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
  'hardware-info'
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
