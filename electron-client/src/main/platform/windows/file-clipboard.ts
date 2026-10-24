import path from 'node:path'
import { spawn } from 'node:child_process'
import type { FileClipboardAdapter } from '../../services/clipboard-service.js'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'

const FILE_CLIPBOARD_TIMEOUT_MS = 5_000
const MAX_FILE_CLIPBOARD_OUTPUT_BYTES = 128 * 1024

const FILE_CLIPBOARD_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
function Invoke-ClipboardAction([ScriptBlock] $action) {
  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    try { return & $action }
    catch {
      if ($attempt -eq 4) { throw }
      Start-Sleep -Milliseconds (25 * ($attempt + 1))
    }
  }
}
if ($payload.mode -eq 'write') {
  $items = New-Object System.Collections.Specialized.StringCollection
  foreach ($item in @($payload.paths)) { [void] $items.Add([string] $item) }
  Invoke-ClipboardAction { [System.Windows.Forms.Clipboard]::SetFileDropList($items) }
  [Console]::Out.Write('{"success":true}')
} elseif ($payload.mode -eq 'read') {
  $items = Invoke-ClipboardAction {
    if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
      return @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [string] $_ })
    }
    return @()
  }
  [Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($items)))
} else {
  throw 'invalid mode'
}
`

export function clipboardFailure(error: unknown): ZToolsError {
  if (error instanceof ZToolsError) return error
  return new ZToolsError(errorCodes.clipboardError, '剪贴板操作失败')
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export class WindowsFileClipboardAdapter implements FileClipboardAdapter {
  constructor(private readonly executable = powershellPath()) {}

  async readFiles(signal?: AbortSignal): Promise<string[]> {
    const output = await this.#execute({ mode: 'read' }, signal)
    const value: unknown = JSON.parse(output)
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new ZToolsError(errorCodes.clipboardError, '文件剪贴板返回了无效数据')
    }
    return value
  }

  async writeFiles(paths: string[], signal?: AbortSignal): Promise<void> {
    await this.#execute({ mode: 'write', paths }, signal)
  }

  #execute(payload: { mode: 'read' } | { mode: 'write'; paths: string[] }, signal?: AbortSignal): Promise<string> {
    if (process.platform !== 'win32') {
      throw new ZToolsError(errorCodes.notSupported, '文件剪贴板仅支持 Windows')
    }
    return new Promise((resolve, reject) => {
      const command = Buffer.from(FILE_CLIPBOARD_SCRIPT, 'utf16le').toString('base64')
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
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(clipboardFailure(error))
        else resolve(Buffer.concat(output).toString('utf8'))
      }
      const onAbort = (): void => {
        child.kill()
        finish(new ZToolsError(errorCodes.callerDestroyed, '文件剪贴板操作已取消'))
      }
      const timeout = setTimeout(() => {
        child.kill()
        finish(new ZToolsError(errorCodes.requestTimeout, '文件剪贴板操作超时'))
      }, FILE_CLIPBOARD_TIMEOUT_MS)

      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.byteLength
        if (outputBytes > MAX_FILE_CLIPBOARD_OUTPUT_BYTES) {
          child.kill()
          finish(new ZToolsError(errorCodes.responseTooLarge, '文件剪贴板输出超过上限'))
          return
        }
        output.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        errorBytes += chunk.byteLength
        if (errorBytes <= MAX_FILE_CLIPBOARD_OUTPUT_BYTES) errors.push(chunk)
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
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
      if (!settled) child.stdin.end(JSON.stringify(payload), 'utf8')
    })
  }
}
