import { readHardwareSummary } from './hardware-summary.js'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type {
  SystemDiskUsageParams,
  SystemFileIconParams,
  SystemForceParams,
  SystemNotifyParams,
  SystemPathName,
  SystemPathParams,
  SystemPreventSleepParams,
  SystemShutdownParams
} from '../../contracts/method-params.js'
import { FileSystemService } from './file-system-service.js'
import type { WindowRegistry } from '../windows/window-registry.js'

type StaticSystemPath = Exclude<SystemPathName, 'cache' | 'temp'>
const execFileAsync = promisify(execFile)

export interface SystemBatteryStatus {
  percent: number
  isCharging: boolean
  timeRemaining: number
}

export type SystemPowerAction =
  | 'shutdown'
  | 'restart'
  | 'logout'
  | 'lock'
  | 'sleep'
  | 'hibernate'

export interface SystemPowerCommandRunner {
  run(executable: string, args: readonly string[]): Promise<void>
}

export interface SystemPowerAdapter {
  execute(action: SystemPowerAction, options: { force?: boolean; timeout?: number }): Promise<void>
}

export interface SystemBrowserWindowReader {
  readTitle(): Promise<string>
}

export interface SystemBrowserUrlAdapter {
  read(): Promise<{ url: string; browser: string }>
}

export interface SystemAdapter {
  appName: string
  appVersion: string
  isDev: boolean
  paths: Record<StaticSystemPath, string>
  getProductVersion?(): string
  isDarkMode(): boolean
  setDarkMode(enabled: boolean): void
  showNotification(params: SystemNotifyParams, caller: CallerIdentity): Promise<void>
  getFileIcon(filePath: string): Promise<string>
  getNativeId(): Promise<string>
  getBatteryStatus?: () => Promise<SystemBatteryStatus>
  startPreventSleep(): number
  stopPreventSleep(id: number): void
}

interface CpuTimes {
  idle: number
  total: number
}

function currentCpuTimes(): CpuTimes {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
  }
  return { idle, total }
}

function platformName(platform: NodeJS.Platform): 'windows' | 'macos' | 'linux' {
  switch (platform) {
    case 'win32': return 'windows'
    case 'darwin': return 'macos'
    case 'linux': return 'linux'
    default:
      throw new ZToolsError(errorCodes.notSupported, `不支持的系统平台: ${platform}`)
  }
}

export function resolveSystemVolumePath(
  platform: NodeJS.Platform,
  requestedPath?: string,
  systemDrive = process.env.SystemDrive
): string {
  const defaultPath = platform === 'win32'
    ? `${/^[A-Za-z]:$/.test(systemDrive ?? '') ? systemDrive : 'C:'}\\`
    : '/'
  const volumePath = requestedPath ?? defaultPath
  if (/[\u0000-\u001f\u007f]/.test(volumePath)) {
    throw new ZToolsError(errorCodes.invalidRequest, '卷路径包含无效字符')
  }
  if (platform === 'win32') {
    if (!path.win32.isAbsolute(volumePath) || !/^[A-Za-z]:[\\/]/.test(volumePath)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Windows 卷路径必须是本地驱动器绝对路径')
    }
    return volumePath
  }
  if (platform === 'darwin' || platform === 'linux') {
    if (!path.posix.isAbsolute(volumePath)) {
      throw new ZToolsError(errorCodes.invalidRequest, '卷路径必须是 POSIX 绝对路径')
    }
    return volumePath
  }
  throw new ZToolsError(errorCodes.notSupported, `当前系统不支持磁盘查询: ${platform}`)
}

