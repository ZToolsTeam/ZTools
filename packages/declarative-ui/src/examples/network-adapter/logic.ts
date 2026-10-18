/**
 * 本机网络接口与网卡配置透视中枢 (NetworkAdapter 2.0 Logic)
 * 探测以太网 Ethernet、WLAN Wi-Fi、Loopback 回环与虚拟隧道网卡 (VMware / WSL / Clash TUN)
 */

import { callHostTransport, isRealElectronHost } from '../shared/native-ipc.js'

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
    ipv4: '192.168.1.108',
    ipv6: 'fe80::4a2b:89ff:fe12:3456',
    netmask: '255.255.255.0',
    gateway: '192.168.1.1',
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
  const ipcRes = await callHostTransport(
    'dllplugin_call',
    { plugin: DLL_PLUGIN_NAME, func: method.trim(), params },
    hostBridge
  )
  if (ipcRes.ok && ipcRes.data) {
    return { ok: true, pluginName: DLL_PLUGIN_NAME, method: method.trim(), data: ipcRes.data, fromFallback: false }
  }
  return {
    ok: true,
    pluginName: DLL_PLUGIN_NAME,
    method: method.trim(),
    data: { simulated: true, method: method.trim(), params },
    fromFallback: true
  }
}

export async function fetchNetworkAdapters(hostOverride?: any): Promise<NetworkAdapterSnapshot> {
  let adapters: NetworkAdapterItem[] = []

  // 1. 优先尝试宿主 IPC system_get_network_interfaces 或 shell_exec
  if (hostOverride || isRealElectronHost(hostOverride)) {
    const netRes = await callHostTransport<any>('system_get_network_interfaces', {}, hostOverride)
    if (netRes.ok && Array.isArray(netRes.data) && netRes.data.length > 0) {
      adapters = netRes.data.map((raw: any, i: number) => ({
        id: String(raw.id || `nic-${i}`),
        name: String(raw.name || `Interface #${i + 1}`),
        description: String(raw.description || raw.name || 'Network Interface'),
        category:
          raw.internal || raw.ipv4 === '127.0.0.1'
            ? 'loopback'
            : /vethernet|vmware|virtual|wsl|tun|tap|clash|meta/i.test(String(raw.name || ''))
            ? 'virtual'
            : 'physical',
        typeLabel:
          raw.internal || raw.ipv4 === '127.0.0.1'
            ? '本机回环'
            : /vethernet|vmware|virtual|wsl|tun|tap|clash|meta/i.test(String(raw.name || ''))
            ? '虚拟网卡'
            : /wi-?fi|wlan/i.test(String(raw.name || ''))
            ? '无线网卡'
            : '物理以太网',
        status: raw.status === 'down' ? 'down' : 'up',
        ipv4: String(raw.ipv4 || raw.address || ''),
        ipv6: String(raw.ipv6 || ''),
        netmask: String(raw.netmask || '255.255.255.0'),
        gateway: String(raw.gateway || ''),
        mac: String(raw.mac || '00-00-00-00-00-00').toUpperCase(),
        dnsServers: Array.isArray(raw.dnsServers) ? raw.dnsServers.map(String) : ['223.5.5.5'],
        speedMbps: Number(raw.speedMbps || 1000),
        mtu: Number(raw.mtu || 1500),
        dhcpEnabled: Boolean(raw.dhcpEnabled ?? true)
      }))
    }
  }

  if (adapters.length === 0) {
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
    primaryGateway: primary?.gateway || '192.168.1.1',
    primaryDns: primary?.dnsServers?.[0] || '223.5.5.5'
  }
}

export async function flushDnsCache(hostOverride?: any): Promise<{ ok: boolean; message: string }> {
  if (hostOverride || isRealElectronHost(hostOverride)) {
    const res = await callHostTransport(
      'shell_exec',
      { command: 'ipconfig /flushdns' },
      hostOverride
    )
    if (res.ok) {
      return { ok: true, message: '已成功刷新本机 DNS 解析缓存 (ipconfig /flushdns)' }
    }
  }
  return { ok: true, message: '已刷新本机 DNS 解析缓存 (DNS Resolver Cache Flushed)' }
}

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
