import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes } from '../../contracts/errors.js'
import {
  RUNTIME_PERMISSION_CHANGED_EVENT,
  type RuntimeCapabilityId
} from '../../contracts/runtime-capability.js'
import type { RuntimeCapabilitySnapshot } from './runtime-capability-service.js'

export { RUNTIME_PERMISSION_CHANGED_EVENT }

const MONITORED_CAPABILITIES: readonly RuntimeCapabilityId[] = Object.freeze(['screen.capture'])
const DEFAULT_QUERY_TIMEOUT_MS = 5_000

interface RuntimePermissionEventPort {
  onSubscriptionChanged(key: string, listener: (count: number) => void): () => void
  subscribers(key: string): CallerIdentity[]
  publishHostToOwner(type: string, payload: unknown, owner: CallerIdentity): { success: true; delivered: number }
}

interface RuntimePermissionCapabilityPort {
  getSnapshot(
    params: { capability: RuntimeCapabilityId },
    caller: CallerIdentity,
    signal?: AbortSignal
  ): Promise<RuntimeCapabilitySnapshot>
  closeOwner?(owner: CallerIdentity | number): void
}

export interface RuntimePermissionMonitorOptions {
  queryTimeoutMs?: number
}

interface OwnerPermissionState {
  readonly owner: CallerIdentity
  readonly snapshots: Map<RuntimeCapabilityId, number>
  controller: AbortController | undefined
  pending: Promise<void> | undefined
  refreshAgain: boolean
}

function ownerKey(owner: CallerIdentity): string {
  return JSON.stringify([
    owner.type,
    owner.webContentsId,
    owner.pluginId ?? null,
    owner.pluginInstanceId ?? null
  ])
}

function sameOwner(left: CallerIdentity, right: CallerIdentity): boolean {
  return left.type === right.type && left.webContentsId === right.webContentsId &&
    left.pluginId === right.pluginId && left.pluginInstanceId === right.pluginInstanceId
}

function isOwnerIdentity(value: unknown): value is CallerIdentity {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<CallerIdentity>
  if ((candidate.type !== 'main' && candidate.type !== 'plugin') ||
      !Number.isSafeInteger(candidate.webContentsId) || (candidate.webContentsId ?? -1) < 0) return false
  if (candidate.type === 'plugin' &&
      (typeof candidate.pluginId !== 'string' || candidate.pluginId.length === 0 ||
       (candidate.pluginInstanceId !== undefined && typeof candidate.pluginInstanceId !== 'string'))) return false
  return candidate.type === 'plugin' ||
    (candidate.pluginId === undefined && candidate.pluginInstanceId === undefined)
}

/**
 * Refreshes read-only permission snapshots when a subscribed owner returns to the app.
 * It never requests or grants a permission; the event payload is only a refresh hint.
 */
export class RuntimePermissionMonitorService {
  readonly #owners = new Map<string, OwnerPermissionState>()
  readonly #queryTimeoutMs: number
  #removeSubscriptionListener: (() => void) | undefined
  #started = false
  #stopped = false

