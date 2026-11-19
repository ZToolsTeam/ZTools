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
  if (origin === 'trayMenu') return 'quit'
  if (preferences.closeConfirm) return 'confirm'
  return preferences.minimizeToTray ? 'hide' : 'quit'
}

export interface AllWindowsClosedState {
  quitWhenAllWindowsClose: boolean
  cancellationRequested: boolean
  quitAllowed: boolean
  quitInProgress: boolean
}

/** 仅在平台策略要求退出且主进程尚未进入退出清理流时才响应 window-all-closed 退出，防止停机销毁窗口时重入 app.quit */
export function shouldQuitOnAllWindowsClosed(state: AllWindowsClosedState): boolean {
  if (!state.quitWhenAllWindowsClose) return false
  if (state.cancellationRequested || state.quitAllowed || state.quitInProgress) return false
  return true
}
