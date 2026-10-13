import {
  canCall,
  isAllowedMethod,
  type AllowedMethod,
  type CallerIdentity,
  type CallerType
} from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import {
  isRuntimeCapabilityId,
  type CapabilityAuthorizationStatus,
  type CapabilityImplementationStatus,
  type CapabilityOsPermissionStatus,
  type RuntimeCapabilityId
} from '../../contracts/runtime-capability.js'

export type {
  CapabilityAuthorizationStatus,
  CapabilityImplementationStatus,
  CapabilityOsPermissionStatus,
  RuntimeCapabilityId
} from '../../contracts/runtime-capability.js'

export interface RuntimeCapabilityCallerGate {
  /** Existing IPC method whose caller-type policy applies to the listed callers. */
  method: AllowedMethod
  methodGateCallers: readonly CallerType[]
}

export interface RuntimeCapabilityDefinition {
  /** Stable public ID, for example `screen.capture`; never an IPC method name. */
  id: RuntimeCapabilityId
  callerGate?: RuntimeCapabilityCallerGate
}

export interface RuntimeCapabilityQueryParams {
  capability: string
}

export interface RuntimeCapabilitySnapshot {
  capability: RuntimeCapabilityId
  implementation: CapabilityImplementationStatus
  authorization: CapabilityAuthorizationStatus
  osPermission: CapabilityOsPermissionStatus
  /** Monotonic for this capability and trusted caller in this runtime instance. */
  revision: number
}

type ProviderResult<T> = T | Promise<T>

/**
 * Read-only providers. OS permission providers must only inspect an existing status;
 * they must never open a system prompt or change a permission.
 */
export interface RuntimeCapabilityProviders {
  getImplementation?(
    capability: RuntimeCapabilityId,
    signal?: AbortSignal
  ): ProviderResult<CapabilityImplementationStatus>
  getAuthorization?(
    capability: RuntimeCapabilityId,
    caller: CallerIdentity,
    signal?: AbortSignal
  ): ProviderResult<CapabilityAuthorizationStatus>
  getOsPermission?(
    capability: RuntimeCapabilityId,
    signal?: AbortSignal
  ): ProviderResult<CapabilityOsPermissionStatus>
}

interface CapabilityState {
  implementation: CapabilityImplementationStatus
  authorization: CapabilityAuthorizationStatus
  osPermission: CapabilityOsPermissionStatus
}

interface VersionedCapabilityState extends CapabilityState {
  revision: number
}

const CALLER_TYPES = new Set<CallerType>(['main', 'plugin'])
const IMPLEMENTATION_STATUSES = new Set<CapabilityImplementationStatus>([
  'supported',
  'unsupported',
  'unavailable'
])
const AUTHORIZATION_STATUSES = new Set<CapabilityAuthorizationStatus>([
  'not-requested',
  'granted',
  'denied',
  'unknown'
])
const OS_PERMISSION_STATUSES = new Set<CapabilityOsPermissionStatus>([
  'not-required',
  'not-determined',
  'granted',
  'denied',
  'restricted',
  'unknown'
])

function isCallerIdentity(value: unknown): value is CallerIdentity {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<CallerIdentity>
  return (candidate.type === 'main' || candidate.type === 'plugin') &&
    Number.isSafeInteger(candidate.webContentsId) &&
    (candidate.webContentsId ?? -1) >= 0 &&
    (candidate.pluginId === undefined || typeof candidate.pluginId === 'string') &&
    (candidate.pluginInstanceId === undefined || typeof candidate.pluginInstanceId === 'string')
}

function copyCallerIdentity(caller: CallerIdentity): CallerIdentity {
  return {
    type: caller.type,
    webContentsId: caller.webContentsId,
    ...(caller.pluginId === undefined ? {} : { pluginId: caller.pluginId }),
    ...(caller.pluginInstanceId === undefined ? {} : { pluginInstanceId: caller.pluginInstanceId })
  }
}

function callerKey(caller: CallerIdentity | undefined): string {
  if (!caller) return 'invalid-caller'
  return JSON.stringify([
    caller.type,
    caller.webContentsId,
    caller.pluginId ?? null,
    caller.pluginInstanceId ?? null
  ])
}

function capabilityStateKey(
  capability: RuntimeCapabilityId,
  caller: CallerIdentity | undefined
): string {
  return `${capability}\u0000${callerKey(caller)}`
}

function isStatus<T extends string>(value: unknown, statuses: ReadonlySet<T>): value is T {
  return typeof value === 'string' && statuses.has(value as T)
}

