/**
 * Platform detection and plugin targeting utilities for Frontend.
 */
import { getBundledPluginEntry } from './bundledPlugins.js'

export function isMacOS() {
  if (typeof globalThis !== 'undefined' && globalThis.__ZTOOLS_PLATFORM_OVERRIDE__) {
    const ov = String(globalThis.__ZTOOLS_PLATFORM_OVERRIDE__).toLowerCase()
    return ov === 'darwin' || ov === 'macos' || ov === 'mac'
  }
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
  if (typeof globalThis !== 'undefined' && globalThis.__ZTOOLS_PLATFORM_OVERRIDE__) {
    const ov = String(globalThis.__ZTOOLS_PLATFORM_OVERRIDE__).toLowerCase()
    return ov === 'win32' || ov === 'windows' || ov === 'win'
  }
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
  // 实现完全依赖 Windows（运行对话框 / Windows 快捷方式 / winget）
  'windows-run',
  'windows-shortcuts',
  'winget'
])

/**
 * macOS-exclusive plugins that must be hidden on Windows.
 */
export const MACOS_EXCLUSIVE_PLUGIN_IDS = new Set([
  'homebrew',
  'apple-shortcuts'
])

/**
 * 在所有系统上都暂不可用、不展示的内置页面或依赖外部 Store 配置的扩展。
 */
export const UNAVAILABLE_PLUGIN_IDS = new Set([
  // 不是插件：客户端自身的设置、更新、推广页面
  'raycast-settings',
  'raycast-core',
  'raycast-wrapped',
  'trial-nudges',
  // 独立 Store 扩展（通过插件市场按需安装配置）
  'github',
  'obsidian',
  'speedtest',
  'currency-exchange'
])

/**
 * Check if a plugin is supported on the current platform.
 * @param {string|object} plugin - Plugin ID string or plugin object
 * @returns {boolean}
 */
const PLATFORM_ALIASES = Object.freeze({
  windows: 'windows', win: 'windows', win32: 'windows',
  macos: 'macos', mac: 'macos', darwin: 'macos', osx: 'macos'
})
const PLATFORM_ORDER = ['windows', 'macos']

/**
 * 插件声明支持的平台（'windows' / 'macos' 的子集）。
 * 以 plugin.json 的 targets 为准（只看 electron 运行时目标，与主进程安装校验一致），兼容旧的 platforms 字符串数组。
 * 未声明时返回 null；声明了但没有可用的 electron 目标时返回 []。
 * @param {object} plugin
 * @returns {string[] | null}
 */
export function getPluginPlatforms(plugin) {
  if (!plugin || typeof plugin !== 'object') return null
  const found = new Set()
  let declared = false
  if (Array.isArray(plugin.targets) && plugin.targets.length > 0) {
    declared = true
    for (const target of plugin.targets) {
      if (!target || typeof target !== 'object' || target.runtime !== 'electron') continue
      const platform = PLATFORM_ALIASES[String(target.platform || '').trim().toLowerCase()]
      if (platform) found.add(platform)
    }
  }
  if (Array.isArray(plugin.platforms) && plugin.platforms.length > 0) {
    declared = true
    for (const item of plugin.platforms) {
      const platform = PLATFORM_ALIASES[String(item || '').trim().toLowerCase()]
      if (platform) found.add(platform)
    }
  }
  if (!declared) return null
  return PLATFORM_ORDER.filter((p) => found.has(p))
}

/**
 * 平台标签文字：跨平台 / 仅 Windows / 仅 macOS；未声明时返回空字符串（不显示标签）
 * @param {object} plugin
 */
export function getPluginPlatformLabel(plugin) {
  const platforms = getPluginPlatforms(plugin)
  if (!platforms || platforms.length === 0) return ''
  if (platforms.length === PLATFORM_ORDER.length) return '跨平台'
  return platforms[0] === 'windows' ? '仅 Windows' : '仅 macOS'
}

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

  // On Windows, macOS-exclusive plugins (Homebrew, Apple Shortcuts) are hidden
  if (isWindows() && MACOS_EXCLUSIVE_PLUGIN_IDS.has(normalizedId)) {
    return false
  }

  // 插件在 plugin.json（targets）里声明了支持的平台时，按声明判断当前系统能否运行；
  // 只有 ID、没带平台声明时（旧快捷方式、深链接、别名跳转），内置插件按随客户端打包的 plugin.json 判断
  const ownPlatforms = typeof plugin === 'object' ? getPluginPlatforms(plugin) : null
  const bundledEntry = ownPlatforms ? null : getBundledPluginEntry(normalizedId)
  const platforms = ownPlatforms || (bundledEntry ? getPluginPlatforms(bundledEntry) : null)
  if (platforms) {
    // 声明了目标、但没有任何可用的 electron 目标：哪个客户端都跑不了
    if (platforms.length === 0) return false
    if (isMacOS()) return platforms.includes('macos')
    if (isWindows()) return platforms.includes('windows')
    // 识别不出当前系统（如网页预览、测试环境）时不按平台过滤，交给主进程安装校验把关
    return true
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
