import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { getResolvedLocale, SUPPORTED_LOCALES, t } from '../i18n/index.js'
import { SYSTEM_TOOLS_ZH_META } from './system-tools.zh-data.js'

export interface SystemToolTarget {
  id: string
  name: string
  category: string
  description: string
  iconSource: string
  altNames?: string[]
}

export interface SystemToolsListResult {
  success: true
  os: {
    major: number
    minor: number
    build: number
    isWindows11: boolean
  }
  targets: SystemToolTarget[]
}

export interface SystemToolsOpenResult {
  success: true
  target: string
  launcher: string
  osBuild: number
}

export interface SystemToolsProvider {
  listTargets(): Promise<SystemToolsListResult>
  openTarget(targetId: string): Promise<SystemToolsOpenResult>
  getIcon?(targetId: string): Promise<string>
}

export interface SystemToolsLauncher {
  openExternal(url: string): Promise<void>
  launchProcess(file: string, args: readonly string[]): Promise<string>
}

export interface SystemToolsIconReader {
  (source: string): Promise<string>
}

type FileResolver = (systemRoot: string) => string

interface ProcessCandidate {
  kind: 'process'
  launcher: string
  file: FileResolver
  args: readonly string[]
}

interface ExternalCandidate {
  kind: 'external'
  launcher: string
  url: string
}

type LaunchCandidate = ProcessCandidate | ExternalCandidate

interface TargetDefinition extends SystemToolTarget {
  candidates: readonly LaunchCandidate[]
}

function system32File(relativePath: string): FileResolver {
  const segments = relativePath.split('\\')
  return (systemRoot) => path.join(systemRoot, 'System32', ...segments)
}

function sysnativeFile(relativePath: string): FileResolver {
  const segments = relativePath.split('\\')
  return (systemRoot) => path.join(systemRoot, 'Sysnative', ...segments)
}

function processCandidate(
  launcher: string,
  file: FileResolver,
  args: readonly string[] = []
): ProcessCandidate {
  return { kind: 'process', launcher, file, args }
}

function externalCandidate(launcher: string, url: string): ExternalCandidate {
  return { kind: 'external', launcher, url }
}

function createTarget(
  id: string,
  category: string,
  iconSource: string,
  candidates: readonly LaunchCandidate[]
): TargetDefinition {
  const meta = SYSTEM_TOOLS_ZH_META[id]
  return {
    id,
    name: meta?.name ?? id,
    category,
    description: meta?.description ?? '',
    iconSource,
    candidates
  }
}

