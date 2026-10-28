import { errorCodes, ZToolsError } from './errors.js'

export interface MediaMetadataParams {
  action: 'inspect' | 'clean'
  path: string
  operationId: string
  outputPath?: string
  digest?: string
  mode?: 'location' | 'metadata'
}
export function validateMediaMetadataParams(value: unknown): asserts value is MediaMetadataParams {
  const invalid = () => new ZToolsError(errorCodes.invalidRequest, '媒体处理参数无效')
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid()
  const p = value as Record<string, unknown>, keys = ['action', 'path', 'operationId', 'outputPath', 'digest', 'mode']
  const validPath = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 4096 && !v.includes('\0')
  if (Object.keys(p).some(key => !keys.includes(key)) || typeof p.action !== 'string' || !['inspect', 'clean'].includes(p.action) || !validPath(p.path) || typeof p.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p.operationId)) throw invalid()
  if (p.action === 'clean' && (!validPath(p.outputPath) || typeof p.digest !== 'string' || !/^[a-f0-9]{64}$/.test(p.digest) || typeof p.mode !== 'string' || !['location', 'metadata'].includes(p.mode))) throw invalid()
}
