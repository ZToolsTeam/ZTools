function shouldRedactParams(method) {
  return method === 'db_put_secure' || method === 'db_get_secure' || method === 'network_http_request' ||
    method.startsWith('credential_v1_')
}

const NETWORK_CANCELLATION_CONFIRMATION_MS = 30000

/**
 * Transport - 通信传输层
 * 负责与 Delphi 端的 V8 绑定通信，提供 Promise 封装、超时处理、消息路由
 */
class Transport {
  constructor(config = {}) {
    this.config = {
      debug: config.debug || false,
      timeout: config.timeout || 10000,
      gracefulDegradation: config.gracefulDegradation !== false, // 默认启用优雅降级
      ...config
    }

    this.pendingCalls = new Map()
    this.messageCallback = null
    this.callIdCounter = 0
    this.mockProvider = new MockProvider()

    this._setupDebug()
    this._checkEnvironment()
  }

  // ============ 调试工具 ============
  _setupDebug() {
    this._debug = this.config.debug
    try {
      if (
        window.localStorage &&
        window.localStorage.getItem('ZTOOLS_DEBUG') === '1'
      ) {
        this._debug = true
      }
    } catch (e) {}
  }

  _log(...args) {
    // if (this._debug) {
    //   try {
    //     console.debug('[ztools-transport]', ...args)
    //   } catch (e) {}
    // }
  }

  _withRequestId(error, messageId) {
    const requestId = typeof messageId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(messageId)
      ? messageId
      : null
    if (!requestId) return error
    const target = error && (typeof error === 'object' || typeof error === 'function')
      ? error
      : new Error(String(error || '请求失败'))
    try {
      if (target.requestId === requestId) return target
      Object.defineProperty(target, 'requestId', {
        value: requestId,
        enumerable: false,
        configurable: false,
        writable: false
      })
      return target
    } catch {
      const wrapped = new Error(target instanceof Error ? target.message : String(target))
      if (typeof target.code === 'string') wrapped.code = target.code
      try { Object.defineProperty(wrapped, 'cause', { value: error, enumerable: false }) } catch (causeError) {}
      Object.defineProperty(wrapped, 'requestId', {
        value: requestId,
        enumerable: false,
        configurable: false,
        writable: false
      })
      return wrapped
    }
  }

  _toPublicError(error, context = {}) {
    const message =
      error instanceof Error ? error.message : String(error || '')

    if (/^Call timeout[:：]/i.test(message)) {
      console.error('[ztools-transport]', message, context)

      const publicError = new Error('超时失败')
      publicError.code = 'CALL_TIMEOUT'
      publicError.detail = message
      publicError.cause = error
      return publicError
    }

    return error
  }

  // ============ 环境检测 ============
  _checkEnvironment() {
    // 显示环境警告(仅首次)
    environment.showEnvironmentWarning()

    // 记录环境信息
    this._log('Environment:', environment.getInfo())
  }

  // ============ 核心通信方法 ============

  /**
   * 调用V8绑定方法
   * @param {string} method - 方法名
   * @param {object} params - 参数
   * @param {object} options - 选项 {timeout}
   * @returns {Promise<any>}
   */
  async call(method, params = {}, options = {}) {
    return new Promise((resolve, reject) => {
      const messageId = this._generateMessageId(method)
      const timeout = options.timeout ?? this.config.timeout
      const signal = options.signal
      const bridge = environment.getElectronTransport()
      const cancel = bridge?.cancellations?.[method]

      if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
          typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
        const error = new Error('IPC signal 无效')
        error.code = 'INVALID_REQUEST'
        reject(this._withRequestId(error, messageId))
        return
      }
      if (signal?.aborted) {
        const error = Object.assign(new Error('调用已取消'), { name: 'AbortError', code: 'CALLER_DESTROYED' })
        reject(this._withRequestId(error, messageId))
        return
      }
      if (signal && typeof cancel !== 'function') {
        const error = new Error('宿主没有此方法的受控取消入口')
        error.code = 'NOT_SUPPORTED'
        reject(this._withRequestId(error, messageId))
        return
      }

      this._log('call ->', method, shouldRedactParams(method) ? '[REDACTED]' : params, 'messageId:', messageId)

      let timeoutId = null
      let cancellationDeadlineId = null
      let settled = false
      let cancelRequested = false
      let abortListener
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId)
        if (cancellationDeadlineId) clearTimeout(cancellationDeadlineId)
        signal?.removeEventListener('abort', abortListener)
        this.pendingCalls.delete(messageId)
      }
      const settleResolve = value => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const settleReject = error => {
        if (settled) return
        settled = true
        cleanup()
        reject(this._withRequestId(error, messageId))
      }
      const requestCancel = (reason, publicError) => {
        if (settled || cancelRequested) return
        cancelRequested = true
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        const cancellationUnconfirmed = () => Object.assign(
          new Error('取消请求未确认底层网络请求已结束'),
          { code: 'CANCELLATION_UNCONFIRMED' }
        )
        if (method === 'network_http_request') {
          cancellationDeadlineId = setTimeout(() => settleReject(cancellationUnconfirmed()), NETWORK_CANCELLATION_CONFIRMATION_MS)
        }
        Promise.resolve().then(() => cancel({ messageId, reason })).then(response => {
          if (!response || response.messageId !== messageId || response.success !== true) {
            throw cancellationUnconfirmed()
          }
        }).then(() => {
          if (!settled && method !== 'network_http_request') settleReject(publicError)
        }, error => {
          if (method === 'network_http_request') {
            // A failed cancellation ACK does not tell us whether the original request
            // has settled. Keep awaiting its response; the bounded deadline reports
            // unconfirmed only if that response never arrives.
            return
          } else if (error?.code) {
            settleReject(error)
          } else {
            settleReject(Object.assign(new Error('取消请求未获 Main 确认，原请求结果尚未确认'), {
              code: 'CANCELLATION_UNCONFIRMED', cause: error
            }))
          }
        })
      }
      const onTimeout = () => {
        if (typeof cancel === 'function') {
          const timeoutError = Object.assign(new Error('屏幕权限申请已超时'), { code: 'REQUEST_TIMEOUT' })
          requestCancel('timeout', timeoutError)
          return
        }
        const timeoutError = new Error(`Call timeout: ${method}`)
        this._log('call timeout:', method)
        settleReject(this._toPublicError(timeoutError, { method, messageId, timeout }))
      }
      if (timeout !== Infinity && timeout > 0) timeoutId = setTimeout(onTimeout, timeout)
      abortListener = () => {
        const error = Object.assign(new Error('调用已取消'), { name: 'AbortError', code: 'CALLER_DESTROYED' })
        requestCancel('cancel', error)
      }
      signal?.addEventListener('abort', abortListener, { once: true })

