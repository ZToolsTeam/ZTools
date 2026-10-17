/**
 * Platform detection and plugin targeting utilities for Frontend.
 */

export function isMacOS() {
  if (typeof navigator !== 'undefined') {
    if (navigator.userAgentData?.platform) {
      return navigator.userAgentData.platform.toLowerCase().includes('mac')
    }
    const platform = navigator.platform || ''
    const userAgent = navigator.userAgent || ''
    if (platform.toLowerCase().includes('mac') || userAgent.toLowerCase().includes('macintosh')) {
      return true
    }
  }
  return false
}

export function isWindows() {
  if (typeof navigator !== 'undefined') {
    if (navigator.userAgentData?.platform) {
      return navigator.userAgentData.platform.toLowerCase().includes('win')
    }
    const platform = navigator.platform || ''
    const userAgent = navigator.userAgent || ''
    if (platform.toLowerCase().includes('win') || userAgent.toLowerCase().includes('windows')) {
      return true
    }
  }
  return false
}

/**
 * Windows-exclusive plugins that must be hidden on macOS (Tier 4).
 */
export const WINDOWS_EXCLUSIVE_PLUGIN_IDS = new Set([
  'boost',
  'context-menu',
  'cleaner',
  'qq-cleaner',
  'wechat-cleaner',
  'flow-guard',
  'network-adapter',
  'network-rescue',
  'hardware-info',
  // 实现完全依赖 Windows（shutdown.exe / PowerShell / 任务栏 / winget）
  'system',
  'windows-run',
  'windows-taskbar',
  'windows-shortcuts',
  'winget',
  // 依赖 Windows 原生组件（DLLPlugins）；其他系统上调用失败后只会返回模拟数据
  'disk-analyzer',
  'process-monitor',
  'software-manager',
  'batch-audio',
  'batch-rename',
  'batch-video',
  'multi-download',
  'video-downloader',
  'pdf',
  'color-picker'
])

/**
 * 在所有系统上都暂不可用、不展示的内置插件。
 * 原因是宿主没有给它们提供所需能力，或它们本身不是插件；它们目前只能显示示例数据或假装执行成功。
 * 真正接上宿主能力后，再从这里移出。
 */
export const UNAVAILABLE_PLUGIN_IDS = new Set([
  // 不是插件：客户端自身的设置、账户、更新、推广页面
  'raycast-settings',
  'raycast-core',
  'raycast-account',
  'raycast-wrapped',
  'trial-nudges',
  'organizations',
  // 宿主未提供所需能力，只能展示示例数据或假成功
  'window-management',
  'clipboard-history',
  'snippets',
  'everything-file-search',
  'kill-process',
  'wifi-password-reveal',
  'applications',
  'audio-device',
  'clean-keyboard',
  'downloads-manager',
  'screenshots',
  'github',
  'obsidian',
  // 结果是编造的：随机网速、静态汇率、只回显原文的翻译、不可扫描的二维码、20 个词的词典
  'speedtest',
  'currency-exchange',
  'translator',
  'qr-code',
  'dictionary',
  // 条目以明文写入本地存储，不能作为密码保险箱提供
  'password-vault'
])

/**
 * Check if a plugin is supported on the current platform.
 * @param {string|object} plugin - Plugin ID string or plugin object
 * @returns {boolean}
 */
export function isPluginSupportedOnCurrentPlatform(plugin) {
  if (!plugin) return false
  const pluginId = typeof plugin === 'string'
    ? plugin
    : (plugin.pluginId || plugin.id || '')
  const normalizedId = String(pluginId).trim().toLowerCase()

  if (UNAVAILABLE_PLUGIN_IDS.has(normalizedId)) return false

  // On macOS, Tier 4 Windows-exclusive plugins are never supported
  if (isMacOS() && WINDOWS_EXCLUSIVE_PLUGIN_IDS.has(normalizedId)) {
    return false
  }

  // If plugin manifest/data explicitly defines platforms, check current platform
  if (typeof plugin === 'object' && Array.isArray(plugin.platforms) && plugin.platforms.length > 0) {
    const matches = plugin.platforms.some((p) => {
      const norm = String(p).trim().toLowerCase()
      if (norm === 'darwin' || norm === 'macos' || norm === 'mac') return isMacOS()
      if (norm === 'win32' || norm === 'windows' || norm === 'win') return isWindows()
      return false
    })
    if (!matches) return false
  }

  return true
}

