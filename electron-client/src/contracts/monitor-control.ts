import { errorCodes, ZToolsError } from './errors.js'
export interface MonitorChange { id: string; control: 'brightness' | 'contrast'; value: number; expected: number }
export type MonitorRequest = { action: 'list' } | { action: 'sleep' } | { action: 'set'; topology: string; changes: MonitorChange[] }
export interface MonitorDisplay {
  id: string; name: string; isPrimary: boolean; builtIn: boolean; width: number; height: number
  protocol: 'apple' | 'ddcci' | 'wmi' | 'unsupported'; canBrightness: boolean; canContrast: boolean
  brightness?: number; contrast?: number; reason?: string
}
export const monitorRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const percent = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100
export function validateMonitorRequest(value: unknown): asserts value is MonitorRequest {
  const invalid = () => { throw new ZToolsError(errorCodes.invalidRequest, '显示器请求参数无效') }
  if (!monitorRecord(value) || typeof value.action !== 'string' || !['list', 'set', 'sleep'].includes(value.action)) return invalid()
  const keys = value.action === 'set' ? ['action', 'topology', 'changes'] : ['action']
  if (Object.keys(value).some(k => !keys.includes(k))) return invalid()
  if (value.action !== 'set') return
  if (typeof value.topology !== 'string' || !value.topology || value.topology.length > 8192 || /[^A-Fa-f0-9mac:\-/|]/.test(value.topology) || !Array.isArray(value.changes) || !value.changes.length || value.changes.length > 16) return invalid()
  const ids = new Set<string>()
  for (const c of value.changes) {
    if (!monitorRecord(c) || Object.keys(c).some(k => !['id', 'control', 'value', 'expected'].includes(k)) || typeof c.id !== 'string' || !/^(?:mac|win):[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/.test(c.id) || (c.control !== 'brightness' && c.control !== 'contrast') || !percent(c.value) || !percent(c.expected) || ids.has(`${c.id}:${c.control}`)) return invalid()
    ids.add(`${c.id}:${c.control}`)
  }
}
export function parseMonitorDisplay(value: unknown): MonitorDisplay {
  if (!monitorRecord(value) || typeof value.id !== 'string' || !/^(?:mac|win):[A-Fa-f0-9-]{36}$/.test(value.id) || typeof value.name !== 'string' || !value.name || !['isPrimary', 'builtIn', 'canBrightness', 'canContrast'].every(k => typeof value[k] === 'boolean') || typeof value.protocol !== 'string' || !['apple', 'ddcci', 'wmi', 'unsupported'].includes(value.protocol) || !Number.isSafeInteger(value.width) || Number(value.width) < 1 || !Number.isSafeInteger(value.height) || Number(value.height) < 1) throw new ZToolsError(errorCodes.screenError, '显示器组件返回的设备信息无效')
  for (const [name, capability] of [['brightness', 'canBrightness'], ['contrast', 'canContrast']] as const) if ((value[name] !== undefined && !percent(value[name])) || (value[capability] && !percent(value[name]))) throw new ZToolsError(errorCodes.screenError, '显示器组件未返回真实控制状态')
  if (value.reason !== undefined && typeof value.reason !== 'string') throw new ZToolsError(errorCodes.screenError, '显示器状态说明无效')
  return value as unknown as MonitorDisplay
}
