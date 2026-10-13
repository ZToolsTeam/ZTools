/** SDK2 source; activated together with every file consumer and the Main/preload contract. */
class ReferenceWindowAPI extends WindowAPI {
  constructor(transport) { super(transport); this.references = new ReferenceFileSystemAPI(transport) }
  async _showReferenceDialog(method, params, options, mode) {
    const refs = this.references
    refs._options(options, ['signal'])
    refs._options(params, mode === 'open' ? ['title', 'filters', 'properties'] : mode === 'save' ? ['title', 'filters', 'defaultName'] : ['title', 'access'])
    for (const key of ['title', 'filters', 'defaultName']) if (params[key] !== undefined && (typeof params[key] !== 'string' ||
        params[key].includes('\0') || new TextEncoder().encode(params[key]).length > 4096)) throw refs._error('INVALID_REQUEST', '文件选择提示无效')
    if (params.defaultName !== undefined) { refs._relative(params.defaultName, false); if (params.defaultName.includes('/')) throw refs._error('INVALID_REQUEST', '保存名称只能有一个文件名') }
    if (params.properties !== undefined && (!Array.isArray(params.properties) || !params.properties.length || params.properties.length > 3 ||
        new Set(params.properties).size !== params.properties.length || params.properties.some(item => !['openFile', 'openDirectory', 'multiSelections'].includes(item)))) {
      throw refs._error('INVALID_REQUEST', '文件选择类型无效')
    }
    if (params.access !== undefined && !['read', 'read-write'].includes(params.access)) throw refs._error('INVALID_REQUEST', '目录授权范围无效')
    const result = await refs._call(method, params, { ...options, timeout: Infinity })
    if (Object.keys(result).some(key => !['success', 'canceled', 'references'].includes(key)) || typeof result.canceled !== 'boolean' ||
        !Array.isArray(result.references) || result.references.length > 64 || (result.canceled && result.references.length)) throw refs._error('FILE_ERROR', '文件选择响应无效')
    for (const reference of result.references) refs._returnedReference(reference, mode === 'save' ? ['save'] : mode === 'folder' ? ['directory'] : ['file', 'directory'])
    return result
  }
  showOpenDialog(params = {}, options = {}) { return this._showReferenceDialog('window_show_open_dialog', params, options, 'open') }
  showSaveDialog(params = {}, options = {}) { return this._showReferenceDialog('window_show_save_dialog', params, options, 'save') }
  showSelectFolderDialog(params = {}, options = {}) { return this._showReferenceDialog('window_show_select_folder_dialog', params, options, 'folder') }
}

