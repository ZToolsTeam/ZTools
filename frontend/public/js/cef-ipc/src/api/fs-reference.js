/** SDK contract 2 source. Client activation accompanies Main/preload/manifest and all consumer migration. */
class ReferenceFileSystemAPI {
  constructor(transport) { this.transport = transport }

  _error(code, message) { const error = new Error(message); error.code = code; return error }
  _reference(ref, kinds, right) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) ||
        typeof ref.grantId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ref.grantId) || !kinds.includes(ref.kind) ||
        Object.keys(ref).some(key => !['grantId', 'displayName', 'kind', 'operations', 'fileUrl'].includes(key)) ||
        !Array.isArray(ref.operations) || (right && !ref.operations.includes(right))) {
      throw this._error('INVALID_REQUEST', '请使用当前SDK授权的文件引用，不能使用旧路径')
    }
    return ref.grantId
  }
  _relative(value = '', empty = true) {
    if (typeof value !== 'string' || new TextEncoder().encode(value).length > 4096 || value.includes('\0') || (!empty && !value)) {
      throw this._error('INVALID_REQUEST', '相对文件名无效')
    }
    if (value) {
      const parts = value.split('/')
      if (parts.length > 64 || parts.some(part => !part || part === '.' || part === '..' || /^\.ztools-save-/i.test(part))) {
        throw this._error('INVALID_REQUEST', '相对文件名超出授权范围')
      }
    }
    return value
  }
  _options(options, keys) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !keys.includes(key))) {
      throw this._error('INVALID_REQUEST', '文件选项无效')
    }
    if (options.replace !== undefined && typeof options.replace !== 'boolean') throw this._error('INVALID_REQUEST', 'replace必须为布尔值')
    if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw this._error('INVALID_REQUEST', 'onProgress必须为函数')
    if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== 'boolean' ||
        typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) {
      throw this._error('INVALID_REQUEST', 'signal必须为AbortSignal')
    }
    return options
  }
  async _call(method, params, options = {}, allowWriteOutcomeUnknown = false) {
    const bridge = window.__ztoolsElectron
    if (options.signal?.aborted) throw this._error('CALLER_DESTROYED', '文件请求已取消')
    if (bridge?.contractVersion !== 2 || typeof bridge.transport?.methods?.[method] !== 'function') {
      throw this._error('NOT_SUPPORTED', '文件引用需要已完成迁移的SDK合约2宿主')
    }
    // Cancellation requires the per-method bridge and the actual Transport implementation, never local-only pretend cancellation.
    if (options.signal && (typeof bridge.transport?.cancellations?.[method] !== 'function' || this.transport.supportsAbortSignal !== true)) {
      throw this._error('NOT_SUPPORTED', '当前宿主尚未开放此文件请求的取消入口')
    }
    let result = await this.transport.call(method, params, { ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeout !== undefined ? { timeout: options.timeout } : {}) })
    if (allowWriteOutcomeUnknown) {
      result = this._writeRecord(result, ['success', 'status', 'size', 'reference']) ||
        this._writeRecord(result, ['success', 'status', 'size', 'issues']) ||
        this._writeRecord(result, ['success', 'status', 'code']) || this._writeRecord(result, ['success', 'error'])
      if (!result) throw this._error('FILE_ERROR', '文件写入回执无效')
      if (result.error) result.error = this._writeRecord(result.error, ['code', 'message'])
    }
    if (!result?.success) {
      const keys = result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result) : []
      if (allowWriteOutcomeUnknown && result?.success === false && result.status === 'result-unknown' &&
          result.code === 'FILE_WRITE_OUTCOME_UNKNOWN' && keys.length === 3 &&
          keys.every(key => ['success', 'status', 'code'].includes(key))) return result
      throw this._error(result?.error?.code || 'FILE_ERROR', result?.error?.message || '文件引用操作失败')
    }
    return result
  }
  async readFile(ref, options = {}) {
    this._options(options, ['relativePath', 'signal', 'onProgress'])
    const result = await this._call('filesystem_read_file', { grantId: this._reference(ref, ['file', 'directory'], 'read'),
      relativePath: this._relative(options.relativePath), encoding: 'utf8' }, options)
    if (typeof result.content !== 'string' || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > 16 * 1024 * 1024 ||
        new TextEncoder().encode(result.content).length > 16 * 1024 * 1024) throw this._error('FILE_ERROR', '文件读取响应无效')
    options.onProgress?.(result.size, result.size)
    return result.content
  }
  async readFileAsBinary(ref, options = {}) {
    this._options(options, ['relativePath', 'signal', 'onProgress'])
    const result = await this._call('filesystem_read_file', { grantId: this._reference(ref, ['file', 'directory'], 'read'),
      relativePath: this._relative(options.relativePath), encoding: 'base64' }, options)
    const bytes = this._decode(result.content, result.size)
    options.onProgress?.(bytes.length, bytes.length)
    return bytes.buffer
  }
  async readFileRange(ref, offset, length, options = {}) {
    this._options(options, ['relativePath', 'signal'])
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
        length > 16 * 1024 * 1024 || offset > Number.MAX_SAFE_INTEGER - length) throw this._error('INVALID_REQUEST', '分段范围无效')
    const result = await this._call('filesystem_read_file_range', { grantId: this._reference(ref, ['file', 'directory'], 'read'),
      relativePath: this._relative(options.relativePath), offset, length }, options)
    const bytes = this._decode(result.content, result.size)
    if (result.offset !== offset || result.encoding !== 'base64' || bytes.length > length) throw this._error('FILE_ERROR', '分段读取响应无效')
    return bytes.buffer
  }
  _decode(content, size) {
    if (typeof content !== 'string' || !Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 || content.length > 24 * 1024 * 1024) {
      throw this._error('FILE_ERROR', '文件字节响应超出上限')
    }
    let binary
    try { binary = atob(content) } catch { throw this._error('FILE_ERROR', '文件字节响应无效') }
    if (binary.length !== size || btoa(binary) !== content) throw this._error('FILE_ERROR', '文件字节响应无效')
    return Uint8Array.from(binary, char => char.charCodeAt(0))
  }
  _content(content) {
    let value
    try { value = encodeContent(content) } catch { throw this._error('INVALID_REQUEST', '文件内容必须为文本或字节数组') }
    const bytes = value.encoding === 'utf8' ? new TextEncoder().encode(value.content).length : atob(value.content).length
    if (bytes > 16 * 1024 * 1024) throw this._error('FILE_TOO_LARGE', '单次文件写入超过16MiB上限')
    return value
  }
  _writeRecord(value, fields) {
    try {
      if (!value || typeof value !== 'object') return null
      const proto = Object.getPrototypeOf(value)
      const constructor = proto && Object.getOwnPropertyDescriptor(proto, 'constructor')?.value
      if (proto !== null && (Object.getPrototypeOf(proto) !== null ||
          typeof constructor !== 'function' || Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(Object))) return null
      const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
      if (keys.length !== fields.length || keys.some(key => !fields.includes(key) ||
          !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) return null
      return Object.fromEntries(fields.map(key => [key, descriptors[key].value]))
    } catch { return null }
  }
  _unavailableWriteReceipt(result, expectedBytes) {
    const data = (value, fields) => this._writeRecord(value, fields)
    try {
      const fact = data(result, ['success', 'status', 'size', 'issues'])
      if (!fact || fact.success !== true || fact.status !== 'committed-reference-unavailable' ||
          !Number.isSafeInteger(fact.size) || fact.size < 0 || fact.size > 16 * 1024 * 1024 ||
          fact.size !== expectedBytes || !Array.isArray(fact.issues) || fact.issues.length < 1 || fact.issues.length > 2) return null
      const issues = [], seen = new Set()
      for (let index = 0; index < fact.issues.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(fact.issues, String(index))
        const issue = descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') && data(descriptor.value, ['stage', 'code'])
        if (!issue || !['reference', 'release'].includes(issue.stage) || seen.has(issue.stage) ||
            (issue.stage === 'reference' && seen.has('release')) ||
            !['PERMISSION_DENIED', 'FILE_ERROR'].includes(issue.code) ||
            (issue.stage === 'release' && issue.code !== 'FILE_ERROR')) return null
        seen.add(issue.stage); issues.push(Object.freeze(issue))
      }
      if (Reflect.ownKeys(fact.issues).length !== issues.length + 1) return null
      return Object.freeze({ success: true, status: fact.status, size: fact.size, issues: Object.freeze(issues) })
    } catch { return null }
  }
  async writeFile(ref, content, options = {}) {
    this._options(options, ['replace', 'signal'])
    const encoded = this._content(content)
    const expectedBytes = encoded.encoding === 'utf8' ? new TextEncoder().encode(encoded.content).length : atob(encoded.content).length
    const result = await this._call('filesystem_write_file', { saveGrantId: this._reference(ref, ['save'], 'write'),
      ...encoded, replace: options.replace ?? false }, options, true)
    if (result.success === false) return Object.freeze({ success: false, status: 'result-unknown', code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
    const unavailable = this._unavailableWriteReceipt(result, expectedBytes)
    if (unavailable) return unavailable
    const keys = result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result) : []
    if (result.success !== true || result.status !== 'committed' || !Number.isSafeInteger(result.size) ||
        result.size !== expectedBytes || !result.reference || keys.length !== 4 ||
        keys.some(key => !['success', 'status', 'size', 'reference'].includes(key))) {
      throw this._error('FILE_ERROR', '文件写入回执无效')
    }
    const rawReference = this._writeRecord(result.reference, ['grantId', 'displayName', 'kind', 'operations', 'fileUrl'])
    const operation = Array.isArray(rawReference?.operations) && Object.getOwnPropertyDescriptor(rawReference.operations, '0')
    if (!rawReference || !Array.isArray(rawReference.operations) || rawReference.operations.length !== 1 ||
        Reflect.ownKeys(rawReference.operations).length !== 2 ||
        operation?.enumerable !== true || !Object.hasOwn(operation, 'value') || operation.value !== 'read') {
      throw this._error('FILE_ERROR', '文件写入回执无效')
    }
    rawReference.operations = ['read']
    const reference = this._returnedReference(rawReference, ['file'])
    if (typeof reference.fileUrl !== 'string' ||
        reference.fileUrl !== 'ztools://file/' + reference.grantId + '/' + encodeURIComponent(reference.displayName)) {
      throw this._error('FILE_ERROR', '文件写入回执产物 URL 无效')
    }
    return Object.freeze({ success: true, status: 'committed', size: result.size,
      reference: Object.freeze({ ...reference, operations: Object.freeze([...reference.operations]) }) })
  }
  async copyFile(source, destination, options = {}) {
    this._options(options, ['replace', 'signal'])
    return this._call('filesystem_copy_file', { fileGrantId: this._reference(source, ['file'], 'read'),
      saveGrantId: this._reference(destination, ['save'], 'write'), replace: options.replace ?? false }, options)
  }
  async moveFile(directory, relativePath, destination, options = {}) {
    this._options(options, ['replace', 'signal'])
    return this._call('filesystem_move_file', { directoryGrantId: this._reference(directory, ['directory'], 'write'),
      relativePath: this._relative(relativePath, false), saveGrantId: this._reference(destination, ['save'], 'write'), replace: options.replace ?? false }, options)
  }
  async _directory(method, directory, relativePath, right, options = {}, extra = {}, empty = false) {
    this._options(options, ['signal'])
    return this._call(method, { directoryGrantId: this._reference(directory, ['directory'], right), relativePath: this._relative(relativePath, empty), ...extra }, options)
  }
  async deleteFile(directory, name, options = {}) { return this._directory('filesystem_delete_file', directory, name, 'write', options, { isDirectory: false }) }
  async deleteDirectory(directory, name, options = {}) { return this._directory('filesystem_delete_directory', directory, name, 'write', options, { isDirectory: true }) }
  async createDirectory(directory, name, options = {}) { return this._directory('filesystem_create_directory', directory, name, 'write', options) }
  async getDirectoryContents(directory, name = '', options = {}) {
    const files = (await this._directory('filesystem_get_directory_contents', directory, name, 'list', options, {}, true)).files
    return this._listedFiles(files)
  }
  _listedFiles(files) {
    let names = 0
    if (!Array.isArray(files) || files.length > 10000 || files.some(file => {
      if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some(key => !['name', 'isDirectory', 'size'].includes(key)) ||
          typeof file.name !== 'string' || !file.name || file.name === '.' || file.name === '..' || /[\/\0]/.test(file.name) ||
          /^\.ztools-save-/i.test(file.name) || typeof file.isDirectory !== 'boolean' || !Number.isSafeInteger(file.size) || file.size < 0) return true
      const bytes = new TextEncoder().encode(file.name).length
      names += bytes
      return bytes > 4096 || names > 1024 * 1024
    })) throw this._error('FILE_ERROR', '目录枚举响应无效')
    return files
  }
  async _find(method, directory, pattern, options) {
    this._options(options, ['relativePath', 'caseSensitive', 'signal'])
    if (typeof pattern !== 'string' || !pattern || new TextEncoder().encode(pattern).length > 256 ||
        Array.from(pattern).length > 128 || /[\/\0]/.test(pattern) ||
        (options.caseSensitive !== undefined && typeof options.caseSensitive !== 'boolean')) throw this._error('INVALID_REQUEST', '文件查找模式无效')
    const result = await this._call(method, { directoryGrantId: this._reference(directory, ['directory'], 'list'),
      relativePath: this._relative(options.relativePath), pattern, caseSensitive: options.caseSensitive ?? true }, options)
    const files = this._listedFiles(result.files)
    if (files.some(file => file.isDirectory !== (method === 'filesystem_find_directories'))) throw this._error('FILE_ERROR', '文件查找响应类型无效')
    return files
  }
  async findFiles(directory, pattern = '*', options = {}) { return this._find('filesystem_find_files', directory, pattern, options) }
  async findDirectories(directory, pattern = '*', options = {}) { return this._find('filesystem_find_directories', directory, pattern, options) }
  _returnedReference(value, kinds) {
    try {
      this._reference(value, kinds)
      if (typeof value.displayName !== 'string' || value.displayName.includes('\0') || new TextEncoder().encode(value.displayName).length > 4096 ||
          new Set(value.operations).size !== value.operations.length || value.operations.some(right => !['read', 'write', 'list'].includes(right)) ||
          (value.kind === 'file' && (value.operations.length !== 1 || value.operations[0] !== 'read')) ||
          (value.kind === 'save' && (value.operations.length !== 1 || value.operations[0] !== 'write')) ||
          (value.fileUrl !== undefined && (value.kind !== 'file' || typeof value.fileUrl !== 'string' ||
            value.fileUrl !== 'ztools://file/' + value.grantId + '/' + encodeURIComponent(value.displayName)))) throw new Error('invalid')
      return value
    } catch { throw this._error('FILE_ERROR', '宿主文件引用响应无效') }
  }
  async deriveRead(directory, name, options = {}) { return this._returnedReference((await this._directory('filesystem_derive_read', directory, name, 'read', options)).reference, ['file']) }
  async deriveSave(directory, name, options = {}) { return this._returnedReference((await this._directory('filesystem_derive_save', directory, name, 'write', options)).reference, ['save']) }
  async deriveDirectory(directory, name, options = {}) { return this._returnedReference((await this._directory('filesystem_derive_directory', directory, name, undefined, options)).reference, ['directory']) }
  async describe(ref, options = {}) {
    this._options(options, ['signal'])
    const result = await this._call('filesystem_describe', { grantId: this._reference(ref, ['file', 'directory']) }, options)
    if (typeof result.isDirectory !== 'boolean' || !Number.isSafeInteger(result.size) || result.size < 0 ||
        !Number.isSafeInteger(result.lastModifiedMs)) throw this._error('FILE_ERROR', '文件元数据响应无效')
    return result
  }
  async getFileSize(ref, options = {}) { return (await this.describe(ref, options)).size }
  async fileExists(ref, options = {}) { return !(await this.describe(ref, options)).isDirectory }
  async directoryExists(ref, options = {}) { return (await this.describe(ref, options)).isDirectory }
  async revoke(ref) { return this._call('filesystem_revoke', { grantId: this._reference(ref, ['file', 'directory', 'save']) }) }
  async getCurrentDirectory() {
    const reference = (await this._call('filesystem_get_current_directory', {})).reference
    return reference === null ? null : this._returnedReference(reference, ['directory'])
  }
  async setCurrentDirectory(directory, options = {}) {
    this._options(options, ['signal'])
    return this._call('filesystem_set_current_directory', { directoryGrantId: this._reference(directory, ['directory'], 'read') }, options)
  }
  _recoveryEntry(entry, inspected = false) {
    const fields = ['recoveryId', 'displayName', 'phase', 'createdAt', 'expectedBytes', ...(inspected ? ['observation', 'businessResult'] : [])]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== fields.length ||
        Object.keys(entry).some(key => !fields.includes(key)) || typeof entry.recoveryId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.recoveryId) ||
        typeof entry.displayName !== 'string' || !entry.displayName || /[\/\0]/.test(entry.displayName) ||
        new TextEncoder().encode(entry.displayName).length > 4096 || !['intent', 'staging', 'committing', 'unknown'].includes(entry.phase) ||
        !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 ||
        (entry.expectedBytes !== null && (!Number.isSafeInteger(entry.expectedBytes) || entry.expectedBytes < 0 || entry.expectedBytes > 2 * 1024 ** 3))) {
      throw this._error('FILE_ERROR', '写入恢复响应无效')
    }
    if (inspected) {
      const observation = entry.observation
      if (entry.businessResult !== 'unconfirmed' || !observation || typeof observation !== 'object' || Array.isArray(observation) ||
          Object.keys(observation).length !== 2 || !['unresolved', 'staging', 'committed-object'].includes(observation.state) ||
          (observation.reason === 'no-object-proof' ? observation.state !== 'unresolved' || Object.keys(observation).some(key => !['state', 'reason'].includes(key)) :
            Object.keys(observation).some(key => !['state', 'size'].includes(key)) || !Number.isSafeInteger(observation.size) || observation.size < 0)) {
        throw this._error('FILE_ERROR', '写入恢复观察结果无效')
      }
      return Object.freeze({ ...entry, observation: Object.freeze({ ...observation }) })
    }
    return Object.freeze({ ...entry })
  }
  async listWriteRecovery(options = {}) {
    this._options(options, ['signal'])
    const entries = (await this._call('filesystem_list_write_recovery', {}, options)).entries
    if (!Array.isArray(entries) || entries.length > 256) throw this._error('FILE_ERROR', '写入恢复记录超出上限')
    const ids = new Set()
    return Object.freeze(entries.map(entry => {
      const result = this._recoveryEntry(entry)
      if (ids.has(result.recoveryId)) throw this._error('FILE_ERROR', '写入恢复记录重复')
      ids.add(result.recoveryId)
      return result
    }))
  }
  async inspectWriteRecovery(recoveryId, options = {}) {
    this._options(options, ['signal'])
    if (typeof recoveryId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(recoveryId)) {
      throw this._error('INVALID_REQUEST', '写入恢复记录ID无效')
    }
    const entry = this._recoveryEntry((await this._call('filesystem_inspect_write_recovery', { recoveryId }, options)).entry, true)
    if (entry.recoveryId !== recoveryId) throw this._error('FILE_ERROR', '写入恢复记录ID不匹配')
    return entry
  }
  async readCache(name, options = {}) {
    this._options(options, ['signal'])
    const result = await this._call('filesystem_read_cache', { name: this._relative(name, false), encoding: 'utf8' }, options)
    if (typeof result.content !== 'string' || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > 16 * 1024 * 1024 ||
        new TextEncoder().encode(result.content).length > 16 * 1024 * 1024) throw this._error('FILE_ERROR', '缓存读取响应无效')
    return result.content
  }
  async readCacheAsBinary(name, options = {}) {
    this._options(options, ['signal'])
    const result = await this._call('filesystem_read_cache', { name: this._relative(name, false), encoding: 'base64' }, options)
    return this._decode(result.content, result.size).buffer
  }
  async writeCache(name, content, options = {}) {
    this._options(options, ['replace', 'signal'])
    const result = await this._call('filesystem_write_cache', { name: this._relative(name, false), ...this._content(content), replace: options.replace ?? false }, options)
    this._returnedReference(result.reference, ['file'])
    return result
  }
}

export default ReferenceFileSystemAPI
