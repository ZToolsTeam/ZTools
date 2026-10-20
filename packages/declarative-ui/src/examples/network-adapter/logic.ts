/**
 * 本机网络接口与网卡配置透视中枢 (NetworkAdapter 2.0 Logic)
 * 探测以太网 Ethernet、WLAN Wi-Fi、Loopback 回环与虚拟隧道网卡 (VMware / WSL / Clash TUN)
 */

import { callHostTransport, invokePluginService, isRealElectronHost, invokeDllPluginCapability } from '../shared/native-ipc.js'

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

export type AdapterCategory = 'physical' | 'virtual' | 'loopback'
export type AdapterFilterMode = 'all' | 'physical' | 'virtual' | 'connected'

export interface NetworkAdapterItem {
  id: string
  name: string
  description: string
  category: AdapterCategory
  typeLabel: string
  status: 'up' | 'down'
  ipv4: string
  ipv6: string
  netmask: string
  gateway: string
  mac: string
  dnsServers: string[]
  speedMbps: number
  mtu: number
  dhcpEnabled: boolean
}

export interface NetworkAdapterSnapshot {
  adapters: NetworkAdapterItem[]
  activeCount: number
  physicalCount: number
  virtualCount: number
  primaryIpv4: string
  primaryGateway: string
  primaryDns: string
}

export const DLL_PLUGIN_NAME = 'NetworkAdapterPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp('^(?:DISABLE_ALL_NIC| SPOOF_KERNEL_MAC_UNSAFE)$', 'i')
export const FORBIDDEN_REASON = '禁止批量禁用全部活动网卡以免导致远程会话或系统网络彻底中断'

const PRESET_ITEMS: CapabilityActionItem[] = [
  {
    id: 'nic-list-all',
    title: '枚举本机全部物理与虚拟网络适配器',
    subtitle: '读取 IPv4/IPv6、子网掩码、MAC 物理地址、默认网关与链路速率',
    tag: '网卡枚举',
    method: 'GetNetworkAdapters',
    params: { includeLoopback: true }
  },
  {
    id: 'nic-flush-dns',
    title: '刷新操作系统 DNS 解析缓存 (ipconfig /flushdns)',
    subtitle: '立即清空本机陈旧域名解析记录并重新查询上游 DNS',
    tag: 'DNS刷新',
    method: 'FlushDnsCache',
    params: {}
  }
]

const FALLBACK_ADAPTERS: NetworkAdapterItem[] = [
  {
    id: 'nic-wlan0',
    name: 'WLAN (Wi-Fi 6E)',
    description: 'Intel(R) Wi-Fi 6E AX211 160MHz',
    category: 'physical',
    typeLabel: '无线网卡',
    status: 'up',
    ipv4: '10.0.0.2',
    ipv6: 'fe80::4a2b:89ff:fe12:3456',
    netmask: '255.255.255.0',
    gateway: '10.0.0.1',
    mac: 'A4-B1-C2-D3-E4-F5',
    dnsServers: ['223.5.5.5', '114.114.114.114'],
    speedMbps: 1201,
    mtu: 1500,
    dhcpEnabled: true
  },
  {
    id: 'nic-eth0',
    name: '以太网 (Ethernet)',
    description: 'Realtek Gaming 2.5GbE Family Controller',
    category: 'physical',
    typeLabel: '物理以太网',
    status: 'up',
    ipv4: '10.0.10.56',
    ipv6: 'fe80::9c8d:7eff:fe65:4321',
    netmask: '255.255.255.0',
    gateway: '10.0.10.1',
    mac: '00-E0-4C-68-12-9A',
    dnsServers: ['119.29.29.29', '1.1.1.1'],
    speedMbps: 2500,
    mtu: 1500,
    dhcpEnabled: true
  },
  {
    id: 'nic-wsl',
    name: 'vEthernet (WSL / Hyper-V)',
    description: 'Hyper-V Virtual Ethernet Adapter',
    category: 'virtual',
    typeLabel: '虚拟交换机',
    status: 'up',
    ipv4: '172.24.160.1',
    ipv6: 'fe80::1020:30ff:fe40:5060',
    netmask: '255.255.240.0',
    gateway: '',
    mac: '00-15-5D-8A-B1-02',
    dnsServers: ['172.24.160.1'],
    speedMbps: 10000,
    mtu: 1500,
    dhcpEnabled: false
  },
  {
    id: 'nic-tun',
    name: 'Meta / Clash TUN',
    description: 'Wintun Userspace Tunnel Network Adapter',
    category: 'virtual',
    typeLabel: '隧道网卡',
    status: 'up',
    ipv4: '198.18.0.1',
    ipv6: 'fdfe:dcba:9876::1',
    netmask: '255.254.0.0',
    gateway: '198.18.0.1',
    mac: '00-FF-98-18-00-01',
    dnsServers: ['198.18.0.2'],
    speedMbps: 10000,
    mtu: 9000,
    dhcpEnabled: false
  },
  {
    id: 'nic-vmware',
    name: 'VMware Network Adapter VMnet8',
    description: 'VMware Virtual Ethernet Adapter for VMnet8 (NAT)',
    category: 'virtual',
    typeLabel: '虚拟网卡',
    status: 'up',
    ipv4: '192.168.188.1',
    ipv6: 'fe80::250:56ff:fec0:8',
    netmask: '255.255.255.0',
    gateway: '',
    mac: '00-50-56-C0-00-08',
    dnsServers: [],
    speedMbps: 1000,
    mtu: 1500,
    dhcpEnabled: false
  },
  {
    id: 'nic-loopback',
    name: 'Loopback Pseudo-Interface 1',
    description: 'Software Loopback Interface 1',
    category: 'loopback',
    typeLabel: '本机回环',
    status: 'up',
    ipv4: '127.0.0.1',
    ipv6: '::1',
    netmask: '255.0.0.0',
    gateway: '',
    mac: '00-00-00-00-00-00',
    dnsServers: ['127.0.0.1'],
    speedMbps: 10000,
    mtu: 65535,
    dhcpEnabled: false
  }
]

