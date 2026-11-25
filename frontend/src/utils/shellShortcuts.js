/**
 * 宿主快捷键单一注册表（Shell Shortcuts Registry）
 * 所有壳层常用快捷键的默认值、响应式当前值、持久化、跨窗口同步、展示文案与保留键集合统一从本文件读取。
 */
import { reactive } from 'vue'
import { t } from '@/i18n'

export const SHELL_SHORTCUTS_STORAGE_KEY = 'ztools_shell_shortcuts'
export const SHELL_SHORTCUTS_CONFIG_FILE = 'user_settings.json'
export const SHELL_SHORTCUTS_CONFIG_PATH = 'hotkey.shell'

export const DEFAULT_SHELL_SHORTCUTS = Object.freeze({
  OPEN_SETTINGS: 'Ctrl+,',
  POPOUT_WINDOW: 'Ctrl+Shift+P',
  ACTION_PANEL: 'Ctrl+K',
  FOCUS_SEARCH: 'Ctrl+F',
  TOGGLE_SIDEBAR: 'Ctrl+B',
  PIN_ITEM: 'Ctrl+P'
})

/** 支持用户修改和清空的 5 项常用快捷键元数据（Esc 返回上一级/主页固定不可编辑） */
export const EDITABLE_SHELL_SHORTCUT_ENTRIES = Object.freeze([
  Object.freeze({ id: 'focus-search', key: 'FOCUS_SEARCH', defaultCombo: DEFAULT_SHELL_SHORTCUTS.FOCUS_SEARCH }),
  Object.freeze({ id: 'action-panel', key: 'ACTION_PANEL', defaultCombo: DEFAULT_SHELL_SHORTCUTS.ACTION_PANEL }),
  Object.freeze({ id: 'toggle-sidebar', key: 'TOGGLE_SIDEBAR', defaultCombo: DEFAULT_SHELL_SHORTCUTS.TOGGLE_SIDEBAR }),
  Object.freeze({ id: 'popout-window', key: 'POPOUT_WINDOW', defaultCombo: DEFAULT_SHELL_SHORTCUTS.POPOUT_WINDOW }),
  Object.freeze({ id: 'open-settings', key: 'OPEN_SETTINGS', defaultCombo: DEFAULT_SHELL_SHORTCUTS.OPEN_SETTINGS })
])

export const EDITABLE_SHELL_SHORTCUT_IDS = Object.freeze(
  EDITABLE_SHELL_SHORTCUT_ENTRIES.map((item) => item.id)
)

const ID_TO_ENTRY = new Map(EDITABLE_SHELL_SHORTCUT_ENTRIES.map((item) => [item.id, item]))
const KEY_TO_ENTRY = new Map(EDITABLE_SHELL_SHORTCUT_ENTRIES.map((item) => [item.key, item]))

/** 响应式壳层快捷键当前生效值（修改或清空后全站自动同步，空串表示已清空） */
export const SHELL_SHORTCUTS = reactive({
  ...DEFAULT_SHELL_SHORTCUTS
})

// 保留默认值常量导出以兼容既有测试与静态引用；业务组件应读取响应式 SHELL_SHORTCUTS.*
export const OPEN_SETTINGS_SHORTCUT = DEFAULT_SHELL_SHORTCUTS.OPEN_SETTINGS
export const POPOUT_WINDOW_SHORTCUT = DEFAULT_SHELL_SHORTCUTS.POPOUT_WINDOW

const ALLOWED_MODIFIER_ORDER = ['Ctrl', 'Control', 'Alt', 'Shift']
const ALLOWED_SHELL_PUNCTUATION = new Set([',', '.', '/', ';', '[', ']', '-', '=', '`', '~'])

function normalizeModifierToken(token) {
  const lower = String(token || '').trim().toLowerCase()
  // 注意：keymap.js 在 macOS 上已把 ⌘(metaKey) 归一化为 'Ctrl'，Windows 上 'Meta' 代表孤立 Win 键，严禁映射到 'Ctrl'
  if (lower === 'ctrl' || lower === 'commandorcontrol' || lower === 'cmdorctrl') {
    return 'Ctrl'
  }
  if (lower === 'control') return 'Control'
  if (lower === 'alt' || lower === 'option' || lower === 'opt') return 'Alt'
  if (lower === 'shift') return 'Shift'
  return ''
}

