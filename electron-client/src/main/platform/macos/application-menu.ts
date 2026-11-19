import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { SHELL_SHORTCUTS } from '../../../contracts/hotkey-rules.js'

const MACOS_PREFERENCES_ACCELERATOR = SHELL_SHORTCUTS.OPEN_SETTINGS.replace(/^Ctrl\+/i, 'Command+')

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

/**
 * 应用主菜单（macOS 顶栏首列应用菜单）子项构造器。
 * 抽离为纯函数以便单元测试在无 Electron 运行时环境下校验结构与快捷键。
 */
export function macosAppSubmenuItems(options: MacosApplicationMenuOptions = {}): MenuItemConstructorOptions[] {
  const appSubmenu: MenuItemConstructorOptions[] = [
    { role: 'about' }
  ]

  if (typeof options.onOpenPreferences === 'function') {
    appSubmenu.push(
      { type: 'separator' },
      {
        label: '偏好设置...',
        accelerator: MACOS_PREFERENCES_ACCELERATOR,
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

  return appSubmenu
}

export function installMacosApplicationMenu(options: MacosApplicationMenuOptions = {}): void {
  const menu = Menu.buildFromTemplate([
    {
      label: app.name || 'ZTools',
      submenu: macosAppSubmenuItems(options)
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
