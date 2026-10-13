import fs from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import type { FileClipboardAdapter } from '../../services/clipboard-service.js'

const LIMIT = 128 * 1024
type Request = { version: 1; mode: 'read' } | { version: 1; mode: 'write'; paths: string[] }
export type MacClipboardRunner = (executable: string, payload: string, signal?: AbortSignal) => Promise<string>

export function macClipboardExecutable(packaged: boolean, resourcesPath: string): string {
  return packaged
    ? path.join(resourcesPath, 'native', 'ZToolsMacClipboard')
    : path.resolve(__dirname, '../../../mac-clipboard-native/native/ZToolsMacClipboard')
}

function validPaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 1024 && value.every(item =>
    typeof item === 'string' && item.startsWith('/') && !item.startsWith('//') &&
    !item.includes('\0') && Buffer.byteLength(item, 'utf8') <= 4096)
}

export function clipboardBridgeFailure(error: unknown): ZToolsError {
  const info = error as { code?: string; killed?: boolean }
  if (info?.code === 'ABORT_ERR') return new ZToolsError(errorCodes.callerDestroyed, 'Clipboard request cancelled')
  if (info?.code === 'ENOENT' || info?.code === 'EACCES') return new ZToolsError(errorCodes.nativeHostUnavailable, 'Mac clipboard helper unavailable')
  if (info?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return new ZToolsError(errorCodes.responseTooLarge, 'Clipboard response exceeds limit')
  if (info?.killed) return new ZToolsError(errorCodes.requestTimeout, 'Clipboard request timed out')
  return new ZToolsError(errorCodes.clipboardError, 'Mac file clipboard failed')
}

const execute: MacClipboardRunner = (executable, payload, signal) => new Promise((resolve, reject) => {
  // Paths travel over stdin, never argv, shell, or a user-selected executable.
  const child = execFile(executable, [], {
    encoding: 'utf8', shell: false, timeout: 5000, maxBuffer: LIMIT, signal,
    env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }
  }, (error, stdout) => error ? reject(error) : resolve(stdout))
  child.stdin?.on('error', () => {}) // Exit/exec failure is reported by the callback.
  child.stdin?.end(payload, 'utf8')
})

export class MacosFileClipboardAdapter implements FileClipboardAdapter {
  constructor(
    private readonly executable: string,
    private readonly runner: MacClipboardRunner = execute,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  isAvailable(): boolean {
    if (this.platform !== 'darwin') return false
    try {
      if (!fs.lstatSync(this.executable).isFile()) return false
      fs.accessSync(this.executable, fs.constants.X_OK)
      return true
    } catch { return false }
  }

  async readFiles(signal?: AbortSignal): Promise<string[]> {
    const value = await this.#request({ version: 1, mode: 'read' }, signal)
    if (!validPaths(value.paths)) throw new ZToolsError(errorCodes.clipboardError, 'Invalid clipboard paths')
    return value.paths
  }

  async writeFiles(paths: string[], signal?: AbortSignal): Promise<void> {
    if (!validPaths(paths) || paths.length === 0) throw new ZToolsError(errorCodes.invalidRequest, 'Invalid clipboard paths')
    await this.#request({ version: 1, mode: 'write', paths }, signal)
  }

  async #request(request: Request, signal?: AbortSignal): Promise<{ paths?: unknown }> {
    if (this.platform !== 'darwin') throw new ZToolsError(errorCodes.notSupported, 'Mac clipboard requires Darwin')
    if (signal?.aborted) throw new ZToolsError(errorCodes.callerDestroyed, 'Clipboard request cancelled')
    const payload = JSON.stringify(request)
    if (Buffer.byteLength(payload) > LIMIT) throw new ZToolsError(errorCodes.invalidRequest, 'Clipboard request exceeds limit')
    let output: string
    try { output = await this.runner(this.executable, payload, signal) }
    catch (error) { throw clipboardBridgeFailure(error) }
    if (signal?.aborted) throw new ZToolsError(errorCodes.callerDestroyed, 'Clipboard request cancelled')
    if (Buffer.byteLength(output) > LIMIT) throw new ZToolsError(errorCodes.responseTooLarge, 'Clipboard response exceeds limit')
    let value: { version?: unknown; success?: unknown; paths?: unknown }
    try { value = JSON.parse(output) }
    catch { throw new ZToolsError(errorCodes.clipboardError, 'Invalid clipboard response') }
    if (!value || value.version !== 1 || value.success !== true) throw new ZToolsError(errorCodes.clipboardError, 'Mac file clipboard failed')
    return value
  }
}
