/**
 * 超级面板配置 API
 */

/**
 * 获取超级面板配置
 * @returns {Promise<Object>} 配置对象
 */
export async function getSuperPanelConfig() {
  if (window.ztools?.config) {
    try {
      const config = await window.ztools.config.get('super_panel')
      return config || getDefaultConfig()
    } catch (error) {
      console.error('Failed to get super panel config:', error)
      return getDefaultConfig()
    }
  }
  return getDefaultConfig()
}

/**
 * 保存超级面板配置
 * @param {Object} config - 配置对象
 * @returns {Promise<boolean>} 是否成功
 */
export async function setSuperPanelConfig(config) {
  if (window.ztools?.config) {
    try {
      await window.ztools.config.set('super_panel', config)
      return true
    } catch (error) {
      console.error('Failed to set super panel config:', error)
      throw error
    }
  }
  throw new Error('ZTools API not available')
}

/**
 * 重新加载热键
 * @returns {Promise<boolean>} 是否成功
 */
export async function reloadHotkeys() {
  if (window.ztools?.sys?.reloadHotkeys) {
    try {
      await window.ztools.sys.reloadHotkeys()
      return true
    } catch (error) {
      console.error('Failed to reload hotkeys:', error)
      throw error
    }
  }
  throw new Error('ZTools API not available')
}

/**
 * 获取默认配置
 * @returns {Object} 默认配置对象
 */
function getDefaultConfig() {
  return {
    enabled: true,
    keyboardHotkey: {
      enabled: true,
      // Alt+Space 留给全局唤醒（悬浮条），两者默认值不能相同
      modifiers: ['Alt', 'Shift'],
      key: 'Space'
    },
    mouseHotkey: {
      enabled: true,
      button: 'middle_long',
      longPressMs: 300
    },
    panelPosition: 'center',
    panelSize: 'small',
    defaultTab: 'history',
    maxRecentCount: 10
  }
}

/**
 * 验证配置对象
 * @param {Object} config - 配置对象
 * @returns {boolean} 是否有效
 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    return false
  }

  // 验证键盘热键
  if (config.keyboardHotkey) {
    if (!Array.isArray(config.keyboardHotkey.modifiers)) {
      return false
    }
    if (typeof config.keyboardHotkey.key !== 'string') {
      return false
    }
  }

  // 验证鼠标热键
  if (config.mouseHotkey) {
    const validButtons = [
      'middle_press',
      'middle_long',
      'right_press',
      'right_long',
      'forward_press',
      'forward_long',
      'backward_press',
      'backward_long'
    ]
    if (!validButtons.includes(config.mouseHotkey.button)) {
      return false
    }
    if (
      typeof config.mouseHotkey.longPressMs !== 'number' ||
      config.mouseHotkey.longPressMs < 200 ||
      config.mouseHotkey.longPressMs > 500
    ) {
      return false
    }
  }

  // 验证面板位置
  if (
    config.panelPosition &&
    !['center', 'cursor'].includes(config.panelPosition)
  ) {
    return false
  }

  // 验证面板大小
  if (
    config.panelSize &&
    !['small', 'medium', 'large'].includes(config.panelSize)
  ) {
    return false
  }

  // 验证默认选中 tab
  if (
    config.defaultTab &&
    !['history', 'pinned', 'local', 'system_tools', 'all'].includes(config.defaultTab)
  ) {
    return false
  }

  // 验证最近使用数量
  if (
    config.maxRecentCount &&
    (typeof config.maxRecentCount !== 'number' ||
      config.maxRecentCount < 5 ||
      config.maxRecentCount > 20)
  ) {
    return false
  }

  return true
}
