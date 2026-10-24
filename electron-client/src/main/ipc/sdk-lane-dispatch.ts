import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, toPublicError, ZToolsError } from '../../contracts/errors.js'
import { SDK_HOST_MAXIMUM_CONTRACT_VERSION } from '../../contracts/protocol-versions.js'
import type { ZToolsResponse } from '../../contracts/ipc.js'
import { parseSdkLaneHandshake, type SdkLaneHandshake } from '../../contracts/sdk-lane-handshake.js'
import { selectSdkMethodRoute } from '../../contracts/sdk-method-routing.js'
import { validateSdkApiLane, type SdkApiLane } from '../../contracts/sdk-api-lane.js'

export interface SdkLaneTarget {
  readonly id: number
  isDestroyed(): boolean
  readonly mainFrame: SdkLaneFrame
}

export interface SdkLaneFrame {
  readonly url: string
}

export interface SdkLaneIpcEvent {
  readonly sender: SdkLaneTarget
  readonly senderFrame: SdkLaneFrame | null
}

export interface SdkLaneRegistry {
  get(webContentsId: number): CallerIdentity | undefined
  getWebContents(webContentsId: number): SdkLaneTarget | undefined
  getSdkApiLane(caller: CallerIdentity | undefined): SdkApiLane | undefined
}

export interface TrustedSdkLaneContext {
  readonly registry: SdkLaneRegistry
  readonly event: SdkLaneIpcEvent
  readonly target: SdkLaneTarget
  readonly frame: SdkLaneFrame
  readonly caller: CallerIdentity
  readonly lane: SdkApiLane
}

export type SdkLaneDispatchDecision =
  | { readonly kind: 'legacy'; readonly lane?: SdkApiLane; readonly context?: TrustedSdkLaneContext }
  | { readonly kind: 'reference'; readonly context: TrustedSdkLaneContext }
  | { readonly kind: 'reject'; readonly code: typeof errorCodes.notSupported | typeof errorCodes.permissionDenied }

export interface SdkLaneReferenceCallPort {
  call(event: SdkLaneIpcEvent, value: unknown): Promise<ZToolsResponse>
}

function sameOwner(left: CallerIdentity | undefined, right: CallerIdentity): boolean {
  return !!left && left.type === right.type && left.webContentsId === right.webContentsId &&
    left.pluginId === right.pluginId && left.pluginInstanceId === right.pluginInstanceId
}

function pageMatchesCaller(urlValue: string, caller: CallerIdentity): boolean {
  let url: URL
  try { url = new URL(urlValue) } catch { return false }
  if (url.protocol !== 'ztools:' || url.username || url.password || url.port) return false
  if (caller.type === 'main') return !caller.pluginId && !caller.pluginInstanceId && url.hostname === 'web'
  if (caller.type !== 'plugin' || !caller.pluginId || !caller.pluginInstanceId || url.hostname !== 'plugins') return false
  let pluginId: string
  try { pluginId = decodeURIComponent(url.pathname.split('/')[1] ?? '') } catch { return false }
  return pluginId === caller.pluginId
}

/** Main-derived full owner, live WebContents, main frame, and page URL; never reads request fields. */
export function getTrustedSdkLaneContext(
  registry: SdkLaneRegistry,
  event: SdkLaneIpcEvent
): TrustedSdkLaneContext | undefined {
  try {
    const caller = registry.get(event.sender.id)
    const target = caller && registry.getWebContents(caller.webContentsId)
    const frame = event.senderFrame
    if (!caller || !target || target !== event.sender || target.isDestroyed() ||
        caller.webContentsId !== target.id || !frame || frame !== target.mainFrame ||
        !pageMatchesCaller(frame.url, caller)) return undefined
    const lane = validateSdkApiLane(registry.getSdkApiLane(caller), SDK_HOST_MAXIMUM_CONTRACT_VERSION)
    return Object.freeze({
      registry,
      event,
      target,
      frame,
      caller: Object.freeze({ ...caller }),
      lane
    })
  } catch {
    return undefined
  }
}

/** Recheck the same owner generation, exact WebContents/frame, current URL, and selected lane. */
export function isCurrentTrustedSdkLaneContext(context: TrustedSdkLaneContext): boolean {
  try {
    const current = context.registry.get(context.caller.webContentsId)
    return context.event.sender === context.target && context.event.senderFrame === context.frame &&
      context.registry.getWebContents(context.caller.webContentsId) === context.target &&
      !context.target.isDestroyed() && context.target.mainFrame === context.frame &&
      pageMatchesCaller(context.frame.url, context.caller) && sameOwner(current, context.caller) &&
      context.registry.getSdkApiLane(current) === context.lane
  } catch {
    return false
  }
}