export function getCapabilityItems(): CapabilityActionItem[] {
  return PRESET_ITEMS.map((item) => ({ ...item, params: { ...item.params } }))
}

export function filterCapabilityItems(items: CapabilityActionItem[], query: string): CapabilityActionItem[] {
  if (!Array.isArray(items)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return items
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.tag.toLowerCase().includes(q) ||
      item.method.toLowerCase().includes(q)
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

function parseAdapterSpeedMbps(raw: any): number {
  if (typeof raw?.speedMbps === 'number' && Number.isFinite(raw.speedMbps) && raw.speedMbps > 0) {
    return raw.speedMbps
  }
  if (typeof raw?.linkSpeed === 'string' && raw.linkSpeed.trim()) {
    const match = raw.linkSpeed.trim().match(/^(\d+(?:\.\d+)?)\s*(gbps|mbps|kbps)?/i)
    if (match) {
      const val = parseFloat(match[1])
      const unit = (match[2] || 'mbps').toLowerCase()
      if (unit === 'gbps') return Math.round(val * 1000)
      if (unit === 'kbps') return Math.max(1, Math.round(val / 1000))
      return Math.round(val)
    }
  }
  if (typeof raw?.linkSpeed === 'number' && Number.isFinite(raw.linkSpeed) && raw.linkSpeed > 0) {
    return raw.linkSpeed
  }
  return 1000
}

function parseAdapterDnsServers(raw: any): string[] {
  if (Array.isArray(raw?.dnsServers)) {
    return raw.dnsServers.map(String).map((s: string) => s.trim()).filter(Boolean)
  }
  if (Array.isArray(raw?.dns)) {
    return raw.dns.map(String).map((s: string) => s.trim()).filter(Boolean)
  }
  if (typeof raw?.dns === 'string' && raw.dns.trim()) {
    return raw.dns
      .split(/[,;\s]+/)
      .map((s: string) => s.trim())
      .filter(Boolean)
  }
  return []
}

function mapRawAdapter(raw: any, i: number): NetworkAdapterItem {
  const nameStr = String(raw.name || `Interface #${i + 1}`)
  const isLoopback = Boolean(raw.internal || raw.ipv4 === '127.0.0.1' || raw.category === 'loopback')
  const isVirtual = Boolean(
    raw.category === 'virtual' || /vethernet|vmware|virtual|wsl|tun|tap|clash|meta/i.test(nameStr)
  )
  const statusStr = String(raw.status || '').toLowerCase()
  const isDown =
    statusStr.includes('down') ||
    statusStr.includes('disconnected') ||
    statusStr.includes('disabled') ||
    statusStr.includes('offline')

  return {
    id: String(raw.id || `nic-${i}`),
    name: nameStr,
    description: String(raw.description || raw.name || 'Network Interface'),
    category: isLoopback ? 'loopback' : isVirtual ? 'virtual' : 'physical',
    typeLabel: String(
      raw.typeLabel ||
        (isLoopback
          ? '本机回环'
          : isVirtual
          ? '虚拟网卡'
          : /wi-?fi|wlan/i.test(nameStr)
          ? '无线网卡'
          : '物理以太网')
    ),
    status: isDown ? 'down' : 'up',
    ipv4: String(raw.ipv4 || raw.address || ''),
    ipv6: String(raw.ipv6 || ''),
    netmask: String(raw.netmask || '255.255.255.0'),
    gateway: String(raw.gateway || ''),
    mac: String(raw.mac || '00-00-00-00-00-00').toUpperCase(),
    dnsServers: parseAdapterDnsServers(raw),
    speedMbps: parseAdapterSpeedMbps(raw),
    mtu: Number(raw.mtu || 1500),
    dhcpEnabled: Boolean(raw.dhcpEnabled ?? true)
  }
}

export async function fetchNetworkAdapters(hostOverride?: any): Promise<NetworkAdapterSnapshot> {
  const realHost = isRealElectronHost(hostOverride) || Boolean(hostOverride)
  let adapters: NetworkAdapterItem[] = []
  let resolvedFromHost = false

  if (realHost) {
    // 1. 优先调用 NetworkAdapterPlugin.getAdapters (聚合 os.networkInterfaces + Get-NetIPConfiguration)
    const pluginRes = await invokePluginService<any>(DLL_PLUGIN_NAME, 'getAdapters', {}, hostOverride)
    if (pluginRes.ok && pluginRes.data) {
      const rawList = Array.isArray(pluginRes.data)
        ? pluginRes.data
        : Array.isArray(pluginRes.data.adapters)
        ? pluginRes.data.adapters
        : null
      if (rawList) {
        adapters = rawList.map(mapRawAdapter)
        resolvedFromHost = true
      }
    }

    // 2. 回退尝试 system_get_network_interfaces
    if (!resolvedFromHost) {
      const netRes = await callHostTransport<any>('system_get_network_interfaces', {}, hostOverride)
      if (netRes.ok && Array.isArray(netRes.data)) {
        adapters = netRes.data.map(mapRawAdapter)
        resolvedFromHost = true
      }
    }
  }

  // 仅在非真实 Electron 宿主且宿主未返回结果时使用离线预览数据
  if (!resolvedFromHost && !isRealElectronHost(hostOverride)) {
    adapters = FALLBACK_ADAPTERS.map((a) => ({ ...a, dnsServers: [...a.dnsServers] }))
  }

  const activeCount = adapters.filter((a) => a.status === 'up').length
  const physicalCount = adapters.filter((a) => a.category === 'physical').length
  const virtualCount = adapters.filter((a) => a.category === 'virtual').length
  const primary = adapters.find((a) => a.category === 'physical' && a.status === 'up') || adapters[0]

  return {
    adapters,
    activeCount,
    physicalCount,
    virtualCount,
    primaryIpv4: primary?.ipv4 || '127.0.0.1',
    primaryGateway: primary?.gateway || '',
    primaryDns: primary?.dnsServers?.[0] || ''
  }
}

const IPV4_REGEX = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export async function applyDnsPreset(
  adapterIdOrName: string,
  primaryDns: string,
  secondaryDns?: string,
  hostOverride?: any
): Promise<{ ok: boolean; adapterId: string; dnsServers: string[]; message: string }> {
  const name = typeof adapterIdOrName === 'string' ? adapterIdOrName.trim() : ''
  const pDns = typeof primaryDns === 'string' ? primaryDns.trim() : ''
  const sDns = typeof secondaryDns === 'string' ? secondaryDns.trim() : ''

  if (!name) {
    return { ok: false, adapterId: '', dnsServers: [], message: '目标网卡名称或 ID 不能为空' }
  }
  const isDhcp = pDns.toLowerCase() === 'dhcp' || pDns.toLowerCase() === 'auto'
  if (!isDhcp && !IPV4_REGEX.test(pDns)) {
    return { ok: false, adapterId: name, dnsServers: [], message: `首选 DNS 地址格式不合法: ${pDns}` }
  }
  if (!isDhcp && sDns && !IPV4_REGEX.test(sDns)) {
    return { ok: false, adapterId: name, dnsServers: [], message: `备选 DNS 地址格式不合法: ${sDns}` }
  }

  const dnsServers = isDhcp ? [] : sDns ? [pDns, sDns] : [pDns]

  if (hostOverride || isRealElectronHost(hostOverride)) {
    const res = await invokePluginService<any>(
      DLL_PLUGIN_NAME,
      'applyDnsPreset',
      {
        adapterId: name,
        name,
        primaryDns: isDhcp ? 'dhcp' : pDns,
        secondaryDns: isDhcp ? '' : sDns,
        dnsServers
      },
      hostOverride
    )
    if (res.ok) {
      return {
        ok: true,
        adapterId: name,
        dnsServers,
        message: String(
          res.data?.message ||
            (isDhcp ? `已将网卡 [${name}] 恢复为 DHCP 自动获取 DNS` : `已将网卡 [${name}] DNS 切换为 ${dnsServers.join(', ')}`)
        )
      }
    }
    return {
      ok: false,
      adapterId: name,
      dnsServers: [],
      message: res.error || `切换网卡 [${name}] DNS 失败（需要管理员权限执行 netsh interface ip set dns）`
    }
  }

  return {
    ok: true,
    adapterId: name,
    dnsServers,
    message: isDhcp ? `已恢复 [${name}] 自动 DNS (离线预览)` : `已切换 [${name}] DNS 至 ${dnsServers.join(', ')} (离线预览)`
  }
}

export async function flushSystemDnsCache(hostOverride?: any): Promise<{ ok: boolean; message: string }> {
  if (hostOverride || isRealElectronHost(hostOverride)) {
    const pluginRes = await invokePluginService<any>(DLL_PLUGIN_NAME, 'flushDns', {}, hostOverride)
    if (pluginRes.ok) {
      return {
        ok: true,
        message: String(pluginRes.data?.message || '已成功刷新本机 DNS 解析缓存 (ipconfig /flushdns)')
      }
    }
    const shellRes = await callHostTransport(
      'shell_exec',
      { command: 'ipconfig /flushdns' },
      hostOverride
    )
    if (shellRes.ok) {
      return { ok: true, message: '已成功刷新本机 DNS 解析缓存 (ipconfig /flushdns)' }
    }
    return {
      ok: false,
      message: pluginRes.error || shellRes.error || '刷新 DNS 解析缓存失败'
    }
  }
  return { ok: true, message: '已刷新本机 DNS 解析缓存 (DNS Resolver Cache Flushed)' }
}

export const flushDnsCache = flushSystemDnsCache

export function copyAdapterInfo(
  adapter: NetworkAdapterItem,
  format: 'ipv4' | 'mac' | 'json' | 'summary' = 'ipv4'
): string {
  if (!adapter) return ''
  if (format === 'ipv4') return adapter.ipv4 || adapter.ipv6 || ''
  if (format === 'mac') return adapter.mac || ''
  if (format === 'json') return JSON.stringify(adapter, null, 2)
  return `${adapter.name} | IPv4: ${adapter.ipv4} | 子网掩码: ${adapter.netmask} | 网关: ${adapter.gateway || '-'} | MAC: ${adapter.mac} | DNS: ${adapter.dnsServers.join(', ') || '-'}`
}

export function filterNetworkAdapters(
  adapters: NetworkAdapterItem[],
  query: string,
  filterMode: AdapterFilterMode | string = 'all'
): NetworkAdapterItem[] {
  if (!Array.isArray(adapters)) return []
  let list = adapters
  if (filterMode === 'physical') {
    list = list.filter((a) => a.category === 'physical')
  } else if (filterMode === 'virtual') {
    list = list.filter((a) => a.category === 'virtual' || a.category === 'loopback')
  } else if (filterMode === 'connected') {
    list = list.filter((a) => a.status === 'up')
  }

  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return list
  return list.filter(
    (a) =>
      a.name.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      a.ipv4.toLowerCase().includes(q) ||
      a.ipv6.toLowerCase().includes(q) ||
      a.mac.toLowerCase().includes(q) ||
      a.typeLabel.toLowerCase().includes(q) ||
      a.dnsServers.some((d) => d.toLowerCase().includes(q))
  )
}
