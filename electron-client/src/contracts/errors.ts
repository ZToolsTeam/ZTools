export const errorCodes = {
  invalidRequest: 'INVALID_REQUEST',
  methodNotFound: 'METHOD_NOT_FOUND',
  permissionDenied: 'PERMISSION_DENIED',
  requestTimeout: 'REQUEST_TIMEOUT',
  callerDestroyed: 'CALLER_DESTROYED',
  appStopping: 'APP_STOPPING',
  cancelled: 'CANCELLED',
  notSupported: 'NOT_SUPPORTED',
  platformNotSupported: 'PLATFORM_NOT_SUPPORTED',
  networkError: 'NETWORK_ERROR',
  responseTooLarge: 'RESPONSE_TOO_LARGE',
  fileError: 'FILE_ERROR',
  fileTooLarge: 'FILE_TOO_LARGE',
  fileAlreadyExists: 'FILE_ALREADY_EXISTS',
  fileWriteOutcomeUnknown: 'FILE_WRITE_OUTCOME_UNKNOWN',
  fileCrossDevice: 'FILE_CROSS_DEVICE',
  fileStagingRetained: 'FILE_STAGING_RETAINED',
  diskFull: 'DISK_FULL',
  shellError: 'SHELL_ERROR',
  processError: 'PROCESS_ERROR',
  screenError: 'SCREEN_ERROR',
  clipboardError: 'CLIPBOARD_ERROR',
  databaseLocked: 'DATABASE_LOCKED',
  databaseKeyNotFound: 'DATABASE_KEY_NOT_FOUND',
  dataCorrupt: 'DATA_CORRUPT',
  storageError: 'STORAGE_ERROR',
  pluginBusy: 'PLUGIN_BUSY',
  pluginIntegrity: 'PLUGIN_INTEGRITY_ERROR',
  checksumMismatch: 'CHECKSUM_MISMATCH',
  pluginPackageInvalid: 'PLUGIN_PACKAGE_INVALID',
  pluginNotFound: 'PLUGIN_NOT_FOUND',
  dllError: 'DLL_ERROR',
  triggerConflict: 'TRIGGER_CONFLICT',
  triggerNotFound: 'TRIGGER_NOT_FOUND',
  nativeHostUnavailable: 'NATIVE_HOST_UNAVAILABLE',
  nativeHostProtocol: 'NATIVE_HOST_PROTOCOL_ERROR',
  nativeHostError: 'NATIVE_HOST_ERROR',
  nativeHostCrashed: 'NATIVE_HOST_CRASHED',
  serviceUnavailable: 'SERVICE_UNAVAILABLE',
  serviceProtocol: 'SERVICE_PROTOCOL_ERROR',
  serviceAuthentication: 'SERVICE_AUTHENTICATION_FAILED',
  internalError: 'INTERNAL_ERROR'
} as const

export type ZToolsErrorCode = (typeof errorCodes)[keyof typeof errorCodes]

export interface ZToolsErrorDetails {
  hostCode?: string
  path?: string
  fields?: string[]
}

export class ZToolsError extends Error {
  constructor(
    readonly code: ZToolsErrorCode,
    message: string,
    readonly details?: ZToolsErrorDetails
  ) {
    super(message)
    this.name = 'ZToolsError'
  }
}

export function toPublicError(error: unknown): { code: ZToolsErrorCode; message: string } {
  if (error instanceof ZToolsError) return { code: error.code, message: error.message }
  return { code: errorCodes.internalError, message: '宿主内部错误' }
}
