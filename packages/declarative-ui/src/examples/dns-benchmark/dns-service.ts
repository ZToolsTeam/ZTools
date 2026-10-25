import { callHostTransport } from '../shared/native-ipc.js'
import type {
  ActiveNetworkAdapter,
  DnsActionResponse,
  DnsBenchmarkItem,
  DnsProviderPreset
} from './types.js'

export const PUBLIC_DNS_PRESETS: readonly DnsProviderPreset[] = Object.freeze([
  {
    id: 'alidns',
    name: '阿里云公共 DNS',
    category: 'domestic',
    categoryLabel: '国内极速',
    primary: '223.5.5.5',
    secondary: '223.6.6.6',
    description: '国内三网 BGP 节点最全，综合解析延迟最低'
  },
  {
    id: 'dnspod',
    name: '腾讯云 DNSPod',
    category: 'domestic',
    categoryLabel: '国内极速',
    primary: '119.29.29.29',
    secondary: '182.254.116.116',
    description: '微信/腾讯系服务与南方电信联通极快'
  },
  {
    id: '114dns',
    name: '114 公共 DNS',
    category: 'domestic',
    categoryLabel: '国内极速',
    primary: '114.114.114.114',
    secondary: '114.114.115.115',
    description: '国内老牌高稳定运营商骨干基础解析'
  },
  {
    id: 'volcdns',
    name: '火山引擎字节 DNS',
    category: 'domestic',
    categoryLabel: '国内极速',
    primary: '180.184.1.1',
    secondary: '180.184.2.2',
    description: '抖音/飞书/字节系及北方联通表现优异'
  },
  {
    id: 'baidudns',
    name: '百度公共 DNS',
    category: 'domestic',
    categoryLabel: '国内极速',
    primary: '180.76.76.76',
    secondary: '114.114.114.114',
    description: '百度智能云 BGP 加速节点'
  },
  {
    id: 'cnnic-sdns',
    name: 'CNNIC SDNS',
    category: 'domestic',
    categoryLabel: '国内极速',
    primary: '1.2.4.8',
    secondary: '210.2.4.8',
    description: '中国互联网络信息中心国家权威节点'
  },
  {
    id: '114-safe',
    name: '114 安全防劫持 DNS',
    category: 'security',
    categoryLabel: '安全纯净',
    primary: '114.114.114.119',
    secondary: '114.114.115.119',
    description: '自动拦截钓鱼网站与恶意木马域名'
  },
  {
    id: '360-safe',
    name: '360 安全 DNS',
    category: 'security',
    categoryLabel: '安全纯净',
    primary: '101.226.4.6',
    secondary: '218.30.118.6',
    description: '恶意欺诈网站拦截保护'
  },
  {
    id: 'onedns-clean',
    name: 'OneDNS 纯净版',
    category: 'security',
    categoryLabel: '安全纯净',
    primary: '117.50.10.10',
    secondary: '52.80.52.52',
    description: '微步在线联合运营，无劫持防恶意域名'
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare DNS',
    category: 'global',
    categoryLabel: '海外/国际',
    primary: '1.1.1.1',
    secondary: '1.0.0.1',
    description: '全球 Anycast 隐私优先，跨境开发者首选'
  },
  {
    id: 'google-dns',
    name: 'Google Public DNS',
    category: 'global',
    categoryLabel: '海外/国际',
    primary: '8.8.8.8',
    secondary: '8.8.4.4',
    description: '国际权威标准解析，海外服务无污染'
  },
  {
    id: 'quad9',
    name: 'Quad9 安全 DNS',
    category: 'global',
    categoryLabel: '海外/国际',
    primary: '9.9.9.9',
    secondary: '149.112.112.112',
    description: 'IBM 联合非营利安全无污染解析'
  },
  {
    id: 'opendns',
    name: 'OpenDNS (Cisco)',
    category: 'global',
    categoryLabel: '海外/国际',
    primary: '208.67.222.222',
    secondary: '208.67.220.220',
    description: '思科国际高速企业级解析服务'
  },
  {
    id: 'adguard-dns',
    name: 'AdGuard DNS',
    category: 'global',
    categoryLabel: '海外/国际',
    primary: '94.140.14.14',
    secondary: '94.140.15.15',
    description: 'DNS 层过滤追踪器与弹窗广告域名'
  },
  {
    id: 'controld',
    name: 'Control D 无过滤 DNS',
    category: 'global',
    categoryLabel: '海外/国际',
    primary: '76.76.2.0',
    secondary: '76.76.10.0',
    description: '北美与亚太低延迟 Anycast 公共解析'
  }
])

