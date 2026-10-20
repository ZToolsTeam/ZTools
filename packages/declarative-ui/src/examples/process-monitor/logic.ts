import {
  callHostTransport,
  formatBytes,
  invokeDllPluginCapability,
  isRealElectronHost,
  showRealItemInFolder
} from '../shared/native-ipc.js'

export { formatBytes } from '../shared/native-ipc.js'

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

export type ProcessSortKey = 'cpu' | 'memory' | 'name' | 'pid'
export type ProcessTerminateMode = 'force' | 'tree' | 'graceful'

export interface ProcessItem {
  pid: number
  name: string
  parentPid: number
  threadCount: number
  handleCount?: number
  path: string
  workingSetBytes: number
  memoryBytes: number
  privateBytes: number
  cpuPercent: number
  startTime?: number
  isSystem: boolean
  description?: string
  companyName?: string
  commandLine?: string
}

export interface SystemInfoData {
  cpuUsagePercent: number
  cpuCoreCount: number
  totalMemoryBytes: number
  usedMemoryBytes: number
  availableMemoryBytes: number
  totalMemory: number
  availableMemory: number
  memoryUsagePercent: number
  processCount: number
  threadCount: number
}

export interface ProcessServiceInfo {
  name: string
  serviceName: string
  displayName: string
  status: string | number
  startType: string
  description: string
}

export interface ProcessDetailInfo {
  pid: number
  name: string
  path: string
  commandLine: string
  companyName: string
  fileDescription: string
  fileVersion: string
  productName: string
  signerName: string
  startTime: string
  handleCount: number
  peakMemoryBytes: number
  memoryBytes: number
  privateBytes: number
  threadCount: number
  parentPid: number
}

export interface ResourceFocusSummary {
  topCpu: ProcessItem | null
  topMemory: ProcessItem | null
}

export const DLL_PLUGIN_NAME = 'ProcessMonitorPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp(
  '^(?:0|4|System|Idle|Registry|MemCompression|csrss\\.exe|lsass\\.exe|smss\\.exe|wininit\\.exe|services\\.exe|winlogon\\.exe|fontdrvhost\\.exe|dwm\\.exe)$',
  'i'
)
export const FORBIDDEN_REASON = '系统内核与会话管理关键进程受保护，严禁强制终止以免引发蓝屏 (BSOD)'

export const CRITICAL_PROCESS_NAMES = [
  'System',
  'Idle',
  'Registry',
  'MemCompression',
  'csrss.exe',
  'smss.exe',
  'wininit.exe',
  'services.exe',
  'lsass.exe',
  'winlogon.exe',
  'fontdrvhost.exe',
  'dwm.exe'
]

const PRESET_ITEMS: CapabilityActionItem[] = [
  {
    id: 'proc-list-all',
    title: '获取全量活动进程快照 (按内存与 CPU 排序)',
    subtitle: '展示进程 PID、工作集内存、命令行参数与数字签名状态',
    tag: '进程快照',
    method: 'GetProcessList',
    params: {
      includeCommandLine: true
    }
  },
  {
    id: 'proc-sys-info',
    title: '查看系统全局 CPU / 物理内存 / 句柄负载摘要',
    subtitle: '监控系统提交内存峰值、线程总数与内核分页池占用',
    tag: '系统负载',
    method: 'GetSystemInfo',
    params: {}
  },
  {
    id: 'proc-services',
    title: '穿透查询宿主进程 (svchost) 承载的底层服务',
    subtitle: '定位高占用 svchost.exe 实例背后关联的具体 Windows 服务名',
    tag: '服务穿透',
    method: 'GetServicesByPID',
    params: {
      pid: 1044
    }
  },
  {
    id: 'proc-terminate',
    title: '强制终止无响应/挂死的应用进程',
    subtitle: '调用 Win32 TerminateProcess 立即回收卡死应用资源',
    tag: '强制结束',
    method: 'TerminateProcessByPID',
    params: {
      pid: 28888
    }
  }
]