const control = system32File('control.exe')
const explorer = system32File('explorer.exe')
const mmc = system32File('mmc.exe')
const systemTools: readonly TargetDefinition[] = [
  createTarget('control_panel', 'core', 'shell:ControlPanelFolder', [processCandidate('primary', control)]),
  createTarget('settings', 'core', '%SystemRoot%\\ImmersiveControlPanel\\SystemSettings.exe', [
    externalCandidate('settings_uri', 'ms-settings:'),
    processCandidate('classic_fallback', control)
  ]),
  createTarget('this_pc', 'core', 'shell:MyComputerFolder', [
    processCandidate('primary', explorer, ['shell:MyComputerFolder'])
  ]),
  createTarget('file_explorer', 'core', '%SystemRoot%\\explorer.exe', [processCandidate('primary', explorer)]),
  createTarget('powershell', 'terminal', '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
    processCandidate('primary', system32File('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoLogo'])
  ]),
  createTarget('command_prompt', 'terminal', '%SystemRoot%\\System32\\cmd.exe', [
    processCandidate('primary', system32File('cmd.exe'))
  ]),
  createTarget('windows_terminal', 'terminal', '%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe', [
    processCandidate('windows_terminal', () => 'wt.exe'),
    processCandidate('powershell_fallback', system32File('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoLogo'])
  ]),
  createTarget('registry_editor', 'management', '%SystemRoot%\\System32\\regedit.exe', [
    processCandidate('primary', system32File('regedit.exe'))
  ]),
  createTarget('task_manager', 'management', '%SystemRoot%\\System32\\Taskmgr.exe', [
    processCandidate('primary', system32File('Taskmgr.exe'))
  ]),
  createTarget('computer_management', 'management', '%SystemRoot%\\System32\\compmgmt.msc', [
    processCandidate('primary', mmc, ['compmgmt.msc'])
  ]),
  createTarget('device_manager', 'management', 'shell:::{74246BFC-4C96-11D0-ABEF-0020AF6B0B7A}', [
    processCandidate('primary', mmc, ['devmgmt.msc'])
  ]),
  createTarget('disk_management', 'management', '%SystemRoot%\\System32\\diskmgmt.msc', [
    processCandidate('primary', mmc, ['diskmgmt.msc'])
  ]),
  createTarget('services', 'management', '%SystemRoot%\\System32\\services.msc', [
    processCandidate('primary', mmc, ['services.msc'])
  ]),
  createTarget('event_viewer', 'management', '%SystemRoot%\\System32\\eventvwr.msc', [
    processCandidate('primary', mmc, ['eventvwr.msc'])
  ]),
  createTarget('task_scheduler', 'management', '%SystemRoot%\\System32\\taskschd.msc', [
    processCandidate('primary', mmc, ['taskschd.msc'])
  ]),
  createTarget('system_information', 'management', '%SystemRoot%\\System32\\msinfo32.exe', [
    processCandidate('primary', system32File('msinfo32.exe'))
  ]),
  createTarget('resource_monitor', 'management', '%SystemRoot%\\System32\\resmon.exe', [
    processCandidate('primary', system32File('resmon.exe'))
  ]),
  createTarget('performance_monitor', 'management', '%SystemRoot%\\System32\\perfmon.exe', [
    processCandidate('primary', system32File('perfmon.exe'))
  ]),
  createTarget('system_properties', 'system', 'shell:::{BB06C0E4-D293-4F75-8A90-CB05B6477EEE}', [
    processCandidate('primary', control, ['sysdm.cpl'])
  ]),
  createTarget('advanced_system_properties', 'system', '%SystemRoot%\\System32\\sysdm.cpl', [
    processCandidate('primary', control, ['sysdm.cpl,,3'])
  ]),
  createTarget('environment_variables', 'system', '%SystemRoot%\\System32\\sysdm.cpl', [
    processCandidate('primary', system32File('rundll32.exe'), ['sysdm.cpl,EditEnvironmentVariables'])
  ]),
  createTarget('programs_features', 'system', 'shell:::{7B81BE6A-CE2B-4676-A29E-EB907A5126C5}', [
    processCandidate('primary', control, ['appwiz.cpl'])
  ]),
  createTarget('optional_features', 'system', '%SystemRoot%\\Sysnative\\OptionalFeatures.exe', [
    processCandidate('primary', sysnativeFile('OptionalFeatures.exe'))
  ]),
  createTarget('network_connections', 'network', 'shell:ConnectionsFolder', [
    processCandidate('primary', control, ['ncpa.cpl'])
  ]),
  createTarget('firewall', 'network', 'shell:::{4026492F-2F69-46B8-B9BF-5654FC07E423}', [
    processCandidate('primary', control, ['firewall.cpl'])
  ]),
  createTarget('power_options', 'hardware', 'shell:::{025A5937-A6BE-4686-A844-36FE4BEC8B6D}', [
    processCandidate('primary', control, ['powercfg.cpl'])
  ]),
  createTarget('sound', 'hardware', 'shell:::{F2DDFC82-8F12-4CDD-B7DC-D4FE1425AA4D}', [
    processCandidate('primary', control, ['mmsys.cpl'])
  ]),
  createTarget('display', 'settings', '%SystemRoot%\\System32\\desk.cpl', [
    externalCandidate('settings_uri', 'ms-settings:display'),
    processCandidate('classic_fallback', control, ['desk.cpl'])
  ]),
  createTarget('bluetooth', 'settings', '%SystemRoot%\\ImmersiveControlPanel\\SystemSettings.exe', [
    externalCandidate('settings_uri', 'ms-settings:bluetooth'),
    processCandidate('classic_fallback', control, ['/name', 'Microsoft.DevicesAndPrinters'])
  ]),
  createTarget('printers', 'settings', 'shell:::{A8A91A66-3A7D-4424-8D24-04E180695C7A}', [
    externalCandidate('settings_uri', 'ms-settings:printers'),
    processCandidate('classic_fallback', control, ['/name', 'Microsoft.DevicesAndPrinters'])
  ]),
  createTarget('date_time', 'settings', 'shell:::{E2E7934B-DCE5-43C4-9576-7FE4F75E7480}', [
    externalCandidate('settings_uri', 'ms-settings:dateandtime'),
    processCandidate('classic_fallback', control, ['timedate.cpl'])
  ]),
  createTarget('region_language', 'settings', 'shell:::{62D8ED13-C9D0-4CE8-A914-47DD628FB1B0}', [
    externalCandidate('settings_uri', 'ms-settings:regionlanguage'),
    processCandidate('classic_fallback', control, ['intl.cpl'])
  ]),
  createTarget('user_accounts', 'settings', 'shell:::{60632754-C523-4B62-B45C-4172DA012619}', [
    externalCandidate('settings_uri', 'ms-settings:yourinfo'),
    processCandidate('classic_fallback', control, ['/name', 'Microsoft.UserAccounts'])
  ]),
  createTarget('apps', 'settings', 'shell:::{7B81BE6A-CE2B-4676-A29E-EB907A5126C5}', [
    externalCandidate('settings_uri', 'ms-settings:appsfeatures'),
    processCandidate('classic_fallback', control, ['appwiz.cpl'])
  ]),
  createTarget('default_apps', 'settings', 'shell:::{17CD9488-1228-4B2F-88CE-4298E93E0966}', [
    externalCandidate('settings_uri', 'ms-settings:defaultapps'),
    processCandidate('classic_fallback', control, ['/name', 'Microsoft.DefaultPrograms'])
  ]),
  createTarget('windows_update', 'settings', '%SystemRoot%\\ImmersiveControlPanel\\SystemSettings.exe', [
    externalCandidate('settings_uri', 'ms-settings:windowsupdate'),
    processCandidate('classic_fallback', control, ['/name', 'Microsoft.WindowsUpdate'])
  ]),
  createTarget('windows_security', 'settings', '%SystemRoot%\\Sysnative\\SecurityHealthSystray.exe', [
    externalCandidate('settings_uri', 'ms-settings:windowsdefender'),
    externalCandidate('classic_fallback', 'windowsdefender:')
  ]),
  createTarget('notifications', 'settings', '%SystemRoot%\\ImmersiveControlPanel\\SystemSettings.exe', [
    externalCandidate('settings_uri', 'ms-settings:notifications')
  ]),
  createTarget('storage', 'settings', '%SystemRoot%\\ImmersiveControlPanel\\SystemSettings.exe', [
    externalCandidate('settings_uri', 'ms-settings:storagesense'),
    processCandidate('classic_fallback', explorer, ['shell:MyComputerFolder'])
  ]),
  createTarget('troubleshoot', 'settings', 'shell:::{C58C4893-3BE0-4B45-ABB5-A63E4B8C8651}', [
    externalCandidate('settings_uri', 'ms-settings:troubleshoot'),
    processCandidate('classic_fallback', control, ['/name', 'Microsoft.Troubleshooting'])
  ]),
  createTarget('remote_desktop', 'settings', '%SystemRoot%\\System32\\mstsc.exe', [
    externalCandidate('settings_uri', 'ms-settings:remotedesktop'),
    processCandidate('classic_fallback', control, ['sysdm.cpl,,5'])
  ]),
  createTarget('recovery', 'settings', 'shell:::{9FE63AFD-59CF-4419-9775-ABCC3849F861}', [
    externalCandidate('settings_uri', 'ms-settings:recovery'),
    processCandidate('classic_fallback', control, ['/name', 'Microsoft.Recovery'])
  ])
]

