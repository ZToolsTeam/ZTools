import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { isConfirmedReferenceWriteReceipt, withoutReferenceWriteReceipt } from '../../contracts/path-reference.js'
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../../contracts/ipc.js'
import { REFERENCE_METHODS, REFERENCE_MUTATING_METHODS } from '../../contracts/reference-transport.js'
import type { PathGrantOwnerLifecycle } from './path-grant-service.js'

const mutating = new Set<string>(REFERENCE_MUTATING_METHODS)
const allowed = new Set<string>(REFERENCE_METHODS)
const dialogs = new Set(['window_show_open_dialog', 'window_show_save_dialog', 'window_show_select_folder_dialog'])
const referenceProducers = new Set([...dialogs, 'filesystem_derive_read', 'filesystem_derive_save', 'filesystem_derive_directory',
  'filesystem_write_file', 'filesystem_write_cache', 'clipboard_read_files', 'clipboard_read_image', 'screen_capture', 'screen_capture_region'])
const denied = () => new ZToolsError(errorCodes.permissionDenied, '文件请求无效或超过上限')
const incomplete = () => new ZToolsError(errorCodes.fileError, '文件请求停止未确认')
const unknown = () => new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '文件请求取消后写入结果未确认')
interface Pending {
  method: string
  controller: AbortController
  finished: Promise<unknown>
}

