import fs from 'node:fs/promises'
import path from 'node:path'
import {
  TOOL_RUNTIME_ERROR_CODES,
  type ToolCapabilityStatus,
  type ToolTaskId
} from '../../../../../contracts/tool-runtime/common.js'
import type {
  DownloadPrimitiveId,
  DownloadStreamProbeResponse,
  DownloadStreamRunResponse,
  DownloadStreamTrack,
  DownloadTransferRecord
} from '../../../../../contracts/tool-runtime/domains/download.js'
import {
  ensureCommonLibExecutable,
  runWithCommonLibBinaryRecovery,
  toCommonLibProvisionProgressPayload,
  type CommonLibsManager
} from '../../../core/commonlibs-manager.js'
import { createToolRuntimeError, isPlainObject } from '../../../core/errors.js'
import type { GuardedProcessRunner } from '../../../core/guarded-process.js'
import type { ToolTaskProgressPayload } from '../../../core/task-manager.js'
import type {
  DownloadDomainDriver,
  DownloadDriverExecutionContext,
  ResolvedDownloadStreamProbeJob,
  ResolvedDownloadStreamRunJob,
  ResolvedDownloadTransferAddJob
} from '../driver.js'
import { NativeHttpTransferEngine } from './native-http-transfer.js'

/**
 * 下载能力域共享 Driver 基类：
 * - 统一承载受控流解析 argv 构造、进度解析与原生 HTTP Range 断点续传引擎委托；
 * - 各平台子类仅声明自身 platformName、独立工具 ID / 可执行入口或覆写平台原生实现，杜绝重复代码。
 */

export interface CommonDownloadDriverBaseOptions {
  readonly platformName: 'windows' | 'macos'
  readonly tagPrefix: string
  readonly commonLibs: CommonLibsManager
  readonly processRunner: GuardedProcessRunner
  readonly streamToolId: string
  readonly streamExecRelPath: string
  /** 可选伴生媒体混流/音频转码工具 ID（用于分离流合并与纯音频提取） */
  readonly mediaToolId?: string
  readonly mediaExecRelPath?: string
  readonly fetchImpl?: typeof fetch
  readonly transferEngine?: NativeHttpTransferEngine
}

const STREAM_PROBE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/** 构建强制 UTF-8 标准输出的受控子进程环境变量（修复 Windows 中文路径与 JSON 标题乱码） */
function buildUtf8ProcessEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8'
  }
}

/** 校验目标文件真实路径位于授权输出目录内（防御外部工具打印越界路径） */
async function isPathWithinDirectory(parentDir: string, candidatePath: string): Promise<boolean> {
  try {
    const [realParent, realCandidate] = await Promise.all([
      fs.realpath(parentDir),
      fs.realpath(candidatePath)
    ])
    const normParent = process.platform === 'win32' ? realParent.toLowerCase() : realParent
    const normCandidate = process.platform === 'win32' ? realCandidate.toLowerCase() : realCandidate
    const rel = path.relative(normParent, normCandidate)
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
  } catch {
    return false
  }
}

function parseOptionalNumber(raw: unknown): number | undefined {
  const num = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isFinite(num) && num >= 0 ? num : undefined
}

/** 规范化安全远程 URL（仅放行 http:// 与 https://，自动补全协议相对链接 //） */
function sanitizeHttpUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 4096 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined
  const candidate = trimmed.startsWith('//') && !trimmed.startsWith('///') ? `https:${trimmed}` : trimmed
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.toString()
  } catch {
    return undefined
  }
}

/** 构造受控流媒体探测 argv（严格开启私有安全护栏） */
export function buildSafeStreamProbeArgv(url: string): readonly string[] {
  return [
    '--ignore-config',
    '--no-exec',
    '--no-playlist',
    '--no-warnings',
    '--dump-single-json',
    '--skip-download',
    '--',
    url
  ]
}

export interface BuildSafeStreamRunArgvOptions {
  /** 已通过离线验签的媒体转码工具目录（传入 --ffmpeg-location） */
  readonly ffmpegLocation?: string
}

