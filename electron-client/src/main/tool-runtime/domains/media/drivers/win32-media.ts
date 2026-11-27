import fs from 'node:fs/promises'
import {
  TOOL_RUNTIME_ERROR_CODES,
  type ToolCapabilityStatus
} from '../../../../../contracts/tool-runtime/common.js'
import type {
  MediaAudioCodec,
  MediaContainerFormat,
  MediaPrimitiveId,
  MediaProbeItem,
  MediaStreamInfo,
  MediaTranscodeResponse,
  MediaVideoCodec,
  MediaWatermarkPosition
} from '../../../../../contracts/tool-runtime/domains/media.js'
import {
  ensureCommonLibExecutable,
  runWithCommonLibBinaryRecovery,
  type CommonLibsManager
} from '../../../core/commonlibs-manager.js'
import { createToolRuntimeError, isPlainObject } from '../../../core/errors.js'
import type { GuardedProcessRunner } from '../../../core/guarded-process.js'
import type { ToolTaskProgressPayload } from '../../../core/task-manager.js'
import type {
  MediaDomainDriver,
  MediaDriverExecutionContext,
  ResolvedMediaProbeFile,
  ResolvedMediaTranscodeJob
} from '../driver.js'

/**
 * Windows 媒体能力域 Driver：
 * - 通过 CommonLibsManager 定位离线验签通过的媒体引擎工具包；
 * - 全部子进程调用经由 GuardedProcessRunner（shell: false），不直接调用底层进程模块；
 * - 第二层工具私有安全护栏：显式限定 -protocol_whitelist file、禁外部滤镜脚本、全量结构化枚举映射 argv。
 */

export const DEFAULT_WIN32_MEDIA_TOOL_ID = 'media-toolkit-7.1.0'
export const DEFAULT_WIN32_MEDIA_PROBE_REL = 'bin/ffprobe.exe'
export const DEFAULT_WIN32_MEDIA_TRANSCODE_REL = 'bin/ffmpeg.exe'

export interface Win32MediaDriverOptions {
  readonly commonLibs: CommonLibsManager
  readonly processRunner: GuardedProcessRunner
  readonly toolId?: string
  readonly probeExecRelPath?: string
  readonly transcodeExecRelPath?: string
}

const VIDEO_CODEC_MAP: Readonly<Record<MediaVideoCodec, string>> = {
  h264: 'libx264',
  hevc: 'libx265',
  vp9: 'libvpx-vp9',
  av1: 'libaom-av1',
  copy: 'copy'
}

const AUDIO_CODEC_MAP: Readonly<Record<MediaAudioCodec, string>> = {
  aac: 'aac',
  mp3: 'libmp3lame',
  opus: 'libopus',
  flac: 'flac',
  pcm: 'pcm_s16le',
  copy: 'copy'
}

const CONTAINER_FORMAT_MAP: Readonly<Record<MediaContainerFormat, string>> = {
  mp4: 'mp4',
  mkv: 'matroska',
  mov: 'mov',
  webm: 'webm',
  mp3: 'mp3',
  aac: 'adts',
  flac: 'flac',
  wav: 'wav',
  ogg: 'ogg',
  gif: 'gif'
}

function parseFrameRateFraction(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw) return undefined
  const parts = raw.split('/')
  if (parts.length === 1) {
    const val = Number(parts[0])
    return Number.isFinite(val) && val > 0 ? Number(val.toFixed(3)) : undefined
  }
  if (parts.length === 2) {
    const num = Number(parts[0])
    const den = Number(parts[1])
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0 && num > 0) {
      return Number((num / den).toFixed(3))
    }
  }
  return undefined
}

function parseOptionalPositiveNumber(raw: unknown): number | undefined {
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isFinite(num) && num >= 0 ? num : undefined
}

function buildWatermarkOverlayExpression(position: MediaWatermarkPosition, marginPx: number): string {
  switch (position) {
    case 'top-left':
      return `${marginPx}:${marginPx}`
    case 'top-right':
      return `main_w-overlay_w-${marginPx}:${marginPx}`
    case 'bottom-left':
      return `${marginPx}:main_h-overlay_h-${marginPx}`
    case 'bottom-right':
      return `main_w-overlay_w-${marginPx}:main_h-overlay_h-${marginPx}`
    case 'center':
      return '(main_w-overlay_w)/2:(main_h-overlay_h)/2'
  }
}

