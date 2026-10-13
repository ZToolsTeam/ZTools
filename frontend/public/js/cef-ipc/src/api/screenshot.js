import { ensureRuntimeCapability } from './runtime-capability.js'

/**
 * Screenshot API - 高层交互式截图能力
 * 封装 ScreenCapturePlugin.dll 提供区域、全屏、窗口截图能力
 */
class ScreenshotAPI {
  constructor(dllplugin, sys) {
    this.dllplugin = dllplugin
    this.sys = sys
  }

  /**
   * 获取公共截图插件名称
   * @private
   */
  _getPluginName() {
    return 'ScreenCapturePlugin'
  }

  /**
   * 标准化插件返回结果
   * @private
   */
  _normalizeResult(result, defaultMessage = '截图失败') {
    if (!result || typeof result !== 'object') {
      throw new Error(defaultMessage)
    }

    if (result.success === false) {
      return {
        success: false,
        cancelled: result.cancelled === true,
        error: result.error || defaultMessage,
        message: result.message || result.error || defaultMessage
      }
    }

    return {
      success: true,
      cancelled: false,
      outputPath: result.outputPath || '',
      savedPath: typeof result.savedPath === 'string' ? result.savedPath : '',
      clipboard: result.clipboard === true,
      pinned: result.pinned === true,
      width: result.width || 0,
      height: result.height || 0,
      rect: result.rect || null,
      screenCount: result.screenCount || 0,
      message: result.message || '操作成功'
    }
  }

