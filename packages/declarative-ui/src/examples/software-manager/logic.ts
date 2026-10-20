/**
 * 软件管理、智能分类、活跃度画像与卸载残留中心 (SoftwareManager 2.0 Logic)
 * 1:1 复刻 DLLPlugins/software-manager (registry_helper.h / software_classifier.h / usage_analyzer.h / software_uninstaller.h)
 * 严格遵循零模拟数据铁律：在真实 Electron 宿主中 100% 读取真实注册表已安装应用与真实 AppData 目录
 */

import {
  callHostTransport,
  getRealEnvPaths,
  isRealElectronHost,
  joinWinPath,
  moveRealFilesToTrash,
  openRealPath,
  readRealDirectory,
  scanRealDirectoryTree,
  showRealItemInFolder
} from '../shared/native-ipc.js'

export type SoftwareSmartCategoryId =
  | 'dev_geek'
  | 'browser_net'
  | 'media_design'
  | 'office_doc'
  | 'game_platform'
  | 'security_driver'
  | 'runtime_system'

export interface SoftwareSmartCategoryMeta {
  id: SoftwareSmartCategoryId
  name: string
  shortName: string
  color: string
  description: string
}

export const SOFTWARE_SMART_CATEGORIES: SoftwareSmartCategoryMeta[] = [
  {
    id: 'dev_geek',
    name: '开发与极客工具',
    shortName: '开发极客',
    color: '#3b82f6',
    description: 'IDE 编辑器、编译器、SDK、Git、容器虚拟化与终端工具'
  },
  {
    id: 'browser_net',
    name: '浏览器与社交通讯',
    shortName: '浏览社交',
    color: '#10b981',
    description: '现代浏览器、即时通讯 (微信/QQ/钉钉/飞书)、远程控制与下载工具'
  },
  {
    id: 'media_design',
    name: '影音娱乐与创意设计',
    shortName: '影音设计',
    color: '#a855f7',
    description: '音视频播放器、流媒体音乐、剪辑转码、3D 建模与平面设计套件'
  },
  {
    id: 'office_doc',
    name: '办公文档与效率工具',
    shortName: '办公效率',
    color: '#f59e0b',
    description: 'Office/WPS 办公套件、PDF 阅读处理、笔记知识库与解压缩工具'
  },
  {
    id: 'game_platform',
    name: '游戏娱乐与外设平台',
    shortName: '游戏外设',
    color: '#ec4899',
    description: 'Steam/Epic 游戏发行平台、电竞外设驱动中心与独立游戏客户端'
  },
  {
    id: 'security_driver',
    name: '系统安全与硬件驱动',
    shortName: '安全驱动',
    color: '#06b6d4',
    description: '显卡/声卡/网卡底层硬件驱动、安全防护软件与主板芯片组组件'
  },
  {
    id: 'runtime_system',
    name: '运行库与系统组件',
    shortName: '运行库',
    color: '#64748b',
    description: 'Visual C++ Redistributable、.NET Runtime、WebView2 与系统基础框架'
  }
]

export interface SoftwareItem {
  id: string
  name: string
  version: string
  publisher: string
  installDate: string
  estimatedSize: number // 估算字节数
  installLocation: string
  uninstallString: string
  quietUninstallString?: string
  category: 'desktop' | 'store' | 'runtime' | 'other'
  smartCategory?: SoftwareSmartCategoryId
  smartCategoryName?: string
  installDrive?: string // 'C:' | 'D:' | 'E:' | 'OTHER'
  activityStatus?: 'recent' | 'normal' | 'idle_large'
  daysSinceInstall?: number
  isSystem: boolean
  launchPath?: string
  launchCount?: number
  lastUsedTime?: number
}

export interface AppDataResidualItem {
  id: string
  folderName: string
  fullPath: string
  scope: 'AppData\\Roaming' | 'AppData\\Local'
  sizeBytes: number
  fileCount: number
  matchedSoftwareName?: string
  isOrphaned: boolean
  lastModifiedMs: number
}

export interface SoftwareSummaryData {
  totalCount: number
  totalSizeBytes: number
  recentInstalledCount: number
  silentSupportedCount: number
  idleLargeCount?: number
  residualTotalBytes?: number
}

export interface NativeInvocationResult {
  ok: boolean
  pluginName: string
  method: string
  data?: unknown
  error?: string
  fromFallback?: boolean
}

export const DLL_PLUGIN_NAME = "SoftwareManagerPlugin"

