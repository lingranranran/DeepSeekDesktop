import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  shell,
  Tray,
  nativeImage,
  Notification,
} from 'electron';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { arch, release } from 'node:os';
import { DshManager, type DesktopBridgeEvent } from './dsh-manager';
import { readLogTail, exportDiagnostics } from './diagnostics';
import { ensureRuntime, readArchiveMeta } from './runtime-setup';
import {
  builtinRuntimeDir,
  runtimesRoot,
  listLocalRuntimes,
  resolveActiveRuntimeDir,
  isHealthyRuntime,
  compareDshVersions,
} from './runtime-registry';
import {
  fetchRuntimeManifest,
  downloadRuntime,
  type RuntimeManifestEntry,
  type RuntimeDownloadState,
} from './runtime-updater';
import { UpdateManager, type UpdateStatus } from './updater';
import { Logger } from './logger';
import { loadWindowState, saveWindowState } from './window-state';
import { loadSettings, saveSettings, type AppSettings } from './settings';
import { createTray } from './tray';

// ---------- 常量与全局状态 ----------

/** dsh 异常后自动重启的次数上限 */
const MAX_RESTARTS = 3;

/** 冒烟测试模式：`应用.exe --smoke`，就绪后打标记日志并自动退出（退出码 0/1） */
const SMOKE = process.argv.includes('--smoke');

/** 冒烟模式下健康检查等待上限（毫秒） */
const SMOKE_TIMEOUT_MS = 90_000;

// 固定 userData：不受打包后 productName 影响，开发/安装版共享同一数据目录
// 冒烟模式例外：隔离到 out/smoke-userdata —— 沙箱/CI 环境写不了真实 AppData，
// 同时避免冒烟运行污染开发者的真实设置/日志/运行时；目录持久化以便复用已解压的运行时
// 打包版 getAppPath() 指向只读 asar，须改用 exe 所在目录（win-unpacked 根）
if (SMOKE) {
  const smokeBase = app.isPackaged ? dirname(process.execPath) : app.getAppPath();
  app.setPath('userData', join(smokeBase, 'out', 'smoke-userdata'));
} else {
  app.setPath('userData', join(app.getPath('appData'), 'deepseek-harness-desktop'));
}

/** v0.1.1+：内置运行时首启解压目录（userData/runtime） */
const RUNTIME_DIR = builtinRuntimeDir();

/** M6：独立运行时安装根目录（userData/runtimes/<id>/） */
const RUNTIMES_ROOT = runtimesRoot();

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const logger = new Logger();

/** 当前设置 */
let settings = loadSettings();

/** 已用掉的重启次数 */
let restarts = 0;

/** 正在退出流程中（窗口 close 不再走托盘隐藏分支） */
let isQuitting = false;

/** 最终退出码（冒烟测试用；正常流程恒为 0） */
let exitCode = 0;

/** 正在退出以安装更新：退出流程改走 NSIS 安装器，而非 app.exit */
let installingUpdate = false;

/** M6：按设置解析启动时应使用的运行时目录（激活的独立运行时 → 回退内置） */
const initialRuntime = resolveActiveRuntimeDir(settings.activeRuntimeId);
if (initialRuntime.fallback && settings.activeRuntimeId) {
  logger.warn(
    `激活的运行时 ${settings.activeRuntimeId} 不可用，本次启动回退内置运行时`
  );
}

/** dsh 进程管理器（优先使用激活的独立运行时，默认内置 userData/runtime） */
const dsh = new DshManager({
  runtimeDir: initialRuntime.dir,
  events: {
    onLog: (line) => logger.info(`[dsh] ${line}`),
    onCrash: (code) => {
      logger.error(`[dsh] 意外崩溃（exit code ${code}）`);
      void handleDshFailure(`进程意外退出（exit code ${code}）`);
    },
    onHung: (port) => {
      logger.error(`[dsh] 服务无响应（端口 ${port} 连续健康检查失败）`);
      void handleDshFailure(`服务无响应（端口 ${port} 连续健康检查失败）`);
    },
    onDesktopEvent: (event) => handleDesktopEvent(event),
  },
});

