import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { PathGrantService } from './path-grant-service.js'

export interface AnchoredDownloadOptions {
  response: Response
  owner: number
  saveGrantId: string
  grants: Pick<PathGrantService, 'streamSave'>
  signal: AbortSignal
  replace?: boolean
  maxBytes?: number
}

/** Persist a response already obtained through NetworkService's session/URL/redirect policy. */
export async function persistAnchoredDownload(options: AnchoredDownloadOptions): Promise<{
  success: true; grantId: string; size: number; statusCode: number; statusText: string
}> {
  const { response, owner, saveGrantId, grants, signal } = options
  const maximum = options.maxBytes ?? 1024 * 1024 * 1024
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 1024 * 1024 * 1024 ||
      (options.replace !== undefined && typeof options.replace !== 'boolean')) throw new ZToolsError(errorCodes.invalidRequest, '下载大小或覆盖选项无效')
  if (!response.body) throw new ZToolsError(errorCodes.networkError, '下载响应没有正文')
  const reader = response.body.getReader()
  let settled = false, bytes = 0, cancellation: Promise<void> | undefined
  const cancel = () => cancellation ??= Promise.resolve().then(() => reader.cancel())
  const onAbort = () => { void cancel().catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal.aborted) throw new ZToolsError(errorCodes.callerDestroyed, '下载已取消')
    if (response.status < 200 || response.status >= 300) throw new ZToolsError(errorCodes.networkError, '下载请求返回非成功HTTP状态')
    const header = response.headers.get('content-length')
    let expected: number | undefined
    if (header !== null) {
      if (!/^(0|[1-9]\d*)$/.test(header)) throw new ZToolsError(errorCodes.networkError, '下载响应长度无效')
      const declared = Number(header)
      if (!Number.isSafeInteger(declared) || declared > maximum) throw new ZToolsError(errorCodes.responseTooLarge, '下载文件超过大小上限')
      // Fetch may decode a compressed body while keeping its wire Content-Length.
      if ((response.headers.get('content-encoding') ?? 'identity').toLowerCase() === 'identity') expected = declared
    }
    async function* chunks(): AsyncGenerator<Buffer> {
      let emptyChunks = 0
      for (;;) {
        if (signal.aborted) throw new ZToolsError(errorCodes.callerDestroyed, '下载已取消')
        const part = await reader.read()
        if (part.done) { settled = true; break }
        if (!(part.value instanceof Uint8Array)) throw new ZToolsError(errorCodes.networkError, '下载响应片段无效')
        if (!part.value.byteLength) {
          if (++emptyChunks > 16) throw new ZToolsError(errorCodes.networkError, '下载响应没有有效数据进展')
          continue
        }
        emptyChunks = 0
        if (part.value.byteLength > maximum - bytes) throw new ZToolsError(errorCodes.responseTooLarge, '下载文件超过大小上限')
        bytes += part.value.byteLength
        // A producer may deliver a large chunk; slice it before taking a private immutable copy.
        for (let offset = 0; offset < part.value.byteLength; offset += 64 * 1024) {
          yield Buffer.from(part.value.subarray(offset, offset + 64 * 1024))
        }
      }
    }
    const result = await grants.streamSave(owner, saveGrantId, expected, chunks(), options.replace ?? false, signal)
    if (!settled || result.status !== 'committed' || result.bytesWritten !== bytes || signal.aborted) {
      throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '下载保存提交结果未确认；不能保证目标未改变')
    }
    return { success: true, grantId: saveGrantId, size: bytes, statusCode: response.status, statusText: response.statusText }
  } finally {
    signal.removeEventListener('abort', onAbort)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!settled || cancellation) await Promise.race([cancel(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ZToolsError(errorCodes.networkError, '下载响应停止未确认')), 5000)
      })])
    } finally { if (timer) clearTimeout(timer); reader.releaseLock() }
  }
}