function copyDefinition(definition: RuntimeCapabilityDefinition): RuntimeCapabilityDefinition {
  if (typeof definition !== 'object' || definition === null || !isRuntimeCapabilityId(definition.id)) {
    throw new TypeError('运行时能力定义必须使用符合公开契约的稳定 capability ID')
  }

  if (definition.callerGate === undefined) return { id: definition.id }

  const gate = definition.callerGate
  if (
    typeof gate !== 'object' ||
    gate === null ||
    !isAllowedMethod(gate.method) ||
    !Array.isArray(gate.methodGateCallers) ||
    gate.methodGateCallers.length === 0 ||
    gate.methodGateCallers.some((callerType) => !CALLER_TYPES.has(callerType)) ||
    new Set(gate.methodGateCallers).size !== gate.methodGateCallers.length
  ) {
    throw new TypeError(`运行时能力 ${definition.id} 的 callerGate 无效`)
  }

  return {
    id: definition.id,
    callerGate: {
      method: gate.method,
      methodGateCallers: [...gate.methodGateCallers]
    }
  }
}

function queryAbortError(reason: unknown): ZToolsError {
  if (reason === errorCodes.appStopping) {
    return new ZToolsError(errorCodes.appStopping, '应用正在退出')
  }
  return new ZToolsError(errorCodes.callerDestroyed, '运行时能力查询已取消')
}