export function isValidIpv4Address(ip: string): boolean {
  if (typeof ip !== 'string') return false
  const trimmed = ip.trim()
  const m = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  for (let i = 1; i <= 4; i++) {
    const part = Number(m[i])
    if (!Number.isInteger(part) || part < 0 || part > 255) return false
  }
  return true
}

export function isSafeAdapterName(name: string): boolean {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (!trimmed || trimmed.length > 120) return false
  return !/[;&|`$<>\\"\r\n\0]/.test(trimmed)
}

export async function getActiveNetworkAdapters(
  hostOverride?: unknown
): Promise<ActiveNetworkAdapter[]> {
  const res = await callHostTransport<Record<string, unknown>>(
    'dllplugin_call',
    {
      plugin: 'DnsBenchmarkPlugin',
      func: 'getActiveAdapters',
      params: {}
    },
    hostOverride
  )
  if (res.ok && res.data && Array.isArray(res.data.adapters)) {
    return (res.data.adapters as Array<Record<string, unknown>>).map((a) => {
      const currentDns = Array.isArray(a.currentDns) ? a.currentDns.map(String) : []
      return {
        name: String(a.name ?? 'WLAN'),
        description: String(a.description ?? a.name ?? 'WLAN'),
        ipv4: String(a.ipv4 ?? '192.168.1.100'),
        isDhcp: Boolean(a.isDhcp ?? currentDns.length === 0),
        currentDns
      }
    })
  }
  if (!res.ok) {
    throw new Error(res.error || 'DNS_ADAPTER_QUERY_FAILED: 无法枚举系统活动网卡')
  }
  return []
}

export function sortAndMarkDnsItems(
  presets: readonly DnsProviderPreset[],
  probeResults: ReadonlyArray<{
    id?: string
    primary?: string
    avgMs?: number
    primaryMs?: number | null
    secondaryMs?: number | null
    timeout?: boolean
  }>,
  activeDnsList: readonly string[] = []
): DnsBenchmarkItem[] {
  const activeSet = new Set(activeDnsList.map((ip) => ip.trim()))
  const resultById = new Map<string, (typeof probeResults)[number]>()
  for (const r of probeResults) {
    if (r.id) resultById.set(r.id, r)
    if (r.primary) resultById.set(r.primary, r)
  }

  const items: DnsBenchmarkItem[] = presets.map((preset) => {
    const matched = resultById.get(preset.id) ?? resultById.get(preset.primary)
    const timeout = Boolean(matched?.timeout ?? (matched === undefined))
    const rawAvg = Number(matched?.avgMs ?? 1500)
    const avgMs = Number.isFinite(rawAvg) && rawAvg > 0 ? Math.round(rawAvg) : 1500
    const isCurrentActive =
      activeSet.has(preset.primary) || (Boolean(preset.secondary) && activeSet.has(preset.secondary))

    return {
      ...preset,
      avgMs: timeout ? 1500 : avgMs,
      primaryMs: matched?.primaryMs ?? (timeout ? null : avgMs),
      secondaryMs: matched?.secondaryMs ?? (timeout ? null : avgMs + 2),
      timeout,
      isCurrentActive
    }
  })

  items.sort((a, b) => {
    if (a.timeout !== b.timeout) return a.timeout ? 1 : -1
    if (a.avgMs !== b.avgMs) return a.avgMs - b.avgMs
    return a.name.localeCompare(b.name, 'zh-CN')
  })

  return items
}

export async function runDnsBenchmark(
  activeDnsList: readonly string[] = [],
  hostOverride?: unknown,
  presets: readonly DnsProviderPreset[] = PUBLIC_DNS_PRESETS
): Promise<{ items: DnsBenchmarkItem[]; fastestDns: DnsBenchmarkItem | null; allTimeout: boolean }> {
  const res = await callHostTransport<Record<string, unknown>>(
    'dllplugin_call',
    {
      plugin: 'DnsBenchmarkPlugin',
      func: 'benchmarkDns',
      params: {
        servers: presets.map((p) => ({
          id: p.id,
          primary: p.primary,
          secondary: p.secondary
        }))
      }
    },
    hostOverride
  )

  const rawResults =
    res.ok && res.data && Array.isArray(res.data.results)
      ? (res.data.results as Array<{
          id?: string
          primary?: string
          avgMs?: number
          primaryMs?: number | null
          secondaryMs?: number | null
          timeout?: boolean
        }>)
      : []

  const sorted = sortAndMarkDnsItems(presets, rawResults, activeDnsList)
  const fastestDns = sorted.find((item) => !item.timeout) ?? null
  const allTimeout = sorted.every((item) => item.timeout)
  return {
    items: sorted,
    fastestDns,
    allTimeout
  }
}

export async function applyAdapterDns(
  adapterName: string,
  primary: string,
  secondary = '',
  hostOverride?: unknown
): Promise<DnsActionResponse> {
  if (!isSafeAdapterName(adapterName)) {
    return {
      ok: false,
      errorCode: 'INVALID_ADAPTER_NAME',
      error: 'INVALID_ADAPTER_NAME: 网卡名称不合法或包含非法字符'
    }
  }
  if (!isValidIpv4Address(primary) || (secondary && !isValidIpv4Address(secondary))) {
    return {
      ok: false,
      errorCode: 'INVALID_DNS_IP',
      error: `INVALID_DNS_IP: 非法的 IPv4 地址格式 (${primary}${secondary ? `, ${secondary}` : ''})`
    }
  }

  const res = await callHostTransport<Record<string, unknown>>(
    'dllplugin_call',
    {
      plugin: 'DnsBenchmarkPlugin',
      func: 'applyDns',
      params: {
        adapterName: adapterName.trim(),
        primary: primary.trim(),
        secondary: secondary.trim(),
        executeSystemModify: hostOverride === undefined
      }
    },
    hostOverride
  )

  if (!res.ok || (res.data && res.data.ok === false)) {
    const errText = String(res.data?.error ?? res.error ?? '修改网卡 DNS 失败')
    const codeMatch = errText.match(/^([A-Z0-9_]+):/)
    return {
      ok: false,
      errorCode: String(res.data?.errorCode ?? codeMatch?.[1] ?? 'APPLY_DNS_FAILED'),
      error: errText
    }
  }

  const currentDns = Array.isArray(res.data?.currentDns)
    ? (res.data.currentDns as unknown[]).map(String)
    : secondary
      ? [primary.trim(), secondary.trim()]
      : [primary.trim()]

  return {
    ok: true,
    adapterName: adapterName.trim(),
    currentDns,
    isDhcp: false,
    flushed: true
  }
}

export async function resetAdapterToDhcp(
  adapterName: string,
  hostOverride?: unknown
): Promise<DnsActionResponse> {
  if (!isSafeAdapterName(adapterName)) {
    return {
      ok: false,
      errorCode: 'INVALID_ADAPTER_NAME',
      error: 'INVALID_ADAPTER_NAME: 网卡名称不合法'
    }
  }

  const res = await callHostTransport<Record<string, unknown>>(
    'dllplugin_call',
    {
      plugin: 'DnsBenchmarkPlugin',
      func: 'resetDhcp',
      params: {
        adapterName: adapterName.trim(),
        executeSystemModify: hostOverride === undefined
      }
    },
    hostOverride
  )

  if (!res.ok || (res.data && res.data.ok === false)) {
    const errText = String(res.data?.error ?? res.error ?? '恢复 DHCP 自动获取 DNS 失败')
    const codeMatch = errText.match(/^([A-Z0-9_]+):/)
    return {
      ok: false,
      errorCode: String(res.data?.errorCode ?? codeMatch?.[1] ?? 'RESET_DHCP_FAILED'),
      error: errText
    }
  }

  return {
    ok: true,
    adapterName: adapterName.trim(),
    currentDns: [],
    isDhcp: true,
    flushed: true
  }
}

export async function flushSystemDnsCache(hostOverride?: unknown): Promise<DnsActionResponse> {
  const res = await callHostTransport<Record<string, unknown>>(
    'dllplugin_call',
    {
      plugin: 'DnsBenchmarkPlugin',
      func: 'flushCache',
      params: {}
    },
    hostOverride
  )
  if (!res.ok || (res.data && res.data.ok === false)) {
    return {
      ok: false,
      errorCode: 'FLUSH_DNS_FAILED',
      error: String(res.data?.error ?? res.error ?? '刷新 DNS 缓存失败')
    }
  }
  return {
    ok: true,
    flushed: true
  }
}
