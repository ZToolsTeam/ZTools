import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'

const NETWORK_METHOD = 'network_http_request' as const
const TOMBSTONE_TTL_MS = 10_000
const MAX_EARLY_PER_OWNER = 64
const MAX_EARLY_TOTAL = 256
const MAX_TERMINAL_PER_OWNER = 64
const MAX_TERMINAL_TOTAL = 256

interface ActiveRequest {
  readonly method: typeof NETWORK_METHOD
  readonly controller: AbortController
}

interface EarlyCancellation {
  readonly reason: 'cancel' | 'timeout'
  readonly expiresAt: number
}

interface TerminalRequest {
  readonly expiresAt: number
}

function ownerKey(owner: CallerIdentity): string {
  return JSON.stringify([owner.type, owner.webContentsId, owner.pluginId ?? null, owner.pluginInstanceId ?? null])
}

function ownerWebContentsId(key: string): number | undefined {
  try {
    const value: unknown = JSON.parse(key)
    return Array.isArray(value) && Number.isSafeInteger(value[1]) ? value[1] as number : undefined
  } catch {
    return undefined
  }
}

/** Main-only cancellation registry scoped to the single network_http_request method. */
export class NetworkRequestCancellationService {
  readonly #active = new Map<string, Map<string, ActiveRequest>>()
  readonly #early = new Map<string, Map<string, EarlyCancellation>>()
  readonly #terminal = new Map<string, Map<string, TerminalRequest>>()
  #earlyCount = 0
  #terminalCount = 0
  #stopped = false

  constructor(private readonly now = Date.now) {}

