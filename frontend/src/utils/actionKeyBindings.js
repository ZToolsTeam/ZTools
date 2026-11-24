/**
 * 「所见即所按」统一动作快捷键解析器
 * 保证底栏提示、动作面板键帽渲染与实际按键派发始终一致，消除假徽标与 Ctrl+Enter 错位。
 */
import { isMacOS } from '@/utils/platform.js'
import { RESERVED_DECLARATIVE_SHORTCUTS } from '@/utils/shellShortcuts.js'

const MODIFIER_CANONICAL = Object.freeze({
  cmd: 'Ctrl',
  command: 'Ctrl',
  meta: 'Ctrl',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  opt: 'Alt',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift'
})

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift']

export function normalizeDeclarativeKeyName(rawKey) {
  const trimmed = String(rawKey || '').trim()
  const lower = trimmed.toLowerCase()
  if (!lower) return ''
  if (lower === 'return' || lower === 'enter') return 'Enter'
  if (lower === 'esc' || lower === 'escape') return 'Escape'
  if (lower === 'del' || lower === 'delete') return 'Delete'
  if (lower === 'backspace') return 'Backspace'
  if (lower === ' ' || lower === 'spacebar' || lower === 'space') return 'Space'
  if (lower === 'up' || lower === 'arrowup') return 'ArrowUp'
  if (lower === 'down' || lower === 'arrowdown') return 'ArrowDown'
  if (lower === 'left' || lower === 'arrowleft') return 'ArrowLeft'
  if (lower === 'right' || lower === 'arrowright') return 'ArrowRight'
  if (lower === 'plus' || trimmed === '+') return 'Plus'
  if (trimmed.length === 1) return trimmed.toUpperCase()
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

/**
 * 将插件 Action.shortcut（对象或字符串）归一化为内部统一展示及匹配键串，如 'Ctrl+Shift+O'、'Enter'、'Delete'
 */
export function normalizeActionShortcutCombo(rawShortcut) {
  if (!rawShortcut) return ''
  const shortcut =
    typeof rawShortcut === 'string'
      ? { modifiers: [], key: rawShortcut }
      : rawShortcut
  if (typeof shortcut !== 'object' || typeof shortcut.key !== 'string' || !shortcut.key.trim()) {
    return ''
  }
  const mods = Array.isArray(shortcut.modifiers) ? shortcut.modifiers : []
  const modSet = new Set()
  for (const mod of mods) {
    const mapped = MODIFIER_CANONICAL[String(mod).toLowerCase()]
    if (mapped) modSet.add(mapped)
  }
  const mainKey = normalizeDeclarativeKeyName(shortcut.key)
  if (!mainKey) return ''
  const orderedMods = MODIFIER_ORDER.filter((m) => modSet.has(m))
  return [...orderedMods, mainKey].join('+')
}

/** 从键盘事件提取规范键名，支持 Windows 中文 IME keyCode=229 时通过 e.code 还原物理按键 */
export function normalizeEventShortcutKey(e) {
  const key = String(e?.key || '')
  if (
    (!key || key === 'Process' || key === 'Unidentified') &&
    typeof e?.code === 'string'
  ) {
    const code = e.code
    const letter = /^Key([A-Z])$/.exec(code)
    if (letter) return letter[1]
    const digit = /^Digit([0-9])$/.exec(code)
    if (digit) return digit[1]
    if (code === 'Space') return 'Space'
    if (code === 'Enter' || code === 'NumpadEnter') return 'Enter'
    if (code === 'Comma') return ','
    if (code === 'Period') return '.'
    if (code === 'Backquote') return e.shiftKey ? '~' : '`'
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  }
  if (key === '，') return ','
  return normalizeDeclarativeKeyName(key)
}

/**
 * 判断键盘事件是否匹配内部统一 combo（如 'Ctrl+Shift+C'）。
 * macOS 上 'Ctrl' 严格匹配 ⌘ (metaKey) 且排除物理 ⌃ (ctrlKey)；Windows 上严格匹配 Ctrl (ctrlKey) 且排除 Win 键。
 */
export function eventMatchesCombo(e, combo, mac = isMacOS()) {
  if (!e || !combo) return false
  const parts = String(combo).split('+').filter(Boolean)
  if (parts.length === 0) return false
  const mainKey = parts[parts.length - 1]
  const modParts = parts.slice(0, -1)

  const wantPrimary = modParts.includes('Ctrl')
  const wantAlt = modParts.includes('Alt')
  const wantShift = modParts.includes('Shift')

  const hasPrimary = Boolean(mac ? e.metaKey : e.ctrlKey)
  const hasOther = Boolean(mac ? e.ctrlKey : e.metaKey)
  const hasAlt = Boolean(e.altKey)
  const hasShift = Boolean(e.shiftKey)

  if (hasOther || wantPrimary !== hasPrimary || wantAlt !== hasAlt || wantShift !== hasShift) {
    return false
  }
  const eventKey = normalizeEventShortcutKey(e)
  return eventKey.toLowerCase() === mainKey.toLowerCase()
}

const isDevEnv = typeof import.meta !== 'undefined' && Boolean(import.meta.env?.DEV)

function warnDuplicateOrReserved(message) {
  if (isDevEnv) {
    console.warn(`[ActionKeyBindings] ${message}`)
  }
}

/**
 * 统一解析动作列表的实际按键归属与 UI 提示映射：
 * - 宿主保留键（如 Ctrl+Shift+P / Ctrl+, / Ctrl+U / Ctrl+K / Escape）优先由宿主消费，不展示冲突徽标；
 * - 重复声明同一 shortcut 时，首个动作获胜，后续动作清除徽标防误导；
 * - 若动作列表已有人显式声明 'Ctrl+Enter'，则次动作快捷键归该显式动作，不再硬绑给下标 1；
 *   否则在非 Form 视图下默认把 'Ctrl+Enter' 赋给直达动作第 2 项。
 */
export function resolveActionKeyBindings(actions, options = {}) {
  const list = Array.isArray(actions) ? actions : []
  const viewType = options.viewType || 'List'
  const isForm = viewType === 'Form'
  const reserved = options.reservedCombos || RESERVED_DECLARATIVE_SHORTCUTS

  const directActions = list.filter((act) => !act?._fromSubmenu)
  const primaryAction = directActions[0] || null

  const hints = new Map()
  const comboToAction = new Map()
  const claimedByExplicit = new Set()

  // 第一轮：校验显式声明的 shortcut（优先保留先声明者；排除宿主保留键）
  for (const action of list) {
    const combo = normalizeActionShortcutCombo(action?.props?.shortcut)
    if (!combo) continue

    if (reserved.has(combo)) {
      warnDuplicateOrReserved(`Action "${action?.props?.title || ''}" shortcut ${combo} conflicts with host reserved key; ignored`)
      continue
    }
    if (claimedByExplicit.has(combo)) {
      warnDuplicateOrReserved(`Action "${action?.props?.title || ''}" duplicated shortcut ${combo}; keeping first declaration`)
      continue
    }
    claimedByExplicit.add(combo)
    comboToAction.set(combo, action)
    hints.set(action, combo)
  }

  // 决定次动作（Ctrl+Enter）归属：显式声明 Ctrl+Enter 优先于第 2 顺位默认规则
  const explicitCtrlEnterAction = comboToAction.get('Ctrl+Enter') || null
  let secondaryAction = null
  if (!isForm) {
    if (explicitCtrlEnterAction && !explicitCtrlEnterAction._fromSubmenu) {
      secondaryAction = explicitCtrlEnterAction
    } else if (!explicitCtrlEnterAction) {
      secondaryAction = directActions[1] || null
    }
  }

  // 第二轮：为未显式声明快捷键的主/次直达动作补充默认 Enter / Ctrl+Enter 提示
  if (isForm) {
    if (primaryAction && !hints.has(primaryAction) && !claimedByExplicit.has('Ctrl+Enter')) {
      hints.set(primaryAction, 'Ctrl+Enter')
      comboToAction.set('Ctrl+Enter', primaryAction)
    }
  } else {
    if (primaryAction && !hints.has(primaryAction) && !claimedByExplicit.has('Enter')) {
      hints.set(primaryAction, 'Enter')
    }
    if (
      secondaryAction &&
      !hints.has(secondaryAction) &&
      !claimedByExplicit.has('Ctrl+Enter')
    ) {
      hints.set(secondaryAction, 'Ctrl+Enter')
      comboToAction.set('Ctrl+Enter', secondaryAction)
    }
  }

  // 生成有序可匹配条目（供运行时快速查找）
  const shortcutEntries = []
  for (const [combo, action] of comboToAction.entries()) {
    // 默认自动附加给主/次动作的 Enter / Ctrl+Enter 由视图固定按键表调度，这里保留显式绑定与显式 Ctrl+Enter
    const isExplicit = Boolean(normalizeActionShortcutCombo(action?.props?.shortcut))
    if (isExplicit) {
      shortcutEntries.push({ combo, action })
    }
  }

  return {
    hints,
    comboToAction,
    shortcutEntries,
    primaryAction,
    secondaryAction,
    hintOf(action) {
      return hints.get(action) || ''
    },
    matchEvent(event, mac = isMacOS()) {
      for (const entry of shortcutEntries) {
        if (eventMatchesCombo(event, entry.combo, mac)) {
          return entry.action
        }
      }
      return null
    }
  }
}
