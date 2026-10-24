import { errorCodes, ZToolsError } from '../../../contracts/errors.js'
import { MacosFileClipboardAdapter, macClipboardExecutable } from './file-clipboard.js'
import type {
  ScreenCaptureFallback,
  ScreenCapturePermissionStatus
} from '../../services/screen-service.js'
import {
  createElectronScreenAdapter,
  type ElectronScreenClipboardApi
} from '../common/electron-screen-adapter.js'
import type { ScreenClipboardAdapters } from '../screen-clipboard.js'

const screenCaptureFallback: ScreenCaptureFallback = {
  async capture() {
    throw new ZToolsError(errorCodes.notSupported, 'macOS screen capture fallback is not implemented')
  }
}

type MacosScreenPermissionApi = {
  getMediaAccessStatus?: (mediaType: 'screen') => Exclude<ScreenCapturePermissionStatus, 'unavailable'>
}

function readScreenCapturePermissionStatus(
  systemPreferences: MacosScreenPermissionApi | undefined
): ScreenCapturePermissionStatus {
  if (typeof systemPreferences?.getMediaAccessStatus !== 'function') return 'unavailable'
  try {
    const status = systemPreferences.getMediaAccessStatus('screen')
    switch (status) {
      case 'not-determined':
      case 'granted':
      case 'denied':
      case 'restricted':
      case 'unknown':
        return status
      default:
        return 'unknown'
    }
  } catch {
    return 'unknown'
  }
}

export function createMacosScreenClipboardAdapters(
  electron: ElectronScreenClipboardApi & { systemPreferences?: MacosScreenPermissionApi },
  packaged = false,
  resourcesPath = process.resourcesPath ?? ''
): ScreenClipboardAdapters {
  const electronScreen = createElectronScreenAdapter(electron)
  return {
    screen: {
      ...electronScreen,
      getScreenCapturePermissionStatus: () => readScreenCapturePermissionStatus(electron.systemPreferences)
    },
    screenCaptureFallback,
    fileClipboard: new MacosFileClipboardAdapter(macClipboardExecutable(packaged, resourcesPath))
  }
}
