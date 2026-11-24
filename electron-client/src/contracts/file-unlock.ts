export interface FileLockProcess {
  pid: number; name: string; executablePath: string; userId: number
  paths: string[]; protected: boolean; reason: string
}
export interface FileLockSnapshot {
  success: true; sessionId: string; targetPath: string; isDirectory: boolean
  processes: FileLockProcess[]; notice: string; mutationBlockedReason: string
}
export type FileUnlockRequest = { action: 'info' | 'drives' | 'cancel' | 'close' } |
  { action: 'inspect'; targetPath: string } |
  { action: 'terminate'; sessionId: string; pids: number[]; mode: 'graceful' | 'force' } |
  { action: 'trash'; sessionId: string } | { action: 'rename'; sessionId: string; name: string }
export function fileUnlockRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
export function validateFileUnlockRequest(value: unknown): asserts value is FileUnlockRequest {
  if (!fileUnlockRecord(value) || typeof value.action !== 'string') throw new Error('Invalid file unlock request')
  const fields: Record<string, string[]> = {
    info: [], drives: [], cancel: [], close: [], inspect: ['targetPath'],
    terminate: ['sessionId', 'pids', 'mode'], trash: ['sessionId'], rename: ['sessionId', 'name']
  }
  const keys = fields[value.action]
  if (!keys || Object.keys(value).some(k => k !== 'action' && !keys.includes(k)) || keys.some(k => !(k in value))) throw new Error('Invalid file unlock request fields')
  if (keys.includes('sessionId') && (typeof value.sessionId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.sessionId))) throw new Error('Rescan the target first')
  if (value.action === 'inspect' && (typeof value.targetPath !== 'string' || !value.targetPath.startsWith('/') || value.targetPath.length > 4096 || value.targetPath.includes('\0') || value.targetPath.split('/').includes('..'))) throw new Error('Provide a full macOS path without path traversal')
  if (value.action === 'rename' && (typeof value.name !== 'string' || !value.name || value.name.length > 255 || /[\0/\r\n:]/.test(value.name) || ['.', '..'].includes(value.name))) throw new Error('New name must be a valid file name without path separators')
  if (value.action === 'terminate' && (!['graceful', 'force'].includes(String(value.mode)) || typeof value.mode !== 'string' || !Array.isArray(value.pids) || !value.pids.length || value.pids.length > 128 || new Set(value.pids).size !== value.pids.length || value.pids.some(pid => !Number.isInteger(pid) || pid <= 1 || pid > 0x7fffffff))) throw new Error('Invalid target processes or termination mode')
}