/** 自动更新管理器（v0.2.0+；开发模式空转） */
const updater = new UpdateManager({
  logger,
  onState: handleUpdateState,
});

// ---------- 单实例锁 ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户尝试再次启动：唤起主窗口
    showMainWindow();
  });

  app.whenReady().then(bootstrap);
}

// ---------- 启动流程 ----------

async function bootstrap(): Promise<void> {
  logger.info('应用启动');
  updater.init(); // 事件接线（打包版才有实际行为）
  applyLoginItem(); // 同步开机自启状态（设置可能在别处被改动）
  createMainWindow();
  // 托盘与快捷键先于 dsh 就绪可用（dsh 启动可能需要数十秒）
  tray = createTray({
    onToggleMainWindow: toggleMainWindow,
    onOpenSettings: openSettingsWindow,
    onQuit: () => app.quit(),
  });
  applyGlobalShortcut();
  setupDesktopBridge(); // M7.3：注入桌面桥 --patch 覆盖层（须在首次 dsh.start 前完成）
  await loadMainWindowContent();
}

async function loadMainWindowContent(): Promise<void> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  // 1. 先显示原生加载页（不依赖 dsh）
  await win.loadFile(join(__dirname, '..', 'renderer', 'loading.html'));
  try {
    // 2. 确保内置运行时就绪（首启解压，进度推送到加载页）
    await ensureBundledRuntime(win);
    // 3. 后台拉起 dsh 服务
    const port = await dsh.start();
    logger.info(`dsh 就绪，端口 ${port}`);
    // 4. 端口就绪后加载 dsh Web UI
    if (win && !win.isDestroyed()) {
      await win.loadURL(`http://127.0.0.1:${port}`);
    }
    if (SMOKE) {
      void smokeReady(port);
    } else {
      if (updater.available) {
        // 延迟静默检查更新：避开首启解压与 dsh 启动的 IO/带宽高峰
        setTimeout(() => updater.check(), 15_000);
      }
      // M7：后台检查 dsh 运行时新版本（再延 15s，与更新检查错峰）
      setTimeout(() => void checkRuntimeUpdate(), 30_000);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`启动失败：${msg}`);
    showFatal(msg);
  }
}

// ---------- 自动更新（v0.2.0+） ----------

/**
 * M7：后台检查 dsh 运行时新版本（启动 30s 后执行一次）。
 * 发现比当前激活运行时更新的版本且未提醒过 → 系统通知（点击直达运行时管理）。
 * 每个版本只提醒一次（settings.lastNotifiedRuntimeId）；网络失败静默记日志。
 */
async function checkRuntimeUpdate(): Promise<void> {
  try {
    const manifest = await fetchRuntimeManifest();
    if (manifest.length === 0) return;
    manifest.sort((a, b) => compareDshVersions(b.dshVersion, a.dshVersion));
    availableRuntimes = manifest; // 顺带填充缓存，设置页稍后打开可复用
    const newest = manifest[0];
    if (newest.id === settings.lastNotifiedRuntimeId) return; // 该版本已提醒过

    const active = listLocalRuntimes(settings.activeRuntimeId).find((r) => r.active);
    const activeVersion = active?.dshVersion ?? '';
    if (!activeVersion || compareDshVersions(newest.dshVersion, activeVersion) <= 0) return;

    settings.lastNotifiedRuntimeId = newest.id;
    saveSettings(settings);
    logger.info(
      `发现新运行时：dsh ${newest.dshVersion}（当前 ${activeVersion}），已发送桌面提醒`
    );
    if (!Notification.isSupported()) return;
    try {
      const notice = new Notification({
        title: 'dsh 有新版本',
        body: `dsh ${newest.dshVersion} 可用（当前 ${activeVersion}），点击打开运行时管理`,
      });
      notice.on('click', () => openSettingsWindow('runtime'));
      notice.show();
    } catch {
      /* 通知失败不影响主流程 */
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`运行时新版本检查失败（下次启动重试）：${msg}`);
  }
}

