import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { PNG } from 'pngjs'
import type { CallerIdentity } from '../../../contracts/capabilities.js'
import {
  buildMinimalValidPdf,
  captureScreenToPng,
  countPdfPages,
  formatBytes,
  isValidPdfBuffer,
  mergePdfBuffers,
  optimizePdfBuffer,
  processSingleImageFile,
  resolveHostSystemCommands,
  type ActiveRecordingSession,
  type HostPluginContext,
  type HostSystemCommands,
  escapePsSingleQuoted
} from './shared-utils.js'

/** 媒体与识别处理器的系统依赖：生产用真实实现，测试经构造参数注入替身（插件调用参数无法切换） */
export interface MediaOcrHostDeps extends HostSystemCommands {
  /** 截取整屏并保存为 PNG，返回是否真的写出了文件 */
  captureScreenToPng: typeof captureScreenToPng
  /** 启动长时间运行的 ffmpeg 录制进程 */
  spawnProcess: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  /** 调用方窗口关闭时回调 onClosed，返回取消监听的函数（用于插件窗口关闭后收尾录制） */
  watchCallerClosed: (caller: CallerIdentity | undefined, onClosed: () => void) => () => void
}

/** 批量图片旧接口真实支持的缩放预设（JS PNG 路径、GDI+ 脚本、ffmpeg 兜底三处都实现了），其余取值一律拒绝 */
const IMAGE_RESIZE_PRESETS = new Set(['source', 'scale50', 'max1920', 'max1280', 'ico256'])
/** 调用方可指定的输出格式 → 输出扩展名（ico 沿用旧行为：输出 256 以内的 PNG） */
const IMAGE_OUTPUT_FORMAT_EXT: Readonly<Record<string, string>> = {
  png: '.png',
  jpg: '.jpg',
  jpeg: '.jpg',
  webp: '.webp',
  bmp: '.bmp',
  gif: '.gif',
  tif: '.tiff',
  tiff: '.tiff',
  ico: '.png'
}
/** GDI+ 能编码的扩展名 → 脚本里的编码器标识；不在表里的（webp）只能交给 ffmpeg */
const GDI_IMAGE_ENCODERS: Readonly<Record<string, string>> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.bmp': 'bmp',
  '.gif': 'gif',
  '.tif': 'tiff',
  '.tiff': 'tiff'
}
/** ffmpeg 兜底额外支持编码的扩展名 */
const FFMPEG_ONLY_IMAGE_EXTS = new Set(['.webp'])

function isSupportedImageOutputExt(ext: string): boolean {
  return ext in GDI_IMAGE_ENCODERS || FFMPEG_ONLY_IMAGE_EXTS.has(ext)
}

/** 同一种格式的不同写法视为一致（.jpeg 与 .jpg、.tif 与 .tiff） */
function canonicalImageExt(ext: string): string {
  const lower = ext.toLowerCase()
  return lower === '.jpeg' ? '.jpg' : lower === '.tif' ? '.tiff' : lower
}

/** ffmpeg 兜底时按同样的缩放预设、灰阶与画质参数编码，不能只做格式转换却报告已按预设处理 */
function buildFfmpegImageArgs(
  src: string,
  out: string,
  options: { resizePreset: string; isGrayscale: boolean; targetExt: string; jpegQuality: number }
): string[] {
  const filters: string[] = []
  // 参数直接经 spawn 传给 ffmpeg（不经 shell），滤镜参数里的逗号按 ffmpeg 语法写成 \,
  if (options.resizePreset === 'scale50') {
    filters.push('scale=w=max(1\\,trunc(iw/2)):h=max(1\\,trunc(ih/2))')
  } else if (options.resizePreset === 'max1920' || options.resizePreset === 'max1280') {
    const edge = options.resizePreset === 'max1920' ? 1920 : 1280
    filters.push(`scale=w=min(iw\\,${edge}):h=min(ih\\,${edge}):force_original_aspect_ratio=decrease`)
  } else if (options.resizePreset === 'ico256') {
    filters.push('scale=w=min(iw\\,256):h=min(ih\\,256)')
  }
  if (options.isGrayscale) filters.push('hue=s=0')
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', src]
  if (filters.length > 0) args.push('-vf', filters.join(','))
  const ext = canonicalImageExt(options.targetExt)
  if (ext === '.jpg') {
    // mjpeg 的 -q:v 取 2~31，越小画质越高
    const q = options.jpegQuality >= 100 ? 1 : options.jpegQuality >= 95 ? 2 : options.jpegQuality >= 85 ? 3 : 6
    args.push('-q:v', String(q))
  } else if (ext === '.webp') {
    args.push('-q:v', String(options.jpegQuality))
  }
  args.push('-frames:v', '1', out)
  return args
}

/** 默认的调用方窗口关闭监听：Electron 主进程里按 webContentsId 监听 destroyed；拿不到 Electron（单元测试）时不监听 */
function watchCallerWebContentsClosed(caller: CallerIdentity | undefined, onClosed: () => void): () => void {
  const noop = (): void => undefined
  if (!caller || !Number.isInteger(caller.webContentsId) || caller.webContentsId <= 0) return noop
  let electronModule: typeof import('electron') | undefined
  try {
    electronModule = require('electron') as typeof import('electron')
  } catch (err) {
    console.warn('[MediaOcrHost] 无法加载 Electron，录制不会随调用方窗口关闭自动收尾:', err)
    return noop
  }
  const fromId = electronModule?.webContents?.fromId
  if (typeof fromId !== 'function') return noop
  const contents = fromId.call(electronModule.webContents, caller.webContentsId)
  if (!contents || contents.isDestroyed()) {
    // 调用方窗口已经不在了：立即收尾，不能让录制无人停止
    setImmediate(onClosed)
    return noop
  }
  contents.once('destroyed', onClosed)
  return () => {
    contents.removeListener('destroyed', onClosed)
  }
}

/** ffmpeg 启动后观察这么久仍在运行才算录制已开始（参数或输出格式错误时 ffmpeg 会立即退出） */
const FFMPEG_START_PROBE_MS = 800
/** 发送 q 后等待 ffmpeg 写完文件尾并退出的时间 */
const FFMPEG_STOP_TIMEOUT_MS = 5_000
/** 宿主关闭时等待录制收尾的时间 */
const FFMPEG_SHUTDOWN_TIMEOUT_MS = 3_000

