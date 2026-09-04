/**
 * 自动更新封装（M5，v0.2.0+）：
 * 基于 electron-updater + GitHub Releases（feed 由 app-update.yml 描述，
 * electron-builder 打包时按 publish 配置生成）。
 * - 仅打包版生效；开发模式 available = false，所有操作安全空转
 * - 启动后延迟静默检查 → 有新版自动后台下载（blockmap 差量）
 * - 状态变化通过 onState 回调推给 main，main 转发给设置窗口
 */
import { app } from 'electron';
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater';
import type { Logger } from './logger';

/** 更新状态（设置页据此渲染） */
export type UpdateStatus =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'not-available'; currentVersion: string }
  | { phase: 'downloading'; version: string; percent: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'error'; message: string };

export interface UpdateManagerOptions {
  logger: Logger;
  /** 状态变化回调（main 负责转发给渲染层/通知） */
  onState: (state: UpdateStatus) => void;
}

export class UpdateManager {
  private state: UpdateStatus = { phase: 'idle' };
  private downloadedInfo: UpdateInfo | null = null;
  /** 最近一次 update-available 的版本号（download-progress 事件不带版本） */
  private pendingVersion = '';

  constructor(private readonly opts: UpdateManagerOptions) {}

  /** 打包版才有 app-update.yml 与发布 feed；开发模式全部空转 */
  get available(): boolean {
    return app.isPackaged;
  }

  /** 是否已有下载完毕、等待安装的更新 */
  get isDownloaded(): boolean {
    return this.downloadedInfo !== null;
  }

  get currentState(): UpdateStatus {
    return this.state;
  }

  /** 初始化事件接线（app ready 后调用一次） */
  init(): void {
    if (!this.available) return;
    autoUpdater.autoDownload = true; // 发现新版即静默后台下载
    autoUpdater.autoInstallOnAppQuit = true; // 下载完成后正常退出时顺带安装
    // electron-updater 的诊断日志并入应用日志文件
    autoUpdater.logger = {
      info: (m: unknown) => this.opts.logger.info(`[updater] ${String(m)}`),
      warn: (m: unknown) => this.opts.logger.warn(`[updater] ${String(m)}`),
      error: (m: unknown) => this.opts.logger.error(`[updater] ${String(m)}`),
      debug: (m: unknown) => this.opts.logger.info(`[updater:debug] ${String(m)}`),
    };

    autoUpdater.on('checking-for-update', () => this.set({ phase: 'checking' }));
    autoUpdater.on('update-available', (info: UpdateInfo) =>
      this.set({ phase: 'available', version: info.version })
    );
    autoUpdater.on('update-not-available', (info: UpdateInfo) =>
      this.set({ phase: 'not-available', currentVersion: info.version })
    );
    autoUpdater.on('download-progress', (progress: ProgressInfo) =>
      this.set({
        phase: 'downloading',
        version: this.pendingVersion,
        percent: Math.floor(progress.percent),
      })
    );
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.downloadedInfo = info;
      this.set({ phase: 'downloaded', version: info.version });
    });
    autoUpdater.on('error', (err: Error) => {
      this.set({ phase: 'error', message: err.message });
    });
  }

  /** 检查更新（打包版；开发模式空转） */
  check(): void {
    if (!this.available) return;
    void autoUpdater.checkForUpdates().catch(() => {
      /* 错误已由 error 事件上报 */
    });
  }

  /**
   * 请求"重启并安装"（须已下载）。
   * 注意：不直接调 quitAndInstall —— 它与 main.ts 的 before-quit 拦截
   * （先优雅停 dsh 再退出）天然冲突；这里只确认状态，由调用方发起 app.quit()，
   * main 在 dsh 停止完毕后调用 finishInstall() 拉起安装器。
   */
  beginInstall(): boolean {
    return this.isDownloaded;
  }

  /** dsh 已停止、应用即将退出时调用：拉起 NSIS 安装器（内部自行退出应用） */
  finishInstall(): void {
    if (!this.isDownloaded) return;
    autoUpdater.quitAndInstall(false, true);
  }

  private set(s: UpdateStatus): void {
    if (s.phase === 'available' || s.phase === 'downloading' || s.phase === 'downloaded') {
      if ('version' in s && s.version) this.pendingVersion = s.version;
    }
    this.state = s;
    this.opts.onState(s);
  }
}
