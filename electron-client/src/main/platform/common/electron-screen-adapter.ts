import type { desktopCapturer, nativeImage, screen } from 'electron'
import type { ScreenAdapter } from '../../services/screen-service.js'

export type ElectronScreenClipboardApi = {
  screen: Pick<
    typeof screen,
    | 'getCursorScreenPoint'
    | 'getPrimaryDisplay'
    | 'getAllDisplays'
    | 'getDisplayNearestPoint'
    | 'getDisplayMatching'
  >
  desktopCapturer: Pick<typeof desktopCapturer, 'getSources'>
  nativeImage: Pick<typeof nativeImage, 'createFromBitmap'>
}

export function createElectronScreenAdapter(electron: ElectronScreenClipboardApi): ScreenAdapter {
  return {
    getCursorScreenPoint: () => electron.screen.getCursorScreenPoint(),
    getPrimaryDisplay: () => electron.screen.getPrimaryDisplay(),
    getAllDisplays: () => electron.screen.getAllDisplays(),
    getDisplayNearestPoint: (point) => electron.screen.getDisplayNearestPoint(point),
    getDisplayMatching: (rect) => electron.screen.getDisplayMatching(rect),
    async getSources(thumbnailSize) {
      const sources = await electron.desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize
      })
      return sources.map((source) => ({ displayId: source.display_id, image: source.thumbnail }))
    },
    createFromBitmap: (buffer, size) =>
      electron.nativeImage.createFromBitmap(buffer, { ...size, scaleFactor: 1 })
  }
}