/** 基于第一层校验后的结构化作业安全构造受控转码 argv（零自由字符串透传） */
export function buildSafeMediaTranscodeArgv(job: ResolvedMediaTranscodeJob): readonly string[] {
  const args: string[] = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-progress',
    'pipe:1',
    job.overwrite ? '-y' : '-n',
    '-protocol_whitelist',
    'file'
  ]

  if (job.trim?.startSec !== undefined) {
    args.push('-ss', String(job.trim.startSec))
  }
  args.push('-i', job.inputPath)

  if (job.watermark) {
    args.push('-protocol_whitelist', 'file', '-i', job.watermark.imagePath)
  }

  if (job.trim?.durationSec !== undefined) {
    args.push('-t', String(job.trim.durationSec))
  } else if (job.trim?.endSec !== undefined) {
    const start = job.trim.startSec ?? 0
    args.push('-t', String(Math.max(0.001, job.trim.endSec - start)))
  }

  if (job.extractAudioOnly) {
    args.push('-vn')
  } else {
    if (job.watermark) {
      const filters: string[] = []
      let baseLabel = '[0:v]'
      if (job.scale) {
        const w = job.scale.width ?? -2
        const h = job.scale.height ?? -2
        filters.push(`${baseLabel}scale=${w}:${h}[v_scaled]`)
        baseLabel = '[v_scaled]'
      }
      const opacity = job.watermark.opacity ?? 1
      const marginPx = job.watermark.marginPx ?? 16
      const overlayPos = buildWatermarkOverlayExpression(job.watermark.position, marginPx)
      filters.push(`[1:v]format=rgba,colorchannelmixer=aa=${opacity}[wm]`)
      filters.push(`${baseLabel}[wm]overlay=${overlayPos}[v_out]`)
      args.push('-filter_complex', filters.join(';'), '-map', '[v_out]')
      if (!job.stripAudio) {
        args.push('-map', '0:a?')
      }
    } else if (job.scale) {
      const w = job.scale.width ?? -2
      const h = job.scale.height ?? -2
      args.push('-vf', `scale=${w}:${h}`)
    }

    if (job.videoCodec !== undefined) {
      args.push('-c:v', VIDEO_CODEC_MAP[job.videoCodec])
    }
    if (job.videoBitrateKbps !== undefined) {
      args.push('-b:v', `${job.videoBitrateKbps}k`)
    }
    if (job.frameRate !== undefined) {
      args.push('-r', String(job.frameRate))
    }
  }

  if (job.stripAudio) {
    args.push('-an')
  } else {
    if (job.audioCodec !== undefined) {
      args.push('-c:a', AUDIO_CODEC_MAP[job.audioCodec])
    }
    if (job.audioBitrateKbps !== undefined) {
      args.push('-b:a', `${job.audioBitrateKbps}k`)
    }
    if (job.audioSampleRateHz !== undefined) {
      args.push('-ar', String(job.audioSampleRateHz))
    }
    if (job.audioChannels !== undefined) {
      args.push('-ac', String(job.audioChannels))
    }
  }

  args.push('-f', CONTAINER_FORMAT_MAP[job.container], '--', job.outputPath)
  return args
}

export class Win32MediaDriver implements MediaDomainDriver {
  readonly platformName = 'windows' as const
  readonly #commonLibs: CommonLibsManager
  readonly #processRunner: GuardedProcessRunner
  readonly #toolId: string
  readonly #probeExecRelPath: string
  readonly #transcodeExecRelPath: string

  constructor(options: Win32MediaDriverOptions) {
    this.#commonLibs = options.commonLibs
    this.#processRunner = options.processRunner
    this.#toolId = options.toolId ?? DEFAULT_WIN32_MEDIA_TOOL_ID
    this.#probeExecRelPath = options.probeExecRelPath ?? DEFAULT_WIN32_MEDIA_PROBE_REL
    this.#transcodeExecRelPath = options.transcodeExecRelPath ?? DEFAULT_WIN32_MEDIA_TRANSCODE_REL
  }