/** 更新状态变化：转发给设置窗口；下载完毕时弹系统通知（点击即安装） */
function handleUpdateState(state: UpdateStatus): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('updates:state', state);
  }
  if (state.phase === 'downloaded' && !SMOKE && Notification.isSupported()) {
    try {
      const notice = new Notification({
        title: 'DeepSeek Harness 有新版本',
        body: `v${state.version} 已就绪，点击立即重启并安装`,
      });
      notice.on('click', () => installUpdate());
      notice.show();
    } catch {
      /* 通知失败不影响主流程 */
    }
  }
}

/** 用户请求"重启并安装"：走正常退出流程（优雅停 dsh → NSIS 安装器接管） */
function installUpdate(): void {
  if (!updater.beginInstall()) return;
  installingUpdate = true;
  app.quit();
}

// ---------- 桌面桥（M7.3：dsh 内部事件 → 系统通知） ----------

/**
 * M7.3：装配桌面桥 —— 生成 --patch 覆盖层，让 dsh 加载应用自带的 dsh-bridge 插件。
 * 插件把 agent 状态与审批请求以 stdout 标记行上报（见 resources/dsh-bridge/index.js），
 * DshManager 解析后经 onDesktopEvent 回调至此。注入是无条件的（插件存在即注入），
 * 设置项 desktopNotifications 只门控通知显示 —— 开关即时生效、无需重启 dsh。
 * 插件缺失或 patch 写入失败仅记日志降级，不影响 dsh 正常启动。
 */
