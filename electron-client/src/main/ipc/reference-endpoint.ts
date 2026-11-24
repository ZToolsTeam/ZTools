import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { toLocalizedPublicError } from './error-localizer.js'
import type { ZToolsResponse } from '../../contracts/ipc.js'
import type { SdkApiLane } from '../../contracts/sdk-api-lane.js'
import { parseReferenceRequest, parseReferenceCancellation, REFERENCE_METHODS, REFERENCE_MUTATING_METHODS, type ReferenceMethod } from '../../contracts/reference-transport.js'
import type { ReferenceFileDropService } from '../services/reference-file-drop-service.js'
import type { ReferenceRequestTracker } from '../services/reference-request-tracker.js'
import type { RuntimeDiagnosticFailureStore } from '../services/runtime-diagnostics.js'

interface Target { id: number; isDestroyed(): boolean; mainFrame: { url: string } }
interface InvokeEvent { sender: Target; senderFrame: Target['mainFrame'] | null }
interface Registry {
  get(id: number): CallerIdentity | undefined
  getWebContents(id: number): Target | undefined
  getSdkApiLane(caller: CallerIdentity | undefined): SdkApiLane | undefined
}
export interface ReferenceHandler {
  execute(params: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<unknown>
  disposeUndelivered?(result: unknown, caller: CallerIdentity): Promise<void>
}
const methods = new Set<string>(REFERENCE_METHODS), mutating = new Set<string>(REFERENCE_MUTATING_METHODS)
const denied = () => new ZToolsError(errorCodes.permissionDenied, 'Invalid file caller identity or page')
const stopping = () => new ZToolsError(errorCodes.appStopping, 'File capability is shutting down')
const incomplete = () => new ZToolsError(errorCodes.fileError, 'File capability shutdown was not confirmed')

function invokeCleanup(action: () => void | Promise<void>): Promise<void> {
  try { return Promise.resolve(action()) }
  catch (error) { return Promise.reject(error) }
}

/** Main-only endpoint; normal Router registration changes together with the SDK2 consumer migration. */
export class ReferenceIpcEndpoint {
  #phase: 'ready' | 'ingress-closed' | 'draining' | 'stopped' | 'failed' = 'ready'
  #closeFailed = false
  #dropDrain?: Promise<void>
  #draining?: Promise<void>

  constructor(private readonly registry: Registry, private readonly tracker: ReferenceRequestTracker,
    private readonly handlers: Partial<Record<ReferenceMethod, ReferenceHandler>>,
    private readonly authorize: (method: ReferenceMethod, caller: CallerIdentity) => boolean,
    private readonly drops?: Pick<ReferenceFileDropService, 'accept'> & Partial<Pick<ReferenceFileDropService, 'stop'>>,
    private readonly diagnostics?: Pick<RuntimeDiagnosticFailureStore, 'record'>) {}

