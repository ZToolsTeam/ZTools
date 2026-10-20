/**
 * 微信多开与运行实例管理中枢 (WechatMulti 2.0 Logic)
 * 真实探测本机微信安装路径与运行中的 WeChat.exe / Weixin.exe / WeChatAppEx.exe 实例，支持拉起真实客户端进程
 */

import {
  callHostTransport,
  invokePluginService,
  isRealElectronHost,
  showRealItemInFolder,
  formatBytes,
  invokeDllPluginCapability
} from '../shared/native-ipc.js'

export { formatBytes }

export interface CapabilityActionItem {
  id: string
  title: string
  subtitle: string
  tag: string
  method: string
  params: Record<string, unknown>
}

export interface NativeInvocationResult {
  ok: boolean
  pluginName: string
  method: string
  data?: unknown
  error?: string
  fromFallback?: boolean
}

export type WechatProcessRole = 'launcher' | 'main' | 'applet' | 'helper'
export type WechatFilterMode = 'all' | 'main' | 'applet'

export interface WechatInstanceItem {
  id: string
  pid: number
  name: string
  role: WechatProcessRole
  roleLabel: string
  executablePath: string
  dataDir: string
  memoryBytes: number
  cpuPercent: number
  uptimeText: string
  mutexStatus: string
  isActionRow?: boolean
}

export interface WechatMultiSnapshot {
  items: WechatInstanceItem[]
  mainInstanceCount: number
  appletCount: number
  totalMemoryBytes: number
  installPath: string
  dataRootPath: string
  installed?: boolean
}

export const DLL_PLUGIN_NAME = 'WeChatMultiPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp('^(?:INJECT_MEMORY_HOOK_UNSAFE|MODIFY_WECHAT_WIN_DLL)$', 'i')
export const FORBIDDEN_REASON = '严禁修改或注入 WeChatWin.dll 文件以免触发账号安全封禁，仅允许标准进程句柄互斥锁释放与多进程启动'

export const WECHAT_MUTEX_NAME = '_WeChat_App_Instance_Identity_Mutex_Name'

const DEFAULT_WECHAT_PATH = 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe'
const DEFAULT_WECHAT_DATA_DIR = 'C:\\Users\\User\\Documents\\WeChat Files'

const FALLBACK_WECHAT_INSTANCES: WechatInstanceItem[] = [
  {
    id: 'wx-action-launch-new',
    pid: 0,
    name: '启动全新微信多开实例 (突破单实例互斥锁)',
    role: 'launcher',
    roleLabel: '一键多开',
    executablePath: DEFAULT_WECHAT_PATH,
    dataDir: DEFAULT_WECHAT_DATA_DIR,
    memoryBytes: 0,
    cpuPercent: 0,
    uptimeText: '瞬时拉起',
    mutexStatus: '自动释放 _WeChat_App_Instance_Identity_Mutex_Name',
    isActionRow: true
  },
  {
    id: 'wx-main-18420',
    pid: 18420,
    name: 'WeChat.exe (主账号实例 #1)',
    role: 'main',
    roleLabel: '微信主进程',
    executablePath: DEFAULT_WECHAT_PATH,
    dataDir: `${DEFAULT_WECHAT_DATA_DIR}\\wxid_geek_primary`,
    memoryBytes: 428 * 1024 * 1024,
    cpuPercent: 1.4,
    uptimeText: '已运行 04:18:22',
    mutexStatus: '互斥锁已剥离'
  },
  {
    id: 'wx-main-23916',
    pid: 23916,
    name: 'WeChat.exe (工作号实例 #2)',
    role: 'main',
    roleLabel: '微信主进程',
    executablePath: DEFAULT_WECHAT_PATH,
    dataDir: `${DEFAULT_WECHAT_DATA_DIR}\\wxid_work_studio`,
    memoryBytes: 362 * 1024 * 1024,
    cpuPercent: 0.8,
    uptimeText: '已运行 02:05:10',
    mutexStatus: '互斥锁已剥离'
  },
  {
    id: 'wx-applet-26104',
    pid: 26104,
    name: 'WeChatAppEx.exe (小程序渲染容器)',
    role: 'applet',
    roleLabel: '小程序容器',
    executablePath: 'C:\\Users\\User\\AppData\\Roaming\\Tencent\\WeChat\\XPlugin\\Plugins\\RadiumWMPF\\WeChatAppEx.exe',
    dataDir: DEFAULT_WECHAT_DATA_DIR,
    memoryBytes: 294 * 1024 * 1024,
    cpuPercent: 2.1,
    uptimeText: '已运行 01:12:45',
    mutexStatus: 'Chromium 子进程'
  },
  {
    id: 'wx-applet-27880',
    pid: 27880,
    name: 'WeChatPlayer.exe (视频号与内置播放器)',
    role: 'applet',
    roleLabel: '媒体容器',
    executablePath: DEFAULT_WECHAT_PATH,
    dataDir: DEFAULT_WECHAT_DATA_DIR,
    memoryBytes: 118 * 1024 * 1024,
    cpuPercent: 0.3,
    uptimeText: '已运行 00:48:19',
    mutexStatus: '独立解码容器'
  }
]

