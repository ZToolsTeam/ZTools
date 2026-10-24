import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { FileClipboardAdapter } from '../services/clipboard-service.js'
import type { ScreenAdapter, ScreenCaptureFallback } from '../services/screen-service.js'

export interface ScreenClipboardAdapters {
  screen: ScreenAdapter
  screenCaptureFallback: ScreenCaptureFallback
  fileClipboard: FileClipboardAdapter
}

export interface ScreenClipboardAdapterFactories {
  windows(): ScreenClipboardAdapters
  macos?: () => ScreenClipboardAdapters
}

export function createPlatformScreenClipboardAdapters(
  platform: NodeJS.Platform,
  factories: ScreenClipboardAdapterFactories
): ScreenClipboardAdapters {
  switch (platform) {
    case 'win32':
      return factories.windows()
    case 'darwin':
      if (factories.macos) return factories.macos()
      throw new ZToolsError(
        errorCodes.notSupported,
        'macOS screen and file clipboard adapters are not configured'
      )
    default:
      throw new ZToolsError(
        errorCodes.notSupported,
        `Screen and file clipboard adapters are not configured for ${platform}`
      )
  }
}
