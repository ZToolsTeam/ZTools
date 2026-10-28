import { ZToolsError, errorCodes } from './errors.js'
export type ProxyTool = 'git' | 'npm'
export interface SshTunnel { localPort: number; remoteHost: string; remotePort: number }
export type ProxyChange = { kind: 'set'; port: number } | { kind: 'clear' } | { kind: 'restore'; backupId: string }
export type SshProxyRequest = { action: 'scan' | 'cancel' } | { action: 'connect'; sessionId: string; alias: string } |
  { action: 'tunnel'; sessionId: string; alias: string; tunnel: SshTunnel } | { action: 'terminal-proxy'; port: number } |
  { action: 'prepare'; sessionId: string; tool: ProxyTool; change: ProxyChange } | { action: 'apply'; planId: string }
export const validSshAlias = (value: unknown): value is string => typeof value === 'string' && /^[\p{L}\p{N}_][\p{L}\p{N}_.:-]{0,254}$/u.test(value)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const port = (value: unknown) => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 65535
const id = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(k => allowed.includes(k))
export function validSshTunnel(value: unknown): value is SshTunnel {
  return record(value) && keys(value, ['localPort', 'remoteHost', 'remotePort']) && port(value.localPort) && port(value.remotePort) &&
    typeof value.remoteHost === 'string' && /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,252}|\[[A-Fa-f0-9:]{2,45}\])$/.test(value.remoteHost)
}
export function validateSshProxyRequest(value: unknown): asserts value is SshProxyRequest {
  const invalid = () => { throw new ZToolsError(errorCodes.invalidRequest, '主机与代理请求参数无效') }
  if (!record(value) || typeof value.action !== 'string') return invalid()
  if (value.action === 'scan' || value.action === 'cancel') { if (!keys(value, ['action'])) invalid(); return }
  if (value.action === 'terminal-proxy') { if (!keys(value, ['action', 'port']) || !port(value.port)) invalid(); return }
  if (value.action === 'apply') { if (!keys(value, ['action', 'planId']) || !id(value.planId)) invalid(); return }
  if (!id(value.sessionId)) return invalid()
  if (value.action === 'connect' || value.action === 'tunnel') {
    if (!validSshAlias(value.alias) || !keys(value, value.action === 'connect' ? ['action', 'sessionId', 'alias'] : ['action', 'sessionId', 'alias', 'tunnel']) || (value.action === 'tunnel' && !validSshTunnel(value.tunnel))) invalid()
    return
  }
  if (value.action !== 'prepare' || !keys(value, ['action', 'sessionId', 'tool', 'change']) || !['git', 'npm'].includes(String(value.tool)) || typeof value.tool !== 'string' || !record(value.change)) return invalid()
  const c = value.change
  if (c.kind === 'set' && keys(c, ['kind', 'port']) && port(c.port)) return
  if (c.kind === 'clear' && keys(c, ['kind'])) return
  if (c.kind === 'restore' && keys(c, ['kind', 'backupId']) && id(c.backupId)) return
  return invalid()
}
