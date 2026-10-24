import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { OrdinaryNativeRuntimePort } from '../native-host/dll-client-port.js'
import type { ServiceClient } from '../service/service-client.js'
import type { NativeInputAdapter } from '../super-panel/input-service.js'

export interface PlatformNativeRuntime {
  nativeHost: OrdinaryNativeRuntimePort | null
  serviceClient: ServiceClient | null
  nativeInput?: NativeInputAdapter | null
  start(signal?: AbortSignal): Promise<void>
}

export interface PlatformNativeRuntimeFactories {
  windows(): PlatformNativeRuntime
  macos(): PlatformNativeRuntime
}

export function createPlatformNativeRuntime(
  platform: NodeJS.Platform,
  factories: PlatformNativeRuntimeFactories
): PlatformNativeRuntime {
  switch (platform) {
    case 'win32':
      return factories.windows()
    case 'darwin':
      return factories.macos()
    default:
      throw new ZToolsError(errorCodes.notSupported, `Unsupported operating system: ${platform}`)
  }
}