  _awaitCapture(promise, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
      if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return }
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    })
  }

  async _waitCaptureRegionTask(pluginName, taskId, pollInterval, signal) {
    try {
      while (true) {
        signal.throwIfAborted()
        const status = await this._awaitCapture(this.dllplugin.queryTask(pluginName, taskId), signal)
        signal.throwIfAborted()
        if (!status || typeof status !== 'object' || typeof status.completed !== 'boolean') throw new Error('截图任务状态无效')
        if (status.completed) {
          if (status.status === 'cancelled') return { success: false, cancelled: true, error: status.error || '截图已取消' }
          if (status.status === 'error') throw new Error(status.error || '截图失败')
          return status.data
        }
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, pollInterval)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
      }
    } catch (error) {
      if (signal.aborted) void this.dllplugin.cancelTask(pluginName, taskId).catch(() => {})
      throw error
    }
  }

  /**
   * 交互式截图，默认等同于区域截图
   * @param {Object} [options]
   * @returns {Promise<Object>}
   */
  async capture(options = {}) {
    return await this.captureRegion(options)
  }

  /**
   * 区域截图
   * @param {Object} [options]
   * @param {string} [options.outputDir]
   * @param {string} [options.outputFormat='png']
   * @param {boolean} [options.openFolder=false]
   * @param {boolean} [options.enableToolbar=false] 是否开启编辑工具栏
   * @param {boolean} [options.enablePinToScreen=false] 是否允许"贴到屏幕"
   * @param {boolean} [options.autoFinishOnSelect=false] 区域框选完成后是否直接返回
   * @param {AbortSignal} [options.signal] 取消轮询并请求取消原生任务
   * @param {number} [options.timeout=300000] 有界等待时间（ms，最多600000）
   * @param {number} [options.pollInterval=200] 任务状态轮询间隔（ms）
   * @returns {Promise<Object>}
   */
  async captureRegion(options = {}) {
    const pollInterval = options.pollInterval ?? 200, timeout = options.timeout ?? 300000
    if (!Number.isInteger(pollInterval) || pollInterval < 10 || pollInterval > 5000 || !Number.isInteger(timeout) || timeout < 1 || timeout > 600000 ||
        (options.signal !== undefined && (!options.signal || typeof options.signal.addEventListener !== 'function' || typeof options.signal.aborted !== 'boolean'))) throw new Error('截图取消/超时参数无效')
    await ensureRuntimeCapability(this.sys, 'screen.capture', options)
    const controller = new AbortController()
    const cancelError = Object.assign(new Error('截图已取消'), { name: 'AbortError', code: 'CALLER_DESTROYED' })
    const abort = () => controller.abort(cancelError)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('截图等待超时'), { code: 'REQUEST_TIMEOUT' })), timeout)
    const pluginName = this._getPluginName()
    let taskId
    try {
      controller.signal.throwIfAborted()
      // Cancel waiting immediately; an ID arriving later still receives cancellation.
      const creation = this.dllplugin.callAsync(pluginName, 'CaptureRegion', {
        outputDir: options.outputDir || '', outputFormat: options.outputFormat || 'png',
        openFolder: options.openFolder === true, enableToolbar: options.enableToolbar === true,
        enablePinToScreen: options.enablePinToScreen === true, autoFinishOnSelect: options.autoFinishOnSelect === true
      })
      void creation.then(id => { if (controller.signal.aborted) void this.dllplugin.cancelTask(pluginName, id).catch(() => {}) }, () => {})
      taskId = await this._awaitCapture(creation, controller.signal)
      const result = await this._waitCaptureRegionTask(pluginName, taskId, pollInterval, controller.signal)
      return this._normalizeResult(result, '区域截图失败')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }

  /**
   * 全屏截图
   * @param {Object} [options]
   * @param {string} [options.outputDir]
   * @param {string} [options.outputFormat='png']
   * @param {number[]} [options.screens]
   * @param {boolean} [options.openFolder=false]
   * @returns {Promise<Object>}
   */
  async captureScreen(options = {}) {
    await ensureRuntimeCapability(this.sys, 'screen.capture')
    const pluginName = this._getPluginName()
    const result = await this.dllplugin.call(pluginName, 'CaptureScreen', {
      outputDir: options.outputDir || '',
      outputFormat: options.outputFormat || 'png',
      screens: Array.isArray(options.screens) ? options.screens : undefined,
      openFolder: options.openFolder === true
    })
    return this._normalizeResult(result, '全屏截图失败')
  }

  /**
   * 窗口截图
   * @param {Object} options
   * @param {string} options.windowTitle
   * @param {string} [options.outputDir]
   * @param {string} [options.outputFormat='png']
   * @param {boolean} [options.openFolder=false]
   * @returns {Promise<Object>}
   */
  async captureWindow(options = {}) {
    if (!options.windowTitle) {
      throw new Error('windowTitle 参数必填')
    }

    await ensureRuntimeCapability(this.sys, 'screen.capture')

    const pluginName = this._getPluginName()
    const result = await this.dllplugin.call(pluginName, 'CaptureWindow', {
      windowTitle: options.windowTitle,
      outputDir: options.outputDir || '',
      outputFormat: options.outputFormat || 'png',
      openFolder: options.openFolder === true
    })
    return this._normalizeResult(result, '窗口截图失败')
  }

  /**
   * 获取窗口列表
   * @returns {Promise<Array>}
   */
  async getWindowList() {
    const pluginName = this._getPluginName()
    const result = await this.dllplugin.call(pluginName, 'GetWindowList', {})
    if (result?.success === false) {
      throw new Error(result.error || result.message || '获取窗口列表失败')
    }
    return Array.isArray(result?.windows) ? result.windows : []
  }

  /**
   * 获取屏幕列表
   * @returns {Promise<Array>}
   */
  async getScreenList() {
    const pluginName = this._getPluginName()
    const result = await this.dllplugin.call(pluginName, 'GetScreenList', {})
    if (result?.success === false) {
      throw new Error(result.error || result.message || '获取屏幕列表失败')
    }
    return Array.isArray(result?.screens) ? result.screens : []
  }

  /**
   * 检查公共截图插件是否可用
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      return await this.dllplugin.exists(this._getPluginName())
    } catch (error) {
      console.error('[screenshot] 检查插件可用性失败:', error)
      return false
    }
  }
}

export default ScreenshotAPI
