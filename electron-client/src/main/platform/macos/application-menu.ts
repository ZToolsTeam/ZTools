import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { SHELL_SHORTCUTS, toMenuAccelerator } from '../../../contracts/hotkey-rules.js'
import { t } from '../../i18n/index.js'

export interface MacosApplicationMenuOptions {
  readonly onOpenPreferences?: () => void
  /** 偏好设置快捷键显示文案（未传回退默认值，空串表示已清空） */
  readonly settingsAccelerator?: string
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
    const rawSettingsAccelerator = options.settingsAccelerator === undefined
      ? SHELL_SHORTCUTS.OPEN_SETTINGS
      : options.settingsAccelerator
    const settingsAccelerator = toMenuAccelerator(rawSettingsAccelerator, 'darwin')
    appSubmenu.push(
      { type: 'separator' },
      {
        label: t('menu.preferences'),
        ...(settingsAccelerator ? { accelerator: settingsAccelerator } : {}),
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
      label: t('menu.view'),
      submenu: macosViewMenuItems(app.isPackaged)
    },
    { role: 'windowMenu' }
  ])
  Menu.setApplicationMenu(menu)
}
