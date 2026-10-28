import { errorCodes, ZToolsError } from './errors.js'

export interface OfficeDocumentParams {
  action: 'inspect' | 'slim' | 'extract'
  path: string
  outputPath?: string
  digest?: string
  cleanMetadata?: boolean
  operationId: string
}
export function validateOfficeParams(value: unknown): asserts value is OfficeDocumentParams {
  const invalid = () => new ZToolsError(errorCodes.invalidRequest, 'Office 文档处理参数无效')
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid()
  const p = value as Record<string, unknown>
  if (typeof p.action !== 'string' || !['inspect', 'slim', 'extract'].includes(p.action) || Object.keys(p).some(key => !['action', 'path', 'outputPath', 'digest', 'cleanMetadata', 'operationId'].includes(key))) throw invalid()
  if (typeof p.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p.operationId) || typeof p.path !== 'string' || !p.path || p.path.includes('\0') || p.path.length > 4096) throw invalid()
  if (p.action !== 'inspect' && (typeof p.outputPath !== 'string' || !p.outputPath || p.outputPath.includes('\0') || p.outputPath.length > 4096 || typeof p.digest !== 'string' || !/^[a-f0-9]{64}$/.test(p.digest))) throw invalid()
  if (p.cleanMetadata !== undefined && typeof p.cleanMetadata !== 'boolean') throw invalid()
}
