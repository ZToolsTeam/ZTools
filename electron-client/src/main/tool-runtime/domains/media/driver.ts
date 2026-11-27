import type { ToolCapabilityStatus } from '../../../../contracts/tool-runtime/common.js'
import type {
  MediaAudioCodec,
  MediaContainerFormat,
  MediaPrimitiveId,
  MediaProbeItem,
  MediaScaleOption,
  MediaTranscodeResponse,
  MediaTrimOption,
  MediaVideoCodec,
  MediaWatermarkPosition
} from '../../../../contracts/tool-runtime/domains/media.js'
import type { ToolTaskProgressPayload } from '../../core/task-manager.js'

export interface ResolvedMediaProbeFile {
  readonly path: string
  readonly displayName: string
  readonly sizeBytes: number
}

export interface ResolvedMediaWatermarkOption {
  readonly imagePath: string
  readonly position: MediaWatermarkPosition
  readonly opacity?: number
  readonly marginPx?: number
}

export interface ResolvedMediaTranscodeJob {
  readonly taskId: string
  readonly inputPath: string
  readonly outputPath: string
  readonly overwrite: boolean
  readonly container: MediaContainerFormat
  readonly videoCodec?: MediaVideoCodec
  readonly audioCodec?: MediaAudioCodec
  readonly videoBitrateKbps?: number
  readonly audioBitrateKbps?: number
  readonly frameRate?: number
  readonly audioSampleRateHz?: number
  readonly audioChannels?: number
  readonly extractAudioOnly: boolean
  readonly stripAudio: boolean
  readonly scale?: MediaScaleOption
  readonly trim?: MediaTrimOption
  readonly watermark?: ResolvedMediaWatermarkOption
}

export interface MediaDriverExecutionContext {
  readonly signal: AbortSignal
  readonly onProgress?: (payload: ToolTaskProgressPayload) => void
  readonly onToolUsed?: (toolId: string) => void
}

/**
 * 媒体能力域平台异构 Driver 抽象接口：
 * 彻底屏蔽 Windows / macOS 底层媒体引擎、二进制名与参数方言差异。
 */
export interface MediaDomainDriver {
  readonly platformName: 'windows' | 'macos' | 'other'
  getCapabilityStatus(primitiveId: MediaPrimitiveId): Promise<ToolCapabilityStatus>
  ensureCapability(
    primitiveId: MediaPrimitiveId,
    signal?: AbortSignal,
    onProgress?: (payload: ToolTaskProgressPayload) => void
  ): Promise<{ readonly status: ToolCapabilityStatus; readonly provisioned: boolean }>
  getStaticToolIds(primitiveId: MediaPrimitiveId): readonly string[]
  getOptionalExtensions?(primitiveId: MediaPrimitiveId): readonly string[]
  probe(
    files: readonly ResolvedMediaProbeFile[],
    context: MediaDriverExecutionContext
  ): Promise<readonly MediaProbeItem[]>
  transcode(
    job: ResolvedMediaTranscodeJob,
    context: MediaDriverExecutionContext
  ): Promise<MediaTranscodeResponse>
  stop?(): Promise<void> | void
}