function normalizeShellMainKeyToken(token) {
  const trimmed = String(token || '').trim()
  if (!trimmed) return ''
  const lower = trimmed.toLowerCase()
  if (lower === 'space' || lower === 'spacebar' || trimmed === ' ') return 'Space'
  if (lower === 'comma' || trimmed === '，') return ','
  if (lower === 'period') return '.'
  if (lower === 'slash') return '/'
  if (lower === 'semicolon') return ';'
  if (lower === 'minus') return '-'
  if (lower === 'equal') return '='
  if (lower === 'backquote') return '`'
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower.toUpperCase()
  if (/^[a-z0-9]$/i.test(trimmed)) return trimmed.toUpperCase()
  if (ALLOWED_SHELL_PUNCTUATION.has(trimmed)) return trimmed
  return ''
}

/**
 * 校验并规范化常用快捷键组合串：
 * - 空串返回 ''（表示显式清空）；
 * - 合法组合键返回规范串（如 'Ctrl+Shift+P'、'Ctrl+,'、'F2'）；
 * - 非法值返回 null（解析损坏配置时回退默认）。
 */
export function normalizeShellShortcutCombo(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed.length > 48 || /[\r\n\0\t]/.test(trimmed)) return null

  const parts = trimmed.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 5) return null

  const mainKey = normalizeShellMainKeyToken(parts[parts.length - 1])
  if (!mainKey) return null

  const mods = new Set()
  for (const rawMod of parts.slice(0, -1)) {
    const mod = normalizeModifierToken(rawMod)
    if (!mod) return null
    mods.add(mod)
  }

  const isFnKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(mainKey)
  const hasPrimaryOrAlt = mods.has('Ctrl') || mods.has('Control') || mods.has('Alt')
  // 非 F1-F24 键必须携带 Ctrl / Control / Alt 之一，避免单字符或纯 Shift+字母拦截输入框正常打字
  if (!isFnKey && !hasPrimaryOrAlt) return null

  const orderedMods = ALLOWED_MODIFIER_ORDER.filter((m) => mods.has(m))
  return [...orderedMods, mainKey].join('+')
}

/** 比较用规范串（大小写无关） */
export function canonicalizeShellShortcut(combo) {
  const normalized = normalizeShellShortcutCombo(combo)
  if (!normalized) return ''
  return normalized.toLowerCase()
}

/** 解析持久化的常用快捷键覆盖映射（JSON 字符串或对象） */
export function parseShellShortcutsOverrides(raw) {
  let obj = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return {}
    try {
      obj = JSON.parse(trimmed)
    } catch {
      return {}
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {}

  const result = {}
  for (const entry of EDITABLE_SHELL_SHORTCUT_ENTRIES) {
    if (!Object.hasOwn(obj, entry.id)) continue
    const normalized = normalizeShellShortcutCombo(obj[entry.id])
    if (normalized !== null) {
      result[entry.id] = normalized
    }
  }
  return result
}

function buildOverridesObjectFromState() {
  const overrides = {}
  for (const entry of EDITABLE_SHELL_SHORTCUT_ENTRIES) {
    const current = SHELL_SHORTCUTS[entry.key]
    if (current !== entry.defaultCombo) {
      overrides[entry.id] = current
    }
  }
  return overrides
}

function applyOverridesToState(overrides) {
  for (const entry of EDITABLE_SHELL_SHORTCUT_ENTRIES) {
    if (Object.hasOwn(overrides, entry.id)) {
      SHELL_SHORTCUTS[entry.key] = overrides[entry.id]
    } else {
      SHELL_SHORTCUTS[entry.key] = entry.defaultCombo
    }
  }
  SHELL_SHORTCUTS.PIN_ITEM = DEFAULT_SHELL_SHORTCUTS.PIN_ITEM
}

function writeLocalCache(overrides) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SHELL_SHORTCUTS_STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    // 忽略受限环境 localStorage 异常
  }
}

function readLocalCache() {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(SHELL_SHORTCUTS_STORAGE_KEY)
    if (raw === null) return null
    return parseShellShortcutsOverrides(raw)
  } catch {
    return null
  }
}

function resolveKeyFromIdOrKey(idOrKey) {
  if (typeof idOrKey !== 'string') return ''
  if (ID_TO_ENTRY.has(idOrKey)) return ID_TO_ENTRY.get(idOrKey).key
  if (Object.hasOwn(DEFAULT_SHELL_SHORTCUTS, idOrKey)) return idOrKey
  return ''
}

/** 获取指定常用快捷键当前生效值（空串表示已清空） */
export function getShellShortcut(idOrKey) {
  if (idOrKey === 'back') return 'Escape'
  const key = resolveKeyFromIdOrKey(idOrKey)
  return key ? SHELL_SHORTCUTS[key] : ''
}

/** 判断规范化后的按键事件 combo 是否命中指定的常用快捷键（已清空时永远返回 false） */
export function matchesShellShortcut(combo, idOrKey) {
  if (!combo || typeof combo !== 'string') return false
  const target = getShellShortcut(idOrKey)
  if (!target) return false
  return canonicalizeShellShortcut(combo) === canonicalizeShellShortcut(target)
}

