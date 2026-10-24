import { errorCodes, ZToolsError } from './errors.js'

export const NETWORK_REQUEST_CANCEL_CHANNEL = 'ztools:network-request-cancel' as const

export interface NetworkRequestCancellation {
  readonly messageId: string
  readonly reason: 'cancel' | 'timeout'
}

/** The channel is bound to network_http_request; callers cannot select another method. */
export function parseNetworkRequestCancellation(value: unknown): NetworkRequestCancellation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ZToolsError(errorCodes.invalidRequest, '网络请求取消参数无效')
  }
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => key !== 'messageId' && key !== 'reason') ||
      typeof source.messageId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(source.messageId) ||
      (source.reason !== 'cancel' && source.reason !== 'timeout')) {
    throw new ZToolsError(errorCodes.invalidRequest, '网络请求取消参数无效')
  }
  return { messageId: source.messageId, reason: source.reason }
}