export function getCapabilityItems(): CapabilityActionItem[] {
  return PRESET_ITEMS.map((item) => ({
    ...item,
    params: { ...item.params }
  }))
}

export function filterCapabilityItems(items: CapabilityActionItem[], query: string): CapabilityActionItem[] {
  if (!Array.isArray(items)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return items
  return items.filter((item) => {
    if (!item || typeof item.title !== 'string') return false
    return (
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.tag.toLowerCase().includes(q) ||
      item.method.toLowerCase().includes(q)
    )
  })
}

export function validateInvocationPayload(method: string, params: unknown): { valid: boolean; error?: string } {
  if (typeof method !== 'string' || method.trim().length === 0) {
    return { valid: false, error: 'INVALID_METHOD: 调用方法名不能为空' }
  }
  if (method.length > 128 || !/^[A-Za-z0-9_]+$/.test(method.trim())) {
    return { valid: false, error: 'INVALID_METHOD_FORMAT: 方法名包含非法字符或超长' }
  }
  if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    return { valid: false, error: 'INVALID_PARAMS: 参数必须为非空对象' }
  }

  const record = params as Record<string, unknown>
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'string') {
      if (val.length > 4096) {
        return { valid: false, error: `PARAM_TOO_LONG: 参数 ${key} 超过最大长度限制` }
      }
      if (FORBIDDEN_TARGET_PATTERN.test(val)) {
        return { valid: false, error: `SECURITY_INTERCEPTED: ${FORBIDDEN_REASON}` }
      }
    } else if (typeof val === 'number') {
      if (!Number.isFinite(val) || val < -1000 || val > 100_000_000) {
        return { valid: false, error: `PARAM_OUT_OF_RANGE: 数值参数 ${key} 越界或非有限数` }
      }
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
  const res = await invokeDllPluginCapability(DLL_PLUGIN_NAME, method, params, hostBridge)
  return {
    ok: res.ok,
    pluginName: DLL_PLUGIN_NAME,
    method: method.trim(),
    data: res.data ?? undefined,
    error: res.error,
    fromFallback: res.fromFallback
  }
}

export function normalizeProcessItem(raw: any): ProcessItem {
  const pid = Number(raw?.pid ?? 0)
  const name = String(raw?.name || `PID-${pid}`)
  const pathStr = String(raw?.path || '')
  const workingSetBytes = Math.max(
    0,
    Number(raw?.workingSetBytes ?? raw?.memoryBytes ?? raw?.memoryUsage ?? 0)
  )
  const privateBytes = Math.max(
    0,
    Number(raw?.privateBytes ?? workingSetBytes)
  )
  const cpuPercent = Math.max(
    0,
    Number(raw?.cpuPercent ?? raw?.cpuUsage ?? 0)
  )
  const isSys =
    typeof raw?.isSystem === 'boolean'
      ? raw.isSystem
      : pid <= 4 ||
        CRITICAL_PROCESS_NAMES.some((c) => c.toLowerCase() === name.toLowerCase()) ||
        /^c:\\windows\\(?:system32|syswow64|servicing)/i.test(pathStr) ||
        /^(?:svchost|dwm|conhost|fontdrvhost|sihost|taskhostw|RuntimeBroker|SearchIndexer|WmiPrvSE|spoolsv|audiodg|dllhost|dashost|smartscreen|SecurityHealthService|MsMpEng)\.exe$/i.test(
          name
        )

  const threadCount = Math.max(1, Number(raw?.threadCount ?? 1))
  const parentPid = Math.max(0, Number(raw?.parentPid ?? 0))
  const handleCount = Math.max(0, Number(raw?.handleCount ?? 0))

  return {
    pid,
    name,
    parentPid,
    threadCount,
    handleCount,
    path: pathStr,
    workingSetBytes,
    memoryBytes: workingSetBytes,
    privateBytes,
    cpuPercent,
    isSystem: isSys,
    description: String(raw?.description || name),
    companyName: String(raw?.companyName || (isSys ? 'Microsoft Corporation' : '')),
    commandLine: String(raw?.commandLine || pathStr || name)
  }
}