/** 将内部 combo 字符串（如 'Ctrl+Shift+P'）转为动作面板 shortcut 对象；空串返回 undefined */
export function comboToActionShortcut(combo) {
  const normalized = normalizeShellShortcutCombo(combo)
  if (!normalized) return undefined
  const parts = normalized.split('+').filter(Boolean)
  if (parts.length === 0) return undefined
  return {
    modifiers: parts.slice(0, -1),
    key: parts[parts.length - 1]
  }
}

/** 检查候选快捷键是否与其他常用快捷键（或内置固定键 Ctrl+P）冲突 */
export function findConflictingShellShortcut(combo, excludeId = '') {
  const target = canonicalizeShellShortcut(combo)
  if (!target) return null
  for (const entry of EDITABLE_SHELL_SHORTCUT_ENTRIES) {
    if (entry.id === excludeId) continue
    const existing = canonicalizeShellShortcut(SHELL_SHORTCUTS[entry.key])
    if (existing && existing === target) {
      return {
        id: entry.id,
        key: entry.key,
        label: t(`settings.shortcuts.builtins.${entry.id}`)
      }
    }
  }
  const pinCanonical = canonicalizeShellShortcut(SHELL_SHORTCUTS.PIN_ITEM)
  if (pinCanonical && pinCanonical === target) {
    return {
      id: 'pin-item',
      key: 'PIN_ITEM',
      label: t('hotkey.recorder.pinItemLabel')
    }
  }
  return null
}

/** 当前是否存在任意已修改或已清空的常用快捷键（响应式，可在 computed 中使用） */
export function hasCustomizedShellShortcuts() {
  return EDITABLE_SHELL_SHORTCUT_ENTRIES.some(
    (entry) => SHELL_SHORTCUTS[entry.key] !== entry.defaultCombo
  )
}

function createShortcutHint(id, keyOrFixedCombo) {
  const entry = ID_TO_ENTRY.get(id)
  const editable = Boolean(entry)
  return Object.freeze({
    id,
    key: entry?.key || '',
    editable,
    defaultCombo: entry ? entry.defaultCombo : keyOrFixedCombo,
    get combo() {
      return entry ? SHELL_SHORTCUTS[entry.key] : keyOrFixedCombo
    },
    get label() {
      return t(`settings.shortcuts.builtins.${id}`)
    }
  })
}

/** 设置中心「常用快捷键」清单：前 5 项支持修改与清空，最后一项 Esc 返回只读 */
export const BUILTIN_SHORTCUT_HINTS = Object.freeze([
  createShortcutHint('focus-search'),
  createShortcutHint('action-panel'),
  createShortcutHint('toggle-sidebar'),
  createShortcutHint('popout-window'),
  createShortcutHint('open-settings'),
  createShortcutHint('back', 'Escape')
])

/** 动态计算当前声明式插件保留组合键（仅包含非空的宿主常用快捷键与 Escape） */
export function getReservedDeclarativeShortcuts() {
  const reserved = new Set(['Escape'])
  for (const key of ['POPOUT_WINDOW', 'OPEN_SETTINGS', 'ACTION_PANEL']) {
    const combo = SHELL_SHORTCUTS[key]
    if (combo) reserved.add(combo)
  }
  return reserved
}

/** 动态计算悬浮条动作面板保留键（仅包含非空的动作面板、打开设置与 Escape） */
export function getLauncherPanelReservedShortcuts() {
  const reserved = new Set(['Escape'])
  for (const key of ['ACTION_PANEL', 'OPEN_SETTINGS']) {
    const combo = SHELL_SHORTCUTS[key]
    if (combo) reserved.add(combo)
  }
  return reserved
}

/** 宿主保留组合键动态只读视图（兼容 Set.has / 迭代，且实时反映常用快捷键的修改与清空） */
export const RESERVED_DECLARATIVE_SHORTCUTS = Object.freeze({
  has(combo) {
    return getReservedDeclarativeShortcuts().has(combo)
  },
  get size() {
    return getReservedDeclarativeShortcuts().size
  },
  values() {
    return getReservedDeclarativeShortcuts().values()
  },
  [Symbol.iterator]() {
    return getReservedDeclarativeShortcuts()[Symbol.iterator]()
  }
})

// 序列号防竞态：确保慢速初始拉取不覆盖用户刚保存的最新快捷键
let stateVersion = 0

