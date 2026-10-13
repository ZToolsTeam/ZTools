/**
 * Analytics API - 埋点上报
 * 封装埋点上报相关的业务逻辑，通过IPC调用Delphi端异步上报
 */
class AnalyticsAPI {
  constructor(transport) {
    this.transport = transport
    this._webVersion = ''  // web前端版本号
  }

  /**
   * 设置web前端版本号
   * @param {string} version - 版本号
   */
  setWebVersion(version) {
    this._webVersion = version || ''
  }

  /**
   * 上报埋点事件
   * @param {string} event - 事件名称（必填），如 'plugin_open', 'button_click'
   * @param {string} pluginId - 插件ID（可选），标识事件来源插件
   * @param {object} data - 扩展数据（可选），任意JSON对象
   * @returns {Promise<boolean>} 是否上报成功
   *
   * @example
   * // 简单事件（无插件上下文）
   * await ztools.analytics.report('app_launch')
   *
   * // 指定插件ID
   * await ztools.analytics.report('plugin_open', 'ocr')
   *
   * // 指定插件ID + 扩展数据
   * await ztools.analytics.report('button_click', 'ocr', { button: 'start' })
   *
   * // 无插件ID但有扩展数据
   * await ztools.analytics.report('settings_change', '', { theme: 'dark' })
   */
  async report(event, pluginId = '', data = null) {
    if (!event || typeof event !== 'string') {
      console.warn('[analytics] event 参数必须是非空字符串')
      return false
    }

    // 兼容旧调用方式：report(event, data) - 第二个参数是对象时当作data处理
    if (pluginId !== null && typeof pluginId === 'object') {
      data = pluginId
      pluginId = ''
    }

    try {
      const params = {
        event,
        plugin_id: pluginId || '',
        web_version: this._webVersion
      }
      if (data !== null && data !== undefined) {
        params.data = data
      }

      const r = await this.transport.call('analytics_report', params)
      return r && r.success === true
    } catch (e) {
      // 埋点上报失败不应影响业务，静默处理
      console.warn('[analytics] 上报失败:', e.message || e)
      return false
    }
  }
}