export function getMockProcesses(): ProcessItem[] {
  return [
    {
      pid: 4,
      name: 'System',
      parentPid: 0,
      threadCount: 284,
      handleCount: 4120,
      path: 'C:\\Windows\\System32\\ntoskrnl.exe',
      workingSetBytes: 154200000,
      memoryBytes: 154200000,
      privateBytes: 120000000,
      cpuPercent: 0.8,
      isSystem: true,
      description: 'NT Kernel & System',
      companyName: 'Microsoft Corporation',
      commandLine: 'ntoskrnl.exe'
    },
    {
      pid: 1044,
      name: 'svchost.exe',
      parentPid: 688,
      threadCount: 42,
      handleCount: 980,
      path: 'C:\\Windows\\System32\\svchost.exe',
      workingSetBytes: 89400000,
      memoryBytes: 89400000,
      privateBytes: 65000000,
      cpuPercent: 0.2,
      isSystem: true,
      description: 'Windows 服务主进程 (DcomLaunch / PlugPlay)',
      companyName: 'Microsoft Corporation',
      commandLine: 'C:\\Windows\\System32\\svchost.exe -k DcomLaunch -p'
    },
    {
      pid: 612,
      name: 'csrss.exe',
      parentPid: 540,
      threadCount: 16,
      handleCount: 640,
      path: 'C:\\Windows\\System32\\csrss.exe',
      workingSetBytes: 18200000,
      memoryBytes: 18200000,
      privateBytes: 12000000,
      cpuPercent: 0.1,
      isSystem: true,
      description: 'Client Server Runtime Process',
      companyName: 'Microsoft Corporation',
      commandLine: 'csrss.exe'
    },
    {
      pid: 14208,
      name: 'chrome.exe',
      parentPid: 9812,
      threadCount: 38,
      handleCount: 1420,
      path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      workingSetBytes: 1284000000,
      memoryBytes: 1284000000,
      privateBytes: 1150000000,
      cpuPercent: 14.6,
      isSystem: false,
      description: 'Google Chrome 浏览器主进程',
      companyName: 'Google LLC',
      commandLine: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory=Default'
    },
    {
      pid: 19844,
      name: 'Code.exe',
      parentPid: 9812,
      threadCount: 52,
      handleCount: 1180,
      path: 'C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
      workingSetBytes: 742000000,
      memoryBytes: 742000000,
      privateBytes: 680000000,
      cpuPercent: 3.2,
      isSystem: false,
      description: 'Visual Studio Code',
      companyName: 'Microsoft Corporation',
      commandLine: '"C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"'
    },
    {
      pid: 22104,
      name: 'ZTools.exe',
      parentPid: 9812,
      threadCount: 28,
      handleCount: 540,
      path: 'C:\\Program Files\\ZTools\\ZTools.exe',
      workingSetBytes: 148000000,
      memoryBytes: 148000000,
      privateBytes: 125000000,
      cpuPercent: 1.1,
      isSystem: false,
      description: 'ZTools 极客效率中枢',
      companyName: 'ZTools Team',
      commandLine: '"C:\\Program Files\\ZTools\\ZTools.exe"'
    },
    {
      pid: 1540,
      name: 'explorer.exe',
      parentPid: 1420,
      threadCount: 88,
      handleCount: 2310,
      path: 'C:\\Windows\\explorer.exe',
      workingSetBytes: 245000000,
      memoryBytes: 245000000,
      privateBytes: 210000000,
      cpuPercent: 0.6,
      isSystem: false,
      description: 'Windows 资源管理器',
      companyName: 'Microsoft Corporation',
      commandLine: 'C:\\Windows\\Explorer.EXE'
    },
    {
      pid: 28440,
      name: 'node.exe',
      parentPid: 19844,
      threadCount: 14,
      handleCount: 380,
      path: 'C:\\Program Files\\nodejs\\node.exe',
      workingSetBytes: 312000000,
      memoryBytes: 312000000,
      privateBytes: 280000000,
      cpuPercent: 2.4,
      isSystem: false,
      description: 'Node.js JavaScript Runtime',
      companyName: 'OpenJS Foundation',
      commandLine: 'node.exe scripts/dev-server.mjs'
    }
  ]
}

