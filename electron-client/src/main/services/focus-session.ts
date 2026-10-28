export type FocusSessionStatus = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled'
export type FocusSessionPresentation = 'panel' | 'menuBar' | 'hud'
export interface FocusSessionState {
  id: string; title: string; categoryId: string; categoryName: string
  totalDurationMs: number; elapsedMs: number; remainingMs: number; progress: number
  status: FocusSessionStatus; presentation: FocusSessionPresentation
  startedAt: number | null; pausedAt: number | null; completedAt: number | null
  mode: 'single' | 'pomodoro'; phase: 'focus' | 'short_break' | 'long_break'; completedCycles: number
  notificationWarning?: string
}
export interface PersistedFocus { version: 1; anchor: number; session: FocusSessionState }
export function readFocusState(raw: string): PersistedFocus {
  if (raw.length > 16_384) throw new Error('专注状态文件过大，原数据已保留')
  const value: unknown = JSON.parse(raw)
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!object(value) || value.version !== 1 || !Number.isSafeInteger(value.anchor) || Number(value.anchor) < 0 || !object(value.session)) throw new Error('专注状态损坏，原数据已保留')
  const s = value.session
  if (!['id', 'title', 'categoryId', 'categoryName'].every(k => typeof s[k] === 'string' && s[k].length > 0 && s[k].length <= 300) ||
      !['totalDurationMs', 'elapsedMs', 'remainingMs', 'completedCycles'].every(k => Number.isSafeInteger(s[k]) && Number(s[k]) >= 0) ||
      Number(s.totalDurationMs) < 1 || Number(s.totalDurationMs) > 86_400_000 || Number(s.elapsedMs) > Number(s.totalDurationMs) || Number(s.remainingMs) > Number(s.totalDurationMs) ||
      typeof s.progress !== 'number' || !Number.isFinite(s.progress) || s.progress < 0 || s.progress > 1 ||
      typeof s.status !== 'string' || !['idle', 'running', 'paused', 'completed', 'cancelled'].includes(s.status) ||
      typeof s.presentation !== 'string' || !['panel', 'menuBar', 'hud'].includes(s.presentation) ||
      typeof s.mode !== 'string' || !['single', 'pomodoro'].includes(s.mode) ||
      typeof s.phase !== 'string' || !['focus', 'short_break', 'long_break'].includes(s.phase) ||
      !['startedAt', 'pausedAt', 'completedAt'].every(k => s[k] === null || Number.isSafeInteger(s[k]) && Number(s[k]) >= 0)) throw new Error('专注状态损坏，原数据已保留')
  return value as unknown as PersistedFocus
}

export function projectFocus(state: FocusSessionState, anchor: number, now: number): FocusSessionState {
  if (state.status !== 'running') return { ...state }
  const elapsedMs = Math.min(state.totalDurationMs, state.elapsedMs + Math.max(0, now - anchor))
  return { ...state, elapsedMs, remainingMs: state.totalDurationMs - elapsedMs, progress: elapsedMs / state.totalDurationMs }
}
