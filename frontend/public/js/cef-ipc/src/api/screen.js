import { ensureRuntimeCapability } from './runtime-capability.js'

/**
 * Screen API - 屏幕操作
 * 提供屏幕操作功能，类似 uTools API
 */
function bytesToBase64(bytes) {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

class ScreenAPI {
  constructor(transport, sys) {
    this.transport = transport
    this.sys = sys
  }

  // ============ 屏幕截图 ============

  /**
   * 屏幕截图
   * @param {object} rect - 截图区域 {x, y, width, height}，不传则截取全屏
   * @param {function} callback - 回调函数，接收 Base64 编码的图片
   * @returns {Promise<string>} Base64 编码的图片
   */
  async captureReference(rect, options = {}) {
    return this._captureReference('screen_capture', rect ? { rect } : {}, options)
  }
  async captureRegionReference(options = {}) {
    return this._captureReference('screen_capture_region', {}, options)
  }
  async _captureReference(method, params, options) {
    const refs = new ReferenceFileSystemAPI(this.transport)
    refs._options(options, ['signal'])
    await ensureRuntimeCapability(this.sys, 'screen.capture', options)
    const result = await refs._call(method, params, { ...options, ...(method === 'screen_capture_region' ? { timeout: 120000 } : {}) })
    if (method === 'screen_capture_region' && result.cancelled !== undefined) {
      if (result.reference) await refs.revoke(refs._returnedReference(result.reference, ['file']))
      if (result.cancelled !== true || Object.keys(result).some(key => !['success', 'cancelled'].includes(key))) throw refs._error('SCREEN_ERROR', '区域截图取消响应无效')
      return undefined
    }
    const reference = refs._returnedReference(result.reference, ['file'])
    try {
      if (result.fileUrl !== 'ztools://file/' + reference.grantId + '/' + encodeURIComponent(reference.displayName) || !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 16 * 1024 * 1024 || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width <= 0 || result.height <= 0 || result.width * result.height > 32 * 1024 * 1024) throw refs._error('SCREEN_ERROR', '截图引用响应无效')
      return Object.freeze({ reference: Object.freeze({ ...reference, operations: Object.freeze([...reference.operations]) }), fileUrl: result.fileUrl, size: result.size, width: result.width, height: result.height })
    } catch (error) { await refs.revoke(reference); throw error }
  }

  async capture(rect, callback, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      const refs = new ReferenceFileSystemAPI(this.transport), result = await this.captureReference(rect, options)
      let imageBase64
      try {
        const bytes = new Uint8Array(await refs.readFileAsBinary(result.reference, { signal: options.signal }))
        imageBase64 = 'data:image/png;base64,' + bytesToBase64(bytes)
      } finally { await refs.revoke(result.reference) }
      if (typeof callback === 'function') callback(imageBase64)
      return imageBase64
    }
    if (Object.keys(options).length) throw Object.assign(new Error('当前截图合约不支持引用取消选项'), { code: 'NOT_SUPPORTED' })
    await ensureRuntimeCapability(this.sys, 'screen.capture')
    const params = rect ? { rect } : {}
    const r = await this.transport.call('screen_capture', params)

    if (r && r.success && r.tempFile) {
      try {
        // 使用文件系统API读取临时文件
        const binaryData = await window.ztools.fs.readFileAsBinary(r.tempFile)

        // 转换为Base64
        const imageBase64 = 'data:image/png;base64,' + bytesToBase64(binaryData)

        // 删除临时文件
        try {
          await window.ztools.fs.deleteFile(r.tempFile)
        } catch (e) {
          console.warn('Failed to delete temp screenshot file:', e)
        }

        if (typeof callback === 'function') {
          callback(imageBase64)
        }
        return imageBase64
      } catch (e) {
        console.error('Failed to read temp screenshot file:', e)
        throw new Error('Failed to read screenshot: ' + e.message)
      }
    }

    throw new Error(r?.error || 'Screen capture failed')
  }

  async _screenCall(method, params) {
    if (window.__ztoolsElectron?.contractVersion === 2) return new ReferenceFileSystemAPI(this.transport)._call(method, params)
    return this.transport.call(method, params)
  }

  // ============ 鼠标位置 ============

  /**
   * 获取鼠标位置
   * @returns {Promise<{x: number, y: number}>} 鼠标坐标
   */
  async getCursorScreenPoint() {
    const r = await this._screenCall('screen_get_cursor_pos', {})
    if (r && r.success) {
      return { x: r.x, y: r.y }
    }
    throw new Error(r?.error || 'Get cursor position failed')
  }

  /**
   * 获取鼠标位置 (别名，兼容部分组件调用)
   * @returns {Promise<{x: number, y: number}>} 鼠标坐标
   */
  async getCursorPos() {
    return await this.getCursorScreenPoint()
  }

  // ============ 显示器信息 ============

  /**
   * 获取主显示器信息
   * @returns {Promise<object>} 显示器信息
   */
  async getPrimaryDisplay() {
    const r = await this._screenCall('screen_get_primary_display', {})
    if (r && r.success && r.display) {
      return r.display
    }
    throw new Error(r?.error || 'Get primary display failed')
  }

  /**
   * 获取所有显示器信息
   * @returns {Promise<Array>} 显示器信息数组
   */
  async getAllDisplays() {
    const r = await this._screenCall('screen_get_all_displays', {})
    if (r && r.success && r.displays) {
      return r.displays
    }
    throw new Error(r?.error || 'Get all displays failed')
  }

  /**
   * 获取距离指定点最近的显示器
   * @param {object} point - 坐标点 {x, y}
   * @returns {Promise<object>} 显示器信息
   */
  async getDisplayNearestPoint(point) {
    const r = await this._screenCall('screen_get_display_nearest', {
      point
    })
    if (r && r.success && r.display) {
      return r.display
    }
    throw new Error(r?.error || 'Get display nearest point failed')
  }

  /**
   * 获取与指定矩形最匹配的显示器
   * @param {object} rect - 矩形区域 {x, y, width, height}
   * @returns {Promise<object>} 显示器信息
   */
  async getDisplayMatching(rect) {
    const r = await this._screenCall('screen_get_display_matching', { rect })
    if (r && r.success && r.display) {
      return r.display
    }
    throw new Error(r?.error || 'Get display matching failed')
  }

  // ============ 便捷方法 ============

  /**
   * 全屏截图
   * @returns {Promise<string>} Base64 编码的图片
   */
  async captureFullScreen(options = {}) {
    return await this.capture(undefined, undefined, options)
  }

  /**
   * 区域截图
   * @param {number} x - X坐标
   * @param {number} y - Y坐标
   * @param {number} width - 宽度
   * @param {number} height - 高度
   * @returns {Promise<string>} Base64 编码的图片
   */
  async captureRegion(x, y, width, height, options = {}) {
    return await this.capture({ x, y, width, height }, undefined, options)
  }
}

export default ScreenAPI
