/** SDK2 transfer source. Non-file networking continues through the existing NetworkAPI. */
class ReferenceNetworkAPI extends NetworkAPI {
  constructor(transport) { super(transport); this.references = new ReferenceFileSystemAPI(transport) }
  _transferOptions(url, options, upload) {
    const refs = this.references
    refs._options(options, upload ? ['headers', 'fieldName', 'timeout', 'signal', 'onProgress'] : ['headers', 'replace', 'timeout', 'signal', 'onProgress'])
    let parsed
    try { parsed = new URL(url) } catch { throw refs._error('INVALID_REQUEST', '文件传输URL无效') }
    if (typeof url !== 'string' || new TextEncoder().encode(url).length > 8192 || /[\0\r\n]/.test(url) ||
        !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw refs._error('INVALID_REQUEST', '文件传输URL无效')
    const timeout = options.timeout ?? 120000
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw refs._error('INVALID_REQUEST', '文件传输超时范围无效')
    if (options.headers !== undefined) {
      if (!options.headers || typeof options.headers !== 'object' || Array.isArray(options.headers) || Object.keys(options.headers).length > 128) throw refs._error('INVALID_REQUEST', '文件传输headers无效')
      let bytes = 0
      for (const [key, value] of Object.entries(options.headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) || typeof value !== 'string' || /[\0\r\n]/.test(value) || new TextEncoder().encode(value).length > 8192) throw refs._error('INVALID_REQUEST', '文件传输headers无效')
        bytes += new TextEncoder().encode(key + value).length
        if (bytes > 64 * 1024) throw refs._error('INVALID_REQUEST', '文件传输headers超出上限')
      }
    }
    if (upload && options.fieldName !== undefined && (typeof options.fieldName !== 'string' || !options.fieldName || /[\0\r\n]/.test(options.fieldName) || new TextEncoder().encode(options.fieldName).length > 256)) throw refs._error('INVALID_REQUEST', '上传字段名无效')
    return { url: parsed.href, timeout, ...(options.headers !== undefined ? { headers: options.headers } : {}) }
  }
  async download(url, save, options = {}) {
    const params = this._transferOptions(url, options, false), refs = this.references
    const saveGrantId = refs._reference(save, ['save'], 'write')
    const result = await refs._call('network_http_download', { ...params, saveGrantId, replace: options.replace ?? false }, { signal: options.signal, timeout: params.timeout })
    if (Object.keys(result).some(key => !['success', 'grantId', 'size', 'statusCode', 'statusText'].includes(key)) || result.grantId !== saveGrantId ||
        !Number.isSafeInteger(result.size) || result.size < 0 || result.size > 1024 * 1024 * 1024 || !Number.isInteger(result.statusCode) ||
        result.statusCode < 200 || result.statusCode >= 300 || typeof result.statusText !== 'string') throw refs._error('FILE_WRITE_OUTCOME_UNKNOWN', '下载完成后的响应无法确认')
    options.onProgress?.(result.size, result.size)
    return result
  }
  async upload(url, file, options = {}) {
    const params = this._transferOptions(url, options, true), refs = this.references
    const result = await refs._call('network_http_upload', { ...params, fileGrantId: refs._reference(file, ['file'], 'read'), fieldName: options.fieldName ?? 'file' }, { signal: options.signal, timeout: params.timeout })
    if (Object.keys(result).some(key => !['success', 'data'].includes(key)) || !result.data || Object.keys(result.data).some(key => !['statusCode', 'statusText', 'body'].includes(key)) ||
        !Number.isInteger(result.data.statusCode) || result.data.statusCode < 200 || result.data.statusCode >= 300 || typeof result.data.statusText !== 'string' ||
        typeof result.data.body !== 'string' || new TextEncoder().encode(result.data.body).length > 16 * 1024 * 1024) throw refs._error('NETWORK_ERROR', '上传响应无效')
    options.onProgress?.(1, 1)
    return result
  }
}

export default ReferenceNetworkAPI
