import type { GlobalShortcutAdapter } from '../../services/trigger-service.js'

export interface ElectronGlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export function toElectronAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((token) => {
      const trimmed = token.trim()
      return trimmed.toLowerCase() === 'ctrl' ? 'CommandOrControl' : trimmed
    })
    .join('+')
}

export function createElectronGlobalShortcutAdapter(
  electron: ElectronGlobalShortcutApi
): GlobalShortcutAdapter {
  return {
    register(accelerator, callback) {
      return electron.register(toElectronAccelerator(accelerator), callback)
    },
    unregister(accelerator) {
      electron.unregister(toElectronAccelerator(accelerator))
    }
  }
}
