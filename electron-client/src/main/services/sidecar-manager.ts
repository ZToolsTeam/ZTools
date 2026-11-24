import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import readline from 'node:readline'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import type { SystemSearchFilesScope } from '../../contracts/method-params.js'
import {
  listMacosApplications,
  scanDirectoryForSearch,
  scanLocalRecentFiles,
  searchFilesOnMacos
} from '../platform/macos/file-indexer.js'
import { getCachedStartMenuApplications } from '../platform/windows/start-menu-apps.js'
import {
  pasteToActiveWindowOnMac,
  setFrontmostWindowBounds,
  type MacosWindowBounds
} from '../platform/macos/window-controller.js'
import { expandSnippetMacros } from './snippets-service.js'
import { getResolvedLocale, ZTOOLS_LOCALE_ENV_KEY } from '../i18n/index.js'

export type SidecarState = 'stopped' | 'starting' | 'running' | 'restarting' | 'degraded'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0'
  id: number | string
  result?: T
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export interface ActiveWindowInfo {
  active: boolean
  hwnd: number
  title: string
  pid: number
  process_name: string
  process_path: string
}

export interface SelectedTextInfo {
  text: string
  source: string
}

/**
 * Windows 索引侧车返回的修改时间是 FILETIME（1601 年起的 100 纳秒数），换成毫秒时间戳；
 * 已经是毫秒（如 macOS / 本地扫描）的原样返回
 */
export function indexerMtimeToMs(value: unknown): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return 0
  if (raw < 1e15) return Math.round(raw)
  return Math.max(0, Math.round(raw / 10_000 - 11_644_473_600_000))
}

/** 全部可启动的程序：macOS 程序目录里的 .app，Windows 开始菜单里的快捷方式 */
async function listLaunchableApplications(): Promise<SearchFilesResult> {
  if (process.platform === 'darwin') return await listMacosApplications()
  const t0 = performance.now()
  const files = process.platform === 'win32' ? (await getCachedStartMenuApplications()).map(app => ({ ...app })) : []
  const elapsedMs = performance.now() - t0
  return {
    query: '',
    limit: files.length,
    files,
    count: files.length,
    total_matches: files.length,
    total_bytes: 0,
    elapsed_us: Math.round(elapsedMs * 1000),
    elapsed_ms: elapsedMs,
    total_indexed: files.length,
    source: process.platform === 'win32' ? 'windows-start-menu' : 'none',
    scope: 'applications'
  }
}

export interface BrowserUrlInfo {
  found: boolean
  url: string
  browser: string
}

export interface FileRecord {
  display_name?: string
  kind?: 'application'
  name: string
  path: string
  is_dir: boolean
  size: number
  mtime: number
  acronym: string
  pinyin: string
}

export interface SubdirStatRecord {
  name: string
  path: string
  fileCount: number
  sizeBytes: number
  file_count?: number | undefined
  total_bytes?: number | undefined
  mtime?: number | undefined
  /** 体积不是完整统计（扫描截断且独立体积统计超时 / 无权限） */
  approximate?: boolean | undefined
}

export interface SearchFilesResult {
  query?: string | undefined
  limit?: number | undefined
  files: FileRecord[]
  count: number
  total_matches: number
  total_bytes?: number | undefined
  subdirs?: SubdirStatRecord[] | undefined
  elapsed_us: number
  elapsed_ms: number
  total_indexed: number
  degraded?: boolean | undefined
  source?: string | undefined
  /** Spotlight 查询超时或被新查询取消，只返回了已读到的部分结果 */
  partial?: boolean | undefined
  /** dir: 扫描达到条目上限停止，files / total_matches 只是已遍历部分 */
  truncated?: boolean | undefined
  /** dir: 扫描体积是近似值（截断后部分子目录体积未能完整统计） */
  approximate?: boolean | undefined
  /** dir: 部分路径读取失败时保留原因，仍返回已读到的结果 */
  scan_error?: string | undefined
  /** 按范围检索时回显实际使用的范围；旧版主进程不返回，界面据此判断能否在本地匹配程序 */
  scope?: SystemSearchFilesScope | undefined
  visited_entries?: number | undefined
  max_entries?: number | undefined
}

export interface IndexPathResult {
  total_indexed: number
  scanner_used: string
  elapsed_ms: number
}

export interface MockDatasetResult {
  total_indexed: number
  elapsed_ms: number
}

export interface IndexerStatsResult {
  total_indexed: number
  index_type: string
}

export interface SidecarBinaryResolveContext {
  isPackaged?: boolean | undefined
  resourcesPath?: string | undefined
  appPath?: string | undefined
  cwd?: string | undefined
  platform?: NodeJS.Platform | undefined
  arch?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  defaultApp?: boolean | undefined
}