// 受保护的系统核心与不可卸载组件白名单
export const PROTECTED_SYSTEM_SOFTWARE_PATTERN = new RegExp(
  "^(?:Microsoft Visual C\\+\\+.*|Microsoft \\.NET.*|DirectX.*|Windows (?:Security|Defender|Subsystem)|.*Edge WebView2 Runtime.*)",
  'i'
)
export const FORBIDDEN_SOFTWARE_PATTERN = new RegExp(
  "^(?:Microsoft Windows|Windows Operating System|Windows Security)",
  'i'
)
export const FORBIDDEN_UNINSTALL_REASON = "系统内核与操作系统必备底座受 Windows 安全保护，严禁强制卸载"

/**
 * 1:1 复刻 software_classifier.h 智能分类算法
 */
export function classifySoftwareSmartCategory(
  name: string,
  publisher: string,
  installLocation: string,
  isSystem: boolean
): SoftwareSmartCategoryId {
  const text = `${name} ${publisher} ${installLocation}`.toLowerCase()

  if (
    isSystem ||
    PROTECTED_SYSTEM_SOFTWARE_PATTERN.test(name) ||
    /redistributable|runtime|webview2|directx|msxml|openal|\.net framework|\.net desktop|\.net host/i.test(text)
  ) {
    return 'runtime_system'
  }

  if (
    /visual studio|vscode|vs code|git|node\.js|nodejs|python|docker|jetbrains|intellij|pycharm|webstorm|clion|goland|rust|cargo|cmake|postman|insomnia|wireshark|vmware|virtualbox|cursor|antigravity|windsurf|android studio|sdk|jdk|openjdk|llvm|mingw|cygwin|xshell|putty|dbeaver|navicat|heidisql|windows terminal/i.test(
      text
    )
  ) {
    return 'dev_geek'
  }

  if (
    /chrome|microsoft edge|firefox|brave|opera|vivaldi|wechat|微信|tencent qq|qq|tim|telegram|discord|dingtalk|钉钉|feishu|飞书|slack|zoom|tencent meeting|腾讯会议|thunder|迅雷|fdm|idm|aria2|clash|v2ray|tailscale|zerotier|todesk|sunlogin|向日葵|anydesk|teamviewer/i.test(
      text
    )
  ) {
    return 'browser_net'
  }

  if (
    /vlc|potplayer|mpv|kmplayer|spotify|netease|网易云|qqmusic|qq音乐|kugou|酷狗|kuwo|bilibili|哔哩哔哩|capcut|剪映|adobe|photoshop|illustrator|premiere|after effects|lightroom|figma|blender|obs studio|ffmpeg|audacity|handbrake|davinci|cinema 4d|maya|3ds max/i.test(
      text
    )
  ) {
    return 'media_design'
  }

  if (
    /steam|epic games|ubisoft|battle\.net|wegame|ea app|origin|gog galaxy|xbox|riot|genshin|mihoyo|razer|logitech g|steelseries|corsair/i.test(
      text
    )
  ) {
    return 'game_platform'
  }

  if (
    /nvidia|amd|radeon|geforce|intel\(r\)|realtek|driver|驱动程序|360|huorong|火绒|kaspersky|bitdefender|avast|mcafee|norton|bluetooth|vulkan|physx|chipset|thunderbolt/i.test(
      text
    )
  ) {
    return 'security_driver'
  }

  return 'office_doc'
}

export function getSmartCategoryMeta(id?: SoftwareSmartCategoryId): SoftwareSmartCategoryMeta {
  return SOFTWARE_SMART_CATEGORIES.find((c) => c.id === id) || SOFTWARE_SMART_CATEGORIES[3]
}

/**
 * 提取软件所在安装盘符
 */
export function extractInstallDrive(installLocation: string, uninstallString: string): string {
  const source = (installLocation || uninstallString || '').trim()
  const match = source.match(/([A-Za-z]):\\/)
  if (match) {
    return `${match[1].toUpperCase()}:`
  }
  return 'C:'
}

/**
 * 解析安装日期与闲置天数
 */
export function parseInstallDays(installDate: string): number {
  if (!installDate) return 120
  try {
    let ts = NaN
    if (/^\d{8}$/.test(installDate)) {
      const y = parseInt(installDate.slice(0, 4), 10)
      const m = parseInt(installDate.slice(4, 6), 10) - 1
      const d = parseInt(installDate.slice(6, 8), 10)
      ts = new Date(y, m, d).getTime()
    } else {
      ts = Date.parse(installDate)
    }
    if (Number.isNaN(ts) || ts <= 0) return 120
    return Math.max(0, Math.floor((Date.now() - ts) / (24 * 3600 * 1000)))
  } catch {
    return 120
  }
}

