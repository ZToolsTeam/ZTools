import { parseDownloadReference, parseUploadReference } from '../../contracts/path-transfer.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import type { NetworkService } from '../services/network-service.js'
import type { ReferenceHandler } from './reference-endpoint.js'

/** Native reference transfer handlers; no legacy path handler fallback. */
export function createReferenceNetworkHandlers(network: Pick<NetworkService, 'downloadRef' | 'uploadRef'>): {
  network_http_download: ReferenceHandler; network_http_upload: ReferenceHandler
} {
  async function transfer<T>(timeoutMs: number, signal: AbortSignal, mutating: boolean, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const deadline = new AbortController(), merged = AbortSignal.any([signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(errorCodes.requestTimeout), timeoutMs)
    try {
      if (merged.aborted) throw cancelled(merged.reason)
      const result = await work(merged)
      if (merged.aborted) throw mutating ? new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '下载提交后结果未交付') : cancelled(merged.reason)
      return result
    } finally { clearTimeout(timer) }
  }
  const cancelled = (reason: unknown) => new ZToolsError(reason === errorCodes.requestTimeout ? errorCodes.requestTimeout :
    reason === errorCodes.appStopping ? errorCodes.appStopping : errorCodes.callerDestroyed, '文件传输已取消')
  return {
    network_http_download: { execute: async (value: unknown, caller: CallerIdentity, signal: AbortSignal) => {
      const params = parseDownloadReference(value)
      return transfer(params.timeout!, signal, true, next => network.downloadRef(params, caller, next))
    } },
    network_http_upload: { execute: async (value: unknown, caller: CallerIdentity, signal: AbortSignal) => {
      const params = parseUploadReference(value)
      return transfer(params.timeout!, signal, false, next => network.uploadRef(params, caller, next))
    } }
  }
}
