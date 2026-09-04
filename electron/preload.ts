import { contextBridge, ipcRenderer } from 'electron';

/** 更新状态（与主进程 updater.ts 的 UpdateStatus 对应） */
export interface UpdateStatusView {
  phase:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  version?: string;
  currentVersion?: string;
  percent?: number;
  message?: string;
}

/**
 * 渲染层（设置页）可用的窄接口。
 * 主窗口加载的是 dsh Web UI，不注入任何 bridge；仅原生页面使用。
 */
contextBridge.exposeInMainWorld('dshDesktop', {
  /** 读取当前设置 */
  getSettings: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),
  /** 保存设置并立即应用；返回 { ok, error? }（如快捷键注册失败） */
  saveSettings: (settings: unknown): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('settings:set', settings),
  /** 在系统资源管理器中打开日志目录 */
  openLogs: (): Promise<void> => ipcRenderer.invoke('app:open-logs'),
  /** 当前应用版本（package.json version） */
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:get-version'),
  /** 自动更新能力是否可用（开发模式为 false） */
  updatesAvailable: (): Promise<boolean> => ipcRenderer.invoke('updates:available'),
  /** 拉取当前更新状态（打开设置页时） */
  getUpdateState: (): Promise<UpdateStatusView> => ipcRenderer.invoke('updates:current-state'),
  /** 手动检查更新 */
  checkUpdates: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('updates:check'),
  /** 重启并安装已下载的更新 */
  installUpdate: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('updates:install'),
  /** 订阅更新状态变化；返回取消订阅函数 */
  onUpdateState: (callback: (state: UpdateStatusView) => void): (() => void) => {
    const listener = (_event: unknown, state: UpdateStatusView): void => callback(state);
    ipcRenderer.on('updates:state', listener);
    return () => ipcRenderer.removeListener('updates:state', listener);
  },
});
