/**
 * 宿主与全局快捷键共享规则、系统禁区黑名单及跨平台规范化工具
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

export type NativeKeyboardModifier = 'ctrl' | 'alt' | 'shift'
export type NativeMouseButton = 'middle' | 'right' | 'forward' | 'backward'
export type NativeMouseAction = 'press' | 'long'

export interface MouseHookTriggerConfig {
  readonly kind: 'mouse'
  readonly button: NativeMouseButton
  readonly action: NativeMouseAction
  readonly longPressMs: number
  readonly fullscreenDnd?: boolean
}

const VALID_DOUBLE_MODIFIER_MAP: Record<string, NativeKeyboardModifier> = {
  doublectrl: 'ctrl',
  doublecontrol: 'ctrl',
  doublealt: 'alt',
  doubleshift: 'shift'
}

export function doubleModifierOf(key: string): NativeKeyboardModifier | undefined {
  if (typeof key !== 'string') return undefined
  const compact = key.replace(/[+\s]/g, '').toLowerCase()
  return Object.hasOwn(VALID_DOUBLE_MODIFIER_MAP, compact)
    ? VALID_DOUBLE_MODIFIER_MAP[compact]
    : undefined
}

export function isDoubleModifier(key: string): boolean {
  return doubleModifierOf(key) !== undefined
}

const DARWIN_MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'meta',
  commandorcontrol: 'meta',
  cmdorctrl: 'meta',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
  win: 'meta',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift'
}

const NON_DARWIN_MODIFIER_ALIASES: Record<string, string> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  commandorcontrol: 'ctrl',
  cmdorctrl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  altgr: 'alt',
  shift: 'shift',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
  super: 'meta',
  win: 'meta'
}

const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta']

function normalizeMainKeyToken(raw: string): string {
  const lower = raw.toLowerCase()
  if (lower === 'return') return 'enter'
  if (lower === 'esc') return 'escape'
  if (lower === '+') return 'plus'
  return lower
}

/**
 * 快捷键比较用的跨平台规范形式：
 * - darwin 下：`Ctrl` / `Cmd` / `CommandOrControl` 统一规范为 `meta`（⌘），物理 `Control` 单独规范为 `ctrl`（⌃），
 *   消除 ⌘+K 与 ⌃+K 假冲突，同时检出 Command+Space 与 Ctrl+Space 真冲突；
 * - win32 / 其他平台：`Ctrl` / `Control` / `CommandOrControl` 统一规范为 `ctrl`，`Meta` / `Super` / `Win` 规范为 `meta`。
 */
export function normalizedAccelerator(
  key: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (typeof key !== 'string') return ''
  const doubleModifier = doubleModifierOf(key)
  if (doubleModifier) return `double${doubleModifier}`

  const parts = key.replace(/\s+/g, '').toLowerCase().split('+').filter(Boolean)
  if (parts.length === 0) return ''
  const mainKey = normalizeMainKeyToken(parts[parts.length - 1] as string)
  const aliases = platform === 'darwin' ? DARWIN_MODIFIER_ALIASES : NON_DARWIN_MODIFIER_ALIASES
  const modifiers = new Set<string>()
  for (const part of parts.slice(0, -1)) {
    modifiers.add(Object.hasOwn(aliases, part) ? (aliases[part] as string) : part)
  }
  const ordered = [...modifiers].sort((a, b) => {
    const ia = MODIFIER_ORDER.indexOf(a)
    const ib = MODIFIER_ORDER.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
  })
  return [...ordered, mainKey].join('+')
}

// Windows 全局热键禁区（规范化格式）
const WINDOWS_BLACKLISTED_HOTKEYS = new Set<string>([
  'ctrl+c',
  'ctrl+v',
  'ctrl+x',
  'ctrl+z',
  'ctrl+y',
  'ctrl+a',
  'ctrl+s',
  'alt+f4',
  'alt+tab',
  'ctrl+shift+escape'
])

// macOS 全局热键禁区（规范化格式：⌘ 对应 meta）
const DARWIN_BLACKLISTED_HOTKEYS = new Set<string>([
  'meta+c',
  'meta+v',
  'meta+x',
  'meta+z',
  'meta+a',
  'meta+q',
  'meta+w',
  'meta+tab',
  'meta+space',
  'shift+meta+3',
  'shift+meta+4',
  'shift+meta+5'
])

/**
 * 校验快捷键是否属于操作系统核心保留禁区（全局注册后会破坏复制粘贴或系统关闭切换等基础交互）
 */
export function getGlobalHotkeyBlacklistReason(
  key: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const norm = normalizedAccelerator(key, platform)
  if (!norm) return null
  if (platform === 'darwin') {
    if (DARWIN_BLACKLISTED_HOTKEYS.has(norm)) {
      return `快捷键 ${key.trim()} 为 macOS 系统关键组合键，禁止注册为全局热键`
    }
    return null
  }
  if (WINDOWS_BLACKLISTED_HOTKEYS.has(norm)) {
    return `快捷键 ${key.trim()} 为 Windows 系统关键组合键，禁止注册为全局热键`
  }
  return null
}
