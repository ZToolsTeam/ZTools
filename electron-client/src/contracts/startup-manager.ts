import { errorCodes, ZToolsError } from './errors.js'

export interface MacStartupItem {
  id: string; label: string; file: string; domain: string
  scope: 'user-agent' | 'system-agent' | 'daemon'
  program: string; args: string[]; scheduled: boolean
  enabled: boolean; loaded: boolean; running: boolean; pid: number | null
  programState: 'available' | 'missing' | 'unknown'
  requiresAdmin: boolean; blockedReason: string | null
}
export interface MacStartupScan { success: true; items: MacStartupItem[]; warnings: string[] }
export type StartupRequest =
  | { action: 'scan' | 'cancel'; operationId: string }
  | { action: 'set-enabled'; operationId: string; id: string; enabled: boolean }
  | { action: 'remove' | 'restore'; operationId: string; id: string }
  | { action: 'backups' | 'settings'; operationId: string }

export function validateStartupRequest(value: unknown): asserts value is StartupRequest {
  const v = value as Record<string, unknown> | null
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.action !== 'string' ||
      !['scan', 'cancel', 'set-enabled', 'remove', 'restore', 'backups', 'settings'].includes(v.action) ||
      typeof v.operationId !== 'string' || !/^[\w-]{1,100}$/.test(v.operationId)) throw new ZToolsError(errorCodes.invalidRequest, '启动管理请求无效')
  const keys = ['action', 'operationId']
  if (['set-enabled', 'remove', 'restore'].includes(v.action)) {
    keys.push('id')
    if (typeof v.id !== 'string' || !/^[a-f0-9-]{36,64}$/.test(v.id)) throw new ZToolsError(errorCodes.invalidRequest, '启动项编号无效')
  }
  if (v.action === 'set-enabled') {
    keys.push('enabled')
    if (typeof v.enabled !== 'boolean') throw new ZToolsError(errorCodes.invalidRequest, '启动状态无效')
  }
  if (Object.keys(v).some(k => !keys.includes(k))) throw new ZToolsError(errorCodes.invalidRequest, '启动管理含有多余参数')
}
