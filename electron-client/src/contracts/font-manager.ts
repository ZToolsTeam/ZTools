import { errorCodes, ZToolsError } from './errors.js'
export interface FontRequest { action: 'list' | 'preview' | 'reveal'; operationId: string; id?: string; text?: string }
export interface InstalledFont { id: string; family: string; style: string; filePath: string; hasLicense: boolean; system: boolean }
export interface FontPreview { id: string; png: string; fallbacks: string[]; coverageWarning?: string; license: string; licenseUrl: string; copyright: string; manufacturer: string }
export function validateFontRequest(value: unknown): asserts value is FontRequest {
  const invalid = () => new ZToolsError(errorCodes.invalidRequest, '字体操作参数无效')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const p = value as Record<string, unknown>
  if (Object.keys(p).some(key => !['action', 'operationId', 'id', 'text'].includes(key)) || typeof p.action !== 'string' || !['list', 'preview', 'reveal'].includes(p.action) || typeof p.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p.operationId)) throw invalid()
  if (p.action !== 'list' && (typeof p.id !== 'string' || !p.id || p.id.length > 1024 || /[\u0000-\u001f]/.test(p.id))) throw invalid()
  if (p.action === 'preview' && (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 320 || [...p.text].length > 160 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(p.text))) throw invalid()
  if ((p.action === 'list' && p.id !== undefined) || (p.action !== 'preview' && p.text !== undefined)) throw invalid()
}
