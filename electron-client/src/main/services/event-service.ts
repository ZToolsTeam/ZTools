import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { IPC_EVENT_CHANNEL } from '../../contracts/ipc.js'
import { RUNTIME_PERMISSION_CHANGED_EVENT } from '../../contracts/runtime-capability.js'
import type { EventEnvelope, EventEnvelopeParams, EventKeyParams } from '../../contracts/method-params.js'

const MAX_SUBSCRIPTIONS_PER_CALLER = 256
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

interface EventRegistry {
  send(webContentsId: number, channel: string, value: unknown): boolean
  onRemoved(listener: (webContentsId: number) => void): () => void
}

interface PendingRequest {
  callerEnvelopeId: string
  requesterId: number
  recipientIds: Set<number>
  timeout: NodeJS.Timeout
}

export type PluginExitStatus = 'COMPLETED' | 'CALLBACK_FAILED' | 'TIMEOUT' | 'OWNER_GONE' | 'NO_SUBSCRIBERS' | 'STOPPED'

interface PendingPluginExit {
  owner: CallerIdentity
  timeout: NodeJS.Timeout
  resolve: (status: PluginExitStatus) => void
}

function sameCaller(left: CallerIdentity | undefined, right: CallerIdentity): boolean {
  return !!left && left.type === right.type && left.webContentsId === right.webContentsId &&
    left.pluginId === right.pluginId && left.pluginInstanceId === right.pluginInstanceId
}

interface HostEnvelope extends Omit<EventEnvelope, 'source' | 'target'> {
  source:
    | { kind: 'page'; windowType: 'main' }
    | { kind: 'plugin'; pluginId: string; pluginInstanceId?: string }
    | { kind: 'host' }
  target:
    | { broadcast: true }
    | { pluginId: string; pluginInstanceId?: string }
    | { main: true }
}

type SubscriptionListener = (count: number) => void

function stampEnvelope(input: EventEnvelope, caller: CallerIdentity): HostEnvelope {
  if (caller.type === 'plugin' && !caller.pluginId) {
    throw new ZToolsError(errorCodes.permissionDenied, '插件调用者缺少已注册 pluginId')
  }
  const envelopeId = `host_${randomUUID()}`
  return {
    envelopeId,
    version: 'v1',
    timestamp: Date.now(),
    type: input.type,
    scope: input.scope,
    ...(input.channel ? { channel: input.channel } : {}),
    source: caller.type === 'plugin'
      ? {
          kind: 'plugin',
          pluginId: caller.pluginId as string,
          ...(caller.pluginInstanceId ? { pluginInstanceId: caller.pluginInstanceId } : {})
        }
      : { kind: 'page', windowType: 'main' },
    target: { broadcast: true },
    payload: input.payload,
    ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    ...(input.timeout ? { timeout: input.timeout } : {})
  }
}

export class EventService {
  readonly #subscriptions = new Map<number, Set<string>>()
  readonly #callers = new Map<number, CallerIdentity>()
  readonly #subscriptionListeners = new Map<string, Set<SubscriptionListener>>()
  readonly #pendingRequests = new Map<string, PendingRequest>()
  readonly #pendingPluginExits = new Map<string, PendingPluginExit>()
  readonly #removeRegistryListener: () => void
  #stopped = false

  constructor(private readonly registry: EventRegistry) {
    this.#removeRegistryListener = registry.onRemoved((webContentsId) => this.removeCaller(webContentsId))
  }

  subscribe(params: EventKeyParams, caller: CallerIdentity): { success: true; subscribed: boolean; count: number } {
    this.#requireRunning()
    const subscriptions = this.#subscriptions.get(caller.webContentsId) ?? new Set<string>()
    if (!subscriptions.has(params.key) && subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CALLER) {
      throw new ZToolsError(errorCodes.permissionDenied, '单窗口事件订阅数量已达上限')
    }
    const before = subscriptions.size
    subscriptions.add(params.key)
    this.#subscriptions.set(caller.webContentsId, subscriptions)
    this.#callers.set(caller.webContentsId, { ...caller })
    const subscribed = subscriptions.size !== before
    if (subscribed) this.#notifySubscriptionChange(params.key)
    return { success: true, subscribed, count: subscriptions.size }
  }

  unsubscribe(params: EventKeyParams, caller: CallerIdentity): { success: true; unsubscribed: boolean; count: number } {
    this.#requireRunning()
    const subscriptions = this.#subscriptions.get(caller.webContentsId)
    const unsubscribed = subscriptions?.delete(params.key) ?? false
    if (subscriptions?.size === 0) {
      this.#subscriptions.delete(caller.webContentsId)
      this.#callers.delete(caller.webContentsId)
    }
    if (unsubscribed) this.#notifySubscriptionChange(params.key)
    return { success: true, unsubscribed, count: subscriptions?.size ?? 0 }
  }