function setupDesktopBridge(): void {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  // 插件必须在 asar 外（dsh 是独立 node.exe，读不了 app.asar 内的文件）：
  // 打包版位于 <安装>\resources\dsh-bridge；开发模式回退项目 resources/ 目录。
  const candidates = [
    resourcesPath ? join(resourcesPath, 'dsh-bridge', 'index.js') : null,
    join(app.getAppPath(), 'resources', 'dsh-bridge', 'index.js'),
  ];
  const pluginPath = candidates.find((p) => p && existsSync(p));
  if (!pluginPath) {
    logger.warn('未找到 dsh-bridge 插件，桌面通知桥接未启用');
    return;
  }
  const patchFile = join(app.getPath('userData'), 'dsh-desktop-bridge.yml');
  // 覆盖层格式 = PatchOptions 列表；insert 不带 id 即追加到根条目列表，
  // name 为模块 specifier（绝对 file:// URL，cordis-plugin-loader 直接动态导入）
  const yml = [
    '# 由 DeepSeek Harness Desktop 自动生成（桌面通知桥接），请勿手动编辑',
    '- insert:',
    '    - id: dsh-desktop-bridge',
    `      name: '${pathToFileURL(pluginPath).href}'`,
    '',
  ].join('\n');
  try {
    writeFileSync(patchFile, yml, 'utf8');
    dsh.setDesktopBridgePatch(patchFile);
    logger.info(`桌面桥已启用：${pluginPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`桌面桥 patch 文件写入失败，桥接未启用：${msg}`);
  }
}

/** 桌面桥事件 → 系统通知（仅窗口不在前台时发送；点击聚焦主窗口） */
function handleDesktopEvent(event: DesktopBridgeEvent): void {
  if (SMOKE) return;
  if (!settings.desktopNotifications) return;
  const win = mainWindow;
  if (win && !win.isDestroyed() && win.isFocused()) return; // 前台盯着页面时不打扰
  if (!Notification.isSupported()) return;
  try {
    const notice =
      event.type === 'agent-idle'
        ? new Notification({ title: '任务已完成', body: 'dsh 任务已结束，点击查看结果' })
        : new Notification({
            title: '等待权限审批',
            body: event.payload.reason
              ? `工具 ${event.payload.toolName} 请求授权：${event.payload.reason}`
              : `工具 ${event.payload.toolName} 请求授权，点击处理`,
          });
    notice.on('click', () => showMainWindow());
    notice.show();
  } catch {
    /* 通知失败不影响主流程 */
  }
}

/**
 * v0.1.1+：确保 userData/runtime 就绪。
 * - resources/node-runtime.tar 存在 → 首启解压（带进度回调），此后启动走快速复用路径
 * - tar 缺失但运行时已在位（如升级后布局变化）→ 直接复用
 * - 打包版两者皆缺 → 安装损坏，抛错引导重装
 */
async function ensureBundledRuntime(win: BrowserWindow): Promise<void> {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const archive = resourcesPath ? join(resourcesPath, 'node-runtime.tar') : null;

  if (archive && existsSync(archive)) {
    const meta = readArchiveMeta(archive);
    if (!meta) {
      // 归档读不出来：若运行时已在位则继续用，否则视为安装损坏
      if (!existsSync(join(RUNTIME_DIR, 'node.exe'))) {
        throw new Error('内置运行时归档（node-runtime.tar）损坏，请卸载后重新安装本应用。');
      }
      logger.warn('node-runtime.tar 无法读取，复用已解压的内置运行时');
      return;
    }
    let lastPush = 0;
    const result = await ensureRuntime({
      archive,
      runtimeDir: RUNTIME_DIR,
      meta,
      onProgress: (done, total) => {
        const now = Date.now();
        if (now - lastPush < 250 && done !== total) return; // 节流：≤4 次/秒
        lastPush = now;
        if (win.isDestroyed()) return;
        void win.webContents
          .executeJavaScript(
            `window.__setRuntimeProgress && window.__setRuntimeProgress(${done}, ${total})`,
            true
          )
          .catch(() => {
            /* 页面跳转瞬间可能失败，忽略 */
          });
      },
    });
    if (result === 'extracted') {
      logger.info(`内置运行时解压完成：${meta.files} 文件 → ${RUNTIME_DIR}`);
    } else {
      logger.info('内置运行时就绪（复用上次解压结果，无需重新解压）');
    }
    if (!win.isDestroyed()) {
      void win.webContents
        .executeJavaScript(`window.__setRuntimePhase && window.__setRuntimePhase('start')`, true)
        .catch(() => {
          /* 忽略 */
        });
    }
    return;
  }

  // 无 tar（开发模式 / 旧版布局）：打包版必须已有可用的解压结果，否则安装损坏
  if (app.isPackaged && !existsSync(join(RUNTIME_DIR, 'node.exe'))) {
    throw new Error(
      '安装不完整：缺少内置运行时（node-runtime.tar）。请卸载后重新安装本应用。'
    );
  }
}

/** 冒烟测试：等待根路径 HTTP 200 → 打 OK 标记并优雅退出；超时判失败 */
async function smokeReady(port: number): Promise<void> {
  const deadline = Date.now() + SMOKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        logger.info(`[smoke] OK port=${port}`);
        quitApp(0);
        return;
      }
    } catch {
      /* 服务尚未就绪，继续轮询 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  logger.error(`[smoke] FAIL 健康检查超时（端口 ${port} 持续无响应）`);
  quitApp(1);
}

/**
 * dsh 崩溃/挂起后的统一处理：
 * 预算内自动重启并重载窗口；超预算显示错误页。
 */
async function handleDshFailure(reason: string): Promise<void> {
  if (restarts >= MAX_RESTARTS) {
    showFatal(`dsh 服务反复异常（已自动重启 ${restarts} 次），不再自动重启。原因：${reason}`);
    return;
  }
  restarts += 1;
  logger.info(`正在自动重启 dsh（第 ${restarts}/${MAX_RESTARTS} 次）…`);

  const win = mainWindow;
  try {
    if (win && !win.isDestroyed()) {
      await win.loadFile(join(__dirname, '..', 'renderer', 'loading.html'));
    }
    await dsh.stop();
    const port = await dsh.start();
    logger.info(`dsh 重启完成，端口 ${port}`);
    if (win && !win.isDestroyed()) {
      await win.loadURL(`http://127.0.0.1:${port}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`自动重启失败：${msg}`);
    showFatal(`自动重启 dsh 失败：${msg}`);
  }
}

// ---------- 主窗口 ----------

function createMainWindow(): BrowserWindow {
  const saved = loadWindowState();
  const win = new BrowserWindow({
    ...(saved
      ? { x: saved.bounds.x, y: saved.bounds.y, width: saved.bounds.width, height: saved.bounds.height }
      : { width: 1400, height: 900 }),
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'DeepSeek Harness',
    backgroundColor: '#0f1117',
    icon: nativeImage.createFromPath(join(__dirname, '..', 'resources', 'icons', 'icon.png')),
    webPreferences: {
      contextIsolation: true, // 安全默认值
      nodeIntegration: false, // 安全默认值
      sandbox: true,
    },
  });
  if (saved?.maximized) win.maximize();
  // 关闭：托盘模式隐藏到托盘；退出模式记忆窗口状态
  win.on('close', (event) => {
    if (!isQuitting && settings.closeBehavior === 'tray') {
      event.preventDefault();
      win.hide();
      return;
    }
    saveWindowState(win);
  });
  // 加载页 ready 后再显示，避免白屏闪烁
  win.once('ready-to-show', () => win.show());
  // 外部链接（如 GitHub 文档）交给系统默认浏览器，不在应用内跳走
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith('http://127.0.0.1:')) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  mainWindow = win;
  return win;
}

