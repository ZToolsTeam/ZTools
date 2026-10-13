import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { RuntimeCapabilityTarget } from '../../contracts/runtime-capability.js'

export interface SystemPlatformAdapter {
  userDataPath: string
  getRuntimeTarget(): RuntimeCapabilityTarget
  getProductVersion?(): string
  getNativeId(): Promise<string>
}

export interface SystemPlatformAdapterFactories {
  windows(): SystemPlatformAdapter
  macos(): SystemPlatformAdapter
}

export function createSystemPlatformAdapter(
  platform: NodeJS.Platform,
  factories: SystemPlatformAdapterFactories
): SystemPlatformAdapter {
  switch (platform) {
    case 'win32':
      return factories.windows()
    case 'darwin':
      return factories.macos()
    default:
      throw new ZToolsError(errorCodes.notSupported, `Unsupported operating system: ${platform}`)
  }
}
