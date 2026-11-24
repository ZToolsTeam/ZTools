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
      (options.replace !== undefined && typeof options.replace !== 'boolean')) throw new ZToolsError(errorCodes.invalidRequest, 'Invalid download size limit or replace option')
  if (!response.body) throw new ZToolsError(errorCodes.networkError, 'Download response has no body')
  const reader = response.body.getReader()
  let settled = false, bytes = 0, cancellation: Promise<void> | undefined
  const cancel = () => cancellation ??= Promise.resolve().then(() => reader.cancel())
  const onAbort = () => { void cancel().catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal.aborted) throw new ZToolsError(errorCodes.callerDestroyed, 'Download cancelled')
    if (response.status < 200 || response.status >= 300) throw new ZToolsError(errorCodes.networkError, 'Download request returned a non-success HTTP status')
    const header = response.headers.get('content-length')
    let expected: number | undefined
    if (header !== null) {
      if (!/^(0|[1-9]\d*)$/.test(header)) throw new ZToolsError(errorCodes.networkError, 'Invalid download Content-Length header')
      const declared = Number(header)
      if (!Number.isSafeInteger(declared) || declared > maximum) throw new ZToolsError(errorCodes.responseTooLarge, 'Download file exceeds size limit')
      // Fetch may decode a compressed body while keeping its wire Content-Length.
      if ((response.headers.get('content-encoding') ?? 'identity').toLowerCase() === 'identity') expected = declared
    }
    async function* chunks(): AsyncGenerator<Buffer> {
      let emptyChunks = 0
      for (;;) {
        if (signal.aborted) throw new ZToolsError(errorCodes.callerDestroyed, 'Download cancelled')
        const part = await reader.read()
        if (part.done) { settled = true; break }
        if (!(part.value instanceof Uint8Array)) throw new ZToolsError(errorCodes.networkError, 'Invalid download response chunk')
        if (!part.value.byteLength) {
          if (++emptyChunks > 16) throw new ZToolsError(errorCodes.networkError, 'Download stream made no progress')
          continue
        }
        emptyChunks = 0
        if (part.value.byteLength > maximum - bytes) throw new ZToolsError(errorCodes.responseTooLarge, 'Download file exceeds size limit')
        bytes += part.value.byteLength
        // A producer may deliver a large chunk; slice it before taking a private immutable copy.
        for (let offset = 0; offset < part.value.byteLength; offset += 64 * 1024) {
          yield Buffer.from(part.value.subarray(offset, offset + 64 * 1024))
        }
      }
    }
    const result = await grants.streamSave(owner, saveGrantId, expected, chunks(), options.replace ?? false, signal)
    if (!settled || result.status !== 'committed' || result.bytesWritten !== bytes || signal.aborted) {
      throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, 'Download save commit could not be confirmed; target state is unknown')
    }
    return { success: true, grantId: saveGrantId, size: bytes, statusCode: response.status, statusText: response.statusText }
  } finally {
    signal.removeEventListener('abort', onAbort)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!settled || cancellation) await Promise.race([cancel(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ZToolsError(errorCodes.networkError, 'Download stream cancellation was not confirmed')), 5000)
      })])
    } finally { if (timer) clearTimeout(timer); reader.releaseLock() }
  }
}
