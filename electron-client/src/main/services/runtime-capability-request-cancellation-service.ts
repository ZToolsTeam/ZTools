import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'

interface ActiveRequest {
  readonly controller: AbortController
}

interface EarlyCancellation {
  readonly reason: 'cancel' | 'timeout'
  readonly expiresAt: number
}

function ownerKey(owner: CallerIdentity): string {
  return JSON.stringify([owner.type, owner.webContentsId, owner.pluginId ?? null, owner.pluginInstanceId ?? null])
}

/** Main-only cancellation registry for runtime_capability_request; it cannot cancel other IPC methods. */
export class RuntimeCapabilityRequestCancellationService {
  readonly #active = new Map<string, Map<string, ActiveRequest>>()
  readonly #early = new Map<string, Map<string, EarlyCancellation>>()
  #earlyCount = 0
  #stopped = false

  constructor(private readonly now = Date.now) {}

  begin(owner: CallerIdentity, messageId: string, controller: AbortController): () => void {
    this.#assertRequest(owner, messageId)
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
    this.#prune()
    const key = ownerKey(owner)
    const requests = this.#active.get(key) ?? new Map<string, ActiveRequest>()
    if (requests.has(messageId)) throw new ZToolsError(errorCodes.invalidRequest, '屏幕权限申请标识正在使用')
    const cancellations = this.#early.get(key)
    const early = cancellations?.get(messageId)
    if (early) {
      cancellations!.delete(messageId)
      this.#earlyCount -= 1
      if (cancellations!.size === 0) this.#early.delete(key)
    }
    const record = { controller }
    requests.set(messageId, record)
    this.#active.set(key, requests)
    if (early) controller.abort(this.#reasonCode(early.reason))
    return () => {
      if (requests.get(messageId) === record) requests.delete(messageId)
      if (requests.size === 0) this.#active.delete(key)
    }
  }

  cancel(owner: CallerIdentity, messageId: string, reason: 'cancel' | 'timeout'): { requested: boolean } {
    this.#assertRequest(owner, messageId)
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
    this.#prune()
    const key = ownerKey(owner)
    const active = this.#active.get(key)?.get(messageId)
    if (active) {
      active.controller.abort(this.#reasonCode(reason))
      return { requested: true }
    }
    const requests = this.#early.get(key) ?? new Map<string, EarlyCancellation>()
    if (!requests.has(messageId)) {
      if (requests.size >= 64 || this.#earlyCount >= 256) {
        throw new ZToolsError(errorCodes.pluginBusy, '屏幕权限取消请求超过上限')
      }
      requests.set(messageId, { reason, expiresAt: this.now() + 10_000 })
      this.#early.set(key, requests)
      this.#earlyCount += 1
    }
    return { requested: true }
  }

  closeOwner(owner: CallerIdentity | number): void {
    const webContentsId = typeof owner === 'number' ? owner : owner.webContentsId
    for (const [key, requests] of this.#active) {
      const requestOwner = JSON.parse(key) as unknown[]
      if (requestOwner[1] !== webContentsId) continue
      for (const request of requests.values()) request.controller.abort(errorCodes.callerDestroyed)
      this.#active.delete(key)
    }
    for (const key of this.#early.keys()) {
      const requestOwner = JSON.parse(key) as unknown[]
      if (requestOwner[1] !== webContentsId) continue
      this.#earlyCount -= this.#early.get(key)?.size ?? 0
      this.#early.delete(key)
    }
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const requests of this.#active.values()) {
      for (const request of requests.values()) request.controller.abort(errorCodes.appStopping)
    }
    this.#active.clear()
    this.#early.clear()
    this.#earlyCount = 0
  }

  #prune(): void {
    const now = this.now()
    for (const [key, requests] of this.#early) {
      for (const [messageId, request] of requests) {
        if (request.expiresAt > now) continue
        requests.delete(messageId)
        this.#earlyCount -= 1
      }
      if (requests.size === 0) this.#early.delete(key)
    }
  }

  #reasonCode(reason: 'cancel' | 'timeout'): typeof errorCodes.callerDestroyed | typeof errorCodes.requestTimeout {
    return reason === 'timeout' ? errorCodes.requestTimeout : errorCodes.callerDestroyed
  }

  #assertRequest(owner: CallerIdentity, messageId: string): void {
    if (owner.type !== 'plugin' || !owner.pluginId || !owner.pluginInstanceId ||
        !Number.isSafeInteger(owner.webContentsId) || owner.webContentsId <= 0 ||
        typeof messageId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(messageId)) {
      throw new ZToolsError(errorCodes.permissionDenied, '屏幕权限申请取消调用者无效')
    }
  }
}