export function getMockSystemInfo(): SystemInfoData {
  const total = 34225520640
  const avail = 14200000000
  const used = total - avail
  return {
    cpuUsagePercent: 24.5,
    cpuCoreCount: 16,
    totalMemoryBytes: total,
    usedMemoryBytes: used,
    availableMemoryBytes: avail,
    totalMemory: total,
    availableMemory: avail,
    memoryUsagePercent: 58,
    processCount: 8,
    threadCount: 662
  }
}

export function getMockProcessDetail(pid: number): ProcessDetailInfo {
  const proc = getMockProcesses().find((p) => p.pid === pid)
  const mem = proc?.workingSetBytes ?? 64 * 1024 * 1024
  return {
    pid,
    name: proc?.name || `Process_${pid}.exe`,
    path: proc?.path || `C:\\Windows\\System32\\Process_${pid}.exe`,
    commandLine: proc?.commandLine || `${proc?.path || `Process_${pid}.exe`} --service`,
    companyName: proc?.companyName || 'Microsoft Corporation',
    fileDescription: proc?.description || 'Windows 系统进程',
    fileVersion: '10.0.26100.1',
    productName: 'Microsoft Windows Operating System',
    signerName: proc?.isSystem ? 'Microsoft Windows' : proc?.companyName || 'Verified Publisher',
    startTime: '2026-10-15 08:30:00',
    handleCount: proc?.handleCount ?? 420,
    peakMemoryBytes: Math.round(mem * 1.18),
    memoryBytes: mem,
    privateBytes: proc?.privateBytes ?? Math.round(mem * 0.85),
    threadCount: proc?.threadCount ?? 12,
    parentPid: proc?.parentPid ?? 4
  }
}

export function getMockServicesByPID(pid: number): ProcessServiceInfo[] {
  if (pid === 1044) {
    return [
      {
        name: 'DcomLaunch',
        serviceName: 'DcomLaunch',
        displayName: 'DCOM Server Process Launcher',
        status: 'Running',
        startType: 'Auto',
        description: '提供 DCOM 服务启动与对象激活基础能力'
      },
      {
        name: 'PlugPlay',
        serviceName: 'PlugPlay',
        displayName: 'Plug and Play',
        status: 'Running',
        startType: 'Auto',
        description: '使计算机在极少或没有用户输入的情况下识别并适应硬件更改'
      }
    ]
  }
  return []
}

export async function fetchProcesses(host?: any): Promise<ProcessItem[]> {
  // 1. 优先通过 ProcessMonitorPlugin (GetProcessList) 获取完整字段快照（含真实 CPU%、路径、线程数、PPID、命令行）
  try {
    const res = await invokeNativeCapability('GetProcessList', { includeCommandLine: true }, host)
    if (res.ok && !res.fromFallback && res.data && typeof res.data === 'object') {
      const rawList = Array.isArray(res.data)
        ? res.data
        : Array.isArray((res.data as any).processes)
        ? (res.data as any).processes
        : []
      if (rawList.length > 0) {
        return rawList.map((item: any) => normalizeProcessItem(item))
      }
    }
  } catch (err) {
    console.warn('[process-monitor] GetProcessList fallback:', err)
  }

  // 2. 兼容通过 Preload Transport 调用 process_list 获取进程列表
  if (host || isRealElectronHost(host)) {
    const ipcRes = await callHostTransport<Array<any>>('process_list', {}, host)
    if (ipcRes.ok && Array.isArray(ipcRes.data) && ipcRes.data.length > 0) {
      return ipcRes.data.map((p) => normalizeProcessItem(p))
    }
  }

  if (isRealElectronHost(host)) {
    return []
  }
  return getMockProcesses()
}

