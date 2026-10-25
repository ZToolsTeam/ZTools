export const HOTKEY_RULE_DESCRIPTION =
  '支持 Ctrl / Shift / Alt + A-Z、Space 或 F1-F24。'

export const HOTKEY_WAIT_TEXT = '按下快捷键'
export const HOTKEY_UNSUPPORTED_TEXT =
  '仅支持 Ctrl、Shift、Alt 与 A-Z / Space / F1-F24 组合'

export const isDoubleModifierHotkey = (value) =>
  typeof value === 'string' && /^double(?:ctrl|control|alt|shift)$/i.test(value.replace(/[+\s]/g, ''))

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
  const platform = await getHotkeyHostPlatform()
  let hostEnvironment = 'unknown'
  try {
    const ztools = typeof window === 'undefined' ? undefined : window.ztools
    if (typeof ztools?.isElectron === 'function' && ztools.isElectron()) {
      hostEnvironment = 'electron'
    }
  } catch (err) {
    console.warn('[hotkeyRecorder] 检测宿主环境失败:', err)
  }
  return {
    platform,
    hostEnvironment,
    supportsDoubleModifierHotkeys: false
  }
}

export function getHotkeyUnsupportedText(platform = 'unknown', allowDoubleTap = false) {
  if (platform !== 'windows' && platform !== 'macos') {
    return '无法识别宿主平台，快捷键录制暂不可用'
  }
  if (platform === 'macos') {
    return '仅支持 ⌘ / ⌃ / ⌥ / ⇧ 与 A-Z / Space / F1-F24 组合'
  }
  return allowDoubleTap
    ? `${HOTKEY_UNSUPPORTED_TEXT}，或双击 Ctrl / Alt / Shift`
    : HOTKEY_UNSUPPORTED_TEXT
}

export function formatHotkeyForPlatform(
  hotkey,
  platform = 'unknown',
  supportsDoubleModifierHotkeys = false
) {
  const value = typeof hotkey === 'string' ? hotkey : ''
  const compactValue = value.replace(/[+\s]/g, '')
  const doubleModifier = /^double(ctrl|control|alt|shift)$/i.exec(compactValue)
  if (doubleModifier) {
    if (!supportsDoubleModifierHotkeys) {
      const reason = platform === 'unknown' ? '平台未识别' : '当前宿主不支持'
      return `${value}（${reason}）`
    }
    const modifier = doubleModifier[1].toLowerCase()
    const label =
      modifier === 'ctrl' || modifier === 'control'
        ? 'Ctrl'
        : modifier[0].toUpperCase() + modifier.slice(1)
    return `双击 ${label}`
  }
  if (platform !== 'windows' && platform !== 'macos') {
    return value ? `${value}（平台未识别）` : ''
  }
  if (platform !== 'macos') return value
  const symbols = {
    ctrl: '⌘',
    commandorcontrol: '⌘',
    alt: '⌥',
    option: '⌥',
    shift: '⇧',
    control: '⌃'
  }
  return value.split('+').map((token) => symbols[token.trim().toLowerCase()] || token.trim()).join('+')
}

export function getHotkeyWaitText(platform = 'unknown', allowDoubleTap = false) {
  if (platform !== 'windows' && platform !== 'macos') {
    return '无法识别宿主平台，快捷键录制暂不可用'
  }
  if (platform === 'macos') return '按下快捷键 (⌘ / ⌃ / ⌥ / ⇧)'
  return allowDoubleTap ? '按下快捷键或双击 Ctrl / Alt / Shift' : HOTKEY_WAIT_TEXT
}

export function getHotkeyRuleDescription(platform = 'unknown', allowDoubleTap = false) {
  if (platform !== 'windows' && platform !== 'macos') {
    return '无法识别宿主平台，暂不能录制快捷键。'
  }
  if (platform === 'macos') {
    return '支持 ⌘ / ⌃ / ⌥ / ⇧ + A-Z、Space 或 F1-F24；不支持双击修饰键、方向键或数字。'
  }
  return allowDoubleTap
    ? HOTKEY_RULE_DESCRIPTION.replace(
        '；不支持',
        '；另支持双击 Ctrl / Alt / Shift；不支持'
      )
    : `${HOTKEY_RULE_DESCRIPTION} 当前宿主不支持双击修饰键。`
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

export const isSupportedSpaceKey = (key) => key === ' ' || key === 'Space' || key === 'Spacebar'

export const isSupportedMainKey = (key) =>
  /^[a-z]$/i.test(key) || isSupportedSpaceKey(key) || isSupportedFunctionKey(key)

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

const getMainKey = (event, platform) => {
  if (isSupportedMainKey(event.key)) return event.key
  // Option+letter produces characters such as π on macOS. Fall back to the
  // physical key code only for an Option chord so it records as a stable A-Z
  // accelerator instead of being rejected or storing a layout glyph.
  if (platform === 'macos' && event.altKey) {
    const codeMatch = /^Key([A-Z])$/.exec(event.code || '')
    if (codeMatch) return codeMatch[1]
    if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(event.code || '')) return event.code
    if (event.code === 'Space') return 'Space'
  }
  return event.key
}

export const parseSupportedHotkeyEvent = (event, options = {}) => {
  const platform = options.platform ?? 'windows'
  const allowDoubleTap = options.allowDoubleTap === true && platform === 'windows'
  const isMacOS = platform === 'macos'
  if (platform !== 'windows' && platform !== 'macos') {
    resetHotkeyRecorderState()
    return {
      status: 'invalid',
      text: getHotkeyUnsupportedText(platform)
    }
  }
  const modifiers = collectModifiers(event, platform)

  if (event.metaKey && !isMacOS) {
    resetHotkeyRecorderState()
    return {
      status: 'invalid',
      text: getHotkeyUnsupportedText(platform, allowDoubleTap)
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

  const mainKey = getMainKey(event, platform)
  if (!isSupportedMainKey(mainKey) || (modifiers.length === 0 && !isSupportedFunctionKey(mainKey))) {
    resetHotkeyRecorderState()
    return {
      status: 'invalid',
      text: getHotkeyUnsupportedText(platform, allowDoubleTap)
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