/** 显示并聚焦主窗口（second-instance / 全局快捷键 / 托盘共用） */
function showMainWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** 托盘单击：显示 / 隐藏切换 */
function toggleMainWindow(): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    showMainWindow();
  }
}

// ---------- 设置窗口与 IPC ----------

/**
 * 打开设置窗口。
 * @param section 可选定位区（'runtime' = 运行时管理）：经 URL 查询参数传给
 * 渲染端，页面加载后自动展开并滚动到对应区块。已打开时带 section 会重新
 * 导航（设置页轻量、状态全部经 IPC 恢复，重载无副作用）。
 */
function openSettingsWindow(section?: 'runtime'): void {
  const load = (wc: Electron.WebContents): void => {
    void wc.loadFile(join(__dirname, '..', 'renderer', 'settings.html'), {
      query: section ? { section } : undefined,
    });
  };
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    // 已打开时带 section → 重新导航定位（页面轻量、状态经 IPC 恢复，无副作用）
    if (section && !settingsWindow.webContents.isLoading()) {
      load(settingsWindow.webContents);
    }
    return;
  }
  const win = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: true,
    minWidth: 480,
    minHeight: 520,
    maximizable: false,
    title: '设置',
    backgroundColor: '#0f1117',
    icon: nativeImage.createFromPath(join(__dirname, '..', 'resources', 'icons', 'icon.png')),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow = win;
  win.on('closed', () => {
    settingsWindow = null;
  });
  load(win.webContents);
}

ipcMain.handle('settings:get', () => settings);

