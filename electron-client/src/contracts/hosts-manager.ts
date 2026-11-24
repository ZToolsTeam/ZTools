export const HOSTS_MAX_BYTES = 1024 * 1024
export interface HostsSnapshot { content: string; identity: string; revision: string; path: string }
export type HostsRequest = { action: 'read' | 'cancel' | 'flush' } |
  { action: 'prepare'; sessionId: string; content: string } |
  { action: 'restore'; sessionId: string; backupId: string } |
  { action: 'apply'; planId: string }
export function hostsRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
export function validateHostsRequest(value: unknown): asserts value is HostsRequest {
  if (!hostsRecord(value) || typeof value.action !== 'string') throw new Error('Invalid Hosts request')
  const fields: Record<string, string[]> = { read: [], cancel: [], flush: [], prepare: ['sessionId', 'content'], restore: ['sessionId', 'backupId'], apply: ['planId'] }
  const allowed = fields[value.action]
  if (!allowed || allowed.some(k => !(k in value)) || Object.keys(value).some(k => k !== 'action' && !allowed.includes(k))) throw new Error('Invalid Hosts request fields')
  for (const field of allowed.filter(k => k !== 'content')) if (typeof value[field] !== 'string' || !/^[a-f0-9-]{36}$/.test(value[field] as string)) throw new Error('Invalid Hosts read session or backup ID')
  if (value.action === 'prepare' && (typeof value.content !== 'string' || Buffer.byteLength(value.content) > HOSTS_MAX_BYTES || /[\0\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(value.content))) throw new Error('Hosts content contains invalid characters or exceeds 1 MiB')
}
