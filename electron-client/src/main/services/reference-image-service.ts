import type { NativeImage } from 'electron'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { grantId } from '../../contracts/path-reference.js'
import type { PathGrantService } from './path-grant-service.js'
import type { ReferenceCacheService } from './reference-cache-service.js'

type Image = Pick<NativeImage, 'isEmpty' | 'getSize' | 'resize' | 'crop' | 'toPNG' | 'toJPEG' | 'toBitmap'>
export interface ReferenceImageFactory {
  createFromBuffer(bytes: Buffer): Image
  createFromBitmap(bytes: Buffer, options: { width: number; height: number; scaleFactor: number }): Image
}
const maximumBytes = 16 * 1024 * 1024, maximumPixels = 8 * 1024 * 1024
const invalid = () => new ZToolsError(errorCodes.invalidRequest, '图片处理参数无效')
const failed = () => new ZToolsError(errorCodes.fileError, '图片处理失败或输入格式不受当前处理器支持')
function dimensions(width: unknown, height: unknown): { width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || Number(width) <= 0 || Number(height) <= 0 ||
      Number(width) > 8192 || Number(height) > 8192 || Number(width) * Number(height) > maximumPixels) {
    throw new ZToolsError(errorCodes.fileTooLarge, '图片尺寸超过当前处理器上限')
  }
  return { width: Number(width), height: Number(height) }
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(key => !keys.includes(key))) throw invalid()
  return value as Record<string, unknown>
}
export function imageHeader(bytes: Buffer): { format: 'png' | 'jpg'; width: number; height: number } {
  if (bytes.length > maximumBytes) throw new ZToolsError(errorCodes.fileTooLarge, '图片文件超过16MiB')
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw failed()
    const size = dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
    let offset = 8, chunks = 0, ended = false
    while (offset + 12 <= bytes.length) {
      if (++chunks > 4096) throw failed()
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8)
      if (length > bytes.length - offset - 12 || type === 'acTL') throw failed()
      offset += length + 12
      if (type === 'IEND') { ended = true; break }
    }
    if (!ended || offset !== bytes.length) throw failed()
    return { format: 'png', ...size }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2, markers = 0
    while (offset < bytes.length && offset < 1024 * 1024) {
      if (++markers > 4096 || bytes[offset++] !== 0xff) throw failed()
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === undefined || marker === 0 || marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) throw failed()
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || length > bytes.length - offset) throw failed()
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) throw failed()
        return { format: 'jpg', ...dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)) }
      }
      offset += length
    }
  }
  throw failed()
}

