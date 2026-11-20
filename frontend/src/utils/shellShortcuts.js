/**
 * 宿主快捷键单一注册表（Shell Shortcuts Registry）
 * 所有壳层快捷键的注册、展示文案、速查卡、工具提示及插件保留键告警统一从本文件读取。
 */
import { t } from '@/i18n'

export const SHELL_SHORTCUTS = Object.freeze({
  OPEN_SETTINGS: 'Ctrl+,',
  TOGGLE_MODE: 'Ctrl+U',
  POPOUT_WINDOW: 'Ctrl+Shift+P',
  ACTION_PANEL: 'Ctrl+K',
  FOCUS_SEARCH: 'Ctrl+F',
  TOGGLE_SIDEBAR: 'Ctrl+B',
  PIN_ITEM: 'Ctrl+P'
})

export const OPEN_SETTINGS_SHORTCUT = SHELL_SHORTCUTS.OPEN_SETTINGS
export const TOGGLE_MODE_SHORTCUT = SHELL_SHORTCUTS.TOGGLE_MODE
export const POPOUT_WINDOW_SHORTCUT = SHELL_SHORTCUTS.POPOUT_WINDOW

function createShortcutHint(id, combo) {
  return Object.freeze({
    id,
    combo,
    get label() {
      return t(`settings.shortcuts.builtins.${id}`)
    }
  })
}

/** 设置中心「常用快捷键」只读速查清单 */
export const BUILTIN_SHORTCUT_HINTS = Object.freeze([
  createShortcutHint('focus-search', SHELL_SHORTCUTS.FOCUS_SEARCH),
  createShortcutHint('action-panel', SHELL_SHORTCUTS.ACTION_PANEL),
  createShortcutHint('toggle-mode', SHELL_SHORTCUTS.TOGGLE_MODE),
  createShortcutHint('toggle-sidebar', SHELL_SHORTCUTS.TOGGLE_SIDEBAR),
  createShortcutHint('popout-window', SHELL_SHORTCUTS.POPOUT_WINDOW),
  createShortcutHint('open-settings', SHELL_SHORTCUTS.OPEN_SETTINGS),
  createShortcutHint('back', 'Escape')
])

/** 宿主保留组合键：不允许插件局部 shortcut 遮蔽，发生重叠时宿主优先且隐藏插件侧假徽标 */
export const RESERVED_DECLARATIVE_SHORTCUTS = new Set([
  SHELL_SHORTCUTS.POPOUT_WINDOW,
  SHELL_SHORTCUTS.OPEN_SETTINGS,
  SHELL_SHORTCUTS.TOGGLE_MODE,
  SHELL_SHORTCUTS.ACTION_PANEL,
  'Escape'
])
