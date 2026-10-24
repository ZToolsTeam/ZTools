import { errorCodes, ZToolsError } from './errors.js'
import { parseReferenceDirectory } from './path-reference.js'

export function parseReferenceFind(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid()
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(key => !['directoryGrantId', 'relativePath', 'pattern', 'caseSensitive'].includes(key)) ||
      typeof v.pattern !== 'string' || !v.pattern || Buffer.byteLength(v.pattern) > 256 ||
      Array.from(v.pattern).length > 128 || /[\/\0]/.test(v.pattern) ||
      (v.caseSensitive !== undefined && typeof v.caseSensitive !== 'boolean')) throw invalid()
  return { ...parseReferenceDirectory({ directoryGrantId: v.directoryGrantId, relativePath: v.relativePath }, true),
    pattern: v.pattern, caseSensitive: v.caseSensitive ?? true }
}
function invalid(): ZToolsError { return new ZToolsError(errorCodes.invalidRequest, '引用文件查找参数无效') }