export async function fetchSystemInfo(host?: any): Promise<SystemInfoData> {
  // 1. 优先通过 ProcessMonitorPlugin (GetSystemInfo) 获取完整系统负载摘要
  try {
    const res = await invokeNativeCapability('GetSystemInfo', {}, host)
    if (res.ok && !res.fromFallback && res.data && typeof res.data === 'object') {
      const d = ('info' in (res.data as any) ? (res.data as any).info : res.data) as any
      const total = Number(d?.totalMemoryBytes ?? d?.totalMemory ?? 0)
      if (total > 0) {
        const avail = Number(d?.availableMemoryBytes ?? d?.availableMemory ?? 0)
        const used = Number(d?.usedMemoryBytes ?? Math.max(0, total - avail))
        const memPct = Number(d?.memoryUsagePercent ?? Math.round((used / total) * 100))
        return {
          cpuUsagePercent: Number(d?.cpuUsagePercent ?? 0),
          cpuCoreCount: Number(d?.cpuCoreCount ?? 0),
          totalMemoryBytes: total,
          usedMemoryBytes: used,
          availableMemoryBytes: avail,
          totalMemory: total,
          availableMemory: avail,
          memoryUsagePercent: memPct,
          processCount: Number(d?.processCount ?? 0),
          threadCount: Number(d?.threadCount ?? 0)
        }
      }
    }
  } catch (err) {
    console.warn('[process-monitor] GetSystemInfo fallback:', err)
  }

  // 2. 兼容通过 system_get_memory_usage / system_get_hardware_summary / system_get_cpu_usage 获取
  if (host || isRealElectronHost(host)) {
    const [memRes, hwRes, cpuRes] = await Promise.all([
      callHostTransport<{ total: number; used: number; available: number; percent: number }>(
        'system_get_memory_usage',
        {},
        host
      ),
      callHostTransport<{ logicalCpuCount: number; totalMemory: number }>(
        'system_get_hardware_summary',
        {},
        host
      ),
      callHostTransport<{ total: number }>('system_get_cpu_usage', {}, host)
    ])
    if (memRes.ok && memRes.data && typeof memRes.data.total === 'number' && memRes.data.total > 0) {
      const total = memRes.data.total
      const avail = memRes.data.available
      const used = memRes.data.used ?? Math.max(0, total - avail)
      return {
        cpuUsagePercent: cpuRes.ok && typeof cpuRes.data?.total === 'number' ? cpuRes.data.total : 0,
        cpuCoreCount: hwRes.ok && hwRes.data?.logicalCpuCount ? hwRes.data.logicalCpuCount : 0,
        totalMemoryBytes: total,
        usedMemoryBytes: used,
        availableMemoryBytes: avail,
        totalMemory: total,
        availableMemory: avail,
        memoryUsagePercent: memRes.data.percent,
        processCount: 0,
        threadCount: 0
      }
    }
  }

  return getMockSystemInfo()
}