const BATTERY_STATUS_SCRIPT = [
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class ZToolsPowerStatus {',
  '  [StructLayout(LayoutKind.Sequential)]',
  '  public struct SYSTEM_POWER_STATUS {',
  '    public byte ACLineStatus;',
  '    public byte BatteryFlag;',
  '    public byte BatteryLifePercent;',
  '    public byte Reserved;',
  '    public uint BatteryLifeTime;',
  '    public uint BatteryFullLifeTime;',
  '  }',
  '  [DllImport("kernel32.dll")]',
  '  public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);',
  '}',
  "'@",
  '$status = New-Object ZToolsPowerStatus+SYSTEM_POWER_STATUS',
  'if (-not [ZToolsPowerStatus]::GetSystemPowerStatus([ref]$status)) { exit 1 }',
  '$timeRemaining = [int64]$status.BatteryLifeTime',
  'if ($status.BatteryLifeTime -eq [uint32]::MaxValue) { $timeRemaining = -1 }',
  '[pscustomobject]@{',
  '  percent = [int]$status.BatteryLifePercent',
  '  isCharging = $status.ACLineStatus -eq 1',
  '  timeRemaining = $timeRemaining',
  '} | ConvertTo-Json -Compress'
].join('\n')

function unknownBatteryStatus(): SystemBatteryStatus {
  return { percent: 255, isCharging: false, timeRemaining: -1 }
}

function windowsSystemExecutable(name: string): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name)
}

const BROWSER_TITLE_SCRIPT = [
  "Add-Type -TypeDefinition @'",
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public static class ZToolsForegroundWindow {',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)]',
  '  public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)]',
  '  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);',
  '}',
  "'@",
  '$handle = [ZToolsForegroundWindow]::GetForegroundWindow()',
  '$title = ""',
  'if ($handle -ne [IntPtr]::Zero) {',
  '  $buffer = New-Object System.Text.StringBuilder 512',
  '  [void][ZToolsForegroundWindow]::GetWindowText($handle, $buffer, $buffer.Capacity)',
  '  $title = $buffer.ToString()',
  '}',
  '[pscustomobject]@{ title = $title } | ConvertTo-Json -Compress'
].join('\n')

const defaultBrowserWindowReader: SystemBrowserWindowReader = {
  async readTitle() {
    if (process.platform !== 'win32') return ''
    try {
      const result = await execFileAsync(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        BROWSER_TITLE_SCRIPT
      ], {
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        windowsHide: true
      })
      const value: unknown = JSON.parse(String(result.stdout).trim())
      if (typeof value !== 'object' || value === null || !('title' in value) || typeof value.title !== 'string') {
        return ''
      }
      return value.title
    } catch {
      return ''
    }
  }
}

export function parseBrowserWindowTitle(title: string): { url: string; browser: string } {
  let browser = ''
  if (/chrome/i.test(title)) browser = 'Chrome'
  else if (/edge/i.test(title)) browser = 'Edge'
  else if (/firefox/i.test(title)) browser = 'Firefox'
  const url = title.match(/https?:\/\/[^\s]+/i)?.[0] ?? ''
  return { url, browser }
}

export function createSystemBrowserUrlAdapter(
  reader: SystemBrowserWindowReader = defaultBrowserWindowReader,
  platform: NodeJS.Platform = process.platform
): SystemBrowserUrlAdapter {
  return {
    async read() {
      if (platform !== 'win32') return { url: '', browser: '' }
      try {
        return parseBrowserWindowTitle(await reader.readTitle())
      } catch {
        return { url: '', browser: '' }
      }
    }
  }
}

export function readSystemBrowserUrl(): Promise<{ url: string; browser: string }> {
  return createSystemBrowserUrlAdapter().read()
}

const defaultPowerCommandRunner: SystemPowerCommandRunner = {
  async run(executable, args) {
    await execFileAsync(executable, [...args], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    })
  }
}