const MAC_SHORTCUT_SYMBOLS = Object.freeze({
  ctrl: '⌘',
  commandorcontrol: '⌘',
  cmd: '⌘',
  meta: '⌘',
  control: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  enter: '↵',
  escape: 'Esc',
  esc: 'Esc'
})

/**
 * 界面快捷键提示文案：内部统一用 Windows 写法（Ctrl / Alt），
 * macOS 上按系统习惯显示符号且不带加号，例如 Ctrl+K → ⌘K、Alt+Space → ⌥Space。
 * keymap 会把 ⌘ 归一化为 Ctrl，因此展示与实际触发保持一致。
 * @param {string} combo - 例如 'Ctrl+K'
 * @param {boolean} [mac] - 是否按 macOS 展示，默认自动检测
 */
export function shortcutLabel(combo, mac = isMacOS()) {
  if (typeof combo !== 'string' || !combo.trim()) return ''
  const tokens = combo.split('+').map((token) => token.trim()).filter(Boolean)
  if (!mac) return tokens.join('+')
  // 用 hasOwn 查表，避免 constructor / __proto__ 等键名命中原型属性
  return tokens
    .map((token) => {
      const key = token.toLowerCase()
      return Object.hasOwn(MAC_SHORTCUT_SYMBOLS, key) ? MAC_SHORTCUT_SYMBOLS[key] : token
    })
    .join('')
}

const KEY_NAMES = Object.freeze({
  // Electron 加速键写法（触发器里保存的快捷键可能是这种形式）
  commandorcontrol: { mac: '⌘', win: 'Ctrl' },
  cmdorctrl: { mac: '⌘', win: 'Ctrl' },
  control: { mac: '⌃', win: 'Ctrl' },
  option: { mac: '⌥', win: 'Alt' },
  meta: { mac: '⌘', win: 'Win' },
  super: { mac: '⌘', win: 'Win' },
  enter: { mac: '↵', win: 'Enter' },
  return: { mac: '↵', win: 'Enter' },
  escape: { mac: 'Esc', win: 'Esc' },
  esc: { mac: 'Esc', win: 'Esc' },
  space: { mac: 'Space', win: 'Space' },
  arrowup: { mac: '↑', win: '↑' },
  arrowdown: { mac: '↓', win: '↓' },
  arrowleft: { mac: '←', win: '←' },
  arrowright: { mac: '→', win: '→' },
  backspace: { mac: '⌫', win: 'Backspace' },
  delete: { mac: '⌦', win: 'Del' },
  tab: { mac: '⇥', win: 'Tab' }
})

/**
 * 把组合键拆成逐个键帽的展示文本（每个键单独一枚键帽，比「⌘K」挤在一起更易读）。
 * macOS：Ctrl+K → ['⌘', 'K']；Windows：Ctrl+K → ['Ctrl', 'K']。
 * @param {string} combo - 内部统一写法，如 'Ctrl+Shift+O'、'Enter'、'Escape'
 * @param {boolean} [mac] - 是否按 macOS 展示，默认自动检测
 * @returns {string[]}
 */
export function shortcutKeys(combo, mac = isMacOS()) {
  if (typeof combo !== 'string' || !combo.trim()) return []
  return combo.split('+').map((token) => token.trim()).filter(Boolean).map((token) => {
    const key = token.toLowerCase()
    if (Object.hasOwn(KEY_NAMES, key)) return KEY_NAMES[key][mac ? 'mac' : 'win']
    if (mac && Object.hasOwn(MAC_SHORTCUT_SYMBOLS, key)) return MAC_SHORTCUT_SYMBOLS[key]
    return token.length === 1 ? token.toUpperCase() : token
  })
}

/** 单字符的系统符号键（⌘ ⌥ ⇧ ⌃ ↵ 等），渲染时字号略大以保证清晰 */
export function isSymbolKey(label) {
  return typeof label === 'string' && /^[⌘⌥⇧⌃↵⌫⌦⇥↑↓←→]$/.test(label)
}
