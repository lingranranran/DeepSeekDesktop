import { join } from 'node:path';
import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron';

/** 托盘回调 */
export interface TrayCallbacks {
  /** 单击托盘图标：切换主窗口显示/隐藏 */
  onToggleMainWindow: () => void;
  /** 打开设置窗口 */
  onOpenSettings: () => void;
  /** 退出应用 */
  onQuit: () => void;
}

/** 创建系统托盘；应用退出时应调用 destroy() */
export function createTray(callbacks: TrayCallbacks): Tray {
  const icon = nativeImage.createFromPath(join(__dirname, '..', 'resources', 'icons', 'tray.png'));
  const tray = new Tray(icon);
  tray.setToolTip('DeepSeek Harness');

  const template: MenuItemConstructorOptions[] = [
    { label: '显示主窗口', click: () => callbacks.onToggleMainWindow() },
    { label: '设置', click: () => callbacks.onOpenSettings() },
    { type: 'separator' },
    { label: '退出', click: () => callbacks.onQuit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));

  // Windows 惯例：单击托盘图标切换主窗口显隐
  tray.on('click', () => callbacks.onToggleMainWindow());
  return tray;
}