export async function fetchProcessDetail(pid: number, host?: any): Promise<ProcessDetailInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null

  try {
    const res = await invokeNativeCapability('GetProcessDetail', { pid }, host)
    if (res.ok && !res.fromFallback && res.data && typeof res.data === 'object') {
      const raw = ('detail' in (res.data as any) ? (res.data as any).detail : res.data) as any
      if (raw && !raw.error) {
        const mem = Number(raw.memoryBytes ?? raw.peakMemoryBytes ?? 0)
        return {
          pid: Number(raw.pid ?? pid),
          name: String(raw.name || `PID-${pid}`),
          path: String(raw.path || ''),
          commandLine: String(raw.commandLine || raw.path || ''),
          companyName: String(raw.companyName || ''),
          fileDescription: String(raw.fileDescription || ''),
          fileVersion: String(raw.fileVersion || ''),
          productName: String(raw.productName || ''),
          signerName: String(raw.signerName || ''),
          startTime: String(raw.startTime || ''),
          handleCount: Number(raw.handleCount ?? 0),
          peakMemoryBytes: Number(raw.peakMemoryBytes ?? mem),
          memoryBytes: mem,
          privateBytes: Number(raw.privateBytes ?? mem),
          threadCount: Number(raw.threadCount ?? 0),
          parentPid: Number(raw.parentPid ?? 0)
        }
      }
    }
  } catch (err) {
    console.warn('[process-monitor] fetchProcessDetail error:', err)
  }

  if (host || isRealElectronHost(host)) {
    const infoRes = await callHostTransport<{
      pid: number
      name: string
      path: string
      cpuUsage: number
      memoryUsage: number
      privateBytes?: number
      peakMemoryBytes?: number
      handleCount?: number
      threadCount?: number
      parentPid?: number
    }>('process_info', { pid }, host)
    if (infoRes.ok && infoRes.data) {
      const mem = Number(infoRes.data.memoryUsage || 0)
      return {
        pid,
        name: infoRes.data.name || `PID-${pid}`,
        path: infoRes.data.path || '',
        commandLine: infoRes.data.path || infoRes.data.name || '',
        companyName: /^c:\\windows/i.test(infoRes.data.path || '') ? 'Microsoft Corporation' : '',
        fileDescription: infoRes.data.name || '',
        fileVersion: '',
        productName: '',
        signerName: /^c:\\windows/i.test(infoRes.data.path || '')
          ? 'Microsoft Windows'
          : '本机真实运行进程',
        startTime: '',
        memoryBytes: mem,
        privateBytes: Number(infoRes.data.privateBytes ?? mem),
        peakMemoryBytes: Number(infoRes.data.peakMemoryBytes ?? mem),
        handleCount: Number(infoRes.data.handleCount ?? 0),
        threadCount: Number(infoRes.data.threadCount ?? 0),
        parentPid: Number(infoRes.data.parentPid ?? 0)
      }
    }
    if (isRealElectronHost(host)) {
      return null
    }
  }

  return getMockProcessDetail(pid)
}

export async function fetchServicesByPID(pid: number, host?: any): Promise<ProcessServiceInfo[]> {
  if (!Number.isInteger(pid) || pid <= 0) return []

  try {
    const res = await invokeNativeCapability('GetServicesByPID', { pid }, host)
    if (res.ok && !res.fromFallback && res.data && typeof res.data === 'object') {
      const rawList = Array.isArray(res.data)
        ? res.data
        : Array.isArray((res.data as any).services)
        ? (res.data as any).services
        : []
      return rawList.map((s: any) => ({
        name: String(s?.serviceName || s?.name || ''),
        serviceName: String(s?.serviceName || s?.name || ''),
        displayName: String(s?.displayName || s?.serviceName || s?.name || ''),
        status: s?.status ?? 'Running',
        startType: String(s?.startType || 'Auto'),
        description: String(s?.description || '')
      }))
    }
  } catch (err) {
    console.warn('[process-monitor] fetchServicesByPID fallback:', err)
  }

  if (isRealElectronHost(host)) {
    return []
  }
  return getMockServicesByPID(pid)
}

