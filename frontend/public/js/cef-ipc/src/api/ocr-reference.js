class ReferenceOcrAPI extends ReferenceFileSystemAPI {
  _common(result) {
    if (result.provider !== 'apple-vision-local' || !Number.isSafeInteger(result.revision) || result.revision < 1) throw this._error('FILE_ERROR', '本地OCR结果无效')
  }
  _languages(value, maximum) {
    if (!Array.isArray(value) || value.length > maximum || value.some(v => typeof v !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(v)) || new Set(value).size !== value.length) throw this._error('INVALID_REQUEST', '本地OCR语言无效')
    return [...value]
  }
  async languages(options = {}) {
    this._options(options, ['signal'])
    const result = await this._call('ocr_local_languages', {}, options); this._common(result)
    const languages = this._languages(result.languages, 256)
    if (!languages.length) throw this._error('FILE_ERROR', '本地OCR未提供语言')
    return Object.freeze({ provider: result.provider, revision: result.revision, languages: Object.freeze(languages) })
  }
  async recognize(file, options = {}) {
    this._options(options, ['languages', 'signal'])
    const languages = this._languages(options.languages ?? [], 8)
    const result = await this._call('ocr_recognize_reference', { fileGrantId: this._reference(file, ['file'], 'read'), languages }, { signal: options.signal, timeout: 35000 })
    this._common(result)
    if (!Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width < 1 || result.height < 1 || result.width > 8192 || result.height > 8192 || result.width * result.height > 8 * 1024 * 1024 || typeof result.text !== 'string' || new TextEncoder().encode(result.text).length > 1024 * 1024 || !Array.isArray(result.lines) || result.lines.length > 10000) throw this._error('FILE_ERROR', '本地OCR结果无效')
    let bytes = 0
    const lines = result.lines.map(line => {
      if (!line || typeof line.text !== 'string' || typeof line.confidence !== 'number' || !Number.isFinite(line.confidence) || line.confidence < 0 || line.confidence > 1 || !Array.isArray(line.box) || line.box.length !== 4 || line.box.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) || line.box[0] + line.box[2] > 1.00001 || line.box[1] + line.box[3] > 1.00001) throw this._error('FILE_ERROR', '本地OCR行无效')
      bytes += new TextEncoder().encode(line.text).length + 1; if (bytes > 1024 * 1024) throw this._error('FILE_ERROR', '本地OCR文字过多')
      return Object.freeze({ text: line.text, confidence: line.confidence, box: Object.freeze([...line.box]) })
    })
    if (lines.map(v => v.text).join('\n') !== result.text) throw this._error('FILE_ERROR', '本地OCR文字不一致')
    return Object.freeze({ provider: result.provider, revision: result.revision, width: result.width, height: result.height, text: result.text, lines: Object.freeze(lines) })
  }
}
export default ReferenceOcrAPI
