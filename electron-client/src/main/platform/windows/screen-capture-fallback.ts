import path from 'node:path'
import { spawn } from 'node:child_process'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import type { ScreenCaptureFallback, ScreenRectangle } from '../../services/screen-service.js'

const MAX_CAPTURE_PNG_BYTES = 16 * 1024 * 1024
const FALLBACK_TIMEOUT_MS = 8_000

const SCREEN_CAPTURE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
$rect = [Console]::In.ReadToEnd() | ConvertFrom-Json
$bitmap = New-Object System.Drawing.Bitmap([int] $rect.width, [int] $rect.height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$stream = New-Object System.IO.MemoryStream
try {
  $source = [System.Drawing.Point]::new([int] $rect.x, [int] $rect.y)
  $size = [System.Drawing.Size]::new([int] $rect.width, [int] $rect.height)
  $graphics.CopyFromScreen($source, [System.Drawing.Point]::Empty, $size, [System.Drawing.CopyPixelOperation]::SourceCopy)
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
} finally {
  $stream.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}
`

export function screenFailure(error: unknown): ZToolsError {
  if (error instanceof ZToolsError) return error
  return new ZToolsError(errorCodes.screenError, '屏幕操作失败')
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export class WindowsScreenCaptureFallback implements ScreenCaptureFallback {
  constructor(private readonly executable = powershellPath()) {}

  capture(rect: ScreenRectangle, signal: AbortSignal): Promise<Buffer> {
    if (process.platform !== 'win32') {
      throw new ZToolsError(errorCodes.notSupported, 'GDI 截图兜底仅支持 Windows')
    }
    return new Promise((resolve, reject) => {
      const command = Buffer.from(SCREEN_CAPTURE_SCRIPT, 'utf16le').toString('base64')
      const child = spawn(this.executable, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-EncodedCommand',
        command
      ], {
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let settled = false
      let outputBytes = 0
      let errorBytes = 0
      const output: Buffer[] = []
      const errors: Buffer[] = []
      const finish = (error?: unknown): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        if (error) reject(screenFailure(error))
        else resolve(Buffer.concat(output))
      }
      const onAbort = (): void => {
        child.kill()
        finish(new ZToolsError(errorCodes.callerDestroyed, 'GDI 截图已取消'))
      }
      const timeout = setTimeout(() => {
        child.kill()
        finish(new ZToolsError(errorCodes.requestTimeout, 'GDI 截图超时'))
      }, FALLBACK_TIMEOUT_MS)
      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.byteLength
        if (outputBytes > MAX_CAPTURE_PNG_BYTES) {
          child.kill()
          finish(new ZToolsError(errorCodes.fileTooLarge, 'GDI 截图 PNG 超过 16 MiB 上限'))
          return
        }
        output.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        errorBytes += chunk.byteLength
        if (errorBytes <= 128 * 1024) errors.push(chunk)
      })
      child.once('error', finish)
      child.once('close', (code) => {
        if (code !== 0) {
          const detail = Buffer.concat(errors).toString('utf8').trim().slice(0, 512)
          finish(new Error(detail || `Windows PowerShell 退出码 ${String(code)}`))
          return
        }
        finish()
      })
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      if (!settled) child.stdin.end(JSON.stringify(rect), 'utf8')
    })
  }
}