/** 构造受控流媒体下载 argv（禁用配置、禁用钩子、禁用模板注入、显式 -- 分隔 URL） */
export function buildSafeStreamRunArgv(
  job: ResolvedDownloadStreamRunJob,
  options: BuildSafeStreamRunArgvOptions = {}
): readonly string[] {
  const outputTemplate = job.fileName
    ? path.join(job.outputDir, job.fileName)
    : path.join(job.outputDir, '%(id)s.%(ext)s')

  const args: string[] = [
    '--ignore-config',
    '--no-exec',
    '--no-playlist',
    '--no-warnings',
    '--restrict-filenames',
    '--newline',
    '--progress',
    job.overwrite ? '--force-overwrites' : '--no-overwrites',
    '-o',
    outputTemplate
  ]

  if (options.ffmpegLocation) {
    args.push('--ffmpeg-location', options.ffmpegLocation)
  }

  if (job.preferAudioOnly) {
    args.push('-f', job.trackId ?? 'bestaudio/best')
    if (job.audioFormat) {
      args.push('-x', '--audio-format', job.audioFormat)
    }
  } else {
    if (job.trackId) {
      args.push('-f', job.trackId)
    }
    if (job.mergeContainer) {
      args.push('--merge-output-format', job.mergeContainer)
    }
  }

  if (job.maxRateBytesPerSec !== undefined) {
    args.push('--limit-rate', String(job.maxRateBytesPerSec))
  }

  // 使用 %(filepath)j 让流下载引擎以纯 ASCII JSON (\uXXXX) 输出最终落盘路径，
  // 彻底免疫 Windows 非 UTF-8 系统代码页（如 CP936/GBK）下 PyInstaller 子进程 stdout 乱码
  args.push('--print', 'after_move:%(filepath)j', '--', job.url)
  return args
}

/**
 * 解析流下载引擎 --print 输出的落盘路径行：
 * - 优先解析 JSON 字符串（如 `"C:\\dir\\\u4e2d\u6587\\sample.mp3"`），兼容任意 Unicode 路径且免疫 Windows 代码页乱码；
 * - 向下兼容旧式裸绝对路径行；
 * - 拒绝状态行（`[...]`）、损坏 JSON、非字符串、空字节/控制字符或相对路径。
 */
export function parseReportedOutputPath(rawLine: string): string | undefined {
  const trimmed = rawLine.trim()
  if (!trimmed || trimmed.startsWith('[')) return undefined

  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"') || trimmed.length < 2) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return undefined
    }
    if (typeof parsed !== 'string') return undefined
    const decoded = parsed.trim()
    if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)) return undefined
    return path.isAbsolute(decoded) ? decoded : undefined
  }

  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined
  return path.isAbsolute(trimmed) ? trimmed : undefined
}