  /** Stop accepting IPC immediately and cancel active requests/drops; safe to call repeatedly. */
  closeIngress(): void {
    if (this.#phase !== 'ready') return
    this.#phase = 'ingress-closed'
    try { this.tracker.closeIngress() } catch { this.#closeFailed = true }
    if (!this.drops?.stop) { this.#dropDrain = Promise.resolve(); return }
    try { this.#dropDrain = Promise.resolve(this.drops.stop()) }
    catch (error) {
      this.#closeFailed = true
      this.#dropDrain = Promise.reject(error)
      void this.#dropDrain.catch(() => {})
    }
  }

  /** Wait for requests and native drop delivery already in flight. */
  drain(): Promise<void> {
    if (this.#draining) return this.#draining
    this.closeIngress()
    this.#phase = 'draining'
    const requests = invokeCleanup(() => this.tracker.stop())
    const drops = this.#dropDrain ?? Promise.resolve()
    this.#draining = Promise.allSettled([requests, drops]).then(results => {
      if (this.#closeFailed || results.some(result => result.status === 'rejected')) {
        this.#phase = 'failed'
        throw incomplete()
      }
      this.#phase = 'stopped'
    })
    return this.#draining
  }

  /** Private isolated-preload native drop channel only; no public Renderer path/grant API. */
  async acceptDrop(event: InvokeEvent, value: unknown) {
    try {
      this.#assertOpen()
      const method = 'filesystem_read_file', caller = this.#caller(event, method)
      if (caller.type !== 'plugin') throw denied()
      if (!this.drops) throw new ZToolsError(errorCodes.notSupported, 'Native file drop handler is not wired')
      return await this.drops.accept(caller.webContentsId, value, undefined, () => { this.#caller(event, method, caller) })
    } catch (error) { return { success: false as const, error: toLocalizedPublicError(error) } }
  }

  async call(event: InvokeEvent, value: unknown): Promise<ZToolsResponse> {
    let messageId = 'invalid'
    let request: ReturnType<typeof parseReferenceRequest> | undefined
    let caller: CallerIdentity | undefined
    let failureStage = 'parse'
    try {
      this.#assertOpen()
      request = parseReferenceRequest(value); messageId = request.messageId
      if (!methods.has(request.method)) throw new ZToolsError(errorCodes.methodNotFound, 'File method is not exposed')
      const method = request.method as ReferenceMethod
      caller = this.registry.get(event.sender.id)
      failureStage = 'authorization'
      caller = this.#caller(event, method, caller)
      const handler = this.handlers[method]
      if (!handler) throw new ZToolsError(errorCodes.notSupported, 'File consumer handler is not wired')
      const resolvedCaller = caller
      const resolvedRequest = request
      if (!resolvedCaller || !resolvedRequest) throw denied()
      const dispose = handler.disposeUndelivered
        ? (result: unknown) => handler.disposeUndelivered!(result, resolvedCaller)
        : undefined
      failureStage = 'execute'
      const data = await this.tracker.execute(resolvedCaller.webContentsId, method, messageId,
        signal => handler.execute(resolvedRequest.params, resolvedCaller, signal), resolvedRequest.timeoutMs, dispose)
      failureStage = 'reconcile'
      try { this.#caller(event, method, resolvedCaller) }
      catch {
        if (dispose) {
          try { await dispose(data) }
          catch { throw new ZToolsError(mutating.has(method) ? errorCodes.fileWriteOutcomeUnknown : errorCodes.fileError, 'Undelivered reference cleanup was not confirmed') }
        }
        throw new ZToolsError(mutating.has(method) ? errorCodes.fileWriteOutcomeUnknown : errorCodes.callerDestroyed, 'Caller page is no longer valid; result was not delivered')
      }
      return { messageId, success: true, data }
    } catch (error) {
      const publicError = toLocalizedPublicError(error)
      if (caller && request) {
        this.diagnostics?.record(caller, {
          requestId: request.messageId,
          method: request.method,
          failureStage,
          errorCode: publicError.code
        })
      }
      return { messageId, success: false, error: publicError }
    }
  }

  async cancel(event: InvokeEvent, value: unknown): Promise<ZToolsResponse> {
    let messageId = 'invalid'
    try {
      this.#assertOpen()
      const request = parseReferenceCancellation(value); messageId = request.messageId
      const caller = this.#caller(event, request.method)
      if (!this.handlers[request.method]) throw new ZToolsError(errorCodes.notSupported, 'File consumer handler is not wired')
      this.tracker.cancel(caller.webContentsId, request.method, messageId, request.reason)
      return { messageId, success: true, data: { success: true, requested: true } }
    } catch (error) { return { messageId, success: false, error: toLocalizedPublicError(error) } }
  }

  #caller(event: InvokeEvent, method: ReferenceMethod, expected?: CallerIdentity): CallerIdentity {
    const target = this.registry.getWebContents(event.sender.id), caller = this.registry.get(event.sender.id)
    if (!target || target !== event.sender || target.isDestroyed() || !event.senderFrame || event.senderFrame !== target.mainFrame ||
        !caller || caller.webContentsId !== target.id || this.registry.getSdkApiLane(caller) !== 2 || !this.authorize(method, caller)) throw denied()
    if (expected && (caller.type !== expected.type || caller.pluginId !== expected.pluginId || caller.pluginInstanceId !== expected.pluginInstanceId)) throw denied()
    let url: URL
    try { url = new URL(event.senderFrame.url) } catch { throw denied() }
    if (url.protocol !== 'ztools:' || url.username || url.password || url.port) throw denied()
    if (caller.type === 'main') { if (url.hostname !== 'web') throw denied() }
    else if (caller.type === 'plugin') {
      let plugin: string
      try { plugin = decodeURIComponent(url.pathname.split('/')[1] ?? '') } catch { throw denied() }
      if (url.hostname !== 'plugins' || !caller.pluginId || !caller.pluginInstanceId || plugin !== caller.pluginId) throw denied()
    } else throw denied()
    return Object.freeze({ ...caller })
  }

  #assertOpen(): void {
    if (this.#phase !== 'ready') throw stopping()
  }
}