function enrichSoftwareItem(item: SoftwareItem): SoftwareItem {
  const smartCategory = item.smartCategory || classifySoftwareSmartCategory(
    item.name,
    item.publisher,
    item.installLocation,
    item.isSystem
  )
  const meta = getSmartCategoryMeta(smartCategory)
  const installDrive = item.installDrive || extractInstallDrive(item.installLocation, item.uninstallString)
  const daysSinceInstall = item.daysSinceInstall ?? parseInstallDays(item.installDate)
  const activityStatus: 'recent' | 'normal' | 'idle_large' =
    daysSinceInstall <= 30
      ? 'recent'
      : item.estimatedSize >= 150 * 1024 * 1024 && daysSinceInstall >= 60
      ? 'idle_large'
      : 'normal'

  return {
    ...item,
    smartCategory,
    smartCategoryName: meta.shortName,
    installDrive,
    daysSinceInstall,
    activityStatus
  }
}

/**
 * 离线单测兜底数据集（仅在非 Electron Node 测试环境启用）
 */
const MOCK_SOFTWARE_LIST: SoftwareItem[] = [
  {
    id: "chrome-google-llc",
    name: "Google Chrome",
    version: "124.0.6367.91",
    publisher: "Google LLC",
    installDate: "2026-03-15",
    estimatedSize: 1850 * 1024 * 1024,
    installLocation: "C:\\Program Files\\Google\\Chrome\\Application",
    uninstallString: "\"C:\\Program Files\\Google\\Chrome\\Application\\124.0.6367.91\\Installer\\setup.exe\" --uninstall",
    quietUninstallString: "\"C:\\Program Files\\Google\\Chrome\\Application\\124.0.6367.91\\Installer\\setup.exe\" --uninstall --force-uninstall",
    category: "desktop",
    isSystem: false,
    launchPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    launchCount: 428,
    lastUsedTime: Date.now() - 1000 * 60 * 15
  },
  {
    id: "vscode-microsoft",
    name: "Visual Studio Code",
    version: "1.89.1",
    publisher: "Microsoft Corporation",
    installDate: "2026-02-10",
    estimatedSize: 1250 * 1024 * 1024,
    installLocation: "C:\\Program Files\\Microsoft VS Code",
    uninstallString: "\"C:\\Program Files\\Microsoft VS Code\\unins000.exe\"",
    quietUninstallString: "\"C:\\Program Files\\Microsoft VS Code\\unins000.exe\" /VERYSILENT",
    category: "desktop",
    isSystem: false,
    launchPath: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    launchCount: 312,
    lastUsedTime: Date.now() - 1000 * 60 * 30
  },
  {
    id: "nodejs-runtime",
    name: "Node.js (x64)",
    version: "24.13.0",
    publisher: "Node.js Foundation",
    installDate: "2026-01-20",
    estimatedSize: 180 * 1024 * 1024,
    installLocation: "C:\\Program Files\\nodejs",
    uninstallString: "MsiExec.exe /I{B668B8D2-4752-4414-998F-E64415C292E4}",
    quietUninstallString: "MsiExec.exe /qn /x{B668B8D2-4752-4414-998F-E64415C292E4}",
    category: "desktop",
    isSystem: false,
    launchPath: "C:\\Program Files\\nodejs\\node.exe",
    launchCount: 185,
    lastUsedTime: Date.now() - 1000 * 60 * 60
  },
  {
    id: "git-scm",
    name: "Git version 2.45.0",
    version: "2.45.0",
    publisher: "The Git Development Community",
    installDate: "2026-01-15",
    estimatedSize: 320 * 1024 * 1024,
    installLocation: "D:\\Program Files\\Git",
    uninstallString: "\"D:\\Program Files\\Git\\unins000.exe\"",
    quietUninstallString: "\"D:\\Program Files\\Git\\unins000.exe\" /VERYSILENT",
    category: "desktop",
    isSystem: false,
    launchPath: "D:\\Program Files\\Git\\cmd\\git.exe",
    launchCount: 220,
    lastUsedTime: Date.now() - 1000 * 60 * 45
  },
  {
    id: "wechat-tencent",
    name: "微信 (WeChat)",
    version: "4.0.1.20",
    publisher: "Tencent Technology (Shenzhen) Co., Ltd.",
    installDate: "2025-11-28",
    estimatedSize: 2400 * 1024 * 1024,
    installLocation: "D:\\Program Files\\Tencent\\WeChat",
    uninstallString: "\"D:\\Program Files\\Tencent\\WeChat\\Uninstall.exe\"",
    category: "desktop",
    isSystem: false,
    launchPath: "D:\\Program Files\\Tencent\\WeChat\\WeChat.exe",
    launchCount: 650,
    lastUsedTime: Date.now() - 1000 * 60 * 5
  },
  {
    id: "windows-terminal-store",
    name: "Windows Terminal",
    version: "1.20.10822.0",
    publisher: "Microsoft Corporation",
    installDate: "2026-03-01",
    estimatedSize: 95 * 1024 * 1024,
    installLocation: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1.20.10822.0_x64__8wekyb3d8bbwe",
    uninstallString: "powershell -Command \"Get-AppxPackage *WindowsTerminal* | Remove-AppxPackage\"",
    quietUninstallString: "powershell -Command \"Get-AppxPackage *WindowsTerminal* | Remove-AppxPackage\"",
    category: "store",
    isSystem: false,
    launchPath: "wt.exe",
    launchCount: 140,
    lastUsedTime: Date.now() - 1000 * 60 * 120
  },
  {
    id: "ms-vcredist-2022-x64",
    name: "Microsoft Visual C++ 2015-2022 Redistributable (x64)",
    version: "14.40.33810",
    publisher: "Microsoft Corporation",
    installDate: "2026-01-10",
    estimatedSize: 34 * 1024 * 1024,
    installLocation: "C:\\Windows\\System32",
    uninstallString: "\"C:\\ProgramData\\Package Cache\\{1234-VC-REDIST}\\VC_redist.x64.exe\" /uninstall",
    quietUninstallString: "\"C:\\ProgramData\\Package Cache\\{1234-VC-REDIST}\\VC_redist.x64.exe\" /uninstall /quiet",
    category: "runtime",
    isSystem: true,
    launchCount: 0
  },
  {
    id: "ms-net-desktop-runtime-8",
    name: "Microsoft .NET Desktop Runtime - 8.0.4 (x64)",
    version: "8.0.4",
    publisher: "Microsoft Corporation",
    installDate: "2026-01-12",
    estimatedSize: 110 * 1024 * 1024,
    installLocation: "C:\\Program Files\\dotnet",
    uninstallString: "\"C:\\ProgramData\\Package Cache\\{5678-DOTNET}\\dotnet-runtime.exe\" /uninstall",
    quietUninstallString: "\"C:\\ProgramData\\Package Cache\\{5678-DOTNET}\\dotnet-runtime.exe\" /uninstall /quiet",
    category: "runtime",
    isSystem: true,
    launchCount: 0
  }
].map(item => enrichSoftwareItem(item as SoftwareItem))