/** 解析流媒体探测 JSON 输出 */
export function parseStreamProbeOutput(rawStdout: string): DownloadStreamProbeResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawStdout)
  } catch {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.executionFailed,
      'Stream probe returned malformed JSON'
    )
  }
  if (!isPlainObject(parsed)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.executionFailed,
      'Stream probe returned non-object payload'
    )
  }
  const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : 'Untitled'
  const uploaderRaw =
    (typeof parsed.uploader === 'string' && parsed.uploader.trim()) ||
    (typeof parsed.channel === 'string' && parsed.channel.trim()) ||
    (typeof parsed.creator === 'string' && parsed.creator.trim()) ||
    ''
  const uploader = uploaderRaw ? uploaderRaw.slice(0, 256) : undefined
  const thumbnail = sanitizeHttpUrl(parsed.thumbnail)
  const webpageUrl = sanitizeHttpUrl(parsed.webpage_url ?? parsed.original_url)
  const durationSec = parseOptionalNumber(parsed.duration)
  const rawFormats = Array.isArray(parsed.formats) ? parsed.formats : []
  const tracks: DownloadStreamTrack[] = []

  for (const item of rawFormats) {
    if (!isPlainObject(item)) continue
    const trackId = typeof item.format_id === 'string' && item.format_id ? item.format_id : undefined
    if (!trackId) continue
    const hasVideo = typeof item.vcodec === 'string' && item.vcodec !== 'none'
    const hasAudio = typeof item.acodec === 'string' && item.acodec !== 'none'
    const kind: DownloadStreamTrack['kind'] =
      hasVideo && hasAudio ? 'combined' : hasVideo ? 'video' : 'audio'
    const width = parseOptionalNumber(item.width)
    const height = parseOptionalNumber(item.height)
    const frameRate = parseOptionalNumber(item.fps)
    const bitrateKbps = parseOptionalNumber(item.tbr)
    const sizeBytes = parseOptionalNumber(item.filesize ?? item.filesize_approx)
    const qualityLabel =
      typeof item.format_note === 'string' && item.format_note
        ? item.format_note
        : height !== undefined
          ? `${height}p`
          : undefined

    tracks.push({
      trackId,
      kind,
      ...(typeof item.ext === 'string' && item.ext ? { container: item.ext } : {}),
      ...(qualityLabel ? { qualityLabel } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(frameRate !== undefined ? { frameRate } : {}),
      ...(bitrateKbps !== undefined ? { bitrateKbps } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {})
    })
  }

  return {
    title,
    ...(uploader !== undefined ? { uploader } : {}),
    ...(thumbnail !== undefined ? { thumbnail } : {}),
    ...(webpageUrl !== undefined ? { webpageUrl } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    tracks
  }
}

export abstract class CommonDownloadDriverBase implements DownloadDomainDriver {
  readonly platformName: 'windows' | 'macos'
  readonly #tagPrefix: string
  readonly #commonLibs: CommonLibsManager
  readonly #processRunner: GuardedProcessRunner
  readonly #streamToolId: string
  readonly #streamExecRelPath: string
  readonly #mediaToolId?: string
  readonly #mediaExecRelPath?: string
  readonly #transferEngine: NativeHttpTransferEngine

  protected constructor(options: CommonDownloadDriverBaseOptions) {
    this.platformName = options.platformName
    this.#tagPrefix = options.tagPrefix
    this.#commonLibs = options.commonLibs
    this.#processRunner = options.processRunner
    this.#streamToolId = options.streamToolId
    this.#streamExecRelPath = options.streamExecRelPath
    if (options.mediaToolId && options.mediaExecRelPath) {
      this.#mediaToolId = options.mediaToolId
      this.#mediaExecRelPath = options.mediaExecRelPath
    }
    this.#transferEngine =
      options.transferEngine ??
      new NativeHttpTransferEngine({
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
      })
  }

  getStaticToolIds(primitiveId: DownloadPrimitiveId): readonly string[] {
    if (primitiveId === 'download.stream') {
      return [this.#streamToolId]
    }
    return []
  }

  async getCapabilityStatus(primitiveId: DownloadPrimitiveId): Promise<ToolCapabilityStatus> {
    if (primitiveId === 'download.transfer') {
      return 'ready'
    }
    const ready = await this.#commonLibs.isToolReadyOffline(this.#streamToolId, this.#streamExecRelPath)
    return ready ? 'ready' : 'needs_provisioning'
  }

  async ensureCapability(
    primitiveId: DownloadPrimitiveId,
    signal?: AbortSignal,
    onProgress?: (payload: ToolTaskProgressPayload) => void
  ): Promise<{ readonly status: ToolCapabilityStatus; readonly provisioned: boolean }> {
    if (primitiveId === 'download.transfer') {
      return { status: 'ready', provisioned: false }
    }
    return ensureCommonLibExecutable(
      this.#commonLibs,
      this.#streamToolId,
      this.#streamExecRelPath,
      signal,
      onProgress
    )
  }

  async probeStream(
    job: ResolvedDownloadStreamProbeJob,
    context: DownloadDriverExecutionContext
  ): Promise<DownloadStreamProbeResponse> {
    await this.ensureCapability('download.stream', context.signal, context.onProgress)
    context.onToolUsed?.(this.#streamToolId)
    const releaseActive = this.#commonLibs.acquireActiveProcess(this.#streamToolId)

    try {
      return await runWithCommonLibBinaryRecovery(
        this.#commonLibs,
        {
          toolId: this.#streamToolId,
          relativeExecPath: this.#streamExecRelPath,
          primitiveId: 'download.stream',
          signal: context.signal,
          ...(context.onProgress ? { onProgress: context.onProgress } : {})
        },
        async (resolved) => {
        const res = await this.#processRunner.run({
          exePath: resolved.executablePath,
          argv: buildSafeStreamProbeArgv(job.url),
          env: buildUtf8ProcessEnv(),
          signal: context.signal,
          timeoutMs: job.timeoutMs,
          maxOutputBytes: STREAM_PROBE_MAX_OUTPUT_BYTES,
          tag: `${this.#tagPrefix}.stream.probe`
        })
        if (res.cancelled) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.taskCancelled,
            'Stream probe was cancelled',
            { primitiveId: 'download.stream' }
          )
        }
        if (res.timedOut) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.executionTimeout,
            'Stream probe timed out',
            {
              primitiveId: 'download.stream',
              stage: 'executing',
              timedOut: true,
              ...(res.stderr ? { detail: res.stderr } : {})
            }
          )
        }
        if (res.exitCode !== 0) {
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.executionFailed,
            `Stream probe failed (exitCode=${String(res.exitCode)}): ${res.stderr.slice(0, 512)}`,
            {
              primitiveId: 'download.stream',
              stage: 'executing',
              exitCode: res.exitCode,
              ...(res.stderr ? { detail: res.stderr } : {})
            }
          )
        }
        return parseStreamProbeOutput(res.stdout)
      })
    } finally {
      releaseActive()
    }
  }

  async runStream(
    job: ResolvedDownloadStreamRunJob,
    context: DownloadDriverExecutionContext
  ): Promise<DownloadStreamRunResponse> {
    const startMs = Date.now()
    await this.ensureCapability('download.stream', context.signal, context.onProgress)
    context.onToolUsed?.(this.#streamToolId)
    const releaseActive = this.#commonLibs.acquireActiveProcess(this.#streamToolId)

    // 当请求显式需要混流/音频转码（audioFormat / mergeContainer / 分离流 trackId 含 +）时强制按需拉取媒体工具；
    // 若未显式要求但本机已离线缓存媒体工具，则静默注入 --ffmpeg-location 提升默认合并体验。
    const requiresMediaMuxer = Boolean(
      job.audioFormat || job.mergeContainer || (job.trackId && job.trackId.includes('+'))
    )
    let ffmpegLocation: string | undefined
    let releaseMediaActive: (() => void) | undefined

    try {
      if (this.#mediaToolId && this.#mediaExecRelPath) {
        const mediaReadyOffline = await this.#commonLibs.isToolReadyOffline(
          this.#mediaToolId,
          this.#mediaExecRelPath
        )
        if (requiresMediaMuxer && !mediaReadyOffline) {
          context.onProgress?.({ phase: 'provisioning', stage: 'fetching-catalog', percent: 0 })
          await this.#commonLibs.ensureTool(this.#mediaToolId, context.signal, (progress) => {
            context.onProgress?.(toCommonLibProvisionProgressPayload(progress))
          })
        }
        if (requiresMediaMuxer || mediaReadyOffline) {
          const mediaExec = await this.#commonLibs.resolveExecutable(
            this.#mediaToolId,
            this.#mediaExecRelPath
          )
          ffmpegLocation = path.dirname(mediaExec.executablePath)
          context.onToolUsed?.(this.#mediaToolId)
          releaseMediaActive = this.#commonLibs.acquireActiveProcess(this.#mediaToolId)
        }
      }

      return await runWithCommonLibBinaryRecovery(
        this.#commonLibs,
        {
          toolId: this.#streamToolId,
          relativeExecPath: this.#streamExecRelPath,
          primitiveId: 'download.stream',
          signal: context.signal,
          ...(context.onProgress ? { onProgress: context.onProgress } : {})
        },
        async (resolved) => {
        context.onProgress?.({ phase: 'running', percent: 0 })
        const argv = buildSafeStreamRunArgv(job, {
          ...(ffmpegLocation ? { ffmpegLocation } : {})
        })
        let lineBuf = ''
        let lastReportedPath: string | undefined
        const consumeStdoutLine = (rawLine: string): void => {
          const trimmed = rawLine.trim()
          if (!trimmed) return
          if (trimmed.startsWith('[')) {
            const match = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(trimmed)
            if (match) {
              const pct = Math.min(99, Math.round(Number(match[1])))
              if (Number.isFinite(pct)) {
                context.onProgress?.({ phase: 'running', percent: pct })
              }
            } else if (/^\[(?:Merger|ExtractAudio|Fixup[^\]]*)\]/i.test(trimmed)) {
              context.onProgress?.({ phase: 'finalizing', percent: 99 })
            }
            return
          }
          // 流式捕获最后一条输出路径（兼容 %(filepath)j 纯 ASCII JSON 转义与裸绝对路径），免疫长下载超出 maxOutputBytes 后的 stdout 尾部截断
          const reportedPath = parseReportedOutputPath(trimmed)
          if (reportedPath) {
            lastReportedPath = reportedPath
          }
        }

        const res = await this.#processRunner.run({
          exePath: resolved.executablePath,
          argv,
          env: buildUtf8ProcessEnv(),
          signal: context.signal,
          timeoutMs: job.timeoutMs,
          tag: `${this.#tagPrefix}.stream.run:${job.taskId}`,
          onStdoutChunk: (chunk) => {
            lineBuf += chunk
            const lines = lineBuf.split(/\r?\n/)
            lineBuf = lines.pop() ?? ''
            for (const line of lines) {
              consumeStdoutLine(line)
            }
          }
        })
        if (lineBuf.trim()) {
          consumeStdoutLine(lineBuf)
        }
        // 兼容未触发 onStdoutChunk 的进程执行器替身：若流式阶段未捕获到路径，再从 res.stdout 末尾兜底提取
        if (!lastReportedPath && res.stdout) {
          for (const line of res.stdout.split(/\r?\n/)) {
            const reportedPath = parseReportedOutputPath(line)
            if (reportedPath) {
              lastReportedPath = reportedPath
            }
          }
        }

        if (res.cancelled) {
          context.onProgress?.({ phase: 'cancelled' })
          throw createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.taskCancelled,
            'Stream download was cancelled',
            { primitiveId: 'download.stream' }
          )
        }
        if (res.timedOut) {
          const timeoutErr = createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.executionTimeout,
            'Stream download timed out',
            {
              primitiveId: 'download.stream',
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
            `Stream download failed (exitCode=${String(res.exitCode)}): ${res.stderr.slice(0, 512)}`,
            {
              primitiveId: 'download.stream',
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

        // 优先采用外部工具通过 --print after_move:%(filepath)j 报告的真实落盘路径（如音频提取/混流会自动改后缀）；
        // 同时强制校验该路径位于授权 outputDir 目录内，缺失或不存在时再回退显式 fileName。
        let resolvedOutputPath: string | undefined
        let resolvedStat: Awaited<ReturnType<typeof fs.stat>> | null = null
        if (lastReportedPath && (await isPathWithinDirectory(job.outputDir, lastReportedPath))) {
          const st = await fs.stat(lastReportedPath).catch(() => null)
          if (st && st.isFile()) {
            resolvedOutputPath = lastReportedPath
            resolvedStat = st
          }
        }
        if (!resolvedOutputPath && job.fileName) {
          const fallbackPath = path.join(job.outputDir, job.fileName)
          if (await isPathWithinDirectory(job.outputDir, fallbackPath)) {
            const st = await fs.stat(fallbackPath).catch(() => null)
            if (st && st.isFile()) {
              resolvedOutputPath = fallbackPath
              resolvedStat = st
            }
          }
        }

        if (!resolvedOutputPath || !resolvedStat) {
          const missingOutErr = createToolRuntimeError(
            TOOL_RUNTIME_ERROR_CODES.executionFailed,
            lastReportedPath
              ? 'Stream download output file is missing or outside authorized directory'
              : 'Stream download finished without producing an output file',
            { primitiveId: 'download.stream', stage: 'finalizing' }
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

        context.onProgress?.({
          phase: 'completed',
          percent: 100,
          transferredBytes: resolvedStat.size,
          totalBytes: resolvedStat.size
        })
        return {
          taskId: job.taskId,
          outputFileName: path.basename(resolvedOutputPath),
          outputBytes: resolvedStat.size,
          durationMs: Math.max(0, Date.now() - startMs)
        }
      })
    } finally {
      releaseMediaActive?.()
      releaseActive()
    }
  }

  addTransfer(
    job: ResolvedDownloadTransferAddJob,
    context: DownloadDriverExecutionContext
  ): Promise<DownloadTransferRecord> {
    return this.#transferEngine.add(job, context.onProgress)
  }

  pauseTransfer(taskId: ToolTaskId): Promise<DownloadTransferRecord> {
    return this.#transferEngine.pause(taskId)
  }

  resumeTransfer(taskId: ToolTaskId): Promise<DownloadTransferRecord> {
    return this.#transferEngine.resume(taskId)
  }

  cancelTransfer(taskId: ToolTaskId): Promise<DownloadTransferRecord> {
    return this.#transferEngine.cancel(taskId)
  }

  async getTransferStatus(taskId?: ToolTaskId): Promise<readonly DownloadTransferRecord[]> {
    return this.#transferEngine.status(taskId)
  }

  stop(): Promise<void> {
    return this.#transferEngine.stop()
  }
}
