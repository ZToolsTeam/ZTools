import { canCall, type CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, toPublicError, ZToolsError } from '../../contracts/errors.js'
import { parseNetworkRequestCancellation } from '../../contracts/network-request-cancel.js'
import type { ZToolsResponse } from '../../contracts/ipc.js'
import type { NetworkRequestCancellationService } from '../services/network-request-cancellation-service.js'
import {
  getTrustedSdkLaneContext,
  isCurrentTrustedSdkLaneContext,
  type SdkLaneIpcEvent,
  type SdkLaneRegistry
} from './sdk-lane-dispatch.js'

interface Registry extends SdkLaneRegistry {
  get(webContentsId: number): CallerIdentity | undefined
}

function requestMessageId(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const messageId = (value as Record<string, unknown>).messageId
  return typeof messageId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(messageId) ? messageId : 'invalid'
}

/** Narrow Main endpoint: the channel and registry are permanently bound to network_http_request. */
export class NetworkRequestCancellationEndpoint {
  constructor(
    private readonly registry: Registry,
    private readonly cancellations: NetworkRequestCancellationService,
    private readonly isStopping: () => boolean,
    private readonly pendingMethod: (webContentsId: number, messageId: string) => string | undefined
  ) {}

  async cancel(event: SdkLaneIpcEvent, value: unknown): Promise<ZToolsResponse> {
    let messageId = requestMessageId(value)
    try {
      if (this.isStopping()) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
      const context = getTrustedSdkLaneContext(this.registry, event)
      if (!context || (context.lane !== 1 && context.lane !== 2) || !canCall('network_http_request', context.caller)) {
        throw new ZToolsError(errorCodes.permissionDenied, '网络请求取消调用者无效')
      }
      const request = parseNetworkRequestCancellation(value)
      messageId = request.messageId
      const activeMethod = this.pendingMethod(context.target.id, request.messageId)
      if (activeMethod !== undefined && activeMethod !== 'network_http_request') {
        throw new ZToolsError(errorCodes.permissionDenied, '取消标识不属于网络请求')
      }
      if (!isCurrentTrustedSdkLaneContext(context)) {
        throw new ZToolsError(errorCodes.permissionDenied, '网络请求取消调用页面已失效')
      }
      const data = this.cancellations.cancel(context.caller, request.messageId, request.reason)
      if (!isCurrentTrustedSdkLaneContext(context)) {
        throw new ZToolsError(errorCodes.permissionDenied, '网络请求取消调用页面已失效')
      }
      return { messageId, success: true, data }
    } catch (error) {
      return { messageId, success: false, error: toPublicError(error) }
    }
  }
}
