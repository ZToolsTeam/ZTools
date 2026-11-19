/**
 * 宿主快捷键单一注册表（Shell Shortcuts Registry）
 * 所有壳层快捷键的注册、展示文案、速查卡、工具提示及插件保留键告警统一从本文件读取。
 */

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

/** 设置中心「常用快捷键」只读速查清单 */
export const BUILTIN_SHORTCUT_HINTS = Object.freeze([
  { id: 'focus-search', label: '聚焦搜索', combo: SHELL_SHORTCUTS.FOCUS_SEARCH },
  { id: 'action-panel', label: '动作面板', combo: SHELL_SHORTCUTS.ACTION_PANEL },
  { id: 'toggle-mode', label: '工作台与悬浮条切换', combo: SHELL_SHORTCUTS.TOGGLE_MODE },
  { id: 'toggle-sidebar', label: '展开 / 收起侧栏', combo: SHELL_SHORTCUTS.TOGGLE_SIDEBAR },
  { id: 'popout-window', label: '弹出为独立常驻窗口', combo: SHELL_SHORTCUTS.POPOUT_WINDOW },
  { id: 'open-settings', label: '打开设置', combo: SHELL_SHORTCUTS.OPEN_SETTINGS },
  { id: 'back', label: '返回上一级 / 主页', combo: 'Escape' }
])

/** 宿主保留组合键：不允许插件局部 shortcut 遮蔽，发生重叠时宿主优先且隐藏插件侧假徽标 */
export const RESERVED_DECLARATIVE_SHORTCUTS = new Set([
  SHELL_SHORTCUTS.POPOUT_WINDOW,
  SHELL_SHORTCUTS.OPEN_SETTINGS,
  SHELL_SHORTCUTS.TOGGLE_MODE,
  SHELL_SHORTCUTS.ACTION_PANEL,
  'Escape'
])
