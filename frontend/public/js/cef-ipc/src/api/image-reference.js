/** Shared Electron PNG/JPEG operations using FileRef/SaveRef; advanced image methods await their provider. */
class ReferenceImageAPI extends ReferenceFileSystemAPI {
  async previewGIF(images, options = {}) {
    this._options(options, ['signal', 'interval', 'loop'])
    const interval = options.interval ?? 500, loop = options.loop ?? true
    if (!Array.isArray(images) || !images.length || images.length > 64 || !Number.isSafeInteger(interval) || interval < 10 || interval > 10000 || interval % 10 !== 0 || typeof loop !== 'boolean') throw this._error('INVALID_REQUEST', 'GIF预览图片或间隔无效')
    const result = await this._call('image_preview_gif', { fileGrantIds: images.map(input => this._reference(input, ['file'], 'read')), interval, loop }, { signal: options.signal })
    const reference = this._returnedReference(result.reference, ['file'])
    try {
      if (result.frameCount !== images.length || result.fileUrl !== 'ztools://file/' + reference.grantId + '/' + encodeURIComponent(reference.displayName) || !Number.isSafeInteger(result.size) || result.size < 14 || result.size > 16 * 1024 * 1024 || ![result.width, result.height].every(size => Number.isSafeInteger(size) && size > 0 && size <= 1024) || result.width * result.height * images.length > 4 * 1024 * 1024) throw this._error('FILE_ERROR', 'GIF预览响应无效')
      return Object.freeze({ reference: Object.freeze({ ...reference, operations: Object.freeze([...reference.operations]) }), fileUrl: result.fileUrl, size: result.size, frameCount: result.frameCount, width: result.width, height: result.height })
    } catch (error) { await this.revoke(reference); throw error }
  }
  async imagesToGIF(images, output, options = {}) {
    this._options(options, ['replace', 'signal', 'interval', 'loop'])
    const interval = options.interval ?? 500, loop = options.loop ?? true
    if (!Array.isArray(images) || !images.length || images.length > 64 || !Number.isSafeInteger(interval) || interval < 10 || interval > 10000 || interval % 10 !== 0 || typeof loop !== 'boolean' || (options.replace !== undefined && typeof options.replace !== 'boolean')) throw this._error('INVALID_REQUEST', 'GIF输入图片或间隔无效')
    const result = await this._call('image_to_gif', { fileGrantIds: images.map(input => this._reference(input, ['file'], 'read')), saveGrantId: this._reference(output, ['save'], 'write'), interval, loop, replace: options.replace ?? false }, { signal: options.signal })
    if (result.status !== 'committed' || result.frameCount !== images.length || !Number.isSafeInteger(result.size) || result.size < 14 || result.size > 16 * 1024 * 1024 || ![result.width, result.height].every(size => Number.isSafeInteger(size) && size > 0 && size <= 1024) || result.width * result.height * images.length > 4 * 1024 * 1024) throw this._error('FILE_WRITE_OUTCOME_UNKNOWN', 'GIF保存结果未确认')
    return Object.freeze({ status: result.status, size: result.size, frameCount: result.frameCount, width: result.width, height: result.height })
  }
  async imagesToPDF(images, output, options = {}) {
    this._options(options, ['replace', 'signal'])
    if (!Array.isArray(images) || !images.length || images.length > 64 || (options.replace !== undefined && typeof options.replace !== 'boolean')) throw this._error('INVALID_REQUEST', 'PDF输入图片列表无效')
    const result = await this._call('image_to_pdf', { fileGrantIds: images.map(input => this._reference(input, ['file'], 'read')),
      saveGrantId: this._reference(output, ['save'], 'write'), replace: options.replace ?? false }, options)
    if (!result || result.success !== true || result.status !== 'committed' || result.pageCount !== images.length ||
        !Number.isSafeInteger(result.size) || result.size < 8 || result.size > 16 * 1024 * 1024) throw this._error('FILE_WRITE_OUTCOME_UNKNOWN', 'PDF保存结果未确认')
    return Object.freeze({ status: result.status, size: result.size, pageCount: result.pageCount })
  }
  async preview(input, operation, params = {}, options = {}) {
    this._options(options, ['format', 'quality', 'signal'])
    const fields = operation === 'resize' ? ['width', 'height', 'keepAspectRatio'] : operation === 'scale' ? ['scaleX', 'scaleY'] :
      operation === 'crop' ? ['rect'] : operation === 'rotate' ? ['angle'] : operation === 'flip' ? ['direction'] : []
    if (!['convert', 'compress', 'resize', 'scale', 'crop', 'rotate', 'flip'].includes(operation) ||
        !params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !fields.includes(key))) {
      throw this._error('INVALID_REQUEST', '图片预览参数无效')
    }
    const format = options.format ?? 'png'
    if (!['png', 'jpg'].includes(format) || (options.quality !== undefined && (!Number.isSafeInteger(options.quality) || options.quality < 1 || options.quality > 100))) {
      throw this._error('INVALID_REQUEST', '图片预览格式或质量无效')
    }
    const result = await this._call('image_preview', { fileGrantId: this._reference(input, ['file'], 'read'), operation, ...params,
      format, ...(options.quality !== undefined ? { quality: options.quality } : {}) }, options)
    this._imageResult(result)
    this._returnedReference({ ...result.reference, fileUrl: result.fileUrl }, ['file'])
    if (!Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 16 * 1024 * 1024) throw this._error('FILE_ERROR', '图片预览响应无效')
    return Object.freeze({ reference: Object.freeze({ ...result.reference }), fileUrl: result.fileUrl, size: result.size,
      width: result.width, height: result.height, format: result.format })
  }
  async imageToBase64(input, options = {}) {
    this._options(options, ['signal'])
    const result = await this._call('image_encode_base64', { fileGrantId: this._reference(input, ['file'], 'read') }, options)
    this._returnedReference({ ...result.reference, fileUrl: result.fileUrl }, ['file'])
    if (!['image/png', 'image/jpeg'].includes(result.mimeType) || !Number.isSafeInteger(result.size) ||
        result.size <= 0 || result.size > 16 * 1024 * 1024) throw this._error('FILE_ERROR', 'Base64编码响应无效')
    return Object.freeze({ reference: Object.freeze({ ...result.reference }), fileUrl: result.fileUrl, mimeType: result.mimeType, size: result.size })
  }
  async base64ToImage(input, output, format, options = {}) {
    this._options(options, ['quality', 'replace', 'signal'])
    if (options.quality !== undefined && (!Number.isSafeInteger(options.quality) || options.quality < 1 || options.quality > 100)) {
      throw this._error('INVALID_REQUEST', 'JPEG质量须为1到100')
    }
    const result = await this._call('image_decode_base64', { fileGrantId: this._reference(input, ['file'], 'read'),
      saveGrantId: this._reference(output, ['save'], 'write'), format: this._format(output, format),
      replace: options.replace ?? false, ...(options.quality !== undefined ? { quality: options.quality } : {}) }, options)
    this._imageResult(result)
    if (result.status !== 'committed' || !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 16 * 1024 * 1024) {
      throw this._error('FILE_WRITE_OUTCOME_UNKNOWN', '图片保存收据无效，请核实目标文件')
    }
    return Object.freeze({ status: result.status, width: result.width, height: result.height, format: result.format, size: result.size })
  }
  async getInfo(input, options = {}) {
    this._options(options, ['signal'])
    const result = await this._call('image_get_info', { fileGrantId: this._reference(input, ['file'], 'read') }, options)
    this._imageResult(result)
    return Object.freeze({ width: result.width, height: result.height, format: result.format })
  }
  _imageResult(result) {
    if (!Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width <= 0 || result.height <= 0 ||
        result.width > 8192 || result.height > 8192 || result.width * result.height > 8 * 1024 * 1024 || !['png', 'jpg'].includes(result.format)) {
      throw this._error('FILE_ERROR', '图片处理响应无效')
    }
  }
  _format(output, explicit) {
    const format = explicit ?? (/\.jpe?g$/i.test(output?.displayName ?? '') ? 'jpg' : /\.png$/i.test(output?.displayName ?? '') ? 'png' : null)
    if (!['png', 'jpg'].includes(format)) throw this._error('INVALID_REQUEST', '请明确选择PNG或JPEG输出格式')
    return format
  }
  async _transform(operation, input, output, params, options) {
    this._options(options, ['format', 'replace', 'quality', 'keepAspectRatio', 'signal'])
    if (options.quality !== undefined && (!Number.isSafeInteger(options.quality) || options.quality < 1 || options.quality > 100)) {
      throw this._error('INVALID_REQUEST', 'JPEG质量须为1到100')
    }
    const result = await this._call('image_transform', { operation,
      fileGrantId: this._reference(input, ['file'], 'read'), saveGrantId: this._reference(output, ['save'], 'write'),
      format: this._format(output, options.format), replace: options.replace ?? false,
      ...(options.quality !== undefined ? { quality: options.quality } : {}), ...params }, options)
    this._imageResult(result)
    if (result.status !== 'committed' || !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 16 * 1024 * 1024) {
      throw this._error('FILE_WRITE_OUTCOME_UNKNOWN', '图片保存收据无效，请核实目标文件')
    }
    return Object.freeze({ status: result.status, width: result.width, height: result.height, format: result.format, size: result.size })
  }
  async convert(input, output, format, quality = 85, options = {}) {
    this._options(options, ['replace', 'signal'])
    return this._transform('convert', input, output, {}, { ...options, format, quality })
  }
  async resize(input, output, width, height, options = {}) {
    this._options(options, ['format', 'replace', 'quality', 'keepAspectRatio', 'signal'])
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192 ||
        width * height > 8 * 1024 * 1024 || (options.keepAspectRatio !== undefined && typeof options.keepAspectRatio !== 'boolean')) {
      throw this._error('INVALID_REQUEST', '图片缩放尺寸无效')
    }
    return this._transform('resize', input, output, { width, height, keepAspectRatio: options.keepAspectRatio ?? true }, options)
  }
  async scale(input, output, scaleX, scaleY = scaleX, options = {}) {
    this._options(options, ['format', 'replace', 'quality', 'signal'])
    if ([scaleX, scaleY].some(scale => typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.1 || scale > 5)) {
      throw this._error('INVALID_REQUEST', '图片缩放比例须为0.1到5')
    }
    return this._transform('scale', input, output, { scaleX, scaleY }, options)
  }
  async crop(input, output, rect, options = {}) {
    this._options(options, ['format', 'replace', 'quality', 'signal'])
    if (!rect || typeof rect !== 'object' || Array.isArray(rect) || Object.keys(rect).length !== 4 ||
        Object.keys(rect).some(key => !['x', 'y', 'width', 'height'].includes(key)) ||
        ['x', 'y', 'width', 'height'].some(key => !Number.isSafeInteger(rect[key])) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) {
      throw this._error('INVALID_REQUEST', '图片裁剪范围无效')
    }
    return this._transform('crop', input, output, { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }, options)
  }
  async rotate(input, output, angle, options = {}) {
    this._options(options, ['format', 'replace', 'quality', 'signal'])
    if (typeof angle !== 'number' || !Number.isFinite(angle) || Math.abs(angle) > 36000) throw this._error('INVALID_REQUEST', '图片旋转角度无效')
    return this._transform('rotate', input, output, { angle }, options)
  }
  async flip(input, output, direction = 'horizontal', options = {}) {
    this._options(options, ['format', 'replace', 'quality', 'signal'])
    if (!['horizontal', 'vertical'].includes(direction)) throw this._error('INVALID_REQUEST', '图片翻转方向无效')
    return this._transform('flip', input, output, { direction }, options)
  }
  async compress(input, output, quality = 85, options = {}) {
    this._options(options, ['replace', 'signal'])
    return this._transform('compress', input, output, {}, { ...options, format: 'jpg', quality })
  }
}
export default ReferenceImageAPI
