import { canCall, type CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { toLocalizedPublicError } from './error-localizer.js'
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
      if (this.isStopping()) throw new ZToolsError(errorCodes.appStopping, 'Application is exiting')
      const context = getTrustedSdkLaneContext(this.registry, event)
      if (!context || (context.lane !== 1 && context.lane !== 2) || !canCall('network_http_request', context.caller)) {
        throw new ZToolsError(errorCodes.permissionDenied, 'Invalid caller for network request cancellation')
      }
      const request = parseNetworkRequestCancellation(value)
      messageId = request.messageId
      const activeMethod = this.pendingMethod(context.target.id, request.messageId)
      if (activeMethod !== undefined && activeMethod !== 'network_http_request') {
        throw new ZToolsError(errorCodes.permissionDenied, 'Cancellation token does not belong to a network request')
      }
      if (!isCurrentTrustedSdkLaneContext(context)) {
        throw new ZToolsError(errorCodes.permissionDenied, 'Caller page for network request cancellation is no longer valid')
      }
      const data = this.cancellations.cancel(context.caller, request.messageId, request.reason)
      if (!isCurrentTrustedSdkLaneContext(context)) {
        throw new ZToolsError(errorCodes.permissionDenied, 'Caller page for network request cancellation is no longer valid')
      }
      return { messageId, success: true, data }
    } catch (error) {
      return { messageId, success: false, error: toLocalizedPublicError(error) }
    }
  }
}
