import net from 'node:net'

export interface ProbeTarget { host: string; port: number; name: string; group: 'domestic' | 'global' | 'custom' | 'gateway' }
export interface NetworkProbe extends ProbeTarget { protocol: 'TCP' | 'ICMP'; samplesMs: number[]; latencyMs: number | null; jitterMs: number | null; error: string | null }
export interface NetworkSnapshot { interfaceName: string | null; localAddresses: string[]; gateway: string | null; warning: string | null }
export interface NetworkBandwidth {
  downloadMbps: number; uploadMbps: number; baseRttMs: number | null; responsivenessRpm: number | null
  downloadedBytes: number | null; uploadedBytes: number | null; interfaceName: string; durationMs: number; checkedAt: string
}
export type SpeedtestRequest = { action: 'cancel'; operationId: string } | { action: 'bandwidth'; operationId: string } | { action: 'diagnose'; operationId: string; target?: string }

export function parseProbeTarget(raw: unknown): ProbeTarget {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 300 || /[\s\\]/.test(raw.trim())) throw new Error('请输入域名、IP 或主机:端口')
  const value = raw.trim(), url = new URL(value.includes('://') ? value : `https://${net.isIP(value) === 6 ? `[${value}]` : value}`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !host || host.length > 253 || (!net.isIP(host) && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(host))) throw new Error('只接受域名或 IP，可指定端口；不要包含账号、路径或参数')
  const port = Number(url.port || (url.protocol === 'http:' ? 80 : 443))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1～65535')
  return { host, port, name: `${net.isIP(host) === 6 ? `[${host}]` : host}:${port}`, group: 'custom' }
}
export function validateSpeedtestRequest(value: unknown): asserts value is SpeedtestRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('测速请求无效')
  const r = value as Record<string, unknown>
  if (typeof r.action !== 'string' || !['cancel', 'diagnose', 'bandwidth'].includes(r.action) || typeof r.operationId !== 'string' || !/^[\w-]{1,100}$/.test(r.operationId)) throw new Error('测速操作或编号无效')
  const keys = r.action === 'diagnose' ? ['action', 'operationId', 'target'] : ['action', 'operationId']
  if (Object.keys(r).some(k => !keys.includes(k))) throw new Error('测速请求含多余字段')
  if (r.action === 'diagnose' && r.target !== undefined) parseProbeTarget(r.target)
}
