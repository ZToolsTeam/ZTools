import type {
  CapabilityOsPermissionStatus,
  RuntimeCapabilityProviders
} from './runtime-capability-service.js'
import type { RuntimeCapabilityTarget } from '../../contracts/runtime-capability.js'
import type { ScreenAdapter } from './screen-service.js'

/**
 * Reuses only the existing read-only macOS screen-capture TCC probe.
 * No permission request API is exposed through this provider.
 */
export function createRuntimeCapabilityProviders(
  screen: Pick<ScreenAdapter, 'getScreenCapturePermissionStatus'>,
  platform: RuntimeCapabilityTarget['platform'],
  overrides: RuntimeCapabilityProviders = {},
  fileClipboardAvailable: () => boolean = () => false
): RuntimeCapabilityProviders {
  return {
    getImplementation(capability) {
      switch (capability) {
        case 'screen.capture':
          return 'supported'
        case 'clipboard.files.read':
          return platform === 'windows' || fileClipboardAvailable() ? 'supported' : 'unavailable'
        case 'system.hibernate':
          return 'unsupported'
        default:
          return 'unavailable'
      }
    },
    getOsPermission(capability): CapabilityOsPermissionStatus {
      if (capability !== 'screen.capture') return 'unknown'
      if (platform === 'windows') return 'not-required'
      const status = screen.getScreenCapturePermissionStatus?.()
      if (status === undefined || status === 'unavailable') return 'unknown'
      return status
    },
    ...overrides
  }
}
