/**
 * 系统极速加速、大内存进程治理与开机启动项管理 (Boost 2.0 Logic)
 * 1:1 复刻 DLLPlugins/boost (BoostPlugin.h & 启动项管理_技术设计文档.md)
 * 真实采集物理内存工作集、CPU 负载、高占用后台进程、Windows 开机启动项与 %TEMP% 热点缓存
 */

import {
  callHostTransport,
  formatBytes,
  getRealEnvPaths,
  getRealFileSize,
  getRealSystemPath,
  invokeDllPluginCapability,
  isRealElectronHost,
  listRealDirectoryContents,
  readRealDirectory,
  showRealItemInFolder,
  trashRealItem
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

export interface BoostCandidateItem {
  id: string
  type: 'process' | 'startup_item' | 'temp_cache'
  pid?: number
  name: string
  path: string
  memoryOrSizeBytes: number
  cpuPercent: number
  isProtected: boolean
  startupScope?: '用户启动目录 (Startup)' | '公共启动目录 (Common Startup)' | '注册表后台常驻'
  impactLevel?: '高耗时影响' | '中等影响' | '低影响'
  recommendation: string
}

export interface BoostSnapshot {
  totalMemoryBytes: number
  usedMemoryBytes: number
  availableMemoryBytes: number
  memoryUsagePercent: number
  cpuUsagePercent: number
  reclaimableEstimateBytes: number
  startupItemCount: number
  candidates: BoostCandidateItem[]
}

export const DLL_PLUGIN_NAME = 'BoostPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp(
  '^(?:Windows Defender|SecurityHealth|lsass|csrss|svchost|wininit|System|explorer|dwm|ZTools|electron)(?:\\.exe)?$',
  'i'
)
export const FORBIDDEN_REASON = '系统安全与核心引导启动项受保护，严禁禁用'

const PRESET_ITEMS: CapabilityActionItem[] = [
  {
    id: 'boost-registry-run',
    title: 'HKCU/HKLM 注册表自启动应用优化',
    subtitle: '扫描并禁用随系统登录自动拉起的第三方后台驻留程序',
    tag: '高耗时项',
    method: 'DisableItem',
    params: { category: 'registry', itemId: 'third-party-updater' }
  },
  {
    id: 'boost-scheduled-task',
    title: '计划任务自动更新器清理',
    subtitle: '禁用第三方软件定时唤醒与后台静默更新任务',
    tag: '计划任务',
    method: 'DisableItem',
    params: { category: 'scheduled_task', itemId: 'auto-update-task' }
  },
  {
    id: 'boost-services',
    title: '非核心第三方后台服务延迟/禁用',
    subtitle: '识别冗余云盘同步、打印辅助与遥测服务',
    tag: '后台服务',
    method: 'DisableItem',
    params: { category: 'service', itemId: 'telemetry-helper' }
  },
  {
    id: 'boost-startup-folder',
    title: '开始菜单 Startup 启动目录巡检',
    subtitle: '管理用户与公共启动目录下的快捷方式',
    tag: '启动目录',
    method: 'StartScanAsync',
    params: { scope: 'all' }
  }
]

export function getCapabilityItems(): CapabilityActionItem[] {
  return PRESET_ITEMS.map(item => ({
    ...item,
    params: { ...item.params }
  }))
}

