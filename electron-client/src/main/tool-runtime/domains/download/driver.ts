import type { ToolCapabilityStatus, ToolTaskId } from '../../../../contracts/tool-runtime/common.js'
import type {
  DownloadPrimitiveId,
  DownloadStreamAudioFormat,
  DownloadStreamMergeContainer,
  DownloadStreamProbeResponse,
  DownloadStreamRunResponse,
  DownloadTransferRecord
} from '../../../../contracts/tool-runtime/domains/download.js'
import type { ToolTaskProgressPayload } from '../../core/task-manager.js'

export interface ResolvedDownloadStreamProbeJob {
  readonly url: string
  readonly timeoutMs: number
}

export interface ResolvedDownloadStreamRunJob {
  readonly taskId: ToolTaskId
  readonly url: string
  readonly outputDir: string
  readonly fileName?: string
  readonly trackId?: string
  readonly preferAudioOnly: boolean
  readonly audioFormat?: DownloadStreamAudioFormat
  readonly mergeContainer?: DownloadStreamMergeContainer
  readonly maxRateBytesPerSec?: number
  readonly timeoutMs: number
  readonly overwrite: boolean
}

export interface ResolvedDownloadTransferAddJob {
  readonly taskId: ToolTaskId
  readonly url: string
  readonly outputDir: string
  readonly fileName: string
  readonly maxConnections: number
  readonly maxRateBytesPerSec?: number
  readonly overwrite: boolean
  readonly expectedSha256?: string
}

export interface DownloadDriverExecutionContext {
  readonly signal: AbortSignal
  readonly onProgress?: (payload: ToolTaskProgressPayload) => void
  readonly onToolUsed?: (toolId: string) => void
}

/**
 * 下载能力域平台异构 Driver 抽象接口：
 * 彻底隔离流媒体解析与多连接断点续传在不同操作系统上的底层引擎实现。
 */
export interface DownloadDomainDriver {
  readonly platformName: 'windows' | 'macos' | 'other'
  getCapabilityStatus(primitiveId: DownloadPrimitiveId): Promise<ToolCapabilityStatus>
  ensureCapability(
    primitiveId: DownloadPrimitiveId,
    signal?: AbortSignal,
    onProgress?: (payload: ToolTaskProgressPayload) => void
  ): Promise<{ readonly status: ToolCapabilityStatus; readonly provisioned: boolean }>
  getStaticToolIds(primitiveId: DownloadPrimitiveId): readonly string[]
  getOptionalExtensions?(primitiveId: DownloadPrimitiveId): readonly string[]
  probeStream(
    job: ResolvedDownloadStreamProbeJob,
    context: DownloadDriverExecutionContext
  ): Promise<DownloadStreamProbeResponse>
  runStream(
    job: ResolvedDownloadStreamRunJob,
    context: DownloadDriverExecutionContext
  ): Promise<DownloadStreamRunResponse>
  addTransfer(
    job: ResolvedDownloadTransferAddJob,
    context: DownloadDriverExecutionContext
  ): Promise<DownloadTransferRecord>
  pauseTransfer(taskId: ToolTaskId): Promise<DownloadTransferRecord>
  resumeTransfer(taskId: ToolTaskId): Promise<DownloadTransferRecord>
  cancelTransfer(taskId: ToolTaskId): Promise<DownloadTransferRecord>
  getTransferStatus(taskId?: ToolTaskId): Promise<readonly DownloadTransferRecord[]>
  stop?(): Promise<void> | void
}
