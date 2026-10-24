import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { MacosProcessDiscoveryAdapter } from './macos/process-discovery.js'
import { WindowsProcessDiscoveryAdapter } from './windows/process-discovery.js'
import type { ProcessDiscoveryAdapter } from '../services/process-service.js'

export function createPlatformProcessDiscoveryAdapter(
  platform: NodeJS.Platform
): ProcessDiscoveryAdapter {
  switch (platform) {
    case 'win32':
      return new WindowsProcessDiscoveryAdapter()
    case 'darwin':
      return new MacosProcessDiscoveryAdapter()
    default:
      throw new ZToolsError(errorCodes.notSupported, `当前平台未配置进程发现适配器: ${platform}`)
  }
}
