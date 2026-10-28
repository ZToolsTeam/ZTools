export const HOSTS_MAX_BYTES = 1024 * 1024
export interface HostsSnapshot { content: string; identity: string; revision: string; path: string }
export type HostsRequest = { action: 'read' | 'cancel' | 'flush' } |
  { action: 'prepare'; sessionId: string; content: string } |
  { action: 'restore'; sessionId: string; backupId: string } |
  { action: 'apply'; planId: string }
export function hostsRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
export function validateHostsRequest(value: unknown): asserts value is HostsRequest {
  if (!hostsRecord(value) || typeof value.action !== 'string') throw new Error('Hosts 请求无效')
  const fields: Record<string, string[]> = { read: [], cancel: [], flush: [], prepare: ['sessionId', 'content'], restore: ['sessionId', 'backupId'], apply: ['planId'] }
  const allowed = fields[value.action]
  if (!allowed || allowed.some(k => !(k in value)) || Object.keys(value).some(k => k !== 'action' && !allowed.includes(k))) throw new Error('Hosts 请求字段无效')
  for (const field of allowed.filter(k => k !== 'content')) if (typeof value[field] !== 'string' || !/^[a-f0-9-]{36}$/.test(value[field] as string)) throw new Error('Hosts 读取结果或备份编号无效')
  if (value.action === 'prepare' && (typeof value.content !== 'string' || Buffer.byteLength(value.content) > HOSTS_MAX_BYTES || /[\0\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(value.content))) throw new Error('Hosts 内容包含非法字符或超过 1 MiB')
}
