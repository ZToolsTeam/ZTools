/**
 * Update API - 软件更新
 * 提供应用和插件更新功能
 */
class UpdateAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 检查更新
   * @param {string} source - 检查来源：startup | manual
   * @returns {Promise<object>}
   */
  async check(source = 'manual') {
    const normalizedSource = source === 'startup' ? 'startup' : 'manual'
    const r = await this.transport.call('update_check', { source: normalizedSource })
    // 严格协议：只接受扁平结构 { success, app, web }
    if (!r || typeof r !== 'object' || !('success' in r)) {
      throw new Error('Invalid update_check response: missing success')
    }
    return {
      success: r.success === true,
      app: r.app ?? null,
      web: r.web ?? null
    }
  }

  /**
   * 下载并安装应用更新。
   * 下载完成后再把已校验的包交给外部安装器，避免把“下载成功”误报为“已安装”。
   * @param {object} info - 更新信息 { version, downloadUrl, checksum }
   * @returns {Promise<object>}
   */
  async downloadAndInstall(info) {
    const packageInfo = {
      type: 'app',
      version: info.version,
      downloadUrl: info.downloadUrl,
      checksum: info.checksum,
      fileSize: info.fileSize || 0
    }
    const downloaded = await this.transport.call('update_download_start', packageInfo)
    if (!downloaded || downloaded.success !== true) return downloaded || { success: false }
    const installed = await this.transport.call('update_install_start', packageInfo, { timeout: Infinity })
    return installed || { success: false }
  }

  /**
   * 取消尚未交给安装器的更新下载。
   * @returns {Promise<object>}
   */
  async cancel() {
    return (await this.transport.call('update_cancel', {})) || { success: false }
  }

  /**
   * 下载应用更新
   * @param {object} info - 更新信息
   * @returns {Promise<boolean>}
   */
  async downloadApp(info) {
    const r = await this.transport.call('update_download_start', {
      type: 'app',
      ...info
    })
    return r && r.success === true
  }

  /**
   * 下载插件更新
   * @param {string} id - 插件ID
   * @param {object} info - 更新信息（来自 batchCheckPlugins / checkPluginUpdate）
   * @returns {Promise<boolean>}
   */
  async downloadPlugin(id, info) {
    // 后端返回 download_url，Delphi 端读取 url，需要做字段映射
    const url = info.download_url || info.downloadUrl || info.url || ''
    const r = await this.transport.call('plugin_update', {
      pluginId: id,
      url,
      version: info.version || '',
      checksum: info.checksum || '',
      fileSize: info.fileSize || info.file_size || 0
    })
    return r && r.success === true
  }
}

export default UpdateAPI
