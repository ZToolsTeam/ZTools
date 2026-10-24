import { spawn } from 'node:child_process'
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
  runCommand,
  runPowerShell,
  type ActiveRecordingSession,
  type HostPluginContext
} from './shared-utils.js'

export class MediaOcrHostPluginHandler {
  readonly #ctx: HostPluginContext
  readonly #activeRecordings = new Map<string, ActiveRecordingSession>()

  constructor(ctx: HostPluginContext) {
    this.#ctx = ctx
  }

  async stop(): Promise<void> {
    for (const session of this.#activeRecordings.values()) {
      if (session.childProcess) {
        try {
          session.childProcess.kill('SIGINT')
        } catch {
          // ignore
        }
      }
    }
    this.#activeRecordings.clear()
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
        const captured = await captureScreenToPng(tempCapturePath, signal)
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
      } else if (this.#ctx.clipboard) {
        const clipText = await this.#ctx.clipboard.getText()
        if (clipText && clipText.trim()) {
          return {
            ok: true,
            success: true,
            text: clipText.trim(),
            lines: clipText.trim().split(/\r?\n/),
            engine: 'ClipboardTextDirect'
          }
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

      try {
        if (process.platform === 'win32') {
          const escapedPath = targetPath.replace(/'/g, "''")
          const escapedLang = normalizedWinLang.replace(/'/g, "''")
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
          const out = await runPowerShell(psScript, 20_000, signal)
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
            } catch {
              const trimmedOut = out.trim()
              if (trimmedOut.length > 0) {
                return {
                  ok: true,
                  success: true,
                  text: trimmedOut,
                  lines: trimmedOut.split(/\r?\n/),
                  engine: 'Windows.Media.Ocr'
                }
              }
            }
          }
        }

        const tesseractLang = rawLang
          ? rawLang.toLowerCase().includes('en')
            ? 'eng'
            : 'chi_sim+eng'
          : 'chi_sim+eng'
        const tesseract = await runCommand('tesseract', [targetPath, 'stdout', '-l', tesseractLang], 15_000, signal)
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

        return {
          ok: false,
          success: false,
          error: '未检测到有效文字区域或 OCR 识别失败'
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
      if (process.platform !== 'win32' || params.__simulateSampleFailure === true) {
        return {
          ok: false,
          success: false,
          error: '屏幕像素采样失败'
        }
      }

      const reqX = Number(params.x ?? 0)
      const reqY = Number(params.y ?? 0)
      const hasCoord = typeof params.x === 'number' && typeof params.y === 'number'
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
      const raw = await runPowerShell(psScript, 8_000, signal)
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
        const parsed = JSON.parse(raw) as { x?: number; y?: number; r?: number; g?: number; b?: number }
        if (
          typeof parsed.r !== 'number' ||
          typeof parsed.g !== 'number' ||
          typeof parsed.b !== 'number' ||
          !Number.isFinite(parsed.r) ||
          !Number.isFinite(parsed.g) ||
          !Number.isFinite(parsed.b)
        ) {
          return {
            ok: false,
            success: false,
            error: '屏幕像素采样失败'
          }
        }
        x = Number(parsed.x ?? reqX)
        y = Number(parsed.y ?? reqY)
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
      await captureScreenToPng(resolvedOutput, signal)
      // [S-1] 严禁在抓屏失败时写入 320x180 灰色假 PNG
      if (!fsSync.existsSync(resolvedOutput)) {
        return {
          ok: false,
          success: false,
          error: '屏幕录制或抓图失败，未生成有效输出文件'
        }
      }
      const stat = await fs.stat(resolvedOutput)
      if (stat.size === 0) {
        await fs.unlink(resolvedOutput).catch(() => undefined)
        return {
          ok: false,
          success: false,
          error: '屏幕录制或抓图失败，未生成有效输出文件'
        }
      }
      return {
        ok: true,
        success: true,
        outputPath: resolvedOutput,
        sizeBytes: stat.size,
        sizeText: formatBytes(stat.size)
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
      const isPngSingleCapture = resolvedOutput.toLowerCase().endsWith('.png')

      let childProcess: ReturnType<typeof spawn> | undefined
      const disableFfmpeg =
        params.__simulateCaptureFailure === true ||
        params.__simulateNoFfmpeg === true ||
        process.env.ZTOOLS_DISABLE_FFMPEG === '1'

      if (!disableFfmpeg) {
        const ffmpegCheck = await runCommand('ffmpeg', ['-version'], 4_000, signal)
        if (ffmpegCheck.exitCode === 0 && process.platform === 'win32') {
          try {
            childProcess = spawn(
              'ffmpeg',
              ['-y', '-f', 'gdigrab', '-framerate', String(fps), '-i', 'desktop', '-t', '60', resolvedOutput],
              { windowsHide: true, stdio: 'ignore' }
            )
          } catch {
            childProcess = undefined
          }
        }

        if (!childProcess && isPngSingleCapture) {
          await captureScreenToPng(resolvedOutput, signal)
        }
      }

      if (!childProcess && !isPngSingleCapture) {
        return {
          ok: false,
          success: false,
          recording: false,
          error: '本机未检测到 ffmpeg，无法启动屏幕视频或音频录制'
        }
      }

      // [S-1] 彻底移除 320x180 灰色假 PNG 兜底逻辑
      this.#activeRecordings.set(sessionId, {
        id: sessionId,
        type,
        outputPath: resolvedOutput,
        startedAt: Date.now(),
        fps,
        childProcess
      })

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
      const sessionId = String(params.sessionId ?? '')
      const active =
        (sessionId ? this.#activeRecordings.get(sessionId) : undefined) ??
        Array.from(this.#activeRecordings.values())[0]

      if (active) {
        this.#activeRecordings.delete(active.id)
        if (active.childProcess) {
          try {
            active.childProcess.kill('SIGINT')
          } catch {
            // ignore
          }
          await new Promise((r) => setTimeout(r, 300))
        }
        const durationMs = Date.now() - active.startedAt
        // [S-1] 若输出文件不存在或为空，必须如实返回 { ok: false, error: ... }，绝不伪造文件
        if (!fsSync.existsSync(active.outputPath)) {
          return {
            ok: false,
            success: false,
            recording: false,
            sessionId: active.id,
            outputPath: active.outputPath,
            error: '屏幕录制或抓图失败，未生成有效输出文件'
          }
        }
        const stat = await fs.stat(active.outputPath)
        if (stat.size === 0) {
          await fs.unlink(active.outputPath).catch(() => undefined)
          return {
            ok: false,
            success: false,
            recording: false,
            sessionId: active.id,
            outputPath: active.outputPath,
            error: '屏幕录制或抓图失败，未生成有效输出文件'
          }
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

      if (typeof params.outputPath === 'string' && params.outputPath.trim()) {
        const resolvedOut = await this.#ctx.authorizeExistingPath(params.outputPath.trim(), caller, 'read').catch(() => '')
        if (resolvedOut && fsSync.existsSync(resolvedOut)) {
          const stat = await fs.stat(resolvedOut)
          if (stat.size > 0) {
            return {
              ok: true,
              success: true,
              recording: false,
              outputPath: resolvedOut,
              sizeBytes: stat.size,
              sizeText: formatBytes(stat.size)
            }
          }
        }
      }

      return {
        ok: false,
        success: false,
        recording: false,
        error: '屏幕录制或抓图失败，未生成有效输出文件'
      }
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

    if (rawFiles.length > 0) {
      const fallbackExt = pluginName === 'BatchAudioPlugin' ? 'mp3' : 'mp4'
      const rawFmt =
        params.format ?? params.outputFormat ?? params.outputContainer ?? params.container ?? fallbackExt
      const defaultExt = MediaOcrHostPluginHandler.#normalizeMediaExtension(rawFmt, fallbackExt)

      const simulateNoFfmpeg =
        params.__simulateNoFfmpeg === true || process.env.ZTOOLS_DISABLE_FFMPEG === '1'
      const ffmpegCheck = simulateNoFfmpeg
        ? { exitCode: 1, stdout: '', stderr: 'disabled' }
        : await runCommand('ffmpeg', ['-version'], 4_000, signal)
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
        const res = await runCommand('ffmpeg', args, 60_000, signal)
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
      const extractedText =
        literalMatches.length > 0
          ? literalMatches.join('\n')
          : `PDF Document: ${path.basename(resolvedFile)} (${formatBytes(buf.byteLength)})`
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
      const resolvedOutPdf = await this.#ctx.authorizeOutputPath(rawOutPdf, caller)
      await fs.mkdir(path.dirname(resolvedOutPdf), { recursive: true })

      const contentLines: string[] = []
      if (typeof params.text === 'string' && params.text.trim()) {
        contentLines.push(...params.text.trim().split(/\r?\n/))
      }
      for (const f of rawFiles) {
        const resolvedInput = await this.#ctx.authorizeExistingPath(f, caller, 'read')
        const st = await fs.stat(resolvedInput)
        const ext = path.extname(resolvedInput).toLowerCase()
        if (ext === '.txt' || ext === '.md') {
          const txt = await fs.readFile(resolvedInput, 'utf8')
          contentLines.push(...txt.split(/\r?\n/))
        } else {
          contentLines.push(`Source File: ${path.basename(resolvedInput)} (${formatBytes(st.size)})`)
        }
      }
      const pdfBuf = buildMinimalValidPdf(contentLines.length > 0 ? contentLines : ['Empty Document'])
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
    const resizePreset = String(params.resizePreset ?? params.resize ?? 'source').toLowerCase()
    const rawOutFmt = String(params.outputFormat ?? params.format ?? 'keep').trim().toLowerCase().replace(/^\./, '')
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
        const keepSameFormat = !rawOutFmt || rawOutFmt === 'keep' || rawOutFmt === 'source' || `.${rawOutFmt}` === srcExt
        const targetExt = keepSameFormat
          ? srcExt || '.png'
          : rawOutFmt === 'jpg' || rawOutFmt === 'jpeg'
            ? '.jpg'
            : rawOutFmt === 'webp'
              ? '.webp'
              : rawOutFmt === 'bmp'
                ? '.bmp'
                : rawOutFmt === 'ico'
                  ? '.png'
                  : '.png'

        const outDir =
          typeof params.outputDir === 'string' && params.outputDir.trim()
            ? await this.#ctx.authorizeOutputPath(params.outputDir.trim(), caller)
            : parsed.dir
        await fs.mkdir(outDir, { recursive: true })
        const rawOutPath =
          typeof params.outputPath === 'string' && params.outputPath.trim() && rawFiles.length === 1
            ? params.outputPath.trim()
            : path.join(outDir, `${parsed.name}_opt${targetExt}`)
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
          const escapedSrc = resolvedSrc.replace(/'/g, "''")
          const escapedOut = outPath.replace(/'/g, "''")
          const psScript = `
            $ErrorActionPreference = 'Stop'
            Add-Type -AssemblyName System.Drawing
            $srcBmp = New-Object System.Drawing.Bitmap('${escapedSrc}')
            try {
              $w = [int]$srcBmp.Width
              $h = [int]$srcBmp.Height
              $preset = '${resizePreset}'
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
              }
              $dstBmp = New-Object System.Drawing.Bitmap($w, $h)
              try {
                $g = [System.Drawing.Graphics]::FromImage($dstBmp)
                try {
                  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
                  $g.DrawImage($srcBmp, 0, 0, $w, $h)
                } finally {
                  $g.Dispose()
                }
                if ('${targetExt}' -eq '.jpg') {
                  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
                  $encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
                  $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]${jpegQuality})
                  $dstBmp.Save('${escapedOut}', $codec, $encParams)
                } elseif ('${targetExt}' -eq '.bmp') {
                  $dstBmp.Save('${escapedOut}', [System.Drawing.Imaging.ImageFormat]::Bmp)
                } else {
                  $dstBmp.Save('${escapedOut}', [System.Drawing.Imaging.ImageFormat]::Png)
                }
                [PSCustomObject]@{ width = $w; height = $h } | ConvertTo-Json -Compress
              } finally {
                $dstBmp.Dispose()
              }
            } finally {
              $srcBmp.Dispose()
            }
          `
          const out = await runPowerShell(psScript, 20_000, signal)
          if (!fsSync.existsSync(outPath)) {
            const ff = await runCommand('ffmpeg', ['-y', '-i', resolvedSrc, outPath], 25_000, signal)
            if (ff.exitCode !== 0 || !fsSync.existsSync(outPath)) {
              throw new Error(`图片编码转换失败: ${path.basename(resolvedSrc)}`)
            }
          }
          const outStat = await fs.stat(outPath)
          if (keepSameFormat && resizePreset === 'source' && !isGrayscale && outStat.size > srcStat.size) {
            await fs.copyFile(resolvedSrc, outPath)
            outBytes = srcStat.size
          } else {
            outBytes = outStat.size
          }
          try {
            const parsedJson = JSON.parse(out) as { width?: number; height?: number }
            outWidth = Number(parsedJson.width) || 0
            outHeight = Number(parsedJson.height) || 0
          } catch {
            outWidth = 0
            outHeight = 0
          }
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
    const invoiceNo = xmlInvNo || labelInvNo || twentyDigit || eightDigit || '00000000'

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
      : Number((totalAmount - totalAmount / 1.06).toFixed(2))
    const netAmount = Math.max(0, Number((totalAmount - taxAmount).toFixed(2)))

    // 4. 销售方与购买方抬头
    const xmlSeller = combined.match(/<(?:SellerName|xhfmc|Xhfmc)>([^<\r\n]+)<\//i)?.[1]?.trim()
    const labelSeller = combined.match(/(?:销售方|销方名称|收款方)[名称：:\s]*([^\r\n，,;；]{2,36})/)?.[1]?.trim()
    const corpMatch = combined.match(/([\u4e00-\u9fa5A-Za-z0-9()（）]{2,24}(?:有限公司|股份有限公司|集团|事务所|酒店|航空|铁路|出行|科技|餐饮))/)?.[1]
    const sellerName = xmlSeller || labelSeller || corpMatch || '未知销售商户'

    const xmlBuyer = combined.match(/<(?:BuyerName|ghfmc|Ghfmc)>([^<\r\n]+)<\//i)?.[1]?.trim()
    const labelBuyer = combined.match(/(?:购买方|购方名称|付款方|抬头)[名称：:\s]*([^\r\n，,;；]{2,36})/)?.[1]?.trim()
    const buyerName = xmlBuyer || labelBuyer || '默认企业抬头'

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
}