/** 正在运行的 ffmpeg 录制：先写同目录临时文件，正常结束后才替换目标文件 */
interface FfmpegRecordingRun {
  child: ChildProcess
  tempPath: string
  /** 进程退出或启动失败时完成，不会 reject */
  exit: Promise<{ code: number | null; error?: string }>
  stderrTail: () => string
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 在限定时间内等待 promise，超时返回 null，并清掉计时器（不让悬挂的定时器拖住进程） */
async function waitWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export class MediaOcrHostPluginHandler {
  readonly #ctx: HostPluginContext
  readonly #sys: HostSystemCommands
  readonly #captureScreenToPng: typeof captureScreenToPng
  readonly #spawnProcess: MediaOcrHostDeps['spawnProcess']
  readonly #watchCallerClosed: MediaOcrHostDeps['watchCallerClosed']
  readonly #activeRecordings = new Map<string, ActiveRecordingSession>()
  readonly #ffmpegRuns = new Map<string, FfmpegRecordingRun>()
  /** 录制会话对应的“调用方窗口关闭”监听的取消函数 */
  readonly #callerWatches = new Map<string, () => void>()

  constructor(ctx: HostPluginContext, deps: Partial<MediaOcrHostDeps> = {}) {
    this.#ctx = ctx
    this.#sys = resolveHostSystemCommands(deps)
    this.#captureScreenToPng = deps.captureScreenToPng ?? captureScreenToPng
    this.#spawnProcess = deps.spawnProcess ?? ((command, args, options) => spawn(command, [...args], options))
    this.#watchCallerClosed = deps.watchCallerClosed ?? watchCallerWebContentsClosed
  }

  async stop(): Promise<void> {
    // 宿主关闭时让 ffmpeg 正常收尾（直接结束进程会留下缺少文件尾、无法播放的视频）
    const sessions = Array.from(this.#activeRecordings.values())
    await Promise.all(sessions.map((session) => this.#finalizeRecording(session, FFMPEG_SHUTDOWN_TIMEOUT_MS)))
  }

  async handleOcr(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const rawImagePath = String(params.imagePath ?? params.filePath ?? params.path ?? '').trim()
    const isCaptureAndRecognize =
      lowerFn === 'captureandrecognize' || lowerFn === 'screenocr' || lowerFn === 'capturescreenocr'

    if (
      isCaptureAndRecognize ||
      lowerFn === 'recognize' ||
      lowerFn === 'ocrfile' ||
      lowerFn === 'extracttext' ||
      rawImagePath
    ) {
      let targetPath = ''
      let tempCreated = false

      if (isCaptureAndRecognize && !rawImagePath) {
        const tempCapturePath = path.join(os.tmpdir(), `ztools_ocr_capture_${Date.now()}.png`)
        const captured = await this.#captureScreenToPng(tempCapturePath, signal)
        if (!captured || !fsSync.existsSync(tempCapturePath)) {
          return {
            ok: false,
            success: false,
            error: '屏幕截图采样失败，无法执行 OCR 识别'
          }
        }
        targetPath = tempCapturePath
        tempCreated = true
      } else if (rawImagePath) {
        targetPath = await this.#ctx.authorizeExistingPath(rawImagePath, caller, 'read')
      } else if (typeof params.base64 === 'string' && params.base64.trim()) {
        const rawB64 = params.base64.replace(/^data:image\/\w+;64,|^data:image\/\w+;base64,/, '')
        targetPath = path.join(os.tmpdir(), `ztools_ocr_${Date.now()}.png`)
        await fs.writeFile(targetPath, Buffer.from(rawB64, 'base64'))
        tempCreated = true
      } else if (
        this.#ctx.clipboard &&
        typeof (this.#ctx.clipboard as { getImage?: () => Promise<Buffer | string | null> }).getImage === 'function'
      ) {
        const clipImage = await (
          this.#ctx.clipboard as { getImage: () => Promise<Buffer | string | null> }
        ).getImage()
        if (clipImage) {
          targetPath = path.join(os.tmpdir(), `ztools_ocr_clip_${Date.now()}.png`)
          const buf = Buffer.isBuffer(clipImage)
            ? clipImage
            : Buffer.from(String(clipImage).replace(/^data:image\/\w+;base64,/, ''), 'base64')
          await fs.writeFile(targetPath, buf)
          tempCreated = true
        }
      }

      if (!targetPath || !fsSync.existsSync(targetPath)) {
        return { ok: false, success: false, error: '未提供有效的待识别图像文件' }
      }

      const rawLang = String(params.lang ?? params.languageModelId ?? params.language ?? '').trim()
      const normalizedWinLang = rawLang
        ? rawLang.toLowerCase().includes('en')
          ? 'en-US'
          : rawLang.toLowerCase().includes('ja') || rawLang.toLowerCase().includes('jp')
            ? 'ja-JP'
            : rawLang.toLowerCase().includes('zh') || rawLang.toLowerCase().includes('chi')
              ? 'zh-Hans-CN'
              : rawLang.replace(/[^a-zA-Z0-9-]/g, '')
        : ''

      let windowsOcrIssue = ''
      try {
        if (process.platform === 'win32') {
          const escapedPath = escapePsSingleQuoted(targetPath)
          const escapedLang = escapePsSingleQuoted(normalizedWinLang)
          const psScript = `
            $ErrorActionPreference = 'Stop'
            Add-Type -AssemblyName System.Runtime.WindowsRuntime
            $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
            $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
            $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
            $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
            $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
            Function Await($WinRtTask, $ResultType) {
              $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
              $netTask = $asTask.Invoke($null, @($WinRtTask))
              $netTask.Wait(-1) | Out-Null
              $netTask.Result
            }
            $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync('${escapedPath}')) ([Windows.Storage.StorageFile])
            $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
            $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $engine = $null
            if ('${escapedLang}' -ne '') {
              try {
                $langObj = New-Object Windows.Globalization.Language('${escapedLang}')
                if ([Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($langObj)) {
                  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langObj)
                }
              } catch {}
            }
            if ($null -eq $engine) {
              $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
            }
            if ($null -eq $engine) {
              $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('en-US')))
            }
            $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $lines = @($result.Lines | ForEach-Object { $_.Text })
            $stream.Dispose()
            [PSCustomObject]@{
              text = $result.Text
              lines = $lines
            } | ConvertTo-Json -Compress
          `
          // Windows.Media.Ocr 失败（脚本报错、超时、输出异常）只记下原因，继续尝试 tesseract，不能直接抛给调用方
          let out = ''
          try {
            out = await this.#sys.runPowerShell(psScript, 20_000, signal)
          } catch (err) {
            windowsOcrIssue = errorText(err)
          }
          if (out) {
            try {
              const parsed = JSON.parse(out) as { text?: string; lines?: string[] }
              const recognizedText = (parsed.text ?? (parsed.lines ?? []).join('\n')).trim()
              if (recognizedText.length > 0) {
                return {
                  ok: true,
                  success: true,
                  text: recognizedText,
                  lines: parsed.lines ?? recognizedText.split(/\r?\n/),
                  engine: 'Windows.Media.Ocr'
                }
              }
              windowsOcrIssue = '未识别到文字'
            } catch (err) {
              console.warn('[MediaOcrHost] Windows.Media.Ocr output JSON parse failed:', err)
              windowsOcrIssue = `输出格式异常（${errorText(err)}）`
            }
          } else if (!windowsOcrIssue) {
            windowsOcrIssue = '没有输出'
          }
          if (signal?.aborted) {
            return { ok: false, success: false, error: 'OCR 识别已取消' }
          }
        }

        const tesseractLang = rawLang
          ? rawLang.toLowerCase().includes('en')
            ? 'eng'
            : 'chi_sim+eng'
          : 'chi_sim+eng'
        const tesseract = await this.#sys.runCommand('tesseract', [targetPath, 'stdout', '-l', tesseractLang], 15_000, signal)
        if (tesseract.exitCode === 0 && tesseract.stdout.trim()) {
          const text = tesseract.stdout.trim()
          return {
            ok: true,
            success: true,
            text,
            lines: text.split(/\r?\n/),
            engine: 'Tesseract-CLI'
          }
        }
        const tesseractIssue =
          tesseract.exitCode === 0
            ? '未识别到文字'
            : `退出码 ${tesseract.exitCode}${tesseract.stderr.trim() ? `：${tesseract.stderr.trim().slice(0, 300)}` : ''}`
        const reasons = [windowsOcrIssue ? `Windows.Media.Ocr：${windowsOcrIssue}` : '', `Tesseract：${tesseractIssue}`]
          .filter(Boolean)
          .join('；')

        return {
          ok: false,
          success: false,
          error: `未检测到有效文字区域或 OCR 识别失败（${reasons}）`
        }
      } finally {
        if (tempCreated) {
          await fs.unlink(targetPath).catch(() => undefined)
        }
      }
    }

    return {
      ok: true,
      success: true,
      supportedLanguages: ['zh-Hans-CN', 'en-US', 'ja-JP'],
      engine: process.platform === 'win32' ? 'Windows.Media.Ocr' : 'SystemVision'
    }
  }

  async handleColorPicker(
    fn: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (lowerFn === 'pickcolor' || lowerFn === 'getcursorcolor' || lowerFn === 'samplepixel' || lowerFn === 'pick') {
      if (process.platform !== 'win32') {
        return {
          ok: false,
          success: false,
          error: '屏幕像素采样失败'
        }
      }

      const reqX = Number(params.x ?? 0)
      const reqY = Number(params.y ?? 0)
      const hasCoord = typeof params.x === 'number' && typeof params.y === 'number'
      // 坐标取整后插入脚本，只接受有限数字；NaN / Infinity 如实报错，不能改取鼠标位置冒充指定坐标的颜色
      if (hasCoord && (!Number.isFinite(reqX) || !Number.isFinite(reqY))) {
        return { ok: false, success: false, error: '屏幕像素采样失败：坐标必须是有限数字' }
      }
      const psScript = `
        $ErrorActionPreference = 'Stop'
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        ${hasCoord ? `$pt = New-Object System.Drawing.Point(${Math.round(reqX)}, ${Math.round(reqY)})` : `$pt = [System.Windows.Forms.Cursor]::Position`}
        $bmp = New-Object System.Drawing.Bitmap(1, 1)
        $graphics = [System.Drawing.Graphics]::FromImage($bmp)
        $graphics.CopyFromScreen($pt, [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size(1, 1)))
        $pixel = $bmp.GetPixel(0, 0)
        $graphics.Dispose()
        $bmp.Dispose()
        [PSCustomObject]@{
          x = $pt.X
          y = $pt.Y
          r = [int]$pixel.R
          g = [int]$pixel.G
          b = [int]$pixel.B
        } | ConvertTo-Json -Compress
      `
      // PowerShell 失败（非零退出、超时）同样如实返回采样失败，不能抛给调用方当成未知异常
      let raw: string
      try {
        raw = await this.#sys.runPowerShell(psScript, 8_000, signal)
      } catch (err) {
        return { ok: false, success: false, error: `屏幕像素采样失败：${err instanceof Error ? err.message : String(err)}` }
      }
      if (!raw) {
        return {
          ok: false,
          success: false,
          error: '屏幕像素采样失败'
        }
      }

      let x: number
      let y: number
      let r: number
      let g: number
      let b: number
      try {
        const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown; r?: unknown; g?: unknown; b?: unknown }
        // 坐标同样只取采样脚本实际读到的值：缺失时不能拿请求坐标或 0 顶替
        const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
        if (
          !isFiniteNumber(parsed.r) ||
          !isFiniteNumber(parsed.g) ||
          !isFiniteNumber(parsed.b) ||
          !isFiniteNumber(parsed.x) ||
          !isFiniteNumber(parsed.y)
        ) {
          return {
            ok: false,
            success: false,
            error: '屏幕像素采样失败'
          }
        }
        x = parsed.x
        y = parsed.y
        r = parsed.r
        g = parsed.g
        b = parsed.b
      } catch {
        return {
          ok: false,
          success: false,
          error: '屏幕像素采样失败'
        }
      }

      const hex = `#${[r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('').toUpperCase()}`
      const rgb = `rgb(${r}, ${g}, ${b})`
      if (params.copyToClipboard !== false && this.#ctx.clipboard) {
        await this.#ctx.clipboard.setText(hex).catch(() => undefined)
      }
      return {
        ok: true,
        success: true,
        x,
        y,
        r,
        g,
        b,
        hex,
        rgb
      }
    }

    return this.handleColorPicker('pickColor', params, signal)
  }

  async handleRecord(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const defaultOutDir = path.join(os.homedir(), 'Videos', 'ZTools_Recordings')
    const customSaveDir = String(params.saveDir ?? params.outputDir ?? '').trim()
    const baseOutDir = customSaveDir || defaultOutDir

    if (lowerFn === 'capturescreen' || lowerFn === 'screenshot' || lowerFn === 'takescreenshot') {
      const rawOutputPath =
        typeof params.outputPath === 'string' && params.outputPath.trim()
          ? params.outputPath.trim()
          : path.join(baseOutDir, `screenshot-${Date.now()}.png`)
      const resolvedOutput = await this.#ctx.authorizeOutputPath(rawOutputPath, caller)
      await fs.mkdir(path.dirname(resolvedOutput), { recursive: true })
      // [S-1] 严禁在抓屏失败时写入 320x180 灰色假 PNG；目标位置已有的旧文件也不能当成本次截图结果
      const frame = await this.#captureFrameTo(resolvedOutput, signal)
      if (!frame.ok) {
        return { ok: false, success: false, error: frame.error }
      }
      return {
        ok: true,
        success: true,
        outputPath: resolvedOutput,
        sizeBytes: frame.sizeBytes,
        sizeText: formatBytes(frame.sizeBytes)
      }
    }

    if (lowerFn === 'startrecording' || lowerFn === 'start') {
      const rawType = String(params.sourceModeId ?? params.type ?? 'video').toLowerCase()
      const type: 'video' | 'gif' | 'region' | 'audio' = rawType.includes('gif')
        ? 'gif'
        : rawType.includes('audio') || rawType.includes('mic')
          ? 'audio'
          : rawType.includes('region')
            ? 'region'
            : 'video'
      const rawContainer = String(params.codecContainer ?? params.format ?? '').toLowerCase()
      const ext =
        rawContainer.includes('gif') || type === 'gif'
          ? 'gif'
          : rawContainer.includes('mp3')
            ? 'mp3'
            : rawContainer.includes('wav') || type === 'audio'
              ? 'wav'
              : rawContainer.includes('mkv')
                ? 'mkv'
                : rawContainer.includes('webm')
                  ? 'webm'
                  : 'mp4'
      const rawOutputPath =
        typeof params.outputPath === 'string' && params.outputPath.trim()
          ? params.outputPath.trim()
          : path.join(baseOutDir, `record-${Date.now()}.${ext}`)
      const resolvedOutput = await this.#ctx.authorizeOutputPath(rawOutputPath, caller)
      await fs.mkdir(path.dirname(resolvedOutput), { recursive: true })
      const fps = Number(params.fps) || 30
      const sessionId = `rec-${Date.now()}`
      const startFailed = (error: string, errorCode?: string) => ({
        ok: false,
        success: false,
        recording: false,
        outputPath: resolvedOutput,
        ...(errorCode ? { errorCode } : {}),
        error
      })

      // PNG 单帧模式：开始时就抓一帧，失败直接返回错误，不进入录制状态，也不留下临时文件
      if (resolvedOutput.toLowerCase().endsWith('.png')) {
        const frame = await this.#captureFrameTo(resolvedOutput, signal)
        if (!frame.ok) return startFailed(frame.error)
        this.#activeRecordings.set(sessionId, { id: sessionId, type, outputPath: resolvedOutput, startedAt: Date.now(), fps })
        return {
          ok: true,
          success: true,
          recording: true,
          sessionId,
          outputPath: resolvedOutput,
          sizeBytes: frame.sizeBytes,
          startedAt: new Date().toISOString()
        }
      }

      // gdigrab 只能抓屏幕画面，旧接口从未实现录音；以前会“开始成功”，到停止时才因输出无效失败
      if (type === 'audio') {
        return startFailed('旧录制接口只能录制屏幕画面，不支持单独录音', 'UNSUPPORTED_ACTION')
      }
      const ffmpegCheck =
        process.env.ZTOOLS_DISABLE_FFMPEG === '1'
          ? { exitCode: 1, stdout: '', stderr: 'disabled' }
          : await this.#sys.runCommand('ffmpeg', ['-version'], 4_000, signal)
      if (ffmpegCheck.exitCode !== 0) {
        return startFailed('本机未检测到 ffmpeg，无法启动屏幕视频或音频录制')
      }
      if (process.platform !== 'win32') {
        return startFailed('旧录制接口只支持在 Windows 上用 ffmpeg 录制屏幕视频')
      }

      const parsedOut = path.parse(resolvedOutput)
      const tempPath = path.join(parsedOut.dir, `.${parsedOut.name}.ztools-recording-${Date.now()}${parsedOut.ext}`)
      // 不加 -t 时长上限：以前带 -t 60，超过 60 秒的录制被截断，停止时却按墙钟时间报告时长并成功。
      // 结束统一靠发送 q：调用方停止、调用方窗口关闭（见下方监听）或宿主退出（stop()）时收尾
      const run = this.#startFfmpegRun(
        ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-framerate', String(fps), '-i', 'desktop', tempPath],
        tempPath
      )
      if ('error' in run) return startFailed(run.error)
      // ffmpeg 参数、设备或输出格式有误时会立即退出：观察片刻仍在运行才报告录制已开始
      const early = await waitWithin(run.exit, FFMPEG_START_PROBE_MS)
      if (early) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined)
        const tail = run.stderrTail()
        return startFailed(
          `ffmpeg 录制进程启动后立即退出（${early.error ?? `退出码 ${early.code ?? '未知'}`}）${tail ? `：${tail}` : ''}`
        )
      }

      this.#ffmpegRuns.set(sessionId, run)
      this.#activeRecordings.set(sessionId, {
        id: sessionId,
        type,
        outputPath: resolvedOutput,
        startedAt: Date.now(),
        fps,
        childProcess: run.child
      })
      // 插件窗口关闭后没人会再调用停止：自动发送 q 收尾并保存文件，不让 ffmpeg 一直录到宿主退出
      try {
        const unwatch = this.#watchCallerClosed(caller, () => {
          const session = this.#activeRecordings.get(sessionId)
          if (!session) return
          void this.#finalizeRecording(session, FFMPEG_STOP_TIMEOUT_MS).then((result) => {
            if (result.ok) console.info('[MediaOcrHost] 调用方窗口已关闭，录制已收尾保存:', result.outputPath)
            else console.warn('[MediaOcrHost] 调用方窗口已关闭，录制收尾失败:', result.error)
          })
        })
        // 监听回调可能已同步触发并结束了会话，此时直接取消监听
        if (this.#activeRecordings.has(sessionId)) this.#callerWatches.set(sessionId, unwatch)
        else unwatch()
      } catch (err) {
        console.warn('[MediaOcrHost] 无法监听调用方窗口关闭，录制只能由停止指令或宿主退出收尾:', err)
      }

      return {
        ok: true,
        success: true,
        recording: true,
        sessionId,
        outputPath: resolvedOutput,
        startedAt: new Date().toISOString()
      }
    }

    if (lowerFn === 'stoprecording' || lowerFn === 'stop') {
      // 指定了会话却找不到时不能去结束别的会话；也不再把调用方给的任意已有文件报成录制结果
      const sessionId = String(params.sessionId ?? '').trim()
      const active = sessionId
        ? this.#activeRecordings.get(sessionId)
        : Array.from(this.#activeRecordings.values())[0]
      if (!active) {
        return {
          ok: false,
          success: false,
          recording: false,
          ...(sessionId ? { sessionId } : {}),
          error: sessionId ? `录制会话不存在或已结束：${sessionId}` : '当前没有正在进行的录制'
        }
      }
      return this.#finalizeRecording(active, FFMPEG_STOP_TIMEOUT_MS)
    }

    return {
      ok: true,
      success: true,
      recording: this.#activeRecordings.size > 0,
      sessions: Array.from(this.#activeRecordings.values()).map((s) => ({
        id: s.id,
        type: s.type,
        outputPath: s.outputPath,
        startedAt: s.startedAt,
        fps: s.fps
      }))
    }
  }

  /**
   * 抓取整屏写到 outputPath：先写同目录临时文件，确认非空后再替换目标。
   * 抓屏返回失败、抛错或写出空文件时，目标位置保持原样（旧文件不会被当成本次结果），临时文件一律删除。
   */
  async #captureFrameTo(
    outputPath: string,
    signal?: AbortSignal
  ): Promise<{ ok: true; sizeBytes: number } | { ok: false; error: string }> {
    const tempPath = `${outputPath}.ztools-capture-${Date.now()}.png`
    try {
      let captured: boolean
      try {
        captured = await this.#captureScreenToPng(tempPath, signal)
      } catch (err) {
        return { ok: false, error: `屏幕录制或抓图失败：${errorText(err)}` }
      }
      const stat = captured ? await fs.stat(tempPath).catch(() => null) : null
      if (!stat || !stat.isFile() || stat.size === 0) {
        return { ok: false, error: '屏幕录制或抓图失败，未生成有效输出文件' }
      }
      try {
        await fs.rename(tempPath, outputPath)
      } catch (err) {
        return { ok: false, error: `屏幕截图保存失败：${errorText(err)}` }
      }
      return { ok: true, sizeBytes: stat.size }
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  #startFfmpegRun(args: string[], tempPath: string): FfmpegRecordingRun | { error: string } {
    let child: ChildProcess
    try {
      // stdin 用来发送 q 让 ffmpeg 正常写完文件尾；stderr 必须持续读取，否则管道写满会卡住 ffmpeg
      child = this.#spawnProcess('ffmpeg', args, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    } catch (err) {
      return { error: `启动 ffmpeg 录制进程失败：${errorText(err)}` }
    }
    let tail = ''
    child.stderr?.on('data', (chunk: Buffer | string) => {
      tail = (tail + String(chunk)).slice(-2_000)
    })
    // 进程已退出后再写 stdin 会触发 EPIPE；没有监听的 error 事件会变成主进程未捕获异常
    child.stdin?.on('error', (err) => {
      tail = `${tail}\n${err.message}`.slice(-2_000)
    })
    const exit = new Promise<{ code: number | null; error?: string }>((resolve) => {
      child.once('error', (err) => resolve({ code: null, error: err.message }))
      child.once('close', (code) => resolve({ code }))
    })
    return { child, tempPath, exit, stderrTail: () => tail.trim() }
  }

  /** 结束录制并核对结果：ffmpeg 必须正常退出（退出码 0）且写出非空文件，才把临时文件替换为目标文件 */
  async #finalizeRecording(active: ActiveRecordingSession, stopTimeoutMs: number): Promise<Record<string, unknown>> {
    this.#activeRecordings.delete(active.id)
    const unwatch = this.#callerWatches.get(active.id)
    this.#callerWatches.delete(active.id)
    try {
      unwatch?.()
    } catch (err) {
      console.warn('[MediaOcrHost] 取消调用方窗口关闭监听失败:', err)
    }
    const run = this.#ffmpegRuns.get(active.id)
    this.#ffmpegRuns.delete(active.id)
    const durationMs = Date.now() - active.startedAt
    const failed = (error: string) => ({
      ok: false,
      success: false,
      recording: false,
      sessionId: active.id,
      outputPath: active.outputPath,
      error
    })

    if (run) {
      // 发送 q 让 ffmpeg 正常收尾；Windows 上 kill('SIGINT') 实际是强制结束进程，视频会缺少文件尾而无法播放
      try {
        run.child.stdin?.end('q')
      } catch (err) {
        console.warn('[MediaOcrHost] 向 ffmpeg 发送结束指令失败:', err)
      }
      let exit = await waitWithin(run.exit, stopTimeoutMs)
      const forced = !exit
      if (!exit) {
        try {
          run.child.kill()
        } catch (err) {
          console.warn('[MediaOcrHost] 结束 ffmpeg 录制进程失败:', err)
        }
        exit = await waitWithin(run.exit, 2_000)
      }
      if (forced || !exit || exit.code !== 0) {
        await fs.rm(run.tempPath, { force: true }).catch(() => undefined)
        const tail = run.stderrTail()
        const reason = forced
          ? 'ffmpeg 未能在限定时间内正常结束，录制文件可能不完整，已丢弃'
          : `ffmpeg 录制异常退出（${exit?.error ?? `退出码 ${exit?.code ?? '未知'}`}）${tail ? `：${tail}` : ''}`
        return failed(`屏幕录制失败：${reason}`)
      }
      const stat = await fs.stat(run.tempPath).catch(() => null)
      if (!stat || !stat.isFile() || stat.size === 0) {
        await fs.rm(run.tempPath, { force: true }).catch(() => undefined)
        return failed('屏幕录制或抓图失败，未生成有效输出文件')
      }
      try {
        await fs.rename(run.tempPath, active.outputPath)
      } catch (err) {
        await fs.rm(run.tempPath, { force: true }).catch(() => undefined)
        return failed(`录制文件保存失败：${errorText(err)}`)
      }
      return {
        ok: true,
        success: true,
        recording: false,
        sessionId: active.id,
        outputPath: active.outputPath,
        durationMs,
        sizeBytes: stat.size,
        sizeText: formatBytes(stat.size)
      }
    }

    // PNG 单帧模式：开始录制时已抓好并写入目标文件，这里只核对文件仍然有效
    const stat = await fs.stat(active.outputPath).catch(() => null)
    if (!stat || !stat.isFile() || stat.size === 0) {
      return failed('屏幕录制或抓图失败，未生成有效输出文件')
    }
    return {
      ok: true,
      success: true,
      recording: false,
      sessionId: active.id,
      outputPath: active.outputPath,
      durationMs,
      sizeBytes: stat.size,
      sizeText: formatBytes(stat.size)
    }
  }

  async handleScreenshots(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    if (
      lowerFn === 'capturescreen' ||
      lowerFn === 'captureregion' ||
      lowerFn === 'capturewindow' ||
      lowerFn === 'screenshot' ||
      lowerFn === 'takescreenshot'
    ) {
      return this.handleRecord('captureScreen', params, caller, signal)
    }

    const dir =
      typeof params.outputDir === 'string' && params.outputDir.trim()
        ? await this.#ctx.authorizeOutputPath(params.outputDir.trim(), caller)
        : path.join(os.homedir(), 'Pictures', 'ZTools_Screenshots')
    await fs.mkdir(dir, { recursive: true })
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    const files: Array<Record<string, unknown>> = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) continue
      const fullPath = path.join(dir, entry.name)
      const stat = await fs.stat(fullPath)
      files.push({
        id: entry.name,
        name: entry.name,
        path: fullPath,
        sizeBytes: stat.size,
        sizeText: formatBytes(stat.size),
        createdAt: stat.mtime.toISOString()
      })
    }
    return {
      ok: true,
      success: true,
      outputDir: dir,
      files,
      screenshots: files,
      items: files
    }
  }

  static #extractRawFilesParam(params: Record<string, unknown>): string[] {
    if (Array.isArray(params.files)) return params.files.map(String)
    if (Array.isArray(params.filePaths)) return params.filePaths.map(String)
    if (Array.isArray(params.paths)) return params.paths.map(String)
    if (typeof params.filePath === 'string' && params.filePath.trim()) return [params.filePath.trim()]
    if (typeof params.inputPath === 'string' && params.inputPath.trim()) return [params.inputPath.trim()]
    if (typeof params.path === 'string' && params.path.trim()) return [params.path.trim()]
    return []
  }

  async handleAiImage(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const rawFiles = MediaOcrHostPluginHandler.#extractRawFilesParam(params)

    if (
      lowerFn === 'processimage' ||
      lowerFn === 'processbatch' ||
      lowerFn === 'upscale' ||
      lowerFn === 'enhance' ||
      lowerFn === 'compress' ||
      rawFiles.length > 0
    ) {
      const mode = String(params.taskMode ?? params.engineId ?? params.mode ?? params.operation ?? fn ?? 'enhance')
      const scaleFactor =
        parseInt(String(params.scale ?? params.scaleFactor ?? (mode.includes('4') ? '4' : '2')), 10) || 2
      const rawOutFmt = String(params.outputFormat ?? params.format ?? '').trim().toLowerCase().replace(/^\./, '')
      const normalizedOutExt =
        rawOutFmt === 'png'
          ? '.png'
          : rawOutFmt === 'jpg' || rawOutFmt === 'jpeg'
            ? '.jpg'
            : rawOutFmt === 'bmp'
              ? '.bmp'
              : rawOutFmt === 'webp'
                ? '.webp'
                : ''

      const results: Array<Record<string, unknown>> = []
      const errors: Array<{ file: string; error: string }> = []

      for (const src of rawFiles) {
        try {
          const resolvedSrc = await this.#ctx.authorizeExistingPath(src, caller, 'read')
          const parsed = path.parse(resolvedSrc)
          const outDir =
            typeof params.outputDir === 'string' && params.outputDir.trim()
              ? await this.#ctx.authorizeOutputPath(params.outputDir.trim(), caller)
              : parsed.dir
          await fs.mkdir(outDir, { recursive: true })
          const targetExt = normalizedOutExt || parsed.ext || '.png'
          const safeSuffix = mode.toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'processed'
          const rawOutPath =
            typeof params.outputPath === 'string' && params.outputPath.trim() && rawFiles.length === 1
              ? params.outputPath.trim()
              : path.join(outDir, `${parsed.name}_${safeSuffix}${targetExt}`)
          const outPath = await this.#ctx.authorizeOutputPath(rawOutPath, caller)

          const info = await processSingleImageFile(resolvedSrc, outPath, mode, scaleFactor)
          results.push({
            sourcePath: resolvedSrc,
            outputPath: outPath,
            width: info.width,
            height: info.height,
            sizeBytes: info.outputBytes,
            outputBytes: info.outputBytes,
            outputSizeText: formatBytes(info.outputBytes)
          })
        } catch (err) {
          errors.push({
            file: src,
            error: err instanceof Error ? err.message : String(err)
          })
        }
      }

      if (errors.length > 0 && results.length === 0) {
        return {
          ok: false,
          success: false,
          processedCount: 0,
          results: [],
          errors,
          error: errors[0]!.error
        }
      }

      const first = results[0]
      const totalOutBytes = results.reduce((sum, r) => sum + Number(r.outputBytes ?? 0), 0)
      return {
        ok: errors.length === 0,
        success: results.length > 0,
        processedCount: results.length,
        outputPath: (first?.outputPath as string | undefined) ?? '',
        sizeBytes: Number(first?.outputBytes ?? totalOutBytes),
        outputBytes: Number(first?.outputBytes ?? totalOutBytes),
        width: Number(first?.width ?? 0),
        height: Number(first?.height ?? 0),
        results,
        errors
      }
    }

    return {
      ok: true,
      success: true,
      models: ['RealESRGAN-x2-Plus', 'RealESRGAN-x4-Anime', 'PNG-Lossless-Optimizer']
    }
  }

  static #normalizeMediaExtension(rawFormat: unknown, fallbackExt: string): string {
    const cleaned = String(rawFormat ?? '')
      .trim()
      .toLowerCase()
      .replace(/^\./, '')
    if (!cleaned || cleaned === 'keep' || cleaned === 'auto' || cleaned === 'same') {
      return fallbackExt
    }
    const baseToken = cleaned.split(/[_\-\s/]+/)[0] ?? ''
    const knownExts = new Set([
      'mp4',
      'mkv',
      'mov',
      'webm',
      'avi',
      'gif',
      'mp3',
      'flac',
      'aac',
      'wav',
      'ogg',
      'm4a',
      'opus',
      'wma'
    ])
    if (knownExts.has(baseToken)) return baseToken
    for (const ext of knownExts) {
      if (cleaned.includes(ext)) return ext
    }
    return baseToken || fallbackExt
  }

  async handleBatchMedia(
    pluginName: string,
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const rawFiles = MediaOcrHostPluginHandler.#extractRawFilesParam(params)

    if (lowerFn === 'probe' || lowerFn === 'getmediainfo' || lowerFn === 'inspect') {
      const items: Array<Record<string, unknown>> = []
      for (const f of rawFiles) {
        const resolved = await this.#ctx.authorizeExistingPath(f, caller, 'read')
        const stat = await fs.stat(resolved)
        items.push({
          path: resolved,
          name: path.basename(resolved),
          sizeBytes: stat.size,
          sizeText: formatBytes(stat.size),
          extension: path.extname(resolved).toLowerCase()
        })
      }
      return { ok: true, success: true, items }
    }

    // 普通转码不能冒充 AI 模型推理；探测仍可用，处理必须等真实引擎接入。
    if (pluginName === 'AiVideoPlugin') {
      return { ok: false, success: false, processedCount: 0, errorCode: 'NOT_SUPPORTED', error: 'AI 视频补帧、超分和降噪引擎尚未接入，无法执行增强；普通转码不能代替 AI 处理' }
    }

    if (rawFiles.length > 0) {
      const fallbackExt = pluginName === 'BatchAudioPlugin' ? 'mp3' : 'mp4'
      const rawFmt =
        params.format ?? params.outputFormat ?? params.outputContainer ?? params.container ?? fallbackExt
      const defaultExt = MediaOcrHostPluginHandler.#normalizeMediaExtension(rawFmt, fallbackExt)

      const ffmpegDisabled = process.env.ZTOOLS_DISABLE_FFMPEG === '1'
      const ffmpegCheck = ffmpegDisabled
        ? { exitCode: 1, stdout: '', stderr: 'disabled' }
        : await this.#sys.runCommand('ffmpeg', ['-version'], 4_000, signal)
      const hasFfmpeg = ffmpegCheck.exitCode === 0

      const results: Array<Record<string, unknown>> = []
      const errors: Array<{ file: string; error: string }> = []

      for (const src of rawFiles) {
        const resolvedSrc = await this.#ctx.authorizeExistingPath(src, caller, 'read')
        const parsed = path.parse(resolvedSrc)
        const srcExt = parsed.ext.toLowerCase().replace(/^\./, '')
        const targetExt = defaultExt.toLowerCase().replace(/^\./, '')

        const outDir =
          typeof params.outputDir === 'string' && params.outputDir.trim()
            ? await this.#ctx.authorizeOutputPath(params.outputDir.trim(), caller)
            : parsed.dir
        await fs.mkdir(outDir, { recursive: true })
        const rawOutPath =
          typeof params.outputPath === 'string' && params.outputPath.trim() && rawFiles.length === 1
            ? params.outputPath.trim()
            : path.join(outDir, `${parsed.name}_processed.${targetExt}`)
        const outPath = await this.#ctx.authorizeOutputPath(rawOutPath, caller)

        // [P-1] 仅当用户显式请求同格式无损复制时允许 fs.copyFile；其余转码/压缩/提取必须依赖真实 ffmpeg
        const isExplicitSameExtCopy =
          targetExt === srcExt &&
          (lowerFn.includes('copy') ||
            String(params.mode ?? '').toLowerCase() === 'copy' ||
            String(params.codec ?? '').toLowerCase() === 'copy')

        if (isExplicitSameExtCopy) {
          await fs.copyFile(resolvedSrc, outPath)
          const outStat = await fs.stat(outPath)
          results.push({
            sourcePath: resolvedSrc,
            outputPath: outPath,
            engine: 'LosslessStreamCopy',
            sizeBytes: outStat.size,
            outputBytes: outStat.size,
            sizeText: formatBytes(outStat.size)
          })
          continue
        }

        if (!hasFfmpeg) {
          errors.push({
            file: resolvedSrc,
            error: '本机未检测到 ffmpeg，无法执行音视频转码处理'
          })
          continue
        }

        const args = ['-y', '-i', resolvedSrc, outPath]
        const res = await this.#sys.runCommand('ffmpeg', args, 60_000, signal)
        if (res.exitCode !== 0 || !fsSync.existsSync(outPath)) {
          if (fsSync.existsSync(outPath)) {
            await fs.unlink(outPath).catch(() => undefined)
          }
          errors.push({
            file: resolvedSrc,
            error: res.stderr || 'ffmpeg 转码执行失败，未生成有效输出文件'
          })
          continue
        }

        const outStat = await fs.stat(outPath)
        if (outStat.size === 0) {
          await fs.unlink(outPath).catch(() => undefined)
          errors.push({
            file: resolvedSrc,
            error: 'ffmpeg 转码输出文件为空'
          })
          continue
        }

        results.push({
          sourcePath: resolvedSrc,
          outputPath: outPath,
          engine: 'ffmpeg',
          sizeBytes: outStat.size,
          outputBytes: outStat.size,
          sizeText: formatBytes(outStat.size)
        })
      }

      if (errors.length > 0 && results.length === 0) {
        return {
          ok: false,
          success: false,
          processedCount: 0,
          outputPath: '',
          sizeBytes: 0,
          outputBytes: 0,
          results: [],
          errors,
          error: errors[0]!.error
        }
      }

      const first = results[0]
      const totalBytes = results.reduce((sum, r) => sum + Number(r.sizeBytes ?? 0), 0)
      return {
        ok: errors.length === 0,
        success: results.length > 0,
        processedCount: results.length,
        outputPath: (first?.outputPath as string | undefined) ?? '',
        sizeBytes: Number(first?.sizeBytes ?? totalBytes),
        outputBytes: Number(first?.sizeBytes ?? totalBytes),
        results,
        errors
      }
    }

    return { ok: true, success: true, processedCount: 0, outputPath: '', sizeBytes: 0, outputBytes: 0, results: [] }
  }

  async handlePdf(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const effectiveOp = String(params.operation ?? params.mode ?? fn).toLowerCase()
    const rawFilePath = String(params.filePath ?? params.path ?? params.inputPath ?? '').trim()
    const rawFiles = Array.isArray(params.files)
      ? params.files.map(String)
      : rawFilePath
        ? [rawFilePath]
        : []

    if (
      effectiveOp.includes('pdftoword') ||
      effectiveOp.includes('pdftodoc') ||
      effectiveOp.includes('pdftoexcel') ||
      effectiveOp.includes('pdftoxls') ||
      effectiveOp.includes('pdftoppt')
    ) {
      return {
        ok: false,
        success: false,
        error: `当前宿主未安装 LibreOffice 转换组件，不支持将 PDF 转换为专有 Office 格式 (${params.operation ?? fn})`
      }
    }

    // PDF 转图片没有渲染引擎：以前会落到下面“处理现有 PDF”的分支，输出一份 PDF 却报转换成功
    if (
      effectiveOp.includes('pdftoimage') ||
      effectiveOp.includes('pdftopng') ||
      effectiveOp.includes('pdftojpg') ||
      effectiveOp.includes('pdftojpeg')
    ) {
      return {
        ok: false,
        success: false,
        errorCode: 'UNSUPPORTED_ACTION',
        error: `当前宿主没有 PDF 渲染组件，不支持将 PDF 转换为图片 (${params.operation ?? fn})`
      }
    }

    if (lowerFn === 'inspectpdf' || lowerFn === 'getpdfinfo' || lowerFn === 'inspect') {
      if (!rawFiles[0]) {
        return { ok: false, success: false, error: '未提供 PDF 文件路径' }
      }
      const resolvedFile = await this.#ctx.authorizeExistingPath(rawFiles[0], caller, 'read')
      const buf = await fs.readFile(resolvedFile)
      const isPdf = isValidPdfBuffer(buf)
      const pageCount = isPdf ? countPdfPages(buf) : 0
      const raw = buf.toString('latin1')
      const encrypted = /\/Encrypt\b/.test(raw)
      return {
        ok: true,
        success: true,
        path: resolvedFile,
        isPdf,
        pageCount,
        encrypted,
        sizeBytes: buf.byteLength,
        sizeText: formatBytes(buf.byteLength)
      }
    }

    if (
      lowerFn === 'pdftotxt' ||
      lowerFn === 'extracttext' ||
      lowerFn === 'pdftohtml' ||
      effectiveOp === 'pdftotxt' ||
      effectiveOp === 'extracttext' ||
      effectiveOp === 'pdftohtml'
    ) {
      if (!rawFiles[0]) {
        return { ok: false, success: false, error: '未提供 PDF 文件路径' }
      }
      const resolvedFile = await this.#ctx.authorizeExistingPath(rawFiles[0], caller, 'read')
      const buf = await fs.readFile(resolvedFile)
      if (!isValidPdfBuffer(buf)) {
        return { ok: false, success: false, error: '源文件不是有效的 PDF 格式' }
      }
      const raw = buf.toString('latin1')
      const literalMatches = Array.from(raw.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g)).map((m) =>
        (m[1] ?? '').replace(/\\([()\\])/g, '$1')
      )
      // 读不到文字就如实失败，不能用“PDF Document: 文件名 (大小)”冒充提取结果写进输出文件
      if (literalMatches.length === 0) {
        return {
          ok: false,
          success: false,
          error: '未能从 PDF 中提取到文字：可能是扫描件，或文字经过压缩/字体编码，旧接口无法解析'
        }
      }
      const extractedText = literalMatches.join('\n')
      const isHtml = lowerFn === 'pdftohtml' || effectiveOp === 'pdftohtml'
      const defaultExt = isHtml ? '.html' : '.txt'
      const outFile =
        typeof params.outputPath === 'string' && params.outputPath.trim()
          ? await this.#ctx.authorizeOutputPath(params.outputPath.trim(), caller)
          : await this.#ctx.authorizeOutputPath(`${resolvedFile}${defaultExt}`, caller)
      await fs.mkdir(path.dirname(outFile), { recursive: true })
      const outputContent = isHtml
        ? `<!doctype html><html><head><meta charset="utf-8"><title>${path.basename(resolvedFile)}</title></head><body><pre>${extractedText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></body></html>`
        : extractedText
      await fs.writeFile(outFile, outputContent, 'utf8')
      const outStat = await fs.stat(outFile)
      return {
        ok: true,
        success: true,
        operation: fn,
        outputPath: outFile,
        text: extractedText,
        sizeBytes: outStat.size,
        sizeText: formatBytes(outStat.size)
      }
    }

    // 显式从纯文本或图片新建 PDF 的场景
    const isExplicitCreateFromNonPdf =
      lowerFn === 'createpdffromtext' ||
      lowerFn === 'txttopdf' ||
      lowerFn === 'imagetopdf' ||
      (rawFiles.length > 0 &&
        rawFiles.every((f) => {
          const ext = path.extname(f).toLowerCase()
          return ext !== '' && ext !== '.pdf'
        }))

    if (isExplicitCreateFromNonPdf) {
      const rawOutPdf =
        typeof params.outputPath === 'string' && params.outputPath.trim()
          ? params.outputPath.trim()
          : rawFiles[0]
            ? path.join(path.dirname(rawFiles[0]), `${path.parse(rawFiles[0]).name}_output.pdf`)
            : path.join(os.tmpdir(), `ztools_pdf_${Date.now()}.pdf`)
      // 旧接口只能把少量 ASCII 纯文本写进单页 PDF：图片、Word、Excel 等以前只写入“Source File: 文件名”一行就报转换成功，
      // 中文会被替换成 ?、超过 45 行会被截掉，空内容会写成“Empty Document”。这些情况现在一律如实失败。
      const unsupportedInputs = rawFiles.filter((f) => !['.txt', '.md'].includes(path.extname(f).toLowerCase()))
      if (unsupportedInputs.length > 0) {
        return {
          ok: false,
          success: false,
          errorCode: 'UNSUPPORTED_ACTION',
          error: `当前宿主不支持将这些文件转换为 PDF（只支持 .txt / .md 纯文本）：${unsupportedInputs.map((f) => path.basename(f)).join('、')}`
        }
      }
      const contentLines: string[] = []
      if (typeof params.text === 'string' && params.text.trim()) {
        contentLines.push(...params.text.trim().split(/\r?\n/))
      }
      for (const f of rawFiles) {
        const resolvedInput = await this.#ctx.authorizeExistingPath(f, caller, 'read')
        const txt = await fs.readFile(resolvedInput, 'utf8')
        contentLines.push(...txt.split(/\r?\n/))
      }
      if (contentLines.every((line) => !line.trim())) {
        return { ok: false, success: false, error: '没有可写入 PDF 的文本内容' }
      }
      if (contentLines.some((line) => /[^\x20-\x7E\t]/.test(line))) {
        return {
          ok: false,
          success: false,
          errorCode: 'UNSUPPORTED_ACTION',
          error: '当前宿主生成 PDF 时没有内嵌中文等非 ASCII 字体，这些字符会变成问号，已停止生成'
        }
      }
      if (contentLines.length > 45) {
        return {
          ok: false,
          success: false,
          errorCode: 'UNSUPPORTED_ACTION',
          error: `当前宿主只能生成单页 PDF（最多 45 行），本次内容有 ${contentLines.length} 行，已停止生成以免截断`
        }
      }
      const resolvedOutPdf = await this.#ctx.authorizeOutputPath(rawOutPdf, caller)
      await fs.mkdir(path.dirname(resolvedOutPdf), { recursive: true })
      const pdfBuf = buildMinimalValidPdf(contentLines.map((line) => line.replace(/\t/g, '    ')))
      await fs.writeFile(resolvedOutPdf, pdfBuf)
      const outStat = await fs.stat(resolvedOutPdf)
      return {
        ok: true,
        success: true,
        operation: fn,
        outputPath: resolvedOutPdf,
        pageCount: 1,
        sizeBytes: outStat.size,
        sizeText: formatBytes(outStat.size)
      }
    }

    // [P-2] 针对现有 PDF 的合并/压缩/拆分/水印/解密操作：严禁使用 buildMinimalValidPdf 覆盖原文档
    if (rawFiles.length === 0) {
      return { ok: false, success: false, error: '未提供有效的源 PDF 文件路径' }
    }

    const inputBuffers: Buffer[] = []
    const resolvedInputPaths: string[] = []
    for (const f of rawFiles) {
      const resolvedInput = await this.#ctx.authorizeExistingPath(f, caller, 'read')
      if (!fsSync.existsSync(resolvedInput)) {
        return { ok: false, success: false, error: `源 PDF 文件不存在: ${resolvedInput}` }
      }
      const buf = await fs.readFile(resolvedInput)
      if (!isValidPdfBuffer(buf)) {
        return { ok: false, success: false, error: `文件不是有效的 PDF 格式: ${path.basename(resolvedInput)}` }
      }
      resolvedInputPaths.push(resolvedInput)
      inputBuffers.push(buf)
    }

    const primaryInput = resolvedInputPaths[0]!
    const rawOutPdf =
      typeof params.outputPath === 'string' && params.outputPath.trim()
        ? params.outputPath.trim()
        : path.join(path.dirname(primaryInput), `${path.parse(primaryInput).name}_output.pdf`)
    const resolvedOutPdf = await this.#ctx.authorizeOutputPath(rawOutPdf, caller)
    await fs.mkdir(path.dirname(resolvedOutPdf), { recursive: true })

    if (lowerFn === 'mergepdf' || lowerFn === 'merge' || effectiveOp === 'mergepdf' || inputBuffers.length > 1) {
      const merged = mergePdfBuffers(inputBuffers)
      await fs.writeFile(resolvedOutPdf, merged.buffer)
      const outStat = await fs.stat(resolvedOutPdf)
      return {
        ok: true,
        success: true,
        operation: fn,
        outputPath: resolvedOutPdf,
        pageCount: merged.pageCount,
        sizeBytes: outStat.size,
        sizeText: formatBytes(outStat.size)
      }
    }

    const watermarkText =
      typeof params.watermarkText === 'string' && params.watermarkText.trim()
        ? params.watermarkText.trim()
        : typeof params.text === 'string' && (lowerFn.includes('watermark') || effectiveOp.includes('watermark'))
          ? params.text.trim()
          : undefined

    const totalPages = Math.max(1, countPdfPages(inputBuffers[0]!))
    const pageRangeMode = String(params.pageRangeMode ?? params.rangeMode ?? '').toLowerCase().trim()

    if (pageRangeMode === 'single_split') {
      const splitFiles: string[] = []
      const parsedOut = path.parse(resolvedOutPdf)
      for (let i = 0; i < totalPages; i++) {
        const singlePage = optimizePdfBuffer(inputBuffers[0]!, { watermarkText, pageIndices: [i] })
        const pageOutPath =
          i === 0
            ? resolvedOutPdf
            : await this.#ctx.authorizeOutputPath(
                path.join(parsedOut.dir, `${parsedOut.name}_page_${i + 1}.pdf`),
                caller
              )
        await fs.writeFile(pageOutPath, singlePage.buffer)
        splitFiles.push(pageOutPath)
      }
      const outStat = await fs.stat(resolvedOutPdf)
      return {
        ok: true,
        success: true,
        operation: fn,
        sourcePath: primaryInput,
        outputPath: resolvedOutPdf,
        splitFiles,
        splitCount: splitFiles.length,
        pageCount: 1,
        originalSizeBytes: inputBuffers[0]!.byteLength,
        sizeBytes: outStat.size,
        sizeText: formatBytes(outStat.size)
      }
    }

    let pageIndices: number[] | undefined
    if (Array.isArray(params.pages)) {
      pageIndices = params.pages.map((p) => Number(p) - 1).filter((idx) => Number.isFinite(idx) && idx >= 0)
    } else if (typeof params.page === 'number') {
      pageIndices = [Math.max(0, params.page - 1)]
    } else if (pageRangeMode === 'first5') {
      pageIndices = Array.from({ length: Math.min(5, totalPages) }, (_, i) => i)
    } else if (pageRangeMode === 'odd') {
      pageIndices = Array.from({ length: totalPages }, (_, i) => i).filter((i) => (i + 1) % 2 === 1)
    } else if (pageRangeMode === 'even') {
      const evens = Array.from({ length: totalPages }, (_, i) => i).filter((i) => (i + 1) % 2 === 0)
      pageIndices = evens.length > 0 ? evens : [0]
    }

    const processed = optimizePdfBuffer(inputBuffers[0]!, { watermarkText, pageIndices })
    await fs.writeFile(resolvedOutPdf, processed.buffer)
    const outStat = await fs.stat(resolvedOutPdf)

    return {
      ok: true,
      success: true,
      operation: fn,
      sourcePath: primaryInput,
      outputPath: resolvedOutPdf,
      pageCount: processed.pageCount,
      originalSizeBytes: inputBuffers[0]!.byteLength,
      sizeBytes: outStat.size,
      sizeText: formatBytes(outStat.size)
    }
  }

  async handleBatchImage(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const rawFiles = MediaOcrHostPluginHandler.#extractRawFilesParam(params)

    if (lowerFn === 'mergeimagestopdf' || lowerFn === 'mergepdf' || String(params.mode ?? '').toLowerCase() === 'merge_pdf') {
      if (rawFiles.length === 0) {
        return { ok: false, success: false, error: '未提供待合并的图片文件路径' }
      }
      const resolvedInputs: string[] = []
      const pageStreams: string[] = []
      for (const f of rawFiles) {
        const resolved = await this.#ctx.authorizeExistingPath(f, caller, 'read')
        if (!fsSync.existsSync(resolved)) {
          return { ok: false, success: false, error: `源图片文件不存在: ${resolved}` }
        }
        const st = await fs.stat(resolved)
        resolvedInputs.push(resolved)
        const safeName = path.basename(resolved).replace(/[^\x20-\x7E]/g, '?').replace(/[()\\]/g, '\\$&')
        pageStreams.push(
          `BT\n/F1 12 Tf\n48 760 Td\n(Image Page: ${safeName}) Tj\n0 -20 Td\n(Size: ${formatBytes(st.size)}) Tj\nET`
        )
      }
      const primary = resolvedInputs[0]!
      const rawOutPdf =
        typeof params.outputPath === 'string' && params.outputPath.trim()
          ? params.outputPath.trim()
          : path.join(path.dirname(primary), `${path.parse(primary).name}_merged_images.pdf`)
      const outPdf = await this.#ctx.authorizeOutputPath(rawOutPdf, caller)
      await fs.mkdir(path.dirname(outPdf), { recursive: true })
      const pdfBuf = buildMinimalValidPdf(
        resolvedInputs.map((p, idx) => `Page ${idx + 1}: ${path.basename(p)}`)
      )
      const finalBuf = pageStreams.length > 1 ? mergePdfBuffers(resolvedInputs.map(p => buildMinimalValidPdf([path.basename(p)]))).buffer : pdfBuf
      await fs.writeFile(outPdf, finalBuf)
      const outStat = await fs.stat(outPdf)
      return {
        ok: true,
        success: true,
        operation: fn,
        outputPath: outPdf,
        pageCount: resolvedInputs.length,
        processedCount: resolvedInputs.length,
        sizeBytes: outStat.size,
        outputBytes: outStat.size,
        sizeText: formatBytes(outStat.size)
      }
    }

    if (rawFiles.length === 0) {
      return { ok: false, success: false, error: '未提供有效的待处理图片文件路径' }
    }

    const qualityTier = String(params.qualityTier ?? params.quality ?? 'q85').toLowerCase()
    const jpegQuality = qualityTier === 'q70' ? 70 : qualityTier === 'q95' ? 95 : qualityTier === 'lossless' ? 100 : 85
    // 缩放预设与输出格式会进入 PowerShell 脚本和 ffmpeg 参数：只接受白名单取值，其余如实拒绝（不再原样拼进脚本）
    const resizePreset = String(params.resizePreset ?? params.resize ?? 'source').trim().toLowerCase() || 'source'
    if (!IMAGE_RESIZE_PRESETS.has(resizePreset)) {
      return {
        ok: false,
        success: false,
        errorCode: 'INVALID_PARAMS',
        error: `不支持的缩放预设：${resizePreset.slice(0, 40)}（可选：${Array.from(IMAGE_RESIZE_PRESETS).join(' / ')}）`
      }
    }
    const rawOutFmt = String(params.outputFormat ?? params.format ?? 'keep').trim().toLowerCase().replace(/^\./, '')
    const isKeepFormatToken = !rawOutFmt || rawOutFmt === 'keep' || rawOutFmt === 'source'
    if (!isKeepFormatToken && !(rawOutFmt in IMAGE_OUTPUT_FORMAT_EXT)) {
      return {
        ok: false,
        success: false,
        errorCode: 'INVALID_PARAMS',
        error: `不支持的输出格式：${rawOutFmt.slice(0, 40)}（可选：keep / ${Object.keys(IMAGE_OUTPUT_FORMAT_EXT).join(' / ')}）`
      }
    }
    const isGrayscale =
      lowerFn.includes('grayscale') ||
      lowerFn.includes('enhancedoc') ||
      String(params.mode ?? '').toLowerCase().includes('doc') ||
      params.grayscale === true

    const results: Array<Record<string, unknown>> = []
    const errors: Array<{ file: string; error: string }> = []

    for (const src of rawFiles) {
      try {
        const resolvedSrc = await this.#ctx.authorizeExistingPath(src, caller, 'read')
        if (!fsSync.existsSync(resolvedSrc)) {
          errors.push({ file: src, error: `源图片文件不存在: ${resolvedSrc}` })
          continue
        }
        const srcStat = await fs.stat(resolvedSrc)
        if (srcStat.size === 0) {
          errors.push({ file: src, error: `源图片文件为空 (0 字节): ${resolvedSrc}` })
          continue
        }
        const parsed = path.parse(resolvedSrc)
        const srcExt = parsed.ext.toLowerCase()
        const keepSameFormat = isKeepFormatToken || `.${rawOutFmt}` === srcExt
        const targetExt = keepSameFormat ? srcExt || '.png' : IMAGE_OUTPUT_FORMAT_EXT[rawOutFmt]!
        // 保持原格式时扩展名来自源文件名，同样只接受能真实编码的格式（GDI+ 或 ffmpeg），其余如实报不支持
        if (!isSupportedImageOutputExt(targetExt)) {
          errors.push({
            file: src,
            error: `不支持输出 ${targetExt.slice(0, 20)} 格式的图片，请指定输出格式（png / jpg / webp / bmp / gif / tiff）`
          })
          continue
        }
        const explicitOutPath =
          typeof params.outputPath === 'string' && params.outputPath.trim() && rawFiles.length === 1
            ? params.outputPath.trim()
            : ''
        // 编码器按输出格式选择：显式输出路径的扩展名与之不一致时拒绝，避免内容与扩展名不符
        const explicitOutExt = path.extname(explicitOutPath)
        if (explicitOutExt && canonicalImageExt(explicitOutExt) !== canonicalImageExt(targetExt)) {
          errors.push({
            file: src,
            error: `输出路径扩展名 ${explicitOutExt.slice(0, 20)} 与输出格式 ${targetExt} 不一致`
          })
          continue
        }

        const outDir =
          typeof params.outputDir === 'string' && params.outputDir.trim()
            ? await this.#ctx.authorizeOutputPath(params.outputDir.trim(), caller)
            : parsed.dir
        await fs.mkdir(outDir, { recursive: true })
        const rawOutPath = explicitOutPath || path.join(outDir, `${parsed.name}_opt${targetExt}`)
        const outPath = await this.#ctx.authorizeOutputPath(rawOutPath, caller)

        let outWidth = 0
        let outHeight = 0
        let outBytes = 0

        if (srcExt === '.png' && targetExt === '.png') {
          const srcBuf = await fs.readFile(resolvedSrc)
          const png = PNG.sync.read(srcBuf)
          let targetW = png.width
          let targetH = png.height
          if (resizePreset === 'scale50') {
            targetW = Math.max(1, Math.round(png.width * 0.5))
            targetH = Math.max(1, Math.round(png.height * 0.5))
          } else if (resizePreset === 'max1920' && Math.max(png.width, png.height) > 1920) {
            const scale = 1920 / Math.max(png.width, png.height)
            targetW = Math.max(1, Math.round(png.width * scale))
            targetH = Math.max(1, Math.round(png.height * scale))
          } else if (resizePreset === 'max1280' && Math.max(png.width, png.height) > 1280) {
            const scale = 1280 / Math.max(png.width, png.height)
            targetW = Math.max(1, Math.round(png.width * scale))
            targetH = Math.max(1, Math.round(png.height * scale))
          } else if (resizePreset === 'ico256' || rawOutFmt === 'ico') {
            targetW = Math.min(256, png.width)
            targetH = Math.min(256, png.height)
          }

          const outPng = new PNG({ width: targetW, height: targetH })
          const quantMask = qualityTier === 'q70' ? 0xf0 : qualityTier === 'q85' ? 0xf8 : 0xff
          for (let y = 0; y < targetH; y++) {
            const sy = Math.min(png.height - 1, Math.floor((y * png.height) / targetH))
            for (let x = 0; x < targetW; x++) {
              const sx = Math.min(png.width - 1, Math.floor((x * png.width) / targetW))
              const sIdx = (png.width * sy + sx) << 2
              const dIdx = (targetW * y + x) << 2
              let r = (png.data[sIdx] ?? 0) & quantMask
              let g = (png.data[sIdx + 1] ?? 0) & quantMask
              let b = (png.data[sIdx + 2] ?? 0) & quantMask
              const a = png.data[sIdx + 3] ?? 255
              if (isGrayscale) {
                const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
                const bw = lum > 180 ? 255 : lum < 64 ? 0 : lum
                r = bw
                g = bw
                b = bw
              }
              outPng.data[dIdx] = r
              outPng.data[dIdx + 1] = g
              outPng.data[dIdx + 2] = b
              outPng.data[dIdx + 3] = a
            }
          }
          let encodedBuf = PNG.sync.write(outPng, { deflateLevel: 9 })
          // 零倒挂防线 (Zero-Regression Guard)：同格式同尺寸且未开启灰阶时，绝不输出比原图更大的文件
          if (keepSameFormat && targetW === png.width && targetH === png.height && !isGrayscale && encodedBuf.length > srcBuf.length) {
            encodedBuf = srcBuf
          }
          await fs.writeFile(outPath, encodedBuf)
          outWidth = targetW
          outHeight = targetH
          outBytes = encodedBuf.length
        } else if (process.platform === 'win32') {
          const encoded = await this.#encodeImageOnWindows(
            resolvedSrc,
            outPath,
            { targetExt, resizePreset, isGrayscale, jpegQuality },
            signal
          )
          const outStat = await fs.stat(outPath)
          if (keepSameFormat && resizePreset === 'source' && !isGrayscale && outStat.size > srcStat.size) {
            await fs.copyFile(resolvedSrc, outPath)
            outBytes = srcStat.size
          } else {
            outBytes = outStat.size
          }
          outWidth = encoded.width
          outHeight = encoded.height
        } else {
          const info = await processSingleImageFile(resolvedSrc, outPath, 'compress', 1)
          outWidth = info.width
          outHeight = info.height
          outBytes = info.outputBytes
        }

        const savedBytes = Math.max(0, srcStat.size - outBytes)
        results.push({
          sourcePath: resolvedSrc,
          outputPath: outPath,
          width: outWidth,
          height: outHeight,
          originalBytes: srcStat.size,
          sizeBytes: outBytes,
          outputBytes: outBytes,
          savedBytes,
          outputSizeText: formatBytes(outBytes)
        })
      } catch (err) {
        errors.push({
          file: src,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    if (errors.length > 0 && results.length === 0) {
      return {
        ok: false,
        success: false,
        processedCount: 0,
        results: [],
        errors,
        error: errors[0]!.error
      }
    }

    const first = results[0]
    const totalOutBytes = results.reduce((sum, r) => sum + Number(r.outputBytes ?? 0), 0)
    const totalSavedBytes = results.reduce((sum, r) => sum + Number(r.savedBytes ?? 0), 0)
    return {
      ok: errors.length === 0,
      success: results.length > 0,
      processedCount: results.length,
      outputPath: (first?.outputPath as string | undefined) ?? '',
      sizeBytes: totalOutBytes,
      outputBytes: totalOutBytes,
      savedBytes: totalSavedBytes,
      results,
      errors
    }
  }

  /**
   * Windows 上编码一张图片：先用 GDI+ 写同目录临时文件；GDI+ 打不开源图（webp / heic 等）或不能编码目标格式（webp）时交给 ffmpeg。
   * 两者都失败才抛错并带上两边的原因；成功后才把临时文件替换为目标文件，失败时目标位置保持原样。
   */
  async #encodeImageOnWindows(
    resolvedSrc: string,
    outPath: string,
    options: { targetExt: string; resizePreset: string; isGrayscale: boolean; jpegQuality: number },
    signal?: AbortSignal
  ): Promise<{ width: number; height: number; engine: 'GDI+' | 'ffmpeg' }> {
    const parsedOut = path.parse(outPath)
    await fs.mkdir(parsedOut.dir, { recursive: true })
    // 临时文件保留目标扩展名：ffmpeg 按扩展名选择输出格式
    const tempPath = path.join(parsedOut.dir, `.${parsedOut.name}.ztools-image-${Date.now()}${options.targetExt}`)
    const tempHasOutput = async (): Promise<boolean> => {
      const st = await fs.stat(tempPath).catch(() => null)
      return !!st && st.isFile() && st.size > 0
    }
    try {
      let gdiIssue: string
      const gdiEncoder = GDI_IMAGE_ENCODERS[options.targetExt]
      if (gdiEncoder) {
        const escapedSrc = escapePsSingleQuoted(resolvedSrc)
        const escapedOut = escapePsSingleQuoted(tempPath)
        const psScript = `
          $ErrorActionPreference = 'Stop'
          Add-Type -AssemblyName System.Drawing
          $format = '${escapePsSingleQuoted(gdiEncoder)}'
          $preset = '${escapePsSingleQuoted(options.resizePreset)}'
          $grayscale = ${options.isGrayscale ? '$true' : '$false'}
          $srcBmp = New-Object System.Drawing.Bitmap('${escapedSrc}')
          try {
            $w = [int]$srcBmp.Width
            $h = [int]$srcBmp.Height
            if ($preset -eq 'scale50') {
              $w = [Math]::Max(1, [int]($w * 0.5))
              $h = [Math]::Max(1, [int]($h * 0.5))
            } elseif ($preset -eq 'max1920' -and [Math]::Max($w, $h) -gt 1920) {
              $s = 1920.0 / [Math]::Max($w, $h)
              $w = [Math]::Max(1, [int]($w * $s))
              $h = [Math]::Max(1, [int]($h * $s))
            } elseif ($preset -eq 'max1280' -and [Math]::Max($w, $h) -gt 1280) {
              $s = 1280.0 / [Math]::Max($w, $h)
              $w = [Math]::Max(1, [int]($w * $s))
              $h = [Math]::Max(1, [int]($h * $s))
            } elseif ($preset -eq 'ico256') {
              $w = [Math]::Min(256, $w)
              $h = [Math]::Min(256, $h)
            }
            $dstBmp = New-Object System.Drawing.Bitmap($w, $h)
            try {
              $g = [System.Drawing.Graphics]::FromImage($dstBmp)
              try {
                $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
                if ($grayscale) {
                  $cm = New-Object System.Drawing.Imaging.ColorMatrix
                  $cm.Matrix00 = 0.299; $cm.Matrix01 = 0.299; $cm.Matrix02 = 0.299
                  $cm.Matrix10 = 0.587; $cm.Matrix11 = 0.587; $cm.Matrix12 = 0.587
                  $cm.Matrix20 = 0.114; $cm.Matrix21 = 0.114; $cm.Matrix22 = 0.114
                  $attr = New-Object System.Drawing.Imaging.ImageAttributes
                  try {
                    $attr.SetColorMatrix($cm)
                    $g.DrawImage($srcBmp, (New-Object System.Drawing.Rectangle(0, 0, $w, $h)), 0, 0, [int]$srcBmp.Width, [int]$srcBmp.Height, [System.Drawing.GraphicsUnit]::Pixel, $attr)
                  } finally {
                    $attr.Dispose()
                  }
                } else {
                  $g.DrawImage($srcBmp, 0, 0, $w, $h)
                }
              } finally {
                $g.Dispose()
              }
              if ($format -eq 'jpeg') {
                $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
                $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
                $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${Math.round(options.jpegQuality)})
                $dstBmp.Save('${escapedOut}', $codec, $encParams)
              } elseif ($format -eq 'bmp') {
                $dstBmp.Save('${escapedOut}', [System.Drawing.Imaging.ImageFormat]::Bmp)
              } elseif ($format -eq 'gif') {
                $dstBmp.Save('${escapedOut}', [System.Drawing.Imaging.ImageFormat]::Gif)
              } elseif ($format -eq 'tiff') {
                $dstBmp.Save('${escapedOut}', [System.Drawing.Imaging.ImageFormat]::Tiff)
              } elseif ($format -eq 'png') {
                $dstBmp.Save('${escapedOut}', [System.Drawing.Imaging.ImageFormat]::Png)
              } else {
                throw "不支持的编码格式：$format"
              }
              [PSCustomObject]@{ width = $w; height = $h } | ConvertTo-Json -Compress
            } finally {
              $dstBmp.Dispose()
            }
          } finally {
            $srcBmp.Dispose()
          }
        `
        try {
          const out = await this.#sys.runPowerShell(psScript, 20_000, signal)
          if (await tempHasOutput()) {
            let width = 0
            let height = 0
            try {
              const parsedJson = JSON.parse(out) as { width?: number; height?: number }
              width = Number(parsedJson.width) || 0
              height = Number(parsedJson.height) || 0
            } catch {
              // 尺寸只用于展示：读不到时报 0（未知），文件本身已由 GDI+ 写出
            }
            await fs.rename(tempPath, outPath)
            return { width, height, engine: 'GDI+' }
          }
          gdiIssue = '未生成输出文件'
        } catch (err) {
          gdiIssue = errorText(err)
        }
      } else {
        gdiIssue = `不支持编码 ${options.targetExt} 格式`
      }

      if (signal?.aborted) {
        throw new Error(`图片编码转换已取消: ${path.basename(resolvedSrc)}`)
      }
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
      const ff = await this.#sys.runCommand('ffmpeg', buildFfmpegImageArgs(resolvedSrc, tempPath, options), 25_000, signal)
      if (ff.exitCode === 0 && (await tempHasOutput())) {
        await fs.rename(tempPath, outPath)
        return { width: 0, height: 0, engine: 'ffmpeg' }
      }
      const ffStderr = ff.stderr.trim()
      const ffIssue =
        ff.exitCode === 0
          ? '未生成输出文件'
          : /ENOENT/.test(ffStderr)
            ? '本机未检测到 ffmpeg'
            : `退出码 ${ff.exitCode}${ffStderr ? `：${ffStderr.slice(-300)}` : ''}`
      throw new Error(`图片编码转换失败: ${path.basename(resolvedSrc)}（GDI+：${gdiIssue}；ffmpeg：${ffIssue}）`)
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined)
    }
  }

  static #extractRawTextFromInvoiceBuffer(buf: Buffer, ext: string): string {
    if (ext === '.xml' || ext === '.txt' || ext === '.csv') {
      return buf.toString('utf8')
    }
    const rawLatin = buf.toString('latin1')
    const chunks: string[] = [buf.toString('utf8')]

    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g
    let match: RegExpExecArray | null
    while ((match = streamRegex.exec(rawLatin)) !== null) {
      const bodyLatin = match[1] ?? ''
      chunks.push(bodyLatin)
      try {
        const inflated = zlib.inflateSync(Buffer.from(bodyLatin, 'latin1'))
        chunks.push(inflated.toString('utf8'))
        chunks.push(inflated.toString('latin1'))
      } catch {
        // Not a zlib stream or uses different predictor
      }
    }

    const joined = chunks.join('\n')
    const decodedHexParts: string[] = []
    const hexRegex = /<([0-9A-Fa-f]{4,})>/g
    let hexMatch: RegExpExecArray | null
    while ((hexMatch = hexRegex.exec(joined)) !== null) {
      const hexStr = hexMatch[1] ?? ''
      if (hexStr.length % 4 === 0) {
        try {
          const rawHexBuf = Buffer.from(hexStr, 'hex')
          const swapped = Buffer.from(rawHexBuf)
          swapped.swap16()
          decodedHexParts.push(swapped.toString('utf16le'))
        } catch {
          // ignore
        }
      }
    }

    const literalParts = Array.from(joined.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)/g)).map(
      (m) => (m[1] ?? '').replace(/\\([()\\])/g, '$1')
    )

    return [joined, ...decodedHexParts, ...literalParts].join('\n')
  }

  static #parseInvoiceMetadataFromText(filePath: string, rawText: string, sizeBytes: number): Record<string, unknown> {
    const fileName = path.basename(filePath, path.extname(filePath))
    const combined = `${rawText}\n${fileName}`

    // 1. 发票号码 (20位数电票号 或 8-12位传统票号)
    const xmlInvNo = combined.match(/<(?:InvoiceNumber|fphm|FpHm)>([0-9]{8,24})<\/(?:InvoiceNumber|fphm|FpHm)>/i)?.[1]
    const labelInvNo = combined.match(/(?:发票号码|票号|Invoice\s*No)[：:\s]*([0-9]{8,24})/i)?.[1]
    const twentyDigit = combined.match(/\b(2[0-9]{19})\b/)?.[1]
    const eightDigit = combined.match(/\b([0-9]{8,12})\b/)?.[1]
    const invoiceNo = xmlInvNo || labelInvNo || twentyDigit || eightDigit || ''

    // 2. 开票日期
    const xmlDate = combined.match(/<(?:IssueDate|kprq|Kprq)>([0-9]{4}[-年/.][0-9]{1,2}[-月/.][0-9]{1,2})/)?.[1]
    const dateMatch = combined.match(/(20[12][0-9])[-年/.](0?[1-9]|1[0-2])[-月/.](0?[1-9]|[12][0-9]|3[01])/)
    const issueDate = xmlDate
      ? xmlDate.replace(/[年月/.]/g, '-').replace(/日$/, '')
      : dateMatch
        ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`
        : new Date().toISOString().slice(0, 10)

    // 3. 价税合计金额与税额
    const xmlTotal = combined.match(/<(?:TotalAmount|TotalTax-includedAmount|jshj|Jshj|TaxInclusiveTotalAmount)>([0-9]+(?:\.[0-9]{1,2})?)<\//i)?.[1]
    const labelTotal =
      combined.match(/(?:价税合计|小写|合计金额|Total)[（(¥￥\s:：]*([0-9]+(?:\.[0-9]{1,2})?)/i)?.[1] ||
      combined.match(/[¥￥]\s*([0-9]+(?:\.[0-9]{1,2})?)/)?.[1] ||
      fileName.match(/([0-9]+\.[0-9]{1,2})元?/)?.[1]
    const totalAmount = Math.max(0, Number(xmlTotal ?? labelTotal ?? 0))

    const xmlTax = combined.match(/<(?:TaxAmount|TotaltaxAmount|se|Se|TotalTaxAmount)>([0-9]+(?:\.[0-9]{1,2})?)<\//i)?.[1]
    const labelTax = combined.match(/(?:税额|Tax)[：:\s¥￥]*([0-9]+(?:\.[0-9]{1,2})?)/i)?.[1]
    const taxAmount = xmlTax !== undefined || labelTax !== undefined
      ? Math.max(0, Number(xmlTax ?? labelTax ?? 0))
      : 0
    const netAmount = Math.max(0, Number((totalAmount - taxAmount).toFixed(2)))

    // 4. 销售方与购买方抬头
    const xmlSeller = combined.match(/<(?:SellerName|xhfmc|Xhfmc)>([^<\r\n]+)<\//i)?.[1]?.trim()
    const labelSeller = combined.match(/(?:销售方|销方名称|收款方)[名称：:\s]*([^\r\n，,;；]{2,36})/)?.[1]?.trim()
    const corpMatch = combined.match(/([\u4e00-\u9fa5A-Za-z0-9()（）]{2,24}(?:有限公司|股份有限公司|集团|事务所|酒店|航空|铁路|出行|科技|餐饮))/)?.[1]
    const sellerName = xmlSeller || labelSeller || corpMatch || '未知销售商户'

    const xmlBuyer = combined.match(/<(?:BuyerName|ghfmc|Ghfmc)>([^<\r\n]+)<\//i)?.[1]?.trim()
    const labelBuyer = combined.match(/(?:购买方|购方名称|付款方|抬头)[名称：:\s]*([^\r\n，,;；]{2,36})/)?.[1]?.trim()
    const buyerName = xmlBuyer || labelBuyer || ''

    const xmlTaxId = combined.match(/<(?:BuyerTaxId|ghfsbh|Ghfsbh)>([0-9A-Z]{15,20})<\//i)?.[1]?.trim()
    const labelTaxId = combined.match(/\b([0-9A-HJ-NPQRTUWXY]{2}[0-9]{6}[0-9A-HJ-NPQRTUWXY]{10})\b/)?.[1]
    const buyerTaxId = xmlTaxId || labelTaxId || ''

    // 5. 智能归类科目
    let category = '其他费用'
    if (/滴滴|出行|打车|客运|高铁|铁路|航空|机票|交通|通行费|加油/.test(combined)) {
      category = '差旅交通'
    } else if (/酒店|住宿|宾馆|旅馆|华住|如家|亚朵|万豪/.test(combined)) {
      category = '酒店住宿'
    } else if (/餐饮|美食|星巴克|瑞幸|咖啡|饭店|食品|茶饮/.test(combined)) {
      category = '餐饮招待'
    } else if (/京东|办公|文具|电脑|显示器|鼠标|键盘|耗材|数码|设备/.test(combined)) {
      category = '办公设备'
    } else if (/云|软件|技术服务|电信|移动|联通|宽带|通信|服务器|算力/.test(combined)) {
      category = '技术与云服务'
    }

    const isHeaderAbnormal =
      buyerName === '个人' ||
      buyerName.includes('个人') ||
      (buyerName !== '默认企业抬头' && !buyerTaxId && /个人|先生|女士/.test(buyerName))

    return {
      path: filePath,
      fileName: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase(),
      sizeBytes,
      sizeText: formatBytes(sizeBytes),
      invoiceNo,
      issueDate,
      sellerName,
      buyerName,
      buyerTaxId,
      totalAmount,
      taxAmount,
      netAmount,
      category,
      isHeaderAbnormal
    }
  }

  async handleInvoiceAssistant(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity,
    _signal?: AbortSignal
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const rawFiles = MediaOcrHostPluginHandler.#extractRawFilesParam(params)

    if (lowerFn === 'parseinvoices' || lowerFn === 'scaninvoices' || lowerFn === 'inspect') {
      const items: Array<Record<string, unknown>> = []
      const errors: Array<{ file: string; error: string }> = []
      const seenInvoiceNos = new Map<string, number>()

      for (const f of rawFiles) {
        try {
          const resolved = await this.#ctx.authorizeExistingPath(f, caller, 'read')
          if (!fsSync.existsSync(resolved)) {
            errors.push({ file: f, error: `发票文件不存在: ${resolved}` })
            continue
          }
          const st = await fs.stat(resolved)
          const ext = path.extname(resolved).toLowerCase()
          const buf = await fs.readFile(resolved)
          const rawText = MediaOcrHostPluginHandler.#extractRawTextFromInvoiceBuffer(buf, ext)
          const meta = MediaOcrHostPluginHandler.#parseInvoiceMetadataFromText(resolved, rawText, st.size)
          const invNo = String(meta.invoiceNo || '')
          const prevCount = seenInvoiceNos.get(invNo) ?? 0
          seenInvoiceNos.set(invNo, prevCount + 1)
          items.push({
            ...meta,
            isDuplicate: invNo !== '00000000' && prevCount > 0
          })
        } catch (err) {
          errors.push({ file: f, error: err instanceof Error ? err.message : String(err) })
        }
      }

      return {
        ok: errors.length === 0 || items.length > 0,
        success: items.length > 0 || rawFiles.length === 0,
        items,
        invoices: items,
        errors
      }
    }

    if (
      lowerFn === 'exportreimbursementbundle' ||
      lowerFn === 'exportreimbursementpackage' ||
      lowerFn === 'exportinvoicescsv' ||
      lowerFn === 'batchrenameinvoices' ||
      lowerFn === 'mergeinvoicespdf'
    ) {
      const invoiceItems = Array.isArray(params.invoices) ? (params.invoices as Array<Record<string, unknown>>) : []
      if (invoiceItems.length === 0 && rawFiles.length === 0) {
        return { ok: false, success: false, error: '未提供待导出的发票列表' }
      }

      const firstPath = String(invoiceItems[0]?.path ?? rawFiles[0] ?? '').trim()
      const resolvedFirst = await this.#ctx.authorizeExistingPath(firstPath, caller, 'read')
      const defaultOutDir = path.join(path.dirname(resolvedFirst), 'ZTools_Reimbursement_Export')
      const outDir =
        typeof params.outputDir === 'string' && params.outputDir.trim()
          ? await this.#ctx.authorizeOutputPath(params.outputDir.trim(), caller)
          : await this.#ctx.authorizeOutputPath(defaultOutDir, caller)
      await fs.mkdir(outDir, { recursive: true })

      const renamedFiles: string[] = []
      const pdfBuffers: Buffer[] = []
      const csvRows: string[] = [
        '序号,发票号码,开票日期,报销类目,销售方名称,购买方抬头,不含税金额(元),税额(元),价税合计(元),原文件名,归档文件名'
      ]

      let totalAmountSum = 0
      let totalTaxSum = 0
      let totalNetSum = 0

      const sourceList: Array<Record<string, unknown>> =
        invoiceItems.length > 0
          ? invoiceItems
          : rawFiles.map((p) => ({ path: p }))

      for (let i = 0; i < sourceList.length; i++) {
        const item = sourceList[i]!
        const srcPath = String(item.path ?? '').trim()
        const resolvedSrc = await this.#ctx.authorizeExistingPath(srcPath, caller, 'read')
        const buf = await fs.readFile(resolvedSrc)
        const ext = path.extname(resolvedSrc).toLowerCase()
        const parsedMeta =
          item.invoiceNo !== undefined
            ? item
            : MediaOcrHostPluginHandler.#parseInvoiceMetadataFromText(
                resolvedSrc,
                MediaOcrHostPluginHandler.#extractRawTextFromInvoiceBuffer(buf, ext),
                buf.byteLength
              )

        const invNo = String(parsedMeta.invoiceNo ?? '00000000')
        const issueDate = String(parsedMeta.issueDate ?? new Date().toISOString().slice(0, 10))
        const category = String(parsedMeta.category ?? '其他费用')
        const sellerName = String(parsedMeta.sellerName ?? '未知商户').replace(/[\\/:*?"<>|]/g, '_')
        const buyerName = String(parsedMeta.buyerName ?? '默认企业抬头')
        const totalAmount = Number(parsedMeta.totalAmount ?? 0)
        const taxAmount = Number(parsedMeta.taxAmount ?? 0)
        const netAmount = Number(parsedMeta.netAmount ?? Math.max(0, totalAmount - taxAmount))

        totalAmountSum += totalAmount
        totalTaxSum += taxAmount
        totalNetSum += netAmount

        const rawTargetName = String(
          item.targetFileName ??
            `[${category}]_${issueDate}_${sellerName}_${totalAmount.toFixed(2)}元_${invNo.slice(-4)}${ext}`
        ).replace(/[\\/:*?"<>|]/g, '_')

        const destFilePath = await this.#ctx.authorizeOutputPath(path.join(outDir, rawTargetName), caller)
        if (lowerFn !== 'exportinvoicescsv' && lowerFn !== 'mergeinvoicespdf') {
          await fs.copyFile(resolvedSrc, destFilePath)
          renamedFiles.push(destFilePath)
        }

        if (ext === '.pdf' && isValidPdfBuffer(buf)) {
          pdfBuffers.push(buf)
        }

        const escCsv = (val: string | number) => `"${String(val).replace(/"/g, '""')}"`
        csvRows.push(
          [
            i + 1,
            escCsv(invNo),
            escCsv(issueDate),
            escCsv(category),
            escCsv(sellerName),
            escCsv(buyerName),
            netAmount.toFixed(2),
            taxAmount.toFixed(2),
            totalAmount.toFixed(2),
            escCsv(path.basename(resolvedSrc)),
            escCsv(rawTargetName)
          ].join(',')
        )
      }

      csvRows.push(
        `合计,-,-,-,-,-,${totalNetSum.toFixed(2)},${totalTaxSum.toFixed(2)},${totalAmountSum.toFixed(2)},共 ${sourceList.length} 张,-`
      )

      let csvOutputPath = ''
      if (lowerFn !== 'batchrenameinvoices' && lowerFn !== 'mergeinvoicespdf') {
        csvOutputPath = await this.#ctx.authorizeOutputPath(
          path.join(outDir, '报销发票明细汇总表.csv'),
          caller
        )
        await fs.writeFile(csvOutputPath, `\uFEFF${csvRows.join('\r\n')}`, 'utf8')
      }

      let mergedPdfPath = ''
      if (pdfBuffers.length > 0 && lowerFn !== 'batchrenameinvoices' && lowerFn !== 'exportinvoicescsv') {
        mergedPdfPath = await this.#ctx.authorizeOutputPath(
          path.join(outDir, '报销发票合并打印版.pdf'),
          caller
        )
        const merged = mergePdfBuffers(pdfBuffers)
        await fs.writeFile(mergedPdfPath, merged.buffer)
      }

      return {
        ok: true,
        success: true,
        outputDir: outDir,
        processedCount: sourceList.length,
        renamedFiles,
        csvOutputPath,
        mergedPdfPath,
        totalAmount: Number(totalAmountSum.toFixed(2)),
        totalTax: Number(totalTaxSum.toFixed(2)),
        totalNet: Number(totalNetSum.toFixed(2))
      }
    }

    return { ok: false, success: false, error: `未知的发票助手操作: ${fn}` }
  }

  // ==================== 06. 音频输入输出设备一键切换 (AudioDevicePlugin) ====================
  // 旧接口编造设备状态：音量固定 80/75、把枚举到的第一个设备当默认、静音固定 false，
  // setDefault / setVolume / setMute 只改进程内存却报成功，skipSystemScan 时返回空列表成功，脚本还用了 PowerShell 5.1 不支持的 ??。
  // 音频设备插件已改走 audio_get_devices、audio_set_default_device、audio_set_volume、audio_toggle_mute 新接口（由系统服务真实读写并回读确认）。
  async handleAudioDevice(
    _fn: string,
    _params: Record<string, unknown>,
    _signal?: AbortSignal
  ): Promise<unknown> {
    return {
      ok: false,
      success: false,
      errorCode: 'UNSUPPORTED_ACTION',
      error: '请更新音频设备插件，通过新版接口读取和切换音频设备、调节音量与静音'
    }
  }
}
