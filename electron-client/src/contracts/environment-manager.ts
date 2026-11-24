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
  const exact = (row: Record<string, unknown>, fields: string[]) => { if (Object.keys(row).some(k => !fields.includes(k))) throw new Error('Environment request contains invalid fields') }
  if (!environmentRecord(value)) throw new Error('Invalid environment request')
  if (value.action === 'list' || value.action === 'cancel') { exact(value, ['action']); return }
  if (value.action === 'apply') { exact(value, ['action', 'planId']); if (!uuid(value.planId)) throw new Error('Invalid modification plan'); return }
  if (value.action !== 'prepare' || !uuid(value.sessionId) || !environmentRecord(value.change)) throw new Error('Read environment variables first')
  exact(value, ['action', 'sessionId', 'change'])
  const change = value.change
  if (typeof change.source !== 'string' || !['user', 'system'].includes(change.source) || typeof change.kind !== 'string') throw new Error('Invalid environment source or operation')
  if (change.kind === 'clean') { exact(change, ['kind', 'source']); return }
  if (change.kind === 'restore') { exact(change, ['kind', 'source', 'backupId']); if (!uuid(change.backupId)) throw new Error('Invalid backup ID'); return }
  if (!['set', 'delete'].includes(change.kind) || !validEnvironmentKey(change.key)) throw new Error('Variable name must contain only letters, digits, and underscores, and must not start with a digit')
  exact(change, change.kind === 'set' ? ['kind', 'source', 'key', 'value'] : ['kind', 'source', 'key'])
  if (change.kind === 'set' && !validEnvironmentValue(change.value)) throw new Error('Variable value contains null bytes or exceeds 32767 characters')
}