class ReferenceClipboardAPI extends ClipboardAPI {
  constructor(transport, events) { super(transport, events); this.references = new ReferenceFileSystemAPI(transport); this.referenceHandlers = new Map() }
  _getTempFilePath() { return Promise.reject(this.references._error('NOT_SUPPORTED', '文件引用SDK不返回临时路径')) }
  async copyText(textOrFile, options = {}) {
    const refs = this.references; refs._options(options, ['signal'])
    const params = typeof textOrFile === 'string' ? { text: textOrFile } : { fileGrantId: refs._reference(textOrFile, ['file'], 'read') }
    if (params.text !== undefined && new TextEncoder().encode(params.text).length > 8 * 1024 * 1024) throw refs._error('FILE_TOO_LARGE', '剪贴板文本超过8MiB')
    return refs._call('clipboard_copy_text', params, options)
  }
  async readFiles(options = {}) {
    const refs = this.references; refs._options(options, ['signal'])
    const result = await refs._call('clipboard_read_files', {}, options)
    return this._fileResult(result)
  }
  _fileResult(result) {
    const refs = this.references
    if (Object.keys(result).some(key => !['success', 'files', 'errors'].includes(key)) || !Array.isArray(result.files) || result.files.length > 256 ||
        !Array.isArray(result.errors) || result.errors.length > 256) throw refs._error('FILE_ERROR', '文件剪贴板响应无效')
    for (const file of result.files) refs._returnedReference(file, ['file', 'directory'])
    for (const error of result.errors) if (!error || Object.keys(error).some(key => !['index', 'code', 'message'].includes(key)) || !Number.isInteger(error.index) || typeof error.code !== 'string' || typeof error.message !== 'string') throw refs._error('FILE_ERROR', '文件剪贴板错误响应无效')
    return result
  }
  onChange(handler) {
    const refs = this.references
    if (window.__ztoolsElectron?.contractVersion !== 2 || !this.events) throw refs._error('NOT_SUPPORTED', '文件引用事件宿主不可用')
    if (typeof handler !== 'function') throw refs._error('INVALID_REQUEST', '剪贴板事件处理器无效')
    if (this.referenceHandlers.size >= 256 && !this.referenceHandlers.has(handler)) throw refs._error('PERMISSION_DENIED', '剪贴板事件处理器超过上限')
    if (!this.referenceHandlers.has(handler)) {
      const wrapped = envelope => {
        if (envelope?.type !== 'clipboard_change' || !envelope.payload) return
        const payload = envelope.payload
        if (payload.type === 'files') {
          if (payload.contractVersion !== 2 || Object.keys(payload).some(key => !['contractVersion', 'type', 'files', 'errors', 'hasData'].includes(key)) ||
              typeof payload.hasData !== 'boolean') throw refs._error('FILE_ERROR', '文件剪贴板事件契约无效')
          this._fileResult({ success: true, files: payload.files, errors: payload.errors })
          if (payload.hasData !== (payload.files.length > 0)) throw refs._error('FILE_ERROR', '文件剪贴板事件状态无效')
        }
        handler(payload)
      }
      this.events.on('clipboard_change', wrapped)
      this.referenceHandlers.set(handler, wrapped)
    }
    let active = true
    return () => { if (active) { active = false; this.offChange(handler) } }
  }
  offChange(handler) {
    const handlers = handler === undefined ? [...this.referenceHandlers.keys()] : [handler]
    for (const original of handlers) {
      const wrapped = this.referenceHandlers.get(original)
      if (wrapped) { this.events.off('clipboard_change', wrapped); this.referenceHandlers.delete(original) }
    }
  }
  async readImage(options = {}) {
    const refs = this.references; refs._options(options, ['signal'])
    const result = await refs._call('clipboard_read_image', {}, options)
    if (result.useReference === true) return referenceImageResult(refs, result, true)
    if (result.useReference !== false || Object.keys(result).some(key => !['success', 'useReference', 'image'].includes(key)) ||
        typeof result.image !== 'string') throw refs._error('FILE_ERROR', '图片剪贴板响应无效')
    if (result.image) {
      const prefix = 'data:image/png;base64,'
      if (!result.image.startsWith(prefix)) throw refs._error('FILE_ERROR', '图片数据响应无效')
      const content = result.image.slice(prefix.length)
      const size = Math.floor(content.length / 4) * 3 - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0)
      if (size > 512 * 1024) throw refs._error('FILE_ERROR', '直接图片数据超出上限')
      refs._decode(content, size)
    }
    return result
  }
  async copyFile(file, options = {}) { this.references._options(options, ['signal']); return this.references._call('clipboard_copy_file', { fileGrantId: this.references._reference(file, ['file'], 'read') }, options) }
  async copyFiles(files, options = {}) {
    this.references._options(options, ['signal'])
    if (!Array.isArray(files) || !files.length || files.length > 256) return Promise.reject(this.references._error('INVALID_REQUEST', '文件剪贴板数量无效'))
    return this.references._call('clipboard_copy_files', { fileGrantIds: files.map(file => this.references._reference(file, ['file'], 'read')) }, options)
  }
  hideAndPasteFile() { return Promise.reject(this.references._error('NOT_SUPPORTED', '引用文件粘贴消费者尚未接线')) }
}

function referenceImageResult(refs, result, clipboard = false) {
  if (Object.keys(result).some(key => !['success', 'reference', 'fileUrl', 'size', 'width', 'height', ...(clipboard ? ['useReference'] : [])].includes(key)) ||
      !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width <= 0 || result.height <= 0 ||
      result.width * result.height > 32 * 1024 * 1024 || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > 16 * 1024 * 1024 ||
      typeof result.fileUrl !== 'string') throw refs._error('FILE_ERROR', '图片引用响应无效')
  refs._returnedReference({ ...result.reference, fileUrl: result.fileUrl }, ['file'])
  return result
}
class ReferenceScreenAPI extends ScreenAPI {
  constructor(transport) { super(transport); this.references = new ReferenceFileSystemAPI(transport) }
  async capture(params = {}, options = {}) {
    this.references._options(options, ['signal'])
    this.references._options(params, ['rect'])
    return referenceImageResult(this.references, await this.references._call('screen_capture', params, options))
  }
  captureFullScreen(options = {}) { return this.capture({}, options) }
  captureRegion(x, y, width, height, options = {}) { return this.capture({ rect: { x, y, width, height } }, options) }
}

export { ReferenceWindowAPI, ReferenceClipboardAPI, ReferenceScreenAPI }
