/**
 * Environment - 环境检测与适配
 * 检测运行环境，提供环境适配
 */
class Environment {
  constructor() {
    this.type = this._detectEnvironment()
  }

  /**
   * 获取 Electron preload 暴露的受控传输层。
   * @returns {object|null}
   */
  getElectronTransport() {
    try {
      if (typeof window === 'undefined') return null
      const transport = window.__ztoolsElectron?.transport
      return transport &&
        transport.methods &&
        typeof transport.methods === 'object'
        ? transport
        : null
    } catch {
      return null
    }
  }

  /**
   * 获取 CEF 注入的 V8 绑定。
   * @returns {object|null}
   */
  getCEFBridge() {
    try {
      if (typeof window === 'undefined') return null
      const bridge = window.ztools
      return bridge && typeof bridge._sendMessage === 'function' ? bridge : null
    } catch {
      return null
    }
  }

  /**
   * 检测运行环境
   * @returns {'electron'|'cef'|'browser'} 环境类型
   */
  _detectEnvironment() {
    // Electron preload 只暴露逐方法 transport，不暴露 ipcRenderer。
    if (this.getElectronTransport()) {
      return 'electron'
    }

    // 检查是否存在 V8 绑定的特征
    if (this.getCEFBridge()) {
      return 'cef'
    }
    return 'browser'
  }

  /**
   * 判断是否在 CEF 环境中
   */
  isCEF() {
    return this.type === 'cef'
  }

  /**
   * 判断是否在 Electron 环境中
   */
  isElectron() {
    return this.type === 'electron'
  }

  /**
   * 判断是否在浏览器环境中
   */
  isBrowser() {
    return this.type === 'browser'
  }

  /**
   * 获取环境信息
   */
  getInfo() {
    return {
      type: this.type,
      isElectron: this.isElectron(),
      isCEF: this.isCEF(),
      isBrowser: this.isBrowser(),
      userAgent: navigator.userAgent,
      platform: navigator.platform
    }
  }

  /**
   * 创建环境错误
   */
  createEnvironmentError(method) {
    const errorMessage = `环境错误: ${method} 需要在 ZTools 应用中运行。当前环境: ${this.type}`

    const error = new Error(errorMessage)
    error.code = 'ENVIRONMENT_ERROR'
    error.environment = this.type
    error.method = method

    return error
  }

  /**
   * 显示环境警告(仅在浏览器环境首次显示)
   */
  showEnvironmentWarning() {
    if (this.isBrowser() && !this._warningShown) {
      this._warningShown = true

      console.warn(`
╔════════════════════════════════════════════════════════════╗
║  ⚠️ 当前在浏览器环境中 - ZTools API 需要在 ZTools 应用中运行  ║
╠════════════════════════════════════════════════════════════╣
║  环境信息:                                                 ║
║  - 类型: ${this.type.padEnd(48)} ║
╚════════════════════════════════════════════════════════════╝
            `)
    }
  }
}

// 创建全局单例
const environment = new Environment()

export default environment