ipcMain.handle('settings:set', (_event, incoming: Partial<AppSettings>) => {
  settings = {
    closeBehavior: incoming.closeBehavior === 'quit' ? 'quit' : 'tray',
    launchAtLogin: incoming.launchAtLogin === true,
    globalShortcutEnabled: incoming.globalShortcutEnabled === true,
    globalShortcutAccelerator:
      typeof incoming.globalShortcutAccelerator === 'string' && incoming.globalShortcutAccelerator.length > 0
        ? incoming.globalShortcutAccelerator
        : 'Control+Shift+D',
    // M7.3：桌面通知开关只门控通知显示（桥接注入无条件），切换即时生效、无需重启 dsh
    desktopNotifications: incoming.desktopNotifications !== false,
    // 运行时激活由专门的 runtimes:activate IPC 维护（涉及 dsh 重启与回滚），
    // 设置页普通保存不触碰该字段
    activeRuntimeId: settings.activeRuntimeId,
    // M7：运行时新版本提醒的免打扰记忆同样由主进程单独维护
    lastNotifiedRuntimeId: settings.lastNotifiedRuntimeId,
  };
  saveSettings(settings);
  applyLoginItem();
  const shortcutError = applyGlobalShortcut();
  return shortcutError ? { ok: false, error: shortcutError } : { ok: true };
});

ipcMain.handle('app:open-logs', () => {
  void shell.openPath(logger.logDir);
});

// ---------- 诊断区（M7：日志尾部查看器 + 一键导出诊断包） ----------

ipcMain.handle('diag:read-log-tail', () => ({ ok: true, content: readLogTail(logger) }));

ipcMain.handle('diag:export', () => {
  const runtimes = listLocalRuntimes(settings.activeRuntimeId);
  const active = runtimes.find((r) => r.active);
  const env = {
    应用版本: app.getVersion(),
    Electron: process.versions.electron,
    'Node.js（宿主）': process.versions.node,
    Chromium: process.versions.chrome,
    操作系统: `${process.platform} ${release()} (${arch()})`,
    'userData 目录': app.getPath('userData'),
    激活运行时: active ? `dsh ${active.dshVersion}（node ${active.nodeVersion}）` : '内置（未发现）',
    本地运行时:
      runtimes
        .map((r) => `${r.dshVersion}${r.builtIn ? ' [内置]' : ''}${r.active ? ' [激活]' : ''}${r.healthy ? '' : ' [异常]'}`)
        .join('、') || '（无）',
  };
  return exportDiagnostics(logger, env, settingsWindow);
});

// ---------- 运行时管理（M6：独立下载/切换/回滚 dsh 运行时） ----------

/** manifest 缓存（list-available 拉取后供 download 复用；不做磁盘持久化） */
let availableRuntimes: RuntimeManifestEntry[] = [];

/** 下载任务互斥（同一时间只允许一个运行时下载安装） */
let runtimeDownloadBusy = false;

/** 下载进度推送节流 */
let lastRuntimeStatePush = 0;

/** 把下载/安装进度转发给设置窗口（打开时才推） */
function pushRuntimeState(state: RuntimeDownloadState): void {
  const now = Date.now();
  const isEnd = state.phase === 'done' || state.phase === 'error';
  if (!isEnd && now - lastRuntimeStatePush < 250) return; // 节流：≤4 次/秒
  lastRuntimeStatePush = now;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('runtimes:download-state', state);
  }
}

ipcMain.handle('runtimes:list-local', () => listLocalRuntimes(settings.activeRuntimeId));