      this.pendingCalls.set(messageId, {
        method,
        messageId,
        resolve: settleResolve,
        reject: settleReject,
        timeoutId,
        timeout,
        timestamp: Date.now()
      })

      try {
        this._executeCall(method, params, messageId, settleResolve, settleReject, timeoutId)
      } catch (error) {
        this._log('call error:', method, error)
        settleReject(this._toPublicError(error, { method, messageId }))
      }
    })
  }

  /**
   * 执行实际的V8绑定调用 - 统一通过消息机制
   */
  _executeCall(method, params, messageId, resolve, reject, timeoutId) {
    this._log(`_executeCall: ${method}`, shouldRedactParams(method) ? '[REDACTED]' : params)

    if (environment.isElectron()) {
      this._executeElectronCall(
        method,
        params,
        messageId,
        resolve,
        reject,
        timeoutId
      )
      return
    }

    // 检查V8绑定是否可用
    if (!window.ztools || typeof window.ztools._sendMessage !== 'function') {
      this._log(`V8 binding not available, using MockProvider for ${method}`)
      // 降级使用 MockProvider
      try {
        const mockResponse = this.mockProvider.generate(method, params)
        this._log(`MockProvider response for ${method}:`, shouldRedactParams(method) ? '[REDACTED]' : mockResponse)

        if (timeoutId) clearTimeout(timeoutId)
        this.pendingCalls.delete(messageId)

        // 如果返回的是 Promise, 等待完成后 resolve
        if (mockResponse instanceof Promise) {
          mockResponse.then(resolve).catch(reject)
        } else {
          resolve(mockResponse)
        }
        return
      } catch (mockError) {
        this._log('Mock generation error:', mockError)
      }

      if (timeoutId) clearTimeout(timeoutId)
      this.pendingCalls.delete(messageId)

      // 根据配置决定是否优雅降级
      if (this.config.gracefulDegradation) {
        const error = environment.createEnvironmentError(method)
        this._log('Environment error (graceful):', error.message)
        reject(error)
      } else {
        reject(
          new Error(
            'V8 binding not available: window.ztools._sendMessage is undefined'
          )
        )
      }
      return
    }

    try {
      // 将 messageId 添加到 params 中，让 Delphi 端使用这个 MessageId
      const paramsWithId = {
        ...params,
        _messageId: messageId
      }

      // 将 params 序列化为 JSON 字符串
      const paramsJson = JSON.stringify(paramsWithId)

      // 统一通过 _sendMessage 发送消息
      // V8Handler 会接收到 method 和 paramsJson,然后路由到对应的 Handler
      window.ztools._sendMessage(method, paramsJson)

      this._log('sent message:', method, shouldRedactParams(method) ? '[REDACTED]' : paramsJson)
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId)
      this.pendingCalls.delete(messageId)
      this._log('send message error:', method, error)
      reject(error)
    }
  }

  /**
   * 通过 Electron preload 的受控桥调用 main。
   */
  _executeElectronCall(
    method,
    params,
    messageId,
    resolve,
    reject,
    timeoutId
  ) {
    const bridge = environment.getElectronTransport()
    const methodCall = bridge?.methods?.[method]
    if (typeof methodCall !== 'function') {
      if (timeoutId) clearTimeout(timeoutId)
      this.pendingCalls.delete(messageId)
      const error = new Error(`Electron preload 未开放方法: ${method}`)
      error.code = 'METHOD_NOT_FOUND'
      reject(this._toPublicError(error, { method, messageId }))
      return
    }

    const timeout = this.pendingCalls.get(messageId)?.timeout
    const request = {
      messageId,
      params,
      ...(timeout === Infinity
        ? { timeoutMs: 'infinite' }
        : Number.isFinite(timeout) && timeout > 0
          ? { timeoutMs: timeout }
          : {})
    }

    Promise.resolve(methodCall(request))
      .then((response) => {
        if (timeoutId) clearTimeout(timeoutId)
        this.pendingCalls.delete(messageId)
        if (!response || response.messageId !== messageId) {
          throw new Error('Electron response messageId mismatch')
        }
        if (response.success === false) {
          const error = new Error(response.error?.message || 'Request failed')
          error.code = response.error?.code || 'REQUEST_FAILED'
          throw error
        }
        resolve(response.data)
      })
      .catch((error) => {
        if (timeoutId) clearTimeout(timeoutId)
        this.pendingCalls.delete(messageId)
        reject(this._toPublicError(error, { method, messageId }))
      })
  }

  /**
   * 生成唯一的 MessageId（与 Delphi 端格式一致）
   * 格式: js_timestamp_method
   */
  _generateMessageId(method) {
    // 使用时间戳 + 计数器确保唯一性
    return `js_${Date.now()}_${++this.callIdCounter}_${method}`
  }

  /**
   * 接收来自Delphi的消息
   */
  handleMessage(msgType, msgData) {
    // 解析响应数据
    let responseData = msgData
    if (typeof msgData === 'string') {
      try {
        responseData = JSON.parse(msgData)
      } catch (e) {
        // 如果不是JSON,保持原样
      }
    }

    const responseMessageId = responseData && typeof responseData === 'object'
      ? responseData._messageId
      : undefined
    const pendingMethod = typeof responseMessageId === 'string'
      ? this.pendingCalls.get(responseMessageId)?.method
      : undefined
    const logMethod = typeof pendingMethod === 'string' ? pendingMethod : msgType
    this._log('recv <-', msgType, shouldRedactParams(logMethod) ? '[REDACTED]' : msgData)

    // 通过 MessageId 精确匹配 pending call
    if (responseData && responseData._messageId) {
      const messageId = responseData._messageId
      const foundCall = this.pendingCalls.get(messageId)

      if (foundCall) {
        // 找到匹配的调用,清理并resolve/reject
        if (foundCall.timeoutId) clearTimeout(foundCall.timeoutId)
        this.pendingCalls.delete(messageId)

        if (responseData.success === false) {
          foundCall.reject(new Error(responseData.error || 'Request failed'))
        } else {
          foundCall.resolve(responseData)
        }
        this._log('call resolved:', msgType, 'messageId:', messageId)
        return
      } else {
        this._log('recv: messageId not found in pendingCalls:', messageId)
      }
    }

    // 没有 MessageId 或找不到匹配的调用,可能是主动推送的消息
    this._log('recv (no pending call):', msgType)
    if (this.messageCallback) {
      try {
        this.messageCallback(msgType, responseData)
      } catch (error) {
        this._log('messageCallback error:', error)
      }
    }
  }

  /**
   * 设置消息回调
   */
  setMessageCallback(callback) {
    this.messageCallback = callback

    // 注册到V8绑定
    if (
      window.ztools &&
      typeof window.ztools._setMessageCallback === 'function'
    ) {
      window.ztools._setMessageCallback((msgType, msgData) => {
        this.handleMessage(msgType, msgData)
      })
    }
  }

  /**
   * 获取待处理的调用数量
   */
  getPendingCallsCount() {
    return this.pendingCalls.size
  }

  /**
   * 清理所有待处理的调用
   */
  clearPendingCalls() {
    for (const [callId, call] of this.pendingCalls.entries()) {
      if (call.timeoutId) clearTimeout(call.timeoutId)
      call.reject(new Error('Transport cleared'))
    }
    this.pendingCalls.clear()
  }

  /**
   * 获取环境信息
   */
  getEnvironment() {
    return environment.getInfo()
  }

  /**
   * 获取 Electron preload 传输层，仅供 SDK 内部的平台差异适配使用。
   */
  getElectronTransport() {
    return environment.getElectronTransport()
  }

  /**
   * 检查是否在 CEF 环境中
   */
  isCEFEnvironment() {
    return environment.isCEF()
  }

  /**
   * 检查是否在 Electron 环境中
   */
  isElectronEnvironment() {
    return environment.isElectron()
  }

  /**
   * 销毁 Transport，清理所有资源
   */
  destroy() {
    this.clearPendingCalls()
    this.messageCallback = null
  }
}

export default Transport
