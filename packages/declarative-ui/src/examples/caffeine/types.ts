export type CaffeineMode = 'display' | 'system'

export interface CaffeinePreset {
  id: string
  minutes: number
  title: string
  subtitle: string
}

export interface CaffeineStatus {
  active: boolean
  mode: CaffeineMode
  durationMinutes: number
  startedAtMs: number | null
  expiresAtMs: number | null
  remainingMs: number | null
  remainingText: string
  sessionId: number
}

export interface CaffeineActionResult {
  ok: boolean
  status?: CaffeineStatus
  errorCode?: string
  error?: string
}