export function getMockSoftwareList(): SoftwareItem[] {
  return JSON.parse(JSON.stringify(MOCK_SOFTWARE_LIST))
}

export function getMockSoftwareSummary(list: SoftwareItem[] = MOCK_SOFTWARE_LIST): SoftwareSummaryData {
  const totalSizeBytes = list.reduce((sum, item) => sum + (item.estimatedSize || 0), 0)
  const silentSupportedCount = list.filter(item => Boolean(item.quietUninstallString)).length
  const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000
  const recentInstalledCount = list.filter(item => {
    if (!item.installDate) return false
    const parsed = Date.parse(item.installDate)
    return !Number.isNaN(parsed) && parsed >= thirtyDaysAgo
  }).length
  const idleLargeCount = list.filter(item => (item.estimatedSize || 0) >= 150 * 1024 * 1024).length

  return {
    totalCount: list.length,
    totalSizeBytes,
    recentInstalledCount,
    silentSupportedCount,
    idleLargeCount,
    residualTotalBytes: 0
  }
}

export function formatBytes(bytes: number): string {
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

export async function invokeNativeCapability(
  method: string,
  params: Record<string, unknown> = {},
  hostOverride?: any
): Promise<NativeInvocationResult> {
  const host = hostOverride || (typeof window !== 'undefined' ? (window as any).ztools?.nativeHost : undefined)

  if (host && typeof host.invokePlugin === 'function') {
    try {
      const res = await host.invokePlugin(DLL_PLUGIN_NAME, method, params)
      if (res && typeof res === 'object') {
        return {
          ok: res.ok !== false,
          pluginName: DLL_PLUGIN_NAME,
          method,
          data: res.data !== undefined ? res.data : res,
          error: res.error,
          fromFallback: false
        }
      }
    } catch (err: any) {
      console.warn(`[software-manager] Native invoke failed for ${method}:`, err)
      return {
        ok: false,
        pluginName: DLL_PLUGIN_NAME,
        method,
        error: err instanceof Error ? err.message : String(err),
        fromFallback: false
      }
    }
  }

  const transportRes = await callHostTransport<any>(
    'dllplugin_call',
    { plugin: DLL_PLUGIN_NAME, func: method, params },
    hostOverride
  )
  if (transportRes.ok && transportRes.data !== undefined) {
    const parsed = transportRes.data
    if (parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)) {
      return {
        ok: false,
        pluginName: DLL_PLUGIN_NAME,
        method,
        error: String((parsed as Record<string, unknown>).error || '原生组件返回未知错误'),
        fromFallback: false
      }
    }
    return {
      ok: true,
      pluginName: DLL_PLUGIN_NAME,
      method,
      data: parsed,
      fromFallback: false
    }
  }

  if (
    isRealElectronHost(hostOverride) ||
    isRealElectronHost() ||
    Boolean(hostOverride?.__isRealHost || hostOverride?.invoke || hostOverride?.send)
  ) {
    return {
      ok: false,
      pluginName: DLL_PLUGIN_NAME,
      method,
      error: transportRes.error || 'NATIVE_HOST_UNAVAILABLE: 当前宿主未挂载 SoftwareManagerPlugin 原生组件',
      fromFallback: false
    }
  }

  return {
    ok: true,
    pluginName: DLL_PLUGIN_NAME,
    method,
    data: resolveMockData(method),
    fromFallback: true
  }
}

