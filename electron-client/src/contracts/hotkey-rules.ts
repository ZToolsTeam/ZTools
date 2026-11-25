/**
 * 宿主与全局快捷键共享规则、系统禁区黑名单及跨平台规范化工具
 */

export const SHELL_SHORTCUTS = Object.freeze({
  OPEN_SETTINGS: 'Ctrl+,',
  POPOUT_WINDOW: 'Ctrl+Shift+P',
  ACTION_PANEL: 'Ctrl+K',
  FOCUS_SEARCH: 'Ctrl+F',
  TOGGLE_SIDEBAR: 'Ctrl+B',
  PIN_ITEM: 'Ctrl+P'
})

export const EDITABLE_SHELL_SHORTCUT_IDS = Object.freeze([
  'focus-search',
  'action-panel',
  'toggle-sidebar',
  'popout-window',
  'open-settings'
] as const)

export type EditableShellShortcutId = (typeof EDITABLE_SHELL_SHORTCUT_IDS)[number]

const MAX_SHELL_SHORTCUT_LENGTH = 64

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 32 || code === 127) return true
  }
  return false
}

/**
 * 安全解析用户自定义的常用快捷键覆盖项（JSON 字符串或对象）。
 * 仅保留 5 个可编辑白名单键，防御原型污染；允许空串（显式清空），忽略非法类型、控制字符或超长值。
 */
export function parseShellShortcutsOverrides(
  raw: unknown
): Partial<Record<EditableShellShortcutId, string>> {
  let source: unknown = raw
  if (typeof source === 'string') {
    const trimmed = source.trim()
    if (!trimmed) return {}
    try {
      source = JSON.parse(trimmed)
    } catch {
      return {}
    }
  }
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    return {}
  }

  const record = source as Record<string, unknown>
  const result: Partial<Record<EditableShellShortcutId, string>> = {}
  for (const id of EDITABLE_SHELL_SHORTCUT_IDS) {
    if (!Object.hasOwn(record, id)) continue
    const value = record[id]
    if (typeof value !== 'string') continue
    if (hasControlCharacter(value)) continue
    const trimmed = value.trim()
    if (trimmed.length > MAX_SHELL_SHORTCUT_LENGTH) continue
    result[id] = trimmed
  }
  return result
}

/**
 * 解析「打开偏好设置」快捷键：覆盖项存在时按覆盖值返回（空串表示已清空），否则回退默认值。
 */
export function resolveOpenSettingsShortcut(raw: unknown): string {
  const overrides = parseShellShortcutsOverrides(raw)
  if (Object.hasOwn(overrides, 'open-settings')) {
    return overrides['open-settings'] as string
  }
  return SHELL_SHORTCUTS.OPEN_SETTINGS
}

/**
 * 将快捷键组合转换为 Electron MenuItem 可用的 accelerator：
 * - 空串、控制字符、超长字符串或双击修饰键返回 undefined（不传给原生菜单）；
 * - darwin 下将 Ctrl / CommandOrControl / CmdOrCtrl / Cmd 映射为 Command，保持物理 Control 为 Control；
 * - 非 darwin 下保留 Ctrl，并将 CommandOrControl / CmdOrCtrl 规范为 CommandOrControl。
 */
export function toMenuAccelerator(
  combo: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (typeof combo !== 'string') return undefined
  if (hasControlCharacter(combo)) return undefined
  const trimmed = combo.trim()
  if (!trimmed || trimmed.length > MAX_SHELL_SHORTCUT_LENGTH) return undefined
  if (isDoubleModifier(trimmed)) return undefined

  const tokens = trimmed
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean)
  if (tokens.length === 0) return undefined

  const mapped = tokens.map((token) => {
    const lower = token.toLowerCase()
    if (platform === 'darwin') {
      if (
        lower === 'ctrl' ||
        lower === 'commandorcontrol' ||
        lower === 'cmdorctrl' ||
        lower === 'cmd' ||
        lower === 'command'
      ) {
        return 'Command'
      }
      if (lower === 'control') return 'Control'
      return token
    }
    if (lower === 'ctrl') return 'Ctrl'
    if (lower === 'commandorcontrol' || lower === 'cmdorctrl') {
      return 'CommandOrControl'
    }
    return token
  })

  return mapped.join('+')
}

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
 * 判断快捷键是否命中操作系统核心保留禁区，并返回对应的平台标识。
 */
export function getGlobalHotkeyBlacklistPlatform(
  key: string,
  platform: NodeJS.Platform = process.platform
): 'darwin' | 'win32' | null {
  const norm = normalizedAccelerator(key, platform)
  if (!norm) return null
  if (platform === 'darwin') {
    return DARWIN_BLACKLISTED_HOTKEYS.has(norm) ? 'darwin' : null
  }
  return WINDOWS_BLACKLISTED_HOTKEYS.has(norm) ? 'win32' : null
}

/**
 * 校验快捷键是否属于操作系统核心保留禁区（全局注册后会破坏复制粘贴或系统关闭切换等基础交互）
 */
export function getGlobalHotkeyBlacklistReason(
  key: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  const blockedPlatform = getGlobalHotkeyBlacklistPlatform(key, platform)
  if (blockedPlatform === 'darwin') {
    return `Shortcut ${key.trim()} is a reserved macOS system shortcut and cannot be registered globally`
  }
  if (blockedPlatform === 'win32') {
    return `Shortcut ${key.trim()} is a reserved Windows system shortcut and cannot be registered globally`
  }
  return null
}
