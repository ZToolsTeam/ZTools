import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import path from 'node:path'
import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
export type VisionRequest = { version: 1; operation: 'languages' } | { version: 1; operation: 'recognize'; imageBase64: string; languages: string[] }
export interface VisionBackend { run(request: VisionRequest, signal: AbortSignal): Promise<unknown> }
/** One private stdin/stdout helper per call. Settle only after the owned child actually closes. */
export class MacVisionRunner implements VisionBackend {
  constructor(private readonly executable: string, private readonly dependencies: {
    platform?: NodeJS.Platform; timeoutMs?: number; spawn?: (file: string) => ChildProcessWithoutNullStreams
  } = {}) {
    if (!path.isAbsolute(executable) || (dependencies.timeoutMs !== undefined && (!Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1 || dependencies.timeoutMs > 60000))) throw new ZToolsError(errorCodes.invalidRequest, '本地OCR配置无效')
  }
  async run(request: VisionRequest, signal: AbortSignal): Promise<unknown> {
    if ((this.dependencies.platform ?? process.platform) !== 'darwin') throw new ZToolsError(errorCodes.notSupported, '本地Vision需要macOS')
    if (signal.aborted) throw cancelled()
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try { child = (this.dependencies.spawn ?? (file => spawn(file, [], { shell: false, windowsHide: true, stdio: 'pipe' })))(this.executable) }
      catch { reject(failed()); return }
      const chunks: Buffer[] = []; let size = 0, stderr = 0, failure: ZToolsError | undefined
      const terminate = (error: ZToolsError) => { failure ??= error; if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
      const abort = () => terminate(cancelled())
      const timer = setTimeout(() => terminate(new ZToolsError(errorCodes.requestTimeout, '本地OCR超时')), this.dependencies.timeoutMs ?? 30000)
      signal.addEventListener('abort', abort, { once: true })
      child.stdout.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 4 * 1024 * 1024) terminate(failed()); else chunks.push(bytes) })
      child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.length; if (stderr > 64 * 1024) terminate(failed()) })
      child.on('error', () => { failure ??= failed() })
      child.stdin.on('error', () => terminate(failed()))
      child.once('close', code => {
        clearTimeout(timer); signal.removeEventListener('abort', abort)
        try {
          if (failure) throw failure; if (signal.aborted) throw cancelled()
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
          if (value.version !== 1 || value.success !== true || code !== 0) {
            if (value.code === 'LANGUAGE_UNSUPPORTED') throw new ZToolsError(errorCodes.invalidRequest, '当前Vision版本不支持所选语言')
            throw failed()
          }
          resolve(value)
        } catch (error) { reject(error instanceof ZToolsError ? error : failed()) }
      })
      if (signal.aborted) abort()
      else child.stdin.end(JSON.stringify(request))
    })
  }
}
function failed() { return new ZToolsError(errorCodes.fileError, '本地OCR执行失败') }
function cancelled() { return new ZToolsError(errorCodes.callerDestroyed, '本地OCR已取消') }