const systemToolMap = new Map(systemTools.map((target) => [target.id, target]))

function osInformation(platform: NodeJS.Platform): SystemToolsListResult['os'] {
  if (platform !== 'win32') return { major: 0, minor: 0, build: 0, isWindows11: false }
  const parts = os.release().split('.').map((value) => Number.parseInt(value, 10))
  const majorValue = parts[0] ?? 0
  const minorValue = parts[1] ?? 0
  const buildValue = parts[2] ?? 0
  const major = Number.isSafeInteger(majorValue) ? majorValue : 0
  const minor = Number.isSafeInteger(minorValue) ? minorValue : 0
  const build = Number.isSafeInteger(buildValue) ? buildValue : 0
  return { major, minor, build, isWindows11: build >= 22000 }
}

function defaultSystemRoot(): string {
  return process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows'
}

function expandIconSource(source: string): string {
  return source
    .replaceAll('%SystemRoot%', defaultSystemRoot())
    .replaceAll('%WINDIR%', process.env.WINDIR || defaultSystemRoot())
    .replaceAll('%LOCALAPPDATA%', process.env.LOCALAPPDATA || '')
}

function defaultIconReader(source: string): Promise<string> {
  return app.getFileIcon(expandIconSource(source), { size: 'large' }).then((image) => image.toDataURL())
}

function extractLaunchErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const detail = error.message.trim()
    if (detail) return detail
  }
  return t('systemTools.error.launchFailed')
}

function defaultLauncher(): SystemToolsLauncher {
  return {
    openExternal: (url) => shell.openExternal(url),
    launchProcess: (file, args) => new Promise((resolve) => {
      let settled = false
      const finish = (message: string) => {
        if (settled) return
        settled = true
        resolve(message)
      }
      try {
        const child = spawn(file, [...args], {
          detached: true,
          shell: false,
          stdio: 'ignore',
          windowsHide: true
        })
        child.once('error', (error) => finish(extractLaunchErrorMessage(error)))
        child.once('spawn', () => {
          child.unref()
          finish('')
        })
      } catch (error) {
        finish(extractLaunchErrorMessage(error))
      }
    })
  }
}

export class SystemToolsService implements SystemToolsProvider {
  private readonly launcher: SystemToolsLauncher
  private readonly platform: NodeJS.Platform
  private readonly readIcon: SystemToolsIconReader
  private readonly iconCache = new Map<string, Promise<string>>()

  constructor(
    launcher: SystemToolsLauncher = defaultLauncher(),
    platform: NodeJS.Platform = process.platform,
    readIcon: SystemToolsIconReader = defaultIconReader
  ) {
    this.launcher = launcher
    this.platform = platform
    this.readIcon = readIcon
  }

  async listTargets(): Promise<SystemToolsListResult> {
    const os = osInformation(this.platform)
    const currentLocale = getResolvedLocale()
    const alternateLocales = SUPPORTED_LOCALES.filter((locale) => locale !== currentLocale)
    return {
      success: true,
      os,
      targets: this.platform === 'win32'
        ? systemTools.map(({ id, category, iconSource }) => {
          const name = t(`systemTools.${id}.name`, undefined, currentLocale)
          const description = t(`systemTools.${id}.description`, undefined, currentLocale)
          const altNames = alternateLocales
            .map((locale) => t(`systemTools.${id}.name`, undefined, locale))
            .filter((alt, index, list) => alt !== name && list.indexOf(alt) === index)
          return {
            id,
            name,
            category,
            description,
            iconSource,
            ...(altNames.length > 0 ? { altNames } : {})
          }
        })
        : []
    }
  }

  async openTarget(targetId: string): Promise<SystemToolsOpenResult> {
    if (this.platform !== 'win32') throw new Error(t('systemTools.error.windowsOnly'))
    const target = systemToolMap.get(targetId)
    if (!target) throw new Error(t('systemTools.error.unknownTarget'))
    const systemRoot = defaultSystemRoot()
    const osBuild = osInformation(this.platform).build
    let lastError = ''
    for (const candidate of target.candidates) {
      try {
        if (candidate.kind === 'external') {
          await this.launcher.openExternal(candidate.url)
          return { success: true, target: target.id, launcher: candidate.launcher, osBuild }
        }
        const error = await this.launcher.launchProcess(
          candidate.file(systemRoot),
          candidate.args
        )
        if (!error) return { success: true, target: target.id, launcher: candidate.launcher, osBuild }
        lastError = error
      } catch (error) {
        lastError = extractLaunchErrorMessage(error)
      }
    }
    throw new Error(lastError || t('systemTools.error.openFailed'))
  }

  async getIcon(targetId: string): Promise<string> {
    if (this.platform !== 'win32') return ''
    const target = systemToolMap.get(targetId)
    if (!target) return ''
    const cached = this.iconCache.get(target.id)
    if (cached) return cached
    const pending = this.readIcon(target.iconSource).catch(() => '')
    this.iconCache.set(target.id, pending)
    return pending
  }
}