  onSubscriptionChanged(key: string, listener: SubscriptionListener): () => void {
    this.#requireRunning()
    const listeners = this.#subscriptionListeners.get(key) ?? new Set<SubscriptionListener>()
    listeners.add(listener)
    this.#subscriptionListeners.set(key, listeners)
    listener(this.#subscriptionCount(key))
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#subscriptionListeners.delete(key)
    }
  }

  subscribers(key: string): CallerIdentity[] {
    const callers: CallerIdentity[] = []
    for (const [webContentsId, subscriptions] of this.#subscriptions) {
      if (!subscriptions.has(key) && !subscriptions.has('*')) continue
      const caller = this.#callers.get(webContentsId)
      if (caller) callers.push({ ...caller })
    }
    return callers
  }

  publishHost(type: string, payload: unknown): { success: true; delivered: number } {
    this.#requireRunning()
    this.#assertOwnerOnlyHostEvent(type)
    const envelope: HostEnvelope = {
      envelopeId: `host_${randomUUID()}`,
      version: 'v1',
      timestamp: Date.now(),
      type,
      scope: 'system',
      source: { kind: 'host' },
      target: { broadcast: true },
      payload
    }
    return { success: true, delivered: this.#deliver(this.#matchingRecipients(envelope), envelope) }
  }

  publishHostToPlugin(
    type: string,
    payload: unknown,
    pluginId: string,
    pluginInstanceId?: string
  ): { success: true; delivered: number } {
    this.#requireRunning()
    this.#assertOwnerOnlyHostEvent(type)
    const envelope: HostEnvelope = {
      envelopeId: `host_${randomUUID()}`,
      version: 'v1',
      timestamp: Date.now(),
      type,
      scope: 'plugin',
      source: { kind: 'host' },
      target: {
        pluginId,
        ...(pluginInstanceId ? { pluginInstanceId } : {})
      },
      payload
    }
    return { success: true, delivered: this.#deliver(this.#matchingRecipients(envelope), envelope) }
  }

  /** Capability-bearing host events must reach only the captured owner instance. */
  publishHostToOwner(type: string, payload: unknown, owner: CallerIdentity): { success: true; delivered: number } {
    this.#requireRunning()
    const current = this.#callers.get(owner.webContentsId)
    const subscriptions = this.#subscriptions.get(owner.webContentsId)
    if (!current || !subscriptions || !['main', 'plugin'].includes(owner.type) ||
        current.type !== owner.type || current.pluginId !== owner.pluginId ||
        current.pluginInstanceId !== owner.pluginInstanceId ||
        (owner.type === 'plugin' && !owner.pluginId) ||
        (!subscriptions.has(type) && !subscriptions.has('*'))) return { success: true, delivered: 0 }
    const envelope: HostEnvelope = {
      envelopeId: 'host_' + randomUUID(), version: 'v1', timestamp: Date.now(), type,
      scope: owner.type === 'plugin' ? 'plugin' : 'system', source: { kind: 'host' },
      target: owner.type === 'plugin'
        ? { pluginId: owner.pluginId!, ...(owner.pluginInstanceId ? { pluginInstanceId: owner.pluginInstanceId } : {}) }
        : { main: true }, payload
    }
    return { success: true, delivered: this.#deliver(new Set([owner.webContentsId]), envelope) }
  }

  requestPluginExit(owner: CallerIdentity, isKill: boolean, timeoutMs = 2000): Promise<PluginExitStatus> {
    this.#requireRunning()
    if (typeof isKill !== 'boolean' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000 ||
        owner.type !== 'plugin' || !owner.pluginId || !owner.pluginInstanceId) {
      throw new ZToolsError(errorCodes.invalidRequest, '插件退出请求参数无效')
    }
    if (!sameCaller(this.#callers.get(owner.webContentsId), owner)) return Promise.resolve('OWNER_GONE')
    const subscriptions = this.#subscriptions.get(owner.webContentsId)
    if (!subscriptions?.has('plugin_out') && !subscriptions?.has('*')) return Promise.resolve('NO_SUBSCRIBERS')
    if (this.#pendingPluginExits.size >= 16) throw new ZToolsError(errorCodes.pluginBusy, '插件退出请求数量已达上限')
    const id = 'host_' + randomUUID()
    return new Promise(resolve => {
      const timeout = setTimeout(() => this.#finishPluginExit(id, 'TIMEOUT'), timeoutMs)
      this.#pendingPluginExits.set(id, { owner: { ...owner }, resolve, timeout })
      const envelope: HostEnvelope = {
        envelopeId: id, correlationId: id, version: 'v1', timestamp: Date.now(), type: 'plugin_out',
        scope: 'plugin', source: { kind: 'host' }, target: { pluginId: owner.pluginId!, pluginInstanceId: owner.pluginInstanceId! },
        payload: { isKill }, timeout: timeoutMs
      }
      if (!this.#sendEnvelope(owner.webContentsId, envelope)) this.#finishPluginExit(id, 'OWNER_GONE')
    })
  }

  #finishPluginExit(id: string, status: PluginExitStatus): void {
    const pending = this.#pendingPluginExits.get(id)
    if (!pending) return
    this.#pendingPluginExits.delete(id)
    clearTimeout(pending.timeout)
    pending.resolve(status)
  }

  publishHostToMain(type: string, payload: unknown): { success: true; delivered: number } {
    this.#requireRunning()
    this.#assertOwnerOnlyHostEvent(type)
    const envelope: HostEnvelope = {
      envelopeId: `host_${randomUUID()}`,
      version: 'v1',
      timestamp: Date.now(),
      type,
      scope: 'system',
      source: { kind: 'host' },
      target: { main: true },
      payload
    }
    return { success: true, delivered: this.#deliver(this.#matchingRecipients(envelope), envelope) }
  }

  publish(params: EventEnvelopeParams, caller: CallerIdentity): { success: true; delivered: number } {
    this.#requireRunning()
    const input = params.envelope
    this.#assertRendererMayPublish(input.type)
    if (input.replyTo) return this.#reply(input, caller)
    const envelope = stampEnvelope(input, caller)
    const recipients = this.#matchingRecipients(envelope, caller.webContentsId)
    return { success: true, delivered: this.#deliver(recipients, envelope) }
  }

  request(params: EventEnvelopeParams, caller: CallerIdentity): { success: true; delivered: number } {
    this.#requireRunning()
    const input = params.envelope
    this.#assertRendererMayPublish(input.type)
    const envelope = stampEnvelope(input, caller)
    envelope.correlationId = envelope.envelopeId
    const recipients = this.#matchingRecipients(envelope)
    if (recipients.size === 0) {
      this.#sendNoSubscribers(caller.webContentsId, input.envelopeId, envelope)
      return { success: true, delivered: 0 }
    }
    const timeoutMs = input.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS
    const timeout = setTimeout(() => this.#pendingRequests.delete(envelope.envelopeId), timeoutMs)
    const pending: PendingRequest = {
      callerEnvelopeId: input.envelopeId,
      requesterId: caller.webContentsId,
      recipientIds: new Set(recipients),
      timeout
    }
    this.#pendingRequests.set(envelope.envelopeId, pending)
    const deliveredRecipients = this.#deliverWithIds(recipients, envelope)
    if (deliveredRecipients.size === 0) {
      clearTimeout(timeout)
      this.#pendingRequests.delete(envelope.envelopeId)
      this.#sendNoSubscribers(caller.webContentsId, input.envelopeId, envelope)
      return { success: true, delivered: 0 }
    }
    pending.recipientIds = deliveredRecipients
    return { success: true, delivered: deliveredRecipients.size }
  }

  removeCaller(webContentsId: number): void {
    const subscriptions = this.#subscriptions.get(webContentsId)
    for (const [id, pending] of this.#pendingPluginExits) {
      if (pending.owner.webContentsId === webContentsId) this.#finishPluginExit(id, 'OWNER_GONE')
    }
    this.#subscriptions.delete(webContentsId)
    this.#callers.delete(webContentsId)
    for (const [envelopeId, pending] of this.#pendingRequests) {
      pending.recipientIds.delete(webContentsId)
      if (pending.requesterId === webContentsId || pending.recipientIds.size === 0) {
        clearTimeout(pending.timeout)
        this.#pendingRequests.delete(envelopeId)
      }
    }
    if (subscriptions) {
      for (const key of subscriptions) this.#notifySubscriptionChange(key)
    }
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#removeRegistryListener()
    for (const id of this.#pendingPluginExits.keys()) this.#finishPluginExit(id, 'STOPPED')
    this.#subscriptions.clear()
    this.#callers.clear()
    for (const pending of this.#pendingRequests.values()) clearTimeout(pending.timeout)
    this.#pendingRequests.clear()
    this.#subscriptionListeners.clear()
  }

  diagnostics(): { callers: number; subscriptions: number; pendingRequests: number } {
    let subscriptions = 0
    for (const callerSubscriptions of this.#subscriptions.values()) subscriptions += callerSubscriptions.size
    return { callers: this.#subscriptions.size, subscriptions, pendingRequests: this.#pendingRequests.size + this.#pendingPluginExits.size }
  }

  #reply(input: EventEnvelope, caller: CallerIdentity): { success: true; delivered: number } {
    const exitId = input.replyTo ?? ''
    const exit = this.#pendingPluginExits.get(exitId)
    if (exit) {
      if (!sameCaller(exit.owner, caller) || !sameCaller(this.#callers.get(caller.webContentsId), caller)) {
        throw new ZToolsError(errorCodes.permissionDenied, '调用者未收到对应退出请求')
      }
      if (input.type !== 'events.Ack' || !input.payload || typeof input.payload !== 'object' ||
          Array.isArray(input.payload) || typeof (input.payload as Record<string, unknown>).ok !== 'boolean') {
        throw new ZToolsError(errorCodes.invalidRequest, '退出确认格式无效')
      }
      this.#finishPluginExit(exitId, (input.payload as Record<string, unknown>).ok === true ? 'COMPLETED' : 'CALLBACK_FAILED')
      return { success: true, delivered: 1 }
    }
    const pending = this.#pendingRequests.get(input.replyTo ?? '')
    if (!pending) throw new ZToolsError(errorCodes.invalidRequest, 'replyTo 对应的请求不存在或已结束')
    if (!pending.recipientIds.has(caller.webContentsId)) {
      throw new ZToolsError(errorCodes.permissionDenied, '调用者未收到对应请求')
    }
    clearTimeout(pending.timeout)
    this.#pendingRequests.delete(input.replyTo ?? '')
    const envelope = stampEnvelope(input, caller)
    envelope.replyTo = pending.callerEnvelopeId
    return {
      success: true,
      delivered: this.#sendEnvelope(pending.requesterId, envelope) ? 1 : 0
    }
  }

  #matchingRecipients(envelope: HostEnvelope, excludedId?: number): Set<number> {
    const keys = new Set([envelope.type, '*'])
    if (envelope.channel) keys.add(`channel:${envelope.channel}`)
    const recipients = new Set<number>()
    for (const [webContentsId, subscriptions] of this.#subscriptions) {
      if (webContentsId === excludedId) continue
      const caller = this.#callers.get(webContentsId)
      if ('pluginId' in envelope.target &&
          (caller?.type !== 'plugin' || caller.pluginId?.toLowerCase() !== envelope.target.pluginId.toLowerCase())) continue
      if ('pluginInstanceId' in envelope.target &&
          caller?.pluginInstanceId !== envelope.target.pluginInstanceId) continue
      if ('main' in envelope.target && caller?.type !== 'main') continue
      if ([...keys].some((key) => subscriptions.has(key))) recipients.add(webContentsId)
    }
    return recipients
  }

  #subscriptionCount(key: string): number {
    let count = 0
    for (const subscriptions of this.#subscriptions.values()) {
      if (subscriptions.has(key) || subscriptions.has('*')) count += 1
    }
    return count
  }

  #notifySubscriptionChange(changedKey: string): void {
    const keys = changedKey === '*'
      ? [...this.#subscriptionListeners.keys()]
      : [changedKey]
    for (const key of keys) {
      const count = this.#subscriptionCount(key)
      for (const listener of this.#subscriptionListeners.get(key) ?? []) listener(count)
    }
  }

  #deliver(recipients: Set<number>, envelope: HostEnvelope): number {
    return this.#deliverWithIds(recipients, envelope).size
  }

  #deliverWithIds(recipients: Set<number>, envelope: HostEnvelope): Set<number> {
    const delivered = new Set<number>()
    for (const webContentsId of recipients) {
      if (this.#sendEnvelope(webContentsId, envelope)) delivered.add(webContentsId)
      else this.removeCaller(webContentsId)
    }
    return delivered
  }

  #sendEnvelope(webContentsId: number, envelope: HostEnvelope): boolean {
    return this.registry.send(webContentsId, IPC_EVENT_CHANNEL, {
      msgType: 'event_envelope',
      msgData: { envelope }
    })
  }

  #sendNoSubscribers(requesterId: number, callerEnvelopeId: string, request: HostEnvelope): void {
    this.#sendEnvelope(requesterId, {
      ...request,
      envelopeId: `host_${randomUUID()}`,
      timestamp: Date.now(),
      type: 'events.Ack',
      payload: { ok: false, code: 'NO_SUBSCRIBERS' },
      replyTo: callerEnvelopeId
    })
  }

  #requireRunning(): void {
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
  }

  #assertRendererMayPublish(type: string): void {
    if (type === RUNTIME_PERMISSION_CHANGED_EVENT || type === 'plugin_out' || type === 'plugin_enter') {
      throw new ZToolsError(errorCodes.permissionDenied, '该事件仅允许宿主发布')
    }
  }

  #assertOwnerOnlyHostEvent(type: string): void {
    if (type === RUNTIME_PERMISSION_CHANGED_EVENT || type === 'plugin_out' || type === 'plugin_enter') {
      throw new ZToolsError(errorCodes.permissionDenied, '该事件必须定向发送给当前调用者')
    }
  }
}
