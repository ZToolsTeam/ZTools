import { WindowsFileClipboardAdapter } from './file-clipboard.js'
import { WindowsScreenCaptureFallback } from './screen-capture-fallback.js'
import {
  createElectronScreenAdapter,
  type ElectronScreenClipboardApi
} from '../common/electron-screen-adapter.js'
import type { ScreenClipboardAdapters } from '../screen-clipboard.js'

export function createWindowsScreenClipboardAdapters(
  electron: ElectronScreenClipboardApi
): ScreenClipboardAdapters {
  return {
    screen: createElectronScreenAdapter(electron),
    screenCaptureFallback: new WindowsScreenCaptureFallback(),
    fileClipboard: new WindowsFileClipboardAdapter()
  }
}
