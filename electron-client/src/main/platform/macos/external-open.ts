import type { Event as ElectronEvent } from 'electron'
import {
  MACOS_EXTERNAL_OPEN_LIMITS,
  type MacosExternalOpenRequest,
  validateMacosOpenFilePath,
  validateMacosOpenUrl
} from '../../../contracts/external-open.js'

export type MacosExternalOpenKind = MacosExternalOpenRequest['kind']
export type MacosExternalOpenPhase = 'capturing' | 'ready' | 'stopped'

export type MacosExternalOpenCaptureResult =
  | { readonly status: 'queued' }
  | { readonly status: 'duplicate' }
  | { readonly status: 'rejected'; readonly reason: string }

export interface MacosExternalOpenCoordinatorOptions {
  /** Runs in the main process only. File paths from OS events must be converted to an owner-scoped grant before Renderer delivery. */
  readonly handle: (request: MacosExternalOpenRequest, signal: AbortSignal) => void | Promise<void>
  /** Receives only request kind, so a failed open never places a user's path into generic logs. */
  readonly onDeliveryError?: (kind: MacosExternalOpenKind, error: unknown) => void
  readonly pendingLimit?: number
  readonly stopTimeoutMs?: number
}

interface PendingOpen {
  readonly key: string
  readonly request: MacosExternalOpenRequest
}

/** Bounded startup queue for trusted Electron macOS open-file/open-url events. */
export class MacosExternalOpenCoordinator {
  #phase: MacosExternalOpenPhase = 'capturing'
  readonly #queue: PendingOpen[] = []
  readonly #pendingKeys = new Set<string>()
  readonly #handle: MacosExternalOpenCoordinatorOptions['handle']
  readonly #onDeliveryError: MacosExternalOpenCoordinatorOptions['onDeliveryError']
  readonly #pendingLimit: number
  readonly #stopTimeoutMs: number
  #activeController: AbortController | undefined
  #drainPromise: Promise<void> | undefined
  #stopPromise: Promise<void> | undefined

