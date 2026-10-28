/**
 * Plugin API - 插件操作
 * 封装插件相关的业务逻辑
 */
class PluginAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 获取插件列表
   * @returns {Promise<Array>}
   */
  async getList() {
    return await this.transport.call('plugin_list_get', {})
  }

  /**
   * 打开插件
   * @param {string} pluginId - 插件ID
   * @param {Object} [payload] - 传递给目标插件的启动参数，序列化后不超过 64KB
   * @returns {Promise<any>}
   */
  async open(pluginId, payload) {
    const params = { pluginId }
    if (payload !== undefined) {
      if (
        payload === null ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      ) {
        throw new TypeError('plugin.open payload must be an object')
      }
      let serialized
      try {
        serialized = JSON.stringify(payload)
      } catch (error) {
        throw new TypeError(
          `plugin.open payload is not serializable: ${error.message}`
        )
      }
      if (serialized.length > 64 * 1024) {
        throw new RangeError('plugin.open payload exceeds the 64KB limit')
      }
      params.payload = payload
    }
    return await this.transport.call('plugin_open', params)
  }

  /**
   * 卸载插件
   * @param {string} pluginId - 插件ID
   * @returns {Promise<any>}
   */
  async uninstall(pluginId) {
    // 卸载大型插件时需要递归删除目录，可能耗时较长，使用 20 秒超时
    return await this.transport.call(
      'plugin_uninstall',
      { pluginId },
      { timeout: 20000 }
    )
  }

  /**
   * 获取插件历史数据快照。
   * @param {string} pluginId - 插件ID
   * @returns {Promise<any>}
   */
  async listPreservedData(pluginId) {
    return await this.transport.call('plugin_data_list', { pluginId })
  }

  /**
   * 将指定历史快照中的明确资产恢复到受管恢复目录，不覆盖插件代码或现有数据。
   * @param {string} pluginId - 插件ID
   * @param {string} preservationId - 历史快照ID
   * @param {string[]} assets - 快照内的相对资产路径
   * @returns {Promise<any>}
   */
  async restorePreservedData(pluginId, preservationId, assets) {
    if (!Array.isArray(assets) || assets.length === 0) {
      throw new TypeError('plugin.restorePreservedData assets must be a non-empty array')
    }
    return await this.transport.call('plugin_data_restore', {
      pluginId,
      preservationId,
      assets
    })
  }

  /**
   * 安装插件
   * @param {string} pluginId - 插件ID
   * @param {string} url - 下载地址
   * @param {Object} info - 完整性元数据
   * @returns {Promise<any>}
   */
  async install(pluginId, url, info = {}) {
    return await this.transport.call('plugin_install', {
      pluginId,
      url,
      version: info.version || '',
      checksum: info.checksum || '',
      fileSize: info.fileSize || info.file_size || 0
    })
  }

  /**
   * 刷新插件列表
   * @returns {Promise<any>}
   */
  async refresh() {
    return await this.getList()
  }

  /**
   * 切换插件启用状态
   * @param {string} pluginId - 插件ID
   * @returns {Promise<any>}
   */
  async toggle(pluginId) {
    return await this.transport.call('plugin_toggle', { pluginId })
  }

  /** 持久化官方下架状态；重复调用保持禁用。 */
  async revoke(pluginId, reason) {
    return await this.transport.call('plugin_revoke', { pluginId, revoked: true, reason })
  }

  /** 查询指定安装任务，避免遗漏完成事件后误报失败。 */
  async getInstallStatus(pluginId, operationId) {
    return await this.transport.call('plugin_install_status', { pluginId, operationId })
  }

  /**
   * 关闭插件窗口
   * @param {string} pluginId - 插件ID
   * @param {string} [instanceId] - 实例ID（可选，为空则关闭该插件所有窗口）
   * @returns {Promise<any>}
   */
  async close(pluginId, instanceId) {
    const params = { pluginId }
    if (instanceId !== undefined && instanceId !== '') {
      if (typeof instanceId !== 'string') {
        throw new TypeError('plugin.close instanceId must be a string')
      }
      params.instanceId = instanceId
    }
    return await this.transport.call('plugin_window_close', params)
  }

  /**
   * 创建桌面快捷方式
   * @param {string} pluginId - 插件ID
   * @returns {Promise<any>}
   */
  async createShortcut(pluginId) {
    return await this.transport.call(
      'plugin_create_shortcut',
      { pluginId },
      { timeout: 60000 }
    )
  }

  async refreshIcon(pluginId, iconUrl) {
    return await this.transport.call('plugin_refresh_icon', { pluginId, iconUrl })
  }
}

export default PluginAPI
