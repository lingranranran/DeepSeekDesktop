import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, screen, type Rectangle } from 'electron';

/** 窗口持久化状态 */
export interface WindowState {
  bounds: Rectangle;
  maximized: boolean;
}

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

/** 读取上次会话的窗口状态；不存在、损坏或落在屏幕外（显示器已拔掉）时返回 null */
export function loadWindowState(): WindowState | null {
  try {
    if (!existsSync(stateFile())) return null;
    const s = JSON.parse(readFileSync(stateFile(), 'utf8')) as WindowState;
    const b = s?.bounds;
    if (
      typeof b?.x !== 'number' ||
      typeof b?.y !== 'number' ||
      typeof b?.width !== 'number' ||
      typeof b?.height !== 'number' ||
      b.width <= 0 ||
      b.height <= 0
    ) {
      return null;
    }
    // 校验至少与某个现存显示器的可见区域相交，避免恢复到已拔掉的显示器上
    const visible = screen
      .getAllDisplays()
      .some((d) => intersects(d.workArea, b));
    if (!visible) return null;
    return { bounds: b, maximized: s.maximized === true };
  } catch {
    return null;
  }
}

/** 保存窗口状态（最大化时保存的是还原后的常规边界） */
export function saveWindowState(win: {
  isMaximized(): boolean;
  getNormalBounds(): Rectangle;
}): void {
  try {
    const state: WindowState = {
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
    };
    writeFileSync(stateFile(), JSON.stringify(state));
  } catch {
    /* 状态保存失败不影响使用 */
  }
}

function intersects(a: Rectangle, b: Rectangle): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}
