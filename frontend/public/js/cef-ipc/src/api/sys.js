/**
 * System API - 系统操作
 * 封装系统相关的业务逻辑
 */
class SystemAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 显示系统通知（支持模态/非模态）
   * @param {string} title - 通知标题
   * @param {string} message - 通知内容
   * @param {object} options - 可选配置 { modal: boolean }
   * @returns {Promise<boolean>}
   */
  async notify(title, message, options = {}) {
    const r = await this.transport.call('system_notify', {
      title,
      message,
      modal: options.modal !== undefined ? options.modal : true // 默认模态
    })
    return r && r.success === true
  }

  /**
   * 显示 Toast 通知（轻量、非阻塞、自动消失）
   * @param {string} type - 类型: 'success' | 'error' | 'info' | 'warning' | 'loading'
   * @param {string} message - 通知内容
   * @param {number} duration - 持续时间（秒），默认 3 秒，0 表示不自动关闭
   * @returns {Promise<void>}
   */
  async toast(type, message, duration = 3) {
    // 直接调用前端 Toast，不经过后端
    if (typeof window !== 'undefined' && window.__ztoolsToast) {
      window.__ztoolsToast(type, message, duration)
    } else {
      console.warn('[sys.toast] Toast 系统未初始化，降级为 console 输出')
      console.log(`[${type.toUpperCase()}] ${message}`)
    }
  }

  /**
   * Read only this plugin instance's recent, sanitized Main failures for known SDK request IDs.
   * @param {{requestIds?: string[]}} options
   * @returns {Promise<{schemaVersion: number, requestFailures: Array<object>}>}
   */
  async getDiagnostics(options = {}) {
    const requestIds = options?.requestIds
    if (options === null || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some(key => key !== 'requestIds') ||
        (requestIds !== undefined && (!Array.isArray(requestIds) || requestIds.length > 64 ||
          requestIds.some(value => typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value))))) {
      const error = new Error('诊断请求 ID 无效')
      error.code = 'INVALID_REQUEST'
      throw error
    }
    const ids = requestIds === undefined ? [] : [...new Set(requestIds)]
    const data = await this.transport.call('diagnostics_get', ids.length ? { requestIds: ids } : {})
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.requestFailures) || data.requestFailures.length > ids.length) {
      const error = new Error('宿主诊断响应无效')
      error.code = 'DIAGNOSTICS_INVALID'
      throw error
    }
    const allowedIds = new Set(ids)
    const requestFailures = []
    const seen = new Set()
    for (const failure of data.requestFailures) {
      if (!failure || typeof failure !== 'object' || Array.isArray(failure) ||
          failure.schemaVersion !== 1 || failure.layer !== 'main' ||
          typeof failure.requestId !== 'string' || !allowedIds.has(failure.requestId) || seen.has(failure.requestId) ||
          typeof failure.method !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(failure.method) ||
          typeof failure.failureStage !== 'string' || !/^[a-z-]{1,32}$/.test(failure.failureStage) ||
          typeof failure.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(failure.errorCode) ||
          typeof failure.occurredAt !== 'string' || !Number.isFinite(Date.parse(failure.occurredAt))) {
        const error = new Error('宿主诊断记录无效')
        error.code = 'DIAGNOSTICS_INVALID'
        throw error
      }
      seen.add(failure.requestId)
      requestFailures.push(Object.freeze({
        schemaVersion: 1,
        layer: 'main',
        requestId: failure.requestId,
        method: failure.method,
        failureStage: failure.failureStage,
        errorCode: failure.errorCode,
        occurredAt: new Date(Date.parse(failure.occurredAt)).toISOString()
      }))
    }
    return Object.freeze({ schemaVersion: 1, requestFailures: Object.freeze(requestFailures) })
  }

  /**
   * 显示确认对话框（模态）
   * @param {string} title - 标题
   * @param {string} message - 消息内容
   * @param {object} options - 可选配置 { okText, cancelText }
   * @returns {Promise<boolean>} 用户是否点击确认
   */
  async confirm(title, message, options = {}) {
    // TODO: 后续实现 Delphi 非模态对话框
    // 当前使用浏览器原生 confirm
    if (typeof window !== 'undefined') {
      return window.confirm(`${title}\n\n${message}`)
    }
    return false
  }

  /**
   * 设置暗黑模式
   * @param {boolean} enabled - 是否启用暗黑模式
   * @returns {Promise<boolean>}
   */
  async setDarkMode(enabled) {
    const r = await this.transport.call('system_set_dark_mode', {
      dark: !!enabled
    })
    return r && r.success === true
  }

  /**
   * 获取系统信息
   * @returns {Promise<object>}
   */
  async getInfo() {
    const r = await this.transport.call('get_system_info', {})
    if (r && r.success) {
      return r
    }
    throw new Error(r?.error || 'Get system info failed')
  }

  // ============ 系统扩展功能 (类似 uTools API) ============

  /**
   * 获取本机唯一标识
   * @returns {Promise<string>}
   */
  async getNativeId() {
    const r = await this.transport.call('system_get_native_id', {})
    if (r && r.success && r.nativeId) {
      return r.nativeId
    }
    throw new Error(r?.error || 'Get native ID failed')
  }

  /**
   * 获取应用名称
   * @returns {Promise<string>}
   */
  async getAppName() {
    const r = await this.transport.call('system_get_app_name', {})
    if (r && r.success && r.appName) {
      return r.appName
    }
    return 'ZTools'
  }

  /**
   * 获取应用版本（从应用程序文件版本资源读取）
   * @returns {Promise<string>}
   */
  async getAppVersion() {
    const r = await this.transport.call('system_get_app_version', {})
    if (r && r.success && r.appVersion) {
      return r.appVersion
    }
    return '1.0.0'
  }

  /**
   * 获取系统路径
   * @param {string} name - 路径名称 (app, home, appData, userData, temp, desktop, documents, downloads, music, pictures, videos, cache)
   * @returns {Promise<string>}
   */
  async getPath(name) {
    const r = await this.transport.call('system_get_path', { name })
    if (r && r.success && r.path) {
      return r.path
    }
    return ''
  }

  /**
   * Read the real Windows login-item state when the host supports it.
   * @returns {Promise<{success: boolean, enabled: boolean}>}
   */
  async getAutostart() {
    return await this.transport.call('system_get_autostart', {})
  }

  /**
   * Update the real Windows login-item state.
   * @param {boolean} enabled
   * @returns {Promise<{success: boolean, enabled: boolean}>}
   */
  async setAutostart(enabled) {
    return await this.transport.call('system_set_autostart', { enabled: !!enabled })
  }

  /**
   * 获取文件图标（通过 Windows SHGetFileInfo API）
   * @param {string} filePath - 文件路径
   * @returns {Promise<string>} Base64 编码的图标数据 (data:image/png;base64,...)
   */
  async getFileIcon(filePath) {
    const r = await this.transport.call('system_get_file_icon', { filePath })
    if (r && r.success) {
      return r.icon || ''
    }
    return ''
  }

  /**
   * 读取当前文件夹路径
   * @returns {Promise<string>}
   */
  async readCurrentFolderPath() {
    const r = await this.transport.call('system_read_current_folder', {})
    if (r && r.success && r.path) {
      return r.path
    }
    return ''
  }

  /**
   * 读取当前浏览器 URL（通过 Windows API 获取前台浏览器窗口）
   * 支持 Chrome, Edge, Firefox 等主流浏览器
   * @returns {Promise<{url: string, browser: string}>} 返回 URL 和浏览器名称
   */
  async readCurrentBrowserUrl() {
    const r = await this.transport.call('system_read_current_browser_url', {})
    if (r && r.success) {
      return {
        url: r.url || '',
        browser: r.browser || ''
      }
    }
    return { url: '', browser: '' }
  }

  /**
   * 是否为开发模式
   * @returns {Promise<boolean>}
   */
  async isDev() {
    const r = await this.transport.call('system_is_dev', {})
    if (r && r.success) {
      return r.isDev || false
    }
    return false
  }

  /**
   * 获取平台信息
   * @returns {Promise<object>} {platform, isWindows, isMacOS, isLinux}
   */
  async getPlatform() {
    try {
      const r = await this.transport.call('system_get_platform', {})
      if (r && r.success) {
        return {
          platform: r.platform || 'unknown',
          isWindows: r.isWindows || false,
          isMacOS: r.isMacOS || false,
          isLinux: r.isLinux || false
        }
      }
    } catch {
      // A failed host query must not guess the operating system.
    }
    return {
      platform: 'unknown',
      isWindows: false,
      isMacOS: false,
      isLinux: false
    }
  }

  /**
   * 查询当前运行时中已登记能力的只读状态。
   * 查询不会申请权限；每次实际 IPC 操作仍会独立校验授权与系统权限。
   * @param {string} capability - 稳定能力 ID
   * @returns {Promise<object>} capability-record.schema.json 定义的状态快照
   */
  async getCapability(capability) {
    if (
      typeof this.transport.isElectronEnvironment !== 'function' ||
      !this.transport.isElectronEnvironment()
    ) {
      const error = new Error('运行时能力查询仅支持 Electron 宿主')
      error.code = 'NOT_SUPPORTED'
      throw error
    }
    return this.transport.call('runtime_capability_get', { capability })
  }

  /** Requests screen-capture authorization for this trusted plugin instance. */
  async requestCapability(request, options = {}) {
    if (
      typeof this.transport.isElectronEnvironment !== 'function' ||
      !this.transport.isElectronEnvironment()
    ) {
      const error = new Error('运行时能力申请仅支持 Electron 宿主')
      error.code = 'NOT_SUPPORTED'
      throw error
    }
    const capability = request && typeof request === 'object' ? request.capability : undefined
    const timeout = options.timeout ?? 120000
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) {
      const error = new Error('屏幕权限申请等待时间必须为 1 到 120000 毫秒')
      error.code = 'INVALID_REQUEST'
      throw error
    }
    if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== 'boolean' ||
        typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) {
      const error = new Error('屏幕权限申请 signal 无效')
      error.code = 'INVALID_REQUEST'
      throw error
    }
    return this.transport.call('runtime_capability_request', { capability }, {
      ...(options.signal ? { signal: options.signal } : {}),
      timeout
    })
  }

  /** Revokes a capability previously granted to the current plugin instance. */
  async revokeCapability(request) {
    if (
      typeof this.transport.isElectronEnvironment !== 'function' ||
      !this.transport.isElectronEnvironment()
    ) {
      const error = new Error('运行时能力撤销仅支持 Electron 宿主')
      error.code = 'NOT_SUPPORTED'
      throw error
    }
    const capability = request && typeof request === 'object' ? request.capability : undefined
    return this.transport.call('runtime_capability_revoke', { capability })
  }

  /** Main-window only: lists active instance grants for user management. */
  async listCapabilityGrants() {
    if (
      typeof this.transport.isElectronEnvironment !== 'function' ||
      !this.transport.isElectronEnvironment()
    ) {
      const error = new Error('运行时能力管理仅支持 Electron 宿主')
      error.code = 'NOT_SUPPORTED'
      throw error
    }
    return this.transport.call('runtime_capability_grants_list', {})
  }

  /** Main-window only: revokes one opaque grant ID displayed by listCapabilityGrants. */
  async revokeCapabilityGrant(grantId) {
    if (
      typeof this.transport.isElectronEnvironment !== 'function' ||
      !this.transport.isElectronEnvironment()
    ) {
      const error = new Error('运行时能力管理仅支持 Electron 宿主')
      error.code = 'NOT_SUPPORTED'
      throw error
    }
    return this.transport.call('runtime_capability_grant_revoke', { grantId })
  }

  /**
   * Returns the current Electron host identity without accepting caller supplied identity data.
   * @returns {Promise<object>} Runtime identity defined by runtime-identity.schema.json
   */
  async getRuntimeIdentity() {
    if (
      typeof this.transport.isElectronEnvironment !== 'function' ||
      !this.transport.isElectronEnvironment()
    ) {
      const error = new Error('Runtime identity is only available from the Electron host')
      error.code = 'NOT_SUPPORTED'
      throw error
    }
    return this.transport.call('system_get_runtime_identity', {})
  }

  /**
   * 是否为 Windows 系统
   * @returns {Promise<boolean>}
   */
  async isWindows() {
    const info = await this.getPlatform()
    return info.isWindows
  }

  /**
   * 是否为 macOS 系统
   * @returns {Promise<boolean>}
   */
  async isMacOS() {
    const info = await this.getPlatform()
    return info.isMacOS
  }

  /**
   * 是否为 Linux 系统
   * @returns {Promise<boolean>}
   */
  async isLinux() {
    const info = await this.getPlatform()
    return info.isLinux
  }

  // ============ 电源管理功能 ============

  /**
   * 关机
   * @param {boolean} force - 是否强制关机，默认 false
   * @param {number} timeout - 延迟时间（秒），默认 0
   * @returns {Promise<boolean>}
   */
  async shutdown(force = false, timeout = 0) {
    const r = await this.transport.call('system_shutdown', { force, timeout })
    return r && r.success === true
  }

  /**
   * 重启
   * @param {boolean} force - 是否强制重启，默认 false
   * @returns {Promise<boolean>}
   */
  async restart(force = false) {
    const r = await this.transport.call('system_restart', { force })
    return r && r.success === true
  }

  /**
   * 注销当前用户
   * @param {boolean} force - 是否强制注销，默认 false
   * @returns {Promise<boolean>}
   */
  async logout(force = false) {
    const r = await this.transport.call('system_logout', { force })
    return r && r.success === true
  }

  /**
   * 锁定屏幕
   * @returns {Promise<boolean>}
   */
  async lock() {
    const r = await this.transport.call('system_lock', {})
    return r && r.success === true
  }

  /**
   * 睡眠（挂起到内存）
   * @returns {Promise<boolean>}
   */
  async sleep() {
    const r = await this.transport.call('system_sleep', {})
    return r && r.success === true
  }

  /**
   * 休眠（挂起到磁盘）
   * @returns {Promise<boolean>}
   */
  async hibernate() {
    const r = await this.transport.call('system_hibernate', {})
    return r && r.success === true
  }

  /**
   * 阻止/允许系统休眠
   * @param {boolean} enable - 是否阻止休眠
   * @returns {Promise<boolean>}
   */
  async preventSleep(enable) {
    const r = await this.transport.call('system_prevent_sleep', {
      enable: !!enable
    })
    return r && r.success === true
  }

  // ============ Phase 1.4: 键鼠模拟 ============

  /**
   * 模拟按键
   * @param {string} key - 按键，如 'A', 'Enter', 'F1'
   * @returns {Promise<boolean>}
   */
  async simulateKeyPress(key) {
    const r = await this.transport.call('system_simulate_key_press', { key })
    return r && r.success === true
  }

  /**
   * 模拟组合键
   * @param {string} keys - 组合键，如 'Ctrl+C', 'Alt+F4'
   * @returns {Promise<boolean>}
   */
  async simulateKeyCombo(keys) {
    const r = await this.transport.call('system_simulate_key_combo', { keys })
    return r && r.success === true
  }

  /**
   * 输入文本
   * @param {string} text - 要输入的文本
   * @returns {Promise<boolean>}
   */
  async simulateText(text) {
    const r = await this.transport.call('system_simulate_text', { text })
    return r && r.success === true
  }

  /**
   * 移动鼠标
   * @param {number} x - X坐标
   * @param {number} y - Y坐标
   * @returns {Promise<boolean>}
   */
  async simulateMouseMove(x, y) {
    const r = await this.transport.call('system_simulate_mouse_move', { x, y })
    return r && r.success === true
  }

  /**
   * 模拟鼠标点击
   * @param {string} button - 按钮：'left'|'right'|'middle'
   * @param {number} [x] - X坐标(可选,不提供则在当前位置点击)
   * @param {number} [y] - Y坐标(可选)
   * @returns {Promise<boolean>}
   */
  async simulateMouseClick(button, x, y) {
    const r = await this.transport.call('system_simulate_mouse_click', {
      button,
      x,
      y
    })
    return r && r.success === true
  }

  /**
   * 模拟鼠标滚轮
   * @param {number} delta - 滚动量（正数向上，负数向下）
   * @returns {Promise<boolean>}
   */
  async simulateMouseWheel(delta) {
    const r = await this.transport.call('system_simulate_mouse_wheel', {
      delta
    })
    return r && r.success === true
  }

  // ============ Phase 2: 系统监控 ============

  /**
   * 获取CPU使用率
   * @returns {Promise<{total: number, perCore: Array<number>}>}
   */
  async getHardwareSummary() {
    const result = await this.transport.call('system_get_hardware_summary', {})
    const data = result?.data, failed = () => Object.assign(new Error('硬件概要响应无效'), { code: 'SYSTEM_ERROR' })
    if (result?.success !== true || !data || !['windows', 'macos'].includes(data.platform) || !['ia32', 'x64', 'arm64'].includes(data.processArch) || typeof data.osVersion !== 'string' || data.osVersion.length > 64 || !Array.isArray(data.cpuModels) || data.cpuModels.length > 32 || data.cpuModels.some(value => typeof value !== 'string' || !value || value.length > 512) || !Number.isSafeInteger(data.logicalCpuCount) || data.logicalCpuCount < 0 || data.logicalCpuCount > 65536 || !Number.isSafeInteger(data.totalMemory) || data.totalMemory < 0 || !data.fieldAvailability || ['cpuModels', 'logicalCpuCount', 'totalMemory', 'osVersion'].some(key => typeof data.fieldAvailability[key] !== 'boolean')) throw failed()
    if (data.fieldAvailability.cpuModels !== !!data.cpuModels.length || data.fieldAvailability.logicalCpuCount !== (data.logicalCpuCount > 0) || data.fieldAvailability.totalMemory !== (data.totalMemory > 0) || data.fieldAvailability.osVersion !== !!data.osVersion) throw failed()
    return Object.freeze({ platform: data.platform, processArch: data.processArch, osVersion: data.osVersion, cpuModels: Object.freeze([...data.cpuModels]), logicalCpuCount: data.logicalCpuCount, totalMemory: data.totalMemory, fieldAvailability: Object.freeze({ ...data.fieldAvailability }) })
  }
  async getCPUUsage() {
    const r = await this.transport.call('system_get_cpu_usage', {})
    return r && r.success ? r : null
  }

  /**
   * 获取内存使用情况
   * @returns {Promise<{total: number, used: number, available: number, percent: number}>}
   */
  async getMemoryUsage() {
    const r = await this.transport.call('system_get_memory_usage', {})
    return r && r.success ? r : null
  }

  /**
   * 获取磁盘使用情况
   * @param {string} [drive] - 卷绝对路径；省略时使用当前系统卷根目录
   * @returns {Promise<{total: number, used: number, free: number, percent: number}>}
   */
  async getDiskUsage(drive) {
    const params = drive === undefined ? {} : { drive }
    const r = await this.transport.call('system_get_disk_usage', params)
    return r && r.success ? r : null
  }

  /**
   * 获取网络统计
   * @returns {Promise<{sent: number, received: number, speed: number}>}
   */
  async getNetworkStats() {
    const r = await this.transport.call('system_get_network_stats', {})
    return r && r.success ? r : null
  }

  /**
   * 获取电池状态
   * @returns {Promise<{percent: number, isCharging: boolean, timeRemaining: number}>}
   */
  async getBatteryStatus() {
    const r = await this.transport.call('system_get_battery_status', {})
    return r && r.success ? r : null
  }

  // ============ 软件更新功能 ============

  /**
   * 检查更新（同时检查App和Web）
   * @returns {Promise<{app: object|null, web: object|null}>}
   * {
   *   app: { version, changelog, force, fileSize, downloadUrl, checksum } | null,
   *   web: { version, changelog, fileSize, downloadUrl } | null
   * }
   */
  async checkUpdate(source = 'manual') {
    const normalizedSource = source === 'startup' ? 'startup' : 'manual'
    const r = await this.transport.call('update_check', { source: normalizedSource })
    if (r && r.success) {
      return {
        app: r.app || null,
        web: r.web || null
      }
    }
    throw new Error(r?.error || 'Check update failed')
  }

  /**
   * 检查App更新（兼容方法，实际调用统一检查）
   * @returns {Promise<object|null>}
   */
  async checkAppUpdate() {
    const result = await this.checkUpdate()
    return result.app
  }

  /**
   * 检查Web资源更新（兼容方法，实际调用统一检查）
   * @returns {Promise<object|null>}
   */
  async checkWebUpdate() {
    const result = await this.checkUpdate()
    return result.web
  }

  /**
   * 执行更新
   * @param {string} type - 更新类型: 'app' | 'web'
   * @param {object} [info] - 更新信息（可选，传入后不依赖 Delphi 端缓存）
   * @param {string} [info.version] - 版本号
   * @param {string} [info.downloadUrl] - 下载地址
   * @param {string} [info.changelog] - 更新日志
   * @param {number} [info.fileSize] - 文件大小
   * @param {string} [info.checksum] - 校验和
   * @param {string} [info.minAppVersion] - Web 更新要求的最低宿主版本
   * @returns {Promise<{status: string}>}
   */
  async performUpdate(type, info = {}) {
    const payload = { type, ...info }
    const r = await this.transport.call('update_install_start', payload, {
      ...(type === 'app' ? { timeout: Infinity } : {})
    })
    if (r && r.success) {
      return r
    }
    throw new Error(r?.error || 'Update failed')
  }

  /**
   * 获取当前版本信息
   * @returns {Promise<{appVersion: string, webVersion: string}>}
   */
  async getCurrentVersion() {
    const r = await this.transport.call('update_get_version', {})
    if (r && r.success) {
      return {
        appVersion: r.appVersion || '0',
        webVersion: r.webVersion || '0'
      }
    }
    throw new Error(r?.error || 'Get version failed')
  }

  // ============ 提权执行功能 ============

  /**
   * 提权执行原子操作
   * @param {string} type - 操作类型 (reg_write, reg_delete, file_delete, file_write, file_copy, file_move, process_kill, scheduled_task_set_enabled, restart_explorer, system_action)
   * @param {object} payload - 操作参数
   * @param {number} [timeout=30000] - 超时时间（毫秒）
   * @returns {Promise<any>}
   */
  async privilegedExecute(type, payload, timeout = 30000) {
    const r = await this.transport.call('privileged_execute', {
      type,
      payload,
      timeout
    })
    if (r && r.success) {
      return r.result
    }
    throw new Error(r?.error || 'Privileged execute failed')
  }

  // ============ 快捷键管理 ============

  /**
   * 重新加载超级面板热键配置
   * @returns {Promise<boolean>}
   */
  async reloadHotkeys() {
    const r = await this.transport.call('system_reload_hotkeys', {})
    return r && r.success === true
  }

  /**
   * 获取已加入超级面板的本地软件
   * @returns {Promise<Array<{id: string, name: string}>>}
   */
  async getPanelLocalApps() {
    const r = await this.transport.call('system_get_panel_local_apps', {})
    if (r && r.success) {
      return Array.isArray(r.apps) ? r.apps : []
    }
    throw new Error(r?.error || 'Get panel local apps failed')
  }

}

export default SystemAPI
