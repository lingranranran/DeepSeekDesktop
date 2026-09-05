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

/** 本地运行时条目（M6，与主进程 runtime-registry.ts 的 LocalRuntimeInfo 对应） */
export interface LocalRuntimeView {
  id: string;
  dshVersion: string;
  nodeVersion: string;
  dir: string;
  builtIn: boolean;
  healthy: boolean;
  active: boolean;
}

/** 可下载运行时条目（M6，与 runtime-updater.ts 的 RuntimeManifestEntry 对应） */
export interface AvailableRuntimeView {
  id: string;
  dshVersion: string;
  nodeVersion: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

/** 运行时下载/安装进度（M6，与 RuntimeDownloadState 对应） */
export interface RuntimeDownloadStateView {
  phase: 'downloading' | 'extracting' | 'done' | 'error';
  id: string;
  percent?: number;
  done?: number;
  total?: number;
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
  /** 读取当天日志尾部（诊断区查看器，最近 200 行） */
  readLogTail: (): Promise<{ ok: boolean; content?: string; error?: string }> =>
    ipcRenderer.invoke('diag:read-log-tail'),
  /** 导出诊断包（环境信息 + 保留期日志 → 单个 txt），保存后自动在资源管理器中定位 */
  exportDiagnostics: (): Promise<{
    ok: boolean;
    canceled?: boolean;
    path?: string;
    error?: string;
  }> => ipcRenderer.invoke('diag:export'),
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
  /** 列出本地已安装的运行时（内置 + 独立下载），标记当前激活项 */
  listLocalRuntimes: (): Promise<LocalRuntimeView[]> => ipcRenderer.invoke('runtimes:list-local'),
  /** 拉取远端运行时清单（失败返回 { ok:false, error }） */
  listAvailableRuntimes: (): Promise<{
    ok: boolean;
    runtimes?: AvailableRuntimeView[];
    error?: string;
  }> => ipcRenderer.invoke('runtimes:list-available'),
  /** 启动运行时下载安装（异步任务，进度经 onRuntimeDownloadState 推送） */
  downloadRuntime: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('runtimes:download', id),
  /** 激活运行时（null = 切回内置）；主进程会重启 dsh 并重载主窗口，失败自动回滚 */
  activateRuntime: (id: string | null): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('runtimes:activate', id),
  /** 删除未激活的独立运行时（内置与激活中不可删） */
  deleteRuntime: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('runtimes:delete', id),
  /** 订阅运行时下载/安装进度；返回取消订阅函数 */
  onRuntimeDownloadState: (callback: (state: RuntimeDownloadStateView) => void): (() => void) => {
    const listener = (_event: unknown, state: RuntimeDownloadStateView): void => callback(state);
    ipcRenderer.on('runtimes:download-state', listener);
    return () => ipcRenderer.removeListener('runtimes:download-state', listener);
  },
});
