import { BUILTIN_SHORTCUT_HINTS, SHELL_SHORTCUTS } from '@/utils/shellShortcuts'
import { t } from '@/i18n'

export const HOTKEY_RULE_DESCRIPTION_KEY = 'hotkey.recorder.ruleBase'
export const HOTKEY_WAIT_TEXT_KEY = 'hotkey.recorder.waitDefault'
export const HOTKEY_UNSUPPORTED_TEXT_KEY = 'hotkey.recorder.unsupportedWin'

/** 动态获取默认快捷键规则说明（避免模块顶层静态调用 t() 导致热切换冻结） */
export const getDefaultHotkeyRuleDescription = () => t(HOTKEY_RULE_DESCRIPTION_KEY)

/** 动态获取默认等待录入提示 */
export const getDefaultHotkeyWaitText = () => t(HOTKEY_WAIT_TEXT_KEY)

/** 动态获取默认不支持提示 */
export const getDefaultHotkeyUnsupportedText = () => t(HOTKEY_UNSUPPORTED_TEXT_KEY)

const DOUBLE_MODIFIER_CANONICAL = Object.freeze({
  doublectrl: 'DoubleCtrl',
  doublecontrol: 'DoubleCtrl',
  doublealt: 'DoubleAlt',
  doubleshift: 'DoubleShift'
})

export const isDoubleModifierHotkey = (value) =>
  typeof value === 'string' &&
  Object.hasOwn(DOUBLE_MODIFIER_CANONICAL, value.replace(/[+\s]/g, '').toLowerCase())

/** 将双击修饰键字符串归一化为 DoubleCtrl / DoubleAlt / DoubleShift */
export function normalizeDoubleModifierHotkey(value) {
  if (typeof value !== 'string') return ''
  const compact = value.replace(/[+\s]/g, '').toLowerCase()
  return Object.hasOwn(DOUBLE_MODIFIER_CANONICAL, compact) ? DOUBLE_MODIFIER_CANONICAL[compact] : ''
}