ipcMain.handle('runtimes:list-available', async () => {
  try {
    const runtimes = await fetchRuntimeManifest();
    availableRuntimes = runtimes;
    // 新版本排前（设置页直接按序渲染）
    runtimes.sort((a, b) => compareDshVersions(b.dshVersion, a.dshVersion));
    return { ok: true, runtimes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`拉取运行时清单失败：${msg}`);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('runtimes:download', (_event, id: unknown) => {
  if (typeof id !== 'string' || id.length === 0) return { ok: false, error: '参数错误' };
  if (runtimeDownloadBusy) return { ok: false, error: '已有运行时下载任务进行中，请稍候' };
  const entry = availableRuntimes.find((r) => r.id === id || r.dshVersion === id);
  if (!entry) return { ok: false, error: `清单中不存在运行时 ${id}，请刷新可用列表后重试` };
  if (isHealthyRuntime(join(RUNTIMES_ROOT, entry.id))) {
    return { ok: false, error: '该运行时已安装' };
  }

  runtimeDownloadBusy = true;
  logger.info(`开始下载运行时：dsh ${entry.dshVersion}（${(entry.sizeBytes / 1024 / 1024).toFixed(0)} MB）`);
  void downloadRuntime({
    entry,
    targetRoot: RUNTIMES_ROOT,
    onState: (s) => {
      pushRuntimeState(s);
      if (s.phase === 'extracting' && s.done === 1) {
        logger.info(`运行时 ${entry.dshVersion} 下载完成，开始解压 …`);
      }
    },
  })
    .then(() => logger.info(`运行时安装完成：dsh ${entry.dshVersion}（id=${entry.id}）`))
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`运行时下载/安装失败：${msg}`);
      pushRuntimeState({ phase: 'error', id: entry.id, message: msg });
    })
    .finally(() => {
      runtimeDownloadBusy = false;
    });
  return { ok: true };
});

/** 激活运行时（null = 切回内置）：停 dsh → 换目录 → 起 dsh → 重载窗口；失败自动回滚 */
async function activateRuntime(id: string | null): Promise<{ ok: boolean; error?: string }> {
  if (id === settings.activeRuntimeId) return { ok: true }; // 无变化
  const targetDir = id ? join(RUNTIMES_ROOT, id) : RUNTIME_DIR;
  if (id && !isHealthyRuntime(targetDir)) {
    return { ok: false, error: '运行时不完整或已被删除，请重新下载安装' };
  }
  const prevId = settings.activeRuntimeId;
  const prevDir = prevId ? join(RUNTIMES_ROOT, prevId) : RUNTIME_DIR;
  const win = mainWindow;
  logger.info(`切换运行时：${prevId ?? '内置'} → ${id ?? '内置'}`);

  try {
    if (win && !win.isDestroyed()) {
      await win.loadFile(join(__dirname, '..', 'renderer', 'loading.html'));
    }
    await dsh.stop();
    dsh.setRuntimeDir(targetDir);
    settings.activeRuntimeId = id;
    saveSettings(settings);
    const port = await dsh.start();
    logger.info(`运行时切换完成，dsh 端口 ${port}`);
    if (win && !win.isDestroyed()) {
      await win.loadURL(`http://127.0.0.1:${port}`);
    }
    return { ok: true };
  } catch (err) {
    // 回滚：恢复原运行时并重启 dsh；连回滚都失败才显示错误页
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`切换运行时失败：${msg}，回滚到 ${prevId ?? '内置'}`);
    settings.activeRuntimeId = prevId;
    saveSettings(settings);
    dsh.setRuntimeDir(prevDir);
    try {
      await dsh.stop();
      const port = await dsh.start();
      if (win && !win.isDestroyed()) {
        await win.loadURL(`http://127.0.0.1:${port}`);
      }
    } catch (rollbackErr) {
      const rmsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      logger.error(`回滚失败：${rmsg}`);
      showFatal(`切换运行时失败且回滚失败：${msg} / ${rmsg}`);
    }
    return { ok: false, error: msg };
  }
}

ipcMain.handle('runtimes:activate', (_event, id: unknown) => {
  if (id !== null && typeof id !== 'string') return Promise.resolve({ ok: false, error: '参数错误' });
  return activateRuntime(id as string | null);
});

