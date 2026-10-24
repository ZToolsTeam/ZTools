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
  /** 需要知道「是哪个插件」的能力收到了未归属（宿主身份）的调用 */
  pluginIdentityRequired: 'PLUGIN_IDENTITY_REQUIRED',
  /** 插件 plugin.json 未声明所需权限 */
  pluginPermissionRequired: 'PLUGIN_PERMISSION_REQUIRED',
  processProtected: 'PROCESS_PROTECTED',
  processNotFound: 'PROCESS_NOT_FOUND',
  processAccessDenied: 'PROCESS_ACCESS_DENIED',
  processIdentityMismatch: 'PROCESS_IDENTITY_MISMATCH',
  processTerminateTimeout: 'PROCESS_TERMINATE_TIMEOUT',
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
  /**
   * 允许原样返回给调用方的结构化补充信息（例如结束进程超时时仍在运行的 pid）。
   * 只能放可公开的非敏感数据；其余 details 字段只进日志，不出现在 IPC 响应里。
   */
  public?: Readonly<Record<string, string | number | boolean | readonly number[]>>
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

export interface PublicError {
  code: ZToolsErrorCode
  message: string
  details?: Readonly<Record<string, unknown>>
}

export function toPublicError(error: unknown): PublicError {
  if (error instanceof ZToolsError) {
    return error.details?.public
      ? { code: error.code, message: error.message, details: { ...error.details.public } }
      : { code: error.code, message: error.message }
  }
  return { code: errorCodes.internalError, message: '宿主内部错误' }
}
