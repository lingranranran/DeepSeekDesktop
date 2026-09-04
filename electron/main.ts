import { app, BrowserWindow, globalShortcut, ipcMain, shell, Tray, nativeImage } from 'electron';
import { join } from 'node:path';
import { DshManager } from './dsh-manager';
import { Logger } from './logger';
import { loadWindowState, saveWindowState } from './window-state';
import { loadSettings, saveSettings, type AppSettings } from './settings';
import { createTray } from './tray';

// ---------- 常量与全局状态 ----------

/** dsh 异常后自动重启的次数上限 */
const MAX_RESTARTS = 3;

// 固定 userData：不受打包后 productName 影响，开发/安装版共享同一数据目录
app.setPath('userData', join(app.getPath('appData'), 'deepseek-harness-desktop'));

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

/** dsh 进程管理器 */
const dsh = new DshManager({
  onLog: (line) => logger.info(`[dsh] ${line}`),
  onCrash: (code) => {
    logger.error(`[dsh] 意外崩溃（exit code ${code}）`);
    void handleDshFailure(`进程意外退出（exit code ${code}）`);
  },
  onHung: (port) => {
    logger.error(`[dsh] 服务无响应（端口 ${port} 连续健康检查失败）`);
    void handleDshFailure(`服务无响应（端口 ${port} 连续健康检查失败）`);
  },
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
  applyLoginItem(); // 同步开机自启状态（设置可能在别处被改动）
  createMainWindow();
  // 托盘与快捷键先于 dsh 就绪可用（dsh 启动可能需要数十秒）
  tray = createTray({
    onToggleMainWindow: toggleMainWindow,
    onOpenSettings: openSettingsWindow,
    onQuit: () => app.quit(),
  });
  applyGlobalShortcut();
  await loadMainWindowContent();
}

async function loadMainWindowContent(): Promise<void> {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  // 1. 先显示原生加载页（不依赖 dsh）
  await win.loadFile(join(__dirname, '..', 'renderer', 'loading.html'));
  // 2. 后台拉起 dsh 服务
  try {
    const port = await dsh.start();
    logger.info(`dsh 就绪，端口 ${port}`);
    // 3. 端口就绪后加载 dsh Web UI
    if (win && !win.isDestroyed()) {
      await win.loadURL(`http://127.0.0.1:${port}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`启动失败：${msg}`);
    showFatal(msg);
  }
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

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 560,
    height: 560,
    resizable: false,
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
  void win.loadFile(join(__dirname, '..', 'renderer', 'settings.html'));
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
  };
  saveSettings(settings);
  applyLoginItem();
  const shortcutError = applyGlobalShortcut();
  return shortcutError ? { ok: false, error: shortcutError } : { ok: true };
});

ipcMain.handle('app:open-logs', () => {
  void shell.openPath(logger.logDir);
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

function showFatal(message: string): void {
  const win = mainWindow ?? createMainWindow();
  if (win.isDestroyed()) return;
  const html = `data:text/html;charset=utf-8,${encodeURIComponent(fatalPage(message))}`;
  void win.loadURL(html);
  if (!win.isVisible()) win.show();
}

function fatalPage(message: string): string {
  const safe = message.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
  const logDir = logger.logDir.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
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
<p>排查建议：确认已安装 <code>@deepseek-ai/dsh</code>（<code>npm i -g @deepseek-ai/dsh</code>），然后重启本应用。详细日志见 <code>${logDir}</code></p>
</div></body></html>`;
}

// ---------- 生命周期 ----------

app.on('window-all-closed', () => {
  // 托盘模式下窗口均隐藏而非销毁；走到这里说明用户选择了直接退出
  app.quit();
});

app.on('before-quit', (event) => {
  // 拦截第一次退出，先优雅停 dsh，再真正退出
  event.preventDefault();
  isQuitting = true;
  logger.info('应用退出');
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
  void dsh.stop().finally(() => {
    app.exit(0);
  });
});
