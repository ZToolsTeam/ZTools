import type { Session, WebContents } from 'electron'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { SDK_HOST_MAXIMUM_CONTRACT_VERSION } from '../../contracts/protocol-versions.js'
import { validateSdkApiHostMaximum, validateSdkApiLane, type SdkApiLane } from '../../contracts/sdk-api-lane.js'

export interface WindowRegistryOptions {
  /** Test injection only; production defaults to the current host SDK maximum. */
  readonly hostMaximumSdkContractVersion?: number
}

function ownerKey(caller: CallerIdentity): string {
  return JSON.stringify([caller.type, caller.webContentsId, caller.pluginId ?? null, caller.pluginInstanceId ?? null])
}

function sameOwner(left: CallerIdentity | undefined, right: CallerIdentity): boolean {
  return !!left && left.type === right.type && left.webContentsId === right.webContentsId &&
    left.pluginId === right.pluginId && left.pluginInstanceId === right.pluginInstanceId
}

export class WindowRegistry {
  readonly #callers = new Map<number, CallerIdentity>()
  readonly #webContents = new Map<number, WebContents>()
  readonly #sdkApiLanes = new Map<string, SdkApiLane>()
  readonly #removedListeners = new Set<(webContentsId: number) => void>()
  readonly #hostMaximumSdkContractVersion: SdkApiLane

  constructor(options: WindowRegistryOptions = {}) {
    this.#hostMaximumSdkContractVersion = validateSdkApiHostMaximum(
      options.hostMaximumSdkContractVersion ?? SDK_HOST_MAXIMUM_CONTRACT_VERSION
    )
  }

  registerMain(webContents: WebContents): CallerIdentity {
    const identity: CallerIdentity = { type: 'main', webContentsId: webContents.id }
    return this.#register(webContents, identity, 1)
  }

  /**
   * The optional lane is Main-derived from the selected, validated install target;
   * it must never come from Renderer request data. Omission preserves SDK1 behavior.
   */
  registerPlugin(
    webContents: WebContents,
    pluginId: string,
    pluginInstanceId: string,
    sdkApiLane: SdkApiLane = 1
  ): CallerIdentity {
    const trustedLane = validateSdkApiLane(sdkApiLane, this.#hostMaximumSdkContractVersion)
    const identity: CallerIdentity = {
      type: 'plugin',
      webContentsId: webContents.id,
      pluginId,
      pluginInstanceId
    }
    return this.#register(webContents, identity, trustedLane)
  }

  #register(webContents: WebContents, identity: CallerIdentity, sdkApiLane: SdkApiLane): CallerIdentity {
    if (this.#callers.has(webContents.id)) {
      throw new Error(`WebContents 已注册: ${webContents.id}`)
    }
    const registeredIdentity = Object.freeze({ ...identity })
    this.#callers.set(webContents.id, registeredIdentity)
    this.#webContents.set(webContents.id, webContents)
    this.#sdkApiLanes.set(ownerKey(registeredIdentity), sdkApiLane)
    webContents.once('destroyed', () => {
      if (this.#webContents.get(webContents.id) !== webContents ||
          !sameOwner(this.#callers.get(webContents.id), registeredIdentity)) return
      this.#remove(webContents.id)
    })
    return registeredIdentity
  }

  getSdkApiLane(caller: CallerIdentity | undefined): SdkApiLane | undefined {
    if (!caller) return undefined
    if (!sameOwner(this.#callers.get(caller.webContentsId), caller)) return undefined
    if (!this.getWebContents(caller.webContentsId)) return undefined
    return this.#sdkApiLanes.get(ownerKey(caller))
  }

  get(webContentsId: number): CallerIdentity | undefined {
    return this.#callers.get(webContentsId)
  }

  getSession(webContentsId: number): Session | undefined {
    const target = this.#webContents.get(webContentsId)
    if (!target || target.isDestroyed()) {
      this.#remove(webContentsId)
      return undefined
    }
    return target.session
  }

  getWebContents(webContentsId: number): WebContents | undefined {
    const target = this.#webContents.get(webContentsId)
    if (!target || target.isDestroyed()) {
      this.#remove(webContentsId)
      return undefined
    }
    return target
  }

  send(webContentsId: number, channel: string, value: unknown): boolean {
    const target = this.#webContents.get(webContentsId)
    if (!target || target.isDestroyed()) {
      this.#remove(webContentsId)
      return false
    }
    try {
      target.send(channel, value)
      return true
    } catch {
      this.#remove(webContentsId)
      return false
    }
  }

  onRemoved(listener: (webContentsId: number) => void): () => void {
    this.#removedListeners.add(listener)
    return () => this.#removedListeners.delete(listener)
  }

  clear(): void {
    const ids = [...this.#callers.keys()]
    this.#callers.clear()
    this.#webContents.clear()
    this.#sdkApiLanes.clear()
    const listenerErrors: unknown[] = []
    for (const id of ids) listenerErrors.push(...this.#notifyRemoved(id))
    this.#removedListeners.clear()
    this.#reportRemovedListenerErrors(listenerErrors, 'WindowRegistry.clear notification failed')
  }

  #remove(webContentsId: number): void {
    const caller = this.#callers.get(webContentsId)
    const removed = this.#callers.delete(webContentsId)
    this.#webContents.delete(webContentsId)
    if (caller) this.#sdkApiLanes.delete(ownerKey(caller))
    if (removed) {
      this.#reportRemovedListenerErrors(
        this.#notifyRemoved(webContentsId),
        `WindowRegistry removal notification failed for WebContents ${webContentsId}`
      )
    }
  }

  #notifyRemoved(webContentsId: number): unknown[] {
    const errors: unknown[] = []
    for (const listener of [...this.#removedListeners]) {
      try {
        listener(webContentsId)
      } catch (error) {
        errors.push(error)
      }
    }
    return errors
  }

  #reportRemovedListenerErrors(errors: readonly unknown[], message: string): void {
    if (errors.length === 0) return
    console.error('[WindowRegistry] onRemoved listener failed', new AggregateError(errors, message))
  }
}
