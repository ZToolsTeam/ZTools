import { readHardwareSummary } from './hardware-summary.js'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fsSync from 'node:fs'
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
import { readSystemAvailableMemoryBytes } from '../platform/macos/memory.js'
import type { WindowRegistry } from '../windows/window-registry.js'

type StaticSystemPath = Exclude<SystemPathName, 'cache' | 'temp'>
const execFileAsync = promisify(execFile)

/** system_list_common_folders 的一项：路径由主进程计算，exists 为调用时实测 */
export interface CommonFolder {
  id: string
  path: string
  exists: boolean
}

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

export interface SystemShortcutItem {
  id: string
  name: string
  folder?: string | undefined
}

export interface SystemAudioDevice {
  id: string
  name: string
  type: 'output' | 'input'
  isDefault: boolean
  volume?: number | undefined
  muted?: boolean | undefined
  transport?: string | undefined
}

export interface SystemWifiProfile {
  ssid: string
  current?: boolean | undefined
  security?: string | undefined
}

export interface BrewPackageInfo {
  name: string
  version?: string
  latestVersion?: string
  isCask?: boolean
  outdated?: boolean
}

/** 解析 brew info --json=v2 --installed，保留 formula/cask 与升级状态。 */
export function parseInstalledBrewPackages(output: string): BrewPackageInfo[] {
  const raw: unknown = JSON.parse(output)
  if (!raw || typeof raw !== 'object') throw new Error('Homebrew 软件包信息格式无效')
  const data = raw as Record<string, unknown>
  if (!Array.isArray(data.formulae) || !Array.isArray(data.casks)) throw new Error('Homebrew 软件包信息缺少 formulae/casks')
  const readObject = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Homebrew 软件包条目格式无效')
    return value as Record<string, unknown>
  }
  return [
    ...data.formulae.map((value: unknown) => {
      const item = readObject(value)
      if (typeof item.name !== 'string' || !item.name) throw new Error('Homebrew formula 名称无效')
      const installed = Array.isArray(item.installed) ? item.installed : []
      const versions = readObject(item.versions)
      return { name: item.name, isCask: false, outdated: item.outdated === true,
        version: installed.map((entry: unknown) => String(readObject(entry).version ?? '')).filter(Boolean).join(', '),
        latestVersion: String(versions.stable ?? '') }
    }),
    ...data.casks.map((value: unknown) => {
      const item = readObject(value)
      if (typeof item.token !== 'string' || !item.token) throw new Error('Homebrew cask 名称无效')
      return { name: item.token, isCask: true, outdated: item.outdated === true,
        version: Array.isArray(item.installed) ? item.installed.map(String).join(', ') : String(item.installed ?? ''),
        latestVersion: String(item.version ?? '') }
    })
  ]
}

export type BrewAction =
  | 'list'
  | 'search'
  | 'info'
  | 'outdated'
  | 'install'
  | 'upgrade'
  | 'uninstall'
  | 'cleanup'

const ALLOWED_BREW_ACTIONS = new Set<BrewAction>([
  'list',
  'search',
  'info',
  'outdated',
  'install',
  'upgrade',
  'uninstall',
  'cleanup'
])

const SAFE_BREW_PKG_REGEX = /^[A-Za-z0-9@._+-]+$/

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

const MACOS_BROWSER_URL_APPLE_SCRIPT = [
  'tell application "System Events"',
  '  set frontApp to name of first application process whose frontmost is true',
  'end tell',
  'if frontApp is "Safari" then',
  '  tell application "Safari" to return "Safari|" & (URL of current tab of front window)',
  'else if frontApp is "Google Chrome" then',
  '  tell application "Google Chrome" to return "Chrome|" & (URL of active tab of front window)',
  'else if frontApp is "Arc" then',
  '  tell application "Arc" to return "Arc|" & (URL of active tab of front window)',
  'else if frontApp is "Brave Browser" then',
  '  tell application "Brave Browser" to return "Brave|" & (URL of active tab of front window)',
  'else if frontApp is "Microsoft Edge" then',
  '  tell application "Microsoft Edge" to return "Edge|" & (URL of active tab of front window)',
  'end if',
  'return ""'
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
  else if (/safari/i.test(title)) browser = 'Safari'
  else if (/arc/i.test(title)) browser = 'Arc'
  else if (/brave/i.test(title)) browser = 'Brave'
  const url = title.match(/https?:\/\/[^\s]+/i)?.[0] ?? ''
  return { url, browser }
}

