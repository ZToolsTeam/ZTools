import { createPlatformPortDiscoveryAdapter, type PortDiscoveryAdapter, type PortSnapshot } from '../platform/port-discovery.js'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type {
  ProcessExistsParams,
  ProcessFindParams,
  ProcessKillByNameParams,
  ProcessKillParams,
  ProcessPidParams,
  ProcessStartParams,
  ProcessWaitParams
} from '../../contracts/method-params.js'
import type { WindowRegistry } from '../windows/window-registry.js'
import type { FileSystemService } from './file-system-service.js'

export interface ProcessSummary {
  pid: number
  name: string
  path: string
  cpuUsage: number
  memoryUsage: number
  fieldAvailability: {
    path: boolean
    cpuUsage: boolean
    memoryUsage: boolean
  }
}

export interface ProcessDiscoveryAdapter {
  list(signal: AbortSignal): Promise<ProcessSummary[]>
}

interface ManagedProcess {
  child: ChildProcess
  pid: number
  name: string
  ownerWebContentsId: number
  exited: boolean
  exitCode: number | undefined
  exitedAt: number | undefined
}

const EXITED_RECORD_TTL_MS = 5 * 60 * 1000
const TRUSTED_POWERSHELL_PLUGIN_IDS = new Set(['quick-folders', 'port-manager'])
const execFileAsync = promisify(execFile)

export interface ProcessWindowCommandRunner {
  run(executable: string, args: readonly string[], signal: AbortSignal): Promise<string>
}

export interface ProcessWindowReader {
  read(pid: number, signal: AbortSignal): Promise<number>
}

function abortError(signal: AbortSignal): ZToolsError {
  if (signal.reason === errorCodes.requestTimeout) {
    return new ZToolsError(errorCodes.requestTimeout, '调用超时')
  }
  if (signal.reason === errorCodes.appStopping) {
    return new ZToolsError(errorCodes.appStopping, '应用正在退出')
  }
  return new ZToolsError(errorCodes.callerDestroyed, '调用者已销毁')
}

function normalizedPath(value: string): string {
  return path.resolve(value).toLocaleLowerCase('en-US')
}

const PROCESS_WINDOW_SCRIPT = [
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class ZToolsProcessWindow {',
  '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
  '  [DllImport("user32.dll")]',
  '  public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);',
  '  [DllImport("user32.dll")]',
  '  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
  '  [DllImport("user32.dll")]',
  '  public static extern bool IsWindowVisible(IntPtr hWnd);',
  '  public static long FindVisibleWindow(uint targetPid) {',
  '    long found = 0;',
  '    EnumWindows((hWnd, lParam) => {',
  '      uint processId;',
  '      GetWindowThreadProcessId(hWnd, out processId);',
  '      if (processId == targetPid && IsWindowVisible(hWnd)) {',
  '        found = hWnd.ToInt64();',
  '        return false;',
  '      }',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return found;',
  '  }',
  '}',
  "'@"
].join('\n')

const defaultProcessWindowCommandRunner: ProcessWindowCommandRunner = {
  async run(executable, args, signal) {
    const result = await execFileAsync(executable, [...args], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      signal
    })
    return String(result.stdout)
  }
}

function parseWindowHandle(output: string): number {
  const handle = Number(output.trim())
  if (!Number.isSafeInteger(handle) || handle < 0) {
    throw new ZToolsError(errorCodes.processError, '读取进程窗口句柄失败')
  }
  return handle
}

export function createProcessWindowReader(
  runner: ProcessWindowCommandRunner = defaultProcessWindowCommandRunner,
  platform: NodeJS.Platform = process.platform
): ProcessWindowReader {
  return {
    async read(pid, signal) {
      if (!Number.isInteger(pid) || pid < 1 || pid > 0xffff_ffff) {
        throw new ZToolsError(errorCodes.invalidRequest, 'pid 无效')
      }
      if (platform !== 'win32') {
        throw new ZToolsError(errorCodes.notSupported, '当前平台不支持进程窗口查询')
      }
      if (signal.aborted) throw abortError(signal)
      const script = `${PROCESS_WINDOW_SCRIPT}\n$targetPid = ${pid}\n[ZToolsProcessWindow]::FindVisibleWindow([uint32]$targetPid)`
      try {
        return parseWindowHandle(await runner.run(
          path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
          signal
        ))
      } catch (error) {
        if (error instanceof ZToolsError) throw error
        if (signal.aborted) throw abortError(signal)
        throw new ZToolsError(errorCodes.processError, '读取进程窗口失败')
      }
    }
  }
}