export interface SidecarProcessOptions {
  name: string
  binaryName: string
  fallbackBinaryName?: string | undefined
  args?: string[] | undefined
  cwd?: string | undefined
  heartbeatIntervalMs?: number | undefined
  maxRestartsWithinWindow?: number | undefined
  restartWindowMs?: number | undefined
  resolveContext?: SidecarBinaryResolveContext | undefined
}

export interface SidecarStopOutcome {
  name: string
  previousState: SidecarState
  pid: number | null
  exitMethod: 'none' | 'already-exited' | 'rpc-shutdown' | 'sigterm' | 'taskkill'
  forced: boolean
  error?: string
}

export interface SidecarManagerStopReport {
  uiaccess: SidecarStopOutcome
  indexer: SidecarStopOutcome
}

function isControlledRegularFile(filePath: string): boolean {
  try {
    const stats = fs.lstatSync(filePath)
    if (!stats.isFile() || stats.isSymbolicLink()) return false
    const canonical = path.resolve(fs.realpathSync(filePath))
    const requested = path.resolve(filePath)
    return process.platform === 'win32'
      ? canonical.toLowerCase() === requested.toLowerCase()
      : canonical === requested
  } catch {
    return false
  }
}

/**
 * 解析侧车可执行文件路径：
 * - 打包态优先并仅从受控 resources/native/ 目录定位，避免命中 app.asar 虚拟路径或外部 cwd 劫持
 * - 开发态与单测态按构建输出目录及工作目录回退查找
 */
