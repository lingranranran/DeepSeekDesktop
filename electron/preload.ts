import { contextBridge, ipcRenderer } from 'electron';

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
});
