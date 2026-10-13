/** SDK2 file calls wait for Main's authoritative cancellation/commit result. */
class ReferenceTransport extends Transport {
  constructor(config = {}) {
    super(config)
    this.supportsAbortSignal = true
    this.referenceCalls = new Map()
    this.referenceDestroyed = false
    this.referenceCleanupMs = config.referenceCleanupMs ?? 30000
    if (!Number.isInteger(this.referenceCleanupMs) || this.referenceCleanupMs < 1 || this.referenceCleanupMs > 30000) {
      throw this._referenceError('INVALID_REQUEST', '取消等待上限无效')
    }
  }
  _referenceError(code, message) { const error = new Error(message); error.code = code; return error }
  _writeRecord(object, fields) {
    try {
      if (!object || typeof object !== 'object') return null
      const proto = Object.getPrototypeOf(object)
      const constructor = proto && Object.getOwnPropertyDescriptor(proto, 'constructor')?.value
      if (proto !== null && (Object.getPrototypeOf(proto) !== null ||
          typeof constructor !== 'function' || Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(Object))) return null
      const descriptors = Object.getOwnPropertyDescriptors(object), keys = Reflect.ownKeys(descriptors)
      if (keys.length !== fields.length || keys.some(key => !fields.includes(key) ||
          !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) return null
      return Object.fromEntries(fields.map(key => [key, descriptors[key].value]))
    } catch { return null }
  }
  // Only a correlated Main write receipt can establish commit; never an error or another method's data.
  _committedWriteReceipt(value) {
    const data = (object, fields) => this._writeRecord(object, fields)
    try {
      const fact = data(value, ['success', 'status', 'size', 'reference']) || data(value, ['success', 'status', 'size', 'issues'])
      if (!fact || fact.success !== true || !Number.isSafeInteger(fact.size) || fact.size < 0 || fact.size > 16 * 1024 * 1024) return null
      if (fact.status === 'committed' && Object.hasOwn(fact, 'reference')) {
        const ref = data(fact.reference, ['grantId', 'displayName', 'kind', 'operations', 'fileUrl'])
        const operation = ref && Object.getOwnPropertyDescriptor(ref.operations, '0')
        if (!ref || typeof ref.grantId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ref.grantId) ||
            typeof ref.displayName !== 'string' || ref.displayName.includes('\0') ||
            new TextEncoder().encode(ref.displayName).length > 4096 || ref.kind !== 'file' ||
            !Array.isArray(ref.operations) || ref.operations.length !== 1 ||
            operation?.enumerable !== true || !Object.hasOwn(operation, 'value') || operation.value !== 'read' ||
            Reflect.ownKeys(ref.operations).length !== 2 ||
            ref.fileUrl !== 'ztools://file/' + ref.grantId + '/' + encodeURIComponent(ref.displayName)) return null
        return Object.freeze({ success: true, status: 'committed', size: fact.size,
          reference: Object.freeze({ ...ref, operations: Object.freeze(['read']) }) })
      }
      if (fact.status !== 'committed-reference-unavailable' || !Array.isArray(fact.issues) ||
          fact.issues.length < 1 || fact.issues.length > 2) return null
      const issues = [], seen = new Set()
      for (let index = 0; index < fact.issues.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(fact.issues, String(index))
        const issue = descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') && data(descriptor.value, ['stage', 'code'])
        if (!issue || !['reference', 'release'].includes(issue.stage) || seen.has(issue.stage) ||
            (issue.stage === 'reference' && seen.has('release')) || !['PERMISSION_DENIED', 'FILE_ERROR'].includes(issue.code) ||
            (issue.stage === 'release' && issue.code !== 'FILE_ERROR')) return null
        seen.add(issue.stage); issues.push(Object.freeze(issue))
      }
      if (Reflect.ownKeys(fact.issues).length !== issues.length + 1) return null
      return Object.freeze({ success: true, status: fact.status, size: fact.size, issues: Object.freeze(issues) })
    } catch { return null }
  }
  _unavailableCommit(size, releaseFailed = false) {
    return Object.freeze({ success: true, status: 'committed-reference-unavailable', size,
      issues: Object.freeze([Object.freeze({ stage: 'reference', code: 'PERMISSION_DENIED' }),
        ...(releaseFailed ? [Object.freeze({ stage: 'release', code: 'FILE_ERROR' })] : [])]) })
  }
  call(method, params = {}, options = {}) {
    const host = window.__ztoolsElectron
    const cancel = host?.transport?.cancellations?.[method]
    if (host?.contractVersion !== 2 || typeof cancel !== 'function') {
      if (options.signal) return Promise.reject(this._referenceError('NOT_SUPPORTED', '宿主没有逐方法取消入口'))
      return super.call(method, params, options)
    }
    const invoke = host.transport.methods?.[method]
    const revoke = host.transport.methods?.filesystem_revoke
    const signal = options.signal
    const timeout = options.timeout ?? this.config.timeout
    const maximumTimeout = method === 'network_http_request' ? 300250 : 120000
    if (this.referenceDestroyed || signal?.aborted) return Promise.reject(this._referenceError('CALLER_DESTROYED', '文件请求已取消'))
    if (typeof invoke !== 'function' || (signal && (typeof signal.aborted !== 'boolean' ||
        typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) ||
        (timeout !== Infinity && (!Number.isInteger(timeout) || timeout < 1 || timeout > maximumTimeout))) {
      return Promise.reject(this._referenceError('INVALID_REQUEST', '文件传输选项无效'))
    }
    if (this.referenceCalls.size >= 64) return Promise.reject(this._referenceError('PERMISSION_DENIED', '文件请求超过上限'))
    const messageId = this._generateMessageId(method)
    const mutating = new Set(['filesystem_write_file', 'filesystem_write_cache', 'filesystem_delete_file',
      'filesystem_copy_file', 'filesystem_move_file', 'filesystem_create_directory', 'filesystem_delete_directory',
      'network_http_download', 'clipboard_copy_text', 'clipboard_copy_file', 'clipboard_copy_files', 'shell_trash_item',
      'clipboard_read_image', 'screen_capture', 'screen_capture_region']).has(method)
    return new Promise((resolve, reject) => {
      let requested = false, timer, deadline, settled = false, committedFact, cleanupPending = false, invocationFinished = false
      const releaseSlot = () => {
        if (invocationFinished && !cleanupPending) this.referenceCalls.delete(messageId)
      }
      const failure = () => this._referenceError(mutating ? 'FILE_WRITE_OUTCOME_UNKNOWN' : 'FILE_ERROR', '文件请求结束未确认')
      const cancellationUnconfirmed = () => this._referenceError('CANCELLATION_UNCONFIRMED', '取消请求未确认底层网络请求已结束')
      const pendingFailure = () => method === 'network_http_request' && requested ? cancellationUnconfirmed() : failure()
      const settle = (value, error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (deadline) clearTimeout(deadline)
        signal?.removeEventListener('abort', onAbort)
        error ? reject(this._withRequestId(error, messageId)) : resolve(value)
      }
      const requestCancel = (reason) => {
        if (requested || settled) return
        requested = true
        if (timer) clearTimeout(timer)
        deadline = setTimeout(() => committedFact
          ? settle(this._unavailableCommit(committedFact.size, true))
          : settle(undefined, method === 'network_http_request' ? cancellationUnconfirmed() : failure()), this.referenceCleanupMs)
        // A failed cancel send does not prove the original native operation stopped.
        Promise.resolve().then(() => cancel({ messageId, reason })).catch(() => undefined)
      }
      const onAbort = () => requestCancel('cancel')
      this.referenceCalls.set(messageId, { cancel: () => requestCancel('cancel') })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      if (timeout !== Infinity) timer = setTimeout(() => requestCancel('timeout'), timeout)
      const request = { messageId, params, timeoutMs: timeout === Infinity ? 'infinite' : timeout }
      const revokeCommitted = async (fact) => {
        committedFact = fact
        if (typeof revoke !== 'function') return this._unavailableCommit(fact.size, true)
        const cleanupId = this._generateMessageId('filesystem_revoke')
        cleanupPending = true
        let cleanupTimer
        const cleanup = Promise.resolve().then(() => revoke({ messageId: cleanupId,
          params: { grantId: fact.reference.grantId }, timeoutMs: this.referenceCleanupMs })).then(response => {
          const outer = this._writeRecord(response, ['messageId', 'success', 'data'])
          return outer?.messageId === cleanupId && outer.success === true &&
            this._writeRecord(outer.data, ['success'])?.success === true
        }).catch(() => false).finally(() => { cleanupPending = false; releaseSlot() })
        const confirmed = await Promise.race([cleanup, new Promise(resolve => {
          cleanupTimer = setTimeout(() => resolve(false), this.referenceCleanupMs)
        })])
        clearTimeout(cleanupTimer)
        return this._unavailableCommit(fact.size, !confirmed)
      }
      Promise.resolve().then(() => invoke(request)).then(async response => {
        if (method === 'filesystem_write_file') response = this._writeRecord(response, ['messageId', 'success', 'data']) ||
          this._writeRecord(response, ['messageId', 'success', 'error'])
        if (!response || response.messageId !== messageId || typeof response.success !== 'boolean') throw pendingFailure()
        if (!response.success) {
          if (!response.error || typeof response.error.code !== 'string' || typeof response.error.message !== 'string') throw pendingFailure()
          throw this._referenceError(response.error.code, response.error.message)
        }
        if (method === 'filesystem_write_file') {
          const fact = this._committedWriteReceipt(response.data)
          if (fact) {
            if ((requested || settled) && fact.status === 'committed') settle(await revokeCommitted(fact))
            else settle(fact)
            return
          }
        }
        // Other methods retain their existing cancellation semantics.
        if (requested && method !== 'network_http_request') throw failure()
        settle(response.data)
      }).catch(error => settle(undefined, error?.code ? error : pendingFailure())).finally(() => {
        invocationFinished = true; releaseSlot()
      })
    })
  }
  getPendingCallsCount() { return super.getPendingCallsCount() + this.referenceCalls.size }
  clearPendingCalls() {
    for (const call of this.referenceCalls.values()) call.cancel()
    super.clearPendingCalls()
  }
  destroy() { this.referenceDestroyed = true; super.destroy() }
}

export default ReferenceTransport
