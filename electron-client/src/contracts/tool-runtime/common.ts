/**
 * 第三方引擎工具池与主进程薄原语公共基础契约（完全平台无关、去工具名化）
 * 仅声明能力语义、任务生命周期、结构化路径槽位与公共工具池状态结构，严禁出现具体第三方引擎名或 CLI 方言。
 */

export const TOOL_RUNTIME_CONTRACT_VERSION = 1 as const

export type ToolTaskId = string

export type ToolDomainId = 'media' | 'download'

export type ToolCapabilityStatus = 'ready' | 'needs_provisioning' | 'unsupported'

export type ToolRuntimePermission = 'media.read' | 'media.process' | 'network'

export type ToolPlatformArchKey = 'win32-x64' | 'darwin-arm64' | 'darwin-x64'

export interface ToolCapabilityDescriptor {
  readonly primitiveId: string
  readonly domain: ToolDomainId
  readonly summary: string
  readonly ipcMethods: readonly string[]
  readonly requiredPermissions: readonly ToolRuntimePermission[]
  readonly status: ToolCapabilityStatus
  readonly optionalExtensions: readonly string[]
}

export interface ToolRuntimeCapabilitiesSnapshot {
  readonly contractVersion: typeof TOOL_RUNTIME_CONTRACT_VERSION
  readonly platform: 'windows' | 'macos' | 'other'
  readonly domains: readonly ToolDomainId[]
  readonly capabilities: readonly ToolCapabilityDescriptor[]
}

export interface ToolRuntimeEnsureRequest {
  readonly primitiveId: string
}

export interface ToolRuntimeEnsureResult {
  readonly primitiveId: string
  readonly status: ToolCapabilityStatus
  readonly provisioned: boolean
}

export interface ToolTaskCancelRequest {
  readonly taskId: ToolTaskId
}

export interface ToolTaskCancelResult {
  readonly taskId: ToolTaskId
  readonly cancelled: boolean
}

/**
 * 结构化路径槽位参数：
 * - grantId 模式：引用主进程 PathGrantService 签发的不透明授权句柄（可选附带相对路径）；
 * - path 模式：受控显式绝对路径（仍强制经过 PathSlotGuard realpath 规范化、防穿越与双端系统目录/DataRoot 禁区校验）。
 */
export interface ToolPathSlot {
  readonly grantId?: string
  readonly relativePath?: string
  readonly path?: string
}

export type ToolProvisionStage =
  | 'fetching-catalog'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'retrying'

export type ToolRuntimeErrorStage =
  | 'validation'
  | 'provisioning'
  | 'verifying'
  | 'executing'
  | 'finalizing'

export type ToolRuntimeUserAction =
  | 'retry'
  | 'check_network'
  | 'reinstall_tool'
  | 'update_client'
  | 'check_permissions'
  | 'cancel'
  | 'none'

export interface ToolProgressEvent {
  readonly taskId: ToolTaskId
  readonly primitiveId: string
  readonly phase: 'provisioning' | 'running' | 'finalizing' | 'completed' | 'cancelled' | 'failed'
  /** 0 到 100 之间的进度百分比（允许为 0） */
  readonly percent?: number
  readonly transferredBytes?: number
  readonly totalBytes?: number
  readonly speedBytesPerSec?: number
  /** provisioning 阶段的细分步骤，供插件展示清晰状态 */
  readonly stage?: ToolProvisionStage
  /** 失败态下的稳定细粒度错误码 */
  readonly errorCode?: ToolRuntimeErrorCode
  /** 失败态下是否建议重试 */
  readonly retryable?: boolean
  /** 失败态下建议向用户展示的操作引导 */
  readonly userAction?: ToolRuntimeUserAction
  readonly message?: string
  readonly timestamp: number
}

export type CommonLibToolStatus = 'ready' | 'unreferenced' | 'revoked' | 'corrupted'

export interface CommonLibInventoryItem {
  readonly toolId: string
  readonly toolName: string
  readonly version: string
  readonly platformArch: ToolPlatformArchKey
  readonly sizeBytes: number
  readonly installedAt: string
  readonly status: CommonLibToolStatus
  readonly referencedByCapabilities: readonly string[]
  readonly referencedByPlugins: readonly string[]
  readonly unreferencedSince?: string
  readonly canManualClean: boolean
  readonly revokedReason?: string
}

export interface CommonLibListResult {
  readonly items: readonly CommonLibInventoryItem[]
  readonly totalSizeBytes: number
}

export interface CommonLibCleanRequest {
  readonly toolId?: string
  readonly runGc?: boolean
}

export interface CommonLibCleanResult {
  readonly removedToolIds: readonly string[]
  readonly skippedToolIds: readonly string[]
  readonly reclaimedBytes: number
}

export const TOOL_RUNTIME_ERROR_CODES = {
  invalidRequest: 'TOOL_INVALID_REQUEST',
  capabilityUnsupported: 'TOOL_CAPABILITY_UNSUPPORTED',
  capabilityProvisionFailed: 'TOOL_CAPABILITY_PROVISION_FAILED',
  pathDenied: 'TOOL_PATH_DENIED',
  policyViolation: 'TOOL_POLICY_VIOLATION',
  trustVerificationFailed: 'TOOL_TRUST_VERIFICATION_FAILED',
  toolRevoked: 'TOOL_REVOKED',
  toolRollbackBlocked: 'TOOL_ROLLBACK_BLOCKED',
  taskCancelled: 'TOOL_TASK_CANCELLED',
  taskNotFound: 'TOOL_TASK_NOT_FOUND',
  concurrencyLimited: 'TOOL_CONCURRENCY_LIMITED',
  executionTimeout: 'TOOL_EXECUTION_TIMEOUT',
  toolBinaryUnavailable: 'TOOL_BINARY_UNAVAILABLE',
  executionFailed: 'TOOL_EXECUTION_FAILED'
} as const

export type ToolRuntimeErrorCode = (typeof TOOL_RUNTIME_ERROR_CODES)[keyof typeof TOOL_RUNTIME_ERROR_CODES]

/** 面向插件侧安全公开的结构化错误元数据（绝不包含本机敏感路径） */
export interface ToolRuntimePublicErrorDetails {
  readonly toolCode: ToolRuntimeErrorCode
  readonly stage: ToolRuntimeErrorStage
  readonly retryable: boolean
  readonly userAction: ToolRuntimeUserAction
  readonly primitiveId?: string
  readonly timedOut?: boolean
  readonly exitCode?: number
  readonly attempts?: number
  readonly detail?: string
}
