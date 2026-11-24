import { errorCodes, ZToolsError } from './errors.js'

export const RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL = 'ztools:runtime-capability-request-cancel' as const

export interface RuntimeCapabilityRequestCancellation {
  readonly messageId: string
  readonly reason: 'cancel' | 'timeout'
}

export function parseRuntimeCapabilityRequestCancellation(value: unknown): RuntimeCapabilityRequestCancellation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'Invalid screen capture permission cancel request')
  }
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => key !== 'messageId' && key !== 'reason') ||
      typeof source.messageId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(source.messageId) ||
      (source.reason !== 'cancel' && source.reason !== 'timeout')) {
    throw new ZToolsError(errorCodes.invalidRequest, 'Invalid screen capture permission cancel request')
  }
  return { messageId: source.messageId as string, reason: source.reason as 'cancel' | 'timeout' }
}