function requestMethod(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'method')) return undefined
  try { return (value as Record<string, unknown>).method } catch { return undefined }
}

/**
 * Choose a transport before parsing the full envelope. Lane 1 keeps the legacy parser;
 * only an authenticated lane 2 owner can select the reference parser or stable lane 2 list.
 */
export function selectTrustedSdkLaneDispatch(
  registry: SdkLaneRegistry,
  event: SdkLaneIpcEvent,
  value: unknown,
  hostMaximum: unknown
): SdkLaneDispatchDecision {
  const caller = registry.get(event.sender.id)
  if (!caller) return { kind: 'legacy' }

  let registeredLane: SdkApiLane
  try { registeredLane = validateSdkApiLane(registry.getSdkApiLane(caller), SDK_HOST_MAXIMUM_CONTRACT_VERSION) }
  catch { return { kind: 'reject', code: errorCodes.notSupported } }

  if (registeredLane === 1) {
    const decision = selectSdkMethodRoute(requestMethod(value), registeredLane, hostMaximum)
    if (decision.route === 'legacy') return { kind: 'legacy', lane: registeredLane }
    if (decision.route === 'reject' &&
        (decision.reason === 'unknown-method' || decision.reason === 'lane-2-required')) {
      return { kind: 'legacy', lane: registeredLane }
    }
    return { kind: 'reject', code: errorCodes.notSupported }
  }

  const context = getTrustedSdkLaneContext(registry, event)
  if (!context || context.lane !== registeredLane) {
    return { kind: 'reject', code: errorCodes.permissionDenied }
  }
  const decision = selectSdkMethodRoute(requestMethod(value), context.lane, hostMaximum)
  if (decision.route === 'reference') return { kind: 'reference', context }
  if (decision.route === 'legacy') return { kind: 'legacy', lane: context.lane, context }
  if (decision.reason === 'unknown-method') return { kind: 'legacy', lane: context.lane, context }
  return { kind: 'reject', code: errorCodes.notSupported }
}

/** Execute the selected Main route; a missing reference port never falls through to legacy. */
export async function dispatchTrustedSdkLaneCall(options: {
  readonly decision: SdkLaneDispatchDecision
  readonly event: SdkLaneIpcEvent
  readonly value: unknown
  readonly reference?: SdkLaneReferenceCallPort
  legacy(context?: TrustedSdkLaneContext): Promise<ZToolsResponse>
}): Promise<ZToolsResponse> {
  const { decision, event, value } = options
  if (decision.kind === 'legacy') return options.legacy(decision.context)
  if (decision.kind === 'reject') {
    const message = decision.code === errorCodes.permissionDenied
      ? '调用者身份或页面无效'
      : 'SDK API lane 或适配器尚未启用'
    return dispatchFailure(value, decision.code, message)
  }
  if (!isCurrentTrustedSdkLaneContext(decision.context)) {
    return dispatchFailure(value, errorCodes.permissionDenied, '调用者身份或页面已失效')
  }
  if (!options.reference) {
    return dispatchFailure(value, errorCodes.notSupported, '文件引用运行时尚未接线')
  }
  return options.reference.call(event, value)
}

function dispatchFailure(
  value: unknown,
  code: typeof errorCodes[keyof typeof errorCodes],
  message: string
): ZToolsResponse {
  const messageId = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).messageId
    : undefined
  return {
    messageId: typeof messageId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(messageId) ? messageId : 'invalid',
    success: false,
    error: toPublicError(new ZToolsError(code, message))
  }
}

/** Strict zero-payload Main→preload handshake reply, or null on stop/invalid caller. */
export function createSdkLaneHandshakeReply(
  registry: SdkLaneRegistry,
  event: SdkLaneIpcEvent,
  payloadCount: number,
  stopping: boolean,
  hostMaximum: unknown
): Readonly<SdkLaneHandshake> | null {
  if (stopping || payloadCount !== 0) return null
  const context = getTrustedSdkLaneContext(registry, event)
  if (!context) return null
  return parseSdkLaneHandshake({
    hostMaximumSdkContractVersion: hostMaximum,
    windowSdkApiLane: context.lane
  }) ?? null
}
