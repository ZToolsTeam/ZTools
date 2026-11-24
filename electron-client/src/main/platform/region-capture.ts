import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { t } from '../i18n/index.js'
import type { ScreenRectangle } from '../services/screen-service.js'
import type { RegionSelectionBackend } from './macos/region-selection.js'

/** 让用户框选屏幕区域（macOS 与 Windows 共用）；取消返回 undefined */
export interface RegionSelectorPort {
  selectScreenRegion(signal?: AbortSignal): Promise<ScreenRectangle | undefined>
  /** 宿主退出时关闭仍打开的框选遮罩 */
  stop(): Promise<void>
}

export function createRegionSelector(dependencies: {
  regionSelection: RegionSelectionBackend
  getDisplayBounds: () => ScreenRectangle[]
}): RegionSelectorPort {
  return {
    async selectScreenRegion(signal) {
      const bounds = dependencies.getDisplayBounds()
      if (bounds.length === 0) {
        throw new ZToolsError(errorCodes.screenError, t('regionCapture.error.noDisplay'), {
          i18nKey: 'regionCapture.error.noDisplay'
        })
      }
      return dependencies.regionSelection.select(bounds.map(rect => ({ ...rect })), signal ?? new AbortController().signal)
    },
    stop: () => dependencies.regionSelection.stop()
  }
}

export interface RegionCaptureDisplay {
  id: number
  bounds: ScreenRectangle
  scaleFactor: number
}

export interface RegionCaptureImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  crop(rect: ScreenRectangle): RegionCaptureImage
  toPNG(): Buffer
}

export interface RegionCaptureSource {
  display_id: string
  thumbnail: RegionCaptureImage
}

export interface RegionCaptureDependencies {
  getAllDisplays(): RegionCaptureDisplay[]
  getSources(thumbnailSize: { width: number; height: number }): Promise<RegionCaptureSource[]>
}

function contains(outer: ScreenRectangle, inner: ScreenRectangle): boolean {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
}

/**
 * 按显示器物理像素截取一块区域（框选结果总在单个显示器内）。
 * 不缩放到 DIP：Windows 150% 等缩放比例下保留原始清晰度，文字识别更准。
 */
export async function captureRegionPng(dependencies: RegionCaptureDependencies, rect: ScreenRectangle): Promise<Buffer> {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 1 || rect.height < 1) {
    throw new ZToolsError(errorCodes.invalidRequest, t('regionCapture.error.invalidRegion'), {
      i18nKey: 'regionCapture.error.invalidRegion'
    })
  }
  const displays = dependencies.getAllDisplays()
  const display = displays.find(item => contains(item.bounds, rect))
  if (!display) {
    throw new ZToolsError(errorCodes.screenError, t('regionCapture.error.crossDisplay'), {
      i18nKey: 'regionCapture.error.crossDisplay'
    })
  }
  const thumbnailSize = {
    width: Math.max(...displays.map(item => Math.ceil(item.bounds.width * item.scaleFactor))),
    height: Math.max(...displays.map(item => Math.ceil(item.bounds.height * item.scaleFactor)))
  }
  const sources = await dependencies.getSources(thumbnailSize)
  const matches = sources.filter(source => source.display_id === String(display.id))
  const source = matches.length === 1 ? matches[0] : sources.length === 1 && displays.length === 1 ? sources[0] : undefined
  if (!source || source.thumbnail.isEmpty()) {
    throw new ZToolsError(errorCodes.screenError, t('regionCapture.error.sourceNotFound'), {
      i18nKey: 'regionCapture.error.sourceNotFound'
    })
  }
  // 缩略图按显示器比例缩放到不超过 thumbnailSize，实际像素按缩略图尺寸换算
  const size = source.thumbnail.getSize()
  const scaleX = size.width / display.bounds.width
  const scaleY = size.height / display.bounds.height
  const left = Math.max(0, Math.floor((rect.x - display.bounds.x) * scaleX))
  const top = Math.max(0, Math.floor((rect.y - display.bounds.y) * scaleY))
  const crop = {
    x: left,
    y: top,
    width: Math.min(size.width - left, Math.ceil(rect.width * scaleX)),
    height: Math.min(size.height - top, Math.ceil(rect.height * scaleY))
  }
  if (crop.width < 1 || crop.height < 1) {
    throw new ZToolsError(errorCodes.screenError, t('regionCapture.error.captureFailed'), {
      i18nKey: 'regionCapture.error.captureFailed'
    })
  }
  const png = source.thumbnail.crop(crop).toPNG()
  if (png.length === 0) {
    throw new ZToolsError(errorCodes.screenError, t('regionCapture.error.captureFailed'), {
      i18nKey: 'regionCapture.error.captureFailed'
    })
  }
  return png
}
