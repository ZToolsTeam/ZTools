import { errorCodes, ZToolsError, type ZToolsErrorCode } from '../../../contracts/errors.js'
import {
  TOOL_RUNTIME_ERROR_CODES,
  type ToolRuntimeErrorCode,
  type ToolRuntimeErrorStage,
  type ToolRuntimeUserAction
} from '../../../contracts/tool-runtime/common.js'

const MAX_PUBLIC_DETAIL_LENGTH = 256

/**
 * 将工具运行时细粒度错误码映射为宿主标准 IPC 错误码，
 * 同时通过 details.hostCode 与 details.public.toolCode 保留精确语义，供上层界面与测试精准断言。
 */
function mapToolErrorToZToolsCode(toolCode: ToolRuntimeErrorCode): ZToolsErrorCode {
  switch (toolCode) {
    case TOOL_RUNTIME_ERROR_CODES.invalidRequest:
    case TOOL_RUNTIME_ERROR_CODES.policyViolation:
      return errorCodes.invalidRequest
    case TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported:
      return errorCodes.notSupported
    case TOOL_RUNTIME_ERROR_CODES.pathDenied:
    case TOOL_RUNTIME_ERROR_CODES.toolRevoked:
    case TOOL_RUNTIME_ERROR_CODES.toolRollbackBlocked:
      return errorCodes.permissionDenied
    case TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed:
      return errorCodes.pluginIntegrity
    case TOOL_RUNTIME_ERROR_CODES.taskCancelled:
      return errorCodes.cancelled
    case TOOL_RUNTIME_ERROR_CODES.taskNotFound:
      return errorCodes.invalidRequest
    case TOOL_RUNTIME_ERROR_CODES.concurrencyLimited:
      return errorCodes.pluginBusy
    case TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed:
      return errorCodes.networkError
    case TOOL_RUNTIME_ERROR_CODES.executionTimeout:
      return errorCodes.requestTimeout
    case TOOL_RUNTIME_ERROR_CODES.toolBinaryUnavailable:
    case TOOL_RUNTIME_ERROR_CODES.executionFailed:
      return errorCodes.processError
  }
}

export interface DefaultToolErrorMeta {
  readonly stage: ToolRuntimeErrorStage
  readonly retryable: boolean
  readonly userAction: ToolRuntimeUserAction
}

/** 按细粒度错误码派生默认的阶段、可重试性与用户引导动作 */
export function resolveDefaultToolErrorMeta(toolCode: ToolRuntimeErrorCode): DefaultToolErrorMeta {
  switch (toolCode) {
    case TOOL_RUNTIME_ERROR_CODES.invalidRequest:
    case TOOL_RUNTIME_ERROR_CODES.policyViolation:
    case TOOL_RUNTIME_ERROR_CODES.taskNotFound:
      return { stage: 'validation', retryable: false, userAction: 'none' }
    case TOOL_RUNTIME_ERROR_CODES.capabilityUnsupported:
      return { stage: 'validation', retryable: false, userAction: 'update_client' }
    case TOOL_RUNTIME_ERROR_CODES.pathDenied:
      return { stage: 'validation', retryable: false, userAction: 'check_permissions' }
    case TOOL_RUNTIME_ERROR_CODES.capabilityProvisionFailed:
      return { stage: 'provisioning', retryable: true, userAction: 'check_network' }
    case TOOL_RUNTIME_ERROR_CODES.trustVerificationFailed:
      return { stage: 'verifying', retryable: true, userAction: 'reinstall_tool' }
    case TOOL_RUNTIME_ERROR_CODES.toolRevoked:
    case TOOL_RUNTIME_ERROR_CODES.toolRollbackBlocked:
      return { stage: 'verifying', retryable: false, userAction: 'update_client' }
    case TOOL_RUNTIME_ERROR_CODES.taskCancelled:
      return { stage: 'executing', retryable: false, userAction: 'none' }
    case TOOL_RUNTIME_ERROR_CODES.concurrencyLimited:
      return { stage: 'executing', retryable: true, userAction: 'retry' }
    case TOOL_RUNTIME_ERROR_CODES.executionTimeout:
      return { stage: 'executing', retryable: true, userAction: 'retry' }
    case TOOL_RUNTIME_ERROR_CODES.toolBinaryUnavailable:
      return { stage: 'executing', retryable: true, userAction: 'reinstall_tool' }
    case TOOL_RUNTIME_ERROR_CODES.executionFailed:
      return { stage: 'executing', retryable: true, userAction: 'retry' }
  }
}

