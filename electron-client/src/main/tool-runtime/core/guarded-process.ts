import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { TOOL_RUNTIME_ERROR_CODES } from '../../../contracts/tool-runtime/common.js'
import { createToolRuntimeError, isPlainObject, sanitizePublicErrorDetail } from './errors.js'

/**
 * 全 tool-runtime 唯一允许导入 `node:child_process` 的受控子进程执行器。
 * 安全硬性保证：
 * 1. 强制 shell: false + windowsHide: true，严禁命令拼接；
 * 2. Windows 使用 taskkill /F /T /PID 清理整棵进程树；
 * 3. macOS/POSIX 使用进程组 (-pid) 两段式优雅停机（SIGTERM -> graceMs -> SIGKILL）；
 * 4. 持久化活跃进程 PID+startTime 登记文件，支持宿主重启后回收上次异常遗留的孤儿进程。
 */

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_GRACE_MS = 3_000
const DEFAULT_TIMEOUT_MS = 120_000

export interface ActiveProcessRecord {
  readonly pid: number
  readonly startTime: number
  readonly tag?: string
}

export interface GuardedProcessRunOptions {
  readonly exePath: string
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly tag?: string
  readonly onStdoutChunk?: (chunk: string) => void
  readonly onStderrChunk?: (chunk: string) => void
}

export interface GuardedProcessResult {
  readonly exitCode: number | null
  readonly exitSignal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly durationMs: number
}

export interface GuardedProcessRunnerOptions {
  /** 活跃进程持久化文件路径（通常位于 <DataRoot>/CommonLibs/.active-processes.json） */
  readonly activeProcessesFile?: string
  readonly platform?: NodeJS.Platform
  /** POSIX 两段式停机宽限毫秒数 */
  readonly graceMs?: number
  /** 允许测试覆盖终止进程树的实现 */
  readonly terminateProcessTreeImpl?: (pid: number, platform: NodeJS.Platform, graceMs: number) => Promise<void>
  /** 可选覆盖真实 OS 进程启动时间（毫秒时间戳）查询，返回 null 表示无法确认（Fail-Safe 不盲杀） */
  readonly getProcessStartTimeMsImpl?: (pid: number, platform: NodeJS.Platform) => Promise<number | null>
}

const PID_START_TIME_TOLERANCE_MS = 10_000

/**
 * 查询目标 PID 在操作系统中的真实启动时间（毫秒时间戳），防 PID 复用误杀。
 * 无法核实时一律返回 null（Fail-Safe 跳过清理）。
 */