  constructor(options: MacosExternalOpenCoordinatorOptions) {
    const pendingLimit = options.pendingLimit ?? MACOS_EXTERNAL_OPEN_LIMITS.pendingRequests
    if (!Number.isSafeInteger(pendingLimit) || pendingLimit < 1 || pendingLimit > 128) {
      throw new RangeError('Mac external-open pending limit must be an integer from 1 to 128')
    }
    const stopTimeoutMs = options.stopTimeoutMs ?? 5_000
    if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1 || stopTimeoutMs > 30_000) {
      throw new RangeError('Mac external-open stop timeout must be an integer from 1 to 30000')
    }
    this.#handle = options.handle
    this.#onDeliveryError = options.onDeliveryError
    this.#pendingLimit = pendingLimit
    this.#stopTimeoutMs = stopTimeoutMs
  }

  get phase(): MacosExternalOpenPhase {
    return this.#phase
  }

  captureFile(filePath: unknown): MacosExternalOpenCaptureResult {
    if (this.#phase === 'stopped') return { status: 'rejected', reason: 'stopped' }
    const parsed = validateMacosOpenFilePath(filePath)
    if (!parsed.valid) return { status: 'rejected', reason: parsed.reason }
    return this.#enqueue(Object.freeze({ kind: 'file', filePath: parsed.value }), `file:${parsed.value}`)
  }

  captureUrl(url: unknown): MacosExternalOpenCaptureResult {
    if (this.#phase === 'stopped') return { status: 'rejected', reason: 'stopped' }
    const parsed = validateMacosOpenUrl(url)
    if (!parsed.valid) return { status: 'rejected', reason: parsed.reason }
    const request = parsed.value
    return this.#enqueue(request, `plugin-open:${request.pluginId.toLowerCase()}`)
  }

  /** Call after the main-process consumer is able to handle queued requests. Safe to call more than once. */
  markReady(): void {
    if (this.#phase === 'stopped') return
    this.#phase = 'ready'
    this.#scheduleDrain()
  }

  /** Cancel queued and in-flight opens while allowing future OS events to be accepted. */
  cancelPending(): void {
    if (this.#phase === 'stopped') return
    for (const item of this.#queue.splice(0)) this.#pendingKeys.delete(item.key)
    this.#activeController?.abort()
  }

  /** Permanently reject new events, discard queued opens, and signal the current handler to cancel. */
  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    this.#phase = 'stopped'
    for (const item of this.#queue.splice(0)) this.#pendingKeys.delete(item.key)
    this.#activeController?.abort()
    this.#stopPromise = this.#drainPromise ? this.#waitForStop(this.#drainPromise) : Promise.resolve()
    return this.#stopPromise
  }

  /** Wait for the requests currently eligible for delivery; pre-ready requests remain queued. */
  async whenIdle(): Promise<void> {
    while (this.#drainPromise) await this.#drainPromise
  }

  async #waitForStop(drain: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        drain,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('External-open consumer did not confirm cancellation')), this.#stopTimeoutMs)
        })
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  #enqueue(request: MacosExternalOpenRequest, key: string): MacosExternalOpenCaptureResult {
    if (this.#pendingKeys.has(key)) return { status: 'duplicate' }
    if (this.#queue.length >= this.#pendingLimit) return { status: 'rejected', reason: 'queue-overflow' }
    this.#queue.push({ key, request })
    this.#pendingKeys.add(key)
    this.#scheduleDrain()
    return { status: 'queued' }
  }

  #scheduleDrain(): void {
    if (this.#phase !== 'ready' || this.#drainPromise || this.#queue.length === 0) return
    // Publish the drain before calling a consumer that can synchronously request stop.
    const draining = Promise.resolve().then(() => this.#drain())
    this.#drainPromise = draining
    void draining.then(() => {
      if (this.#drainPromise !== draining) return
      this.#drainPromise = undefined
      this.#scheduleDrain()
    })
  }

  async #drain(): Promise<void> {
    while (this.#phase === 'ready') {
      const item = this.#queue.shift()
      if (!item) return
      const controller = new AbortController()
      this.#activeController = controller
      try {
        await this.#handle(item.request, controller.signal)
      } catch (error) {
        if (!controller.signal.aborted) {
          try { this.#onDeliveryError?.(item.request.kind, error) } catch { /* diagnostic hooks cannot interrupt later opens */ }
        }
      } finally {
        this.#pendingKeys.delete(item.key)
        this.#activeController = undefined
      }
    }
  }
}

export interface MacosExternalOpenAppEvents {
  on(event: 'open-file', listener: (event: ElectronEvent, filePath: string) => void): unknown
  on(event: 'open-url', listener: (event: ElectronEvent, url: string) => void): unknown
  removeListener(event: 'open-file', listener: (event: ElectronEvent, filePath: string) => void): unknown
  removeListener(event: 'open-url', listener: (event: ElectronEvent, url: string) => void): unknown
}

/** Register before app.whenReady(); only packaged macOS builds claim the external URL/file entry points. */
export function installMacosExternalOpenListeners(
  app: MacosExternalOpenAppEvents,
  coordinator: MacosExternalOpenCoordinator,
  runtime: { readonly platform: NodeJS.Platform; readonly isPackaged: boolean; readonly includeFileEvents?: boolean }
): { dispose(): void } {
  if (runtime.platform !== 'darwin' || runtime.isPackaged !== true) return { dispose() {} }

  const onOpenFile = (event: ElectronEvent, filePath: string) => {
    event.preventDefault()
    coordinator.captureFile(filePath)
  }
  const onOpenUrl = (event: ElectronEvent, url: string) => {
    event.preventDefault()
    coordinator.captureUrl(url)
  }
  const includeFiles = runtime.includeFileEvents !== false
  if (includeFiles) app.on('open-file', onOpenFile)
  try {
    app.on('open-url', onOpenUrl)
  } catch (installationError) {
    try {
      if (includeFiles) app.removeListener('open-file', onOpenFile)
    } catch (cleanupError) {
      throw new AggregateError([installationError, cleanupError], 'External-open listener setup and rollback failed')
    }
    throw installationError
  }

  let disposed = false
  return {
    dispose() {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      try { if (includeFiles) app.removeListener('open-file', onOpenFile) } catch (error) { errors.push(error) }
      try { app.removeListener('open-url', onOpenUrl) } catch (error) { errors.push(error) }
      if (errors.length > 0) {
        disposed = false
        throw new AggregateError(errors, 'External-open listener cleanup failed')
      }
    }
  }
}
