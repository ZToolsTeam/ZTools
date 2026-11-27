import type { ToolPathSlot, ToolTaskId } from '../common.js'

/**
 * 下载能力域平台无关原语契约（download.stream / download.transfer）
 * 严禁暴露任何具体第三方下载引擎名称、RPC 协议或 CLI 方言参数。
 */

export const DOWNLOAD_DOMAIN_ID = 'download' as const

export const DOWNLOAD_PRIMITIVE_IDS = {
  stream: 'download.stream',
  transfer: 'download.transfer'
} as const

export type DownloadPrimitiveId = (typeof DOWNLOAD_PRIMITIVE_IDS)[keyof typeof DOWNLOAD_PRIMITIVE_IDS]

export const DOWNLOAD_IPC_METHODS = [
  'tool_download_stream_probe',
  'tool_download_stream_run',
  'tool_download_transfer_add',
  'tool_download_transfer_pause',
  'tool_download_transfer_resume',
  'tool_download_transfer_cancel',
  'tool_download_transfer_status'
] as const

export type DownloadIpcMethod = (typeof DOWNLOAD_IPC_METHODS)[number]

export interface DownloadStreamProbeRequest {
  readonly url: string
  readonly timeoutMs?: number
}

export interface DownloadStreamTrack {
  readonly trackId: string
  readonly kind: 'combined' | 'video' | 'audio'
  readonly container?: string
  readonly qualityLabel?: string
  readonly width?: number
  readonly height?: number
  readonly frameRate?: number
  readonly bitrateKbps?: number
  readonly sizeBytes?: number
}

export type DownloadStreamAudioFormat = 'mp3' | 'flac' | 'm4a' | 'opus' | 'wav'

export type DownloadStreamMergeContainer = 'mp4' | 'mkv' | 'webm'

export interface DownloadStreamProbeResponse {
  readonly title: string
  readonly uploader?: string
  readonly thumbnail?: string
  readonly webpageUrl?: string
  readonly durationSec?: number
  readonly tracks: readonly DownloadStreamTrack[]
}

export interface DownloadStreamRunRequest {
  readonly taskId?: ToolTaskId
  readonly url: string
  readonly outputDir: ToolPathSlot
  readonly fileName?: string
  readonly trackId?: string
  readonly preferAudioOnly?: boolean
  readonly audioFormat?: DownloadStreamAudioFormat
  readonly mergeContainer?: DownloadStreamMergeContainer
  readonly maxRateBytesPerSec?: number
  readonly timeoutMs?: number
  readonly overwrite?: boolean
}

export interface DownloadStreamRunResponse {
  readonly taskId: ToolTaskId
  readonly outputFileName: string
  readonly outputBytes: number
  readonly durationMs: number
}

export type DownloadTransferState = 'queued' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'

export interface DownloadTransferAddRequest {
  readonly taskId?: ToolTaskId
  readonly url: string
  readonly outputDir: ToolPathSlot
  readonly fileName?: string
  readonly maxConnections?: number
  readonly maxRateBytesPerSec?: number
  readonly overwrite?: boolean
  readonly expectedSha256?: string
}

export interface DownloadTransferControlRequest {
  readonly taskId: ToolTaskId
}

export interface DownloadTransferStatusRequest {
  readonly taskId?: ToolTaskId
}

export interface DownloadTransferRecord {
  readonly taskId: ToolTaskId
  readonly url: string
  readonly fileName: string
  readonly state: DownloadTransferState
  readonly downloadedBytes: number
  readonly totalBytes?: number
  readonly speedBytesPerSec: number
  readonly connections: number
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface DownloadTransferStatusResponse {
  readonly tasks: readonly DownloadTransferRecord[]
}
