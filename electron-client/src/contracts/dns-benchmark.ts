import { isIP } from 'node:net'

export interface DnsNetworkService {
  name: string; device: string; addresses: string[]; servers: string[]
  backup: { id: string; servers: string[]; createdAt: string } | null
}
export interface DnsProbeResult { server: string; milliseconds: number | null; answers: string[]; error: string | null }
export type DnsRequest =
  | { action: 'list' | 'flush'; operationId: string }
  | { action: 'benchmark'; operationId: string; servers: string[] }
  | { action: 'cancel'; operationId: string }
  | { action: 'apply' | 'reset'; operationId: string; service: string; expectedServers: string[]; servers?: string[] }
  | { action: 'restore'; operationId: string; service: string; expectedServers: string[]; backupId: string }

export function validDnsServers(value: unknown, max = 8): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(v => typeof v === 'string' && isIP(v) !== 0) && new Set(value).size === value.length
}
export function validNetworkService(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim() && !/^[-*]/.test(value) && !/[\u0000-\u001f\u007f]/.test(value)
}
export function validateDnsRequest(value: unknown): asserts value is DnsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DNS 请求无效')
  const p = value as Record<string, unknown>
  if (typeof p.action !== 'string' || typeof p.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(p.operationId)) throw new Error('DNS 操作编号无效')
  const fields: Record<string, string[]> = {
    list: [], flush: [], cancel: [], benchmark: ['servers'], apply: ['service', 'expectedServers', 'servers'],
    reset: ['service', 'expectedServers'], restore: ['service', 'expectedServers', 'backupId']
  }
  const extras = Object.hasOwn(fields, p.action) ? fields[p.action] : undefined
  if (!extras || Object.keys(p).some(key => !['action', 'operationId', ...extras].includes(key))) throw new Error('DNS 操作参数无效')
  if (p.action === 'benchmark' && (!validDnsServers(p.servers, 40) || !p.servers.length)) throw new Error('请选择 1～40 个有效 DNS 地址')
  if (['apply', 'reset', 'restore'].includes(p.action) && (!validNetworkService(p.service) || !validDnsServers(p.expectedServers))) throw new Error('网络服务或原 DNS 配置无效，请重新读取')
  if (p.action === 'apply' && (!validDnsServers(p.servers) || !p.servers.length)) throw new Error('请选择有效 DNS 地址')
  if (p.action === 'restore' && (typeof p.backupId !== 'string' || !/^[0-9a-f-]{36}$/.test(p.backupId))) throw new Error('DNS 恢复记录无效')
}