export function filterCapabilityItems(items: CapabilityActionItem[], query: string): CapabilityActionItem[] {
  if (!Array.isArray(items)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return items
  return items.filter(item => {
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
  hostBridge?: { dllplugin?: { call?: (plugin: string, fn: string, payload: unknown) => Promise<unknown> }; __isRealHost?: boolean }
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

/**
 * 扫描本机真实 Windows 开机启动目录与自启常驻进程 (启动项管理_技术设计文档.md)
 */
async function scanRealStartupItems(
  allProcs: Array<{ pid: number; name: string; path: string; cpuUsage: number; memoryUsage: number }>,
  hostOverride?: any
): Promise<BoostCandidateItem[]> {
  const items: BoostCandidateItem[] = []

  if (!hostOverride || isRealElectronHost(hostOverride)) {
    const env = await getRealEnvPaths(hostOverride)
    const userStartup = env.appData
      ? `${env.appData}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup`
      : ''
    const commonStartup = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\StartUp'

    const folders: Array<{ dir: string; scope: '用户启动目录 (Startup)' | '公共启动目录 (Common Startup)' }> = [
      { dir: userStartup, scope: '用户启动目录 (Startup)' },
      { dir: commonStartup, scope: '公共启动目录 (Common Startup)' }
    ]

    for (const f of folders) {
      if (!f.dir) continue
      const entries = await readRealDirectory(f.dir, hostOverride)
      for (const entry of entries) {
        if (entry.name.toLowerCase() === 'desktop.ini') continue
        items.push({
          id: `boost-startup-file-${f.scope}-${entry.name}`,
          type: 'startup_item',
          name: `[开机启动] ${entry.name.replace(/\.(?:lnk|url|bat|cmd)$/i, '')}`,
          path: entry.path || `${f.dir}\\${entry.name}`,
          memoryOrSizeBytes: entry.sizeBytes || 4096,
          cpuPercent: 0,
          isProtected: FORBIDDEN_TARGET_PATTERN.test(entry.name),
          startupScope: f.scope,
          impactLevel: '高耗时影响',
          recommendation: `位于 ${f.scope}，随 Windows 登录自动拉起，可移出启动目录以缩短开机耗时`
        })
      }
    }
  }

  // 同时识别当前正在后台运行的典型开机自启驻留服务/托盘助手
  const AUTOSTART_PATTERNS = /onedrive|edgeupdate|googleupdate|steam|wechat|qq|dingtalk|feishu|todesk|sunlogin|nvidia|radeon|razer|logi|clash|tailscale|docker|wps|baidu|thunder|everything/i
  const seenNames = new Set<string>()
  for (const p of allProcs) {
    const name = String(p.name || '')
    const lower = name.toLowerCase()
    if (seenNames.has(lower)) continue
    if (AUTOSTART_PATTERNS.test(name) || AUTOSTART_PATTERNS.test(p.path || '')) {
      seenNames.add(lower)
      const mem = Number(p.memoryUsage || 0)
      items.push({
        id: `boost-startup-proc-${p.pid}`,
        type: 'startup_item',
        pid: Number(p.pid),
        name: `[自启常驻] ${name}`,
        path: String(p.path || ''),
        memoryOrSizeBytes: mem,
        cpuPercent: typeof p.cpuUsage === 'number' ? p.cpuUsage : 0,
        isProtected: false,
        startupScope: '注册表后台常驻',
        impactLevel: mem > 150 * 1024 * 1024 ? '高耗时影响' : '中等影响',
        recommendation: `随系统自启或后台常驻托盘 (当前占用 ${formatBytes(mem)})，闲置时可关闭释放内存`
      })
    }
  }

  return items
}

/**
 * 采集本机真实内存工作集、CPU 负载、开机启动项与可优化高占用候选列表
 */
export async function fetchBoostSnapshot(hostOverride?: any): Promise<BoostSnapshot> {
  const [hwRes, memRes, cpuRes, procsRes, tempDir] = await Promise.all([
    callHostTransport<{ totalMemory?: number }>('system_get_hardware_summary', {}, hostOverride),
    callHostTransport<{ total: number; used: number; available?: number; free?: number; percent?: number; usagePercent?: number }>(
      'system_get_memory_usage',
      {},
      hostOverride
    ),
    callHostTransport<{ total: number }>('system_get_cpu_usage', {}, hostOverride),
    callHostTransport<Array<{ pid: number; name: string; path: string; cpuUsage: number; memoryUsage: number }>>(
      'process_list',
      {},
      hostOverride
    ),
    getRealSystemPath('temp', hostOverride)
  ])

  const rawProcs = procsRes.ok && Array.isArray(procsRes.data) ? procsRes.data : []
  const sumProcMem = rawProcs.reduce((s, p) => s + Number(p.memoryUsage || 0), 0)

  const totalMemoryBytes =
    memRes.ok && memRes.data?.total
      ? memRes.data.total
      : hwRes.ok && hwRes.data?.totalMemory
      ? hwRes.data.totalMemory
      : 16 * 1024 * 1024 * 1024

  const usedMemoryBytes =
    memRes.ok && memRes.data?.used
      ? memRes.data.used
      : sumProcMem > 0
      ? Math.min(totalMemoryBytes, Math.round(sumProcMem * 1.15))
      : 0

  const availableMemoryBytes =
    memRes.ok && typeof memRes.data?.available === 'number'
      ? memRes.data.available
      : memRes.ok && typeof memRes.data?.free === 'number'
      ? memRes.data.free
      : Math.max(0, totalMemoryBytes - usedMemoryBytes)

  const memoryUsagePercent =
    memRes.ok && typeof memRes.data?.percent === 'number'
      ? memRes.data.percent
      : memRes.ok && typeof memRes.data?.usagePercent === 'number'
      ? memRes.data.usagePercent
      : totalMemoryBytes > 0
      ? Math.round((usedMemoryBytes / totalMemoryBytes) * 1000) / 10
      : 0

  const cpuUsagePercent = cpuRes.ok && typeof cpuRes.data?.total === 'number' ? Math.round(cpuRes.data.total) : 0

  const candidates: BoostCandidateItem[] = []
  let reclaimableEstimateBytes = 0

  if (rawProcs.length > 0) {
    const sorted = rawProcs
      .slice()
      .sort((a, b) => (b.memoryUsage || 0) - (a.memoryUsage || 0))
      .slice(0, 30)

    for (const p of sorted) {
      const name = String(p.name || 'Unknown')
      const baseName = name.replace(/\.exe$/i, '')
      const isProtected =
        p.pid <= 4 ||
        FORBIDDEN_TARGET_PATTERN.test(name) ||
        FORBIDDEN_TARGET_PATTERN.test(baseName) ||
        /^c:\\windows\\system32/i.test(p.path || '')
      const mem = Number(p.memoryUsage || 0)
      if (!isProtected) {
        reclaimableEstimateBytes += Math.round(mem * 0.35)
      }
      candidates.push({
        id: `boost-proc-${p.pid}`,
        type: 'process',
        pid: Number(p.pid),
        name,
        path: String(p.path || ''),
        memoryOrSizeBytes: mem,
        cpuPercent: typeof p.cpuUsage === 'number' ? p.cpuUsage : 0,
        isProtected,
        impactLevel: mem > 300 * 1024 * 1024 ? '高耗时影响' : '中等影响',
        recommendation: isProtected
          ? '系统核心/宿主驻留进程 (受保护自动跳过)'
          : mem > 300 * 1024 * 1024
          ? '高内存占用应用，闲置时可释放工作集或关闭'
          : '常规后台驻留进程，可按需回收工作集'
      })
    }
  }

  // 扫描开机启动项与自启常驻服务
  const startupItems = await scanRealStartupItems(rawProcs, hostOverride)
  candidates.push(...startupItems)

  if (tempDir) {
    const tempEntries = await readRealDirectory(tempDir, hostOverride)
    const slice = tempEntries.filter(e => !e.isDirectory).slice(0, 15)
    for (let i = 0; i < slice.length; i++) {
      const entry = slice[i]
      const sz = entry.sizeBytes > 0 ? entry.sizeBytes : await getRealFileSize(entry.path, hostOverride)
      if (sz <= 0) continue
      const fPath = entry.path
      const fName = entry.name || fPath.split(/[\\/]/).pop() || fPath
      reclaimableEstimateBytes += sz
      candidates.push({
        id: `boost-temp-${i}-${fName}`,
        type: 'temp_cache',
        name: `[临时缓存] ${fName}`,
        path: fPath,
        memoryOrSizeBytes: sz,
        cpuPercent: 0,
        isProtected: false,
        impactLevel: '低影响',
        recommendation: '系统 %TEMP% 临时残留文件，可安全移入回收站释放I/O负载'
      })
    }
  }

  return {
    totalMemoryBytes,
    usedMemoryBytes,
    availableMemoryBytes,
    memoryUsagePercent,
    cpuUsagePercent,
    reclaimableEstimateBytes,
    startupItemCount: startupItems.length,
    candidates
  }
}

export async function terminateBoostProcess(
  pid: number,
  name: string,
  hostOverride?: any
): Promise<{ ok: boolean; error?: string }> {
  const baseName = name.replace(/\.exe$/i, '').replace(/^\[自启常驻\]\s*/i, '')
  if (pid <= 4 || FORBIDDEN_TARGET_PATTERN.test(name) || FORBIDDEN_TARGET_PATTERN.test(baseName)) {
    return { ok: false, error: FORBIDDEN_REASON }
  }
  const dllRes = await callHostTransport<any>(
    'dllplugin_call',
    {
      plugin: 'ProcessMonitorPlugin',
      func: 'TerminateProcessByPID',
      params: { pid, force: true }
    },
    hostOverride
  )
  if (dllRes.ok && dllRes.data && (dllRes.data as any).error === undefined && (dllRes.data as any).success !== false) {
    return { ok: true }
  }
  const res = await callHostTransport('process_kill', { pid, force: true }, hostOverride)
  return { ok: res.ok, error: res.error }
}

export async function executeQuickBoostCleanup(
  candidates: BoostCandidateItem[],
  hostOverride?: any
): Promise<{ ok: boolean; cleanedCount: number; freedBytes: number }> {
  const tempItems = candidates.filter(c => c.type === 'temp_cache' && !c.isProtected)
  let cleanedCount = 0
  let freedBytes = 0

  for (const item of tempItems) {
    const res = await trashRealItem(item.path, hostOverride)
    if (res.ok) {
      cleanedCount += 1
      freedBytes += item.memoryOrSizeBytes
    }
  }

  return { ok: true, cleanedCount, freedBytes }
}

export async function openBoostItemLocation(path: string, hostOverride?: any): Promise<boolean> {
  if (!path) return false
  return showRealItemInFolder(path, hostOverride)
}
