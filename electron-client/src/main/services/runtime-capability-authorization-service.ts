import { randomBytes } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { CapabilityAuthorizationStatus, RuntimeCapabilityId } from '../../contracts/runtime-capability.js'
import type { WindowRegistry } from '../windows/window-registry.js'

export interface RuntimeCapabilityPromptPort {
  request(owner: CallerIdentity, pluginName: string, signal: AbortSignal): Promise<boolean>
  cancelOwner(owner: CallerIdentity): void
  stop(): void
}

export interface RuntimeCapabilityLease {
  readonly signal: AbortSignal
  assertCurrent(): void
  release(): void
}

export interface RuntimeCapabilityGrantRecord {
  grantId: string
  capability: 'screen.capture'
  pluginId: string
  pluginName: string
  grantedAt: number
}

export interface RuntimeCapabilityAuthorizationOptions {
  resolvePluginName?: (pluginId: string) => Promise<string>
  onChanged?: (owner: CallerIdentity, revision: number) => void
}

interface OwnerState {
  owner: CallerIdentity
  authorization: 'not-requested' | 'granted' | 'denied'
  generation: number
  grant?: RuntimeCapabilityGrantRecord
  readonly leases: Set<AbortController>
}

interface PendingRequest {
  controller: AbortController
  generation: number
  promise: Promise<'granted' | 'denied'>
  readonly waiters: Set<symbol>
}

function ownerKey(owner: CallerIdentity): string {
  return JSON.stringify([owner.type, owner.webContentsId, owner.pluginId ?? null, owner.pluginInstanceId ?? null])
}

function sameOwner(left: CallerIdentity | undefined, right: CallerIdentity): boolean {
  return left?.type === right.type && left.webContentsId === right.webContentsId &&
    left.pluginId === right.pluginId && left.pluginInstanceId === right.pluginInstanceId
}

function copyOwner(owner: CallerIdentity): CallerIdentity {
  return { ...owner }
}

function abortError(reason: unknown): ZToolsError {
  if (reason === errorCodes.appStopping) return new ZToolsError(errorCodes.appStopping, '应用正在退出')
  if (reason === errorCodes.callerDestroyed) return new ZToolsError(errorCodes.callerDestroyed, '插件窗口已关闭')
  return new ZToolsError(errorCodes.requestTimeout, '权限申请等待已取消')
}

/** Main-owned, instance-scoped in-memory authorization for screen capture. */
export class RuntimeCapabilityAuthorizationService {
  readonly #owners = new Map<string, OwnerState>()
  readonly #pending = new Map<string, PendingRequest>()
  readonly #removeOwnerListener: () => void
  #revision = 0
  #stopped = false

  constructor(
    private readonly registry: Pick<WindowRegistry, 'get' | 'getWebContents' | 'onRemoved'>,
    private readonly prompt: RuntimeCapabilityPromptPort,
    private readonly options: RuntimeCapabilityAuthorizationOptions = {}
  ) {
    this.#removeOwnerListener = registry.onRemoved(id => this.closeOwner(id))
  }