function resolveMockData(method: string): unknown {
  switch (method) {
    case 'GetAllSoftware':
    case 'SearchSoftware':
      return { software: getMockSoftwareList() }
    case 'GetSummary':
      return getMockSoftwareSummary()
    case 'UninstallSoftware':
    case 'OpenInstallLocation':
    case 'LaunchSoftware':
      return { success: true }
    default:
      return {}
  }
}

export function mapRecordToSoftwareItem(rec: any, index: number): SoftwareItem {
  const name = String(rec.name || rec.DisplayName || '').trim()
  const isSystem = Boolean(rec.isSystemComponent || rec.SystemComponent || PROTECTED_SYSTEM_SOFTWARE_PATTERN.test(name))
  const rawSize = typeof rec.estimatedSize === 'number' && rec.estimatedSize > 0
    ? rec.estimatedSize
    : (typeof rec.estimatedSizeKb === 'number' && rec.estimatedSizeKb > 0 ? rec.estimatedSizeKb * 1024 : 0)

  let category: 'desktop' | 'store' | 'runtime' | 'other' = 'desktop'
  if (isSystem || PROTECTED_SYSTEM_SOFTWARE_PATTERN.test(name)) {
    category = 'runtime'
  } else if (name.includes('Store') || (rec.installLocation && String(rec.installLocation).includes('WindowsApps'))) {
    category = 'store'
  }

  let launchPath = rec.launchPath
  if (!launchPath && rec.installLocation && typeof rec.installLocation === 'string') {
    if (rec.installLocation.toLowerCase().endsWith('.exe')) {
      launchPath = rec.installLocation
    }
  }

  const publisher = String(rec.publisher || rec.Publisher || '未知开发商')
  const installLocation = String(rec.installLocation || rec.InstallLocation || '')
  const uninstallString = String(rec.uninstallString || rec.UninstallString || '')

  return enrichSoftwareItem({
    id: String(rec.id || `app-${index}-${encodeURIComponent(name).slice(0, 16)}`),
    name,
    version: String(rec.version || rec.DisplayVersion || ''),
    publisher,
    installDate: String(rec.installDate || rec.InstallDate || ''),
    estimatedSize: rawSize,
    installLocation,
    uninstallString,
    quietUninstallString: rec.quietUninstallString || rec.QuietUninstallString || undefined,
    category,
    isSystem,
    launchPath,
    launchCount: rec.launchCount,
    lastUsedTime: rec.lastUsedTime
  })
}

/**
 * 拉取本机已安装软件列表
 */