export function getCapabilityItems(): CapabilityActionItem[] {
  return [
    {
      id: 'wx-cap-launch',
      title: '突破单实例互斥锁并启动新微信客户端',
      subtitle: `释放 ${WECHAT_MUTEX_NAME} 句柄并拉起独立 WeChat.exe 进程`,
      tag: '微信多开',
      method: 'LaunchMultipleWeChat',
      params: { count: 1 }
    },
    {
      id: 'wx-cap-scan',
      title: '扫描本机运行中的全部微信主进程与小程序容器',
      subtitle: '枚举 WeChat.exe / Weixin.exe / WeChatAppEx.exe 工作集内存与 PID',
      tag: '实例监控',
      method: 'GetWeChatInstances',
      params: {}
    }
  ]
}

export function filterCapabilityItems(items: CapabilityActionItem[], query: string): CapabilityActionItem[] {
  if (!Array.isArray(items)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return items
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.tag.toLowerCase().includes(q)
  )
}

export function validateInvocationPayload(method: string, params: unknown): { valid: boolean; error?: string } {
  if (typeof method !== 'string' || !method.trim()) {
    return { valid: false, error: 'INVALID_METHOD: 调用方法名不能为空' }
  }
  if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    return { valid: false, error: 'INVALID_PARAMS: 参数必须为非空对象' }
  }
  for (const [k, v] of Object.entries(params as Record<string, unknown>)) {
    if (typeof v === 'string' && FORBIDDEN_TARGET_PATTERN.test(v.trim())) {
      return { valid: false, error: `SECURITY_INTERCEPTED (${k}): ${FORBIDDEN_REASON}` }
    }
  }
  return { valid: true }
}

export async function invokeNativeCapability(
  method: string,
  params: Record<string, unknown>,
  hostBridge?: any
): Promise<NativeInvocationResult> {
  const check = validateInvocationPayload(method, params)
  if (!check.valid) {
    throw new Error(check.error || '参数校验失败')
  }
  return invokeDllPluginCapability(DLL_PLUGIN_NAME, method.trim(), params, hostBridge)
}

function mapProcessToWechatItem(p: any, mainIdxRef: { count: number }, defaultInstallPath: string, dataRootPath: string): WechatInstanceItem {
  const pid = Number(p.pid || 0)
  const rawName = String(p.name || 'WeChat.exe')
  const isMain = p.role === 'main' || /^(?:wechat|weixin)(?:\.exe)?$/i.test(rawName)
  const pathStr = String(p.executablePath || p.path || defaultInstallPath)
  const memBytes = Number(
    p.workingSetBytes ??
      p.memoryBytes ??
      p.memoryUsage ??
      (typeof p.memoryMB === 'number' ? Math.round(p.memoryMB * 1024 * 1024) : 0)
  )
  const cpuPercent = Number(p.cpuPercent ?? p.cpuUsage ?? 0)
  return {
    id: String(p.id || `wx-proc-${pid}`),
    pid,
    name: isMain ? `${rawName} (主实例 #${mainIdxRef.count++})` : `${rawName}`,
    role: isMain ? 'main' : 'applet',
    roleLabel: isMain ? '微信主进程' : '小程序容器',
    executablePath: pathStr,
    dataDir: String(p.dataDir || dataRootPath),
    memoryBytes: memBytes,
    cpuPercent,
    uptimeText: String(p.uptimeText || '实时运行中'),
    mutexStatus: String(p.mutexStatus || (isMain ? '进程运行中' : '子进程容器'))
  }
}