export class ProcessService {
  readonly #portRequests = new Set<AbortController>()
  #portsStopped = false
  readonly #managed = new Map<number, Map<number, ManagedProcess>>()
  readonly #removeListener: () => void

  constructor(
    registry: WindowRegistry,
    private readonly files: FileSystemService,
    private readonly now: () => number = Date.now,
    private readonly runtimePlatform: NodeJS.Platform = process.platform,
    private readonly discoveryAdapter?: ProcessDiscoveryAdapter,
    private readonly portDiscoveryAdapter?: PortDiscoveryAdapter,
    private readonly windowReader: ProcessWindowReader = createProcessWindowReader()
  ) {
    this.#removeListener = registry.onRemoved((webContentsId) => this.#disposeCaller(webContentsId))
  }

  stop(): void {
    this.#portsStopped = true; for (const controller of this.#portRequests) controller.abort(errorCodes.appStopping)
    this.#removeListener()
    for (const webContentsId of this.#managed.keys()) this.#disposeCaller(webContentsId)
    this.#managed.clear()
  }

  async listPorts(signal: AbortSignal): Promise<PortSnapshot & { success: true }> {
    if (this.#portsStopped) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
    if (signal.aborted) throw abortError(signal)
    if (this.#portRequests.size >= 4) throw new ZToolsError(errorCodes.pluginBusy, '端口查询正在处理中')
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]); this.#portRequests.add(controller)
    try {
      const result = await (this.portDiscoveryAdapter ?? createPlatformPortDiscoveryAdapter(this.runtimePlatform)).list(combined)
      if (combined.aborted || this.#portsStopped) throw abortError(combined)
      return { success: true, ...result }
    } finally { this.#portRequests.delete(controller) }
  }

  async list(signal: AbortSignal): Promise<{ success: true; data: ProcessSummary[] }> {
    return { success: true, data: await this.#listProcesses(signal) }
  }

  async info(
    params: ProcessPidParams,
    _caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: ProcessSummary }> {
    const item = (await this.#listProcesses(signal)).find((processItem) => processItem.pid === params.pid)
    if (!item) throw new ZToolsError(errorCodes.processError, '进程不存在')
    return { success: true, data: item }
  }

  async exists(
    params: ProcessExistsParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: { exists: boolean } }> {
    const numeric = /^\d+$/.test(params.nameOrPid) ? Number(params.nameOrPid) : undefined
    if (numeric !== undefined && Number.isInteger(numeric) && numeric > 0 && numeric <= 0xffff_ffff) {
      const owned = this.#managed.get(caller.webContentsId)?.get(numeric)
      if (owned) return { success: true, data: { exists: !owned.exited } }
      const processes = await this.#listProcesses(signal)
      return { success: true, data: { exists: processes.some((item) => item.pid === numeric) } }
    }
    const target = params.nameOrPid.toLocaleLowerCase('en-US')
    const processes = await this.#listProcesses(signal)
    return {
      success: true,
      data: { exists: processes.some((item) => item.name.toLocaleLowerCase('en-US') === target) }
    }
  }

  async find(
    params: ProcessFindParams,
    signal: AbortSignal
  ): Promise<{ success: true; data: Array<{ pid: number; name: string }> }> {
    const target = params.name.toLocaleLowerCase('en-US')
    const data = (await this.#listProcesses(signal))
      .filter((item) => item.name.toLocaleLowerCase('en-US').includes(target))
      .map(({ pid, name }) => ({ pid, name }))
    return { success: true, data }
  }

  async start(
    params: ProcessStartParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; pid: number }> {
    if (this.runtimePlatform !== 'win32') {
      throw new ZToolsError(errorCodes.notSupported, '当前平台尚未实现工具与应用启动适配器')
    }
    if (signal.aborted) throw abortError(signal)
    const executable = await this.#resolveExecutable(params.path, caller)
    const workingDirectory = params.workingDir === ''
      ? path.dirname(executable)
      : await this.files.resolveAuthorizedPath(params.workingDir, caller, 'read', false)
    let workingStats: Awaited<ReturnType<typeof fs.stat>>
    try {
      workingStats = await fs.stat(workingDirectory)
    } catch {
      throw new ZToolsError(errorCodes.processError, '工作目录不存在')
    }
    if (!workingStats.isDirectory()) throw new ZToolsError(errorCodes.processError, '工作目录不是目录')
    if (signal.aborted) throw abortError(signal)

    let child: ChildProcess
    try {
      child = spawn(executable, params.args, {
        cwd: workingDirectory,
        shell: false,
        stdio: 'ignore',
        windowsHide: !params.show
      })
    } catch {
      throw new ZToolsError(errorCodes.processError, '启动进程失败')
    }

    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort)
        child.removeListener('spawn', onSpawn)
        child.removeListener('error', onError)
      }
      const onSpawn = (): void => {
        cleanup()
        resolve()
      }
      const onError = (): void => {
        cleanup()
        reject(new ZToolsError(errorCodes.processError, '启动进程失败'))
      }
      const onAbort = (): void => {
        cleanup()
        child.kill('SIGKILL')
        reject(abortError(signal))
      }
      child.once('spawn', onSpawn)
      child.once('error', onError)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    const pid = child.pid
    if (!pid) {
      child.kill()
      throw new ZToolsError(errorCodes.processError, '进程未返回有效 PID')
    }
    const record: ManagedProcess = {
      child,
      pid,
      name: path.basename(executable).toLocaleLowerCase('en-US'),
      ownerWebContentsId: caller.webContentsId,
      exited: false,
      exitCode: undefined,
      exitedAt: undefined
    }
    const records = this.#managed.get(caller.webContentsId) ?? new Map<number, ManagedProcess>()
    this.#prune(records)
    records.set(pid, record)
    this.#managed.set(caller.webContentsId, records)
    child.once('exit', (code) => {
      record.exited = true
      record.exitCode = code ?? -1
      record.exitedAt = this.now()
    })
    child.on('error', () => {
      record.exited = true
      record.exitCode ??= -1
      record.exitedAt ??= this.now()
    })
    if (signal.aborted) {
      records.delete(pid)
      child.kill('SIGKILL')
      throw abortError(signal)
    }
    return { success: true, pid }
  }

  kill(params: ProcessKillParams, caller: CallerIdentity): { success: true } {
    const record = this.#ownedProcess(params.pid, caller)
    if (record.exited) throw new ZToolsError(errorCodes.processError, '进程已经退出')
    const killed = record.child.kill(params.force ? 'SIGKILL' : 'SIGTERM')
    if (!killed) throw new ZToolsError(errorCodes.processError, '终止进程失败')
    return { success: true }
  }

  async wait(
    params: ProcessWaitParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: { exitCode: number } }> {
    const record = this.#ownedProcess(params.pid, caller)
    if (record.exited) return { success: true, data: { exitCode: record.exitCode ?? -1 } }
    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined
      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
        record.child.removeListener('exit', onExit)
      }
      const onExit = (code: number | null): void => {
        cleanup()
        resolve({ success: true, data: { exitCode: code ?? -1 } })
      }
      const onAbort = (): void => {
        cleanup()
        reject(abortError(signal))
      }
      record.child.once('exit', onExit)
      signal.addEventListener('abort', onAbort, { once: true })
      if (params.timeout > 0) {
        timeout = setTimeout(() => {
          cleanup()
          reject(new ZToolsError(errorCodes.requestTimeout, '等待进程超时'))
        }, params.timeout)
      }
      if (signal.aborted) onAbort()
    })
  }

  killByName(
    params: ProcessKillByNameParams,
    caller: CallerIdentity
  ): { success: true; killedCount: number } {
    const records = this.#managed.get(caller.webContentsId)
    if (records) this.#prune(records)
    const target = params.name.toLocaleLowerCase('en-US')
    let killedCount = 0
    for (const record of records?.values() ?? []) {
      if (record.exited || record.name !== target) continue
      const killed = record.child.kill(params.force ? 'SIGKILL' : 'SIGTERM')
      if (!killed) throw new ZToolsError(errorCodes.processError, '终止进程失败')
      killedCount += 1
    }
    if (killedCount === 0) {
      throw new ZToolsError(errorCodes.processError, '未找到匹配的进程')
    }
    return { success: true, killedCount }
  }

  getWindow(params: ProcessPidParams, signal: AbortSignal): Promise<{ success: true; handle: number }> {
    return this.windowReader.read(params.pid, signal).then((handle) => ({ success: true, handle }))
  }

  runFFmpeg(): never {
    throw new ZToolsError(errorCodes.notSupported, 'FFmpeg 进程由独立迁移批次提供')
  }

  async #resolveExecutable(value: string, caller: CallerIdentity): Promise<string> {
    let target: string
    try {
      target = await this.files.resolveAuthorizedPath(value, caller, 'read', false)
    } catch (error) {
      if (!(error instanceof ZToolsError) || error.code !== errorCodes.permissionDenied) throw error
      target = await this.#resolveTrustedSystemExecutable(value, caller)
    }
    let stats: Awaited<ReturnType<typeof fs.stat>>
    try {
      stats = await fs.stat(target)
    } catch {
      throw new ZToolsError(errorCodes.processError, '可执行文件不存在')
    }
    if (!stats.isFile() || path.extname(target).toLocaleLowerCase('en-US') !== '.exe') {
      throw new ZToolsError(errorCodes.processError, '启动目标必须是普通 EXE 文件')
    }
    return target
  }

