import { app, Menu, type MenuItemConstructorOptions } from 'electron'

export interface MacosApplicationMenuOptions {
  readonly onOpenPreferences?: () => void
}

/**
 * 显示菜单。正式版不放“重新载入 / 强制重新载入”：插件普遍用 ⌘R 作刷新，
 * 插件动作未命中时菜单会重载整个主窗口、丢掉插件状态；开发版保留重新载入与开发者工具。
 */
export function macosViewMenuItems(isPackaged: boolean): MenuItemConstructorOptions[] {
  return [
    ...(isPackaged ? [] : [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[]),
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]
}

export function installMacosApplicationMenu(options: MacosApplicationMenuOptions = {}): void {
  const appSubmenu: MenuItemConstructorOptions[] = [
    { role: 'about' }
  ]

  if (typeof options.onOpenPreferences === 'function') {
    appSubmenu.push(
      { type: 'separator' },
      {
        label: '偏好设置...',
        accelerator: 'Command+,',
        click: () => options.onOpenPreferences?.()
      }
    )
  }

  appSubmenu.push(
    { type: 'separator' },
    { role: 'services' },
    { type: 'separator' },
    { role: 'hide' },
    { role: 'hideOthers' },
    { role: 'unhide' },
    { type: 'separator' },
    { role: 'quit' }
  )

  const menu = Menu.buildFromTemplate([
    {
      label: app.name || 'ZTools',
      submenu: appSubmenu
    },
    { role: 'editMenu' },
    {
      label: '显示',
      submenu: macosViewMenuItems(app.isPackaged)
    },
    { role: 'windowMenu' }
  ])
  Menu.setApplicationMenu(menu)
}