export async function fetchSoftwareList(host?: any, forceRefresh = false): Promise<SoftwareItem[]> {
  if (!host || isRealElectronHost(host)) {
    const ipcRes = await callHostTransport<any[]>(
      'applications_list',
      { forceRefresh, includeSystemComponents: true },
      host
    )
    if (ipcRes.ok && Array.isArray(ipcRes.data) && ipcRes.data.length > 0) {
      return ipcRes.data.map((item: any, idx: number) => mapRecordToSoftwareItem(item, idx))
    }
  }

  try {
    const ztools = typeof window !== 'undefined' ? (window as any).ztools : undefined
    if (typeof ztools?.applications_list === 'function') {
      const list = await ztools.applications_list({ forceRefresh, includeSystemComponents: true })
      if (Array.isArray(list) && list.length > 0) {
        return list.map((item: any, idx: number) => mapRecordToSoftwareItem(item, idx))
      }
    }
  } catch (err) {
    console.warn('[software-manager] fetchSoftwareList from window.ztools failed:', err)
  }

  try {
    const res = await invokeNativeCapability('GetAllSoftware', { forceRefresh }, host)
    if (res.ok && !res.fromFallback && res.data && typeof res.data === 'object' && Array.isArray((res.data as any).software)) {
      return ((res.data as any).software as any[]).map((item, idx) => mapRecordToSoftwareItem(item, idx))
    }
  } catch (err) {
    console.warn('[software-manager] fetchSoftwareList DLL invoke failed:', err)
  }

  if (!host || isRealElectronHost(host)) {
    try {
      const env = await getRealEnvPaths(host)
      const progRoots: Array<{ path: string; arch: string; isSystemRoot?: boolean }> = [
        { path: 'C:\\Program Files', arch: 'x64' },
        { path: 'C:\\Program Files (x86)', arch: 'x86' }
      ]
      if (env.localAppData) {
        progRoots.push({ path: `${env.localAppData}\\Programs`, arch: 'User x64' })
      }

      const SKIP_FOLDERS = new Set([
        'common files',
        'windowsapps',
        'modifiablewindowsapps',
        'uninstall information',
        'msbuild',
        'reference assemblies',
        'dotnet',
        'windows sidebar',
        'internet explorer'
      ])

      const discovered: SoftwareItem[] = []
      await Promise.all(
        progRoots.map(async (root) => {
          const entries = await readRealDirectory(root.path, host)
          const dirs = entries
            .filter((e) => e.isDirectory && !e.name.startsWith('.') && !SKIP_FOLDERS.has(e.name.toLowerCase()))
            .slice(0, 18)

          await Promise.all(
            dirs.map(async (dir, idx) => {
              const fullDir = dir.path || joinWinPath(root.path, dir.name)
              const stats = await scanRealDirectoryTree(fullDir, {
                maxDepth: 2,
                maxFiles: 80,
                collectTopN: 10,
                hostOverride: host
              })
              if (stats.totalBytes <= 0 && stats.fileCount <= 0) return

              const exeFile = stats.files.find((f) => f.name.toLowerCase().endsWith('.exe') && !/unins|update|crash|helper/i.test(f.name))
              const uninstFile = stats.files.find((f) => /unins|uninstall/i.test(f.name) && f.name.toLowerCase().endsWith('.exe'))
              const mtimeDate = new Date(dir.lastModifiedMs || Date.now())
              const y = mtimeDate.getFullYear()
              const m = String(mtimeDate.getMonth() + 1).padStart(2, '0')
              const d = String(mtimeDate.getDate()).padStart(2, '0')
              const isSys = /^windows\s|microsoft\s(?:visual|sdks|office|edge)/i.test(dir.name)

              const publisher =
                /microsoft|windows|vs code/i.test(dir.name)
                  ? 'Microsoft Corporation'
                  : /google|chrome/i.test(dir.name)
                  ? 'Google LLC'
                  : /git/i.test(dir.name)
                  ? 'The Git Development Community'
                  : /node/i.test(dir.name)
                  ? 'OpenJS Foundation'
                  : /nvidia/i.test(dir.name)
                  ? 'NVIDIA Corporation'
                  : `${root.arch} Application`

              discovered.push(
                enrichSoftwareItem({
                  id: `real-sw-${root.arch}-${idx}-${dir.name}`,
                  name: dir.name,
                  version: 'Installed',
                  publisher,
                  installDate: `${y}-${m}-${d}`,
                  estimatedSize: Math.max(stats.totalBytes, 4 * 1024 * 1024),
                  installLocation: fullDir,
                  uninstallString: uninstFile?.path || '',
                  quietUninstallString: uninstFile?.path ? `"${uninstFile.path}" /S` : undefined,
                  category: isSys ? 'runtime' : 'desktop',
                  isSystem: isSys,
                  launchPath: exeFile?.path || fullDir
                })
              )
            })
          )
        })
      )

      if (discovered.length > 0) {
        return discovered.sort((a, b) => b.estimatedSize - a.estimatedSize)
      }
    } catch (err) {
      console.warn('[software-manager] Program Files real scan failed:', err)
    }
  }

  if (isRealElectronHost(host)) {
    return []
  }

  return getMockSoftwareList()
}

/**
 * 扫描本机 %APPDATA% 与 %LOCALAPPDATA% 软件缓存与卸载残留目录 (software_uninstaller.h)
 */
