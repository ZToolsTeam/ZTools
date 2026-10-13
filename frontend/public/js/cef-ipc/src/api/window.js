/**
 * Window API - 窗口操作
 * 封装窗口相关的业务逻辑
 */
class WindowAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 打开新窗口
   * @param {string} url - URL地址
   * @returns {Promise<any>}
   */
  async open(url) {
    return await this.transport.call('window_open', { url })
  }

  /**
   * 关闭窗口
   * @returns {Promise<any>}
   */
  async close() {
    return await this.transport.call('window_close', {})
  }

  /**
   * 最小化窗口
   * @returns {Promise<any>}
   */
  async minimize() {
    return await this.transport.call('window_minimize', {})
  }

  /**
   * 最大化窗口
   * @returns {Promise<any>}
   */
  async maximize() {
    return await this.transport.call('window_maximize', {})
  }

  /**
   * 切换全屏
   * @returns {Promise<any>}
   */
  async toggleFullscreen() {
    return await this.transport.call('window_fullscreen_toggle', {})
  }

  /**
   * 拖动窗口
   * @returns {Promise<any>}
   */
  async drag() {
    return await this.transport.call('window_drag', {})
  }

  /**
   * 隐藏窗口
   * @returns {Promise<any>}
   */
  async hide() {
    return await this.transport.call('window_hide', {})
  }

  /**
   * 显示窗口
   * @returns {Promise<any>}
   */
  async show() {
    return await this.transport.call('window_show', {})
  }

  /**
   * 隐藏插件窗口（仅在插件窗口上下文中生效）
   * @returns {Promise<any>}
   */
  async hidePluginWindow() {
    return await this.transport.call('pluginwin_hide', {})
  }

  /**
   * 显示插件窗口（仅在插件窗口上下文中生效）
   * @returns {Promise<any>}
   */
  async showPluginWindow() {
    return await this.transport.call('pluginwin_show', {})
  }

  /**
   * 最小化插件窗口（仅在插件窗口上下文中生效）
   * @returns {Promise<any>}
   */
  async minimizePluginWindow() {
    return await this.transport.call('pluginwin_minimize', {})
  }

  /**
   * 恢复插件窗口（从最小化恢复，仅在插件窗口上下文中生效）
   * @returns {Promise<any>}
   */
  async restorePluginWindow() {
    return await this.transport.call('pluginwin_restore', {})
  }

  /**
   * 设置窗口高度
   * @param {number} height - 窗口高度（像素）
   * @returns {Promise<any>}
   */
  async setHeight(height) {
    return await this.transport.call('window_set_height', { height })
  }

  /**
   * 退出插件模式，隐藏窗口
   * @returns {Promise<any>}
   */
  async outPlugin() {
    return await this.transport.call('window_out_plugin', {})
  }

  /**
   * 跳转到指定URL
   * @param {string} url - 目标URL
   * @returns {Promise<any>}
   */
  async redirect(url) {
    return await this.transport.call('window_redirect', { url })
  }

  /**
   * 显示打开文件对话框
   * @param {Object} options - 对话框选项
   * @param {string} options.title - 对话框标题
   * @param {string} options.defaultPath - 默认路径
   * @param {string} options.filters - 文件过滤器，如 "文本文件 (*.txt)|*.txt"
   * @param {Array<string>} options.properties - 属性数组，如 ['multiSelections', 'openDirectory']
   * @returns {Promise<{filePath?: string, fileUrl?: string, filePaths?: Array<{path: string, fileUrl?: string}>, canceled: boolean}>}
   * @note 此接口不设超时限制，会一直等待用户选择或取消
   */
  async showOpenDialog(options = {}) {
    // 文件对话框不设超时，等待用户操作完成（设置为 Infinity 表示无限等待）
    return await this.transport.call('window_show_open_dialog', options, {
      timeout: Infinity
    })
  }

  /**
   * 显示保存文件对话框
   * @param {Object} options - 对话框选项
   * @param {string} options.title - 对话框标题
   * @param {string} options.defaultPath - 初始目录路径
   * @param {string} options.defaultName - 默认文件名
   * @param {string} options.filters - 文件过滤器，如 "文本文件 (*.txt)|*.txt"
   * @returns {Promise<{filePath?: string, fileUrl?: string, canceled: boolean}>}
   * @note 此接口不设超时限制，会一直等待用户选择或取消
   */
  async showSaveDialog(options = {}) {
    // 文件对话框不设超时，等待用户操作完成（设置为 Infinity 表示无限等待）
    return await this.transport.call('window_show_save_dialog', options, {
      timeout: Infinity
    })
  }

  /**
   * 显示选择文件夹对话框
   * @param {Object} options - 对话框选项
   * @param {string} options.title - 对话框标题
   * @param {string} options.defaultPath - 默认路径
   * @returns {Promise<{folderPath?: string, canceled: boolean}>}
   * @note 此接口不设超时限制，会一直等待用户选择或取消
   */
  async showSelectFolderDialog(options = {}) {
    // 文件对话框不设超时，等待用户操作完成（设置为 Infinity 表示无限等待）
    return await this.transport.call(
      'window_show_select_folder_dialog',
      options,
      { timeout: Infinity }
    )
  }

  /**
   * 设置窗口大小
   * @param {number} width - 窗口宽度（像素）
   * @param {number} height - 窗口高度（像素）
   * @param {boolean} animate - 是否使用动画效果，默认 true
   * @returns {Promise<any>}
   */
  async setSize(width, height, animate = true) {
    return await this.transport.call('window_set_size', {
      width,
      height,
      animate
    })
  }

  /**
   * 获取窗口位置和大小
   * @returns {Promise<{x: number, y: number, width: number, height: number}>}
   */
  async getBounds() {
    const r = await this.transport.call('window_get_bounds', {})
    if (r && r.success) {
      return {
        x: r.x || 0,
        y: r.y || 0,
        width: r.width || 0,
        height: r.height || 0
      }
    }
    throw new Error(r?.error || 'Get bounds failed')
  }

  /**
   * 设置窗口透明度
   * @param {number} opacity - 透明度 (0.0 - 1.0)
   * @returns {Promise<any>}
   */
  async setOpacity(opacity) {
    return await this.transport.call('window_set_opacity', { opacity })
  }

  /**
   * 设置窗口置顶
   * @param {boolean} alwaysOnTop - 是否置顶
   * @returns {Promise<any>}
   */
  async setAlwaysOnTop(alwaysOnTop) {
    return await this.transport.call('window_set_always_on_top', {
      alwaysOnTop
    })
  }

  /**
   * 在鼠标附近显示宿主原生 Tooltip。
   * @param {string} text - 提示文本
   * @returns {Promise<any>}
   */
  async showTooltip(text) {
    return await this.transport.call('window_show_tooltip', { text })
  }

  /**
   * 隐藏宿主原生 Tooltip。
   * @returns {Promise<any>}
   */
  async hideTooltip() {
    return await this.transport.call('window_hide_tooltip', {})
  }

  /**
   * 显示桌面置顶悬浮录屏控制条。
   * @param {Object} [options]
   * @param {number} [options.duration] - 初始已录制秒数
   * @param {string} [options.taskId] - 录制任务ID
   * @returns {Promise<any>}
   */
  async showRecordBar(options = {}) {
    return await this.transport.call('window_show_record_bar', options)
  }

  /**
   * 更新录屏控制条显示状态或时长。
   * @param {Object} [options]
   * @param {number} [options.duration] - 当前录制秒数
   * @param {string} [options.status] - 录制状态
   * @returns {Promise<any>}
   */
  async updateRecordBar(options = {}) {
    return await this.transport.call('window_update_record_bar', options)
  }

  /**
   * 隐藏并销毁录屏控制条。
   * @returns {Promise<any>}
   */
  async hideRecordBar() {
    return await this.transport.call('window_hide_record_bar', {})
  }

  /**
   * 切换开发者工具
   * @returns {Promise<any>}
   */
  async toggleDevTools() {
    return await this.transport.call('window_toggle_devtools', {})
  }

  /**
   * 发送关闭确认结果
   * @param {Object} result - 确认结果 {confirmed: boolean, doNotAskAgain: boolean, action: 'exit'|'minimize'|'cancel'}
   * @returns {Promise<any>}
   */
  async sendCloseConfirmResult(result) {
    return await this.transport.call('ui_close_confirm_result', result)
  }
}

export default WindowAPI
