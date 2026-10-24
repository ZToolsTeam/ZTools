import { app, Menu, type MenuItemConstructorOptions } from 'electron'

export interface MacosApplicationMenuOptions {
  readonly onOpenPreferences?: () => void
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
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ])
  Menu.setApplicationMenu(menu)
}
