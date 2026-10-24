/**
 * Settings API - 设置操作
 * 封装设置相关的业务逻辑
 */
class SettingsAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 获取设置值
   * @param {string} key - 设置键名
   * @returns {Promise<any>} 设置值,不存在返回undefined
   */
  async get(key) {
    const r = await this.transport.call('settings_get', { key })
    if (r && r.success === true && r.value !== undefined) {
      return r.value
    }
    return undefined
  }

  /**
   * 设置值
   * @param {string} key - 设置键名
   * @param {any} value - 设置值
   * @returns {Promise<boolean>}
   */
  async set(key, value) {
    const r = await this.transport.call('settings_set', { key, value })
    return r && r.success === true
  }
}

export default SettingsAPI
