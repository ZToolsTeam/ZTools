/**
 * Events - 事件系统
 * 事件订阅/发布、请求/响应模式、频道管理
 */
class Events {
  constructor(transport) {
    this.transport = transport
    this.handlers = new Map()
    this.subscriptions = new Set()
    this.failedUnsubscriptions = new Set()
    this.subscriptionPromises = new Map()
    this.unsubscriptionPromises = new Map()
    this.legacyHandlers = new Map()
    this.confirmedHandlers = new Map()
    this.pendingConfirmedSubscriptions = new Map()
    this.pendingRequests = new Map()
    this.lifecycleVersion = 0
    this.destroyed = false
    this.destroyPromise = null
  }

  // ============ 内部工具方法 ============

  _ensureSet(key) {
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set())
    }
    return this.handlers.get(key)
  }

  _buildEnvelope(type, payload, options = {}) {
    return {
      envelopeId: `env_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      version: 'v1',
      timestamp: Date.now(),
      type,
      scope: options.scope || 'system',
      channel: options.channel,
      source: { kind: 'page' },
      target: { broadcast: true },
      payload: payload == null ? {} : payload,
      ...options
    }
  }

  async _subscribeKey(key, lifecycleVersion = this.lifecycleVersion) {
    this._assertActiveLifecycle(lifecycleVersion)

    const pendingUnsubscribe = this.unsubscriptionPromises.get(key)
    if (pendingUnsubscribe) {
      await pendingUnsubscribe.catch(() => {})
      this._assertActiveLifecycle(lifecycleVersion)
    }

    if (this.subscriptions.has(key) && !this.failedUnsubscriptions.has(key)) {
      return { success: true, subscribed: false }
    }

    const pendingSubscribe = this.subscriptionPromises.get(key)
    if (pendingSubscribe) return pendingSubscribe

    let transportResult
    try {
      // Preserve the legacy on()/onChannel() timing: start the Main call in
      // the current turn, while still exposing an awaitable confirmation.
      transportResult = this.transport.call('event_subscribe', { key })
    } catch (error) {
      transportResult = Promise.reject(error)
    }
    let subscribePromise
    subscribePromise = Promise.resolve(transportResult)
      .then((result) => {
        this._requireSubscriptionSuccess('subscribe', result)
        this.subscriptions.add(key)
        this.failedUnsubscriptions.delete(key)
        return result
      })
      .finally(() => {
        if (this.subscriptionPromises.get(key) === subscribePromise) {
          this.subscriptionPromises.delete(key)
        }
      })
    this.subscriptionPromises.set(key, subscribePromise)
    return subscribePromise
  }

  _assertActiveLifecycle(lifecycleVersion) {
    if (this.destroyed || lifecycleVersion !== this.lifecycleVersion) {
      throw new Error('Events were cleared or destroyed before event subscription')
    }
  }

  _requireSubscriptionSuccess(operation, result) {
    if (result && result.success === true) return

    const error = new Error(`Main did not confirm event ${operation}`)
    error.code = operation === 'subscribe'
      ? 'EVENT_SUBSCRIPTION_NOT_CONFIRMED'
      : 'EVENT_UNSUBSCRIPTION_NOT_CONFIRMED'
    throw error
  }

  _hasLocalHandlers(key) {
    return (this.handlers.get(key)?.size || 0) > 0 ||
      (this.pendingConfirmedSubscriptions.get(key) || 0) > 0
  }

  async _unsubscribeKey(key, { onlyWhenIdle = false } = {}) {
    const pendingUnsubscribe = this.unsubscriptionPromises.get(key)
    if (pendingUnsubscribe) return pendingUnsubscribe

    const pendingSubscribe = this.subscriptionPromises.get(key)
    const performUnsubscribe = async () => {
        if (onlyWhenIdle && this._hasLocalHandlers(key)) {
          return { success: true, unsubscribed: false }
        }
        if (!this.subscriptions.has(key) && !this.failedUnsubscriptions.has(key)) {
          return { success: true, unsubscribed: false }
        }

        let result
        try {
          result = await this.transport.call('event_unsubscribe', { key })
          this._requireSubscriptionSuccess('unsubscribe', result)
        } catch (error) {
          this.failedUnsubscriptions.add(key)
          throw error
        }
        this.subscriptions.delete(key)
        this.failedUnsubscriptions.delete(key)
        return result
    }
    let unsubscribePromise
    unsubscribePromise = (pendingSubscribe
      ? Promise.resolve(pendingSubscribe).catch(() => {}).then(performUnsubscribe)
      : performUnsubscribe())
      .finally(() => {
        if (this.unsubscriptionPromises.get(key) === unsubscribePromise) {
          this.unsubscriptionPromises.delete(key)
        }
      })
    this.unsubscriptionPromises.set(key, unsubscribePromise)
    return unsubscribePromise
  }

  _ensureOwnerSet(ownerMap, key) {
    if (!ownerMap.has(key)) ownerMap.set(key, new Set())
    return ownerMap.get(key)
  }

  _ensureConfirmedHandlerMap(key) {
    if (!this.confirmedHandlers.has(key)) {
      this.confirmedHandlers.set(key, new Map())
    }
    return this.confirmedHandlers.get(key)
  }

  _changePendingConfirmedSubscriptions(key, delta) {
    const count = (this.pendingConfirmedSubscriptions.get(key) || 0) + delta
    if (count > 0) this.pendingConfirmedSubscriptions.set(key, count)
    else this.pendingConfirmedSubscriptions.delete(key)
  }

  _releaseConfirmedHandler(key, handler) {
    const confirmedHandlers = this.confirmedHandlers.get(key)
    const count = confirmedHandlers?.get(handler) || 0
    if (!count) return Promise.resolve()

    if (count > 1) {
      confirmedHandlers.set(handler, count - 1)
      return Promise.resolve()
    }

    confirmedHandlers.delete(handler)
    if (!confirmedHandlers.size) this.confirmedHandlers.delete(key)

    if (!this.legacyHandlers.get(key)?.has(handler)) {
      this.handlers.get(key)?.delete(handler)
    }

    const handlers = this.handlers.get(key)
    if (handlers?.size) return Promise.resolve()
    this.handlers.delete(key)
    return this._unsubscribeKey(key, { onlyWhenIdle: true }).then(() => undefined)
  }

  _cleanupSubscriptionKeys(keys, message) {
    return Promise.allSettled([...keys].map((key) => this._unsubscribeKey(key)))
      .then((results) => {
        const errors = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason)
        errors.forEach((error) => console.error(message, error))
        return { success: errors.length === 0, errors }
      })
  }

  _settlePendingRequest(requestId, result) {
    const entry = this.pendingRequests.get(requestId)
    if (!entry) return false

    this.pendingRequests.delete(requestId)
    clearTimeout(entry.timeoutId)
    entry.resolve(result)
    return true
  }

  _cancelPendingRequests() {
    for (const requestId of this.pendingRequests.keys()) {
      this._settlePendingRequest(requestId, { ok: false, code: 'CANCELLED' })
    }
  }

  // ============ 事件分发 ============

  /**
   * 分发事件信封
   * @param {object} envelope - 事件信封
   */
  dispatchEnvelope(envelope) {
    try {
      if (!envelope) return

      // Phase 1: 处理请求/响应
      if (envelope.replyTo != null) {
        if (this.pendingRequests.has(envelope.replyTo)) {
          const ack = envelope.payload != null ? envelope.payload : envelope
          this._settlePendingRequest(envelope.replyTo, ack)
        }
        return
      }

      // Phase 2: 分发到事件处理器
      const keys = []
      if (envelope.type) keys.push(envelope.type)
      if (envelope.channel) keys.push('channel:' + envelope.channel)

      keys.forEach((k) => {
        const set = this.handlers.get(k)
        if (set && set.size) {
          set.forEach((fn) => {
            try {
              fn(envelope)
            } catch (e) {
              console.error('[ztools-events] Handler error:', e)
            }
          })
        }
      })

      // Phase 3: 通配符处理器
      const anySet = this.handlers.get('*')
      if (anySet && anySet.size) {
        anySet.forEach((fn) => {
          try {
            fn(envelope)
          } catch (e) {
            console.error('[ztools-events] Wildcard handler error:', e)
          }
        })
      }
    } catch (e) {
      console.error('[ztools-events] Dispatch envelope error:', e)
    }
  }

  // ============ 事件订阅/发布 ============

  /**
   * 订阅事件
   * @param {string} eventType - 事件类型
   * @param {function} handler - 处理函数
   */
  on(eventType, handler) {
    const set = this._ensureSet(eventType)
    set.add(handler)
    this._ensureOwnerSet(this.legacyHandlers, eventType).add(handler)

    // 通知后端订阅（异步，不阻塞）
    this._subscribeKey(eventType).catch((e) => {
      // 忽略订阅错误，不影响事件系统的使用
      if (this.transport._debug) {
        console.warn(
          '[ztools-events] Subscribe error (non-critical):',
          e.message
        )
      }
    })
  }

  /**
   * 取消订阅事件
   * @param {string} eventType - 事件类型
   * @param {function} handler - 处理函数(可选,不传则清空所有)
   */
  off(eventType, handler) {
    const set = this.handlers.get(eventType)

    if (handler) {
      set?.delete(handler)
      const legacyHandlers = this.legacyHandlers.get(eventType)
      legacyHandlers?.delete(handler)
      if (legacyHandlers && !legacyHandlers.size) this.legacyHandlers.delete(eventType)

      const confirmedHandlers = this.confirmedHandlers.get(eventType)
      confirmedHandlers?.delete(handler)
      if (confirmedHandlers && !confirmedHandlers.size) this.confirmedHandlers.delete(eventType)
    } else {
      set?.clear()
      this.legacyHandlers.delete(eventType)
      this.confirmedHandlers.delete(eventType)
    }

    // 如果没有处理器了,通知后端取消订阅
    if (!set?.size) {
      this.handlers.delete(eventType)
      this._unsubscribeKey(eventType, { onlyWhenIdle: true }).catch((e) => {
        console.error('[ztools-events] Unsubscribe error:', e)
      })
    }
  }

  /**
   * 等待 Main 确认后再添加本地事件处理器。
   * @param {string} eventType - 事件类型
   * @param {function} handler - 处理函数
   * @returns {Promise<function(): Promise<void>>} 幂等的异步注销函数
   */
  async subscribeConfirmed(eventType, handler) {
    if (typeof eventType !== 'string' || !eventType) {
      throw new TypeError('eventType must be a non-empty string')
    }
    if (typeof handler !== 'function') {
      throw new TypeError('handler must be a function')
    }
    if (this.destroyed) {
      throw new Error('Events instance is destroyed')
    }

    const lifecycleVersion = this.lifecycleVersion
    this._changePendingConfirmedSubscriptions(eventType, 1)
    try {
      await this._subscribeKey(eventType, lifecycleVersion)
      if (lifecycleVersion !== this.lifecycleVersion || this.destroyed) {
        throw new Error('Events were cleared or destroyed before subscription was confirmed')
      }

      this._ensureSet(eventType).add(handler)
      const confirmedHandlers = this._ensureConfirmedHandlerMap(eventType)
      confirmedHandlers.set(handler, (confirmedHandlers.get(handler) || 0) + 1)

      let active = true
      return () => {
        if (!active) return Promise.resolve()
        active = false
        return this._releaseConfirmedHandler(eventType, handler)
      }
    } finally {
      this._changePendingConfirmedSubscriptions(eventType, -1)
    }
  }

  /**
   * 发送事件
   * @param {string} eventType - 事件类型
   * @param {any} payload - 事件数据
   * @param {object} options - 选项
   * @returns {Promise}
   */
  async emit(eventType, payload, options) {
    const envelope = this._buildEnvelope(eventType, payload, options)
    // 先在前端本地分发事件（同步）
    this.dispatchEnvelope(envelope)
    // 然后通知后端（异步）
    return await this.transport.call('event_publish', { envelope })
  }

  // ============ 频道订阅 ============

  /**
   * 订阅频道
   * @param {string} channel - 频道名
   * @returns {Promise}
   */
  async subscribe(channel) {
    return await this._subscribeKey('channel:' + channel)
  }

  /**
   * 取消订阅频道
   * @param {string} channel - 频道名
   * @returns {Promise}
   */
  async unsubscribe(channel) {
    return await this._unsubscribeKey('channel:' + channel)
  }

  /**
   * 订阅频道并绑定处理器
   * @param {string} channel - 频道名
   * @param {function} handler - 处理函数
   */
  onChannel(channel, handler) {
    this.on('channel:' + channel, handler)
  }

  /**
   * 取消频道订阅
   * @param {string} channel - 频道名
   * @param {function} handler - 处理函数
   */
  offChannel(channel, handler) {
    this.off('channel:' + channel, handler)
  }

  /**
   * 发布到频道
   * @param {string} channel - 频道名
   * @param {string} eventType - 事件类型
   * @param {any} payload - 事件数据
   * @param {object} options - 选项
   * @returns {Promise}
   */
  async publish(channel, eventType, payload, options) {
    const opt = { ...options, channel }
    return await this.emit(eventType, payload, opt)
  }

  // ============ 请求/响应模式 ============

  /**
   * 发送请求并等待响应
   * @param {string} eventType - 事件类型
   * @param {any} payload - 请求数据
   * @param {object} options - 选项 {timeout, ...}
   * @returns {Promise}
   */
  async request(eventType, payload, options = {}) {
    const envelope = this._buildEnvelope(eventType, payload, options)
    if (!envelope.correlationId) {
      envelope.correlationId = envelope.envelopeId
    }

    return new Promise((resolve) => {
      const timeoutMs = options.timeout || 10000
      const timeoutId = setTimeout(() => {
        this._settlePendingRequest(envelope.envelopeId, { ok: false, code: 'TIMEOUT' })
      }, timeoutMs)

      this.pendingRequests.set(envelope.envelopeId, {
        resolve,
        timeoutId
      })

      // 尝试发送请求
      this.transport.call('event_request', { envelope }).catch(() => {
        // 如果event_request不支持,降级为event_publish
        this.transport.call('event_publish', { envelope })
      })
    })
  }

  /**
   * 响应请求
   * @param {string} replyTo - 回复的envelopeId
   * @param {any} ackPayload - 响应数据
   * @param {object} options - 选项
   * @returns {Promise}
   */
  async respond(replyTo, ackPayload, options = {}) {
    const env = this._buildEnvelope(
      options.type || 'events.Ack',
      ackPayload || {},
      options
    )
    env.replyTo = replyTo
    return await this.transport.call('event_publish', { envelope: env })
  }

  // ============ 清理 ============

  /**
   * 清理所有事件处理器
   * @returns {Promise<{success: boolean, errors: unknown[]}>} 取消订阅结果
   */
  clear() {
    this.lifecycleVersion += 1
    const subscribedKeys = new Set([
      ...this.subscriptions,
      ...this.failedUnsubscriptions,
      ...this.subscriptionPromises.keys(),
      ...this.unsubscriptionPromises.keys()
    ])
    this.handlers.clear()
    this.legacyHandlers.clear()
    this.confirmedHandlers.clear()
    this.pendingConfirmedSubscriptions.clear()
    this._cancelPendingRequests()
    return this._cleanupSubscriptionKeys(subscribedKeys, '[ztools-events] Cleanup unsubscribe error:')
  }

  /**
   * 销毁
   * @returns {Promise<{success: boolean, errors: unknown[]}>} 清理结果
   */
  destroy() {
    if (this.destroyPromise) return this.destroyPromise

    this.lifecycleVersion += 1
    this.destroyed = true
    const subscribedKeys = new Set([
      ...this.subscriptions,
      ...this.failedUnsubscriptions,
      ...this.subscriptionPromises.keys(),
      ...this.unsubscriptionPromises.keys()
    ])
    this.handlers.clear()
    this.legacyHandlers.clear()
    this.confirmedHandlers.clear()
    this.pendingConfirmedSubscriptions.clear()
    this._cancelPendingRequests()
    this.destroyPromise = this._cleanupSubscriptionKeys(
      subscribedKeys,
      '[ztools-events] Destroy unsubscribe error:'
    )
    return this.destroyPromise
  }
}

export default Events
