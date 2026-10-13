import type { ConfigService } from '../services/config-service.js'

export type CloseRequestOrigin = 'closeButton' | 'trayMenu'
export type CloseDecision = 'confirm' | 'hide' | 'quit'

export interface ClosePreferences {
  closeConfirm: boolean
  minimizeToTray: boolean
}

function parseBooleanSetting(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  return fallback
}

export async function readClosePreferences(
  config: Pick<ConfigService, 'get'>
): Promise<ClosePreferences> {
  const [closeConfirm, minimizeToTray] = await Promise.all([
    config.get('user_settings.json', 'system.closeConfirm', 'true'),
    config.get('user_settings.json', 'system.minimizeToTray', 'true')
  ])
  return {
    closeConfirm: parseBooleanSetting(closeConfirm, true),
    minimizeToTray: parseBooleanSetting(minimizeToTray, true)
  }
}

export function decideCloseAction(
  preferences: ClosePreferences,
  origin: CloseRequestOrigin
): CloseDecision {
  if (preferences.closeConfirm) return 'confirm'
  if (origin === 'trayMenu') return 'quit'
  return preferences.minimizeToTray ? 'hide' : 'quit'
}