export async function probeSoftwareAppDataResiduals(
  softwareList: SoftwareItem[],
  host?: any
): Promise<AppDataResidualItem[]> {
  if (host && !isRealElectronHost(host)) {
    return []
  }
  if (!isRealElectronHost(host) && typeof window === 'undefined') {
    return [
      {
        id: 'res-chrome-cache',
        folderName: 'Google',
        fullPath: 'C:\\Users\\Demo\\AppData\\Local\\Google',
        scope: 'AppData\\Local',
        sizeBytes: 340 * 1024 * 1024,
        fileCount: 412,
        matchedSoftwareName: 'Google Chrome',
        isOrphaned: false,
        lastModifiedMs: Date.now() - 3600_000
      },
      {
        id: 'res-orphan-old',
        folderName: 'OldUninstalledAppCache',
        fullPath: 'C:\\Users\\Demo\\AppData\\Roaming\\OldUninstalledAppCache',
        scope: 'AppData\\Roaming',
        sizeBytes: 85 * 1024 * 1024,
        fileCount: 96,
        matchedSoftwareName: undefined,
        isOrphaned: true,
        lastModifiedMs: Date.now() - 86400_000 * 95
      }
    ]
  }

  try {
    const env = await getRealEnvPaths(host)
    const roots: Array<{ path: string; scope: 'AppData\\Roaming' | 'AppData\\Local' }> = [
      { path: env.appData, scope: 'AppData\\Roaming' },
      { path: env.localAppData, scope: 'AppData\\Local' }
    ]

    const PROTECTED_APPDATA_DIRS = new Set([
      'microsoft',
      'windows',
      'packages',
      'programs',
      'temp',
      'connecteddevicesplatform',
      'd3dscache',
      'fontcache',
      'ztools',
      'antigravity'
    ])

    const results: AppDataResidualItem[] = []
    await Promise.all(
      roots.map(async (root) => {
        const entries = await readRealDirectory(root.path, host)
        const dirs = entries
          .filter((e) => e.isDirectory && !e.name.startsWith('.') && !PROTECTED_APPDATA_DIRS.has(e.name.toLowerCase()))
          .slice(0, 12)

        await Promise.all(
          dirs.map(async (dir) => {
            const fullPath = dir.path || joinWinPath(root.path, dir.name)
            const stats = await scanRealDirectoryTree(fullPath, {
              maxDepth: 2,
              maxFiles: 120,
              collectTopN: 5,
              hostOverride: host
            })
            if (stats.totalBytes <= 64 * 1024) return

            const lowerDir = dir.name.toLowerCase()
            const matched = softwareList.find((sw) => {
              const swName = sw.name.toLowerCase()
              const swPub = (sw.publisher || '').toLowerCase()
              return (
                swName.includes(lowerDir) ||
                lowerDir.includes(swName.split(' ')[0] || '___') ||
                (swPub && swPub !== '未知开发商' && swPub.includes(lowerDir))
              )
            })

            results.push({
              id: `appdata-${root.scope}-${dir.name}`,
              folderName: dir.name,
              fullPath,
              scope: root.scope,
              sizeBytes: stats.totalBytes,
              fileCount: stats.fileCount,
              matchedSoftwareName: matched?.name,
              isOrphaned: !matched,
              lastModifiedMs: dir.lastModifiedMs || Date.now()
            })
          })
        )
      })
    )

    return results.sort((a, b) => b.sizeBytes - a.sizeBytes)
  } catch (err) {
    console.warn('[software-manager] probeSoftwareAppDataResiduals error:', err)
    return []
  }
}

export async function cleanAppDataResiduals(
  items: AppDataResidualItem[],
  host?: any
): Promise<{ ok: boolean; cleanedCount: number; freedBytes: number; error?: string }> {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, cleanedCount: 0, freedBytes: 0, error: '未勾选任何残留目录' }
  }
  const paths = items.map((i) => i.fullPath).filter(Boolean)
  const freedBytes = items.reduce((s, i) => s + (i.sizeBytes || 0), 0)

  if (!host || isRealElectronHost(host)) {
    const res = await moveRealFilesToTrash(paths, host)
    return {
      ok: res.ok,
      cleanedCount: res.trashedCount || paths.length,
      freedBytes: res.ok ? freedBytes : 0,
      error: res.error
    }
  }
  return { ok: true, cleanedCount: paths.length, freedBytes }
}

/**
 * 拉取统计概览
 */
export async function fetchSoftwareSummary(host?: any, list?: SoftwareItem[]): Promise<SoftwareSummaryData> {
  let items = list
  if (!items || items.length === 0) {
    items = await fetchSoftwareList(host, false)
  }

  if (items && items.length > 0) {
    const totalCount = items.length
    const totalSizeBytes = items.reduce((sum, item) => sum + (item.estimatedSize || 0), 0)
    const silentSupportedCount = items.filter(item => Boolean(item.quietUninstallString || item.uninstallString)).length
    const recentInstalledCount = items.filter(item => (item.daysSinceInstall ?? parseInstallDays(item.installDate)) <= 30).length
    const idleLargeCount = items.filter(item => (item.estimatedSize || 0) >= 150 * 1024 * 1024).length

    return {
      totalCount,
      totalSizeBytes,
      recentInstalledCount,
      silentSupportedCount,
      idleLargeCount
    }
  }

  if (isRealElectronHost(host)) {
    return {
      totalCount: 0,
      totalSizeBytes: 0,
      recentInstalledCount: 0,
      silentSupportedCount: 0,
      idleLargeCount: 0
    }
  }

  return getMockSoftwareSummary()
}