export function resolveSidecarBinaryPath(
  name: string,
  context: SidecarBinaryResolveContext = {}
): string | null {
  const env = context.env ?? process.env
  const envKey = `ZTOOLS_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PATH`
  const envOverride = env[envKey]
  if (envOverride && fs.existsSync(envOverride)) {
    return envOverride
  }

  const platform = context.platform ?? process.platform
  const arch = context.arch ?? process.arch
  const isWin = platform === 'win32'
  const binName = isWin ? `${name}.exe` : name
  const resourcesPath = context.resourcesPath ?? process.resourcesPath
  const defaultApp = context.defaultApp ?? Boolean(process.defaultApp)
  const isPackaged =
    context.isPackaged ??
    (typeof resourcesPath === 'string' && resourcesPath.length > 0 && !defaultApp)

  const platformDirs = isWin
    ? ['win32-x64']
    : [`darwin-${arch}`, 'darwin-universal', 'darwin']

  if (isPackaged) {
    if (typeof resourcesPath !== 'string' || resourcesPath.length === 0) {
      return null
    }
    const packagedCandidates = [
      path.join(resourcesPath, 'native', binName),
      ...platformDirs.map((dir) => path.join(resourcesPath, 'native', dir, 'bin', binName))
    ]
    for (const candidate of packagedCandidates) {
      if (isControlledRegularFile(candidate)) {
        return candidate
      }
    }
    return null
  }

  const appRoot = context.appPath ?? path.resolve(__dirname, '..', '..', '..')
  const cwd = context.cwd ?? process.cwd()
  const devCandidates: string[] = []
  for (const dir of platformDirs) {
    devCandidates.push(
      path.join(appRoot, 'out', 'native', dir, 'bin', binName),
      path.join(appRoot, 'resources', 'native', dir, 'bin', binName),
      path.join(cwd, 'out', 'native', dir, 'bin', binName),
      path.join(cwd, 'electron-client', 'out', 'native', dir, 'bin', binName)
    )
  }
  if (!isWin) {
    devCandidates.push(
      path.join(appRoot, 'out', 'native', 'win32-x64', 'bin', `${name}.exe`),
      path.join(appRoot, 'resources', 'native', 'win32-x64', 'bin', `${name}.exe`),
      path.join(cwd, 'out', 'native', 'win32-x64', 'bin', `${name}.exe`),
      path.join(cwd, 'electron-client', 'out', 'native', 'win32-x64', 'bin', `${name}.exe`)
    )
  }

  for (const candidate of devCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function normalizePathPrefix(targetPath: string): string {
  const resolved = path.win32.resolve(targetPath).toLowerCase()
  return resolved.endsWith('\\') ? resolved : `${resolved}\\`
}

/**
 * Windows 强制要求带 uiAccess="true" 清单的可执行文件必须位于系统受信任位置且签名有效。
 * 非受信任目录（例如便携版、非 Program Files 自定义路径）直接尝试 spawn 必然触发 EACCES。
 */
export function isTrustedWindowsUiAccessLocation(
  executablePath: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const normalizedTarget = path.win32.resolve(executablePath).toLowerCase()
  const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows'
  const trustedRoots = [
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
    env.ProgramW6432,
    path.win32.join(systemRoot, 'System32')
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0)

  return trustedRoots.some((root) => normalizedTarget.startsWith(normalizePathPrefix(root)))
}

function hasCustomSidecarPathOverride(
  binaryName: string,
  context: SidecarBinaryResolveContext = {}
): boolean {
  const env = context.env ?? process.env
  const envKey = `ZTOOLS_${binaryName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PATH`
  return Boolean(env[envKey])
}

function isPackagedContext(context: SidecarBinaryResolveContext = {}): boolean {
  const resourcesPath = context.resourcesPath ?? process.resourcesPath
  const defaultApp = context.defaultApp ?? Boolean(process.defaultApp)
  return (
    context.isPackaged ??
    (typeof resourcesPath === 'string' && resourcesPath.length > 0 && !defaultApp)
  )
}

function formatSidecarError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function hasProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasProcessExited(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const onExit = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.removeListener('exit', onExit)
      resolve(hasProcessExited(child))
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

function forceKillProcessTree(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  if (process.platform === 'win32') {
    const res = spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 3000
    })
    return res.status === 0
  }
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

export class ManagedSidecarProcess {
  public state: SidecarState = 'stopped'
  public child: ChildProcess | null = null
  public pid: number | null = null
  public lastError: string | null = null
  public activeBinary: string | null = null
  public usingFallback = false
  public fallbackReason: string | null = null
  public restartCount = 0

  private nextRequestId = 1
  private pendingRequests = new Map<number | string, {
    resolve: (res: unknown) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
  }>()

  private heartbeatTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private handshakeTimer: NodeJS.Timeout | null = null
  private restartTimestamps: number[] = []
  private intentionallyStopped = false
  private rl: readline.Interface | null = null
  private abortPendingSpawn: ((err: Error) => void) | null = null
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<SidecarStopOutcome> | null = null

  constructor(public readonly options: SidecarProcessOptions) {}

  public async start(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise.catch(() => undefined)
    }
    if (this.startPromise) {
      return this.startPromise
    }
    if (this.state === 'running' || this.state === 'starting') return

    this.startPromise = this.performStart().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async performStart(): Promise<void> {
    this.intentionallyStopped = false
    this.state = 'starting'
    this.lastError = null
    this.activeBinary = null
    this.usingFallback = false
    this.fallbackReason = null

    const resolveContext = this.options.resolveContext
    const platform = resolveContext?.platform ?? process.platform
    const env = resolveContext?.env ?? process.env
    const binaryPath = this.resolveBinaryPath(this.options.binaryName)
    const fallbackPath = this.options.fallbackBinaryName
      ? this.resolveBinaryPath(this.options.fallbackBinaryName)
      : null

    let primaryFailureReason: string | null = null

    // Windows 打包态若未安装在受信任系统目录，直接跳过必然触发 EACCES 的 uiAccess 试探并优雅降级
    const shouldSkipUntrustedUiAccess =
      platform === 'win32' &&
      this.options.binaryName === 'ztools-uiaccess' &&
      Boolean(this.options.fallbackBinaryName) &&
      Boolean(fallbackPath) &&
      Boolean(binaryPath) &&
      !hasCustomSidecarPathOverride(this.options.binaryName, resolveContext) &&
      isPackagedContext(resolveContext) &&
      !isTrustedWindowsUiAccessLocation(binaryPath!, env)

    if (shouldSkipUntrustedUiAccess) {
      primaryFailureReason = `untrusted-install-location: ${binaryPath}`
    } else if (binaryPath) {
      try {
        await this.spawnProcess(binaryPath, this.options.binaryName)
        return
      } catch (err) {
        primaryFailureReason = formatSidecarError(err)
      }
    } else {
      primaryFailureReason = `Binary not found: ${this.options.binaryName}`
    }

    if (this.intentionallyStopped) {
      this.state = 'stopped'
      return
    }

    // 主二进制缺失、不可信任或启动失败时尝试回退二进制，回退成功后清除陈旧 lastError 并保留降级原因
    if (this.options.fallbackBinaryName && fallbackPath && fallbackPath !== binaryPath) {
      try {
        await this.spawnProcess(fallbackPath, this.options.fallbackBinaryName)
        this.usingFallback = true
        this.fallbackReason = primaryFailureReason
        this.lastError = null
        return
      } catch (fallbackErr) {
        this.state = 'degraded'
        this.activeBinary = null
        this.usingFallback = false
        this.fallbackReason = primaryFailureReason
        this.lastError = formatSidecarError(fallbackErr)
        return
      }
    }

    this.state = 'degraded'
    this.activeBinary = null
    this.lastError = primaryFailureReason
  }

  private resolveBinaryPath(name: string): string | null {
    return resolveSidecarBinaryPath(name, this.options.resolveContext)
  }

  private cleanupSpawnResources(child: ChildProcess): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    if (this.child !== child) return
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
    if (!child.killed && !hasProcessExited(child)) {
      child.kill('SIGTERM')
    }
    this.child = null
    this.pid = null
    this.activeBinary = null
  }

  private spawnProcess(executablePath: string, binaryLabel: string): Promise<void> {
    if (this.intentionallyStopped) {
      return Promise.reject(new Error('Sidecar stopped during startup'))
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const settleError = (err: unknown): void => {
        if (settled) return
        settled = true
        this.abortPendingSpawn = null
        reject(err)
      }
      const settleSuccess = (): void => {
        if (settled) return
        settled = true
        this.abortPendingSpawn = null
        resolve()
      }
      this.abortPendingSpawn = (abortErr: Error): void => {
        if (this.handshakeTimer) {
          clearTimeout(this.handshakeTimer)
          this.handshakeTimer = null
        }
        settleError(abortErr)
      }

      try {
        const sessionToken = crypto.randomBytes(24).toString('hex')
        const child = spawn(executablePath, this.options.args || [], {
          cwd: this.options.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            ZTOOLS_SIDECAR_TOKEN: sessionToken,
            [ZTOOLS_LOCALE_ENV_KEY]: getResolvedLocale()
          }
        })

        this.child = child
        this.pid = child.pid ?? null

        child.on('error', (err) => {
          if (this.child !== child) return
          this.lastError = err.message
          if (!settled) {
            this.cleanupSpawnResources(child)
            settleError(err)
          } else {
            this.handleUnexpectedExit()
          }
        })

        child.on('exit', (code, signal) => {
          if (this.child !== child) return
          if (!settled) {
            // 启动与握手尚未完成前的退出交回 performStart() 做回退或 degraded 收敛，不调度后台重连定时器
            this.cleanupSpawnResources(child)
            settleError(new Error(`Sidecar exited prematurely with code ${code}, signal ${signal}`))
            return
          }
          this.handleExit(code, signal)
        })

        if (!child.stdout || !child.stdin) {
          throw new Error('Failed to attach stdio pipes')
        }

        // 避免侧车瞬时退出后 stdin 写入触发未捕获 EPIPE / 流销毁异常
        child.stdin.on('error', (err) => {
          if (this.child === child && !this.intentionallyStopped) {
            this.lastError = err.message
          }
        })

        this.rl = readline.createInterface({ input: child.stdout })
        this.rl.on('line', (line) => {
          this.handleRpcLine(line)
        })

        // Verify with initial handshake & ping
        if (this.handshakeTimer) {
          clearTimeout(this.handshakeTimer)
          this.handshakeTimer = null
        }
        this.handshakeTimer = setTimeout(async () => {
          this.handshakeTimer = null
          if (this.child !== child || this.intentionallyStopped) {
            settleError(new Error('Sidecar spawn aborted before handshake'))
            return
          }
          try {
            await this.sendRequest('handshake', { token: sessionToken }, 3000)
            await this.sendRequest('ping', {}, 3000)
            if (this.child !== child || this.intentionallyStopped) {
              throw new Error('Sidecar stopped during handshake')
            }
            this.state = 'running'
            this.activeBinary = binaryLabel
            this.lastError = null
            this.startHeartbeat()
            settleSuccess()
          } catch (handshakeErr) {
            this.cleanupSpawnResources(child)
            settleError(handshakeErr)
          }
        }, 100)
      } catch (err) {
        if (this.child) {
          this.cleanupSpawnResources(this.child)
        }
        settleError(err)
      }
    })
  }

  public async stop(): Promise<SidecarStopOutcome> {
    if (this.stopPromise) {
      return this.stopPromise
    }
    this.stopPromise = this.performStop().finally(() => {
      this.stopPromise = null
    })
    return this.stopPromise
  }

  private async performStop(): Promise<SidecarStopOutcome> {
    const previousState = this.state
    const child = this.child
    const pid = child?.pid ?? this.pid
    const hadPendingHandshake = Boolean(this.handshakeTimer) || previousState === 'starting'
    const pendingSpawnAbort = this.abortPendingSpawn
    this.abortPendingSpawn = null

    this.intentionallyStopped = true
    this.stopHeartbeat()
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.clearPendingRequests(new Error('Sidecar stopped'))

    let exitMethod: SidecarStopOutcome['exitMethod'] = 'none'
    let forced = false
    let stopError: string | undefined

    if (child) {
      if (hasProcessExited(child)) {
        exitMethod = 'already-exited'
      } else {
        // 尚未完成初始握手时不发 shutdown RPC 避免白等 1s 超时，直接走宽限终止
        let exitedGracefully = false
        if (!hadPendingHandshake) {
          try {
            await this.sendRequest('shutdown', {}, 1000).catch(() => undefined)
          } catch {
            // 忽略停机 RPC 错误，继续走宽限等待与强杀兜底
          }
          exitedGracefully = await waitForChildExit(child, 400)
        }
        if (exitedGracefully) {
          exitMethod = 'rpc-shutdown'
        } else {
          if (this.child === child && !child.killed && !hasProcessExited(child)) {
            try {
              child.kill('SIGTERM')
            } catch (err) {
              stopError = formatSidecarError(err)
            }
          }
          const exitedOnSigterm = await waitForChildExit(child, hadPendingHandshake ? 250 : 500)
          if (exitedOnSigterm) {
            exitMethod = 'sigterm'
          } else {
            forced = true
            exitMethod = 'taskkill'
            const killed = pid ? forceKillProcessTree(pid) : false
            if (!killed && !hasProcessExited(child)) {
              stopError = stopError || 'Failed to force-terminate sidecar process tree'
            }
          }
        }
      }
      if (this.child === child) {
        this.child = null
      }
    }

    if (this.rl) {
      this.rl.close()
      this.rl = null
    }

    this.state = 'stopped'
    this.pid = null
    this.activeBinary = null
    pendingSpawnAbort?.(new Error('Sidecar stopped during startup'))
    return {
      name: this.options.name,
      previousState,
      pid,
      exitMethod,
      forced,
      ...(stopError ? { error: stopError } : {})
    }
  }

  public async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  public sendRequest<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
    if (this.state !== 'running' && this.state !== 'starting') {
      return Promise.reject(new Error(`Cannot send request, sidecar is in ${this.state} state`))
    }

    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      return Promise.reject(new Error('Sidecar stdin is not writable'))
    }

    const id = this.nextRequestId++
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`JSON-RPC request '${method}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pendingRequests.set(id, { resolve: resolve as (res: unknown) => void, reject, timer })

      try {
        const payload = JSON.stringify(req) + '\n'
        this.child!.stdin!.write(payload)
      } catch (writeErr) {
        clearTimeout(timer)
        this.pendingRequests.delete(id)
        reject(writeErr as Error)
      }
    })
  }

  private handleRpcLine(line: string) {
    if (!line || !line.trim()) return
    try {
      const msg: JsonRpcResponse = JSON.parse(line)
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const req = this.pendingRequests.get(msg.id)!
        this.pendingRequests.delete(msg.id)
        clearTimeout(req.timer)

        if (msg.error) {
          req.reject(new Error(`RPC Error [${msg.error.code}]: ${msg.error.message}`))
        } else {
          req.resolve(msg.result)
        }
      }
    } catch {
      // Ignore unparseable non-JSON-RPC lines
    }
  }

  private handleExit(_code: number | null, _signal: NodeJS.Signals | null) {
    this.stopHeartbeat()
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
    this.pid = null
    this.child = null
    this.activeBinary = null

    if (this.intentionallyStopped) {
      this.state = 'stopped'
      return
    }

    this.handleUnexpectedExit()
  }

  private handleUnexpectedExit() {
    this.stopHeartbeat()
    this.clearPendingRequests(new Error('Sidecar process exited unexpectedly'))
    if (this.rl) {
      this.rl.close()
      this.rl = null
    }
    if (this.child) {
      const oldChild = this.child
      const oldPid = oldChild.pid ?? this.pid
      this.child = null
      this.pid = null
      this.activeBinary = null
      if (!oldChild.killed && !hasProcessExited(oldChild)) {
        try {
          oldChild.kill('SIGTERM')
        } catch {
          // 忽略 SIGTERM 发送异常，交由进程树强杀兜底
        }
        // SIGTERM 若未能在短窗内结束子进程，则强杀整棵进程树防止孤儿残留
        if (oldPid) {
          void waitForChildExit(oldChild, 300).then((exited) => {
            if (!exited && !hasProcessExited(oldChild)) {
              forceKillProcessTree(oldPid)
            }
          })
        }
      }
    }

    if (this.intentionallyStopped || this.state === 'restarting' || this.state === 'degraded' || this.state === 'stopped') {
      return
    }

    const now = Date.now()
    const windowMs = this.options.restartWindowMs || 60000
    const maxRestarts = this.options.maxRestartsWithinWindow || 5

    this.restartTimestamps = this.restartTimestamps.filter(t => now - t < windowMs)
    this.restartTimestamps.push(now)
    this.restartCount++

    if (this.restartTimestamps.length > maxRestarts) {
      console.warn(`[Sidecar:${this.options.name}] Max restarts exceeded (${maxRestarts} within ${windowMs}ms). Degrading.`)
      this.state = 'degraded'
      return
    }

    const backoffMs = Math.min(500 * Math.pow(2, this.restartTimestamps.length - 1), 5000)
    console.info(`[Sidecar:${this.options.name}] Process crashed. Restarting in ${backoffMs}ms (attempt ${this.restartTimestamps.length}/${maxRestarts})...`)
    this.state = 'restarting'

    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
    }
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.intentionallyStopped) {
        this.start().catch(err => {
          console.error(`[Sidecar:${this.options.name}] Failed to auto-restart:`, err)
        })
      }
    }, backoffMs)
  }

  private startHeartbeat() {
    this.stopHeartbeat()
    const interval = this.options.heartbeatIntervalMs || 15000
    this.heartbeatTimer = setInterval(async () => {
      if (this.state === 'running') {
        try {
          await this.sendRequest('ping', {}, 3000)
        } catch (err) {
          console.warn(`[Sidecar:${this.options.name}] Heartbeat failed:`, err)
          this.handleUnexpectedExit()
        }
      }
    }, interval)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearPendingRequests(err: Error) {
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer)
      req.reject(err)
    }
    this.pendingRequests.clear()
  }
}

export interface SidecarManagerOptions {
  resolveContext?: SidecarBinaryResolveContext | undefined
}

export class SidecarManager {
  private uiaccessProcess: ManagedSidecarProcess
  private indexerProcess: ManagedSidecarProcess

  // In-memory fallback dataset for degraded indexer mode
  private fallbackFiles: FileRecord[] = []
  private pastedHistory: string[] = []

  constructor(options: SidecarManagerOptions = {}) {
    this.uiaccessProcess = new ManagedSidecarProcess({
      name: 'ztools-uiaccess',
      binaryName: 'ztools-uiaccess',
      fallbackBinaryName: 'ztools-uiaccess-standard',
      heartbeatIntervalMs: 15000,
      resolveContext: options.resolveContext
    })

    this.indexerProcess = new ManagedSidecarProcess({
      name: 'ztools-indexer',
      binaryName: 'ztools-indexer',
      heartbeatIntervalMs: 15000,
      resolveContext: options.resolveContext
    })
  }

  public getPastedHistory(): readonly string[] {
    return [...this.pastedHistory]
  }

  public setFallbackFiles(files: readonly FileRecord[]): void {
    this.fallbackFiles = [...files]
  }

  public async startAll(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return
    await Promise.allSettled([
      this.uiaccessProcess.start(),
      this.indexerProcess.start()
    ])
    if (signal?.aborted) {
      await this.stop()
    }
  }

  public async stop(): Promise<SidecarManagerStopReport> {
    const [uiaccess, indexer] = await Promise.all([
      this.uiaccessProcess.stop(),
      this.indexerProcess.stop()
    ])
    return { uiaccess, indexer }
  }

  public getStatus() {
    return {
      uiaccess: {
        state: this.uiaccessProcess.state,
        pid: this.uiaccessProcess.pid,
        activeBinary: this.uiaccessProcess.activeBinary,
        usingFallback: this.uiaccessProcess.usingFallback,
        fallbackReason: this.uiaccessProcess.fallbackReason,
        restarts: this.uiaccessProcess.restartCount,
        lastError: this.uiaccessProcess.lastError
      },
      indexer: {
        state: this.indexerProcess.state,
        pid: this.indexerProcess.pid,
        activeBinary: this.indexerProcess.activeBinary,
        usingFallback: this.indexerProcess.usingFallback,
        fallbackReason: this.indexerProcess.fallbackReason,
        restarts: this.indexerProcess.restartCount,
        lastError: this.indexerProcess.lastError
      }
    }
  }

  // --- UIAccess Methods with Graceful Degradation ---

  public async getActiveWindow(): Promise<ActiveWindowInfo> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest<ActiveWindowInfo>('get_active_window', {})
      } catch (err) {
        console.warn('[SidecarManager] getActiveWindow RPC failed, falling back:', err)
      }
    }
    // Degraded fallback
    return {
      active: false,
      hwnd: 0,
      title: '',
      pid: 0,
      process_name: '',
      process_path: ''
    }
  }

  public async getSelectedText(): Promise<SelectedTextInfo> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest<SelectedTextInfo>('get_selected_text', {})
      } catch (err) {
        console.warn('[SidecarManager] getSelectedText RPC failed, falling back:', err)
      }
    }
    // Degraded fallback
    return {
      text: '',
      source: 'degraded_fallback'
    }
  }

  public async getBrowserUrl(): Promise<BrowserUrlInfo> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest<BrowserUrlInfo>('get_browser_url', {})
      } catch (err) {
        console.warn('[SidecarManager] getBrowserUrl RPC failed, falling back:', err)
      }
    }
    // Degraded fallback
    return {
      found: false,
      url: '',
      browser: 'none'
    }
  }

  public async setMockState(state: Record<string, unknown>): Promise<boolean> {
    if (this.uiaccessProcess.state === 'running') {
      return await this.uiaccessProcess.sendRequest<boolean>('set_mock_state', state)
    }
    return false
  }

  public async manageWindow(
    action: string,
    bounds?: MacosWindowBounds,
    target?: { hwnd: number; pid: number }
  ): Promise<{ success: boolean; action: string; rect?: MacosWindowBounds; error?: string; errorCode?: string }> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest('manage_window', {
          action,
          host_pid: process.pid,
          ...(target ? { target_hwnd: target.hwnd, target_pid: target.pid } : {}),
          ...(bounds ? { bounds } : {})
        })
      } catch (err: unknown) {
        console.warn('[SidecarManager] manage_window RPC failed:', err)
        return { success: false, action, error: err instanceof Error ? err.message : String(err) }
      }
    }

    if (process.platform === 'darwin') {
      const targetBounds = bounds ?? { x: 100, y: 80, width: 1200, height: 800 }
      const macRes = await setFrontmostWindowBounds(targetBounds, action)
      return {
        success: macRes.success,
        action,
        ...(macRes.rect ? { rect: macRes.rect } : bounds ? { rect: bounds } : {}),
        ...(macRes.error ? { error: macRes.error } : {}),
        ...(macRes.errorCode ? { errorCode: macRes.errorCode } : {})
      }
    }

    return {
      success: false,
      action,
      ...(bounds ? { rect: bounds } : {}),
      error: 'UIAccess sidecar is not running'
    }
  }

  public async setSnippets(snippets: unknown[]): Promise<unknown> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest('set_snippets', { snippets })
      } catch (err: unknown) {
        console.warn('[SidecarManager] set_snippets RPC failed:', err)
      }
    }
    return { success: false, count: Array.isArray(snippets) ? snippets.length : 0 }
  }

  public async pasteToActive(targetHwnd = 0): Promise<{ success: boolean }> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest<{ success: boolean }>('paste_to_active', { target_hwnd: targetHwnd })
      } catch (err: unknown) {
        console.warn('[SidecarManager] paste_to_active RPC failed:', err)
      }
    }
    if (process.platform === 'darwin') {
      const lastText = this.pastedHistory[this.pastedHistory.length - 1] ?? ''
      const res = await pasteToActiveWindowOnMac(lastText, 0)
      return { success: res.success }
    }
    return { success: false }
  }

  public async pasteToActiveWindow(
    text: string,
    targetHwnd = 0
  ): Promise<{ success: boolean; pasted: string; error?: string; errorCode?: string }> {
    const safeText = String(text ?? '')
    this.pastedHistory.push(safeText)
    if (this.pastedHistory.length > 200) {
      this.pastedHistory.shift()
    }

    if (this.uiaccessProcess.state === 'running') {
      try {
        const rpcRes = await this.uiaccessProcess.sendRequest<{ success: boolean }>('paste_to_active', {
          text: safeText,
          target_hwnd: targetHwnd
        })
        return { success: Boolean(rpcRes?.success), pasted: safeText }
      } catch (err: unknown) {
        console.warn('[SidecarManager] pasteToActiveWindow RPC failed:', err)
      }
    }

    if (process.platform === 'darwin') {
      const macRes = await pasteToActiveWindowOnMac(safeText, 0)
      return {
        success: macRes.success,
        pasted: safeText,
        ...(macRes.error ? { error: macRes.error } : {}),
        ...(macRes.errorCode ? { errorCode: macRes.errorCode } : {})
      }
    }

    return {
      success: false,
      pasted: safeText,
      error: 'UIAccess sidecar is not running'
    }
  }

  public async expandSnippet(
    keyword: string,
    content: string,
    clipboard = ''
  ): Promise<{
    success: boolean
    expanded: string
    backspaces: number
    cursorOffset: number
    error?: string
    errorCode?: string
  }> {
    const { expanded, cursorOffset } = expandSnippetMacros(String(content ?? ''), {
      clipboard,
      now: new Date()
    })
    const backspaces = String(keyword ?? '').length

    this.pastedHistory.push(expanded)
    if (this.pastedHistory.length > 200) {
      this.pastedHistory.shift()
    }

    if (this.uiaccessProcess.state === 'running') {
      try {
        await this.uiaccessProcess.sendRequest('expand_snippet', {
          keyword,
          content: expanded,
          backspaces,
          cursor_offset: cursorOffset
        })
        return { success: true, expanded, backspaces, cursorOffset }
      } catch (err: unknown) {
        console.warn('[SidecarManager] expandSnippet RPC failed:', err)
      }
    }

    if (process.platform === 'darwin') {
      const macRes = await pasteToActiveWindowOnMac(expanded, cursorOffset)
      return {
        success: macRes.success,
        expanded,
        backspaces,
        cursorOffset,
        ...(macRes.error ? { error: macRes.error } : {}),
        ...(macRes.errorCode ? { errorCode: macRes.errorCode } : {})
      }
    }

    return {
      success: false,
      expanded,
      backspaces,
      cursorOffset,
      error: 'UIAccess sidecar is not running'
    }
  }

  public async trimProcessMemory(pid = 0): Promise<{ success: boolean; pid: number; trimmed: boolean }> {
    if (this.uiaccessProcess.state === 'running') {
      try {
        return await this.uiaccessProcess.sendRequest<{ success: boolean; pid: number; trimmed: boolean }>('trim_process_memory', { pid })
      } catch (err: unknown) {
        console.warn('[SidecarManager] trim_process_memory RPC failed:', err)
      }
    }
    return { success: false, pid, trimmed: false }
  }

  // --- Indexer Methods with Graceful Degradation ---

  public registerFallbackFile(file: FileRecord): void {
    this.fallbackFiles.push(file)
  }

  public async searchFiles(
    query: string,
    limit = 50,
    options: { scope?: SystemSearchFilesScope } = {}
  ): Promise<SearchFilesResult> {
    const trimmed = String(query || '').trim()
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50))
    const scope = options.scope ?? 'all'
    if (scope === 'applications') {
      return await listLaunchableApplications()
    }
    if (trimmed.toLowerCase().startsWith('dir:')) {
      const targetDir = trimmed.slice(4).trim()
      if (targetDir) {
        return await scanDirectoryForSearch(targetDir, safeLimit, this.fallbackFiles)
      }
    }

    // 1. 若外部单测注入了 fallbackFiles，优先匹配 fallbackFiles
    if (this.fallbackFiles.length > 0) {
      const t0 = performance.now()
      const qLower = trimmed.toLowerCase()
      const matches: FileRecord[] = []

      for (const f of this.fallbackFiles) {
        if (
          !qLower ||
          f.name.toLowerCase().includes(qLower) ||
          f.acronym.toLowerCase().includes(qLower) ||
          f.path.toLowerCase().includes(qLower)
        ) {
          matches.push(f)
          if (matches.length >= safeLimit) break
        }
      }
      const elapsedMs = performance.now() - t0
      const totalBytes = matches.reduce((acc, f) => acc + (f.size || 0), 0)

      return {
        query: trimmed,
        limit: safeLimit,
        files: matches,
        count: matches.length,
        total_matches: matches.length,
        total_bytes: totalBytes,
        elapsed_us: Math.round(elapsedMs * 1000),
        elapsed_ms: elapsedMs,
        total_indexed: this.fallbackFiles.length,
        degraded: true,
        source: 'macos-fs'
      }
    }

    // 2. macOS 优先走原生应用缓存（含 InfoPlist.strings / mdls 本地化中文名称与双语拼音）+ 本地目录 / Spotlight 检索
    if (process.platform === 'darwin') {
      return await searchFilesOnMacos(trimmed, safeLimit, this.fallbackFiles, {
        excludeApplications: scope === 'files'
      })
    }

    // 3. 若 Windows Indexer 侧车运行中且有非空关键词，优先调用硬件级索引
    if (trimmed && this.indexerProcess.state === 'running') {
      try {
        const rpcRes = await this.indexerProcess.sendRequest<SearchFilesResult>('search_files', {
          query: trimmed,
          limit: safeLimit
        })
        if (rpcRes && Array.isArray(rpcRes.files) && (rpcRes.files.length > 0 || (rpcRes.total_indexed ?? 0) > 0)) {
          return {
            ...rpcRes,
            files: rpcRes.files.map(file => ({ ...file, mtime: indexerMtimeToMs(file.mtime) })),
            ...(scope === 'files' ? { scope } : {})
          }
        }
      } catch (err) {
        console.warn('[SidecarManager] searchFiles RPC failed, falling back:', err)
      }
    }

    // 4. 空查询或 Windows 侧车未返回结果时，扫描本机真实用户目录（Downloads/Desktop/Documents/cwd）
    const t0 = performance.now()
    const local = await scanLocalRecentFiles(trimmed, safeLimit)
    const elapsedMs = performance.now() - t0

    return {
      query: trimmed,
      limit: safeLimit,
      files: local.files,
      count: local.files.length,
      total_matches: local.files.length,
      total_bytes: local.totalBytes,
      subdirs: local.subdirs,
      elapsed_us: Math.round(elapsedMs * 1000),
      elapsed_ms: elapsedMs,
      total_indexed: local.files.length,
      degraded: this.indexerProcess.state !== 'running',
      source: 'local-fs',
      ...(scope === 'files' ? { scope } : {})
    }
  }

  public async indexPath(targetPath: string, scanner: 'auto' | 'usn' | 'directory' = 'auto'): Promise<IndexPathResult> {
    if (this.indexerProcess.state === 'running') {
      try {
        return await this.indexerProcess.sendRequest<IndexPathResult>('index_path', { path: targetPath, scanner }, 60000)
      } catch (err) {
        console.warn('[SidecarManager] indexPath RPC failed, falling back:', err)
      }
    }

    return {
      total_indexed: this.fallbackFiles.length,
      scanner_used: 'degraded_unindexed',
      elapsed_ms: 0
    }
  }

  public async generateMockDataset(count = 1000000): Promise<MockDatasetResult> {
    if (this.indexerProcess.state === 'running') {
      return await this.indexerProcess.sendRequest<MockDatasetResult>('generate_mock_dataset', { count }, 30000)
    }
    return {
      total_indexed: 0,
      elapsed_ms: 0
    }
  }

  public async getStats(): Promise<IndexerStatsResult> {
    if (this.indexerProcess.state === 'running') {
      return await this.indexerProcess.sendRequest<IndexerStatsResult>('get_stats', {})
    }
    return {
      total_indexed: this.fallbackFiles.length,
      index_type: 'degraded_in_memory'
    }
  }
}