/** Shared Windows/macOS Electron codec backend. All files enter/leave via retained native grants. */
export class ReferenceImageService {
  readonly #pending = new Map<number, number>()
  #stopped = false
  constructor(private readonly grants: Pick<PathGrantService, 'read' | 'save'>, private readonly images: ReferenceImageFactory,
    private readonly cache?: Pick<ReferenceCacheService, 'writeGeneratedCacheFile' | 'revokeReference'>) {}
  stop(): void { this.#stopped = true }

  async getInfo(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    const params = record(value, ['fileGrantId']), id = grantId(params.fileGrantId)
    return this.#run(caller, signal, async () => {
      const { header, image } = await this.#load(id, caller, signal)
      return { success: true as const, ...dimensions(image.getSize().width, image.getSize().height), format: header.format }
    })
  }
  transform(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    return this.#transform(value, caller, signal, false)
  }
  preview(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    return this.#transform(value, caller, signal, true)
  }
  async #transform(value: unknown, caller: CallerIdentity, signal: AbortSignal, cacheOutput: boolean) {
    const params = record(value, ['fileGrantId', ...(cacheOutput ? [] : ['saveGrantId']), 'operation', 'format', 'width', 'height', 'scaleX', 'scaleY', 'rect', 'keepAspectRatio', 'quality', 'replace', 'angle', 'direction'])
    const input = grantId(params.fileGrantId), output = cacheOutput ? undefined : grantId(params.saveGrantId)
    if (typeof params.operation !== 'string' || !['convert', 'resize', 'scale', 'crop', 'compress', 'rotate', 'flip'].includes(params.operation) ||
        typeof params.format !== 'string' || !['png', 'jpg'].includes(params.format) || (params.replace !== undefined && typeof params.replace !== 'boolean') ||
        (params.quality !== undefined && (!Number.isSafeInteger(params.quality) || Number(params.quality) < 1 || Number(params.quality) > 100)) ||
        (params.keepAspectRatio !== undefined && typeof params.keepAspectRatio !== 'boolean')) throw invalid()
    const operation = params.operation
    const optionKeys = operation === 'resize' ? ['width', 'height', 'keepAspectRatio'] : operation === 'scale' ? ['scaleX', 'scaleY'] : operation === 'crop' ? ['rect'] : operation === 'rotate' ? ['angle'] : operation === 'flip' ? ['direction'] : []
    if (['width', 'height', 'keepAspectRatio', 'scaleX', 'scaleY', 'rect', 'angle', 'direction'].some(key => params[key] !== undefined && !optionKeys.includes(key))) throw invalid()
    const requestedSize = operation === 'resize' ? dimensions(params.width, params.height) : undefined
    const rectangle = operation === 'crop' ? record(params.rect, ['x', 'y', 'width', 'height']) : undefined
    if (rectangle && (!Number.isSafeInteger(rectangle.x) || !Number.isSafeInteger(rectangle.y) || Number(rectangle.x) < 0 || Number(rectangle.y) < 0)) throw invalid()
    if (rectangle) dimensions(rectangle.width, rectangle.height)
    if (operation === 'scale' && [params.scaleX, params.scaleY].some(scale => typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.1 || scale > 5)) throw invalid()
    if (operation === 'rotate' && (typeof params.angle !== 'number' || !Number.isFinite(params.angle) || Math.abs(params.angle) > 36000)) throw invalid()
    if (operation === 'flip' && !['horizontal', 'vertical'].includes(String(params.direction))) throw invalid()
    return this.#run(caller, signal, async () => {
      if (cacheOutput && !this.cache) throw new ZToolsError(errorCodes.methodNotFound, '图片缓存处理器尚未接线')
      let { image } = await this.#load(input, caller, signal)
      const original = dimensions(image.getSize().width, image.getSize().height)
      if (operation === 'resize' && requestedSize) {
        const ratio = Math.min(requestedSize.width / original.width, requestedSize.height / original.height)
        const size = params.keepAspectRatio === false ? requestedSize : dimensions(Math.max(1, Math.round(original.width * ratio)), Math.max(1, Math.round(original.height * ratio)))
        image = image.resize({ ...size, quality: 'best' })
      } else if (operation === 'scale') {
        image = image.resize({ ...dimensions(Math.max(1, Math.round(original.width * Number(params.scaleX))), Math.max(1, Math.round(original.height * Number(params.scaleY)))), quality: 'best' })
      } else if (operation === 'crop' && rectangle) {
        const rect = { x: Number(rectangle.x), y: Number(rectangle.y), width: Number(rectangle.width), height: Number(rectangle.height) }
        if (rect.x > original.width - rect.width || rect.y > original.height - rect.height) throw invalid()
        image = image.crop(rect)
      } else if (operation === 'rotate' || operation === 'flip') {
        image = await this.#pixels(image, params, signal)
      } else if (operation !== 'convert' && operation !== 'compress') throw invalid()
      this.#active(signal)
      if (image.isEmpty()) throw failed()
      const size = dimensions(image.getSize().width, image.getSize().height)
      const bytes = params.format === 'png' ? image.toPNG({ scaleFactor: 1 }) : image.toJPEG(Number(params.quality ?? 85))
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximumBytes) throw new ZToolsError(errorCodes.fileTooLarge, '处理后图片超过16MiB')
      // Give cancellation/owner teardown an event-loop turn before starting a file write.
      await new Promise<void>(resolve => setImmediate(resolve)); this.#active(signal)
      if (cacheOutput) {
        const result = await this.cache!.writeGeneratedCacheFile(bytes, caller, String(params.format), signal)
        if (this.#stopped || signal.aborted) {
          try { await this.cache!.revokeReference(result.reference, caller) }
          finally { throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '预览缓存已写入，但结果未交付') }
        }
        return { success: true as const, reference: result.reference, fileUrl: result.fileUrl, size: result.size, ...size, format: params.format }
      }
      if (!output) throw invalid()
      const receipt = await this.grants.save(caller.webContentsId, output, bytes, params.replace === true, signal)
      if (this.#stopped || signal.aborted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '图片保存结果未交付，需核实目标文件')
      return { success: true as const, status: receipt.status, size: receipt.bytesWritten, ...size, format: params.format }
    })
  }
  async encodeBase64(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    const params = record(value, ['fileGrantId']), input = grantId(params.fileGrantId)
    return this.#run(caller, signal, async () => {
      if (!this.cache) throw new ZToolsError(errorCodes.methodNotFound, '图片缓存处理器尚未接线')
      const { bytes, header } = await this.#load(input, caller, signal)
      const encodedLength = Math.ceil(bytes.length / 3) * 4
      if (encodedLength > maximumBytes) throw new ZToolsError(errorCodes.fileTooLarge, 'Base64编码结果超过16MiB')
      await new Promise<void>(resolve => setImmediate(resolve)); this.#active(signal)
      const result = await this.cache.writeGeneratedCacheFile(Buffer.from(bytes.toString('base64'), 'ascii'), caller, 'b64', signal)
      if (this.#stopped || signal.aborted) {
        await this.cache.revokeReference(result.reference, caller)
        throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, 'Base64缓存已写入，但结果未交付')
      }
      return { success: true as const, reference: result.reference, fileUrl: result.fileUrl,
        size: result.size, mimeType: header.format === 'png' ? 'image/png' : 'image/jpeg' }
    })
  }
  async decodeBase64(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    const params = record(value, ['fileGrantId', 'saveGrantId', 'format', 'quality', 'replace'])
    const input = grantId(params.fileGrantId), output = grantId(params.saveGrantId)
    if (!['png', 'jpg'].includes(String(params.format)) ||
        (params.quality !== undefined && (!Number.isSafeInteger(params.quality) || Number(params.quality) < 1 || Number(params.quality) > 100)) ||
        (params.replace !== undefined && typeof params.replace !== 'boolean')) throw invalid()
    return this.#run(caller, signal, async () => {
      const textBytes = await this.grants.read(caller.webContentsId, input, '', maximumBytes, signal)
      this.#active(signal)
      if (textBytes.length > maximumBytes || textBytes.some(byte => byte > 127)) throw invalid()
      const text = textBytes.toString('ascii').trim()
      const match = /^data:image\/(png|jpeg|jpg);base64,([\s\S]*)$/.exec(text)
      const encoded = (match ? match[2]! : text).replace(/[ \t\r\n]/g, '')
      if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw invalid()
      const bytes = Buffer.from(encoded, 'base64')
      if (bytes.toString('base64') !== encoded) throw invalid()
      const header = imageHeader(bytes)
      if (match && (match[1] === 'png') !== (header.format === 'png')) throw invalid()
      const image = this.images.createFromBuffer(bytes)
      if (image.isEmpty()) throw failed()
      const size = dimensions(image.getSize().width, image.getSize().height)
      const encodedImage = params.format === 'png' ? image.toPNG({ scaleFactor: 1 }) : image.toJPEG(Number(params.quality ?? 85))
      if (!Buffer.isBuffer(encodedImage) || !encodedImage.length || encodedImage.length > maximumBytes) throw failed()
      await new Promise<void>(resolve => setImmediate(resolve)); this.#active(signal)
      const receipt = await this.grants.save(caller.webContentsId, output, encodedImage, params.replace === true, signal)
      if (this.#stopped || signal.aborted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '图片保存结果未交付，需核实目标文件')
      return { success: true as const, status: receipt.status, size: receipt.bytesWritten, ...size, format: params.format }
    })
  }
  async #pixels(image: Image, params: Record<string, unknown>, signal: AbortSignal): Promise<Image> {
    const original = dimensions(image.getSize().width, image.getSize().height)
    const input = image.toBitmap({ scaleFactor: 1 })
    if (!Buffer.isBuffer(input) || input.length !== original.width * original.height * 4) throw failed()
    const radians = (((Number(params.angle ?? 0) % 360) + 360) % 360) * Math.PI / 180
    const cos = Math.cos(radians), sin = Math.sin(radians)
    const size = params.operation === 'flip' ? original : dimensions(
      Math.ceil(original.width * Math.abs(cos) + original.height * Math.abs(sin) - 1e-10),
      Math.ceil(original.width * Math.abs(sin) + original.height * Math.abs(cos) - 1e-10))
    const output = Buffer.alloc(size.width * size.height * 4)
    for (let y = 0; y < size.height; y++) {
      if (y % 32 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); this.#active(signal) }
      for (let x = 0; x < size.width; x++) {
        let sx: number, sy: number
        if (params.operation === 'flip') {
          sx = params.direction === 'horizontal' ? original.width - 1 - x : x
          sy = params.direction === 'vertical' ? original.height - 1 - y : y
        } else {
          const dx = x - (size.width - 1) / 2, dy = y - (size.height - 1) / 2
          sx = Math.round(cos * dx + sin * dy + (original.width - 1) / 2)
          sy = Math.round(-sin * dx + cos * dy + (original.height - 1) / 2)
        }
        if (sx >= 0 && sy >= 0 && sx < original.width && sy < original.height) {
          const source = (sy * original.width + sx) * 4, destination = (y * size.width + x) * 4
          output[destination] = input[source]!
          output[destination + 1] = input[source + 1]!
          output[destination + 2] = input[source + 2]!
          output[destination + 3] = input[source + 3]!
        }
      }
    }
    this.#active(signal)
    return this.images.createFromBitmap(output, { ...size, scaleFactor: 1 })
  }
  async #load(id: string, caller: CallerIdentity, signal: AbortSignal) {
    const bytes = await this.grants.read(caller.webContentsId, id, '', maximumBytes, signal)
    this.#active(signal)
    const header = imageHeader(bytes), image = this.images.createFromBuffer(bytes)
    if (image.isEmpty()) throw failed()
    dimensions(image.getSize().width, image.getSize().height)
    return { bytes, header, image }
  }
  #active(signal: AbortSignal): void {
    if (this.#stopped || signal.aborted) throw new ZToolsError(errorCodes.callerDestroyed, '图片处理已取消')
  }
  async #run<T>(caller: CallerIdentity, signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    this.#active(signal)
    if (!Number.isSafeInteger(caller.webContentsId) || caller.webContentsId <= 0 || !['main', 'plugin'].includes(caller.type)) throw invalid()
    const owned = this.#pending.get(caller.webContentsId) ?? 0
    if (owned >= 1 || [...this.#pending.values()].reduce((sum, count) => sum + count, 0) >= 2) throw new ZToolsError(errorCodes.fileTooLarge, '图片处理任务已达上限')
    this.#pending.set(caller.webContentsId, owned + 1)
    try { return await execute() }
    catch (error) { if (error instanceof ZToolsError) throw error; throw failed() }
    finally { this.#pending.delete(caller.webContentsId) }
  }
}
