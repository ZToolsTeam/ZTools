/**
 * Network API - 网络请求
 * 解决 CEF 环境下的 CORS 限制
 */
class NetworkAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 发起HTTP请求
   * @param {Object} options - 请求选项
   * @param {string} options.method - 请求方法：'GET'|'HEAD'|'POST'|'PUT'|'DELETE'
   * @param {string} options.url - 请求URL
   * @param {Object} [options.headers] - 自定义请求头
   * @param {string|Object} [options.body] - 请求体(POST/PUT)
   * @param {number} [options.timeout=30000] - 超时时间(毫秒)
   * @param {AbortSignal} [options.signal] - 取消请求；仅通过 Transport 受控选项传递
   * @returns {Promise<{statusCode: number, statusText: string, body: string}>}
   */
  async request(options) {
    const { method, url, headers, body, timeout = 30000, signal } = options
    // Let the NetworkService's own deadline return its stable timeout result
    // before the outer IPC deadline can race it. Main's parser caps this at 300s.
    const transportTimeout = Number.isSafeInteger(timeout) && timeout > 0
      ? Math.min(timeout + 250, 300250)
      : timeout

    return await this.transport.call(
      'network_http_request',
      {
        method: method.toUpperCase(),
        url,
        headers,
        body: typeof body === 'object' ? JSON.stringify(body) : body,
        timeout
      },
      { timeout: transportTimeout, ...(signal === undefined ? {} : { signal }) }
    )
  }

  /**
   * 发起HTTP请求 (别名)
   */
  async httpRequest(options) {
    return await this.request(options)
  }

  /**
   * GET请求简化方法
   * @param {string} url - 请求URL
   * @param {Object} [options] - 额外选项
   * @returns {Promise<{statusCode: number, statusText: string, body: string}>}
   */
  async get(url, options = {}) {
    return this.request({ method: 'GET', url, ...options })
  }

  /**
   * POST请求简化方法
   * @param {string} url - 请求URL
   * @param {string|Object} body - 请求体
   * @param {Object} [options] - 额外选项
   * @returns {Promise<{statusCode: number, statusText: string, body: string}>}
   */
  async post(url, body, options = {}) {
    return this.request({ method: 'POST', url, body, ...options })
  }

  /**
   * PUT请求简化方法
   * @param {string} url - 请求URL
   * @param {string|Object} body - 请求体
   * @param {Object} [options] - 额外选项
   * @returns {Promise<{statusCode: number, statusText: string, body: string}>}
   */
  async put(url, body, options = {}) {
    return this.request({ method: 'PUT', url, body, ...options })
  }

  /**
   * DELETE请求简化方法
   * @param {string} url - 请求URL
   * @param {Object} [options] - 额外选项
   * @returns {Promise<{statusCode: number, statusText: string, body: string}>}
   */
  async delete(url, options = {}) {
    return this.request({ method: 'DELETE', url, ...options })
  }

  /**
   * 下载文件(带进度回调)
   * @param {string} url - 文件URL
   * @param {string} savePath - 保存路径
   * @param {Object} [options] - 下载选项
   * @param {Object} [options.headers] - 自定义请求头
   * @param {Function} [options.onProgress] - 进度回调 (downloaded, total) => void
   * @returns {Promise<{path: string, size: number}>}
   */
  async download(url, savePath, options = {}) {
    const { headers, onProgress, timeout = 120000 } = options

    // TODO: 实现进度回调监听
    // 需要通过EventBus监听download进度事件

    const result = await this.transport.call(
      'network_http_download',
      { url, savePath, headers, timeout },
      { timeout }
    )
    onProgress?.(result.size, result.size)
    return result
  }

  /**
   * 上传文件(带进度回调)
   * @param {string} url - 上传URL
   * @param {string} filePath - 文件路径
   * @param {Object} [options] - 上传选项
   * @param {Object} [options.headers] - 自定义请求头
   * @param {string} [options.fieldName='file'] - 表单字段名
   * @param {Function} [options.onProgress] - 进度回调 (uploaded, total) => void
   * @returns {Promise<Object>}
   */
  async upload(url, filePath, options = {}) {
    const { headers, fieldName = 'file', onProgress, timeout = 120000 } = options

    // TODO: 实现进度回调监听

    const result = await this.transport.call(
      'network_http_upload',
      { url, filePath, fieldName, headers, timeout },
      { timeout }
    )
    onProgress?.(1, 1)
    return result
  }

  /**
   * 设置Cookie
   * @param {Object} cookie - Cookie对象
   * @param {string} cookie.name - Cookie名称
   * @param {string} cookie.value - Cookie值
   * @param {string} [cookie.domain] - 域名
   * @param {string} [cookie.path='/'] - 路径
   * @returns {Promise<void>}
   */
  async setCookie(cookie) {
    return await this.transport.call('network_set_cookie', cookie)
  }

  /**
   * 获取Cookie
   * @param {string} url - URL
   * @returns {Promise<Array<Object>>} Cookie列表
   */
  async getCookie(url) {
    return await this.transport.call('network_get_cookie', { url })
  }

  /**
   * 清除所有Cookie
   * @returns {Promise<void>}
   */
  async clearCookies() {
    return await this.transport.call('network_clear_cookies', {})
  }

  /**
   * 设置代理
   * @param {Object} proxy - 代理配置
   * @param {string} proxy.host - 代理主机
   * @param {number} proxy.port - 代理端口
   * @param {string} [proxy.username] - 用户名
   * @param {string} [proxy.password] - 密码
   * @returns {Promise<void>}
   */
  async setProxy(proxy) {
    return await this.transport.call('network_set_proxy', proxy)
  }
}

// 导出类(不导出单例,由client.js实例化)
export default NetworkAPI
