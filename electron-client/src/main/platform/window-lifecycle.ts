import { errorCodes, ZToolsError } from '../../contracts/errors.js'

export interface PlatformWindowLifecyclePolicy {
  quitWhenAllWindowsClose: boolean
  quitWhenMainWindowIsDestroyed: boolean
  reopenMainWindowOnActivate: boolean
  useSystemTray: boolean
}

export function createPlatformWindowLifecyclePolicy(
  platform: NodeJS.Platform
): PlatformWindowLifecyclePolicy {
  switch (platform) {
    case 'win32':
      return {
        quitWhenAllWindowsClose: true,
        quitWhenMainWindowIsDestroyed: true,
        reopenMainWindowOnActivate: false,
        useSystemTray: true
      }
    case 'darwin':
      return {
        quitWhenAllWindowsClose: false,
        quitWhenMainWindowIsDestroyed: false,
        reopenMainWindowOnActivate: true,
        useSystemTray: false
      }
    default:
      throw new ZToolsError(errorCodes.notSupported, `Unsupported operating system: ${platform}`)
  }
}
