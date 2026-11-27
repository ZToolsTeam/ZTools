import type { ToolPathSlot, ToolTaskId } from '../common.js'

/**
 * 媒体能力域平台无关原语契约（media.probe / media.transcode）
 * 严禁暴露任何具体第三方引擎名称、可执行文件名或 CLI 方言参数。
 */

export const MEDIA_DOMAIN_ID = 'media' as const

export const MEDIA_PRIMITIVE_IDS = {
  probe: 'media.probe',
  transcode: 'media.transcode'
} as const

export type MediaPrimitiveId = (typeof MEDIA_PRIMITIVE_IDS)[keyof typeof MEDIA_PRIMITIVE_IDS]

export const MEDIA_IPC_METHODS = [
  'tool_media_probe',
  'tool_media_transcode_run'
] as const

export type MediaIpcMethod = (typeof MEDIA_IPC_METHODS)[number]

export type MediaContainerFormat = 'mp4' | 'mkv' | 'mov' | 'webm' | 'mp3' | 'aac' | 'flac' | 'wav' | 'ogg' | 'gif'
export type MediaVideoCodec = 'h264' | 'hevc' | 'vp9' | 'av1' | 'copy'
export type MediaAudioCodec = 'aac' | 'mp3' | 'opus' | 'flac' | 'pcm' | 'copy'
export type MediaWatermarkPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center'

export interface MediaProbeRequest {
  readonly inputs: readonly ToolPathSlot[]
}

export interface MediaStreamInfo {
  readonly index: number
  readonly kind: 'video' | 'audio' | 'subtitle' | 'other'
  readonly codec?: string
  readonly width?: number
  readonly height?: number
  readonly frameRate?: number
  readonly bitrateBps?: number
  readonly sampleRateHz?: number
  readonly channels?: number
  readonly language?: string
}

export interface MediaProbeItem {
  readonly displayName: string
  readonly container?: string
  readonly durationSec?: number
  readonly sizeBytes: number
  readonly bitrateBps?: number
  readonly streams: readonly MediaStreamInfo[]
}

export interface MediaProbeResponse {
  readonly items: readonly MediaProbeItem[]
}

export interface MediaScaleOption {
  readonly width?: number
  readonly height?: number
  readonly keepAspectRatio?: boolean
}

export interface MediaTrimOption {
  readonly startSec?: number
  readonly durationSec?: number
  readonly endSec?: number
}

export interface MediaWatermarkOption {
  readonly imageSlot: ToolPathSlot
  readonly position: MediaWatermarkPosition
  readonly opacity?: number
  readonly marginPx?: number
}

export interface MediaTranscodeRequest {
  readonly taskId?: ToolTaskId
  readonly input: ToolPathSlot
  readonly output: ToolPathSlot
  readonly overwrite?: boolean
  readonly container: MediaContainerFormat
  readonly videoCodec?: MediaVideoCodec
  readonly audioCodec?: MediaAudioCodec
  readonly videoBitrateKbps?: number
  readonly audioBitrateKbps?: number
  readonly frameRate?: number
  readonly audioSampleRateHz?: number
  readonly audioChannels?: number
  readonly extractAudioOnly?: boolean
  readonly stripAudio?: boolean
  readonly scale?: MediaScaleOption
  readonly trim?: MediaTrimOption
  readonly watermark?: MediaWatermarkOption
}

export interface MediaTranscodeResponse {
  readonly taskId: ToolTaskId
  readonly outputBytes: number
  readonly durationMs: number
  readonly container: MediaContainerFormat
}