  async #resolveTrustedSystemExecutable(value: string, caller: CallerIdentity): Promise<string> {
    if (caller.type !== 'plugin' || !caller.pluginId || !TRUSTED_POWERSHELL_PLUGIN_IDS.has(caller.pluginId)) {
      throw new ZToolsError(errorCodes.permissionDenied, '可执行文件未由当前窗口授权')
    }
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
    const trusted = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    let canonicalTarget: string
    let canonicalTrusted: string
    try {
      [canonicalTarget, canonicalTrusted] = await Promise.all([fs.realpath(value), fs.realpath(trusted)])
    } catch {
      throw new ZToolsError(errorCodes.permissionDenied, '可信系统可执行文件不可用')
    }
    if (normalizedPath(canonicalTarget) !== normalizedPath(canonicalTrusted)) {
      throw new ZToolsError(errorCodes.permissionDenied, '可执行文件未由当前窗口授权')
    }
    return canonicalTarget
  }

  #ownedProcess(pid: number, caller: CallerIdentity): ManagedProcess {
    const records = this.#managed.get(caller.webContentsId)
    if (records) this.#prune(records)
    const record = records?.get(pid)
    if (!record || record.ownerWebContentsId !== caller.webContentsId) {
      throw new ZToolsError(errorCodes.permissionDenied, '只能管理当前窗口启动的进程')
    }
    return record
  }

  #prune(records: Map<number, ManagedProcess>): void {
    const cutoff = this.now() - EXITED_RECORD_TTL_MS
    for (const [pid, record] of records) {
      if (record.exitedAt !== undefined && record.exitedAt < cutoff) records.delete(pid)
    }
  }

  #disposeCaller(webContentsId: number): void {
    const records = this.#managed.get(webContentsId)
    if (!records) return
    for (const record of records.values()) {
      if (!record.exited) record.child.kill('SIGKILL')
    }
    this.#managed.delete(webContentsId)
  }

  #listProcesses(signal: AbortSignal): Promise<ProcessSummary[]> {
    if (signal.aborted) return Promise.reject(abortError(signal))
    if (!this.discoveryAdapter) {
      return Promise.reject(new ZToolsError(errorCodes.notSupported, '当前平台未配置进程发现适配器'))
    }
    return this.discoveryAdapter.list(signal).then(
      (processes) => {
        if (signal.aborted) throw abortError(signal)
        return processes
      },
      (error: unknown) => {
        if (signal.aborted) throw abortError(signal)
        throw error
      }
    )
  }
}
