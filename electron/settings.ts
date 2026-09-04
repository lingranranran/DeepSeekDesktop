import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

/** 应用设置（userData/settings.json 持久化） */
export interface AppSettings {
  /** 关闭窗口时的行为：最小化到托盘 / 直接退出 */
  closeBehavior: 'tray' | 'quit';
  /** 开机自启动 */
  launchAtLogin: boolean;
  /** 全局快捷键开关 */
  globalShortcutEnabled: boolean;
  /** 全局快捷键（Electron accelerator 格式，如 Control+Shift+D） */
  globalShortcutAccelerator: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  closeBehavior: 'tray',
  launchAtLogin: false,
  globalShortcutEnabled: false,
  globalShortcutAccelerator: 'Control+Shift+D',
};

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json');
}

/** 读取设置并与默认值合并（新增字段自动补默认值，损坏时整体回退默认值） */
export function loadSettings(): AppSettings {
  try {
    if (!existsSync(settingsFile())) return { ...DEFAULT_SETTINGS };
    const raw = JSON.parse(readFileSync(settingsFile(), 'utf8')) as Partial<AppSettings>;
    return {
      closeBehavior: raw.closeBehavior === 'quit' ? 'quit' : 'tray',
      launchAtLogin: raw.launchAtLogin === true,
      globalShortcutEnabled: raw.globalShortcutEnabled === true,
      globalShortcutAccelerator:
        typeof raw.globalShortcutAccelerator === 'string' && raw.globalShortcutAccelerator.length > 0
          ? raw.globalShortcutAccelerator
          : DEFAULT_SETTINGS.globalShortcutAccelerator,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 保存设置到磁盘 */
export function saveSettings(settings: AppSettings): void {
  try {
    writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {
    /* 设置写失败不阻断使用 */
  }
}
