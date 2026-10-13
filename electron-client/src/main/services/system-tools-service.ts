import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

export interface SystemToolTarget {
  id: string
  name: string
  category: string
  description: string
  iconSource: string
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

const control = system32File('control.exe')
const explorer = system32File('explorer.exe')
const mmc = system32File('mmc.exe')
const systemTools: readonly TargetDefinition[] = [
  {
    id: 'control_panel',
    name: '控制面板',
    category: 'core',
    description: '打开经典控制面板',
    iconSource: 'shell:ControlPanelFolder',
    candidates: [processCandidate('primary', control)]
  },
  {
    id: 'settings',
    name: 'Windows 设置',
    category: 'core',
    description: '打开 Windows 设置主页',
    iconSource: '%SystemRoot%\\ImmersiveControlPanel\\SystemSettings.exe',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:'),
      processCandidate('classic_fallback', control)
    ]
  },
  {
    id: 'this_pc',
    name: '此电脑',
    category: 'core',
    description: '打开此电脑',
    iconSource: 'shell:MyComputerFolder',
    candidates: [processCandidate('primary', explorer, ['shell:MyComputerFolder'])]
  },
  {
    id: 'file_explorer',
    name: '文件资源管理器',
    category: 'core',
    description: '打开文件资源管理器',
    iconSource: '%SystemRoot%\\explorer.exe',
    candidates: [processCandidate('primary', explorer)]
  },
  {
    id: 'powershell',
    name: 'Windows PowerShell',
    category: 'terminal',
    description: '打开 Windows PowerShell',
    iconSource: '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    candidates: [processCandidate('primary', system32File('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoLogo'])]
  },
  {
    id: 'command_prompt',
    name: '命令提示符',
    category: 'terminal',
    description: '打开命令提示符',
    iconSource: '%SystemRoot%\\System32\\cmd.exe',
    candidates: [processCandidate('primary', system32File('cmd.exe'))]
  },
  {
    id: 'windows_terminal',
    name: 'Windows 终端',
    category: 'terminal',
    description: '优先打开 Windows 终端，未安装时回退 PowerShell',
    iconSource: '%LOCALAPPDATA%\\Microsoft\\WindowsApps\\wt.exe',
    candidates: [
      processCandidate('windows_terminal', () => 'wt.exe'),
      processCandidate('powershell_fallback', system32File('WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoLogo'])
    ]
  },
  {
    id: 'registry_editor',
    name: '注册表编辑器',
    category: 'management',
    description: '打开注册表编辑器，Windows 可能请求提升权限',
    iconSource: '%SystemRoot%\\System32\\regedit.exe',
    candidates: [processCandidate('primary', system32File('regedit.exe'))]
  },
  {
    id: 'task_manager',
    name: '任务管理器',
    category: 'management',
    description: '打开任务管理器',
    iconSource: '%SystemRoot%\\System32\\Taskmgr.exe',
    candidates: [processCandidate('primary', system32File('Taskmgr.exe'))]
  },
  {
    id: 'computer_management',
    name: '计算机管理',
    category: 'management',
    description: '打开计算机管理控制台',
    iconSource: '%SystemRoot%\\System32\\compmgmt.msc',
    candidates: [processCandidate('primary', mmc, ['compmgmt.msc'])]
  },
  {
    id: 'device_manager',
    name: '设备管理器',
    category: 'management',
    description: '打开设备管理器',
    iconSource: 'shell:::{74246BFC-4C96-11D0-ABEF-0020AF6B0B7A}',
    candidates: [processCandidate('primary', mmc, ['devmgmt.msc'])]
  },
  {
    id: 'disk_management',
    name: '磁盘管理',
    category: 'management',
    description: '打开磁盘管理',
    iconSource: '%SystemRoot%\\System32\\diskmgmt.msc',
    candidates: [processCandidate('primary', mmc, ['diskmgmt.msc'])]
  },
  {
    id: 'services',
    name: '服务',
    category: 'management',
    description: '打开 Windows 服务管理器',
    iconSource: '%SystemRoot%\\System32\\services.msc',
    candidates: [processCandidate('primary', mmc, ['services.msc'])]
  },
  {
    id: 'event_viewer',
    name: '事件查看器',
    category: 'management',
    description: '打开事件查看器',
    iconSource: '%SystemRoot%\\System32\\eventvwr.msc',
    candidates: [processCandidate('primary', mmc, ['eventvwr.msc'])]
  },
  {
    id: 'task_scheduler',
    name: '任务计划程序',
    category: 'management',
    description: '打开任务计划程序',
    iconSource: '%SystemRoot%\\System32\\taskschd.msc',
    candidates: [processCandidate('primary', mmc, ['taskschd.msc'])]
  },
  {
    id: 'system_information',
    name: '系统信息',
    category: 'management',
    description: '打开系统信息',
    iconSource: '%SystemRoot%\\System32\\msinfo32.exe',
    candidates: [processCandidate('primary', system32File('msinfo32.exe'))]
  },
  {
    id: 'resource_monitor',
    name: '资源监视器',
    category: 'management',
    description: '打开资源监视器',
    iconSource: '%SystemRoot%\\System32\\resmon.exe',
    candidates: [processCandidate('primary', system32File('resmon.exe'))]
  },
  {
    id: 'performance_monitor',
    name: '性能监视器',
    category: 'management',
    description: '打开性能监视器',
    iconSource: '%SystemRoot%\\System32\\perfmon.exe',
    candidates: [processCandidate('primary', system32File('perfmon.exe'))]
  },
  {
    id: 'system_properties',
    name: '系统属性',
    category: 'system',
    description: '打开系统属性',
    iconSource: 'shell:::{BB06C0E4-D293-4F75-8A90-CB05B6477EEE}',
    candidates: [processCandidate('primary', control, ['sysdm.cpl'])]
  },
  {
    id: 'advanced_system_properties',
    name: '高级系统属性',
    category: 'system',
    description: '打开系统属性的高级页',
    iconSource: '%SystemRoot%\\System32\\sysdm.cpl',
    candidates: [processCandidate('primary', control, ['sysdm.cpl,,3'])]
  },
  {
    id: 'environment_variables',
    name: '环境变量',
    category: 'system',
    description: '打开环境变量编辑器',
    iconSource: '%SystemRoot%\\System32\\sysdm.cpl',
    candidates: [processCandidate('primary', system32File('rundll32.exe'), ['sysdm.cpl,EditEnvironmentVariables'])]
  },
  {
    id: 'programs_features',
    name: '程序和功能',
    category: 'system',
    description: '打开经典程序和功能',
    iconSource: 'shell:::{7B81BE6A-CE2B-4676-A29E-EB907A5126C5}',
    candidates: [processCandidate('primary', control, ['appwiz.cpl'])]
  },
  {
    id: 'optional_features',
    name: 'Windows 功能',
    category: 'system',
    description: '打开启用或关闭 Windows 功能',
    iconSource: '%SystemRoot%\\Sysnative\\OptionalFeatures.exe',
    candidates: [processCandidate('primary', sysnativeFile('OptionalFeatures.exe'))]
  },
  {
    id: 'network_connections',
    name: '网络连接',
    category: 'network',
    description: '打开网络适配器连接列表',
    iconSource: 'shell:ConnectionsFolder',
    candidates: [processCandidate('primary', control, ['ncpa.cpl'])]
  },
  {
    id: 'firewall',
    name: 'Windows 防火墙',
    category: 'network',
    description: '打开经典 Windows 防火墙',
    iconSource: 'shell:::{4026492F-2F69-46B8-B9BF-5654FC07E423}',
    candidates: [processCandidate('primary', control, ['firewall.cpl'])]
  },
  {
    id: 'power_options',
    name: '电源选项',
    category: 'hardware',
    description: '打开经典电源选项',
    iconSource: 'shell:::{025A5937-A6BE-4686-A844-36FE4BEC8B6D}',
    candidates: [processCandidate('primary', control, ['powercfg.cpl'])]
  },
  {
    id: 'sound',
    name: '声音',
    category: 'hardware',
    description: '打开经典声音设置',
    iconSource: 'shell:::{F2DDFC82-8F12-4CDD-B7DC-D4FE1425AA4D}',
    candidates: [processCandidate('primary', control, ['mmsys.cpl'])]
  },
  {
    id: 'display',
    name: '显示设置',
    category: 'settings',
    description: '打开显示设置',
    iconSource: '%SystemRoot%\\System32\\desk.cpl',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:display'),
      processCandidate('classic_fallback', control, ['desk.cpl'])
    ]
  },
  {
    id: 'bluetooth',
    name: '蓝牙和设备',
    category: 'settings',
    description: '打开蓝牙和设备设置',
    iconSource: '%SystemRoot%\\ImmersiveControlPanel\\SystemSettings.exe',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:bluetooth'),
      processCandidate('classic_fallback', control, ['/name', 'Microsoft.DevicesAndPrinters'])
    ]
  },
  {
    id: 'printers',
    name: '打印机和扫描仪',
    category: 'settings',
    description: '打开打印机和扫描仪设置',
    iconSource: 'shell:::{A8A91A66-3A7D-4424-8D24-04E180695C7A}',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:printers'),
      processCandidate('classic_fallback', control, ['/name', 'Microsoft.DevicesAndPrinters'])
    ]
  },
  {
    id: 'date_time',
    name: '日期和时间',
    category: 'settings',
    description: '打开日期和时间设置',
    iconSource: 'shell:::{E2E7934B-DCE5-43C4-9576-7FE4F75E7480}',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:dateandtime'),
      processCandidate('classic_fallback', control, ['timedate.cpl'])
    ]
  },
  {
    id: 'region_language',
    name: '区域和语言',
    category: 'settings',
    description: '打开区域和语言设置',
    iconSource: 'shell:::{62D8ED13-C9D0-4CE8-A914-47DD628FB1B0}',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:regionlanguage'),
      processCandidate('classic_fallback', control, ['intl.cpl'])
    ]
  },
  {
    id: 'user_accounts',
    name: '用户账户',
    category: 'settings',
    description: '打开账户信息设置',
    iconSource: 'shell:::{60632754-C523-4B62-B45C-4172DA012619}',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:yourinfo'),
      processCandidate('classic_fallback', control, ['/name', 'Microsoft.UserAccounts'])
    ]
  },
  {
    id: 'apps',
    name: '应用和功能',
    category: 'settings',
    description: '打开已安装应用设置',
    iconSource: 'shell:::{7B81BE6A-CE2B-4676-A29E-EB907A5126C5}',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:appsfeatures'),
      processCandidate('classic_fallback', control, ['appwiz.cpl'])
    ]
  },
  {
    id: 'default_apps',
    name: '默认应用',
    category: 'settings',
    description: '打开默认应用设置',
    iconSource: 'shell:::{17CD9488-1228-4B2F-88CE-4298E93E0966}',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:defaultapps'),
      processCandidate('classic_fallback', control, ['/name', 'Microsoft.DefaultPrograms'])
    ]
  },
  {
    id: 'windows_update',
    name: 'Windows 更新',
    category: 'settings',
    description: '打开 Windows 更新',
    iconSource: '%SystemRoot%\\ImmersiveControlPanel\\SystemSettings.exe',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:windowsupdate'),
      processCandidate('classic_fallback', control, ['/name', 'Microsoft.WindowsUpdate'])
    ]
  },
  {
    id: 'windows_security',
    name: 'Windows 安全中心',
    category: 'settings',
    description: '打开 Windows 安全中心设置',
    iconSource: '%SystemRoot%\\Sysnative\\SecurityHealthSystray.exe',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:windowsdefender'),
      externalCandidate('classic_fallback', 'windowsdefender:')
    ]
  },
  {
    id: 'notifications',
    name: '通知',
    category: 'settings',
    description: '打开通知设置',
    iconSource: '%SystemRoot%\\ImmersiveControlPanel\\SystemSettings.exe',
    candidates: [externalCandidate('settings_uri', 'ms-settings:notifications')]
  },
  {
    id: 'storage',
    name: '存储',
    category: 'settings',
    description: '打开存储设置',
    iconSource: '%SystemRoot%\\ImmersiveControlPanel\\SystemSettings.exe',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:storagesense'),
      processCandidate('classic_fallback', explorer, ['shell:MyComputerFolder'])
    ]
  },
  {
    id: 'troubleshoot',
    name: '疑难解答',
    category: 'settings',
    description: '打开疑难解答设置',
    iconSource: 'shell:::{C58C4893-3BE0-4B45-ABB5-A63E4B8C8651}',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:troubleshoot'),
      processCandidate('classic_fallback', control, ['/name', 'Microsoft.Troubleshooting'])
    ]
  },
  {
    id: 'remote_desktop',
    name: '远程桌面',
    category: 'settings',
    description: '打开远程桌面设置',
    iconSource: '%SystemRoot%\\System32\\mstsc.exe',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:remotedesktop'),
      processCandidate('classic_fallback', control, ['sysdm.cpl,,5'])
    ]
  },
  {
    id: 'recovery',
    name: '恢复',
    category: 'settings',
    description: '打开系统恢复设置',
    iconSource: 'shell:::{9FE63AFD-59CF-4419-9775-ABCC3849F861}',
    candidates: [
      externalCandidate('settings_uri', 'ms-settings:recovery'),
      processCandidate('classic_fallback', control, ['/name', 'Microsoft.Recovery'])
    ]
  }
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
        child.once('error', (error) => finish(error instanceof Error ? error.message : '启动失败'))
        child.once('spawn', () => {
          child.unref()
          finish('')
        })
      } catch (error) {
        finish(error instanceof Error ? error.message : '启动失败')
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
    return {
      success: true,
      os,
      targets: this.platform === 'win32'
        ? systemTools.map(({ id, name, category, description, iconSource }) => ({
          id,
          name,
          category,
          description,
          iconSource
        }))
        : []
    }
  }

  async openTarget(targetId: string): Promise<SystemToolsOpenResult> {
    if (this.platform !== 'win32') throw new Error('系统工具仅支持 Windows')
    const target = systemToolMap.get(targetId)
    if (!target) throw new Error('未知系统工具')
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
        lastError = error instanceof Error ? error.message : '启动失败'
      }
    }
    throw new Error(lastError || 'Windows 无法打开该系统工具')
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