/** Main-only file request state machine. Activation belongs to the atomic reference-contract Router migration. */
export class ReferenceRequestTracker {
  readonly #pending = new Map<number, Map<string, Pending>>()
  readonly #early = new Map<number, Map<string, { method: string; expires: number; reason: string }>>()
  readonly #removeListener: () => void
  #count = 0
  #earlyCount = 0
  #stopped = false
  #cleanupFailed = false
  #stopping?: Promise<void>
  constructor(private readonly owners: PathGrantOwnerLifecycle, private readonly cleanupMs = 10_000,
    private readonly now = Date.now) {
    if (!Number.isSafeInteger(cleanupMs) || cleanupMs < 1 || cleanupMs > 30_000) throw denied()
    this.#removeListener = owners.onRemoved(owner => {
      const early = this.#early.get(owner)
      this.#earlyCount -= early?.size ?? 0; this.#early.delete(owner)
      for (const record of this.#pending.get(owner)?.values() ?? []) record.controller.abort(errorCodes.callerDestroyed)
    })
  }

  execute(owner: number, method: string, messageId: string, work: (signal: AbortSignal) => Promise<unknown>,
    timeoutMs: number | 'infinite' = DEFAULT_TIMEOUT_MS, onUndelivered?: (value: unknown) => Promise<void>): Promise<unknown> {
    try {
      this.#validate(owner, method, messageId)
      if (referenceProducers.has(method) && !onUndelivered) throw denied()
      if ((timeoutMs === 'infinite' && !dialogs.has(method)) || (timeoutMs !== 'infinite' &&
          (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS))) throw denied()
      this.#prune()
      const early = this.#early.get(owner)?.get(messageId)
      if (early) {
        if (early.method !== method) throw denied()
        this.#early.get(owner)!.delete(messageId); this.#earlyCount--
        if (!this.#early.get(owner)!.size) this.#early.delete(owner)
        throw this.#cancelError(early.reason)
      }
      const requests = this.#pending.get(owner) ?? new Map<string, Pending>()
      if (requests.has(messageId) || requests.size >= 2 || this.#count >= 8) throw denied()
      const controller = new AbortController()
      let dispatched = false, deliveryCleanupFailed = false, cleanupTimer: NodeJS.Timeout | undefined
      const timeout = timeoutMs === 'infinite' ? undefined : setTimeout(() => controller.abort(errorCodes.requestTimeout), timeoutMs)
      const finished = Promise.resolve().then(async () => {
        if (controller.signal.aborted) throw this.#cancelError(controller.signal.reason)
        dispatched = true
        try {
          const value = await work(controller.signal)
          if (controller.signal.aborted) {
            const committed = method === 'filesystem_write_file' && isConfirmedReferenceWriteReceipt(value) ? value : undefined
            let releaseFailed = false
            if (onUndelivered) {
              try { await onUndelivered(value) }
              catch {
                this.#cleanupFailed = true; deliveryCleanupFailed = true; releaseFailed = true
                if (!committed) throw mutating.has(method) ? unknown() : incomplete()
              }
            }
            if (committed) return withoutReferenceWriteReceipt(committed, releaseFailed)
            throw mutating.has(method) ? unknown() : this.#cancelError(controller.signal.reason)
          }
          return value
        } catch (error) {
          // Commit and retained-staging facts must survive cancellation, unlike the legacy eager abort race.
          if (error instanceof ZToolsError && (error.code === errorCodes.fileWriteOutcomeUnknown || error.code === errorCodes.fileStagingRetained ||
              (deliveryCleanupFailed && error.code === errorCodes.fileError))) throw error
          if (controller.signal.aborted) throw method === 'filesystem_write_file' ? unknown() : this.#cancelError(controller.signal.reason)
          throw error
        }
      })
      const record: Pending = { method, controller, finished }
      requests.set(messageId, record); this.#pending.set(owner, requests); this.#count++
      const cleanup = () => {
        if (timeout) clearTimeout(timeout)
        if (requests.get(messageId) === record) { requests.delete(messageId); this.#count-- }
        if (!requests.size) this.#pending.delete(owner)
      }
      void finished.then(cleanup, cleanup)
      let onAbort!: () => void
      const cancellationDeadline = new Promise<never>((_, reject) => {
        onAbort = () => {
          cleanupTimer = setTimeout(() => reject(dispatched && mutating.has(method) ? unknown() : incomplete()), this.cleanupMs)
        }
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      return Promise.race([finished, cancellationDeadline]).finally(() => {
        controller.signal.removeEventListener('abort', onAbort)
        if (cleanupTimer) clearTimeout(cleanupTimer)
        // A noncooperating handler keeps its bounded reservation until actual settlement.
        if (timeout) clearTimeout(timeout)
      })
    } catch (error) { return Promise.reject(error) }
  }

  cancel(owner: number, method: string, messageId: string, reason: 'cancel' | 'timeout' = 'cancel'): void {
    this.#validate(owner, method, messageId)
    if (reason !== 'cancel' && reason !== 'timeout') throw denied()
    const code = reason === 'timeout' ? errorCodes.requestTimeout : errorCodes.callerDestroyed
    const pending = this.#pending.get(owner)?.get(messageId)
    if (pending) {
      if (pending.method !== method) throw denied()
      pending.controller.abort(code)
      return
    }
    // IPC cancel may arrive before invoke registration. Keep a bounded, short-lived owner/method tombstone.
    this.#prune()
    const early = this.#early.get(owner) ?? new Map<string, { method: string; expires: number; reason: string }>()
    const existing = early.get(messageId)
    if (existing) { if (existing.method !== method) throw denied(); return }
    if (early.size >= 64 || this.#earlyCount >= 256) throw denied()
    early.set(messageId, { method, expires: this.now() + 10_000, reason: code }); this.#early.set(owner, early); this.#earlyCount++
  }

  closeIngress(): void {
    if (this.#stopped) return
    this.#stopped = true
    try { this.#removeListener() } catch { this.#cleanupFailed = true }
    this.#early.clear(); this.#earlyCount = 0
    const pending = [...this.#pending.values()].flatMap(requests => [...requests.values()])
    for (const record of pending) record.controller.abort(errorCodes.appStopping)
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping
    this.closeIngress()
    const pending = [...this.#pending.values()].flatMap(requests => [...requests.values()])
    this.#stopping = (async () => {
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([Promise.allSettled(pending.map(record => record.finished)), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(incomplete()), this.cleanupMs)
        })])
        if (this.#cleanupFailed) throw incomplete()
      } finally { if (timer) clearTimeout(timer) }
    })()
    return this.#stopping
  }
  #validate(owner: number, method: string, id: string): void {
    if (this.#stopped || !Number.isSafeInteger(owner) || owner <= 0 || !this.owners.isActive(owner) ||
        !allowed.has(method) || typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(id)) throw denied()
  }
  #prune(): void {
    for (const [owner, entries] of this.#early) {
      for (const [id, entry] of entries) if (entry.expires <= this.now()) { entries.delete(id); this.#earlyCount-- }
      if (!entries.size) this.#early.delete(owner)
    }
  }
  #cancelError(reason: unknown): ZToolsError {
    if (reason === errorCodes.requestTimeout) return new ZToolsError(errorCodes.requestTimeout, '文件请求超时')
    if (reason === errorCodes.appStopping) return new ZToolsError(errorCodes.appStopping, '应用正在退出')
    return new ZToolsError(errorCodes.callerDestroyed, '文件请求已取消或调用窗口已关闭')
  }
}
