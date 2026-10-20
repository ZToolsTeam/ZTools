import { spawn } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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

  async handleAiImage(
    fn: string,
    params: Record<string, unknown>,
    caller?: CallerIdentity
  ): Promise<unknown> {
    const lowerFn = fn.toLowerCase()
    const rawFiles = Array.isArray(params.files)
      ? params.files.map(String)
      : typeof params.filePath === 'string'
        ? [params.filePath]
        : typeof params.inputPath === 'string'
          ? [params.inputPath]
          : typeof params.path === 'string'
            ? [params.path]
            : []

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
    const rawFiles = Array.isArray(params.files)
      ? params.files.map(String)
      : typeof params.filePath === 'string'
        ? [params.filePath]
        : typeof params.inputPath === 'string'
          ? [params.inputPath]
          : typeof params.path === 'string'
            ? [params.path]
            : []

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
}