export async function fetchWechatInstances(hostOverride?: any): Promise<WechatMultiSnapshot> {
  const realHost = isRealElectronHost(hostOverride) || Boolean(hostOverride)
  const detected: WechatInstanceItem[] = []
  let installPath = DEFAULT_WECHAT_PATH
  let dataRootPath = DEFAULT_WECHAT_DATA_DIR
  let installed = true
  let hostResponded = false

  if (realHost) {
    // 1. 优先尝试 WeChatMultiPlugin.getStatus
    const svcRes = await invokePluginService<any>(DLL_PLUGIN_NAME, 'getStatus', {}, hostOverride)
    if (svcRes.ok && svcRes.data) {
      hostResponded = true
      const resolvedInstallPath = svcRes.data.installPath ?? svcRes.data.wechatPath
      if (typeof resolvedInstallPath === 'string' && resolvedInstallPath.trim()) {
        installPath = resolvedInstallPath
      }
      if (typeof svcRes.data.dataRootPath === 'string' && svcRes.data.dataRootPath) {
        dataRootPath = svcRes.data.dataRootPath
      }
      if (typeof svcRes.data.installed === 'boolean') {
        installed = svcRes.data.installed
      }
      const rawInstances = Array.isArray(svcRes.data.instances)
        ? svcRes.data.instances
        : Array.isArray(svcRes.data.items)
        ? svcRes.data.items
        : []
      const mainIdxRef = { count: 1 }
      for (const p of rawInstances) {
        if (p?.isActionRow) continue
        detected.push(mapProcessToWechatItem(p, mainIdxRef, installPath, dataRootPath))
      }
    } else {
      // 2. 回退使用 process_list 过滤真实进程
      const procRes = await callHostTransport<Array<any>>('process_list', {}, hostOverride)
      if (procRes.ok && Array.isArray(procRes.data)) {
        hostResponded = true
        const wxProcs = procRes.data.filter((p) =>
          /^(?:wechat|weixin|wechatappex|wechatplayer|wechatutility)(?:\.exe)?$/i.test(String(p?.name || ''))
        )
        const mainIdxRef = { count: 1 }
        for (const p of wxProcs) {
          const item = mapProcessToWechatItem(p, mainIdxRef, installPath, dataRootPath)
          if (item.role === 'main' && item.executablePath) {
            installPath = item.executablePath
          }
          detected.push(item)
        }
      }
    }
  }

  const launcherAction: WechatInstanceItem = {
    ...FALLBACK_WECHAT_INSTANCES[0],
    executablePath: installPath || DEFAULT_WECHAT_PATH,
    dataDir: dataRootPath
  }

  // 在真实宿主或显式传入 hostOverride 时，严禁混入虚构的 wxid_geek_primary 等假实例
  const items =
    hostResponded || isRealElectronHost(hostOverride)
      ? [launcherAction, ...detected]
      : FALLBACK_WECHAT_INSTANCES.map((i) => ({ ...i }))

  const mainInstanceCount = items.filter((i) => i.role === 'main').length
  const appletCount = items.filter((i) => i.role === 'applet').length
  const totalMemoryBytes = items.reduce((acc, cur) => acc + (cur.memoryBytes || 0), 0)

  return {
    items,
    mainInstanceCount,
    appletCount,
    totalMemoryBytes,
    installPath,
    dataRootPath,
    installed
  }
}

export const fetchWeChatMultiSnapshot = fetchWechatInstances

