import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { PathAccessAdapter, AnchoredPathObject } from '../platform/path-access.js'
import type { PathWriteJournal, PathWriteRecord } from '../platform/path-write-journal.js'

export interface PathWriteRecoveryEntry {
  readonly recoveryId: string
  readonly displayName: string
  readonly phase: PathWriteRecord['phase']
  readonly createdAt: number
  readonly expectedBytes: number | null
}
export interface PathWriteObservation {
  state: 'unresolved' | 'staging' | 'committed-object'
  size: number
}
export type RecoveryAdapter = Pick<PathAccessAdapter, 'platform' | 'pin' | 'release' | 'stop'> & {
  observeWrite(object: AnchoredPathObject, proof: Buffer, signal: AbortSignal): Promise<PathWriteObservation>
}
const denied = () => new ZToolsError(errorCodes.permissionDenied, '写入恢复只允许当前主窗口访问')
const unavailable = () => new ZToolsError(errorCodes.fileError, '写入恢复身份尚未确认')

/** Main-window diagnostics only. Object matching never acknowledges business success or mutates the journal. */
export class PathWriteRecoveryService {
  readonly #controller = new AbortController()
  readonly #pending = new Set<Promise<unknown>>()
  #stop?: Promise<void>
  constructor(private readonly journal: PathWriteJournal, private readonly adapter: RecoveryAdapter,
    private readonly cleanupTimeoutMs = 10000) {
    if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 30000) throw unavailable()
  }

  list(caller: CallerIdentity, signal?: AbortSignal): Promise<readonly PathWriteRecoveryEntry[]> {
    return this.#run(caller, signal, async combined => {
      const records = await this.journal.pending()
      this.#active(caller, combined)
      return Object.freeze(records.map(record => this.#entry(record)))
    })
  }

  inspect(recoveryId: unknown, caller: CallerIdentity, signal?: AbortSignal): Promise<PathWriteRecoveryEntry & {
    observation: PathWriteObservation | { state: 'unresolved'; reason: 'no-object-proof' }
    businessResult: 'unconfirmed'
  }> {
    return this.#run(caller, signal, async combined => {
      if (typeof recoveryId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(recoveryId)) throw unavailable()
      let object: AnchoredPathObject | undefined
      try {
        const record = (await this.journal.pending()).find(entry => entry.id === recoveryId)
        this.#active(caller, combined)
        if (!record || record.platform !== this.adapter.platform) throw unavailable()
        if (!record.proof) return { ...this.#entry(record), observation: { state: 'unresolved', reason: 'no-object-proof' }, businessResult: 'unconfirmed' }
        object = await this.adapter.pin(record.selectedPath, 'save', ['write'], combined)
        this.#active(caller, combined)
        const observation = await this.adapter.observeWrite(object, Buffer.from(record.proof, 'base64'), combined)
        this.#active(caller, combined)
        if (!['unresolved', 'staging', 'committed-object'].includes(observation.state) ||
            !Number.isSafeInteger(observation.size) || observation.size < 0) throw unavailable()
        // Explicit projection: neither private path/proof nor extra adapter fields may reach the UI.
        return { ...this.#entry(record), observation: { state: observation.state, size: observation.size }, businessResult: 'unconfirmed' }
      } catch (error) {
        if (error instanceof ZToolsError && (error.code === errorCodes.permissionDenied || error.code === errorCodes.callerDestroyed)) throw error
        throw unavailable()
      } finally {
        try { if (object) await this.adapter.release(object) }
        catch { throw unavailable() }
      }
    })
  }

  stop(): Promise<void> {
    if (!this.#stop) {
      this.#controller.abort()
      this.#stop = (async () => {
        let failed = false
        try { await this.#bounded(Promise.allSettled([...this.#pending])) } catch { failed = true }
        try { await this.#bounded(Promise.resolve().then(() => this.adapter.stop())) } catch { failed = true }
        if (failed) throw unavailable()
      })()
    }
    return this.#stop
  }

  #run<T>(caller: CallerIdentity, signal: AbortSignal | undefined, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    try {
      this.#assertCaller(caller)
      const combined = signal ? AbortSignal.any([signal, this.#controller.signal]) : this.#controller.signal
      this.#active(caller, combined)
      if (this.#pending.size >= 8) throw unavailable()
      // Reserve before any await, including journal load; late cancellation retains the slot until release settles.
      const pending = Promise.resolve().then(() => { this.#active(caller, combined); return execute(combined) })
      this.#pending.add(pending)
      void pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending))
      return pending
    } catch (error) { return Promise.reject(error) }
  }
  #active(caller: CallerIdentity, signal: AbortSignal): void {
    this.#assertCaller(caller)
    if (signal.aborted) throw new ZToolsError(errorCodes.callerDestroyed, '写入恢复查询已取消')
  }
  async #bounded(pending: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), this.cleanupTimeoutMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }

  #assertCaller(caller: CallerIdentity): void {
    if (caller.type !== 'main' || !Number.isSafeInteger(caller.webContentsId) || caller.webContentsId <= 0 || this.#controller.signal.aborted) throw denied()
  }
  #entry(record: PathWriteRecord): PathWriteRecoveryEntry {
    const paths = record.platform === 'win32' ? path.win32 : path.posix
    return Object.freeze({ recoveryId: record.id, displayName: paths.basename(record.selectedPath),
      phase: record.phase, createdAt: record.createdAt, expectedBytes: record.expectedBytes })
  }
}