  constructor(
    private readonly events: RuntimePermissionEventPort,
    private readonly capabilities: RuntimePermissionCapabilityPort,
    options: RuntimePermissionMonitorOptions = {}
  ) {
    const timeout = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) {
      throw new TypeError('权限状态查询超时必须是 1 到 60000 毫秒的整数')
    }
    this.#queryTimeoutMs = timeout
  }

  start(): void {
    if (this.#stopped) return
    if (this.#started) return
    this.#started = true
    this.#removeSubscriptionListener = this.events.onSubscriptionChanged(
      RUNTIME_PERMISSION_CHANGED_EVENT,
      () => this.#reconcileSubscribers()
    )
  }

  /** Establishes a silent baseline when this owner subscribes to the host event. */
  onOwnerSubscribed(owner: CallerIdentity): Promise<void> {
    if (!this.#isActive() || !isOwnerIdentity(owner) || !this.#isSubscribed(owner)) return Promise.resolve()
    const key = ownerKey(owner)
    let state = this.#owners.get(key)
    if (!state) {
      state = {
        owner: { ...owner }, snapshots: new Map(), controller: undefined,
        pending: undefined, refreshAgain: false
      }
      this.#owners.set(key, state)
    }
    return this.#queueRefresh(state)
  }

  /** Called by the host when a registered main or plugin window receives focus. */
  refreshOwner(owner: CallerIdentity): Promise<void> {
    return this.onOwnerSubscribed(owner)
  }

  /** Called by the host after resume; only current event subscribers are queried. */
  async refreshSubscribedOwners(): Promise<void> {
    if (!this.#isActive()) return
    const owners = this.events.subscribers(RUNTIME_PERMISSION_CHANGED_EVENT)
      .filter(isOwnerIdentity)
    await Promise.all(owners.map((owner) => this.refreshOwner(owner)))
  }

  /** Releases monitor and capability snapshots for a destroyed WebContents owner. */
  closeOwner(owner: CallerIdentity | number): void {
    const webContentsId = typeof owner === 'number' ? owner : owner.webContentsId
    if (!Number.isSafeInteger(webContentsId) || webContentsId < 0) return
    for (const [key, state] of this.#owners) {
      if (state.owner.webContentsId !== webContentsId) continue
      state.controller?.abort(errorCodes.callerDestroyed)
      this.#owners.delete(key)
    }
    this.capabilities.closeOwner?.(webContentsId)
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#removeSubscriptionListener?.()
    this.#removeSubscriptionListener = undefined
    for (const state of this.#owners.values()) state.controller?.abort(errorCodes.appStopping)
    this.#owners.clear()
  }

  #reconcileSubscribers(): void {
    if (!this.#isActive()) return
    const currentOwners = new Map<string, CallerIdentity>()
    for (const owner of this.events.subscribers(RUNTIME_PERMISSION_CHANGED_EVENT)) {
      if (!isOwnerIdentity(owner)) continue
      currentOwners.set(ownerKey(owner), owner)
    }

    for (const [key, owner] of currentOwners) {
      if (this.#owners.has(key)) continue
      const state: OwnerPermissionState = {
        owner: { ...owner },
        snapshots: new Map(),
        controller: undefined,
        pending: undefined,
        refreshAgain: false
      }
      this.#owners.set(key, state)
      void this.#queueRefresh(state).catch(() => {})
    }
    for (const [key, state] of this.#owners) {
      if (currentOwners.has(key)) continue
      state.controller?.abort(errorCodes.callerDestroyed)
      this.#owners.delete(key)
    }
  }

  #queueRefresh(state: OwnerPermissionState): Promise<void> {
    if (!this.#isCurrent(state)) return Promise.resolve()
    if (state.pending) {
      state.refreshAgain = true
      return state.pending
    }

    let tracked: Promise<void>
    const task = Promise.resolve().then(async () => {
      while (this.#isCurrent(state)) {
        await this.#readOwnerSnapshot(state)
        if (!state.refreshAgain || !this.#isCurrent(state)) break
        state.refreshAgain = false
      }
    })
    tracked = task.finally(() => {
      if (state.pending === tracked) state.pending = undefined
      if (state.controller?.signal.aborted) state.controller = undefined
    })
    state.pending = tracked
    return tracked
  }

  async #readOwnerSnapshot(state: OwnerPermissionState): Promise<void> {
    if (!this.#isCurrent(state)) return
    const controller = new AbortController()
    state.controller = controller
    const timeout = setTimeout(() => controller.abort(errorCodes.requestTimeout), this.#queryTimeoutMs)
    try {
      const snapshots = await Promise.all(MONITORED_CAPABILITIES.map((capability) =>
        this.capabilities.getSnapshot({ capability }, state.owner, controller.signal)
      ))
      if (controller.signal.aborted || !this.#isCurrent(state)) return
      for (const snapshot of snapshots) this.#applySnapshot(state, snapshot)
    } catch {
      // A failed or timed-out read leaves the last known state untouched for the next focus.
    } finally {
      clearTimeout(timeout)
      if (state.controller === controller) state.controller = undefined
    }
  }

  #applySnapshot(state: OwnerPermissionState, snapshot: RuntimeCapabilitySnapshot): void {
    const previousRevision = state.snapshots.get(snapshot.capability)
    state.snapshots.set(snapshot.capability, snapshot.revision)
    if (previousRevision === undefined || previousRevision === snapshot.revision) return
    this.events.publishHostToOwner(
      RUNTIME_PERMISSION_CHANGED_EVENT,
      { capability: snapshot.capability, revision: snapshot.revision },
      state.owner
    )
  }

  #isSubscribed(owner: CallerIdentity): boolean {
    return this.events.subscribers(RUNTIME_PERMISSION_CHANGED_EVENT)
      .some((subscriber) => isOwnerIdentity(subscriber) && sameOwner(subscriber, owner))
  }

  #isCurrent(state: OwnerPermissionState): boolean {
    return this.#isActive() && this.#owners.get(ownerKey(state.owner)) === state &&
      this.#isSubscribed(state.owner)
  }

  #isActive(): boolean {
    return this.#started && !this.#stopped
  }
}