  getAuthorizationStatus(capability: RuntimeCapabilityId, caller: CallerIdentity): CapabilityAuthorizationStatus {
    if (this.#stopped) return 'unknown'
    if (capability !== 'screen.capture') return 'unknown'
    if (caller.type === 'main') {
      try {
        this.#assertCurrentMain(caller)
        return 'granted'
      } catch {
        return 'denied'
      }
    }
    if (caller.type !== 'plugin') return 'unknown'
    if (!this.#isCurrentPlugin(caller)) return 'denied'
    return this.#state(caller).authorization
  }

  async requestCapability(
    capability: RuntimeCapabilityId,
    caller: CallerIdentity,
    signal?: AbortSignal
  ): Promise<'granted' | 'denied'> {
    this.#requireRunning()
    if (signal?.aborted) return Promise.reject(abortError(signal.reason))
    if (capability !== 'screen.capture') {
      throw new ZToolsError(errorCodes.notSupported, '当前仅支持申请屏幕采集权限')
    }
    this.#assertCurrentPlugin(caller)
    const key = ownerKey(caller)
    const state = this.#state(caller)
    if (state.authorization === 'granted') return 'granted'

    const existing = this.#pending.get(key)
    if (existing) return this.#waitForRequest(existing, key, signal)

    const controller = new AbortController()
    const generation = state.generation
    const pending: PendingRequest = {
      controller,
      generation,
      promise: Promise.resolve('denied'),
      waiters: new Set()
    }
    pending.promise = Promise.resolve().then(async () => {
      let allowed = false
      let pluginName = caller.pluginId!
      try {
        pluginName = await this.#resolvePluginName(caller.pluginId!)
        this.#assertCurrentPlugin(caller)
        if (controller.signal.aborted || state.generation !== generation || this.#pending.get(key) !== pending) {
          return state.authorization === 'granted' ? 'granted' : 'denied'
        }
        allowed = await this.prompt.request(caller, pluginName, controller.signal)
      } catch (error) {
        if (controller.signal.aborted && this.#stopped) throw abortError(errorCodes.appStopping)
        if (controller.signal.reason === errorCodes.callerDestroyed || !this.#isCurrentPlugin(caller)) {
          throw abortError(errorCodes.callerDestroyed)
        }
        // Prompt failures default to deny; no renderer or native code can create a grant.
        allowed = false
      }

      if (this.#stopped) throw abortError(errorCodes.appStopping)
      if (controller.signal.reason === errorCodes.callerDestroyed || !this.#isCurrentPlugin(caller)) {
        throw abortError(errorCodes.callerDestroyed)
      }
      this.#assertCurrentPlugin(caller)
      if (controller.signal.aborted || state.generation !== generation || this.#pending.get(key) !== pending) {
        return state.authorization === 'granted' ? 'granted' : 'denied'
      }
      state.authorization = allowed ? 'granted' : 'denied'
      if (allowed) {
        state.grant = {
          grantId: randomBytes(32).toString('base64url'),
          capability: 'screen.capture',
          pluginId: caller.pluginId!,
          pluginName,
          grantedAt: Date.now()
        }
      } else {
        delete state.grant
      }
      this.#notifyChanged(caller)
      return state.authorization
    }).finally(() => {
      if (this.#pending.get(key) === pending) this.#pending.delete(key)
    })
    this.#pending.set(key, pending)
    void pending.promise.catch(() => undefined)
    return this.#waitForRequest(pending, key, signal)
  }

  revokeCapability(capability: RuntimeCapabilityId, caller: CallerIdentity): { success: true; authorization: 'denied' } {
    this.#requireRunning()
    if (capability !== 'screen.capture') {
      throw new ZToolsError(errorCodes.notSupported, '当前仅支持撤销屏幕采集权限')
    }
    this.#assertCurrentPlugin(caller)
    this.#revokeOwner(this.#state(caller), caller)
    return { success: true, authorization: 'denied' }
  }

  beginOperation(capability: RuntimeCapabilityId, caller: CallerIdentity): RuntimeCapabilityLease | undefined {
    this.#requireRunning()
    if (capability !== 'screen.capture') {
      throw new ZToolsError(errorCodes.notSupported, '当前仅支持屏幕采集权限')
    }
    if (caller.type === 'main') {
      this.#assertCurrentMain(caller)
      return undefined
    }
    this.#assertCurrentPlugin(caller)
    const state = this.#state(caller)
    if (state.authorization !== 'granted' || !state.grant) {
      throw new ZToolsError(errorCodes.permissionDenied, '此插件实例尚未获得屏幕采集授权')
    }
    const generation = state.generation
    const grantId = state.grant.grantId
    const controller = new AbortController()
    state.leases.add(controller)
    let released = false
    return {
      signal: controller.signal,
      assertCurrent: () => {
        if (released || controller.signal.aborted || !this.#isCurrentPlugin(caller) ||
            state.generation !== generation || state.authorization !== 'granted' || state.grant?.grantId !== grantId) {
          throw new ZToolsError(errorCodes.permissionDenied, '屏幕采集授权已撤销')
        }
      },
      release: () => {
        if (released) return
        released = true
        state.leases.delete(controller)
      }
    }
  }

  listGrants(mainCaller: CallerIdentity): RuntimeCapabilityGrantRecord[] {
    this.#assertCurrentMain(mainCaller)
    const records: RuntimeCapabilityGrantRecord[] = []
    for (const state of this.#owners.values()) {
      if (state.authorization !== 'granted' || !state.grant) continue
      if (!this.#isCurrentPlugin(state.owner)) continue
      records.push({ ...state.grant })
    }
    return records.sort((left, right) => left.grantedAt - right.grantedAt || left.pluginId.localeCompare(right.pluginId))
  }

  revokeGrant(grantId: string, mainCaller: CallerIdentity): { success: true; revoked: true } {
    this.#assertCurrentMain(mainCaller)
    for (const state of this.#owners.values()) {
      if (state.grant?.grantId !== grantId) continue
      this.#assertCurrentMain(mainCaller)
      if (!this.#isCurrentPlugin(state.owner)) {
        this.closeOwner(state.owner.webContentsId)
        throw new ZToolsError(errorCodes.invalidRequest, '授权已失效，请刷新列表')
      }
      this.#revokeOwner(state, state.owner)
      return { success: true, revoked: true }
    }
    throw new ZToolsError(errorCodes.invalidRequest, '授权不存在或已撤销')
  }

  closeOwner(owner: CallerIdentity | number): void {
    const webContentsId = typeof owner === 'number' ? owner : owner.webContentsId
    for (const [key, state] of this.#owners) {
      if (state.owner.webContentsId !== webContentsId) continue
      this.#pending.get(key)?.controller.abort(errorCodes.callerDestroyed)
      this.#pending.delete(key)
      this.prompt.cancelOwner(state.owner)
      this.#abortLeases(state)
      this.#owners.delete(key)
      this.#notifyChanged(state.owner)
    }
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#removeOwnerListener()
    for (const [key, pending] of this.#pending) {
      pending.controller.abort(errorCodes.appStopping)
      const owner = this.#owners.get(key)?.owner
      if (owner) this.prompt.cancelOwner(owner)
    }
    for (const state of this.#owners.values()) this.#abortLeases(state)
    this.#pending.clear()
    this.#owners.clear()
    this.prompt.stop()
  }

  #revokeOwner(state: OwnerState, owner: CallerIdentity): void {
    state.generation += 1
    state.authorization = 'denied'
    delete state.grant
    this.#pending.get(ownerKey(owner))?.controller.abort(errorCodes.permissionDenied)
    this.#pending.delete(ownerKey(owner))
    this.prompt.cancelOwner(owner)
    this.#abortLeases(state)
    this.#notifyChanged(owner)
  }

  #waitForRequest(
    pending: PendingRequest,
    key: string,
    signal?: AbortSignal
  ): Promise<'granted' | 'denied'> {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason))
    const waiter = Symbol('runtime-capability-request-waiter')
    pending.waiters.add(waiter)
    return new Promise<'granted' | 'denied'>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort)
        pending.waiters.delete(waiter)
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        if (pending.waiters.size === 0) this.#cancelPending(key, pending, signal?.reason)
        reject(abortError(signal?.reason))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.promise.then(value => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }, error => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      })
    })
  }

  #cancelPending(key: string, pending: PendingRequest, reason: unknown): void {
    if (this.#pending.get(key) !== pending) return
    const state = this.#owners.get(key)
    if (state && state.generation === pending.generation) state.generation += 1
    this.#pending.delete(key)
    pending.controller.abort(reason ?? errorCodes.requestTimeout)
    const owner = state?.owner
    if (owner) this.prompt.cancelOwner(owner)
  }

  #abortLeases(state: OwnerState): void {
    for (const controller of state.leases) controller.abort(errorCodes.permissionDenied)
    state.leases.clear()
  }

  #state(owner: CallerIdentity): OwnerState {
    const key = ownerKey(owner)
    let state = this.#owners.get(key)
    if (!state) {
      state = { owner: copyOwner(owner), authorization: 'not-requested', generation: 0, leases: new Set() }
      this.#owners.set(key, state)
    }
    return state
  }

  #assertCurrentPlugin(owner: CallerIdentity): void {
    if (owner.type !== 'plugin' || !owner.pluginId || !owner.pluginInstanceId || !this.#isCurrentPlugin(owner)) {
      throw new ZToolsError(errorCodes.permissionDenied, '当前插件实例身份无效')
    }
  }

  #assertCurrentMain(owner: CallerIdentity): void {
    if (owner.type !== 'main' || !sameOwner(this.registry.get(owner.webContentsId), owner) ||
        !this.registry.getWebContents(owner.webContentsId) ||
        this.registry.getWebContents(owner.webContentsId)?.isDestroyed()) {
      throw new ZToolsError(errorCodes.permissionDenied, '仅当前主窗口可管理插件授权')
    }
  }

  #isCurrentPlugin(owner: CallerIdentity): boolean {
    return owner.type === 'plugin' && !!owner.pluginId && !!owner.pluginInstanceId &&
      sameOwner(this.registry.get(owner.webContentsId), owner) && !!this.registry.getWebContents(owner.webContentsId)
  }

  async #resolvePluginName(pluginId: string): Promise<string> {
    try {
      const name = await this.options.resolvePluginName?.(pluginId)
      return typeof name === 'string' && name.trim() ? name.trim().slice(0, 128) : pluginId
    } catch {
      return pluginId
    }
  }

  #notifyChanged(owner: CallerIdentity): void {
    this.#revision += 1
    try { this.options.onChanged?.(copyOwner(owner), this.#revision) } catch { /* authorization state remains authoritative */ }
  }

  #requireRunning(): void {
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
  }
}