function getProcessStartTimeMsDefault(pid: number, platform: NodeJS.Platform): Promise<number | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null)
  return new Promise((resolve) => {
    let stdout = ''
    let child: ChildProcess
    try {
      if (platform === 'win32') {
        // 使用无 shell 的 PowerShell 单点查询指定整数字 PID 启动时间（UTC 毫秒）
        child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { [DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() }`
          ],
          { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
        )
      } else {
        child = spawn('ps', ['-p', String(pid), '-o', 'lstart='], {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore']
        })
      }
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // 忽略已退出
      }
      resolve(null)
    }, 3_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        resolve(null)
        return
      }
      const trimmed = stdout.trim()
      if (!trimmed) {
        resolve(null)
        return
      }
      if (platform === 'win32') {
        const ms = Number(trimmed)
        resolve(Number.isFinite(ms) && ms > 0 ? ms : null)
        return
      }
      const parsedMs = Date.parse(trimmed)
      resolve(Number.isFinite(parsedMs) && parsedMs > 0 ? parsedMs : null)
    })
  })
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    // EPERM 说明进程存在但无权发信号
    return code === 'EPERM'
  }
}

function runWindowsTaskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/F', '/T', '/PID', String(pid)], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.once('error', () => resolve())
    killer.once('exit', () => resolve())
  })
}

async function terminateProcessTreeDefault(
  pid: number,
  platform: NodeJS.Platform,
  graceMs: number
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return
  if (platform === 'win32') {
    await runWindowsTaskkill(pid)
    return
  }
  // macOS / POSIX：先向独立进程组发送 SIGTERM 优雅停机
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return
    }
  }
  const deadline = Date.now() + Math.max(50, graceMs)
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!isProcessAlive(pid)) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 进程已退出
    }
  }
}

const BINARY_UNAVAILABLE_ERRNO_CODES: ReadonlySet<string> = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOEXEC',
  'EISDIR',
  'ELOOP'
])

function createSpawnFailureError(error: unknown, phaseLabel: string) {
  const errnoCode = (error as NodeJS.ErrnoException | null)?.code
  const rawMessage = error instanceof Error ? error.message : String(error)
  const safeMessage = sanitizePublicErrorDetail(rawMessage) ?? 'unknown error'
  if (typeof errnoCode === 'string' && BINARY_UNAVAILABLE_ERRNO_CODES.has(errnoCode)) {
    return createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.toolBinaryUnavailable,
      `${phaseLabel} (${errnoCode}): ${safeMessage}`,
      {
        stage: 'executing',
        retryable: true,
        userAction: 'reinstall_tool',
        detail: `${errnoCode}: ${safeMessage}`
      }
    )
  }
  return createToolRuntimeError(
    TOOL_RUNTIME_ERROR_CODES.executionFailed,
    `${phaseLabel}: ${safeMessage}`,
    {
      stage: 'executing',
      detail: safeMessage
    }
  )
}

export class GuardedProcessRunner {
  readonly #activeProcessesFile?: string
  readonly #platform: NodeJS.Platform
  readonly #graceMs: number
  readonly #terminateTree: (pid: number, platform: NodeJS.Platform, graceMs: number) => Promise<void>
  readonly #getProcessStartTimeMs: (pid: number, platform: NodeJS.Platform) => Promise<number | null>
  readonly #activeRecords = new Map<number, ActiveProcessRecord>()
  readonly #activeChildren = new Set<ChildProcess>()
  #persistTail: Promise<void> = Promise.resolve()

  constructor(options: GuardedProcessRunnerOptions = {}) {
    if (options.activeProcessesFile) {
      this.#activeProcessesFile = options.activeProcessesFile
    }
    this.#platform = options.platform ?? process.platform
    this.#graceMs = Math.max(50, options.graceMs ?? DEFAULT_GRACE_MS)
    this.#terminateTree = options.terminateProcessTreeImpl ?? terminateProcessTreeDefault
    this.#getProcessStartTimeMs = options.getProcessStartTimeMsImpl ?? getProcessStartTimeMsDefault
  }

  get activeProcessCount(): number {
    return this.#activeRecords.size
  }

  /** 启动期回收上次宿主异常退出可能遗留的孤儿工具进程 */
  async reapOrphanProcesses(): Promise<number> {
    if (!this.#activeProcessesFile) return 0
    let raw: string
    try {
      raw = await fs.readFile(this.#activeProcessesFile, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') return 0
      console.warn('读取活跃进程登记表失败', error)
      return 0
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      await this.#safeUnlinkActiveFile()
      return 0
    }
    if (!Array.isArray(parsed)) {
      await this.#safeUnlinkActiveFile()
      return 0
    }
    let reaped = 0
    for (const item of parsed) {
      if (!isPlainObject(item)) continue
      const pid = item.pid
      const startTime = item.startTime
      if (
        typeof pid !== 'number' ||
        !Number.isSafeInteger(pid) ||
        pid <= 0 ||
        pid === process.pid ||
        typeof startTime !== 'number' ||
        !Number.isFinite(startTime)
      ) {
        continue
      }
      if (this.#activeRecords.has(pid)) continue
      if (isProcessAlive(pid)) {
        // 强制比对 OS 真实进程启动时间，无法核实或偏差过大说明 PID 已被复用，严禁盲杀
        const actualStartTime = await this.#getProcessStartTimeMs(pid, this.#platform)
        if (actualStartTime === null || Math.abs(actualStartTime - startTime) > PID_START_TIME_TOLERANCE_MS) {
          continue
        }
        await this.#terminateTree(pid, this.#platform, this.#graceMs)
        reaped += 1
      }
    }
    await this.#persistActiveRecords()
    return reaped
  }

  /** 执行受控子进程（禁止 shell 拼接，强制进程树回收与超时/取消保护） */
  async run(options: GuardedProcessRunOptions): Promise<GuardedProcessResult> {
    if (!options.exePath || typeof options.exePath !== 'string' || options.exePath.includes('\0')) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        'Executable path is invalid or contains null byte'
      )
    }
    if (!Array.isArray(options.argv) || options.argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.invalidRequest,
        'Process argv must be an array of clean strings without null bytes'
      )
    }
    if (options.signal?.aborted) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.taskCancelled,
        'Process execution was cancelled before launch'
      )
    }

    const startTime = Date.now()
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxOutputBytes = Math.max(1024, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)

    return new Promise<GuardedProcessResult>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(options.exePath, [...options.argv], {
          shell: false,
          windowsHide: true,
          // macOS 下以独立进程组拉起，确保取消时可按 -pid 完整回收整个子进程组
          detached: this.#platform === 'darwin',
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env ? { env: options.env as NodeJS.ProcessEnv } : {})
        })
      } catch (error) {
        reject(createSpawnFailureError(error, 'Failed to spawn process'))
        return
      }

      const pid = child.pid
      this.#activeChildren.add(child)
      if (typeof pid === 'number' && pid > 0) {
        this.#activeRecords.set(pid, {
          pid,
          startTime,
          ...(options.tag ? { tag: options.tag } : {})
        })
        void this.#persistActiveRecords()
      }

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      const stdoutDecoder = new StringDecoder('utf8')
      const stderrDecoder = new StringDecoder('utf8')
      let stdoutBytes = 0
      let stderrBytes = 0
      let settled = false
      let timedOut = false
      let cancelled = false
      let terminating = false

      const triggerTerminate = (): void => {
        if (terminating) return
        terminating = true
        if (typeof pid === 'number' && pid > 0) {
          void this.#terminateTree(pid, this.#platform, this.#graceMs)
        } else {
          try {
            child.kill('SIGKILL')
          } catch {
            // 忽略已退出进程错误
          }
        }
      }

      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true
              triggerTerminate()
            }, timeoutMs)
          : undefined

      const onAbort = (): void => {
        cancelled = true
        triggerTerminate()
      }
      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true })
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const text = stdoutDecoder.write(chunk)
        if (stdoutBytes < maxOutputBytes) {
          const remaining = maxOutputBytes - stdoutBytes
          const slice = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
          stdoutChunks.push(slice)
          stdoutBytes += slice.byteLength
        }
        if (text) {
          try {
            options.onStdoutChunk?.(text)
          } catch (callbackError) {
            console.warn('处理子进程 stdout 回调失败', callbackError)
          }
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = stderrDecoder.write(chunk)
        if (stderrBytes < maxOutputBytes) {
          const remaining = maxOutputBytes - stderrBytes
          const slice = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
          stderrChunks.push(slice)
          stderrBytes += slice.byteLength
        }
        if (text) {
          try {
            options.onStderrChunk?.(text)
          } catch (callbackError) {
            console.warn('处理子进程 stderr 回调失败', callbackError)
          }
        }
      })

      const cleanup = async (): Promise<void> => {
        if (timer) clearTimeout(timer)
        if (options.signal) options.signal.removeEventListener('abort', onAbort)
        this.#activeChildren.delete(child)
        if (typeof pid === 'number' && pid > 0) {
          this.#activeRecords.delete(pid)
          await this.#persistActiveRecords()
        }
      }

      child.once('error', (error) => {
        if (settled) return
        settled = true
        void cleanup().finally(() => {
          reject(createSpawnFailureError(error, 'Process failed to execute'))
        })
      })

      child.once('close', (exitCode, exitSignal) => {
        if (settled) return
        settled = true
        // 冲刷流式 UTF-8 解码器中可能残留的多字节尾部，避免丢失末尾非 ASCII 字符
        const stdoutTail = stdoutDecoder.end()
        if (stdoutTail) {
          try {
            options.onStdoutChunk?.(stdoutTail)
          } catch (callbackError) {
            console.warn('处理子进程 stdout 尾部回调失败', callbackError)
          }
        }
        const stderrTail = stderrDecoder.end()
        if (stderrTail) {
          try {
            options.onStderrChunk?.(stderrTail)
          } catch (callbackError) {
            console.warn('处理子进程 stderr 尾部回调失败', callbackError)
          }
        }
        void cleanup().finally(() => {
          const result: GuardedProcessResult = {
            exitCode,
            exitSignal,
            stdout: Buffer.concat(stdoutChunks).toString('utf8'),
            stderr: Buffer.concat(stderrChunks).toString('utf8'),
            timedOut,
            cancelled,
            durationMs: Date.now() - startTime
          }
          resolve(result)
        })
      })
    })
  }

  /** 停止执行器并清理所有仍在运行的托管子进程 */
  async stop(): Promise<void> {
    const pids = Array.from(this.#activeRecords.keys())
    await Promise.allSettled(pids.map((pid) => this.#terminateTree(pid, this.#platform, this.#graceMs)))
    this.#activeRecords.clear()
    this.#activeChildren.clear()
    await this.#persistActiveRecords()
  }

  #persistActiveRecords(): Promise<void> {
    const file = this.#activeProcessesFile
    if (!file) return Promise.resolve()
    const snapshot = Array.from(this.#activeRecords.values())
    this.#persistTail = this.#persistTail
      .then(async () => {
        if (snapshot.length === 0) {
          await this.#safeUnlinkActiveFile()
          return
        }
        await fs.mkdir(path.dirname(file), { recursive: true })
        const tmpFile = `${file}.tmp.${process.pid}`
        await fs.writeFile(tmpFile, JSON.stringify(snapshot), 'utf8')
        await fs.rename(tmpFile, file)
      })
      .catch((error: unknown) => {
        console.warn('更新活跃工具进程登记文件失败', error)
      })
    return this.#persistTail
  }

  async #safeUnlinkActiveFile(): Promise<void> {
    if (!this.#activeProcessesFile) return
    try {
      await fs.unlink(this.#activeProcessesFile)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code !== 'ENOENT') {
        console.warn('清理活跃工具进程登记文件失败', error)
      }
    }
  }
}
