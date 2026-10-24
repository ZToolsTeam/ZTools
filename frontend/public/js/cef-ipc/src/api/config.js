// ============================================================
// Config API - 配置操作
// 职责: 封装配置相关的业务逻辑
// ============================================================

class ConfigAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 获取配置值
   * @param {string} path - 配置路径，如 'ui.theme' 或 'system.autostart'
   * @param {string} defaultValue - 默认值
   * @param {string} file - 文件名，默认 'user_settings.json'
   * @returns {Promise<string>} 配置值
   */
  async get(path, defaultValue = '', file = 'user_settings.json') {
    // console.log(`[ConfigAPI] get: path=${path}, default=${defaultValue}`)
    const r = await this.transport.call('config_get', {
      file,
      path,
      default: defaultValue
    })
    // console.log(`[ConfigAPI] get response:`, r)
    const raw = r?.value ?? defaultValue
    // 尝试解析 JSON 字符串（获取整个 group 时后端返回的是 JSON 字符串）
    if (typeof raw === 'string' && raw.length > 0) {
      const trimmed = raw.trim()
      if (trimmed[0] === '{' || trimmed[0] === '[') {
        try {
          return JSON.parse(trimmed)
        } catch (e) {
          // 解析失败，返回原始字符串
        }
      }
    }
    return raw
  }

  /**
   * 设置配置值
   * @param {string} path - 配置路径
   * @param {any} value - 配置值
   * @param {boolean} syncEnabled - 是否启用云同步，默认 false
   * @param {string} file - 文件名，默认 'user_settings.json'
   * @returns {Promise<boolean>}
   */
  async set(path, value, syncEnabled = false, file = 'user_settings.json') {
    // 对象/数组类型使用 JSON.stringify 序列化，避免 String({}) 变成 "[object Object]"
    const serialized =
      typeof value === 'object' && value !== null
        ? JSON.stringify(value)
        : String(value)
    const r = await this.transport.call('config_set', {
      file,
      path,
      value: serialized,
      sync_enabled: syncEnabled
    })
    return r?.success === true
  }

  /**
   * 批量获取配置（便捷方法）
   * @param {Object} paths - 路径和默认值映射，如 { 'ui.theme': 'light', 'ui.fontSize': '14' }
   * @param {string} file - 文件名
   * @returns {Promise<Object>} 配置值对象
   */
  async getMultiple(paths, file = 'user_settings.json') {
    const result = {}
    for (const [path, defaultValue] of Object.entries(paths)) {
      result[path] = await this.get(path, defaultValue, file)
    }
    return result
  }

  /**
   * 批量设置配置（便捷方法）
   * @param {Object} values - 路径和值映射
   * @param {boolean} syncEnabled - 是否启用云同步
   * @param {string} file - 文件名
   * @returns {Promise<boolean>}
   */
  async setMultiple(values, syncEnabled = false, file = 'user_settings.json') {
    for (const [path, value] of Object.entries(values)) {
      await this.set(path, value, syncEnabled, file)
    }
    return true
  }
}

export default ConfigAPI
