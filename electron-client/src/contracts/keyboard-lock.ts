export interface KeyboardLockRequest {
  action: 'start' | 'status' | 'unlock'; operationId: string
  durationSeconds?: number; lockPointer?: boolean
}
export interface KeyboardLockState {
  success: true; operationId: string; status: 'locked' | 'unlocked'
  remainingSeconds: number; blockedEvents: number; lockPointer: boolean; reason: string
}
export function validateKeyboardLockRequest(value: unknown): asserts value is KeyboardLockRequest {
  const p = value as Partial<KeyboardLockRequest> | null
  if (!p || typeof p !== 'object' || Array.isArray(p) || typeof p.action !== 'string' || !['start', 'status', 'unlock'].includes(p.action) ||
      typeof p.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(p.operationId) ||
      Object.keys(p).some(key => !['action', 'operationId', ...(p.action === 'start' ? ['durationSeconds', 'lockPointer'] : [])].includes(key)) ||
      (p.action === 'start' && (!Number.isInteger(p.durationSeconds) || p.durationSeconds! < 5 || p.durationSeconds! > 300 || typeof p.lockPointer !== 'boolean'))) {
    throw new Error('键盘锁参数无效：请选择 5～300 秒的整数时长')
  }
}
