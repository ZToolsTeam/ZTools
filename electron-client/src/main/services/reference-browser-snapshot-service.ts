import { pathToFileURL } from 'node:url'
import { Worker, type WorkerOptions } from 'node:worker_threads'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { parseBrowserSnapshot, validateBrowserSnapshotBytes, validateBrowserSnapshotResult, type BrowserSnapshotResult } from '../../contracts/browser-snapshot.js'
import type { PathGrantService } from './path-grant-service.js'
const cancelled = () => new ZToolsError(errorCodes.callerDestroyed, 'SQLite快照读取已取消')
/** Native read -> bounded immutable bytes -> private WASM worker -> actual thread exit -> public rows. */
export class ReferenceBrowserSnapshotService {
  readonly #pending = new Map<number, { controller: AbortController; finished: Promise<void> }>()
  #stopped = false
  constructor(private readonly grants: Pick<PathGrantService, 'read'>, private readonly dependencies: { createWorker?: (file: URL, options: WorkerOptions) => Worker; timeoutMs?: number } = {}) {
    if (dependencies.timeoutMs !== undefined && (!Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1 || dependencies.timeoutMs > 10000)) throw new ZToolsError(errorCodes.invalidRequest, 'SQLite worker等待上限无效')
  }
  stop(): Promise<void> { this.#stopped = true; for (const request of this.#pending.values()) request.controller.abort(); return Promise.all([...this.#pending.values()].map(request => request.finished)).then(() => {}) }
  async read(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<BrowserSnapshotResult> {
    const params = parseBrowserSnapshot(value)
    if (this.#stopped || signal.aborted) throw cancelled()
    if (this.#pending.has(caller.webContentsId) || this.#pending.size >= 2) throw new ZToolsError(errorCodes.fileTooLarge, 'SQLite读取正在处理中')
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
    let finish!: () => void
    this.#pending.set(caller.webContentsId, { controller, finished: new Promise<void>(resolve => { finish = resolve }) })
    try {
      const bytes = await this.grants.read(caller.webContentsId, params.fileGrantId, '', 16 * 1024 * 1024, combined)
      if (this.#stopped || combined.aborted) throw cancelled()
      validateBrowserSnapshotBytes(bytes)
      const worker = (this.dependencies.createWorker ?? ((file, options) => new Worker(file, options)))(new URL('../workers/browser-snapshot-worker.js', pathToFileURL(__filename)), {
        workerData: { params, bytes: Uint8Array.from(bytes) }, resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 }, execArgv: []
      })
      return await new Promise<BrowserSnapshotResult>((resolve, reject) => {
        let outcome: unknown, failure: ZToolsError | undefined, received = false
        const terminate = () => { void worker.terminate().catch(() => { failure ??= new ZToolsError(errorCodes.fileError, 'SQLite worker停止未确认') }) }
        const abort = () => { failure ??= cancelled(); terminate() }
        const timer = setTimeout(() => { failure ??= new ZToolsError(errorCodes.requestTimeout, 'SQLite快照查询超时'); terminate() }, this.dependencies.timeoutMs ?? 5000)
        combined.addEventListener('abort', abort, { once: true })
        worker.on('message', result => { if (received) { failure ??= new ZToolsError(errorCodes.fileError, 'SQLite worker响应重复'); terminate() } else { received = true; outcome = result } })
        worker.on('error', () => { failure ??= new ZToolsError(errorCodes.fileError, 'SQLite worker执行失败'); terminate() })
        worker.once('exit', code => {
          clearTimeout(timer); combined.removeEventListener('abort', abort)
          try {
            if (failure) throw failure
            if (this.#stopped || combined.aborted) throw cancelled()
            if (code !== 0 || !received) throw new ZToolsError(errorCodes.fileError, 'SQLite worker退出未产生结果')
            const error = (outcome as { success?: unknown; error?: { code?: unknown } })?.error
            if ((outcome as { success?: unknown })?.success === false) throw new ZToolsError(error?.code === errorCodes.fileTooLarge ? errorCodes.fileTooLarge : error?.code === errorCodes.responseTooLarge ? errorCodes.responseTooLarge : errorCodes.fileError, 'SQLite快照损坏、字段过大或缺少所需浏览器表')
            resolve(validateBrowserSnapshotResult(outcome, params.limit))
          } catch (error) { reject(error) }
        })
        if (combined.aborted) abort()
      })
    } finally { this.#pending.delete(caller.webContentsId); finish() }
  }
}