/** 清洗可公开的诊断摘要：去控制字符、脱敏 Windows/POSIX 绝对路径并限长 */
export function sanitizePublicErrorDetail(raw: string | undefined): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/g, '<path>')
    .replace(/(?:\/(?:Users|home|var|tmp|private|Library|Applications|opt|etc|Volumes)\/[^\s'":,;]+)/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return undefined
  return cleaned.length > MAX_PUBLIC_DETAIL_LENGTH
    ? `${cleaned.slice(0, MAX_PUBLIC_DETAIL_LENGTH)}...`
    : cleaned
}

export interface ToolRuntimeErrorOptions {
  readonly fields?: string[]
  readonly path?: string
  readonly primitiveId?: string
  readonly stage?: ToolRuntimeErrorStage
  readonly retryable?: boolean
  readonly userAction?: ToolRuntimeUserAction
  readonly timedOut?: boolean
  readonly exitCode?: number | null
  readonly attempts?: number
  readonly detail?: string
  readonly publicExtras?: Readonly<Record<string, string | number | boolean>>
}

/** 创建带结构化 toolCode 与 UI 引导元数据的宿主错误实例 */
export function createToolRuntimeError(
  toolCode: ToolRuntimeErrorCode,
  message: string,
  options: ToolRuntimeErrorOptions = {}
): ZToolsError {
  const defaults = resolveDefaultToolErrorMeta(toolCode)
  const sanitizedDetail = sanitizePublicErrorDetail(options.detail)
  const publicPayload: Record<string, string | number | boolean> = {
    toolCode,
    stage: options.stage ?? defaults.stage,
    retryable: options.retryable ?? defaults.retryable,
    userAction: options.userAction ?? defaults.userAction,
    ...(options.primitiveId ? { primitiveId: options.primitiveId } : {}),
    ...(options.timedOut !== undefined ? { timedOut: options.timedOut } : {}),
    ...(typeof options.exitCode === 'number' && Number.isFinite(options.exitCode)
      ? { exitCode: options.exitCode }
      : {}),
    ...(typeof options.attempts === 'number' && Number.isFinite(options.attempts)
      ? { attempts: options.attempts }
      : {}),
    ...(sanitizedDetail ? { detail: sanitizedDetail } : {}),
    ...(options.publicExtras ?? {})
  }
  return new ZToolsError(mapToolErrorToZToolsCode(toolCode), message, {
    hostCode: toolCode,
    i18nKey: `error.${toolCode}`,
    ...(options.fields ? { fields: options.fields } : {}),
    ...(options.path ? { path: options.path } : {}),
    public: publicPayload
  })
}

/** 为已抛出的 ToolRuntime 异常补充原语上下文（若原本未携带 primitiveId） */
export function attachPrimitiveContext(error: unknown, primitiveId: string): unknown {
  if (!(error instanceof ZToolsError)) return error
  const existingPublic = error.details?.public
  if (!existingPublic || typeof existingPublic.toolCode !== 'string') return error
  if (typeof existingPublic.primitiveId === 'string' && existingPublic.primitiveId.length > 0) {
    return error
  }
  return new ZToolsError(error.code, error.message, {
    ...error.details,
    public: {
      ...existingPublic,
      primitiveId
    }
  })
}

/** 从异常中提取可写入 ToolProgressEvent 的失败元数据 */
export function extractToolProgressFailureMeta(error: unknown): {
  readonly errorCode: ToolRuntimeErrorCode
  readonly retryable: boolean
  readonly userAction: ToolRuntimeUserAction
  readonly message: string
} {
  if (error instanceof ZToolsError) {
    const pub = error.details?.public
    const toolCode =
      typeof pub?.toolCode === 'string'
        ? (pub.toolCode as ToolRuntimeErrorCode)
        : typeof error.details?.hostCode === 'string' && error.details.hostCode.startsWith('TOOL_')
          ? (error.details.hostCode as ToolRuntimeErrorCode)
          : TOOL_RUNTIME_ERROR_CODES.executionFailed
    const defaults = resolveDefaultToolErrorMeta(toolCode)
    return {
      errorCode: toolCode,
      retryable: typeof pub?.retryable === 'boolean' ? pub.retryable : defaults.retryable,
      userAction: typeof pub?.userAction === 'string' ? (pub.userAction as ToolRuntimeUserAction) : defaults.userAction,
      message: error.message
    }
  }
  return {
    errorCode: TOOL_RUNTIME_ERROR_CODES.executionFailed,
    retryable: true,
    userAction: 'retry',
    message: formatErrorMessage(error)
  }
}

/** 校验并收窄普通非数组对象 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从异常对象安全提取诊断消息 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
