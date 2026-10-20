/**
 * 网络流量监控、进程连接审计与防火墙卫士 (FlowGuard 2.0 Logic)
 * 1:1 复刻 DLLPlugins/flow-guard (FlowGuardPlugin.h)
 * 真实聚合 process_list_ports (TCP/UDP 五元组套接字) 与 process_list (进程路径/内存/CPU)
 */

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

export type RemoteIpScope = 'public' | 'lan' | 'loopback' | 'listening'

export interface PortEndpointItem {
  protocol: string
  localAddress: string
  localPort: number
  remoteAddress: string
  remotePort: number
  state: string
  pid: number
  processName: string
  remoteScope?: RemoteIpScope
}

export interface ProcessNetworkGroup {
  pid: number
  processName: string
  processPath: string
  cpuPercent: number
  memoryBytes: number
  tcpCount: number
  udpCount: number
  establishedCount: number
  listeningCount: number
  publicCount: number
  lanCount: number
  loopbackCount: number
  endpoints: PortEndpointItem[]
  isProtected: boolean
}

export interface FlowGuardSnapshot {
  groups: ProcessNetworkGroup[]
  totalEndpoints: number
  totalEstablished: number
  totalListening: number
  totalUdp: number
  totalPublic: number
  totalLan: number
  totalLoopback: number
}

export const DLL_PLUGIN_NAME = 'FlowGuardPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp('^(?:System|svchost\\.exe|lsass\\.exe|dns\\.exe|csrss\\.exe|services\\.exe)$', 'i')
export const FORBIDDEN_REASON = '核心系统网络服务受保护，禁止断网拦截以防系统断联'

/**
 * 识别远端地址所属网络域（公网外联 / 局域网 / 本机回环 / 监听）
 */
export function classifyRemoteIpScope(remoteAddress: string, state: string, protocol: string): RemoteIpScope {
  const addr = String(remoteAddress || '').trim().toLowerCase()
  const st = String(state || '').trim().toUpperCase()
  if (
    st === 'LISTENING' ||
    st === 'LISTEN' ||
    !addr ||
    addr === '*' ||
    addr === '0.0.0.0' ||
    addr === '::' ||
    addr === '[::]'
  ) {
    return 'listening'
  }
  if (
    addr === '127.0.0.1' ||
    addr.startsWith('127.') ||
    addr === '::1' ||
    addr === '[::1]' ||
    addr === 'localhost'
  ) {
    return 'loopback'
  }
  if (
    addr.startsWith('10.') ||
    addr.startsWith('192.168.') ||
    addr.startsWith('169.254.') ||
    addr.startsWith('fe80:') ||
    addr.startsWith('[fe80:') ||
    addr.startsWith('fc00:') ||
    addr.startsWith('fd00:') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(addr)
  ) {
    return 'lan'
  }
  if (protocol.toUpperCase() === 'UDP' && (addr === '*:*' || addr === '0.0.0.0')) {
    return 'listening'
  }
  return 'public'
}

const PRESET_ITEMS: CapabilityActionItem[] = [
  {
    id: 'flow-realtime-rank',
    title: '实时进程带宽占用排行 (Top 流量监控)',
    subtitle: '监控各应用实时上下行速率 (KB/s) 与累计收发流量',
    tag: '实时监控',
    method: 'GetProcessList',
    params: { sortBy: 'download_rate' }
  },
  {
    id: 'flow-block-p2p',
    title: '拦截后台 P2P 偷跑上传进程',
    subtitle: '一键阻断异常高上传带宽的后台服务网络连接',
    tag: '断网拦截',
    method: 'BlockProcessNetwork',
    params: { processName: 'p2p_uploader.exe' }
  },
  {
    id: 'flow-limit-upload',
    title: '设置进程上传带宽限速 (200 KB/s)',
    subtitle: '防止后台同步占满上行带宽导致游戏或会议卡顿',
    tag: '上传限速',
    method: 'LimitProcessUploadSpeed',
    params: { limitKbps: 200 }
  },
  {
    id: 'flow-connections',
    title: '审查活跃远端 IP 与端口连接明细',
    subtitle: '查看各进程正在通信的远端服务器 IP 与连接状态',
    tag: '连接审计',
    method: 'GetProcessConnections',
    params: {}
  }
]