function powerCommand(
  action: SystemPowerAction,
  options: { force?: boolean; timeout?: number }
): { executable: string; args: string[] } {
  const force = options.force ?? false
  switch (action) {
    case 'shutdown': {
      const timeout = options.timeout ?? 0
      if (!Number.isInteger(timeout) || timeout < 0 || timeout > 86_400) {
        throw new ZToolsError(errorCodes.invalidRequest, 'timeout 无效')
      }
      return {
        executable: windowsSystemExecutable('shutdown.exe'),
        args: ['/s', ...(force ? ['/f'] : []), '/t', String(timeout)]
      }
    }
    case 'restart':
      return {
        executable: windowsSystemExecutable('shutdown.exe'),
        args: ['/r', ...(force ? ['/f'] : []), '/t', '0']
      }
    case 'logout':
      return {
        executable: windowsSystemExecutable('shutdown.exe'),
        args: ['/l', ...(force ? ['/f'] : [])]
      }
    case 'lock':
      return {
        executable: windowsSystemExecutable('rundll32.exe'),
        args: ['user32.dll,LockWorkStation']
      }
    case 'sleep':
      return {
        executable: windowsSystemExecutable('rundll32.exe'),
        args: ['powrprof.dll,SetSuspendState', '0', '0', '0']
      }
    case 'hibernate':
      return {
        executable: windowsSystemExecutable('rundll32.exe'),
        args: ['powrprof.dll,SetSuspendState', '1', '0', '0']
      }
  }
}

export function createSystemPowerAdapter(
  runner: SystemPowerCommandRunner = defaultPowerCommandRunner,
  platform: NodeJS.Platform = process.platform
): SystemPowerAdapter {
  return {
    async execute(action, options) {
      if (platform !== 'win32') {
        throw new ZToolsError(errorCodes.notSupported, '当前平台不支持系统电源操作')
      }
      const command = powerCommand(action, options)
      try {
        await runner.run(command.executable, command.args)
      } catch (error) {
        if (error instanceof ZToolsError) throw error
        throw new ZToolsError(errorCodes.processError, '系统电源操作失败')
      }
    }
  }
}

export async function readSystemBatteryStatus(platform: NodeJS.Platform = process.platform): Promise<SystemBatteryStatus> {
  if (platform !== 'win32') return unknownBatteryStatus()
  const executable = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  try {
    const result = await execFileAsync(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      BATTERY_STATUS_SCRIPT
    ], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true
    })
    const stdout = String(result.stdout)
    const value: unknown = JSON.parse(stdout.trim())
    if (
      typeof value !== 'object' || value === null ||
      !('percent' in value) || !('isCharging' in value) || !('timeRemaining' in value) ||
      typeof value.percent !== 'number' || !Number.isInteger(value.percent) ||
      (value.percent < 0 || value.percent > 100) && value.percent !== 255 ||
      typeof value.isCharging !== 'boolean' ||
      typeof value.timeRemaining !== 'number' ||
      !Number.isSafeInteger(value.timeRemaining) ||
      value.timeRemaining < -1
    ) {
      return unknownBatteryStatus()
    }
    return {
      percent: value.percent,
      isCharging: value.isCharging,
      timeRemaining: value.timeRemaining
    }
  } catch {
    return unknownBatteryStatus()
  }
}

export class SystemService {
  readonly #preventSleepCallers = new Set<number>()
  readonly #removeListener: () => void
  #preventSleepId: number | undefined
  #cpuTimes = currentCpuTimes()

