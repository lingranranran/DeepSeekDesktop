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
  /** M7.3：桌面通知（窗口不在前台时，任务完成/等待审批发送系统通知） */
  desktopNotifications: boolean;
  /**
   * M6：激活的独立运行时 id（null = 应用内置运行时）。
   * 由运行时管理 IPC（runtimes:activate）单独维护，设置页普通保存不触碰。
   */
  activeRuntimeId: string | null;
  /**
   * M7：已就"发现新版本"提醒过的运行时 id（每个版本只提醒一次，避免每次
   * 启动重复打扰）。由主进程运行时更新检查单独维护，设置页普通保存不触碰。
   */
  lastNotifiedRuntimeId: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  closeBehavior: 'tray',
  launchAtLogin: false,
  globalShortcutEnabled: false,
  globalShortcutAccelerator: 'Control+Shift+D',
  desktopNotifications: true,
  activeRuntimeId: null,
  lastNotifiedRuntimeId: null,
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
      desktopNotifications: raw.desktopNotifications !== false,
      activeRuntimeId:
        typeof raw.activeRuntimeId === 'string' && raw.activeRuntimeId.length > 0
          ? raw.activeRuntimeId
          : null,
      lastNotifiedRuntimeId:
        typeof raw.lastNotifiedRuntimeId === 'string' && raw.lastNotifiedRuntimeId.length > 0
          ? raw.lastNotifiedRuntimeId
          : null,
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