export async function getHotkeyHostPlatform() {
  if (typeof window === 'undefined' || typeof window.ztools?.sys?.getInfo !== 'function') {
    return 'unknown'
  }
  try {
    const info = await window.ztools.sys.getInfo()
    return info?.platform === 'windows' || info?.platform === 'macos'
      ? info.platform
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

export async function getHotkeyHostCapabilities() {
  const ztools = typeof window === 'undefined' ? undefined : window.ztools
  let platform = 'unknown'
  let hostEnvironment = 'unknown'
  let info = null
  let explicitNonElectron = false

  try {
    if (typeof ztools?.isElectron === 'function') {
      if (ztools.isElectron()) {
        hostEnvironment = 'electron'
      } else {
        explicitNonElectron = true
      }
    }
  } catch (err) {
    console.warn('[hotkeyRecorder] 检测宿主环境失败:', err)
  }

  if (typeof ztools?.sys?.getInfo === 'function') {
    try {
      info = await ztools.sys.getInfo()
      platform =
        info?.platform === 'windows' || info?.platform === 'macos'
          ? info.platform
          : 'unknown'
    } catch {
      platform = 'unknown'
    }
  }

  // 仅在 Windows 且非明确非 Electron 宿主显式声明能力时开启拓展触发器（macOS 或缺失字段保持 false）
  const isCapableWindowsHost = platform === 'windows' && !explicitNonElectron
  const supportsDoubleModifierHotkeys =
    isCapableWindowsHost && info?.supportsDoubleModifierHotkeys === true
  const supportsMouseTriggers =
    isCapableWindowsHost && info?.supportsMouseTriggers === true

  return {
    platform,
    hostEnvironment,
    supportsDoubleModifierHotkeys,
    supportsMouseTriggers
  }
}

export function getHotkeyUnsupportedText(platform = 'unknown', allowDoubleTap = false, allowShellKeys = false) {
  if (platform !== 'windows' && platform !== 'macos') {
    return t('hotkey.recorder.unknownPlatformUnsupported')
  }
  if (allowShellKeys) {
    return platform === 'macos'
      ? t('hotkey.recorder.unsupportedShellMac')
      : t('hotkey.recorder.unsupportedShellWin')
  }
  if (platform === 'macos') {
    return t('hotkey.recorder.unsupportedMac')
  }
  return allowDoubleTap
    ? t('hotkey.recorder.unsupportedWinDouble')
    : t('hotkey.recorder.unsupportedWin')
}

export function formatHotkeyForPlatform(
  hotkey,
  platform = 'unknown',
  supportsDoubleModifierHotkeys = false
) {
  const value = typeof hotkey === 'string' ? hotkey.trim() : ''
  if (!value) return ''
  const compactValue = value.replace(/[+\s]/g, '')
  const doubleModifier = /^double(ctrl|control|alt|shift)$/i.exec(compactValue)
  if (doubleModifier) {
    if (!supportsDoubleModifierHotkeys) {
      const reason =
        platform === 'unknown'
          ? t('hotkey.recorder.platformUnknown')
          : t('hotkey.recorder.hostUnsupported')
      return t('hotkey.recorder.unsupportedWithReason', { hotkey: value, reason })
    }
    const modifier = doubleModifier[1].toLowerCase()
    const label =
      modifier === 'ctrl' || modifier === 'control'
        ? 'Ctrl'
        : modifier[0].toUpperCase() + modifier.slice(1)
    return t('platform.doubleTap', { key: label })
  }
  if (platform !== 'macos') return value
  const symbols = {
    ctrl: '⌘',
    commandorcontrol: '⌘',
    cmdorctrl: '⌘',
    cmd: '⌘',
    command: '⌘',
    alt: '⌥',
    option: '⌥',
    shift: '⇧',
    control: '⌃'
  }
  return value.split('+').map((token) => symbols[token.trim().toLowerCase()] || token.trim()).join('+')
}

const MODIFIER_COMPARE_ORDER = ['ctrl', 'control', 'alt', 'shift', 'meta']

function canonicalizeHotkeyForCompare(hotkey, platform = 'windows') {
  if (typeof hotkey !== 'string' || !hotkey.trim()) return ''
  const doubleModifier = normalizeDoubleModifierHotkey(hotkey)
  if (doubleModifier) return doubleModifier.toLowerCase()

  const tokens = hotkey.split('+').map((t) => t.trim()).filter(Boolean)
  if (tokens.length === 0) return ''
  const rawMain = tokens[tokens.length - 1].toLowerCase()
  const mainKey =
    rawMain === 'esc'
      ? 'escape'
      : rawMain === 'return'
        ? 'enter'
        : rawMain === ' ' || rawMain === 'spacebar'
          ? 'space'
          : rawMain

  const mods = new Set()
  for (const token of tokens.slice(0, -1)) {
    const lower = token.toLowerCase()
    if (lower === 'ctrl' || lower === 'commandorcontrol' || lower === 'cmdorctrl') {
      mods.add('ctrl')
    } else if (lower === 'cmd' || lower === 'command') {
      mods.add(platform === 'macos' ? 'ctrl' : 'meta')
    } else if (lower === 'control') {
      mods.add(platform === 'macos' ? 'control' : 'ctrl')
    } else if (lower === 'alt' || lower === 'option') {
      mods.add('alt')
    } else if (lower === 'shift') {
      mods.add('shift')
    } else if (lower === 'meta' || lower === 'super' || lower === 'win') {
      mods.add(platform === 'macos' ? 'ctrl' : 'meta')
    } else {
      mods.add(lower)
    }
  }

  const orderedMods = MODIFIER_COMPARE_ORDER.filter((m) => mods.has(m))
  return [...orderedMods, mainKey].join('+')
}

// 系统核心保留快捷键黑名单（与宿主 contracts/hotkey-rules.ts 保持一致）
const WINDOWS_BLACKLISTED_HOTKEYS = new Set([
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

const MACOS_BLACKLISTED_HOTKEYS = new Set([
  'ctrl+c',
  'ctrl+v',
  'ctrl+x',
  'ctrl+z',
  'ctrl+a',
  'ctrl+q',
  'ctrl+w',
  'ctrl+tab',
  'ctrl+space',
  'ctrl+shift+3',
  'ctrl+shift+4',
  'ctrl+shift+5'
])

/**
 * 检查组合键是否命中操作系统关键黑名单；命中时返回明确中文原因，否则返回空字符串
 */
export function getSystemHotkeyBlacklistReason(hotkey, platform = 'windows') {
  const canonical = canonicalizeHotkeyForCompare(hotkey, platform)
  if (!canonical) return ''
  if (platform === 'macos') {
    if (MACOS_BLACKLISTED_HOTKEYS.has(canonical)) {
      const display = formatHotkeyForPlatform(hotkey, 'macos')
      return t('hotkey.recorder.blacklistMac', { key: display })
    }
    return ''
  }
  if (WINDOWS_BLACKLISTED_HOTKEYS.has(canonical)) {
    return t('hotkey.recorder.blacklistWin', { key: String(hotkey).trim() })
  }
  return ''
}

/**
 * 检测快捷键是否与 ZTools 壳层内置快捷键（SHELL_SHORTCUTS）重名，返回温和提示文案（空字符串表示无重叠）。
 * 动态读取 BUILTIN_SHORTCUT_HINTS 与 SHELL_SHORTCUTS，确保用户修改或清空常用快捷键后告警即时同步。
 */
export function getShellReserveWarning(hotkey) {
  if (typeof hotkey !== 'string' || !hotkey.trim()) return ''
  const canonical = canonicalizeHotkeyForCompare(hotkey, 'windows')
  if (!canonical) return ''
  for (const hint of BUILTIN_SHORTCUT_HINTS) {
    if (!hint.combo) continue
    const hintKey = canonicalizeHotkeyForCompare(hint.combo, 'windows')
    if (hintKey && hintKey === canonical && hint.id) {
      return t('hotkey.recorder.shellReserveWarning', { label: t(`settings.shortcuts.builtins.${hint.id}`) })
    }
  }
  const pinKey = canonicalizeHotkeyForCompare(SHELL_SHORTCUTS.PIN_ITEM, 'windows')
  if (pinKey && pinKey === canonical) {
    return t('hotkey.recorder.shellReserveWarning', { label: t('hotkey.recorder.pinItemLabel') })
  }
  return ''
}

const SAFE_SHORTCUT_MODIFIER_TOKENS = new Set([
  'ctrl',
  'control',
  'alt',
  'option',
  'shift',
  'cmd',
  'command',
  'meta',
  'super',
  'win',
  'commandorcontrol',
  'cmdorctrl',
  '⌘',
  '⌥',
  '⇧',
  '⌃'
])

const SAFE_SHORTCUT_KEY_TOKENS = new Set([
  'space',
  'spacebar',
  'tab',
  'enter',
  'return',
  'escape',
  'esc',
  'backspace',
  'delete',
  'del',
  'insert',
  'ins',
  'home',
  'end',
  'pageup',
  'pagedown',
  'pgup',
  'pgdn',
  'up',
  'down',
  'left',
  'right',
  'arrowup',
  'arrowdown',
  'arrowleft',
  'arrowright',
  'plus',
  'minus',
  'comma',
  'period',
  'slash',
  'backslash',
  'backquote'
])

function isSafeShortcutToken(token) {
  if (!token || /\s/.test(token)) return false
  const lower = token.toLowerCase()
  if (SAFE_SHORTCUT_MODIFIER_TOKENS.has(lower) || SAFE_SHORTCUT_KEY_TOKENS.has(lower)) {
    return true
  }
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return true
  // 单字符物理键（A-Z、0-9 及常用标点如 ` ~ , . / - = [ ] ; ' \）
  if (token.length === 1 && /^[\x21-\x7e]$/.test(token) && token !== '(' && token !== ')') {
    return true
  }
  return false
}

function isPendingModifierSequence(text) {
  if (typeof text !== 'string') return false
  const trimmed = text.trim()
  if (!trimmed.endsWith('+...')) return false
  const prefix = trimmed.slice(0, -4)
  if (!prefix) return false
  const parts = prefix.split('+').map((part) => part.trim())
  return parts.length > 0 && parts.every((part) => SAFE_SHORTCUT_MODIFIER_TOKENS.has(part.toLowerCase()))
}

/**
 * 判断快捷键字符串是否可安全传给 <ShortcutKeys>（禁止传入中英文说明提示语、括号注释或未知状态文本）
 */
export function isSafeShortcutKeysCombo(hotkey, platform = 'unknown', supportsDoubleModifierHotkeys = false) {
  if (typeof hotkey !== 'string') return false
  const trimmed = hotkey.trim()
  if (!trimmed) return false
  // 排除包含全角/半角括号、中文字符、句末省略号或句子级说明文本的提示字符串
  if (/[\u4e00-\u9fff（）()]/.test(trimmed) || trimmed.includes('...')) return false
  if (isDoubleModifierHotkey(trimmed)) {
    return platform === 'windows' && Boolean(supportsDoubleModifierHotkeys)
  }
  const tokens = trimmed.split('+').map((part) => part.trim())
  if (tokens.length === 0 || tokens.length > 5 || tokens.some((part) => !part)) {
    return false
  }
  return tokens.every(isSafeShortcutToken)
}

export function getHotkeyWaitText(platform = 'unknown', allowDoubleTap = false) {
  if (platform !== 'windows' && platform !== 'macos') {
    return t('hotkey.recorder.unknownPlatformUnsupported')
  }
  if (platform === 'macos') return t('hotkey.recorder.waitMac')
  return allowDoubleTap ? t('hotkey.recorder.waitWinDouble') : t('hotkey.recorder.waitDefault')
}

export function getHotkeyRuleDescription(platform = 'unknown', allowDoubleTap = false) {
  if (platform !== 'windows' && platform !== 'macos') {
    return t('hotkey.recorder.unknownPlatformRule')
  }
  if (platform === 'macos') {
    return t('hotkey.recorder.ruleMac')
  }
  return allowDoubleTap
    ? t('hotkey.recorder.ruleWinDouble')
    : t('hotkey.recorder.ruleWinNoDouble')
}

const SUPPORTED_MODIFIER_KEYS = ['Control', 'Alt', 'Shift']
const DOUBLE_TAP_INTERVAL_MS = 400
const MODIFIER_HOTKEY_NAME = {
  Control: 'Ctrl',
  Alt: 'Alt',
  Shift: 'Shift'
}

let lastModifierTap = {
  key: '',
  time: 0
}

const collectModifiers = (event, platform) => {
  const modifiers = []
  if (event.metaKey && platform === 'macos') modifiers.push('Ctrl')
  if (event.ctrlKey) modifiers.push(platform === 'macos' ? 'Control' : 'Ctrl')
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')
  return modifiers
}

export const isSupportedModifierKey = (key) => SUPPORTED_MODIFIER_KEYS.includes(key)

export const isSupportedFunctionKey = (key) => /^F([1-9]|1[0-9]|2[0-4])$/i.test(key)

export const isSupportedSpaceKey = (key) =>
  key === ' ' ||
  key === 'Space' ||
  key === 'Spacebar' ||
  key === '\u00a0' ||
  key === '\u3000'

export const isSupportedMainKey = (key) =>
  /^[a-z]$/i.test(key) || isSupportedSpaceKey(key) || isSupportedFunctionKey(key) ||
  key === '`' || key === '~'

const SHELL_PUNCTUATION_KEYS = new Set([',', '.', '/', ';', '[', ']', '-', '='])
const SHELL_PUNCTUATION_CODE_MAP = Object.freeze({
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '='
})

export const isSupportedShellMainKey = (key) =>
  isSupportedMainKey(key) || /^[0-9]$/.test(key) || SHELL_PUNCTUATION_KEYS.has(key)

export const resetHotkeyRecorderState = () => {
  lastModifierTap = {
    key: '',
    time: 0
  }
}

const getEventTime = (event) =>
  Number.isFinite(event.timeStamp) && event.timeStamp > 0 ? event.timeStamp : Date.now()

const isStandaloneModifierTap = (event, modifiers) =>
  isSupportedModifierKey(event.key) &&
  modifiers.length === 1 &&
  modifiers[0] === MODIFIER_HOTKEY_NAME[event.key]

const normalizeMainKey = (key) => (isSupportedSpaceKey(key) ? 'Space' : key.toUpperCase())

const getMainKeyFromCode = (event, allowShellKeys = false) => {
  const code = event?.code || ''
  if (code === 'Space') return 'Space'
  const codeMatch = /^Key([A-Z])$/.exec(code)
  if (codeMatch) return codeMatch[1]
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(code)) return code.toUpperCase()
  if (code === 'Backquote') return event?.shiftKey ? '~' : '`'
  if (allowShellKeys) {
    const digitMatch = /^Digit([0-9])$/.exec(code)
    if (digitMatch) return digitMatch[1]
    if (!event?.shiftKey && Object.hasOwn(SHELL_PUNCTUATION_CODE_MAP, code)) {
      return SHELL_PUNCTUATION_CODE_MAP[code]
    }
  }
  return ''
}

const getMainKey = (event, platform, allowShellKeys = false) => {
  if (event?.code === 'Space' || isSupportedSpaceKey(event?.key) || event?.keyCode === 32) {
    return 'Space'
  }
  // 中文输入法全角逗号兼容（常用快捷键如 Ctrl+,）
  if (allowShellKeys && !event?.shiftKey && (event?.key === '，' || event?.code === 'Comma')) {
    return ','
  }
  const checkMainKey = allowShellKeys ? isSupportedShellMainKey : isSupportedMainKey
  // Option 可能把字母键变成 `、~ 等支持的字符，先还原物理字母键，避免录成另一颗键。
  if (platform === 'macos' && event?.altKey) {
    const codeMatch = /^Key([A-Z])$/.exec(event?.code || '')
    if (codeMatch) return codeMatch[1]
    if (allowShellKeys) {
      const digitMatch = /^Digit([0-9])$/.exec(event?.code || '')
      if (digitMatch) return digitMatch[1]
      if (!event?.shiftKey && Object.hasOwn(SHELL_PUNCTUATION_CODE_MAP, event?.code || '')) {
        return SHELL_PUNCTUATION_CODE_MAP[event.code]
      }
    }
    if (checkMainKey(event?.key)) return event.key
    const codeKey = getMainKeyFromCode(event, allowShellKeys)
    if (codeKey) return codeKey
  }
  if (checkMainKey(event?.key)) return event.key
  // Windows 中文输入法（IME）下按 Ctrl+Space / Shift+Space / Ctrl+字母 等可能产生 key='Process' (229)，从物理键码还原
  const fallbackCodeKey = getMainKeyFromCode(event, allowShellKeys)
  if (fallbackCodeKey) return fallbackCodeKey
  return event?.key
}

export const parseSupportedHotkeyEvent = (event, options = {}) => {
  const platform = options.platform ?? 'windows'
  const allowShellKeys = options.allowShellKeys === true
  const allowDoubleTap = !allowShellKeys && options.allowDoubleTap === true && platform === 'windows'
  const isMacOS = platform === 'macos'
  if (platform !== 'windows' && platform !== 'macos') {
    resetHotkeyRecorderState()
    return {
      status: 'invalid',
      text: getHotkeyUnsupportedText(platform, false, allowShellKeys)
    }
  }
  if (!event || typeof event !== 'object') {
    resetHotkeyRecorderState()
    return {
      status: 'invalid',
      text: getHotkeyUnsupportedText(platform, allowDoubleTap, allowShellKeys)
    }
  }

  // 支持宿主转发的双按修饰键合成事件（如 DoubleCtrl / DoubleAlt / DoubleShift）
  const syntheticDouble =
    normalizeDoubleModifierHotkey(event.key) || normalizeDoubleModifierHotkey(event.code)
  if (syntheticDouble) {
    resetHotkeyRecorderState()
    if (!allowDoubleTap) {
      return {
        status: 'invalid',
        text: getHotkeyUnsupportedText(platform, allowDoubleTap, allowShellKeys)
      }
    }
    return {
      status: 'valid',
      hotkey: syntheticDouble,
      text: formatHotkeyForPlatform(syntheticDouble, platform, allowDoubleTap)
    }
  }

  const modifiers = collectModifiers(event, platform)

  if (event.metaKey && !isMacOS) {
    resetHotkeyRecorderState()
    return {
      status: 'invalid',
      text: getHotkeyUnsupportedText(platform, allowDoubleTap, allowShellKeys)
    }
  }

  if (isMacOS && event.key === 'Meta') {
    resetHotkeyRecorderState()
    return {
      status: 'pending',
      text: formatHotkeyForPlatform(`${modifiers.join('+')}+...`, platform)
    }
  }

  if (isSupportedModifierKey(event.key)) {
    if (event.repeat) {
      return {
        status: 'pending',
        text: formatHotkeyForPlatform(
          modifiers.length > 0 ? `${modifiers.join('+')}+...` : getHotkeyWaitText(platform, allowDoubleTap),
          platform
        )
      }
    }

    if (
      allowDoubleTap &&
      !(isMacOS && modifiers.includes('Control')) &&
      isStandaloneModifierTap(event, modifiers)
    ) {
      const hotkeyName = event.key === 'Control' && isMacOS
        ? 'Control'
        : MODIFIER_HOTKEY_NAME[event.key]
      const now = getEventTime(event)
      if (
        lastModifierTap.key === hotkeyName &&
        now - lastModifierTap.time <= DOUBLE_TAP_INTERVAL_MS
      ) {
        resetHotkeyRecorderState()
        const hotkey = `Double${hotkeyName}`
        return {
          status: 'valid',
          hotkey,
          text: formatHotkeyForPlatform(hotkey, platform, allowDoubleTap)
        }
      }

      lastModifierTap = {
        key: hotkeyName,
        time: now
      }
    }

    return {
      status: 'pending',
      text: formatHotkeyForPlatform(
        modifiers.length > 0 ? `${modifiers.join('+')}+...` : getHotkeyWaitText(platform, allowDoubleTap),
        platform
      )
    }
  }

  const mainKey = getMainKey(event, platform, allowShellKeys)
  const checkMainKey = allowShellKeys ? isSupportedShellMainKey : isSupportedMainKey
  if (modifiers.length > 0) {
    const candidateSpecialKey =
      event.key === 'Tab' || event.code === 'Tab'
        ? 'Tab'
        : event.key === 'Escape' || event.key === 'Esc' || event.code === 'Escape'
          ? 'Escape'
          : /^[0-9]$/.test(String(event.key || ''))
            ? String(event.key)
            : checkMainKey(mainKey)
              ? normalizeMainKey(mainKey)
              : ''
    if (candidateSpecialKey) {
      const blacklistReason = getSystemHotkeyBlacklistReason(
        [...modifiers, candidateSpecialKey].join('+'),
        platform
      )
      if (blacklistReason) {
        resetHotkeyRecorderState()
        return {
          status: 'invalid',
          text: blacklistReason
        }
      }
    }
  }

  // 应用内常用快捷键不允许纯 Shift + 非 F 键（会破坏输入框大小写与符号输入）
  const hasPrimaryOrAlt =
    modifiers.includes('Ctrl') || modifiers.includes('Control') || modifiers.includes('Alt')
  const isShellShiftOnlyInvalid =
    allowShellKeys && !isSupportedFunctionKey(mainKey) && !hasPrimaryOrAlt
  const isShellPunctuationWithShift =
    allowShellKeys && event.shiftKey && SHELL_PUNCTUATION_KEYS.has(mainKey)

  if (
    !checkMainKey(mainKey) ||
    (modifiers.length === 0 && !isSupportedFunctionKey(mainKey)) ||
    isShellShiftOnlyInvalid ||
    isShellPunctuationWithShift
  ) {
    resetHotkeyRecorderState()
    return {
      status: 'invalid',
      text: getHotkeyUnsupportedText(platform, allowDoubleTap, allowShellKeys)
    }
  }

  resetHotkeyRecorderState()
  const hotkey = [...modifiers, normalizeMainKey(mainKey)].join('+')
  return {
    status: 'valid',
    hotkey,
    text: formatHotkeyForPlatform(hotkey, platform)
  }
}

/**
 * 快捷键录入框里的一次按键：单独 Esc 取消录入，单独按 ⌫ / Delete 清除已有快捷键，其余交给 parseSupportedHotkeyEvent。
 * 返回 { action: 'cancel' | 'clear' | 'pending' | 'invalid' | 'valid', hotkey?, text, isKeys }
 * isKeys 为 true 时 text 是已按下的组合键（界面用键帽显示），否则 text 是提示语（用文字显示）。
 */
export function interpretRecorderKeydown(event, options = {}) {
  const bare = !event?.ctrlKey && !event?.metaKey && !event?.altKey && !event?.shiftKey
  if (bare && event?.key === 'Escape') return { action: 'cancel', text: '', isKeys: false }
  if (bare && (event?.key === 'Backspace' || event?.key === 'Delete')) return { action: 'clear', text: '', isKeys: false }
  const result = parseSupportedHotkeyEvent(event, options)
  if (result.status === 'valid') {
    return { action: 'valid', hotkey: result.hotkey, text: result.hotkey, isKeys: true }
  }
  const isKeys =
    result.status === 'pending' &&
    isPendingModifierSequence(result.text)
  return { action: result.status, hotkey: result.hotkey, text: result.text, isKeys }
}

/**
 * 供 Electron 主进程在拦截系统级组合键（如 Alt+Space / Ctrl+Space 或已注册全局热键）后，
 * 将按键安全派发给当前正处于录制状态的隐藏输入框（.hotkey-hidden-input）。
 * 返回 boolean 表示当前是否存在激活的录制框并已接收该按键。
 */
/**
 * 通知 Electron 主进程当前是否有快捷键录入框处于激活录制状态，
 * 以便主进程在录制期间临时在系统内核层捕获 Ctrl+Space / Alt+Space / Shift+Space 等组合键。
 */
export function notifyHotkeyRecorderActive(active) {
  if (typeof window === 'undefined') return
  const payload = { active: Boolean(active) }
  try {
    if (typeof window.ztools?.events?.emit === 'function') {
      void Promise.resolve(window.ztools.events.emit('hotkey_recorder_active', payload)).catch(
        () => undefined
      )
      return
    }
    const rawPublish = window.__ztoolsElectron?.transport?.methods?.event_publish
    if (typeof rawPublish === 'function') {
      void Promise.resolve(
        rawPublish({
          envelope: {
            envelopeId:
              typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                ? `rec_${crypto.randomUUID()}`
                : `rec_${Date.now()}`,
            version: 'v1',
            timestamp: Date.now(),
            type: 'hotkey_recorder_active',
            scope: 'system',
            source: { kind: 'page' },
            target: { broadcast: true },
            payload
          }
        })
      ).catch(() => undefined)
    }
  } catch {
    // 忽略非宿主环境异常
  }
}

export function dispatchSyntheticRecorderHotkey(payload = {}) {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  let targetInput =
    active && active.classList?.contains?.('hotkey-hidden-input') ? active : null
  if (!targetInput && typeof document.querySelector === 'function') {
    targetInput = document.querySelector(
      '.hotkey-recorder.recording:not(.loading) .hotkey-hidden-input'
    )
  }
  if (!targetInput) return false
  const recorder = targetInput.closest?.('.hotkey-recorder')
  if (recorder && (!recorder.classList.contains('recording') || recorder.classList.contains('loading'))) {
    return false
  }
  const key = typeof payload.key === 'string' && payload.key ? payload.key : ' '
  const code =
    typeof payload.code === 'string' && payload.code
      ? payload.code
      : key === ' '
        ? 'Space'
        : key
  const event = new KeyboardEvent('keydown', {
    key,
    code,
    keyCode: code === 'Space' ? 32 : 0,
    which: code === 'Space' ? 32 : 0,
    ctrlKey: Boolean(payload.ctrlKey),
    altKey: Boolean(payload.altKey),
    shiftKey: Boolean(payload.shiftKey),
    metaKey: Boolean(payload.metaKey),
    bubbles: true,
    cancelable: true
  })
  targetInput.dispatchEvent(event)
  return true
}

let recorderFocusListenersBound = false
function bindGlobalRecorderFocusListeners() {
  if (recorderFocusListenersBound || typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
    return
  }
  recorderFocusListenersBound = true
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event?.target
      if (target && target.classList?.contains?.('hotkey-hidden-input')) {
        notifyHotkeyRecorderActive(true)
      }
    },
    true
  )
  document.addEventListener(
    'focusout',
    (event) => {
      const target = event?.target
      if (!target || !target.classList?.contains?.('hotkey-hidden-input')) return
      queueMicrotask(() => {
        const stillFocused = document.activeElement?.classList?.contains?.('hotkey-hidden-input')
        const stillRecording =
          typeof document.querySelector === 'function' &&
          Boolean(document.querySelector('.hotkey-recorder.recording:not(.loading)'))
        if (!stillFocused && !stillRecording) {
          notifyHotkeyRecorderActive(false)
        }
      })
    },
    true
  )
}

if (typeof window !== 'undefined') {
  window.__ztoolsDispatchRecorderHotkey = dispatchSyntheticRecorderHotkey
  bindGlobalRecorderFocusListeners()
}
