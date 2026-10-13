function clipboardBytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
/**
 * Clipboard API - 剪贴板操作
 * 提供剪贴板操作功能，类似 uTools API
 */
class ClipboardAPI {
  constructor(transport, events) {
    this.transport = transport
    this.events = events
    this.changeHandlers = new Map()
  }

  // ============ 复制操作 ============

  /**
   * 复制文本到剪贴板
   * 超过 200KB 的文本自动走临时文件传递，避免 CEF IPC 大数据崩溃
   * @param {string} text - 要复制的文本
   * @returns {Promise<boolean>}
   */
  async copyText(text, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      const refs = new ReferenceFileSystemAPI(this.transport)
      refs._options(options, ['signal'])
      if (typeof text === 'string' && new TextEncoder().encode(text).length > 8 * 1024 * 1024) throw refs._error('RESPONSE_TOO_LARGE', '剪贴板文本超过8MiB')
      await refs._call('clipboard_copy_text', typeof text === 'string' ? { text } : { fileGrantId: refs._reference(text, ['file'], 'read') }, options)
      return true
    }
    if (Object.keys(options).length) throw Object.assign(new Error('当前剪贴板合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
    const MAX_IPC_SIZE = 200 * 1024 // 200KB 阈值

    // 大文本：写入临时文件，只传文件路径
    if (text.length > MAX_IPC_SIZE && typeof window._writeFileArrayBuffer === 'function') {
      try {
        const tempPath = await this._getTempFilePath()
        const encoder = new TextEncoder()
        const byteArray = Array.from(encoder.encode(text))
        const ok = window._writeFileArrayBuffer(tempPath, byteArray)
        if (ok) {
          const r = await this.transport.call('clipboard_copy_text', { tempFile: tempPath })
          return r && r.success === true
        }
      } catch (e) {
        // 临时文件方案失败，回退到直接传输（可能崩溃，但至少尝试）
        console.warn('[clipboard.copyText] 临时文件方案失败，回退直接传输:', e)
      }
    }

    // 小文本或非 CEF 环境：直接传输
    const r = await this.transport.call('clipboard_copy_text', { text })
    return r && r.success === true
  }

  /**
   * 生成临时文件路径（用于大数据传输）
   * @returns {Promise<string>}
   * @private
   */
  async _getTempFilePath() {
    // 通过 system API 获取临时目录
    const r = await this.transport.call('system_get_path', { name: 'temp' })
    const tempDir = (r && r.success && r.path) ? r.path : 'C:\\Temp'
    return tempDir + '\\ztools_clipboard_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.tmp'
  }

  /**
   * 复制图片到剪贴板
   * @param {string} image - Base64 编码的图片
   * @returns {Promise<boolean>}
   */
  async copyImage(image, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      const refs = new ReferenceFileSystemAPI(this.transport)
      refs._options(options, ['signal'])
      if (typeof image === 'string' && new TextEncoder().encode(image).length > 700 * 1024) throw refs._error('FILE_TOO_LARGE', '大图请使用FileRef')
      await refs._call('clipboard_copy_image', typeof image === 'string' ? { image } : { fileGrantId: refs._reference(image, ['file'], 'read') }, options)
      return true
    }
    if (Object.keys(options).length) throw Object.assign(new Error('当前剪贴板合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
    const r = await this.transport.call('clipboard_copy_image', { image })
    return r && r.success === true
  }

  /**
   * 复制文件到剪贴板
   * @param {string} filePath - 文件路径
   * @returns {Promise<boolean>}
   */
  async copyFile(filePath) {
    const r = await this.transport.call('clipboard_copy_file', { filePath })
    return r && r.success === true
  }

  /**
   * 复制多个文件到剪贴板
   * @param {string[]} filePaths - 文件路径数组
   * @returns {Promise<boolean>}
   */
  async copyFiles(filePaths) {
    const r = await this.transport.call('clipboard_copy_files', { filePaths })
    return r && r.success === true
  }

  // ============ 读取操作 ============

  /**
   * 读取剪贴板文本
   * @returns {Promise<string>} 剪贴板文本内容
   */
  async readText(options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      const refs = new ReferenceFileSystemAPI(this.transport)
      refs._options(options, ['signal'])
      const result = await refs._call('clipboard_read_text', {}, options)
      if (typeof result.text !== 'string' || new TextEncoder().encode(result.text).length > 8 * 1024 * 1024) throw refs._error('RESPONSE_TOO_LARGE', '剪贴板文本响应无效')
      return result.text
    }
    if (Object.keys(options).length) throw Object.assign(new Error('当前剪贴板合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
    const r = await this.transport.call('clipboard_read_text', {})
    if (r && r.success && r.text !== undefined) {
      return r.text
    }
    return ''
  }

  /**
   * 读取剪贴板图片
   * @returns {Promise<string|object>} Base64编码的图片或临时文件对象
   */
  async readImageReference(options = {}) {
    const refs = new ReferenceFileSystemAPI(this.transport)
    refs._options(options, ['signal'])
    const result = await refs._call('clipboard_read_image', {}, options)
    if (result.useReference === false) {
      if (typeof result.image !== 'string' || (result.image !== '' && (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.image) || result.image.length > 700 * 1024))) throw refs._error('CLIPBOARD_ERROR', '剪贴板图片响应无效')
      return result.image
    }
    const reference = refs._returnedReference(result.reference, ['file'])
    try {
      if (result.useReference !== true || result.fileUrl !== 'ztools://file/' + reference.grantId + '/' + encodeURIComponent(reference.displayName) || !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 16 * 1024 * 1024 || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width <= 0 || result.height <= 0 || result.width * result.height > 32 * 1024 * 1024) throw refs._error('CLIPBOARD_ERROR', '剪贴板图片引用响应无效')
      let released
      return Object.freeze({ type: 'reference', reference: Object.freeze({ ...reference, operations: Object.freeze([...reference.operations]) }), fileUrl: result.fileUrl, size: result.size, width: result.width, height: result.height,
        release: () => released ??= refs.revoke(reference),
        toDataURL: async (readOptions = {}) => {
          refs._options(readOptions, ['signal'])
          if (released) throw refs._error('PERMISSION_DENIED', '图片引用已释放')
          const bytes = new Uint8Array(await refs.readFileAsBinary(reference, readOptions))
          return 'data:image/png;base64,' + clipboardBytesToBase64(bytes)
        }
      })
    } catch (error) { await refs.revoke(reference); throw error }
  }

  async readImage(options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      const result = await this.readImageReference(options)
      if (typeof result === 'string') return result
      try { return await result.toDataURL(options) }
      finally { await result.release() }
    }
    if (Object.keys(options).length) throw Object.assign(new Error('当前剪贴板合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
    const r = await this.transport.call('clipboard_read_image', {})
    if (r && r.success) {
      if (r.useTempFile) {
        // 大图片(大于2M)：返回临时文件对象
        return {
          type: 'file',
          path: r.tempFile,
          size: r.size,
          width: r.width,
          height: r.height,
          /**
           * 转换为可用的 blob URL
           * @returns {Promise<string>} Blob URL
           */
          toDataURL: async () => {
            // 通过 filesystem API 读取文件
            if (window.ztools && window.ztools.fs) {
              const binary = await window.ztools.fs.readFileAsBinary(r.tempFile)
              const blob = new Blob([binary], { type: 'image/png' })
              return URL.createObjectURL(blob)
            }
            throw new Error('filesystem API not available')
          }
        }
      } else {
        // 小图片：返回 Base64
        return r.image
      }
    }
    return ''
  }

  /**
   * 读取剪贴板文件列表
   * @returns {Promise<Array>} 文件路径数组
   */
  async readFilesDetailed(options = {}) {
    const refs = new ReferenceFileSystemAPI(this.transport)
    refs._options(options, ['signal'])
    const result = await refs._call('clipboard_read_files', {}, options), acquired = new Set()
    try {
      if (!Array.isArray(result.files) || result.files.length > 256 || !Array.isArray(result.errors) || result.errors.length > 256) throw refs._error('CLIPBOARD_ERROR', '文件剪贴板响应无效')
      const files = result.files.map(file => {
        const ref = refs._returnedReference(file, ['file', 'directory'])
        if (acquired.has(ref.grantId)) throw refs._error('CLIPBOARD_ERROR', '文件剪贴板引用重复')
        acquired.add(ref.grantId)
        if (ref.kind === 'directory' && (ref.operations.length !== 2 || !ref.operations.includes('read') || !ref.operations.includes('list'))) throw refs._error('CLIPBOARD_ERROR', '剪贴板目录权限无效')
        return Object.freeze({ ...ref, operations: Object.freeze([...ref.operations]) })
      })
      const errors = result.errors.map(error => {
        if (!error || typeof error !== 'object' || Object.keys(error).some(key => !['index', 'code', 'message'].includes(key)) || !Number.isSafeInteger(error.index) || error.index < 0 || error.index >= 256 || typeof error.code !== 'string' || error.code.length > 64 || typeof error.message !== 'string' || error.message.length > 2048) throw refs._error('CLIPBOARD_ERROR', '文件剪贴板错误响应无效')
        return Object.freeze({ ...error })
      })
      if (options.signal?.aborted) throw refs._error('CALLER_DESTROYED', '文件剪贴板请求已取消')
      return Object.freeze({ files: Object.freeze(files), errors: Object.freeze(errors) })
    } catch (error) { await Promise.all([...acquired].map(grantId => refs._call('filesystem_revoke', { grantId }))); throw error }
  }

  async readFiles(options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) return (await this.readFilesDetailed(options)).files
    if (Object.keys(options).length) throw Object.assign(new Error('当前剪贴板合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
    const r = await this.transport.call('clipboard_read_files', {})
    if (r && r.success && r.files) {
      return r.files
    }
    return []
  }

  // ============ 隐藏并粘贴/输入 ============

  /**
   * 隐藏主窗口并粘贴文本
   * @param {string} text - 要粘贴的文本
   * @returns {Promise<boolean>}
   */
  async hideAndPasteText(text) {
    const r = await this.transport.call('clipboard_hide_and_paste_text', {
      text
    })
    return r && r.success === true
  }

  /**
   * 隐藏主窗口并粘贴图片
   * @param {string} image - Base64 编码的图片
   * @returns {Promise<boolean>}
   */
  async hideAndPasteImage(image) {
    const r = await this.transport.call('clipboard_hide_and_paste_image', {
      image
    })
    return r && r.success === true
  }

  /**
   * 隐藏主窗口并粘贴文件
   * @param {string} filePath - 文件路径
   * @returns {Promise<boolean>}
   */
  async hideAndPasteFile(filePath) {
    const r = await this.transport.call('clipboard_hide_and_paste_file', {
      filePath
    })
    return r && r.success === true
  }

  /**
   * 隐藏主窗口并输入文本 (模拟键盘输入)
   * @param {string} text - 要输入的文本
   * @returns {Promise<boolean>}
   */
  async hideAndType(text) {
    const r = await this.transport.call('clipboard_hide_and_type', { text })
    return r && r.success === true
  }

  // ============ 便捷方法（别名） ============

  /**
   * 写入文本到剪贴板（copyText 的别名）
   * @param {string} text - 要写入的文本
   * @returns {Promise<boolean>}
   */
  async writeText(text, options = {}) {
    return await this.copyText(text, options)
  }

  /**
   * 清空剪贴板
   * @returns {Promise<boolean>}
   */
  async clear(options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      const refs = new ReferenceFileSystemAPI(this.transport)
      refs._options(options, ['signal']); await refs._call('clipboard_clear', {}, options); return true
    }
    if (Object.keys(options).length) throw Object.assign(new Error('当前剪贴板合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
    const r = await this.transport.call('clipboard_clear', {})
    return r && r.success === true
  }

  // ============ 剪贴板监控 ============

  /**
   * 监听剪贴板变化
   * @param {function} handler - 回调函数，接收事件对象
   * @returns {function} 取消监听的函数
   *
   * 事件对象格式：
   * {
   *   type: 'text' | 'image' | 'files',
   *   // 文本类型：
   *   text: string,
   *   hasData: boolean,
   *   size: number,
   *   // 图片类型：
   *   image: string (Base64),  // 小图片
   *   hasData: boolean,
   *   tempFile: string,         // 大图片临时文件路径
   *   width: number,
   *   height: number,
   *   size: number,
   *   format: string,
   *   // 文件类型：
   *   files: Array<string>
   * }
   */
  onChange(handler) {
    if (typeof handler !== 'function') {
      throw new Error('Handler must be a function')
    }

    const existing = this.changeHandlers.get(handler)
    if (existing) return existing.dispose
    const record = { wrapped: undefined, dispose: undefined }
    record.wrapped = (envelope) => {
      if (this.changeHandlers.get(handler) === record && envelope?.type === 'clipboard_change' && envelope.payload) handler(envelope.payload)
    }
    record.dispose = () => {
      if (this.changeHandlers.get(handler) !== record) return
      this.changeHandlers.delete(handler)
      this.events.off('clipboard_change', record.wrapped)
    }
    this.changeHandlers.set(handler, record)
    try { this.events.on('clipboard_change', record.wrapped) }
    catch (error) { this.changeHandlers.delete(handler); throw error }
    return record.dispose
  }

  /**
   * 取消监听剪贴板变化
   * @param {function} handler - 要取消的回调函数（可选）
   */
  offChange(handler) {
    if (handler !== undefined && typeof handler !== 'function') throw new TypeError('Handler must be a function')
    if (handler === undefined) { for (const record of [...this.changeHandlers.values()]) record.dispose() }
    else this.changeHandlers.get(handler)?.dispose()
  }
}

export default ClipboardAPI
