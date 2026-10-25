import type { DnsRecordEntry, DnsRecordType, SslCertHealthReport } from './types.js'

const DNS_TYPE_CODE_MAP: Record<DnsRecordType, number> = {
  A: 1,
  CNAME: 5,
  MX: 15,
  TXT: 16,
  AAAA: 28,
}

export function normalizeDomainInput(raw: string): string {
  const trimmed = String(raw || '').trim()
  if (!trimmed) {
    throw new Error('EMPTY_DOMAIN_INPUT: 域名不能为空')
  }
  let hostname = trimmed
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    try {
      hostname = new URL(trimmed).hostname
    } catch {
      throw new Error(`INVALID_DOMAIN_URL: 无法从 URL 提取域名 (${trimmed})`)
    }
  } else {
    hostname = trimmed.split('/')[0].split(':')[0].trim()
  }

  if (
    !/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(
      hostname,
    )
  ) {
    throw new Error(`INVALID_DOMAIN_NAME: 域名格式不合法 (${hostname})`)
  }
  return hostname.toLowerCase()
}

export function evaluateSslCertInfo(
  certInput: {
    domain: string
    subjectCN: string
    issuerName: string
    validFrom: string | number | Date
    validTo: string | number | Date
    serialNumber?: string
    fingerprint256?: string
    subjectAltNames?: string[]
    protocol?: string
  },
  nowMs: number = Date.now(),
): SslCertHealthReport {
  const domain = normalizeDomainInput(certInput.domain)
  const fromDate = new Date(certInput.validFrom)
  const toDate = new Date(certInput.validTo)
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new Error('INVALID_CERT_DATE: 证书生效或过期时间格式无效')
  }

  const diffMs = toDate.getTime() - nowMs
  const daysRemaining = Math.ceil(diffMs / 86400000)
  const isExpired = diffMs <= 0
  const isExpiringSoon = !isExpired && daysRemaining <= 14

  return {
    domain,
    subjectCN: certInput.subjectCN || domain,
    issuerName: certInput.issuerName || 'Unknown Issuer',
    validFromIso: fromDate.toISOString().slice(0, 10),
    validToIso: toDate.toISOString().slice(0, 10),
    daysRemaining,
    isExpired,
    isExpiringSoon,
    serialNumber: certInput.serialNumber || '-',
    fingerprint256: certInput.fingerprint256 || '-',
    subjectAltNames: certInput.subjectAltNames || [domain],
    protocol: certInput.protocol || 'TLSv1.3',
  }
}

