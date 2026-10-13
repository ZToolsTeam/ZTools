import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type {
  ScreenCaptureParams,
  ScreenPointParams,
  ScreenRectParams
} from '../../contracts/method-params.js'
import type { FileSystemService } from './file-system-service.js'
import type { ReferenceCacheService } from './reference-cache-service.js'
import type { RuntimeCapabilityAuthorizationService, RuntimeCapabilityLease } from './runtime-capability-authorization-service.js'

const MAX_CAPTURE_PIXELS = 32 * 1024 * 1024

export interface ScreenRectangle {
  x: number
  y: number
  width: number
  height: number
}

export interface ScreenDisplay {
  id: number
  label: string
  bounds: ScreenRectangle
  workArea: ScreenRectangle
  scaleFactor: number
  rotation: number
  touchSupport: string
}

export interface ScreenImage {
  getSize(scaleFactor?: number): { width: number; height: number }
  resize(options: { width: number; height: number; quality: 'best' }): ScreenImage
  toBitmap(options?: { scaleFactor: number }): Buffer
  toPNG(): Buffer
}

export interface ScreenCaptureSource {
  displayId: string
  image: ScreenImage
}

export type ScreenCapturePermissionStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown'
  | 'unavailable'

export interface ScreenAdapter {
  getCursorScreenPoint(): { x: number; y: number }
  getPrimaryDisplay(): ScreenDisplay
  getAllDisplays(): ScreenDisplay[]
  getDisplayNearestPoint(point: { x: number; y: number }): ScreenDisplay
  getDisplayMatching(rect: ScreenRectangle): ScreenDisplay
  getSources(thumbnailSize: { width: number; height: number }): Promise<ScreenCaptureSource[]>
  createFromBitmap(buffer: Buffer, size: { width: number; height: number }): ScreenImage
  getScreenCapturePermissionStatus?(): ScreenCapturePermissionStatus
}

export interface ScreenCaptureFallback {
  capture(rect: ScreenRectangle, signal: AbortSignal): Promise<Buffer>
}

interface PublicDisplay {
  id: number
  index: number
  name: string
  primary: boolean
  bounds: ScreenRectangle
  workArea: ScreenRectangle
  scaleFactor: number
  rotation: number
  touchSupport: string
}

function screenFailure(error: unknown): ZToolsError {
  if (error instanceof ZToolsError) return error
  return new ZToolsError(errorCodes.screenError, '屏幕操作失败')
}

type ExplicitScreenPermissionDenial = 'not-determined' | 'denied' | 'restricted'

function isExplicitScreenPermissionDenial(
  status: ScreenCapturePermissionStatus | undefined
): status is ExplicitScreenPermissionDenial {
  return status === 'not-determined' || status === 'denied' || status === 'restricted'
}

function screenPermissionFailure(
  status: Exclude<ScreenCapturePermissionStatus, 'granted'>
): ZToolsError {
  switch (status) {
    case 'denied':
    case 'restricted':
      return new ZToolsError(
        errorCodes.permissionDenied,
        `macOS 屏幕录制权限未获准（TCC 状态：${status}）。请在系统设置的“隐私与安全性 > 屏幕录制”中授权后重试；如状态仍未更新，请重启 ZTools。`
      )
    case 'not-determined':
      return new ZToolsError(
        errorCodes.permissionDenied,
        'macOS 屏幕录制尚未授权（TCC 状态：not-determined）。请在系统提示中允许屏幕录制；如未出现提示，请在系统设置的“隐私与安全性 > 屏幕录制”中检查 ZTools 后重试。'
      )
    case 'unknown':
      return new ZToolsError(
        errorCodes.screenError,
        '无法确认 macOS 屏幕录制权限（TCC 状态：unknown）；为避免越过权限检查，已停止采集。请在系统设置确认状态后重试。'
      )
    case 'unavailable':
      return new ZToolsError(
        errorCodes.notSupported,
        '当前 Electron 运行时无法读取 macOS 屏幕录制权限状态（TCC 状态：unavailable）；为避免越过权限检查，已停止采集。'
      )
  }
}

function readScreenPermissionStatus(adapter: ScreenAdapter): ScreenCapturePermissionStatus | undefined {
  try {
    return adapter.getScreenCapturePermissionStatus?.()
  } catch {
    return 'unknown'
  }
}

function requireNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason === errorCodes.appStopping) {
    throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
  }
  if (signal.reason === errorCodes.permissionDenied) {
    throw new ZToolsError(errorCodes.permissionDenied, '屏幕采集授权已撤销')
  }
  throw new ZToolsError(errorCodes.callerDestroyed, '屏幕操作已取消')
}

function unionBounds(displays: ScreenDisplay[]): ScreenRectangle {
  if (displays.length === 0) throw new ZToolsError(errorCodes.screenError, '系统未返回可用显示器')
  const left = Math.min(...displays.map((display) => display.bounds.x))
  const top = Math.min(...displays.map((display) => display.bounds.y))
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width))
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function intersection(first: ScreenRectangle, second: ScreenRectangle): ScreenRectangle | undefined {
  const left = Math.max(first.x, second.x)
  const top = Math.max(first.y, second.y)
  const right = Math.min(first.x + first.width, second.x + second.width)
  const bottom = Math.min(first.y + first.height, second.y + second.height)
  if (right <= left || bottom <= top) return undefined
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export class ScreenService {
  constructor(
    private readonly files: FileSystemService,
    private readonly adapter: ScreenAdapter,
    private readonly fallback?: ScreenCaptureFallback,
    private readonly referenceCache?: Pick<ReferenceCacheService, 'writeGeneratedCacheFile' | 'revokeReference'>,
    private readonly capabilityAuthorization?: Pick<RuntimeCapabilityAuthorizationService, 'beginOperation'>
  ) {}

  beginCaptureAuthorization(caller: CallerIdentity): RuntimeCapabilityLease | undefined {
    if (!this.capabilityAuthorization && caller.type === 'plugin') {
      throw new ZToolsError(errorCodes.notSupported, '屏幕采集授权服务未接线，已停止截图')
    }
    const lease = this.capabilityAuthorization?.beginOperation('screen.capture', caller)
    if (caller.type === 'plugin' && !lease) {
      throw new ZToolsError(errorCodes.permissionDenied, '当前插件实例未获得屏幕采集授权')
    }
    return lease
  }

  getCursorScreenPoint(): { success: true; x: number; y: number } {
    const point = this.adapter.getCursorScreenPoint()
    return { success: true, x: point.x, y: point.y }
  }

  getPrimaryDisplay(): { success: true; display: PublicDisplay } {
    return { success: true, display: this.#publicDisplay(this.adapter.getPrimaryDisplay()) }
  }

  getAllDisplays(): { success: true; displays: PublicDisplay[] } {
    const primaryId = this.adapter.getPrimaryDisplay().id
    return {
      success: true,
      displays: this.adapter.getAllDisplays().map((display, index) => this.#publicDisplay(display, index, primaryId))
    }
  }

  getDisplayNearestPoint(params: ScreenPointParams): { success: true; display: PublicDisplay } {
    return { success: true, display: this.#publicDisplay(this.adapter.getDisplayNearestPoint(params.point)) }
  }

  getDisplayMatching(params: ScreenRectParams): { success: true; display: PublicDisplay } {
    return { success: true, display: this.#publicDisplay(this.adapter.getDisplayMatching(params.rect)) }
  }

  async capture(params: ScreenCaptureParams, caller: CallerIdentity, signal: AbortSignal): Promise<{ success: true; tempFile: string; width: number; height: number }> {
    const lease = this.beginCaptureAuthorization(caller)
    const operationSignal = lease ? AbortSignal.any([signal, lease.signal]) : signal
    let generatedPath: string | undefined
    try {
      lease?.assertCurrent()
      const result = await this.#captureBytes(params, operationSignal)
      lease?.assertCurrent()
      const generated = await this.files.writeGeneratedCacheFile('screenshots/screen_' + randomUUID() + '.png', result.png, caller)
      generatedPath = generated.path
      requireNotAborted(operationSignal)
      lease?.assertCurrent()
      return { success: true, tempFile: generated.path, width: result.width, height: result.height }
    } catch (error) {
      if (generatedPath && operationSignal.aborted) {
        await this.files.deleteFile({ path: generatedPath }, caller).catch(() => undefined)
      }
      throw screenFailure(error)
    } finally { lease?.release() }
  }

  async captureReference(params: ScreenCaptureParams, caller: CallerIdentity, signal: AbortSignal, existingLease?: RuntimeCapabilityLease) {
    const lease = existingLease ?? this.beginCaptureAuthorization(caller)
    const ownsLease = existingLease === undefined
    if (!this.referenceCache) {
      if (ownsLease) lease?.release()
      throw new ZToolsError(errorCodes.nativeHostUnavailable, '截图引用存储不可用')
    }
    const operationSignal = lease ? AbortSignal.any([signal, lease.signal]) : signal
    let generated: Awaited<ReturnType<ReferenceCacheService['writeGeneratedCacheFile']>> | undefined
    try {
      lease?.assertCurrent()
      const image = await this.#captureBytes(params, operationSignal)
      lease?.assertCurrent()
      generated = await this.referenceCache.writeGeneratedCacheFile(image.png, caller, 'png', operationSignal)
      requireNotAborted(operationSignal)
      lease?.assertCurrent()
      return { success: true as const, reference: generated.reference, fileUrl: generated.fileUrl,
        size: generated.size, width: image.width, height: image.height }
    } catch (error) {
      if (generated && (operationSignal.aborted || lease?.signal.aborted)) {
        try { await this.referenceCache.revokeReference(generated.reference, caller) }
        catch { throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '截图缓存已写入，引用未交付且清理未确认') }
        throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '截图缓存已写入，引用未交付；已请求撤销引用，缓存副作用未回滚')
      }
      throw screenFailure(error)
    } finally { if (ownsLease) lease?.release() }
  }

  async #captureBytes(params: ScreenCaptureParams, signal: AbortSignal): Promise<{ png: Buffer; width: number; height: number }> {
    try {
      requireNotAborted(signal)
      const permissionStatus = readScreenPermissionStatus(this.adapter)
      const isFirstScreenPermissionRequest = permissionStatus === 'not-determined'
      if (
        permissionStatus !== undefined &&
        permissionStatus !== 'granted' &&
        permissionStatus !== 'not-determined'
      ) {
        throw screenPermissionFailure(permissionStatus)
      }
      const displays = this.adapter.getAllDisplays()
      const layout = (items: ScreenDisplay[]) => JSON.stringify(items.map(display => ({ id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor, rotation: display.rotation })).sort((a, b) => a.id - b.id))
      const layoutBefore = layout(displays)
      const target = params.rect ?? unionBounds(displays)
      const pixels = target.width * target.height
      if (!Number.isSafeInteger(pixels) || pixels > MAX_CAPTURE_PIXELS) {
        throw new ZToolsError(errorCodes.fileTooLarge, '截图区域超过 32 Mi 像素上限')
      }

      const thumbnailSize = {
        width: Math.max(...displays.map((display) => Math.ceil(display.bounds.width * display.scaleFactor))),
        height: Math.max(...displays.map((display) => Math.ceil(display.bounds.height * display.scaleFactor)))
      }
      let sources: ScreenCaptureSource[]
      try {
        // An explicit capture call may let Electron initiate first-use screen TCC consent.
        // Read-only capability queries never invoke getSources and remain non-prompting.
        sources = await this.adapter.getSources(thumbnailSize)
      } catch (error) {
        const statusAfterCaptureFailure = readScreenPermissionStatus(this.adapter)
        if (isExplicitScreenPermissionDenial(statusAfterCaptureFailure)) {
          throw screenPermissionFailure(statusAfterCaptureFailure)
        }
        throw error
      }
      if (isFirstScreenPermissionRequest) {
        const statusAfterFirstPermissionRequest = readScreenPermissionStatus(this.adapter) ?? 'unknown'
        if (statusAfterFirstPermissionRequest !== 'granted') {
          throw screenPermissionFailure(statusAfterFirstPermissionRequest)
        }
      }
      requireNotAborted(signal)
      if (layout(this.adapter.getAllDisplays()) !== layoutBefore) throw new ZToolsError(errorCodes.screenError, '截图过程中显示器布局已改变，请重试')
      const sourceByDisplay = new Map<string, ScreenCaptureSource>()
      const ambiguousDisplayIds = new Set<string>()
      for (const source of sources) {
        if (source.displayId === '' || ambiguousDisplayIds.has(source.displayId)) continue
        if (sourceByDisplay.has(source.displayId)) {
          sourceByDisplay.delete(source.displayId)
          ambiguousDisplayIds.add(source.displayId)
          continue
        }
        sourceByDisplay.set(source.displayId, source)
      }
      const unmatchedDisplays = displays.filter(
        (display) => !sourceByDisplay.has(String(display.id))
      )
      const unidentifiedSources = sources.filter((source) => source.displayId === '')
      if (
        ambiguousDisplayIds.size === 0 &&
        unmatchedDisplays.length === 1 &&
        unidentifiedSources.length === 1
      ) {
        sourceByDisplay.set(String(unmatchedDisplays[0]!.id), unidentifiedSources[0]!)
      }
      const intersectingSources = displays
        .map((display) => ({
          display,
          source: sourceByDisplay.get(String(display.id))
        }))
        .filter(({ display }) => intersection(target, display.bounds))
      if (intersectingSources.some(({ source }) => !source || source.image.getSize().width < 1 || source.image.getSize().height < 1)) {
        if (!this.fallback) throw new ZToolsError(errorCodes.screenError, '屏幕截图源不可用')
        const png = await this.fallback.capture(target, signal)
        requireNotAborted(signal)
        return { png, width: target.width, height: target.height }
      }
      const output = Buffer.alloc(pixels * 4)
      for (let index = 3; index < output.length; index += 4) output[index] = 255

      for (const display of displays) {
        const overlap = intersection(target, display.bounds)
        if (!overlap) continue
        const source = sourceByDisplay.get(String(display.id))
        if (!source) {
          throw new ZToolsError(errorCodes.screenError, `显示器 ${display.id} 缺少截图源`)
        }
        const sourceSize = source.image.getSize()
        if (sourceSize.width < 1 || sourceSize.height < 1) {
          throw new ZToolsError(errorCodes.screenError, `显示器 ${display.id} 截图源为空`)
        }
        const normalized = source.image.resize({
          width: display.bounds.width,
          height: display.bounds.height,
          quality: 'best'
        })
        const bitmap = normalized.toBitmap({ scaleFactor: 1 })
        const expectedBytes = display.bounds.width * display.bounds.height * 4
        if (bitmap.byteLength !== expectedBytes) {
          const bitmapSize = normalized.getSize(1)
          throw new ZToolsError(
            errorCodes.screenError,
            `显示器 ${display.id} 位图尺寸异常: expected=${expectedBytes}, actual=${bitmap.byteLength}, size=${bitmapSize.width}x${bitmapSize.height}`
          )
        }
        const sourceX = overlap.x - display.bounds.x
        const sourceY = overlap.y - display.bounds.y
        const targetX = overlap.x - target.x
        const targetY = overlap.y - target.y
        for (let row = 0; row < overlap.height; row += 1) {
          const sourceStart = ((sourceY + row) * display.bounds.width + sourceX) * 4
          const targetStart = ((targetY + row) * target.width + targetX) * 4
          bitmap.copy(output, targetStart, sourceStart, sourceStart + overlap.width * 4)
        }
      }

      requireNotAborted(signal)
      const png = this.adapter.createFromBitmap(output, { width: target.width, height: target.height }).toPNG()
      requireNotAborted(signal)
      return { png, width: target.width, height: target.height }
    } catch (error) {
      throw screenFailure(error)
    }
  }

  #publicDisplay(display: ScreenDisplay, fallbackIndex?: number, primaryId?: number): PublicDisplay {
    const displays = this.adapter.getAllDisplays()
    const index = fallbackIndex ?? Math.max(0, displays.findIndex((item) => item.id === display.id))
    const resolvedPrimaryId = primaryId ?? this.adapter.getPrimaryDisplay().id
    return {
      id: display.id,
      index,
      name: display.label || `Display ${index + 1}`,
      primary: display.id === resolvedPrimaryId,
      bounds: { ...display.bounds },
      workArea: { ...display.workArea },
      scaleFactor: display.scaleFactor,
      rotation: display.rotation,
      touchSupport: display.touchSupport
    }
  }
}