async function persistOverrides(overrides) {
  const serialized = JSON.stringify(overrides)
  if (typeof window !== 'undefined' && typeof window.ztools?.config?.set === 'function') {
    const res = await window.ztools.config.set(
      SHELL_SHORTCUTS_CONFIG_PATH,
      serialized,
      true,
      SHELL_SHORTCUTS_CONFIG_FILE
    )
    if (res === false || (res && typeof res === 'object' && res.success === false)) {
      throw new Error('config.set returned false')
    }
  }
  writeLocalCache(overrides)
  if (typeof window !== 'undefined' && typeof window.ztools?.sys?.reloadHotkeys === 'function') {
    try {
      await window.ztools.sys.reloadHotkeys()
    } catch (err) {
      console.warn('[shellShortcuts] 刷新宿主热键菜单失败:', err)
    }
  }
}

/** 从持久化配置刷新常用快捷键 */
export async function refreshShellShortcuts() {
  if (typeof window === 'undefined' || typeof window.ztools?.config?.get !== 'function') {
    return buildOverridesObjectFromState()
  }
  const versionAtStart = stateVersion
  try {
    const raw = await window.ztools.config.get(
      SHELL_SHORTCUTS_CONFIG_PATH,
      '',
      SHELL_SHORTCUTS_CONFIG_FILE
    )
    if (stateVersion !== versionAtStart) {
      return buildOverridesObjectFromState()
    }
    const overrides = parseShellShortcutsOverrides(raw)
    applyOverridesToState(overrides)
    writeLocalCache(overrides)
    return overrides
  } catch (err) {
    console.warn('[shellShortcuts] 读取常用快捷键配置失败:', err)
    return buildOverridesObjectFromState()
  }
}

/** 应用启动时初始化：先同步读取 localStorage 消除首屏闪屏，再异步与宿主配置对齐 */
export function initShellShortcuts() {
  const cached = readLocalCache()
  if (cached) {
    applyOverridesToState(cached)
  }
  return refreshShellShortcuts()
}

/** 修改或清空单项常用快捷键（combo 为 '' 表示清空；不允许编辑 back/Escape） */
export async function saveShellShortcut(id, rawCombo) {
  const entry = ID_TO_ENTRY.get(id)
  if (!entry) {
    return { success: false, reason: 'not_editable' }
  }
  const normalized = normalizeShellShortcutCombo(rawCombo)
  if (normalized === null) {
    return { success: false, reason: 'invalid' }
  }
  if (normalized) {
    const conflict = findConflictingShellShortcut(normalized, id)
    if (conflict) {
      return { success: false, reason: 'conflict', conflict }
    }
  }

  const prevCombo = SHELL_SHORTCUTS[entry.key]
  if (prevCombo === normalized) {
    return { success: true, combo: normalized, unchanged: true }
  }

  stateVersion += 1
  SHELL_SHORTCUTS[entry.key] = normalized
  const nextOverrides = buildOverridesObjectFromState()

  try {
    await persistOverrides(nextOverrides)
    return { success: true, combo: normalized }
  } catch (err) {
    // 持久化失败回滚内存状态，保证界面与磁盘一致
    SHELL_SHORTCUTS[entry.key] = prevCombo
    return { success: false, reason: 'save_failed', error: err }
  }
}

/** 一键恢复全部 5 项常用快捷键为默认值 */
export async function resetAllShellShortcuts() {
  const prevSnapshot = {}
  for (const entry of EDITABLE_SHELL_SHORTCUT_ENTRIES) {
    prevSnapshot[entry.key] = SHELL_SHORTCUTS[entry.key]
  }

  stateVersion += 1
  applyOverridesToState({})
  try {
    await persistOverrides({})
    return { success: true }
  } catch (err) {
    for (const entry of EDITABLE_SHELL_SHORTCUT_ENTRIES) {
      SHELL_SHORTCUTS[entry.key] = prevSnapshot[entry.key]
    }
    return { success: false, reason: 'save_failed', error: err }
  }
}

/** 响应宿主跨窗口广播 system.ShellShortcutsChange，实时同步主窗口/悬浮条/独立窗 */
export function applyExternalShellShortcuts(payload) {
  const raw =
    payload && typeof payload === 'object'
      ? (payload.shortcuts !== undefined ? payload.shortcuts : payload.raw)
      : payload
  const overrides = parseShellShortcutsOverrides(raw)
  stateVersion += 1
  applyOverridesToState(overrides)
  writeLocalCache(overrides)
  return overrides
}

/** 重置常用快捷键状态（仅供测试隔离使用） */
export function _resetShellShortcutsForTesting() {
  stateVersion += 1
  applyOverridesToState({})
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(SHELL_SHORTCUTS_STORAGE_KEY)
    } catch {
      // ignore
    }
  }
}
