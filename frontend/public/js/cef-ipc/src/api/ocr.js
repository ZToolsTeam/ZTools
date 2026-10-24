/**
 * OCR API - 文字识别
 * 只提供本地识别：recognizeLocal / getLocalLanguages（macOS 本地 Vision，不经过网络，不需要登录凭据）。
 * 云端识别（服务器识别接口，以及携带登录凭据经原生插件转发到云端的 getOrcRes / batchOcr）已移除。
 */
class OCRAPI {
  constructor(transport) {
    this.transport = transport
  }

  /** Contract 2: local Vision only; never routes through DLL/cloud/token code. */
  recognizeLocal(file, options = {}) {
    return (this._localAPI ??= new ReferenceOcrAPI(this.transport)).recognize(file, options)
  }
  getLocalLanguages(options = {}) {
    return (this._localAPI ??= new ReferenceOcrAPI(this.transport)).languages(options)
  }
}

// 导出类(不导出单例,由client.js实例化)
export default OCRAPI
