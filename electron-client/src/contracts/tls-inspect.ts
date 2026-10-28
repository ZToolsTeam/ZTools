import { isIP } from 'node:net'
import { ZToolsError, errorCodes } from './errors.js'

export interface TlsCertificateSummary {
  subjectCN: string; issuerName: string; validFrom: string; validTo: string
  serialNumber: string; fingerprint256: string
}
export interface TlsInspection extends TlsCertificateSummary {
  domain: string; port: number; protocol: string; subjectAltName: string
  authorized: boolean; authorizationError: string; hostnameMatches: boolean
  chain: TlsCertificateSummary[]; chainTruncated: boolean
}
export type TlsInspectRequest = { action: 'cancel'; operationId: string } |
  { action: 'inspect'; operationId: string; domain: string; port?: number; timeoutMs?: number }
export function validateTlsInspectRequest(value: unknown): asserts value is TlsInspectRequest {
  const bad = () => { throw new ZToolsError(errorCodes.invalidRequest, '证书探测参数无效') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad()
  const v = value as Record<string, unknown>
  if (!['inspect', 'cancel'].includes(String(v.action)) || typeof v.action !== 'string' || typeof v.operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(v.operationId)) return bad()
  const allowed = v.action === 'cancel' ? ['action', 'operationId'] : ['action', 'operationId', 'domain', 'port', 'timeoutMs']
  if (Object.keys(v).some(key => !allowed.includes(key))) return bad()
  if (v.action === 'cancel') return
  if (typeof v.domain !== 'string' || !v.domain || v.domain.length > 253 || (!isIP(v.domain) && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i.test(v.domain))) return bad()
  if (v.port !== undefined && (!Number.isInteger(v.port) || Number(v.port) < 1 || Number(v.port) > 65535)) return bad()
  if (v.timeoutMs !== undefined && (!Number.isInteger(v.timeoutMs) || Number(v.timeoutMs) < 1000 || Number(v.timeoutMs) > 15000)) return bad()
}