  getStaticToolIds(_primitiveId: MediaPrimitiveId): readonly string[] {
    return [this.#toolId]
  }

  async getCapabilityStatus(primitiveId: MediaPrimitiveId): Promise<ToolCapabilityStatus> {
    const rel = primitiveId === 'media.probe' ? this.#probeExecRelPath : this.#transcodeExecRelPath
    const ready = await this.#commonLibs.isToolReadyOffline(this.#toolId, rel)
    return ready ? 'ready' : 'needs_provisioning'
  }

  async ensureCapability(
    primitiveId: MediaPrimitiveId,
    signal?: AbortSignal,
    onProgress?: (payload: ToolTaskProgressPayload) => void
  ): Promise<{ readonly status: ToolCapabilityStatus; readonly provisioned: boolean }> {
    const rel = primitiveId === 'media.probe' ? this.#probeExecRelPath : this.#transcodeExecRelPath
    return ensureCommonLibExecutable(this.#commonLibs, this.#toolId, rel, signal, onProgress)
  }

  async probe(
    files: readonly ResolvedMediaProbeFile[],
    context: MediaDriverExecutionContext
  ): Promise<readonly MediaProbeItem[]> {
    await this.ensureCapability('media.probe', context.signal, context.onProgress)
    context.onToolUsed?.(this.#toolId)
    const releaseActive = this.#commonLibs.acquireActiveProcess(this.#toolId)

    try {
      return await runWithCommonLibBinaryRecovery(
        this.#commonLibs,
        {
          toolId: this.#toolId,
          relativeExecPath: this.#probeExecRelPath,
          primitiveId: 'media.probe',
          signal: context.signal,
          ...(context.onProgress ? { onProgress: context.onProgress } : {})
        },
        async (resolved) => {
          const items: MediaProbeItem[] = []
          for (const file of files) {
            if (context.signal.aborted) {
              throw createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.taskCancelled,
                'Media probe was cancelled',
                { primitiveId: 'media.probe' }
              )
            }
            const runResult = await this.#processRunner.run({
              exePath: resolved.executablePath,
              argv: [
                '-v',
                'quiet',
                '-print_format',
                'json',
                '-show_format',
                '-show_streams',
                '-protocol_whitelist',
                'file',
                '--',
                file.path
              ],
              signal: context.signal,
              timeoutMs: 30_000,
              tag: 'media.probe'
            })
            if (runResult.cancelled) {
              throw createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.taskCancelled,
                'Media probe was cancelled',
                { primitiveId: 'media.probe' }
              )
            }
            if (runResult.timedOut) {
              throw createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.executionTimeout,
                `Media probe timed out for "${file.displayName}"`,
                { primitiveId: 'media.probe', stage: 'executing', timedOut: true }
              )
            }
            if (runResult.exitCode !== 0) {
              throw createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.executionFailed,
                `Media probe failed for "${file.displayName}" (exitCode=${String(runResult.exitCode)})`,
                {
                  primitiveId: 'media.probe',
                  stage: 'executing',
                  exitCode: runResult.exitCode,
                  ...(runResult.stderr ? { detail: runResult.stderr } : {})
                }
              )
            }
            items.push(this.#parseProbeJson(runResult.stdout, file))
          }
          return items
        }
      )
    } finally {
      releaseActive()
    }
  }

  async transcode(
    job: ResolvedMediaTranscodeJob,
    context: MediaDriverExecutionContext
  ): Promise<MediaTranscodeResponse> {
    const startMs = Date.now()
    await this.ensureCapability('media.transcode', context.signal, context.onProgress)
    context.onToolUsed?.(this.#toolId)
    const releaseActive = this.#commonLibs.acquireActiveProcess(this.#toolId)

    try {
      return await runWithCommonLibBinaryRecovery(
        this.#commonLibs,
        {
          toolId: this.#toolId,
          relativeExecPath: this.#transcodeExecRelPath,
          primitiveId: 'media.transcode',
          signal: context.signal,
          ...(context.onProgress ? { onProgress: context.onProgress } : {})
        },
        async (resolved) => {
          context.onProgress?.({ phase: 'running', percent: 0 })
          const argv = buildSafeMediaTranscodeArgv(job)
          const totalDurationSec = job.trim?.durationSec
          let stdoutBuffer = ''

          const runResult = await this.#processRunner.run({
            exePath: resolved.executablePath,
            argv,
            signal: context.signal,
            timeoutMs: 300_000,
            tag: `media.transcode:${job.taskId}`,
            onStdoutChunk: (chunk) => {
              stdoutBuffer += chunk
              const lines = stdoutBuffer.split(/\r?\n/)
              stdoutBuffer = lines.pop() ?? ''
              for (const line of lines) {
                if (line.startsWith('out_time_us=')) {
                  const us = Number(line.slice('out_time_us='.length))
                  if (Number.isFinite(us) && us >= 0) {
                    const elapsedSec = us / 1_000_000
                    const percent =
                      totalDurationSec && totalDurationSec > 0
                        ? Math.min(99, Math.round((elapsedSec / totalDurationSec) * 100))
                        : undefined
                    context.onProgress?.({
                      phase: 'running',
                      ...(percent !== undefined ? { percent } : {})
                    })
                  }
                }
              }
            }
          })

          if (runResult.cancelled) {
            context.onProgress?.({ phase: 'cancelled' })
            throw createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.taskCancelled,
              'Media transcode task was cancelled',
              { primitiveId: 'media.transcode' }
            )
          }
          if (runResult.timedOut) {
            const timeoutErr = createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.executionTimeout,
              'Media transcode timed out',
              {
                primitiveId: 'media.transcode',
                stage: 'executing',
                timedOut: true,
                ...(runResult.stderr ? { detail: runResult.stderr } : {})
              }
            )
            context.onProgress?.({
              phase: 'failed',
              errorCode: TOOL_RUNTIME_ERROR_CODES.executionTimeout,
              retryable: true,
              userAction: 'retry',
              message: timeoutErr.message
            })
            throw timeoutErr
          }
          if (runResult.exitCode !== 0) {
            const execErr = createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.executionFailed,
              `Media transcode failed (exitCode=${String(runResult.exitCode)}): ${runResult.stderr.slice(0, 512)}`,
              {
                primitiveId: 'media.transcode',
                stage: 'executing',
                exitCode: runResult.exitCode,
                ...(runResult.stderr ? { detail: runResult.stderr } : {})
              }
            )
            context.onProgress?.({
              phase: 'failed',
              errorCode: TOOL_RUNTIME_ERROR_CODES.executionFailed,
              retryable: true,
              userAction: 'retry',
              message: execErr.message
            })
            throw execErr
          }

          context.onProgress?.({ phase: 'finalizing', percent: 99 })
          const outStat = await fs.stat(job.outputPath).catch(() => null)
          if (!outStat || !outStat.isFile()) {
            const missingOutErr = createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.executionFailed,
              'Media transcode finished without producing an output file',
              { primitiveId: 'media.transcode', stage: 'finalizing' }
            )
            context.onProgress?.({
              phase: 'failed',
              errorCode: TOOL_RUNTIME_ERROR_CODES.executionFailed,
              retryable: true,
              userAction: 'retry',
              message: missingOutErr.message
            })
            throw missingOutErr
          }

          context.onProgress?.({ phase: 'completed', percent: 100 })
          return {
            taskId: job.taskId,
            outputBytes: outStat.size,
            durationMs: Math.max(0, Date.now() - startMs),
            container: job.container
          }
        }
      )
    } finally {
      releaseActive()
    }
  }

  #parseProbeJson(rawOutput: string, file: ResolvedMediaProbeFile): MediaProbeItem {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawOutput)
    } catch {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.executionFailed,
        `Media probe returned malformed JSON for "${file.displayName}"`
      )
    }
    if (!isPlainObject(parsed)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.executionFailed,
        `Media probe returned non-object output for "${file.displayName}"`
      )
    }
    const format = isPlainObject(parsed.format) ? parsed.format : {}
    const rawStreams = Array.isArray(parsed.streams) ? parsed.streams : []
    const streams: MediaStreamInfo[] = []
    for (let i = 0; i < rawStreams.length; i += 1) {
      const s = rawStreams[i]
      if (!isPlainObject(s)) continue
      const codecType = typeof s.codec_type === 'string' ? s.codec_type : 'other'
      const kind: MediaStreamInfo['kind'] =
        codecType === 'video' || codecType === 'audio' || codecType === 'subtitle'
          ? codecType
          : 'other'
      const tags = isPlainObject(s.tags) ? s.tags : undefined
      const width = parseOptionalPositiveNumber(s.width)
      const height = parseOptionalPositiveNumber(s.height)
      const frameRate = parseFrameRateFraction(s.avg_frame_rate ?? s.r_frame_rate)
      const bitrateBps = parseOptionalPositiveNumber(s.bit_rate)
      const sampleRateHz = parseOptionalPositiveNumber(s.sample_rate)
      const channels = parseOptionalPositiveNumber(s.channels)
      const language = typeof tags?.language === 'string' ? tags.language : undefined
      streams.push({
        index: typeof s.index === 'number' && Number.isInteger(s.index) ? s.index : i,
        kind,
        ...(typeof s.codec_name === 'string' && s.codec_name ? { codec: s.codec_name } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(frameRate !== undefined ? { frameRate } : {}),
        ...(bitrateBps !== undefined ? { bitrateBps } : {}),
        ...(sampleRateHz !== undefined ? { sampleRateHz } : {}),
        ...(channels !== undefined ? { channels } : {}),
        ...(language ? { language } : {})
      })
    }

    const container =
      typeof format.format_name === 'string' && format.format_name
        ? format.format_name.split(',')[0]
        : undefined
    const durationSec = parseOptionalPositiveNumber(format.duration)
    const sizeBytes = parseOptionalPositiveNumber(format.size) ?? file.sizeBytes
    const bitrateBps = parseOptionalPositiveNumber(format.bit_rate)

    return {
      displayName: file.displayName,
      ...(container ? { container } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      sizeBytes,
      ...(bitrateBps !== undefined ? { bitrateBps } : {}),
      streams
    }
  }
}
