import fs from 'node:fs/promises'
import {
  TOOL_RUNTIME_ERROR_CODES,
  type ToolCapabilityStatus
} from '../../../../../contracts/tool-runtime/common.js'
import type {
  MediaContainerFormat,
  MediaPrimitiveId,
  MediaProbeItem,
  MediaStreamInfo,
  MediaTranscodeResponse
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
import { buildSafeMediaTranscodeArgv } from './win32-media.js'

/**
 * macOS 媒体能力域异构 Driver：
 * - 优先使用系统自带零下载原生能力（如 /usr/bin/mdls 探测基础元信息、/usr/bin/afconvert 处理原生音频容器）；
 * - 涉及多格式视频编解码与滤镜时，按需调度 macOS 独立签名工具包（绝不强绑 Windows .exe 名称）；
 * - 所有外部进程调用统一经由 GuardedProcessRunner；
 */

export const DEFAULT_DARWIN_MEDIA_TOOL_ID = 'darwin-media-toolkit-7.1.0'
export const DEFAULT_DARWIN_MEDIA_PROBE_REL = 'bin/media-probe'
export const DEFAULT_DARWIN_MEDIA_TRANSCODE_REL = 'bin/media-transcode'

export interface DarwinMediaDriverOptions {
  readonly commonLibs: CommonLibsManager
  readonly processRunner: GuardedProcessRunner
  /** 是否允许使用 macOS 系统原生命令行探测/音频转换（默认在 darwin 宿主机启用） */
  readonly enableSystemNativeTools?: boolean
  readonly toolId?: string
  readonly probeExecRelPath?: string
  readonly transcodeExecRelPath?: string
}

const DARWIN_NATIVE_AUDIO_CONTAINERS: Readonly<Partial<Record<MediaContainerFormat, { format: string; codec: string }>>> = {
  aac: { format: 'adts', codec: 'aac' },
  wav: { format: 'WAVE', codec: 'LEI16' },
  flac: { format: 'flac', codec: 'flac' }
}

function parseNumeric(raw: unknown): number | undefined {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export class DarwinMediaDriver implements MediaDomainDriver {
  readonly platformName = 'macos' as const
  readonly #commonLibs: CommonLibsManager
  readonly #processRunner: GuardedProcessRunner
  readonly #enableSystemNativeTools: boolean
  readonly #toolId: string
  readonly #probeExecRelPath: string
  readonly #transcodeExecRelPath: string

  constructor(options: DarwinMediaDriverOptions) {
    this.#commonLibs = options.commonLibs
    this.#processRunner = options.processRunner
    this.#enableSystemNativeTools = options.enableSystemNativeTools ?? process.platform === 'darwin'
    this.#toolId = options.toolId ?? DEFAULT_DARWIN_MEDIA_TOOL_ID
    this.#probeExecRelPath = options.probeExecRelPath ?? DEFAULT_DARWIN_MEDIA_PROBE_REL
    this.#transcodeExecRelPath = options.transcodeExecRelPath ?? DEFAULT_DARWIN_MEDIA_TRANSCODE_REL
  }

  getStaticToolIds(primitiveId: MediaPrimitiveId): readonly string[] {
    if (primitiveId === 'media.probe' && this.#enableSystemNativeTools) {
      return []
    }
    return [this.#toolId]
  }

  getOptionalExtensions(primitiveId: MediaPrimitiveId): readonly string[] {
    if (primitiveId === 'media.transcode') {
      return ['videotoolbox']
    }
    return []
  }

  async getCapabilityStatus(primitiveId: MediaPrimitiveId): Promise<ToolCapabilityStatus> {
    if (primitiveId === 'media.probe' && this.#enableSystemNativeTools) {
      return 'ready'
    }
    const rel = primitiveId === 'media.probe' ? this.#probeExecRelPath : this.#transcodeExecRelPath
    const ready = await this.#commonLibs.isToolReadyOffline(this.#toolId, rel)
    return ready ? 'ready' : 'needs_provisioning'
  }

  async ensureCapability(
    primitiveId: MediaPrimitiveId,
    signal?: AbortSignal,
    onProgress?: (payload: ToolTaskProgressPayload) => void
  ): Promise<{ readonly status: ToolCapabilityStatus; readonly provisioned: boolean }> {
    if (primitiveId === 'media.probe' && this.#enableSystemNativeTools) {
      return { status: 'ready', provisioned: false }
    }
    return this.#ensureCommonLibTool(primitiveId, signal, onProgress)
  }

  async #ensureCommonLibTool(
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
    // 若 macOS 签名媒体工具包已就绪则优先使用以获取全量流细节，否则回退系统原生 /usr/bin/mdls（零下载）
    if (await this.#commonLibs.isToolReadyOffline(this.#toolId, this.#probeExecRelPath)) {
      return this.#probeWithCommonLib(files, context)
    }
    if (!this.#enableSystemNativeTools) {
      await this.#ensureCommonLibTool('media.probe', context.signal, context.onProgress)
      return this.#probeWithCommonLib(files, context)
    }

    const items: MediaProbeItem[] = []
    let nativeFailed = false
    let nativeFailureError: unknown
    for (const file of files) {
      if (context.signal.aborted) {
        throw createToolRuntimeError(
          TOOL_RUNTIME_ERROR_CODES.taskCancelled,
          'Media probe was cancelled',
          { primitiveId: 'media.probe' }
        )
      }
      try {
        const res = await this.#processRunner.run({
          exePath: '/usr/bin/mdls',
          argv: [
            '-name',
            'kMDItemDurationSeconds',
            '-name',
            'kMDItemPixelWidth',
            '-name',
            'kMDItemPixelHeight',
            '-name',
            'kMDItemAudioSampleRate',
            '-name',
            'kMDItemAudioChannelCount',
            '-name',
            'kMDItemTotalBitRate',
            '-name',
            'kMDItemContentType',
            '--',
            file.path
          ],
          signal: context.signal,
          timeoutMs: 15_000,
          tag: 'darwin.media.probe'
        })
        if (res.cancelled) {
          throw createToolRuntimeError(TOOL_RUNTIME_ERROR_CODES.taskCancelled, 'Media probe cancelled', {
            primitiveId: 'media.probe'
          })
        }
        if (res.timedOut) {
          nativeFailed = true
          nativeFailureError = createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.executionTimeout,
            `macOS native media probe timed out for "${file.displayName}"`,
            { primitiveId: 'media.probe', stage: 'executing', timedOut: true }
          )
          break
        }
        if (res.exitCode !== 0) {
          nativeFailed = true
          nativeFailureError = createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.executionFailed,
            `macOS native media probe failed (exitCode=${String(res.exitCode)})`,
            {
              primitiveId: 'media.probe',
              stage: 'executing',
              exitCode: res.exitCode,
              ...(res.stderr ? { detail: res.stderr } : {})
            }
          )
          break
        }
        items.push(this.#parseMdlsOutput(res.stdout, file))
      } catch (error) {
        const hostCode = (error as { details?: { hostCode?: string } } | null)?.details?.hostCode
        if (hostCode === TOOL_RUNTIME_ERROR_CODES.taskCancelled || context.signal.aborted) {
          throw error
        }
        nativeFailed = true
        nativeFailureError = error
        break
      }
    }

    // 系统原生 /usr/bin/mdls 失败（如未建立 Spotlight 索引或系统工具异常）时，自动尝试拉取签名媒体工具包兜底
    if (nativeFailed) {
      try {
        await this.#ensureCommonLibTool('media.probe', context.signal, context.onProgress)
        return await this.#probeWithCommonLib(files, context)
      } catch {
        throw nativeFailureError
      }
    }
    return items
  }

  async transcode(
    job: ResolvedMediaTranscodeJob,
    context: MediaDriverExecutionContext
  ): Promise<MediaTranscodeResponse> {
    const startMs = Date.now()
    // 简单纯音频容器转换在 macOS 下优先走系统原生 /usr/bin/afconvert（无需外部包下载）；失败时自动回退签名媒体工具包
    const nativeAudioSpec = DARWIN_NATIVE_AUDIO_CONTAINERS[job.container]
    const canUseNativeAudio =
      this.#enableSystemNativeTools &&
      nativeAudioSpec !== undefined &&
      job.trim === undefined &&
      job.scale === undefined &&
      job.watermark === undefined &&
      !job.stripAudio &&
      (job.extractAudioOnly || job.videoCodec === undefined)

    if (canUseNativeAudio && !(await this.#commonLibs.isToolReadyOffline(this.#toolId, this.#transcodeExecRelPath))) {
      let nativeFallbackError: unknown
      try {
        context.onProgress?.({ phase: 'running', percent: 10 })
        const argv: string[] = ['-f', nativeAudioSpec.format, '-d', nativeAudioSpec.codec]
        if (job.audioSampleRateHz !== undefined) {
          argv.push('-r', String(job.audioSampleRateHz))
        }
        if (job.audioChannels !== undefined) {
          argv.push('-c', String(job.audioChannels))
        }
        if (job.audioBitrateKbps !== undefined) {
          argv.push('-b', String(job.audioBitrateKbps * 1000))
        }
        argv.push('--', job.inputPath, job.outputPath)
        const res = await this.#processRunner.run({
          exePath: '/usr/bin/afconvert',
          argv,
          signal: context.signal,
          timeoutMs: 180_000,
          tag: `darwin.afconvert:${job.taskId}`
        })
        if (res.cancelled) {
          context.onProgress?.({ phase: 'cancelled' })
          throw createToolRuntimeError(TOOL_RUNTIME_ERROR_CODES.taskCancelled, 'Media transcode cancelled', {
            primitiveId: 'media.transcode'
          })
        }
        if (!res.timedOut && res.exitCode === 0) {
          const stat = await fs.stat(job.outputPath).catch(() => null)
          if (stat && stat.isFile()) {
            context.onProgress?.({ phase: 'completed', percent: 100 })
            return {
              taskId: job.taskId,
              outputBytes: stat.size,
              durationMs: Math.max(0, Date.now() - startMs),
              container: job.container
            }
          }
        }
        nativeFallbackError = res.timedOut
          ? createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.executionTimeout,
              'macOS native audio transcode timed out',
              { primitiveId: 'media.transcode', stage: 'executing', timedOut: true }
            )
          : createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.executionFailed,
              `macOS native audio transcode failed (exitCode=${String(res.exitCode)})`,
              {
                primitiveId: 'media.transcode',
                stage: 'executing',
                exitCode: res.exitCode,
                ...(res.stderr ? { detail: res.stderr } : {})
              }
            )
      } catch (error) {
        const hostCode = (error as { details?: { hostCode?: string } } | null)?.details?.hostCode
        if (hostCode === TOOL_RUNTIME_ERROR_CODES.taskCancelled || context.signal.aborted) {
          throw error
        }
        nativeFallbackError = error
      }

      // 原生 afconvert 不支持当前输入或执行失败时，无缝回退至签名媒体工具包
      try {
        await this.#ensureCommonLibTool('media.transcode', context.signal, context.onProgress)
      } catch {
        throw nativeFallbackError
      }
    } else {
      await this.#ensureCommonLibTool('media.transcode', context.signal, context.onProgress)
    }

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
          const res = await this.#processRunner.run({
            exePath: resolved.executablePath,
            argv,
            signal: context.signal,
            timeoutMs: 300_000,
            tag: `darwin.media.transcode:${job.taskId}`
          })
          if (res.cancelled) {
            context.onProgress?.({ phase: 'cancelled' })
            throw createToolRuntimeError(TOOL_RUNTIME_ERROR_CODES.taskCancelled, 'Media transcode cancelled', {
              primitiveId: 'media.transcode'
            })
          }
          if (res.timedOut) {
            const timeoutErr = createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.executionTimeout,
              'macOS media transcode timed out',
              {
                primitiveId: 'media.transcode',
                stage: 'executing',
                timedOut: true,
                ...(res.stderr ? { detail: res.stderr } : {})
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
          if (res.exitCode !== 0) {
            const execErr = createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.executionFailed,
              `macOS media transcode failed (exitCode=${String(res.exitCode)}): ${res.stderr.slice(0, 512)}`,
              {
                primitiveId: 'media.transcode',
                stage: 'executing',
                exitCode: res.exitCode,
                ...(res.stderr ? { detail: res.stderr } : {})
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
          const stat = await fs.stat(job.outputPath).catch(() => null)
          if (!stat || !stat.isFile()) {
            const missingOutErr = createToolRuntimeError(
              TOOL_RUNTIME_ERROR_CODES.executionFailed,
              'macOS media transcode finished without producing an output file',
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
            outputBytes: stat.size,
            durationMs: Math.max(0, Date.now() - startMs),
            container: job.container
          }
        }
      )
    } finally {
      releaseActive()
    }
  }

  async #probeWithCommonLib(
    files: readonly ResolvedMediaProbeFile[],
    context: MediaDriverExecutionContext
  ): Promise<readonly MediaProbeItem[]> {
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
            const res = await this.#processRunner.run({
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
              tag: 'darwin.media.probe'
            })
            if (res.cancelled) {
              throw createToolRuntimeError(TOOL_RUNTIME_ERROR_CODES.taskCancelled, 'Media probe cancelled', {
                primitiveId: 'media.probe'
              })
            }
            if (res.timedOut) {
              throw createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.executionTimeout,
                `macOS media probe timed out for "${file.displayName}"`,
                { primitiveId: 'media.probe', stage: 'executing', timedOut: true }
              )
            }
            if (res.exitCode !== 0) {
              throw createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.executionFailed,
                `macOS media probe failed (exitCode=${String(res.exitCode)})`,
                {
                  primitiveId: 'media.probe',
                  stage: 'executing',
                  exitCode: res.exitCode,
                  ...(res.stderr ? { detail: res.stderr } : {})
                }
              )
            }
            let parsed: unknown
            try {
              parsed = JSON.parse(res.stdout)
            } catch {
              throw createToolRuntimeError(
                TOOL_RUNTIME_ERROR_CODES.executionFailed,
                `macOS media probe returned malformed JSON for "${file.displayName}"`,
                { primitiveId: 'media.probe', stage: 'finalizing' }
              )
            }
            const format = isPlainObject(parsed) && isPlainObject(parsed.format) ? parsed.format : {}
            const rawStreams = isPlainObject(parsed) && Array.isArray(parsed.streams) ? parsed.streams : []
            const streams: MediaStreamInfo[] = []
            for (let i = 0; i < rawStreams.length; i += 1) {
              const s = rawStreams[i]
              if (!isPlainObject(s)) continue
              const codecType = typeof s.codec_type === 'string' ? s.codec_type : 'other'
              const kind: MediaStreamInfo['kind'] =
                codecType === 'video' || codecType === 'audio' || codecType === 'subtitle'
                  ? codecType
                  : 'other'
              const width = parseNumeric(s.width)
              const height = parseNumeric(s.height)
              const sampleRateHz = parseNumeric(s.sample_rate)
              const channels = parseNumeric(s.channels)
              streams.push({
                index: typeof s.index === 'number' && Number.isInteger(s.index) ? s.index : i,
                kind,
                ...(typeof s.codec_name === 'string' && s.codec_name ? { codec: s.codec_name } : {}),
                ...(width !== undefined ? { width } : {}),
                ...(height !== undefined ? { height } : {}),
                ...(sampleRateHz !== undefined ? { sampleRateHz } : {}),
                ...(channels !== undefined ? { channels } : {})
              })
            }
            const durationSec = parseNumeric(format.duration)
            const bitrateBps = parseNumeric(format.bit_rate)
            items.push({
              displayName: file.displayName,
              ...(typeof format.format_name === 'string' && format.format_name
                ? { container: format.format_name.split(',')[0] }
                : {}),
              ...(durationSec !== undefined ? { durationSec } : {}),
              sizeBytes: parseNumeric(format.size) ?? file.sizeBytes,
              ...(bitrateBps !== undefined ? { bitrateBps } : {}),
              streams
            })
          }
          return items
        }
      )
    } finally {
      releaseActive()
    }
  }

  #parseMdlsOutput(stdout: string, file: ResolvedMediaProbeFile): MediaProbeItem {
    const kv = new Map<string, string>()
    for (const line of stdout.split(/\r?\n/)) {
      const idx = line.indexOf('=')
      if (idx <= 0) continue
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim().replace(/^"|"$/g, '')
      if (val && val !== '(null)') kv.set(key, val)
    }
    const durationSec = parseNumeric(kv.get('kMDItemDurationSeconds'))
    const width = parseNumeric(kv.get('kMDItemPixelWidth'))
    const height = parseNumeric(kv.get('kMDItemPixelHeight'))
    const sampleRateHz = parseNumeric(kv.get('kMDItemAudioSampleRate'))
    const channels = parseNumeric(kv.get('kMDItemAudioChannelCount'))
    const bitrateBps = parseNumeric(kv.get('kMDItemTotalBitRate'))
    const container = kv.get('kMDItemContentType')

    const streams: MediaStreamInfo[] = []
    if (width !== undefined || height !== undefined) {
      streams.push({
        index: streams.length,
        kind: 'video',
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {})
      })
    }
    if (sampleRateHz !== undefined || channels !== undefined) {
      streams.push({
        index: streams.length,
        kind: 'audio',
        ...(sampleRateHz !== undefined ? { sampleRateHz } : {}),
        ...(channels !== undefined ? { channels } : {})
      })
    }
    return {
      displayName: file.displayName,
      ...(container ? { container } : {}),
      ...(durationSec !== undefined ? { durationSec } : {}),
      sizeBytes: file.sizeBytes,
      ...(bitrateBps !== undefined ? { bitrateBps } : {}),
      streams
    }
  }
}
