export type EnvironmentScope = 'user' | 'system'
export interface EnvironmentVariable { key: string; value: string; scope: EnvironmentScope | 'process' }
export interface EnvironmentPathEntry { scope: EnvironmentScope | 'process'; index: number; value: string; status: 'directory' | 'missing' | 'unknown'; reason: string }
export interface EnvironmentBackupInfo { id: string; source: EnvironmentScope; createdAt: string; summary: string }
export interface EnvironmentSnapshot {
  sessionId: string; platform: string; notice: string
  sources: Array<{ id: EnvironmentScope; label: string }>
  variables: EnvironmentVariable[]; paths: EnvironmentPathEntry[]; backups: EnvironmentBackupInfo[]
}
export type EnvironmentChange = { kind: 'set'; source: EnvironmentScope; key: string; value: string } |
  { kind: 'delete'; source: EnvironmentScope; key: string } | { kind: 'clean'; source: EnvironmentScope } |
  { kind: 'restore'; source: EnvironmentScope; backupId: string }
export type EnvironmentRequest = { action: 'list' | 'cancel' } |
  { action: 'prepare'; sessionId: string; change: EnvironmentChange } | { action: 'apply'; planId: string }
export function environmentRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function validEnvironmentKey(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) }
export function validEnvironmentValue(value: unknown): value is string { return typeof value === 'string' && value.length <= 32767 && !value.includes('\0') }
export function validateEnvironmentRequest(value: unknown): asserts value is EnvironmentRequest {
  const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)
  const exact = (row: Record<string, unknown>, fields: string[]) => { if (Object.keys(row).some(k => !fields.includes(k))) throw new Error('环境变量请求包含无效字段') }
  if (!environmentRecord(value)) throw new Error('环境变量请求无效')
  if (value.action === 'list' || value.action === 'cancel') { exact(value, ['action']); return }
  if (value.action === 'apply') { exact(value, ['action', 'planId']); if (!uuid(value.planId)) throw new Error('修改计划无效'); return }
  if (value.action !== 'prepare' || !uuid(value.sessionId) || !environmentRecord(value.change)) throw new Error('请先读取环境变量')
  exact(value, ['action', 'sessionId', 'change'])
  const change = value.change
  if (typeof change.source !== 'string' || !['user', 'system'].includes(change.source) || typeof change.kind !== 'string') throw new Error('环境变量来源或操作无效')
  if (change.kind === 'clean') { exact(change, ['kind', 'source']); return }
  if (change.kind === 'restore') { exact(change, ['kind', 'source', 'backupId']); if (!uuid(change.backupId)) throw new Error('备份编号无效'); return }
  if (!['set', 'delete'].includes(change.kind) || !validEnvironmentKey(change.key)) throw new Error('变量名必须由字母、数字和下划线组成，且不能以数字开头')
  exact(change, change.kind === 'set' ? ['kind', 'source', 'key', 'value'] : ['kind', 'source', 'key'])
  if (change.kind === 'set' && !validEnvironmentValue(change.value)) throw new Error('变量值含空字符或超过 32767 字符')
}
