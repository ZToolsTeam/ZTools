import { Worker, type WorkerOptions } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { grantId } from '../../contracts/path-reference.js'
import type { ReferenceCacheService } from './reference-cache-service.js'
import type { PathGrantService } from './path-grant-service.js'
import { imageHeader, type ReferenceImageFactory } from './reference-image-service.js'
const cancelled = () => new ZToolsError(errorCodes.callerDestroyed, 'GIF生成已取消')
const invalid = () => new ZToolsError(errorCodes.invalidRequest, 'GIF生成参数无效')
/** read -> immutable normalized PNG frames -> bounded encoder worker -> actual exit -> SaveRef commit. */
export class ReferenceGifService {
  readonly #pending = new Map<number, { controller: AbortController; finished: Promise<void> }>()
  #stopped = false
  constructor(private readonly grants: Pick<PathGrantService, 'read' | 'save'>, private readonly images: Pick<ReferenceImageFactory, 'createFromBuffer'>,
    private readonly dependencies: { createWorker?: (file: URL, options: WorkerOptions) => Worker; timeoutMs?: number } = {}, private readonly cache?: Pick<ReferenceCacheService, 'writeGeneratedCacheFile' | 'revokeReference'>) {
    if (dependencies.timeoutMs !== undefined && (!Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1 || dependencies.timeoutMs > 30000)) throw invalid()
  }
  stop(): Promise<void> { this.#stopped = true; for (const item of this.#pending.values()) item.controller.abort(); return Promise.all([...this.#pending.values()].map(item => item.finished)).then(() => {}) }
  convert(value: unknown, caller: CallerIdentity, signal: AbortSignal) { return this.#convert(value, caller, signal, false) }
  preview(value: unknown, caller: CallerIdentity, signal: AbortSignal) { return this.#convert(value, caller, signal, true) }
  async #convert(value: unknown, caller: CallerIdentity, signal: AbortSignal, cacheOutput: boolean) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !['fileGrantIds', 'interval', 'loop', ...(cacheOutput ? [] : ['saveGrantId', 'replace'])].includes(key))) throw invalid()
    const params = value as Record<string, unknown>, interval = params.interval ?? 500, loop = params.loop ?? true
    if (!Array.isArray(params.fileGrantIds) || !params.fileGrantIds.length || params.fileGrantIds.length > 64 || !Number.isSafeInteger(interval) || Number(interval) < 10 || Number(interval) > 10000 || Number(interval) % 10 !== 0 || typeof loop !== 'boolean' || (params.replace !== undefined && typeof params.replace !== 'boolean')) throw invalid()
    const inputs = params.fileGrantIds.map(grantId), output = cacheOutput ? undefined : grantId(params.saveGrantId)
    if (cacheOutput && !this.cache) throw new ZToolsError(errorCodes.methodNotFound, 'GIF预览缓存尚未接线')
    if (this.#stopped || signal.aborted) throw cancelled()
    if (this.#pending.has(caller.webContentsId) || this.#pending.size >= 2) throw new ZToolsError(errorCodes.fileTooLarge, 'GIF生成正在处理中')
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]); let finish!: () => void
    this.#pending.set(caller.webContentsId, { controller, finished: new Promise<void>(resolve => { finish = resolve }) })
    const active = () => { if (this.#stopped || combined.aborted) throw cancelled() }
    try {
      const frames: Uint8Array[] = []; let originalBytes = 0, decodedPixels = 0, frameBytes = 0, width = 0, height = 0
      for (const input of inputs) {
        active(); const bytes = await this.grants.read(caller.webContentsId, input, '', 16 * 1024 * 1024, combined); active()
        originalBytes += bytes.length; const header = imageHeader(bytes); decodedPixels += header.width * header.height
        if (originalBytes > 16 * 1024 * 1024 || decodedPixels > 32 * 1024 * 1024) throw new ZToolsError(errorCodes.fileTooLarge, 'GIF源图片合计超过16MiB或32Mi像素')
        let image = this.images.createFromBuffer(bytes)
        if (image.isEmpty() || image.getSize().width !== header.width || image.getSize().height !== header.height) throw new ZToolsError(errorCodes.fileError, 'GIF源图片无法解码')
        const ratio = Math.min(1, 1024 / Math.max(header.width, header.height))
        if (ratio < 1) image = image.resize({ width: Math.max(1, Math.floor(header.width * ratio)), height: Math.max(1, Math.floor(header.height * ratio)), quality: 'best' })
        const size = image.getSize(); width = Math.max(width, size.width); height = Math.max(height, size.height)
        if (![size.width, size.height].every(v => Number.isSafeInteger(v) && v > 0 && v <= 1024) || width * height * inputs.length > 4 * 1024 * 1024) throw new ZToolsError(errorCodes.fileTooLarge, 'GIF画布合计超过4Mi像素；请减少帧数或缩小源图片')
        const png = image.toPNG({ scaleFactor: 1 }); frameBytes += png.length
        if (frameBytes > 16 * 1024 * 1024 || imageHeader(png).format !== 'png') throw new ZToolsError(errorCodes.fileTooLarge, 'GIF编码帧超过16MiB或格式无效')
        frames.push(Uint8Array.from(png)); await new Promise<void>(resolve => setImmediate(resolve)); active()
      }
      const worker = (this.dependencies.createWorker ?? ((file, options) => new Worker(file, options)))(new URL('../workers/gif-worker.js', pathToFileURL(__filename)), {
        workerData: { frames, width, height, interval, loop }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 }
      })
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        let received = false, outcome: unknown, failure: ZToolsError | undefined
        const terminate = () => { void worker.terminate().catch(() => { failure ??= new ZToolsError(errorCodes.fileError, 'GIF worker停止未确认') }) }
        const abort = () => { failure ??= cancelled(); terminate() }
        const timer = setTimeout(() => { failure ??= new ZToolsError(errorCodes.requestTimeout, 'GIF编码超时'); terminate() }, this.dependencies.timeoutMs ?? 15000)
        combined.addEventListener('abort', abort, { once: true })
        worker.on('message', message => { if (received) { failure ??= new ZToolsError(errorCodes.fileError, 'GIF worker响应重复'); terminate() } else { received = true; outcome = message } })
        worker.on('error', () => { failure ??= new ZToolsError(errorCodes.fileError, 'GIF worker执行失败'); terminate() })
        worker.once('exit', code => {
          clearTimeout(timer); combined.removeEventListener('abort', abort)
          try {
            if (failure) throw failure; active()
            if (code !== 0 || !received) throw new ZToolsError(errorCodes.fileError, 'GIF worker退出未产生结果')
            const result = outcome as { success?: unknown; bytes?: unknown; error?: { code?: unknown } }
            if (result?.success !== true || !(result.bytes instanceof Uint8Array)) throw new ZToolsError(result?.error?.code === errorCodes.fileTooLarge ? errorCodes.fileTooLarge : errorCodes.fileError, 'GIF编码未成功')
            const encoded = Buffer.from(result.bytes)
            if (encoded.length < 14 || encoded.length > 16 * 1024 * 1024 || encoded.toString('ascii', 0, 6) !== 'GIF89a' || encoded.at(-1) !== 0x3b || encoded.readUInt16LE(6) !== width || encoded.readUInt16LE(8) !== height) throw new ZToolsError(errorCodes.fileError, 'GIF生成结果无效')
            resolve(encoded)
          } catch (error) { reject(error) }
        })
        if (combined.aborted) abort()
      })
      active()
      if (cacheOutput) {
        const generated = await this.cache!.writeGeneratedCacheFile(bytes, caller, 'gif', combined)
        if (this.#stopped || combined.aborted) { await this.cache!.revokeReference(generated.reference, caller); throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, 'GIF预览缓存已写入但结果未交付') }
        return { ...generated, frameCount: inputs.length, width, height }
      }
      if (!output) throw invalid()
      const receipt = await this.grants.save(caller.webContentsId, output, bytes, params.replace === true, combined)
      if (receipt.status !== 'committed' || receipt.bytesWritten !== bytes.length || this.#stopped || combined.aborted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, 'GIF保存结果未确认')
      return { success: true as const, status: 'committed' as const, size: receipt.bytesWritten, frameCount: inputs.length, width, height }
    } catch (error) { if (error instanceof ZToolsError) throw error; if (combined.aborted || this.#stopped) throw cancelled(); throw new ZToolsError(errorCodes.fileError, 'GIF生成失败') }
    finally { this.#pending.delete(caller.webContentsId); finish() }
  }
}