  constructor(
    private readonly files: FileSystemService,
    registry: WindowRegistry,
    private readonly adapter: SystemAdapter,
    private readonly runtimePlatform: NodeJS.Platform = process.platform,
    private readonly power: SystemPowerAdapter = createSystemPowerAdapter(undefined, runtimePlatform),
    private readonly browser: SystemBrowserUrlAdapter = createSystemBrowserUrlAdapter(undefined, runtimePlatform)
  ) {
    this.#removeListener = registry.onRemoved((webContentsId) => {
      this.#preventSleepCallers.delete(webContentsId)
      this.#syncPreventSleep()
    })
  }

  stop(): void {
    this.#removeListener()
    this.#preventSleepCallers.clear()
    this.#syncPreventSleep()
  }

  async notify(params: SystemNotifyParams, caller: CallerIdentity): Promise<{ success: true; status: 'notified' }> {
    await this.adapter.showNotification(params, caller)
    return { success: true, status: 'notified' }
  }

  setDarkMode(enabled: boolean): { success: true; dark: boolean } {
    this.adapter.setDarkMode(enabled)
    return { success: true, dark: enabled }
  }

  async getInfo(caller: CallerIdentity): Promise<Record<string, unknown>> {
    const release = os.release()
    const isWindows = this.runtimePlatform === 'win32'
    const productVersion = this.runtimePlatform === 'darwin'
      ? this.readMacosProductVersion()
      : undefined
    const windowsVersion = isWindows
      ? release.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
      : undefined
    return {
      success: true,
      platform: platformName(this.runtimePlatform),
      osName: this.runtimePlatform === 'darwin' ? 'macOS' : os.version(),
      osVersion: isWindows
        ? release
        : this.runtimePlatform === 'darwin'
          ? productVersion ?? 'unknown'
          : os.version(),
      ...(windowsVersion ? {
        osMajor: windowsVersion[0] ?? 0,
        osMinor: windowsVersion[1] ?? 0,
        osBuild: windowsVersion[2] ?? 0,
        windowsFamily: 'Windows NT',
        windowsRelease: release
      } : { kernelRelease: release }),
      osArch: os.arch(),
      processArch: process.arch,
      appName: this.adapter.appName,
      appVersion: this.adapter.appVersion,
      darkMode: this.adapter.isDarkMode(),
      binPath: this.adapter.paths.app,
      cachePath: await this.files.getScopedCachePath(caller),
      debug: this.adapter.isDev
    }
  }

  private readMacosProductVersion(): string | undefined {
    try {
      const value = this.adapter.getProductVersion?.().trim()
      return value && /^\d+(?:\.\d+){1,2}$/.test(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  async getNativeId(): Promise<{ success: true; nativeId: string }> {
    const nativeId = (await this.adapter.getNativeId()).trim().toUpperCase()
    if (!/^[0-9A-F]{8}$/.test(nativeId)) {
      throw new ZToolsError(errorCodes.notSupported, '无法读取兼容的 Windows 卷序列号')
    }
    return { success: true, nativeId }
  }

  getAppName(): { success: true; appName: string } {
    return { success: true, appName: this.adapter.appName }
  }

  getAppVersion(): { success: true; appVersion: string } {
    return { success: true, appVersion: this.adapter.appVersion }
  }

  async getPath(params: SystemPathParams, caller: CallerIdentity): Promise<{ success: true; path: string }> {
    switch (params.name) {
      case 'cache':
        return { success: true, path: await this.files.getScopedCachePath(caller) }
      case 'temp':
        return { success: true, path: await this.files.getScopedTempPath(caller) }
      default:
        return { success: true, path: this.adapter.paths[params.name] }
    }
  }

  async getFileIcon(params: SystemFileIconParams, caller: CallerIdentity): Promise<Record<string, unknown>> {
    const filePath = await this.files.resolveAuthorizedPath(params.filePath, caller, 'read', false)
    try {
      return {
        success: true,
        icon: await this.adapter.getFileIcon(filePath),
        filePath
      }
    } catch {
      throw new ZToolsError(errorCodes.fileError, '无法读取文件图标')
    }
  }

  async readCurrentFolder(caller: CallerIdentity): Promise<{ success: true; path: string }> {
    return this.files.getCurrentDirectory(caller)
  }

  async readCurrentBrowserUrl(): Promise<{
    success: true
    url: string
    browser: string
    message?: string
  }> {
    const result = await this.browser.read()
    return result.url
      ? { success: true, ...result }
      : {
          success: true,
          ...result,
          message: '未检测到活动的浏览器窗口或无法获取URL'
        }
  }

  getPlatform(): Record<string, unknown> {
    const platform = platformName(this.runtimePlatform)
    return {
      success: true,
      platform,
      isWindows: platform === 'windows',
      isMacOS: platform === 'macos',
      isLinux: platform === 'linux'
    }
  }

  isDev(): { success: true; isDev: boolean } {
    return { success: true, isDev: this.adapter.isDev }
  }

  shutdown(params: SystemShutdownParams): Promise<{ success: true; action: 'shutdown' }> {
    return this.#runPowerAction('shutdown', params)
  }

  restart(params: SystemForceParams): Promise<{ success: true; action: 'restart' }> {
    return this.#runPowerAction('restart', params)
  }

  logout(params: SystemForceParams): Promise<{ success: true; action: 'logout' }> {
    return this.#runPowerAction('logout', params)
  }

  lock(): Promise<{ success: true; action: 'lock' }> {
    return this.#runPowerAction('lock', {})
  }

  sleep(): Promise<{ success: true; action: 'sleep' }> {
    return this.#runPowerAction('sleep', {})
  }

  hibernate(): Promise<{ success: true; action: 'hibernate' }> {
    return this.#runPowerAction('hibernate', {})
  }

  setPreventSleep(params: SystemPreventSleepParams, caller: CallerIdentity): { success: true } {
    if (params.enable) this.#preventSleepCallers.add(caller.webContentsId)
    else this.#preventSleepCallers.delete(caller.webContentsId)
    this.#syncPreventSleep()
    return { success: true }
  }

  getHardwareSummary() { return { success: true as const, data: readHardwareSummary(this.runtimePlatform, this.runtimePlatform === 'darwin' ? this.readMacosProductVersion() : undefined) } }

  getCpuUsage(): { success: true; data: { total: number; perCore: number[] } } {
    const next = currentCpuTimes()
    const idle = next.idle - this.#cpuTimes.idle
    const total = next.total - this.#cpuTimes.total
    this.#cpuTimes = next
    const usage = total > 0 ? Math.round(100 * (total - idle) / total) : 0
    return {
      success: true,
      data: { total: Math.max(0, Math.min(100, usage)), perCore: [] }
    }
  }

  getMemoryUsage(): Record<string, unknown> {
    const total = os.totalmem()
    const available = os.freemem()
    const used = total - available
    return {
      success: true,
      data: {
        total,
        used,
        available,
        percent: total > 0 ? Math.round(used * 100 / total) : 0
      }
    }
  }

  async getDiskUsage(params: SystemDiskUsageParams): Promise<Record<string, unknown>> {
    const volumePath = resolveSystemVolumePath(this.runtimePlatform, params.drive)
    try {
      const stats = await fs.statfs(volumePath)
      const total = stats.bsize * stats.blocks
      const free = stats.bsize * stats.bavail
      const used = total - free
      return {
        success: true,
        data: {
          total,
          used,
          free,
          percent: total > 0 ? Math.round(used * 100 / total) : 0
        }
      }
    } catch {
      throw new ZToolsError(errorCodes.fileError, '无法读取驱动器容量')
    }
  }

  getNetworkStats(): never {
    throw new ZToolsError(errorCodes.notSupported, '网络流量统计尚未实现')
  }

  async getBatteryStatus(): Promise<{ success: true } & SystemBatteryStatus> {
    const status = await (this.adapter.getBatteryStatus?.() ?? readSystemBatteryStatus(this.runtimePlatform))
    return { success: true, ...status }
  }

  async #runPowerAction<Action extends SystemPowerAction>(action: Action, options: { force?: boolean; timeout?: number }): Promise<{
    success: true
    action: Action
  }> {
    await this.power.execute(action, options)
    return { success: true, action }
  }

  #syncPreventSleep(): void {
    if (this.#preventSleepCallers.size > 0 && this.#preventSleepId === undefined) {
      this.#preventSleepId = this.adapter.startPreventSleep()
      return
    }
    if (this.#preventSleepCallers.size === 0 && this.#preventSleepId !== undefined) {
      this.adapter.stopPreventSleep(this.#preventSleepId)
      this.#preventSleepId = undefined
    }
  }
}