function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(queryAbortError(signal.reason))
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(queryAbortError(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
}

/**
 * Produces informational snapshots only. Callers must re-check authorization,
 * implementation availability, and OS permission when performing each operation.
 */
export class RuntimeCapabilityService {
  readonly #definitions = new Map<RuntimeCapabilityId, RuntimeCapabilityDefinition>()
  readonly #snapshots = new Map<string, VersionedCapabilityState>()
  readonly #ownerSnapshotKeys = new Map<number, Set<string>>()
  readonly #ownerControllers = new Map<number, Set<AbortController>>()
  readonly #activeControllers = new Set<AbortController>()
  readonly #ownerCloseEpochs = new Map<number, number>()
  readonly #closingOwners = new Set<number>()
  readonly #latestQueries = new Map<string, number>()
  #nextRevision = 0
  #nextQuerySequence = 0
  #stopped = false

  constructor(
    definitions: readonly RuntimeCapabilityDefinition[],
    private readonly providers: RuntimeCapabilityProviders = {}
  ) {
    if (!Array.isArray(definitions)) throw new TypeError('必须注入显式运行时能力目录')
    for (const source of definitions) {
      const definition = copyDefinition(source)
      if (this.#definitions.has(definition.id)) {
        throw new TypeError(`运行时能力目录存在重复 ID: ${definition.id}`)
      }
      this.#definitions.set(definition.id, definition)
    }
  }

  async getSnapshot(
    params: RuntimeCapabilityQueryParams,
    caller: CallerIdentity,
    signal?: AbortSignal
  ): Promise<RuntimeCapabilitySnapshot> {
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
    const capabilityValue = typeof params === 'object' && params !== null
      ? params.capability
      : undefined
    if (!isRuntimeCapabilityId(capabilityValue)) {
      throw new ZToolsError(errorCodes.invalidRequest, '未知运行时能力')
    }
    const definition = this.#definitions.get(capabilityValue)
    if (!definition) throw new ZToolsError(errorCodes.invalidRequest, '未知运行时能力')

    const trustedCaller = isCallerIdentity(caller) ? copyCallerIdentity(caller) : undefined
    const snapshotKey = capabilityStateKey(definition.id, trustedCaller)
    const controller = new AbortController()
    const ownerId = trustedCaller?.webContentsId
    const ownerEpoch = ownerId === undefined ? 0 : (this.#ownerCloseEpochs.get(ownerId) ?? 0)
    const querySequence = ++this.#nextQuerySequence
    this.#latestQueries.set(snapshotKey, querySequence)
    this.#rememberSnapshotKey(snapshotKey, ownerId)
    this.#activeControllers.add(controller)
    if (ownerId !== undefined) {
      const controllers = this.#ownerControllers.get(ownerId) ?? new Set<AbortController>()
      controllers.add(controller)
      this.#ownerControllers.set(ownerId, controllers)
    }
    const abortFromCaller = () => controller.abort(signal?.reason)
    if (signal?.aborted) abortFromCaller()
    else signal?.addEventListener('abort', abortFromCaller, { once: true })

    try {
      const reads = Promise.all([
        this.#readImplementation(definition.id, controller.signal),
        this.#readAuthorization(definition, trustedCaller, controller.signal),
        this.#readOsPermission(definition.id, controller.signal)
      ])
      const [implementation, authorization, osPermission] = await awaitWithAbort(reads, controller.signal)
      this.#assertQueryActive(controller.signal, ownerId, ownerEpoch)
      const state: CapabilityState = { implementation, authorization, osPermission }
      const previous = this.#snapshots.get(snapshotKey)
      const currentQuerySequence = this.#latestQueries.get(snapshotKey)
      if (currentQuerySequence !== querySequence && previous) {
        return { capability: definition.id, ...previous }
      }
      const unchanged = previous !== undefined &&
        previous.implementation === state.implementation &&
        previous.authorization === state.authorization &&
        previous.osPermission === state.osPermission
      const revision = unchanged ? previous.revision : ++this.#nextRevision
      if (!unchanged) this.#snapshots.set(snapshotKey, { ...state, revision })

      return { capability: definition.id, ...state, revision }
    } finally {
      signal?.removeEventListener('abort', abortFromCaller)
      this.#activeControllers.delete(controller)
      if (ownerId !== undefined) this.#releaseOwnerController(ownerId, controller)
      if (this.#latestQueries.get(snapshotKey) === querySequence) {
        this.#latestQueries.delete(snapshotKey)
      }
    }
  }

  closeOwner(owner: CallerIdentity | number): void {
    const ownerId = typeof owner === 'number' ? owner : owner.webContentsId
    if (!Number.isSafeInteger(ownerId) || ownerId < 0) return
    this.#ownerCloseEpochs.set(ownerId, (this.#ownerCloseEpochs.get(ownerId) ?? 0) + 1)
    this.#closingOwners.add(ownerId)
    for (const controller of this.#ownerControllers.get(ownerId) ?? []) {
      controller.abort(errorCodes.callerDestroyed)
    }
    for (const key of this.#ownerSnapshotKeys.get(ownerId) ?? []) {
      this.#snapshots.delete(key)
      this.#latestQueries.delete(key)
    }
    this.#ownerSnapshotKeys.delete(ownerId)
    this.#finishOwnerCloseEpoch(ownerId)
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const controller of this.#activeControllers) controller.abort(errorCodes.appStopping)
    this.#snapshots.clear()
    this.#ownerSnapshotKeys.clear()
    this.#ownerControllers.clear()
    this.#ownerCloseEpochs.clear()
    this.#closingOwners.clear()
    this.#latestQueries.clear()
  }

  async #readImplementation(
    capability: RuntimeCapabilityId,
    signal: AbortSignal
  ): Promise<CapabilityImplementationStatus> {
    if (!this.providers.getImplementation) return 'unavailable'
    try {
      const value = await this.providers.getImplementation(capability, signal)
      return isStatus(value, IMPLEMENTATION_STATUSES) ? value : 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  async #readAuthorization(
    definition: RuntimeCapabilityDefinition,
    caller: CallerIdentity | undefined,
    signal: AbortSignal
  ): Promise<CapabilityAuthorizationStatus> {
    if (!caller) return 'denied'
    const gate = definition.callerGate
    if (
      gate?.methodGateCallers.includes(caller.type) &&
      !canCall(gate.method, caller)
    ) {
      return 'denied'
    }
    if (!this.providers.getAuthorization) return 'unknown'
    try {
      const value = await this.providers.getAuthorization(definition.id, caller, signal)
      return isStatus(value, AUTHORIZATION_STATUSES) ? value : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  async #readOsPermission(
    capability: RuntimeCapabilityId,
    signal: AbortSignal
  ): Promise<CapabilityOsPermissionStatus> {
    if (!this.providers.getOsPermission) return 'unknown'
    try {
      const value = await this.providers.getOsPermission(capability, signal)
      return isStatus(value, OS_PERMISSION_STATUSES) ? value : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  #assertQueryActive(signal: AbortSignal, ownerId: number | undefined, ownerEpoch: number): void {
    if (signal.aborted) throw queryAbortError(signal.reason)
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
    if (ownerId !== undefined && (this.#ownerCloseEpochs.get(ownerId) ?? 0) !== ownerEpoch) {
      throw new ZToolsError(errorCodes.callerDestroyed, '运行时能力查询已取消')
    }
  }

  #rememberSnapshotKey(snapshotKey: string, ownerId: number | undefined): void {
    if (ownerId === undefined) return
    const keys = this.#ownerSnapshotKeys.get(ownerId) ?? new Set<string>()
    keys.add(snapshotKey)
    this.#ownerSnapshotKeys.set(ownerId, keys)
  }

  #releaseOwnerController(ownerId: number, controller: AbortController): void {
    const controllers = this.#ownerControllers.get(ownerId)
    controllers?.delete(controller)
    if (controllers?.size === 0) this.#ownerControllers.delete(ownerId)
    this.#finishOwnerCloseEpoch(ownerId)
  }

  #finishOwnerCloseEpoch(ownerId: number): void {
    if (!this.#closingOwners.has(ownerId) || this.#ownerControllers.has(ownerId)) return
    this.#closingOwners.delete(ownerId)
    this.#ownerCloseEpochs.delete(ownerId)
  }
}