  begin(
    owner: CallerIdentity,
    method: typeof NETWORK_METHOD,
    messageId: string,
    controller: AbortController
  ): () => void {
    this.#assertRequest(owner, method, messageId)
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
    this.#prune()
    const key = ownerKey(owner)
    const requests = this.#active.get(key) ?? new Map<string, ActiveRequest>()
    if (requests.has(messageId) || this.#terminal.get(key)?.has(messageId)) {
      throw new ZToolsError(errorCodes.invalidRequest, '网络请求标识正在使用或已结束')
    }

    const cancellations = this.#early.get(key)
    const early = cancellations?.get(messageId)
    if (early) {
      cancellations!.delete(messageId)
      this.#earlyCount -= 1
      if (cancellations!.size === 0) this.#early.delete(key)
    }

    const record: ActiveRequest = { method, controller }
    requests.set(messageId, record)
    this.#active.set(key, requests)
    if (early) controller.abort(this.#reasonCode(early.reason))

    let released = false
    return () => {
      if (released) return
      released = true
      if (this.#active.get(key) !== requests || requests.get(messageId) !== record) return
      requests.delete(messageId)
      if (requests.size === 0) this.#active.delete(key)
      if (!this.#stopped) this.#rememberTerminal(key, messageId)
    }
  }

  cancel(
    owner: CallerIdentity,
    messageId: string,
    reason: 'cancel' | 'timeout'
  ): { readonly accepted: boolean; readonly terminal: boolean } {
    this.#assertRequest(owner, NETWORK_METHOD, messageId)
    if (reason !== 'cancel' && reason !== 'timeout') {
      throw new ZToolsError(errorCodes.invalidRequest, '网络请求取消原因无效')
    }
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
    this.#prune()
    const key = ownerKey(owner)
    const active = this.#active.get(key)?.get(messageId)
    if (active) {
      if (active.method !== NETWORK_METHOD) {
        throw new ZToolsError(errorCodes.permissionDenied, '网络请求取消目标无效')
      }
      if (!active.controller.signal.aborted) active.controller.abort(this.#reasonCode(reason))
      // Acceptance means the Main controller was signaled. Transport completion is still awaited separately.
      return { accepted: true, terminal: false }
    }
    if (this.#terminal.get(key)?.has(messageId)) return { accepted: false, terminal: true }

    const requests = this.#early.get(key) ?? new Map<string, EarlyCancellation>()
    if (!requests.has(messageId)) {
      if (requests.size >= MAX_EARLY_PER_OWNER || this.#earlyCount >= MAX_EARLY_TOTAL) {
        throw new ZToolsError(errorCodes.pluginBusy, '网络请求取消标记超过上限')
      }
      requests.set(messageId, { reason, expiresAt: this.now() + TOMBSTONE_TTL_MS })
      this.#early.set(key, requests)
      this.#earlyCount += 1
    }
    return { accepted: true, terminal: false }
  }

  /** Drop requests and tombstones when a WebContents is destroyed or replaced. */
  closeOwner(webContentsId: number): void {
    if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return
    for (const [key, requests] of this.#active) {
      if (ownerWebContentsId(key) !== webContentsId) continue
      for (const request of requests.values()) request.controller.abort(errorCodes.callerDestroyed)
      this.#active.delete(key)
    }
    this.#deleteOwnerRecords(this.#early, webContentsId, count => { this.#earlyCount -= count })
    this.#deleteOwnerRecords(this.#terminal, webContentsId, count => { this.#terminalCount -= count })
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    for (const requests of this.#active.values()) {
      for (const request of requests.values()) request.controller.abort(errorCodes.appStopping)
    }
    this.#active.clear()
    this.#early.clear()
    this.#terminal.clear()
    this.#earlyCount = 0
    this.#terminalCount = 0
  }

  #deleteOwnerRecords<RecordValue>(
    records: Map<string, Map<string, RecordValue>>,
    webContentsId: number,
    removed: (count: number) => void
  ): void {
    for (const key of records.keys()) {
      if (ownerWebContentsId(key) !== webContentsId) continue
      removed(records.get(key)?.size ?? 0)
      records.delete(key)
    }
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
    for (const [key, requests] of this.#terminal) {
      for (const [messageId, request] of requests) {
        if (request.expiresAt > now) continue
        requests.delete(messageId)
        this.#terminalCount -= 1
      }
      if (requests.size === 0) this.#terminal.delete(key)
    }
  }

  #rememberTerminal(key: string, messageId: string): void {
    const requests = this.#terminal.get(key) ?? new Map<string, TerminalRequest>()
    if (requests.has(messageId)) return
    while (requests.size >= MAX_TERMINAL_PER_OWNER) {
      const oldest = requests.keys().next().value as string | undefined
      if (oldest === undefined) break
      requests.delete(oldest)
      this.#terminalCount -= 1
    }
    while (this.#terminalCount >= MAX_TERMINAL_TOTAL) this.#evictOldestTerminal()
    requests.set(messageId, { expiresAt: this.now() + TOMBSTONE_TTL_MS })
    this.#terminal.set(key, requests)
    this.#terminalCount += 1
  }

  #evictOldestTerminal(): void {
    for (const [key, requests] of this.#terminal) {
      const oldest = requests.keys().next().value as string | undefined
      if (oldest === undefined) continue
      requests.delete(oldest)
      this.#terminalCount -= 1
      if (requests.size === 0) this.#terminal.delete(key)
      return
    }
  }

  #reasonCode(reason: 'cancel' | 'timeout'): typeof errorCodes.callerDestroyed | typeof errorCodes.requestTimeout {
    return reason === 'timeout' ? errorCodes.requestTimeout : errorCodes.callerDestroyed
  }

  #assertRequest(owner: CallerIdentity, method: typeof NETWORK_METHOD, messageId: string): void {
    const validOwner = owner.type === 'main'
      ? owner.pluginId === undefined && owner.pluginInstanceId === undefined
      : owner.type === 'plugin' && typeof owner.pluginId === 'string' && owner.pluginId.length > 0 &&
        typeof owner.pluginInstanceId === 'string' && owner.pluginInstanceId.length > 0
    if (!validOwner || method !== NETWORK_METHOD || !Number.isSafeInteger(owner.webContentsId) || owner.webContentsId <= 0 ||
        typeof messageId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(messageId)) {
      throw new ZToolsError(errorCodes.permissionDenied, '网络请求取消调用者无效')
    }
  }
}