const FALLBACK_ENDPOINTS: PortEndpointItem[] = [
  {
    protocol: 'TCP',
    localAddress: '10.0.0.2',
    localPort: 54312,
    remoteAddress: '142.250.190.46',
    remotePort: 443,
    state: 'ESTABLISHED',
    pid: 14208,
    processName: 'chrome.exe',
    remoteScope: 'public'
  },
  {
    protocol: 'TCP',
    localAddress: '10.0.0.2',
    localPort: 54318,
    remoteAddress: '20.205.243.166',
    remotePort: 443,
    state: 'ESTABLISHED',
    pid: 19844,
    processName: 'Code.exe',
    remoteScope: 'public'
  },
  {
    protocol: 'TCP',
    localAddress: '10.0.0.2',
    localPort: 51820,
    remoteAddress: '10.0.0.1',
    remotePort: 53,
    state: 'ESTABLISHED',
    pid: 1044,
    processName: 'svchost.exe',
    remoteScope: 'lan'
  },
  {
    protocol: 'TCP',
    localAddress: '127.0.0.1',
    localPort: 18580,
    remoteAddress: '0.0.0.0',
    remotePort: 0,
    state: 'LISTENING',
    pid: 22104,
    processName: 'ZTools.exe',
    remoteScope: 'listening'
  },
  {
    protocol: 'TCP',
    localAddress: '0.0.0.0',
    localPort: 3000,
    remoteAddress: '0.0.0.0',
    remotePort: 0,
    state: 'LISTENING',
    pid: 28440,
    processName: 'node.exe',
    remoteScope: 'listening'
  },
  {
    protocol: 'UDP',
    localAddress: '127.0.0.1',
    localPort: 5353,
    remoteAddress: '127.0.0.1',
    remotePort: 5353,
    state: 'BOUND',
    pid: 22104,
    processName: 'ZTools.exe',
    remoteScope: 'loopback'
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

/**
 * 采集本机真实活动网络连接与五元组端口画像
 */
export async function fetchFlowGuardSnapshot(hostOverride?: any): Promise<FlowGuardSnapshot> {
  const [portsRes, procsRes] = await Promise.all([
    callHostTransport<PortEndpointItem[]>('process_list_ports', {}, hostOverride),
    callHostTransport<Array<{ pid: number; name: string; path: string; cpuUsage: number; memoryUsage: number }>>(
      'process_list',
      {},
      hostOverride
    )
  ])

  const procMap = new Map<number, { name: string; path: string; cpuUsage: number; memoryUsage: number }>()
  if (procsRes.ok && Array.isArray(procsRes.data)) {
    for (const p of procsRes.data) {
      procMap.set(Number(p.pid), {
        name: String(p.name || ''),
        path: String(p.path || ''),
        cpuUsage: typeof p.cpuUsage === 'number' ? p.cpuUsage : 0,
        memoryUsage: typeof p.memoryUsage === 'number' ? p.memoryUsage : 0
      })
    }
  }

  const rawPorts =
    portsRes.ok && Array.isArray(portsRes.data)
      ? portsRes.data
      : !hostOverride && !isRealElectronHost()
      ? FALLBACK_ENDPOINTS
      : []
  const groupMap = new Map<number, ProcessNetworkGroup>()

  let totalEstablished = 0
  let totalListening = 0
  let totalUdp = 0
  let totalPublic = 0
  let totalLan = 0
  let totalLoopback = 0

  for (const ep of rawPorts) {
    const pid = Number(ep.pid || 0)
    const procInfo = procMap.get(pid)
    const rawName = String(ep.processName || procInfo?.name || (pid === 4 ? 'System' : `PID-${pid}`))
    const processName = rawName.endsWith('.exe') || rawName === 'System' ? rawName : `${rawName}.exe`
    const proto = String(ep.protocol || 'TCP').toUpperCase()
    const state = String(ep.state || '').toUpperCase()
    const remoteAddress = String(ep.remoteAddress || '*')
    const remoteScope = classifyRemoteIpScope(remoteAddress, state, proto)

    if (proto === 'UDP') totalUdp += 1
    if (state === 'ESTABLISHED') totalEstablished += 1
    if (state === 'LISTENING' || state === 'LISTEN') totalListening += 1
    if (remoteScope === 'public') totalPublic += 1
    else if (remoteScope === 'lan') totalLan += 1
    else if (remoteScope === 'loopback') totalLoopback += 1

    let group = groupMap.get(pid)
    if (!group) {
      group = {
        pid,
        processName,
        processPath: procInfo?.path || '',
        cpuPercent: procInfo?.cpuUsage || 0,
        memoryBytes: procInfo?.memoryUsage || 0,
        tcpCount: 0,
        udpCount: 0,
        establishedCount: 0,
        listeningCount: 0,
        publicCount: 0,
        lanCount: 0,
        loopbackCount: 0,
        endpoints: [],
        isProtected: pid <= 4 || FORBIDDEN_TARGET_PATTERN.test(processName) || FORBIDDEN_TARGET_PATTERN.test(rawName)
      }
      groupMap.set(pid, group)
    }

    if (proto === 'UDP') {
      group.udpCount += 1
    } else {
      group.tcpCount += 1
    }
    if (state === 'ESTABLISHED') group.establishedCount += 1
    if (state === 'LISTENING' || state === 'LISTEN') group.listeningCount += 1
    if (remoteScope === 'public') group.publicCount += 1
    else if (remoteScope === 'lan') group.lanCount += 1
    else if (remoteScope === 'loopback') group.loopbackCount += 1

    group.endpoints.push({
      protocol: proto,
      localAddress: String(ep.localAddress || '0.0.0.0'),
      localPort: Number(ep.localPort || 0),
      remoteAddress,
      remotePort: Number(ep.remotePort || 0),
      state: state || (proto === 'UDP' ? 'BOUND' : 'ACTIVE'),
      pid,
      processName,
      remoteScope
    })
  }

  const groups = Array.from(groupMap.values()).sort((a, b) => {
    if (b.publicCount !== a.publicCount) return b.publicCount - a.publicCount
    if (b.establishedCount !== a.establishedCount) return b.establishedCount - a.establishedCount
    return b.endpoints.length - a.endpoints.length
  })

  return {
    groups,
    totalEndpoints: rawPorts.length,
    totalEstablished,
    totalListening,
    totalUdp,
    totalPublic,
    totalLan,
    totalLoopback
  }
}

export async function terminateNetworkProcess(
  pid: number,
  processName: string,
  hostOverride?: any
): Promise<{ ok: boolean; error?: string }> {
  const cleanName = String(processName || '').replace(/\.exe$/i, '')
  if (
    !Number.isInteger(pid) ||
    pid <= 4 ||
    FORBIDDEN_TARGET_PATTERN.test(processName) ||
    FORBIDDEN_TARGET_PATTERN.test(`${cleanName}.exe`)
  ) {
    return { ok: false, error: FORBIDDEN_REASON }
  }

  // 优先通过宿主 ProcessMonitorPlugin.TerminateProcessByPID 执行带系统白名单校验的终止
  const guardedRes = await callHostTransport<any>(
    'dllplugin_call',
    {
      plugin: 'ProcessMonitorPlugin',
      func: 'TerminateProcessByPID',
      params: { pid, processName, force: true }
    },
    hostOverride
  )
  if (guardedRes.ok && guardedRes.data?.ok !== false) {
    return { ok: true }
  }
  if (guardedRes.error && /禁止|保护|SYSTEM|拒绝/i.test(guardedRes.error)) {
    return { ok: false, error: guardedRes.error }
  }

  const res = await callHostTransport('process_kill', { pid, force: true }, hostOverride)
  if (res.ok) return { ok: true }
  return { ok: false, error: res.error || guardedRes.error || '终止联网进程失败' }
}

export async function openNetworkProcessLocation(
  processPath: string,
  hostOverride?: any
): Promise<boolean> {
  if (!processPath) return false
  return showRealItemInFolder(processPath, hostOverride)
}
