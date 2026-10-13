import { parentPort, workerData } from 'node:worker_threads'
import { PNG } from 'pngjs'
import { GIFEncoder, applyPalette, quantize } from 'gifenc'
import { imageHeader } from '../services/reference-image-service.js'
import { errorCodes, toPublicError, ZToolsError } from '../../contracts/errors.js'
if (!parentPort) throw new Error('WORKER_REQUIRED')
try {
  const { frames, width, height, interval, loop } = workerData as { frames: Uint8Array[]; width: number; height: number; interval: number; loop: boolean }
  if (!Array.isArray(frames) || !frames.length || frames.length > 64 || ![width, height].every(v => Number.isSafeInteger(v) && v > 0 && v <= 1024) || width * height * frames.length > 4 * 1024 * 1024 || !Number.isSafeInteger(interval) || interval < 10 || interval > 10000 || interval % 10 !== 0 || typeof loop !== 'boolean') throw new ZToolsError(errorCodes.invalidRequest, 'GIF编码参数无效')
  const gif = GIFEncoder(); let totalBytes = 0
  for (const value of frames) {
    const bytes = Buffer.from(value); totalBytes += bytes.length
    if (totalBytes > 16 * 1024 * 1024) throw new ZToolsError(errorCodes.fileTooLarge, 'GIF帧数据超过16MiB')
    const header = imageHeader(bytes)
    if (header.format !== 'png' || header.width > width || header.height > height) throw new ZToolsError(errorCodes.fileError, 'GIF帧尺寸或格式无效')
    const image = PNG.sync.read(bytes, { checkCRC: true }), rgba = new Uint8Array(width * height * 4).fill(255)
    const x = Math.floor((width - image.width) / 2), y = Math.floor((height - image.height) / 2)
    for (let row = 0; row < image.height; row++) for (let column = 0; column < image.width; column++) {
      const source = (row * image.width + column) * 4, target = ((row + y) * width + column + x) * 4, alpha = image.data[source + 3]! / 255
      for (let channel = 0; channel < 3; channel++) rgba[target + channel] = Math.round(image.data[source + channel]! * alpha + 255 * (1 - alpha))
    }
    const palette = quantize(rgba, 256, { format: 'rgb565' }), index = applyPalette(rgba, palette, 'rgb565')
    gif.writeFrame(index, width, height, { palette, delay: interval, repeat: loop ? 0 : -1, dispose: 1 })
    if (gif.bytesView().length > 16 * 1024 * 1024) throw new ZToolsError(errorCodes.fileTooLarge, 'GIF结果超过16MiB')
  }
  gif.finish(); parentPort.postMessage({ success: true, bytes: gif.bytes() })
} catch (error) { parentPort.postMessage({ success: false, error: toPublicError(error instanceof ZToolsError ? error : new ZToolsError(errorCodes.fileError, 'GIF编码失败')) }) }
finally { parentPort.close() }