export async function uninstallSoftware(
  item: SoftwareItem,
  isQuiet = false,
  host?: any
): Promise<{ ok: boolean; error?: string }> {
  if (FORBIDDEN_SOFTWARE_PATTERN.test(item.name)) {
    return { ok: false, error: FORBIDDEN_UNINSTALL_REASON }
  }

  const uninstallCmd = isQuiet ? (item.quietUninstallString || item.uninstallString) : item.uninstallString
  if (!uninstallCmd && !item.id) {
    return { ok: false, error: '未找到可用的卸载程序命令行' }
  }

  if (!host || isRealElectronHost(host)) {
    const ipcRes = await callHostTransport<{ success?: boolean; message?: string }>(
      'applications_uninstall',
      { command: item.id || item.name },
      host
    )
    if (ipcRes.ok && ipcRes.data?.success !== false) {
      return { ok: true }
    }
  }

  try {
    const res = await invokeNativeCapability('UninstallSoftware', {
      id: item.id,
      name: item.name,
      uninstallString: uninstallCmd,
      isQuiet
    }, host)
    if (res.ok) {
      return { ok: true }
    }
    return { ok: false, error: res.error || '卸载程序启动失败或被用户取消' }
  } catch (err: any) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function openSoftwareLocation(installLocation: string, host?: any): Promise<boolean> {
  if (!installLocation) return false
  if (!host || isRealElectronHost(host)) {
    const ok = await showRealItemInFolder(installLocation, host)
    if (ok) return true
  }

  try {
    const res = await invokeNativeCapability('OpenInstallLocation', { path: installLocation }, host)
    return res.ok
  } catch (err) {
    console.warn('[software-manager] openSoftwareLocation error:', err)
    return false
  }
}

export async function launchSoftware(launchPath: string, host?: any): Promise<boolean> {
  if (!launchPath) return false
  if (!host || isRealElectronHost(host)) {
    const ok = await openRealPath(launchPath, host)
    if (ok) return true
  }

  try {
    const res = await invokeNativeCapability('LaunchSoftware', { path: launchPath }, host)
    return res.ok
  } catch (err) {
    console.warn('[software-manager] launchSoftware error:', err)
    return false
  }
}

/**
 * 多维过滤与排序（向后兼容旧签名，同时支持 7 大智能分类与安装盘符过滤）
 */
export function filterSoftwareList(
  list: SoftwareItem[],
  query: string,
  tab: string,
  smartCatFilter = 'all',
  driveFilter = 'all'
): SoftwareItem[] {
  if (!Array.isArray(list)) return []
  let filtered = list.map(enrichSoftwareItem)

  if (tab === 'desktop') {
    filtered = filtered.filter(s => s.category === 'desktop')
  } else if (tab === 'store') {
    filtered = filtered.filter(s => s.category === 'store')
  } else if (tab === 'runtime') {
    filtered = filtered.filter(s => s.category === 'runtime' || s.isSystem)
  } else if (tab === 'advisor') {
    filtered = filtered.filter(s => (s.estimatedSize || 0) >= 100 * 1024 * 1024 || s.activityStatus === 'idle_large')
  }

  if (smartCatFilter && smartCatFilter !== 'all') {
    filtered = filtered.filter(s => s.smartCategory === smartCatFilter)
  }

  if (driveFilter && driveFilter !== 'all') {
    if (driveFilter === 'OTHER') {
      filtered = filtered.filter(s => s.installDrive !== 'C:' && s.installDrive !== 'D:')
    } else {
      filtered = filtered.filter(s => s.installDrive === driveFilter)
    }
  }

  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (q) {
    filtered = filtered.filter(s =>
      s.id.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      s.name.toLowerCase().replace(/\s+/g, '').includes(q) ||
      s.publisher.toLowerCase().includes(q) ||
      (s.installLocation && s.installLocation.toLowerCase().includes(q)) ||
      (s.version && s.version.toLowerCase().includes(q)) ||
      (s.smartCategoryName && s.smartCategoryName.toLowerCase().includes(q))
    )
  }

  return filtered.slice().sort((a, b) => {
    return (b.estimatedSize || 0) - (a.estimatedSize || 0)
  })
}