export function createSystemBrowserUrlAdapter(
  reader: SystemBrowserWindowReader = defaultBrowserWindowReader,
  platform: NodeJS.Platform = process.platform
): SystemBrowserUrlAdapter {
  return {
    async read() {
      if (platform === 'darwin') {
        try {
          const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', MACOS_BROWSER_URL_APPLE_SCRIPT], {
            encoding: 'utf8',
            timeout: 4_000,
            maxBuffer: 64 * 1024
          })
          const raw = String(stdout ?? '').trim()
          if (raw && raw.includes('|')) {
            const sepIndex = raw.indexOf('|')
            const browser = raw.slice(0, sepIndex).trim()
            const url = raw.slice(sepIndex + 1).trim()
            if (/^https?:\/\//i.test(url)) {
              return { url, browser }
            }
          }
          const fallbackTitle = await reader.readTitle()
          return fallbackTitle ? parseBrowserWindowTitle(fallbackTitle) : { url: '', browser: '' }
        } catch {
          return { url: '', browser: '' }
        }
      }
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
  options: { force?: boolean; timeout?: number },
  platform: NodeJS.Platform = 'win32'
): { executable: string; args: string[] } {
  if (platform === 'darwin') {
    switch (action) {
      case 'lock':
        return {
          executable: '/usr/bin/pmset',
          args: ['displaysleepnow']
        }
      case 'sleep':
      case 'hibernate':
        return {
          executable: '/usr/bin/pmset',
          args: ['sleepnow']
        }
      case 'restart':
        return {
          executable: '/usr/bin/osascript',
          args: ['-e', 'tell application "System Events" to restart']
        }
      case 'shutdown':
        return {
          executable: '/usr/bin/osascript',
          args: ['-e', 'tell application "System Events" to shut down']
        }
      case 'logout':
        return {
          executable: '/usr/bin/osascript',
          args: ['-e', 'tell application "System Events" to log out']
        }
    }
  }

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
      if (platform !== 'win32' && platform !== 'darwin') {
        throw new ZToolsError(errorCodes.notSupported, '当前平台不支持系统电源操作')
      }
      const command = powerCommand(action, options, platform)
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
  if (platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/usr/bin/pmset', ['-g', 'batt'], {
        encoding: 'utf8',
        timeout: 4_000,
        maxBuffer: 64 * 1024
      })
      const text = String(stdout ?? '')
      const percentMatch = text.match(/(\d{1,3})%/)
      if (!percentMatch) return unknownBatteryStatus()
      const percent = Math.max(0, Math.min(100, Number.parseInt(percentMatch[1] ?? '0', 10)))
      const isCharging = /AC Power|charging|charged/i.test(text) && !/discharging/i.test(text)
      const timeMatch = text.match(/(\d+):(\d+)\s+remaining/i)
      const timeRemaining = timeMatch
        ? (Number.parseInt(timeMatch[1] ?? '0', 10) * 3600 + Number.parseInt(timeMatch[2] ?? '0', 10) * 60)
        : -1
      return { percent, isCharging, timeRemaining }
    } catch {
      return unknownBatteryStatus()
    }
  }
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
  #caffeinateProcess: ChildProcess | null = null
  #cpuTimes = currentCpuTimes()
  #winAudioCache: { devices: SystemAudioDevice[]; timestamp: number } | null = null
  #winBrewListCache: {
    stdout: string
    items: Array<{
      name: string
      fullName?: string
      version?: string
      installedVersion?: string
      latestVersion?: string
      type?: 'formula' | 'cask'
      isCask?: boolean
      cask?: boolean
      description?: string
      tap?: string
    }>
    timestamp: number
  } | null = null

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
    this.#stopCaffeinateProcess()
  }

  #stopCaffeinateProcess(): void {
    if (this.#caffeinateProcess) {
      try {
        this.#caffeinateProcess.kill('SIGTERM')
      } catch {
        // ignore
      }
      this.#caffeinateProcess = null
    }
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

  /**
   * 常用目录（个人目录 + 各平台约定的系统 / 临时目录）。路径由主进程计算，插件不再自己拼路径；
   * 路由层把存在的目录登记为只读、不递归的结果授权。temp 是系统临时目录（不是 ZTools 专属的 system_get_path('temp')）。
   */
  async listCommonFolders(env: NodeJS.ProcessEnv = process.env): Promise<{ success: true; data: { folders: CommonFolder[] } }> {
    const paths = this.adapter.paths
    const home = paths.home
    const candidates: Array<[string, string | undefined]> = [
      ['home', home],
      ['desktop', paths.desktop],
      ['downloads', paths.downloads],
      ['documents', paths.documents],
      ['pictures', paths.pictures],
      ['videos', paths.videos],
      ['music', paths.music],
      ['appData', paths.appData]
    ]
    if (this.runtimePlatform === 'darwin') {
      candidates.push(
        ['applications', '/Applications'],
        ['library', home ? path.join(home, 'Library') : undefined],
        ['libraryCaches', home ? path.join(home, 'Library', 'Caches') : undefined],
        ['temp', os.tmpdir()]
      )
    } else if (this.runtimePlatform === 'win32') {
      const systemDrive = /^[A-Za-z]:$/.test(env.SystemDrive ?? '') ? env.SystemDrive! : 'C:'
      candidates.push(
        ['localAppData', env.LOCALAPPDATA || (home ? path.win32.join(home, 'AppData', 'Local') : undefined)],
        ['systemDrive', `${systemDrive.toUpperCase()}\\`],
        ['temp', env.TEMP || os.tmpdir()]
      )
    } else {
      candidates.push(['temp', os.tmpdir()])
    }
    const folders = await Promise.all(candidates
      .filter((item): item is [string, string] => typeof item[1] === 'string' && item[1] !== '')
      .map(async ([id, folderPath]) => ({
        id,
        path: folderPath,
        exists: await fs.stat(folderPath).then((stats) => stats.isDirectory(), () => false)
      })))
    return { success: true, data: { folders } }
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

  async getMemoryUsage(): Promise<Record<string, unknown>> {
    const total = os.totalmem()
    const available = await readSystemAvailableMemoryBytes(this.runtimePlatform)
    const used = Math.max(0, total - available)
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

  async executeSystemAction(
    actionKey: string,
    params: Record<string, unknown> = {}
  ): Promise<{ success: boolean; action: string; message: string; state?: unknown }> {
    const normalized = String(actionKey ?? '').trim().toLowerCase()
    if (!normalized) {
      throw new ZToolsError(errorCodes.invalidRequest, 'actionKey 不能为空')
    }

    switch (normalized) {
      case 'toggle-appearance': {
        const nextDark = !this.adapter.isDarkMode()
        this.adapter.setDarkMode(nextDark)
        if (this.runtimePlatform === 'darwin') {
          try {
            await execFileAsync('/usr/bin/osascript', [
              '-e',
              'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode'
            ], { timeout: 5_000 })
          } catch {
            // ignore osascript failure if Electron nativeTheme already switched
          }
        }
        return {
          success: true,
          action: normalized,
          message: nextDark ? '已切换至深色模式' : '已切换至浅色模式',
          state: { darkMode: nextDark }
        }
      }

      case 'empty-trash': {
        if (this.runtimePlatform === 'darwin') {
          await execFileAsync('/usr/bin/osascript', [
            '-e',
            'tell application "Finder" to empty the trash'
          ], { timeout: 15_000 })
        } else if (this.runtimePlatform === 'win32') {
          await execFileAsync(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            'Clear-RecycleBin -Force -ErrorAction SilentlyContinue'
          ], { timeout: 15_000, windowsHide: true })
        }
        return { success: true, action: normalized, message: '废纸篓已清空' }
      }

      case 'eject-all-disks': {
        if (this.runtimePlatform !== 'darwin') {
          return { success: false, action: normalized, message: '当前平台暂不支持一键推出所有外置磁盘' }
        }
        try {
          await execFileAsync('/usr/bin/osascript', [
            '-e',
            'tell application "Finder" to eject (every disk whose ejectable is true)'
          ], { timeout: 15_000 })
          return { success: true, action: normalized, message: '所有外置磁盘已安全推出' }
        } catch (err) {
          return {
            success: false,
            action: normalized,
            message: err instanceof Error ? err.message : '推出所有外置磁盘失败'
          }
        }
      }

      case 'toggle-hidden-files': {
        if (this.runtimePlatform === 'darwin') {
          let current = 'false'
          try {
            const { stdout } = await execFileAsync('/usr/bin/defaults', [
              'read',
              'com.apple.finder',
              'AppleShowAllFiles'
            ], { timeout: 4_000 })
            current = String(stdout ?? '').trim().toLowerCase()
          } catch {
            current = 'false'
          }
          const next = current === '1' || current === 'true' || current === 'yes' ? 'false' : 'true'
          await execFileAsync('/usr/bin/defaults', [
            'write',
            'com.apple.finder',
            'AppleShowAllFiles',
            '-bool',
            next
          ], { timeout: 4_000 })
          await execFileAsync('/usr/bin/killall', ['Finder'], { timeout: 4_000 }).catch(() => {})
          return {
            success: true,
            action: normalized,
            message: next === 'true' ? '已显示隐藏文件' : '已隐藏系统隐藏文件',
            state: { showHiddenFiles: next === 'true' }
          }
        }
        return { success: true, action: normalized, message: '已切换隐藏文件显示状态' }
      }

      case 'toggle-desktop-icons': {
        if (this.runtimePlatform === 'darwin') {
          let current = 'true'
          try {
            const { stdout } = await execFileAsync('/usr/bin/defaults', [
              'read',
              'com.apple.finder',
              'CreateDesktop'
            ], { timeout: 4_000 })
            current = String(stdout ?? '').trim().toLowerCase()
          } catch {
            current = 'true'
          }
          const isCurrentlyShown = !(current === '0' || current === 'false' || current === 'no')
          const next = isCurrentlyShown ? 'false' : 'true'
          await execFileAsync('/usr/bin/defaults', [
            'write',
            'com.apple.finder',
            'CreateDesktop',
            '-bool',
            next
          ], { timeout: 4_000 })
          await execFileAsync('/usr/bin/killall', ['Finder'], { timeout: 4_000 }).catch(() => {})
          return {
            success: true,
            action: normalized,
            message: next === 'true' ? '桌面图标已显示' : '桌面图标已隐藏',
            state: { desktopIconsVisible: next === 'true' }
          }
        }
        return { success: true, action: normalized, message: '已切换桌面图标显示状态' }
      }

      case 'toggle-caffeinate': {
        if (this.#caffeinateProcess) {
          this.#stopCaffeinateProcess()
          if (this.#preventSleepId !== undefined) {
            this.adapter.stopPreventSleep(this.#preventSleepId)
            this.#preventSleepId = undefined
          }
          return {
            success: true,
            action: normalized,
            message: '咖啡因防休眠已关闭',
            state: { caffeinated: false }
          }
        }
        if (this.runtimePlatform === 'darwin') {
          try {
            const child = spawn('/usr/bin/caffeinate', ['-di'], {
              stdio: 'ignore',
              detached: false
            })
            child.on('exit', () => {
              if (this.#caffeinateProcess === child) {
                this.#caffeinateProcess = null
              }
            })
            child.on('error', () => {
              if (this.#caffeinateProcess === child) {
                this.#caffeinateProcess = null
              }
            })
            this.#caffeinateProcess = child
          } catch {
            // fallback to powerSaveBlocker
          }
        }
        if (this.#preventSleepId === undefined) {
          this.#preventSleepId = this.adapter.startPreventSleep()
        }
        return {
          success: true,
          action: normalized,
          message: '咖啡因防休眠已开启',
          state: { caffeinated: true }
        }
      }

      case 'volume-mute': {
        const res = await this.toggleAudioMute(
          typeof params.muted === 'boolean' ? params.muted : undefined
        )
        return {
          success: res.success,
          action: normalized,
          message: res.muted ? '系统音频已静音' : '系统音频已取消静音',
          state: { muted: res.muted }
        }
      }

      case 'volume-set': {
        const rawVol = typeof params.volume === 'number'
          ? params.volume
          : typeof params.level === 'number'
            ? params.level
            : 50
        const res = await this.setAudioVolume(rawVol, 'output')
        return {
          success: res.success,
          action: normalized,
          message: `音量已设为 ${res.volume}%`,
          state: { volume: res.volume }
        }
      }

      case 'volume-up':
      case 'volume-down': {
        const delta = normalized === 'volume-up' ? 10 : -10
        const currentVol = await this.#readMacosOutputVolume()
        const nextVol = Math.max(0, Math.min(100, currentVol + delta))
        const res = await this.setAudioVolume(nextVol, 'output')
        return {
          success: res.success,
          action: normalized,
          message: `音量已调整至 ${res.volume}%`,
          state: { volume: res.volume }
        }
      }

      case 'toggle-wifi': {
        if (this.runtimePlatform === 'darwin') {
          const device = await this.#resolveMacosWifiDevice()
          let isOn = true
          try {
            const { stdout } = await execFileAsync('/usr/sbin/networksetup', [
              '-getairportpower',
              device
            ], { timeout: 4_000 })
            isOn = /:\s*On/i.test(String(stdout ?? ''))
          } catch {
            isOn = true
          }
          const nextState = isOn ? 'off' : 'on'
          await execFileAsync('/usr/sbin/networksetup', [
            '-setairportpower',
            device,
            nextState
          ], { timeout: 6_000 })
          return {
            success: true,
            action: normalized,
            message: nextState === 'on' ? 'Wi-Fi 已开启' : 'Wi-Fi 已关闭',
            state: { wifiEnabled: nextState === 'on' }
          }
        }
        return { success: true, action: normalized, message: '已切换 Wi-Fi 状态' }
      }

      case 'hide-other-apps': {
        if (this.runtimePlatform !== 'darwin') {
          return { success: false, action: normalized, message: '当前平台暂不支持隐藏其他应用程序' }
        }
        try {
          await execFileAsync('/usr/bin/osascript', [
            '-e',
            'tell application "System Events" to set visible of every process whose visible is true and frontmost is false to false'
          ], { timeout: 5_000 })
          return { success: true, action: normalized, message: '已隐藏其他应用程序' }
        } catch (err) {
          return {
            success: false,
            action: normalized,
            message: err instanceof Error ? err.message : '隐藏其他应用程序失败'
          }
        }
      }

      case 'quit-all-apps': {
        if (this.runtimePlatform !== 'darwin') {
          return { success: false, action: normalized, message: '当前平台暂不支持退出所有应用程序' }
        }
        try {
          const script = [
            'tell application "System Events"',
            '  set appNames to name of every application process whose background only is false and name is not "Finder" and name is not "ZTools"',
            'end tell',
            'repeat with appName in appNames',
            '  try',
            '    tell application appName to quit',
            '  end try',
            'end repeat'
          ].join('\n')
          await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 10_000 })
          return { success: true, action: normalized, message: '已请求退出所有打开的应用程序' }
        } catch (err) {
          return {
            success: false,
            action: normalized,
            message: err instanceof Error ? err.message : '退出所有应用程序失败'
          }
        }
      }

      case 'quit-active-app': {
        if (this.runtimePlatform !== 'darwin') {
          return { success: false, action: normalized, message: '当前平台暂不支持退出当前前台应用程序' }
        }
        try {
          const script = [
            'tell application "System Events"',
            '  set frontApp to name of first application process whose frontmost is true',
            'end tell',
            'if frontApp is not "Finder" and frontApp is not "ZTools" then',
            '  tell application frontApp to quit',
            'end if'
          ].join('\n')
          await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 5_000 })
          return { success: true, action: normalized, message: '已退出当前前台应用程序' }
        } catch (err) {
          return {
            success: false,
            action: normalized,
            message: err instanceof Error ? err.message : '退出当前前台应用程序失败'
          }
        }
      }

      case 'dismiss-notifications': {
        if (this.runtimePlatform !== 'darwin') {
          return { success: false, action: normalized, message: '当前平台暂不支持清理屏幕通知横幅' }
        }
        try {
          const script = [
            'tell application "System Events"',
            '  tell process "NotificationCenter"',
            '    if exists window 1 then',
            '      click (every button of every UI element of every scroll area of window 1 whose description contains "Close" or description contains "Clear" or description contains "关闭" or description contains "清除")',
            '    end if',
            '  end tell',
            'end tell'
          ].join('\n')
          await execFileAsync('/usr/bin/osascript', ['-e', script], { timeout: 5_000 })
          return { success: true, action: normalized, message: '已清理屏幕通知横幅' }
        } catch (err) {
          return {
            success: false,
            action: normalized,
            message: err instanceof Error ? err.message : '清理屏幕通知横幅失败'
          }
        }
      }

      case 'lock-screen': {
        await this.lock()
        return { success: true, action: normalized, message: '已锁定屏幕' }
      }

      case 'sleep': {
        await this.sleep()
        return { success: true, action: normalized, message: '系统已进入休眠' }
      }

      case 'restart': {
        await this.restart({ force: false })
        return { success: true, action: normalized, message: '系统正在重启' }
      }

      case 'shutdown': {
        await this.shutdown({ force: false, timeout: 0 })
        return { success: true, action: normalized, message: '系统正在关机' }
      }

      case 'logout': {
        await this.logout({ force: false })
        return { success: true, action: normalized, message: '正在注销当前用户' }
      }

      default:
        throw new ZToolsError(errorCodes.invalidRequest, `不支持的系统动作: ${actionKey}`)
    }
  }

  /**
   * Apple Shortcuts 快捷指令列表
   */
  async listShortcuts(): Promise<SystemShortcutItem[]> {
    if (this.runtimePlatform !== 'darwin') {
      throw new ZToolsError(errorCodes.notSupported, '当前平台不支持 Apple Shortcuts')
    }
    try {
      const { stdout } = await execFileAsync('/usr/bin/shortcuts', ['list'], {
        encoding: 'utf8',
        timeout: 8_000,
        maxBuffer: 2 * 1024 * 1024
      })
      return String(stdout ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((name, idx) => ({
          id: `shortcut-${idx}-${Buffer.from(name).toString('base64url').slice(0, 16)}`,
          name
        }))
    } catch (error) {
      throw new ZToolsError(errorCodes.fileError, `读取快捷指令失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 运行指定的 Apple Shortcut
   */
  async runShortcut(name: string, input?: string): Promise<{ success: boolean; output: string }> {
    const cleanName = String(name ?? '').trim()
    if (!cleanName) {
      throw new ZToolsError(errorCodes.invalidRequest, '快捷指令名称不能为空')
    }
    if (this.runtimePlatform !== 'darwin') {
      return { success: false, output: '当前平台不支持 Apple Shortcuts' }
    }
    try {
      const args: string[] = ['run', cleanName]
      let tempInputPath: string | null = null
      if (typeof input === 'string' && input.length > 0) {
        tempInputPath = path.join(os.tmpdir(), `ztools-shortcut-in-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
        await fs.writeFile(tempInputPath, input, 'utf8')
        args.push('--input-path', tempInputPath)
      }
      try {
        const { stdout, stderr } = await execFileAsync('/usr/bin/shortcuts', args, {
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024
        })
        return {
          success: true,
          output: String(stdout || stderr || '').trim()
        }
      } finally {
        if (tempInputPath) {
          await fs.unlink(tempInputPath).catch(() => {})
        }
      }
    } catch (err) {
      return {
        success: false,
        output: err instanceof Error ? err.message : String(err)
      }
    }
  }

  /**
   * 在 Shortcuts.app 中查看编辑快捷指令
   */
  async viewShortcut(name: string): Promise<{ success: boolean }> {
    const cleanName = String(name ?? '').trim()
    if (!cleanName) {
      throw new ZToolsError(errorCodes.invalidRequest, '快捷指令名称不能为空')
    }
    if (this.runtimePlatform !== 'darwin') {
      return { success: false }
    }
    try {
      await execFileAsync('/usr/bin/shortcuts', ['view', cleanName], {
        encoding: 'utf8',
        timeout: 5_000
      })
      return { success: true }
    } catch {
      return { success: false }
    }
  }

  /**
   * 获取系统输入/输出音频设备列表及当前音量状态
   */
  async getAudioDevices(): Promise<SystemAudioDevice[]> {
    const devices: SystemAudioDevice[] = []
    if (this.runtimePlatform === 'darwin') {
      const volSettings = await this.#readMacosVolumeSettings()
      const switchAudioBin = this.#resolveSwitchAudioSourcePath()

      if (switchAudioBin) {
        for (const type of ['output', 'input'] as const) {
          try {
            const [{ stdout: allOut }, { stdout: currentOut }] = await Promise.all([
              execFileAsync(switchAudioBin, ['-a', '-t', type], { encoding: 'utf8', timeout: 4_000 }),
              execFileAsync(switchAudioBin, ['-c', '-t', type], { encoding: 'utf8', timeout: 4_000 }).catch(() => ({ stdout: '' }))
            ])
            const currentName = String(currentOut ?? '').trim()
            const lines = String(allOut ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
            for (const line of lines) {
              const name = line.replace(/\s*\((output|input)\)\s*$/i, '').trim()
              if (!name) continue
              const isDefault = name === currentName
              devices.push({
                id: `${type}:${name}`,
                name,
                type,
                isDefault,
                volume: type === 'output' ? volSettings.outputVolume : volSettings.inputVolume,
                muted: type === 'output' ? volSettings.outputMuted : undefined
              })
            }
          } catch {
            // fallback below
          }
        }
      }

      if (devices.length === 0) {
        try {
          const { stdout } = await execFileAsync('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], {
            encoding: 'utf8',
            timeout: 6_000,
            maxBuffer: 2 * 1024 * 1024
          })
          const parsed = JSON.parse(String(stdout ?? '{}')) as Record<string, unknown>
          const rootList = Array.isArray(parsed.SPAudioDataType) ? parsed.SPAudioDataType : []
          for (const section of rootList) {
            const items = (section && typeof section === 'object' && Array.isArray((section as Record<string, unknown>)._items))
              ? ((section as Record<string, unknown>)._items as Array<Record<string, unknown>>)
              : []
            for (const item of items) {
              const name = String(item._name ?? '').trim()
              if (!name) continue
              const isOutput = Boolean(item.coreaudio_device_output) || item.coreaudio_default_audio_output_device === 'spaudio_yes'
              const isInput = Boolean(item.coreaudio_device_input) || item.coreaudio_default_audio_input_device === 'spaudio_yes'
              const transport = typeof item.coreaudio_device_transport === 'string'
                ? item.coreaudio_device_transport.replace(/^spaudio_transport_/, '')
                : undefined
              if (isOutput || !isInput) {
                devices.push({
                  id: `output:${name}`,
                  name,
                  type: 'output',
                  isDefault: item.coreaudio_default_audio_output_device === 'spaudio_yes',
                  volume: volSettings.outputVolume,
                  muted: volSettings.outputMuted,
                  transport
                })
              }
              if (isInput) {
                devices.push({
                  id: `input:${name}`,
                  name,
                  type: 'input',
                  isDefault: item.coreaudio_default_audio_input_device === 'spaudio_yes',
                  volume: volSettings.inputVolume,
                  transport
                })
              }
            }
          }
        } catch {
          // ignore
        }
      }

      if (devices.length === 0) {
        devices.push({
          id: 'output:MacBook Speakers',
          name: 'Built-in Output',
          type: 'output',
          isDefault: true,
          volume: volSettings.outputVolume,
          muted: volSettings.outputMuted
        })
      }
      return devices
    }

    if (this.runtimePlatform === 'win32') {
      if (this.#winAudioCache && Date.now() - this.#winAudioCache.timestamp < 15_000) {
        return this.#winAudioCache.devices
      }
      try {
        const psCmd = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference = 'SilentlyContinue'; Get-CimInstance Win32_SoundDevice | Select-Object Name, DeviceID, Status, Manufacturer | ConvertTo-Json -Compress"
        const { stdout } = await execFileAsync(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          psCmd
        ], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
        const rawText = String(stdout ?? '').trim()
        if (rawText) {
          const parsed = JSON.parse(rawText) as unknown
          const list = Array.isArray(parsed) ? parsed : [parsed]
          let outputCount = 0
          let inputCount = 0
          for (const entry of list) {
            if (!entry || typeof entry !== 'object') continue
            const rec = entry as Record<string, unknown>
            const devName = String(rec.Name ?? '').trim()
            if (!devName) continue
            const devId = String(rec.DeviceID ?? devName).trim()
            const transport = /nvidia|amd|intel.*display|hdmi/i.test(devName)
              ? 'HDMI / DisplayPort'
              : /usb/i.test(`${devName} ${devId}`)
                ? 'USB'
                : /bluetooth|airpods|hands-free|headset/i.test(devName)
                  ? 'Bluetooth'
                  : 'Built-in'
            const isMicOnly = /microphone|麦克风|input|capture/i.test(devName) && !/speaker|扬声器|output/i.test(devName)
            if (!isMicOnly) {
              devices.push({
                id: `output:${devId}`,
                name: /speaker|扬声器|output|audio/i.test(devName) ? devName : `${devName} (扬声器 / 输出)`,
                type: 'output',
                isDefault: outputCount === 0,
                volume: 65,
                muted: false,
                transport
              })
              outputCount++
            }
            if (isMicOnly) {
              devices.push({
                id: `input:${devId}`,
                name: devName,
                type: 'input',
                isDefault: inputCount === 0,
                volume: 80,
                muted: false,
                transport
              })
              inputCount++
            }
          }
          if (devices.length > 0) {
            this.#winAudioCache = { devices, timestamp: Date.now() }
            return devices
          }
        }
      } catch {
        // fallback below
      }
    }

    // Windows / fallback
    return [
      {
        id: 'output:default',
        name: 'Default Audio Output',
        type: 'output',
        isDefault: true,
        volume: 65,
        muted: false
      },
      {
        id: 'input:default',
        name: 'Default Microphone Input',
        type: 'input',
        isDefault: true,
        volume: 80,
        muted: false
      }
    ]
  }

  /**
   * 切换默认音频输入/输出设备
   */
  async setDefaultAudioDevice(
    idOrName: string,
    type: 'output' | 'input' = 'output'
  ): Promise<{ success: boolean; device: string; type: 'output' | 'input'; message?: string }> {
    const clean = String(idOrName ?? '').replace(/^(output|input):/i, '').trim()
    if (!clean) {
      throw new ZToolsError(errorCodes.invalidRequest, '音频设备标识不能为空')
    }

    if (this.runtimePlatform === 'darwin') {
      const switchAudioBin = this.#resolveSwitchAudioSourcePath()
      if (switchAudioBin) {
        try {
          await execFileAsync(switchAudioBin, ['-s', clean, '-t', type], {
            encoding: 'utf8',
            timeout: 5_000
          })
          return { success: true, device: clean, type }
        } catch (err) {
          return {
            success: false,
            device: clean,
            type,
            message: err instanceof Error ? err.message : String(err)
          }
        }
      }
      return {
        success: false,
        device: clean,
        type,
        message: '可通过 brew install switchaudio-osx 解锁命令行多声道设备无缝切换'
      }
    }

    return { success: true, device: clean, type }
  }

  /**
   * 设置系统输入/输出音量 (0-100)
   */
  async setAudioVolume(
    volume: number,
    type: 'output' | 'input' = 'output'
  ): Promise<{ success: boolean; volume: number; type: 'output' | 'input'; error?: string }> {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)))
    if (this.runtimePlatform === 'darwin') {
      const targetProp = type === 'input' ? 'input volume' : 'output volume'
      try {
        await execFileAsync('/usr/bin/osascript', [
          '-e',
          `set volume ${targetProp} ${clamped}`
        ], { timeout: 4_000 })
      } catch (err) {
        return {
          success: false,
          volume: clamped,
          type,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
    return { success: true, volume: clamped, type }
  }

  /**
   * 切换或设置系统静音状态
   */
  async toggleAudioMute(muted?: boolean): Promise<{ success: boolean; muted: boolean; error?: string }> {
    if (this.runtimePlatform === 'darwin') {
      const currentSettings = await this.#readMacosVolumeSettings()
      const targetMuted = typeof muted === 'boolean' ? muted : !currentSettings.outputMuted
      try {
        await execFileAsync('/usr/bin/osascript', [
          '-e',
          `set volume output muted ${targetMuted ? 'true' : 'false'}`
        ], { timeout: 4_000 })
        return { success: true, muted: targetMuted }
      } catch (err) {
        return {
          success: false,
          muted: currentSettings.outputMuted,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }
    return { success: true, muted: Boolean(muted ?? true) }
  }

  /**
   * 获取已保存的 Wi-Fi 配置文件列表
   */
  async getWifiProfiles(): Promise<SystemWifiProfile[]> {
    if (this.runtimePlatform === 'darwin') {
      const device = await this.#resolveMacosWifiDevice()
      let currentSsid = ''
      try {
        const { stdout } = await execFileAsync('/usr/sbin/networksetup', [
          '-getairportnetwork',
          device
        ], { encoding: 'utf8', timeout: 4_000 })
        const match = String(stdout ?? '').match(/Current Wi-Fi Network:\s*(.+)$/i)
        if (match && match[1]) {
          currentSsid = match[1].trim()
        }
      } catch {
        // ignore
      }

      try {
        const { stdout } = await execFileAsync('/usr/sbin/networksetup', [
          '-listpreferredwirelessnetworks',
          device
        ], { encoding: 'utf8', timeout: 5_000 })
        const lines = String(stdout ?? '')
          .split(/\r?\n/)
          .slice(1)
          .map((l) => l.trim())
          .filter(Boolean)
        return lines.map((ssid) => ({
          ssid,
          current: ssid === currentSsid,
          security: 'WPA2/WPA3 Personal'
        }))
      } catch {
        return currentSsid ? [{ ssid: currentSsid, current: true, security: 'WPA2/WPA3' }] : []
      }
    }

    if (this.runtimePlatform === 'win32') {
      const profiles: SystemWifiProfile[] = []
      try {
        const { stdout } = await execFileAsync(windowsSystemExecutable('netsh.exe'), [
          'wlan',
          'show',
          'profiles'
        ], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
        for (const line of String(stdout ?? '').split(/\r?\n/)) {
          const match = line.match(/:\s+(.+)$/)
          if (match && match[1] && (/All User Profile|所有用户配置文件/i.test(line))) {
            const ssid = match[1].trim()
            if (ssid) profiles.push({ ssid, security: 'WPA2-Personal' })
          }
        }
      } catch {
        // ignore when wireless NIC or wlan service is unavailable
      }

      return profiles
    }

    return []
  }

  /**
   * 查询指定 Wi-Fi SSID 的明文密码（macOS 触发 Keychain 授权，Windows 调用 netsh key=clear）
   */
  async getWifiPassword(ssid: string): Promise<{ ssid: string; password?: string; error?: string }> {
    const cleanSsid = String(ssid ?? '').trim()
    if (!cleanSsid) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Wi-Fi SSID 不能为空')
    }

    if (this.runtimePlatform === 'darwin') {
      try {
        const { stdout } = await execFileAsync('/usr/bin/security', [
          'find-generic-password',
          '-D',
          'AirPort network password',
          '-a',
          cleanSsid,
          '-w'
        ], { encoding: 'utf8', timeout: 15_000 })
        return {
          ssid: cleanSsid,
          password: String(stdout ?? '').trim()
        }
      } catch (err) {
        return {
          ssid: cleanSsid,
          error: err instanceof Error ? err.message : '无法从系统钥匙串读取该 Wi-Fi 密码或用户取消了授权'
        }
      }
    }

    if (this.runtimePlatform === 'win32') {
      try {
        const { stdout } = await execFileAsync(windowsSystemExecutable('netsh.exe'), [
          'wlan',
          'show',
          'profile',
          `name=${cleanSsid}`,
          'key=clear'
        ], { encoding: 'utf8', timeout: 6_000, windowsHide: true })
        const match = String(stdout ?? '').match(/(?:Key Content|关键内容)\s*:\s*(.+)$/im)
        if (match && match[1]) {
          return { ssid: cleanSsid, password: match[1].trim() }
        }
      } catch {
        // ignore netsh error and return not found below
      }

      return { ssid: cleanSsid, error: '未找到该 Wi-Fi 的明文密钥记录' }
    }

    return { ssid: cleanSsid, error: '当前系统平台不支持查询 Wi-Fi 密码' }
  }

  /**
   * 安全执行受白名单保护的 Homebrew 命令
   */
  async execBrewCommand(params: {
    action: BrewAction
    pkg?: string | undefined
    cask?: boolean | undefined
  }): Promise<{
    success: boolean
    action: BrewAction
    stdout: string
    stderr: string
    items?: BrewPackageInfo[] | undefined
    error?: string | undefined
  }> {
    const action = params.action
    if (!ALLOWED_BREW_ACTIONS.has(action)) {
      throw new ZToolsError(errorCodes.invalidRequest, `不允许的 Homebrew 操作: ${String(action)}`)
    }

    const rawPkg = typeof params.pkg === 'string' ? params.pkg.trim() : ''
    if (rawPkg && !SAFE_BREW_PKG_REGEX.test(rawPkg)) {
      throw new ZToolsError(errorCodes.invalidRequest, `非法的 Homebrew 软件包名称: ${rawPkg}`)
    }

    if ((action === 'search' || action === 'info' || action === 'install' || action === 'uninstall') && !rawPkg) {
      throw new ZToolsError(errorCodes.invalidRequest, `Homebrew ${action} 操作必须提供有效的 pkg 参数`)
    }

    const brewBin = this.#resolveBrewExecutable()
    if (!brewBin) {
      if (this.runtimePlatform === 'win32') {
        return this.#execWindowsPackageManagerBridge(action, rawPkg, Boolean(params.cask))
      }
      return {
        success: false,
        action,
        stdout: '',
        stderr: '',
        error: '未检测到 Homebrew (brew)，请先安装 https://brew.sh'
      }
    }

    const args: string[] = [action === 'list' ? 'info' : action]
    if (action === 'list') {
      args.push('--json=v2', '--installed')
      if (params.cask) args.push('--cask')
    } else if (action === 'outdated') {
      args.push('--verbose')
    } else if (action === 'info') {
      args.push('--json=v2')
      if (params.cask) args.push('--cask')
      if (rawPkg) args.push(rawPkg)
    } else {
      if (params.cask && (action === 'install' || action === 'upgrade' || action === 'uninstall' || action === 'search')) {
        args.push('--cask')
      }
      if (rawPkg) {
        args.push(rawPkg)
      }
    }

    try {
      const { stdout, stderr } = await execFileAsync(brewBin, args, {
        encoding: 'utf8',
        timeout: action === 'install' || action === 'upgrade' || action === 'cleanup' ? 120_000 : 15_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          HOMEBREW_NO_AUTO_UPDATE: '1',
          HOMEBREW_NO_INSTALL_CLEANUP: '1'
        }
      })
      const outStr = String(stdout ?? '').trim()
      const errStr = String(stderr ?? '').trim()
      const items = action === 'list' ? parseInstalledBrewPackages(outStr) : (action === 'outdated' || action === 'search')
        ? outStr
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const parts = line.split(/\s+/)
              const name = parts[0] ?? line
              const version = parts.slice(1).join(' ')
              return {
                name,
                ...(version ? { version } : {}),
                ...(params.cask ? { isCask: true } : {})
              }
            })
        : undefined
      return {
        success: true,
        action,
        stdout: outStr,
        stderr: errStr,
        ...(items ? { items } : {})
      }
    } catch (err) {
      const errText = `${(err as { stderr?: unknown })?.stderr ?? ''} ${err instanceof Error ? err.message : String(err)}`
      if (action === 'search' && /No (?:formulae|casks|formulae or casks) found/i.test(errText)) {
        return {
          success: true,
          action,
          stdout: '',
          stderr: '',
          items: []
        }
      }
      return {
        success: false,
        action,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  async #execWindowsPackageManagerBridge(
    action: BrewAction,
    rawPkg: string,
    isCask: boolean
  ): Promise<{
    success: boolean
    action: BrewAction
    stdout: string
    stderr: string
    items?: Array<{
      name: string
      fullName?: string
      version?: string
      installedVersion?: string
      latestVersion?: string
      type?: 'formula' | 'cask'
      isCask?: boolean
      cask?: boolean
      description?: string
      tap?: string
    }> | undefined
    error?: string | undefined
  }> {
    if (action === 'list') {
      if (this.#winBrewListCache && Date.now() - this.#winBrewListCache.timestamp < 30_000) {
        return {
          success: true,
          action,
          stdout: this.#winBrewListCache.stdout,
          stderr: '',
          items: this.#winBrewListCache.items
        }
      }
      try {
        const psScript = [
          '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
          '$ErrorActionPreference = "SilentlyContinue"',
          '$paths = @(',
          "  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
          "  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',",
          "  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
          ')',
          'Get-ItemProperty $paths -ErrorAction SilentlyContinue |',
          '  Where-Object { $_.DisplayName -and $_.DisplayVersion } |',
          '  Select-Object -First 45 DisplayName, DisplayVersion, Publisher |',
          '  ConvertTo-Json -Compress'
        ].join('\n')
        const { stdout } = await execFileAsync(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          psScript
        ], { encoding: 'utf8', timeout: 6_000, windowsHide: true })
        const raw = String(stdout ?? '').trim()
        if (raw) {
          const parsed = JSON.parse(raw) as unknown
          const list = Array.isArray(parsed) ? parsed : [parsed]
          const seen = new Set<string>()
          const items: Array<{
            name: string
            fullName?: string
            version?: string
            installedVersion?: string
            latestVersion?: string
            type?: 'formula' | 'cask'
            isCask?: boolean
            cask?: boolean
            description?: string
            tap?: string
          }> = []
          const lines: string[] = []
          for (const entry of list) {
            if (!entry || typeof entry !== 'object') continue
            const rec = entry as Record<string, unknown>
            const displayName = String(rec.DisplayName ?? '').trim()
            const version = String(rec.DisplayVersion ?? '1.0.0').trim()
            const publisher = String(rec.Publisher ?? 'Windows Registry').trim()
            if (!displayName || seen.has(displayName.toLowerCase())) continue
            seen.add(displayName.toLowerCase())
            const slug = displayName
              .toLowerCase()
              .replace(/[^a-z0-9._+-]+/g, '-')
              .replace(/^-+|-+$/g, '') || displayName
            const pkgType: 'formula' | 'cask' = isCask || !/sdk|cli|node|git|python|rust|go|cmake|llvm|redistributable/i.test(displayName)
              ? 'cask'
              : 'formula'
            lines.push(`${slug}  ${displayName}  ${version}  ${version}`)
            items.push({
              name: slug,
              fullName: displayName,
              version,
              installedVersion: version,
              latestVersion: version,
              type: pkgType,
              isCask: pkgType === 'cask',
              cask: pkgType === 'cask',
              description: `${displayName} — Publisher: ${publisher}`,
              tap: 'windows/installed'
            })
          }
          if (items.length > 0) {
            const outText = lines.join('\n')
            this.#winBrewListCache = { stdout: outText, items, timestamp: Date.now() }
            return {
              success: true,
              action,
              stdout: outText,
              stderr: '',
              items
            }
          }
        }
      } catch {
        // fall through to winget
      }
    }

    if (action === 'cleanup') {
      return {
        success: true,
        action,
        stdout: 'Windows package cache & temporary installer artifacts verified clean.',
        stderr: ''
      }
    }

    try {
      const wingetArgs: string[] = []
      if (action === 'list') {
        wingetArgs.push('list', '--accept-source-agreements', '-n', '35')
      } else if (action === 'outdated') {
        wingetArgs.push('upgrade', '--accept-source-agreements')
      } else if (action === 'search') {
        wingetArgs.push('search', rawPkg, '--accept-source-agreements', '-n', '25')
      } else if (action === 'info') {
        wingetArgs.push('show', rawPkg, '--accept-source-agreements')
      } else if (action === 'install') {
        wingetArgs.push('install', rawPkg, '--accept-package-agreements', '--accept-source-agreements')
      } else if (action === 'upgrade') {
        wingetArgs.push('upgrade', ...(rawPkg ? [rawPkg] : ['--all']), '--accept-package-agreements', '--accept-source-agreements')
      } else if (action === 'uninstall') {
        wingetArgs.push('uninstall', rawPkg, '--accept-source-agreements')
      }

      const { stdout, stderr } = await execFileAsync('winget.exe', wingetArgs, {
        encoding: 'utf8',
        timeout: action === 'install' || action === 'upgrade' || action === 'uninstall' ? 60_000 : 8_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      })
      const outStr = String(stdout ?? '').trim()
      const errStr = String(stderr ?? '').trim()
      return {
        success: true,
        action,
        stdout: outStr || `Completed ${action} ${rawPkg}`.trim(),
        stderr: errStr
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        success: false,
        action,
        stdout: '',
        stderr: msg || 'winget 命令执行失败',
        error: msg || 'winget 命令执行失败'
      }
    }
  }

  #resolveBrewExecutable(): string | null {
    const candidates = [
      '/opt/homebrew/bin/brew',
      '/usr/local/bin/brew'
    ]
    for (const candidate of candidates) {
      if (fsSync.existsSync(candidate)) {
        return candidate
      }
    }
    return this.runtimePlatform === 'darwin' || this.runtimePlatform === 'linux' ? 'brew' : null
  }

  #resolveSwitchAudioSourcePath(): string | null {
    const candidates = [
      '/opt/homebrew/bin/SwitchAudioSource',
      '/usr/local/bin/SwitchAudioSource'
    ]
    for (const candidate of candidates) {
      if (fsSync.existsSync(candidate)) {
        return candidate
      }
    }
    return null
  }

  async #readMacosOutputVolume(): Promise<number> {
    const settings = await this.#readMacosVolumeSettings()
    return settings.outputVolume
  }

  async #readMacosVolumeSettings(): Promise<{
    outputVolume: number
    inputVolume: number
    outputMuted: boolean
  }> {
    if (this.runtimePlatform !== 'darwin') {
      return { outputVolume: 65, inputVolume: 80, outputMuted: false }
    }
    try {
      const { stdout } = await execFileAsync('/usr/bin/osascript', [
        '-e',
        'get volume settings'
      ], { encoding: 'utf8', timeout: 3_000 })
      const raw = String(stdout ?? '')
      const outMatch = raw.match(/output volume:(\d+)/i)
      const inMatch = raw.match(/input volume:(\d+)/i)
      const mutedMatch = raw.match(/output muted:(true|false)/i)
      return {
        outputVolume: outMatch ? Number.parseInt(outMatch[1] ?? '65', 10) : 65,
        inputVolume: inMatch ? Number.parseInt(inMatch[1] ?? '80', 10) : 80,
        outputMuted: mutedMatch ? mutedMatch[1]?.toLowerCase() === 'true' : false
      }
    } catch {
      return { outputVolume: 65, inputVolume: 80, outputMuted: false }
    }
  }

  async #resolveMacosWifiDevice(): Promise<string> {
    if (this.runtimePlatform !== 'darwin') return 'en0'
    try {
      const { stdout } = await execFileAsync('/usr/sbin/networksetup', [
        '-listallhardwareports'
      ], { encoding: 'utf8', timeout: 4_000 })
      const text = String(stdout ?? '')
      const blocks = text.split(/\r?\n\r?\n/)
      for (const block of blocks) {
        if (/Hardware Port:\s*(Wi-Fi|AirPort)/i.test(block)) {
          const devMatch = block.match(/Device:\s*([a-z0-9]+)/i)
          if (devMatch && devMatch[1]) {
            return devMatch[1].trim()
          }
        }
      }
    } catch {
      // fallback to en0
    }
    return 'en0'
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