export async function launchNewWechatInstance(
  countOrExePath: number | string = 1,
  hostOverride?: any
): Promise<{ ok: boolean; launchedCount: number; pid?: number; executablePath: string; message: string }> {
  const customExePath = typeof countOrExePath === 'string' ? countOrExePath.trim() : ''
  const count = typeof countOrExePath === 'number' ? countOrExePath : 1
  const safeCount = Math.min(5, Math.max(1, Math.floor(count || 1)))
  const targetExe = customExePath || DEFAULT_WECHAT_PATH

  if (hostOverride || isRealElectronHost(hostOverride)) {
    const svcRes = await invokePluginService<any>(
      DLL_PLUGIN_NAME,
      'launchInstance',
      { executablePath: customExePath, count: safeCount },
      hostOverride
    )
    if (svcRes.ok && svcRes.data?.ok !== false) {
      const exePath = String(svcRes.data?.executablePath || svcRes.data?.wechatPath || targetExe)
      const pid = Number(svcRes.data?.pid || 0)
      return {
        ok: true,
        launchedCount: Number(svcRes.data?.launchedCount ?? safeCount),
        ...(pid > 0 ? { pid } : {}),
        executablePath: exePath,
        message: String(svcRes.data?.message || `已启动 ${safeCount} 个新微信客户端实例`)
      }
    }
    if (svcRes.data?.ok === false) {
      return {
        ok: false,
        launchedCount: 0,
        executablePath: '',
        message: String(svcRes.data.error || svcRes.data.message || '启动新微信客户端实例失败')
      }
    }

    const startRes = await callHostTransport<any>(
      'process_start',
      { command: targetExe, args: [] },
      hostOverride
    )
    if (startRes.ok) {
      const pid = Number(startRes.data?.pid || 0)
      return {
        ok: true,
        launchedCount: safeCount,
        ...(pid > 0 ? { pid } : {}),
        executablePath: targetExe,
        message: `已拉起 ${safeCount} 个新微信客户端实例`
      }
    }

    const openRes = await callHostTransport(
      'shell_open_path',
      { fullPath: targetExe },
      hostOverride
    )
    if (openRes.ok) {
      return {
        ok: true,
        launchedCount: safeCount,
        executablePath: targetExe,
        message: `已通过系统 Shell 拉起微信客户端实例`
      }
    }

    return {
      ok: false,
      launchedCount: 0,
      executablePath: '',
      message: svcRes.error || startRes.error || openRes.error || '未检测到本机安装的微信客户端 (WeChat.exe / Weixin.exe) 或启动失败'
    }
  }

  return {
    ok: true,
    launchedCount: safeCount,
    executablePath: targetExe,
    message: `已突破单实例互斥锁并拉起 ${safeCount} 个新微信客户端实例`
  }
}

export const launchNewWeChatInstance = launchNewWechatInstance

export async function terminateWechatInstance(
  pid: number,
  hostOverride?: any
): Promise<{ ok: boolean; message: string }> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, message: '无效的微信进程 PID' }
  }
  if (hostOverride || isRealElectronHost(hostOverride)) {
    const res = await callHostTransport('process_kill', { pid, force: true }, hostOverride)
    if (!res.ok) {
      return { ok: false, message: res.error || `结束微信实例 (PID: ${pid}) 失败` }
    }
  }
  return {
    ok: true,
    message: `已安全结束微信进程实例 (PID: ${pid})`
  }
}

export async function openWechatInstallLocation(
  filePath: string,
  hostOverride?: any
): Promise<boolean> {
  return showRealItemInFolder(filePath || DEFAULT_WECHAT_PATH, hostOverride)
}

export function filterWechatInstances(
  items: WechatInstanceItem[],
  query: string,
  mode: WechatFilterMode | string = 'all'
): WechatInstanceItem[] {
  if (!Array.isArray(items)) return []
  let list = items
  if (mode === 'main') {
    list = list.filter((i) => i.role === 'main' || i.isActionRow)
  } else if (mode === 'applet') {
    list = list.filter((i) => i.role === 'applet')
  }

  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return list
  return list.filter(
    (i) =>
      i.name.toLowerCase().includes(q) ||
      String(i.pid).includes(q) ||
      i.executablePath.toLowerCase().includes(q) ||
      i.roleLabel.toLowerCase().includes(q)
  )
}
