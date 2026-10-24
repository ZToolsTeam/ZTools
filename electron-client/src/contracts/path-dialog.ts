import { errorCodes, ZToolsError } from './errors.js'

export interface ReferenceDialogOptions {
  title?: string
  filters?: string
  defaultName?: string
  properties?: readonly ('openFile' | 'openDirectory' | 'multiSelections')[]
  access?: 'read' | 'read-write'
}
/** v2 dialog hints do not accept legacy absolute paths. The native selection stays in main. */
export function parseReferenceDialog(value: unknown, mode: 'open' | 'save' | 'folder',
  platform: 'win32' | 'darwin' = process.platform === 'darwin' ? 'darwin' : 'win32'): ReferenceDialogOptions {
  const invalid = () => new ZToolsError(errorCodes.invalidRequest, '文件引用对话框参数无效')
  if (!['open', 'save', 'folder'].includes(mode) || !value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid()
  const v = value as Record<string, unknown>, allowed = mode === 'open' ? ['title', 'filters', 'properties'] :
    mode === 'save' ? ['title', 'filters', 'defaultName'] : ['title', 'access']
  if (Object.keys(v).some(key => !allowed.includes(key))) throw invalid()
  const result: ReferenceDialogOptions = {}
  for (const key of ['title', 'filters', 'defaultName'] as const) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== 'string' || Buffer.byteLength(v[key]) > 4096 || v[key].includes('\0')) throw invalid()
      result[key] = v[key]
    }
  }
  if (result.defaultName !== undefined && (!result.defaultName || result.defaultName === '.' || result.defaultName === '..' ||
      result.defaultName.includes('/') || (platform === 'win32' && /[\\:\x00-\x1f]/.test(result.defaultName)) || /^\.ztools-save-/i.test(result.defaultName))) throw invalid()
  if (v.properties !== undefined) {
    if (!Array.isArray(v.properties) || !v.properties.length || v.properties.length > 3 ||
        v.properties.some(item => !['openFile', 'openDirectory', 'multiSelections'].includes(item)) || new Set(v.properties).size !== v.properties.length) throw invalid()
    result.properties = v.properties as NonNullable<ReferenceDialogOptions['properties']>
  }
  if (v.access !== undefined) {
    if (v.access !== 'read' && v.access !== 'read-write') throw invalid()
    result.access = v.access
  }
  return result
}