export async function inspectDomainSslCert(
  rawDomain: string,
  options?: {
    port?: number
    timeoutMs?: number
    hostInvoke?: (plugin: string, fn: string, params: Record<string, unknown>) => Promise<unknown>
  },
): Promise<SslCertHealthReport> {
  const domain = normalizeDomainInput(rawDomain)
  const port = options?.port || 443
  const timeoutMs = options?.timeoutMs || 6000

  const g = globalThis as Record<string, unknown>
  const win = (typeof window !== 'undefined' ? window : g) as Record<string, unknown>
  const electronBridge = win.__ztoolsElectron as
    | {
        transport?: {
          invoke?: (method: string, params?: Record<string, unknown>) => Promise<unknown>
          methods?: Record<string, (params?: Record<string, unknown>) => Promise<unknown>>
        }
      }
    | undefined
  const ztoolsBridge = (win.ztools || g.ztools) as
    | {
        callPlugin?: (plugin: string, fn: string, params?: Record<string, unknown>) => Promise<unknown>
        invoke?: (method: string, params?: Record<string, unknown>) => Promise<unknown>
      }
    | undefined

  let rawRes: unknown = null
  if (typeof options?.hostInvoke === 'function') {
    rawRes = await options.hostInvoke('SslDomainCheckPlugin', 'inspectDomain', {
      domain,
      port,
      timeoutMs,
    })
  } else if (typeof ztoolsBridge?.callPlugin === 'function') {
    rawRes = await ztoolsBridge.callPlugin('SslDomainCheckPlugin', 'inspectDomain', {
      domain,
      port,
      timeoutMs,
    })
  } else if (typeof electronBridge?.transport?.invoke === 'function') {
    rawRes = await electronBridge.transport.invoke('dll_call', {
      pluginName: 'SslDomainCheckPlugin',
      funcName: 'inspectDomain',
      params: { domain, port, timeoutMs },
    })
  } else if (typeof electronBridge?.transport?.methods?.dll_call === 'function') {
    rawRes = await electronBridge.transport.methods.dll_call({
      pluginName: 'SslDomainCheckPlugin',
      funcName: 'inspectDomain',
      params: { domain, port, timeoutMs },
    })
  }

  const unwrapped =
    rawRes && typeof rawRes === 'object' && 'result' in (rawRes as Record<string, unknown>)
      ? ((rawRes as Record<string, unknown>).result as Record<string, unknown>)
      : (rawRes as Record<string, unknown> | null)

  if (unwrapped && unwrapped.ok === false) {
    throw new Error(String(unwrapped.error || `TLS_HANDSHAKE_FAILED: 无法获取 ${domain} 的 TLS 证书`))
  }

  const certObj = (unwrapped?.cert || unwrapped?.data) as
    | {
        domain?: string
        subjectCN?: string
        issuerName?: string
        validFrom?: string
        validTo?: string
        serialNumber?: string
        fingerprint256?: string
        subjectAltNames?: string[]
        protocol?: string
      }
    | undefined

  if (certObj && certObj.validFrom && certObj.validTo) {
    return evaluateSslCertInfo({
      domain: certObj.domain || domain,
      subjectCN: certObj.subjectCN || domain,
      issuerName: certObj.issuerName || 'Unknown CA',
      validFrom: certObj.validFrom,
      validTo: certObj.validTo,
      serialNumber: certObj.serialNumber,
      fingerprint256: certObj.fingerprint256,
      subjectAltNames: certObj.subjectAltNames,
      protocol: certObj.protocol,
    })
  }

  throw new Error(`SSL_HOST_UNAVAILABLE: 宿主 TLS 探测通道未返回 ${domain} 的证书数据`)
}

export async function resolveDomainDoh(
  rawDomain: string,
  recordTypes: DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'],
  options?: {
    signal?: AbortSignal
    fetchImpl?: typeof fetch
  },
): Promise<DnsRecordEntry[]> {
  const domain = normalizeDomainInput(rawDomain)
  const fetchFn = options?.fetchImpl || globalThis.fetch
  if (typeof fetchFn !== 'function') {
    throw new Error('FETCH_UNAVAILABLE: 当前环境不支持 fetch DoH 查询')
  }

  const results: DnsRecordEntry[] = []
  for (const rType of recordTypes) {
    if (options?.signal?.aborted) {
      throw new Error('DOH_ABORTED: DNS 查询已取消')
    }
    const endpoint = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(
      domain,
    )}&type=${encodeURIComponent(rType)}`
    const resp = await fetchFn(endpoint, {
      headers: { accept: 'application/dns-json' },
      signal: options?.signal,
    })
    if (!resp.ok) {
      throw new Error(`DOH_HTTP_ERROR: DNS 查询返回状态码 ${resp.status}`)
    }
    const payload = (await resp.json()) as {
      Status?: number
      Answer?: Array<{ name: string; type: number; TTL: number; data: string }>
    }
    if (payload.Status === 3) {
      throw new Error(`DNS_NXDOMAIN: 域名 ${domain} 不存在 (NXDOMAIN)`)
    }
    const expectedCode = DNS_TYPE_CODE_MAP[rType]
    for (const ans of payload.Answer || []) {
      if (ans.type === expectedCode) {
        results.push({
          name: ans.name.replace(/\.$/, ''),
          type: rType,
          ttl: ans.TTL,
          data: ans.data.replace(/^"|"$/g, ''),
        })
      }
    }
  }
  return results
}