ipcMain.handle('runtimes:delete', (_event, id: unknown) => {
  if (typeof id !== 'string' || id.length === 0) return { ok: false, error: '参数错误' };
  if (settings.activeRuntimeId === id) {
    return { ok: false, error: '不能删除正在使用的运行时，请先切换到其他运行时' };
  }
  const dir = join(RUNTIMES_ROOT, id);
  if (!existsSync(dir)) return { ok: false, error: '运行时不存在' };
  try {
    rmSync(dir, { recursive: true, force: true });
    logger.info(`已删除运行时：${id}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`删除运行时失败：${msg}`);
    return { ok: false, error: msg };
  }
});

// ---------- 设置项应用 ----------

/** 应用/撤销开机自启 */
function applyLoginItem(): void {
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
}

/**
 * 应用全局快捷键设置；注册失败返回错误信息（用于设置页回显）。
 */
function applyGlobalShortcut(): string | null {
  globalShortcut.unregisterAll();
  if (!settings.globalShortcutEnabled) return null;
  try {
    const ok = globalShortcut.register(settings.globalShortcutAccelerator, () => showMainWindow());
    if (!ok) {
      const msg = `快捷键 ${settings.globalShortcutAccelerator} 注册失败（可能已被其他应用占用）`;
      logger.error(msg);
      return msg;
    }
    logger.info(`全局快捷键已注册：${settings.globalShortcutAccelerator}`);
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`快捷键注册异常：${msg}`);
    return msg;
  }
}

// ---------- 错误页 ----------

/** 带退出码退出：先走优雅退出流程（停 dsh），再以指定码结束进程 */
function quitApp(code: number): void {
  exitCode = code;
  app.quit();
}

function showFatal(message: string): void {
  if (SMOKE) {
    logger.error(`[smoke] FAIL ${message}`);
    quitApp(1);
    return;
  }
  const win = mainWindow ?? createMainWindow();
  if (win.isDestroyed()) return;
  const html = `data:text/html;charset=utf-8,${encodeURIComponent(fatalPage(message))}`;
  void win.loadURL(html);
  if (!win.isVisible()) win.show();
}

function fatalPage(message: string): string {
  const safe = message.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
  const logDir = logger.logDir.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
  // 安装版与开发模式的排查建议不同：安装版用户不应被引导去 npm install
  const tip = app.isPackaged
    ? `排查建议：请先关闭本应用后重新启动（首次准备运行环境被中断时会自动重试）。
若反复失败，请卸载后重新安装本应用（内置运行时可能损坏）。详细日志见 <code>${logDir}</code>`
    : `排查建议：确认已安装 <code>@deepseek-ai/dsh</code>（<code>npm i -g @deepseek-ai/dsh</code>），
或运行 <code>pnpm prepare-runtime</code> 准备内置运行时，然后重启本应用。详细日志见 <code>${logDir}</code>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>启动失败</title>
<style>
  body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0f1117;color:#e6e6e6;font-family:"Segoe UI",system-ui,sans-serif}
  .card{max-width:600px;padding:32px 40px;border:1px solid #2a2d38;border-radius:12px;
        background:#161923}
  h1{font-size:18px;margin:0 0 12px}
  p{font-size:14px;line-height:1.7;color:#a8adbd;white-space:pre-wrap;word-break:break-all}
  code{color:#ffb86c}
</style></head><body><div class="card">
<h1>DeepSeek Harness 启动失败</h1>
<p>${safe}</p>
<p>${tip}</p>
</div></body></html>`;
}

// ---------- 生命周期 ----------

app.on('window-all-closed', () => {
  // 托盘模式下窗口均隐藏而非销毁；走到这里说明用户选择了直接退出
  app.quit();
});

app.on('before-quit', (event) => {
  // 二次进入（安装更新 / 自然退出放行）：不再拦截
  if (isQuitting) return;
  // 拦截第一次退出，先优雅停 dsh，再真正退出
  event.preventDefault();
  isQuitting = true;
  logger.info('应用退出');
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
  void dsh.stop().finally(() => {
    if (installingUpdate) {
      // 用户确认"重启并安装"：拉起 NSIS 安装器（其内部会完成应用退出）
      updater.finishInstall();
      return;
    }
    if (updater.isDownloaded) {
      // 已静默下载新版本：走自然退出，让 autoInstallOnAppQuit 在 quit 钩子安装
      app.quit();
      return;
    }
    app.exit(exitCode);
  });
});