export async function terminateProcess(
  pid: number,
  name: string,
  modeOrHost?: ProcessTerminateMode | any,
  maybeHost?: any
): Promise<{ ok: boolean; error?: string; mode?: ProcessTerminateMode }> {
  const mode: ProcessTerminateMode =
    modeOrHost === 'force' || modeOrHost === 'tree' || modeOrHost === 'graceful'
      ? modeOrHost
      : 'force'
  const host =
    modeOrHost === 'force' || modeOrHost === 'tree' || modeOrHost === 'graceful'
      ? maybeHost
      : modeOrHost

  if (!Number.isInteger(pid) || pid < 0) {
    return { ok: false, error: 'INVALID_PID: 进程 PID 无效' }
  }

  if (
    pid === 0 ||
    pid === 4 ||
    FORBIDDEN_TARGET_PATTERN.test(name) ||
    CRITICAL_PROCESS_NAMES.some((c) => c.toLowerCase() === String(name || '').toLowerCase())
  ) {
    return { ok: false, error: FORBIDDEN_REASON }
  }

  try {
    const res = await invokeNativeCapability(
      'TerminateProcessByPID',
      {
        pid,
        name,
        mode,
        force: mode !== 'graceful',
        tree: mode === 'tree'
      },
      host
    )
    if (!res.fromFallback) {
      if (res.ok) {
        return { ok: true, mode }
      }
      // 若 DLL 调用返回错误，尝试 process_kill (针对当前窗口自己启动的子进程)
      const killRes = await callHostTransport('process_kill', { pid, force: mode !== 'graceful' }, host)
      if (killRes.ok) {
        return { ok: true, mode }
      }
      return { ok: false, error: res.error || '终止进程失败' }
    }
  } catch (err: any) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  if (host || isRealElectronHost(host)) {
    const killRes = await callHostTransport('process_kill', { pid, force: mode !== 'graceful' }, host)
    if (killRes.ok) {
      return { ok: true, mode }
    }
    if (isRealElectronHost(host)) {
      return { ok: false, error: killRes.error || '无法终止外部进程或权限不足' }
    }
  }

  return { ok: true, mode }
}

export async function openFileLocation(filePath: string, host?: any): Promise<boolean> {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) return false
  if (host || isRealElectronHost(host)) {
    const shown = await showRealItemInFolder(filePath, host)
    if (shown) return true
  }
  try {
    const res = await invokeNativeCapability('OpenFileLocation', { path: filePath }, host)
    return res.ok
  } catch (err) {
    console.warn('[process-monitor] openFileLocation error:', err)
    return false
  }
}

export function getResourceFocus(list: ProcessItem[]): ResourceFocusSummary {
  if (!Array.isArray(list) || list.length === 0) {
    return { topCpu: null, topMemory: null }
  }
  let topCpu: ProcessItem | null = null
  let topMemory: ProcessItem | null = null
  for (const item of list) {
    if (!item) continue
    if (!topCpu || item.cpuPercent > topCpu.cpuPercent) {
      topCpu = item
    }
    const mem = item.workingSetBytes ?? item.memoryBytes ?? 0
    const topMemVal = topMemory ? (topMemory.workingSetBytes ?? topMemory.memoryBytes ?? 0) : -1
    if (!topMemory || mem > topMemVal) {
      topMemory = item
    }
  }
  return { topCpu, topMemory }
}

export function filterProcesses(
  list: ProcessItem[],
  query: string,
  tab: string = 'all',
  sortBy: ProcessSortKey = 'cpu'
): ProcessItem[] {
  if (!Array.isArray(list)) return []
  let filtered = list

  if (tab === 'user') {
    filtered = filtered.filter((p) => !p.isSystem)
  } else if (tab === 'system') {
    filtered = filtered.filter((p) => p.isSystem)
  }

  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (q) {
    filtered = filtered.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        String(p.pid).includes(q) ||
        (p.path && p.path.toLowerCase().includes(q)) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.companyName && p.companyName.toLowerCase().includes(q))
    )
  }

  return filtered.slice().sort((a, b) => {
    const memA = a.workingSetBytes ?? a.memoryBytes ?? 0
    const memB = b.workingSetBytes ?? b.memoryBytes ?? 0
    if (sortBy === 'memory') {
      if (memB !== memA) return memB - memA
      return b.cpuPercent - a.cpuPercent
    }
    if (sortBy === 'name') {
      const cmp = a.name.localeCompare(b.name)
      return cmp !== 0 ? cmp : a.pid - b.pid
    }
    if (sortBy === 'pid') {
      return a.pid - b.pid
    }
    // 默认: cpu 优先，次选内存降序
    if (Math.abs(b.cpuPercent - a.cpuPercent) >= 0.1) {
      return b.cpuPercent - a.cpuPercent
    }
    return memB - memA
  })
}
