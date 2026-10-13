import { PNG } from 'pngjs'
import type { ReferenceImageFactory } from '../../src/main/services/reference-image-service.js'
export function gifPngFixture(width: number, height: number, rgba: number[]): Buffer {
  const image = new PNG({ width, height })
  for (let offset = 0; offset < image.data.length; offset += 4) for (let channel = 0; channel < 4; channel++) image.data[offset + channel] = rgba[channel]!
  return PNG.sync.write(image)
}
export const gifTestFactory: Pick<ReferenceImageFactory, 'createFromBuffer'> = { createFromBuffer(bytes) {
  const parsed = PNG.sync.read(bytes)
  return { isEmpty: () => false, getSize: () => ({ width: parsed.width, height: parsed.height }), toPNG: () => bytes,
    toJPEG: () => { throw new Error('unused') }, toBitmap: () => parsed.data,
    crop: () => { throw new Error('unused') }, resize: () => { throw new Error('unit factory does not resize; actual Electron fixture covers resize') } }
} }
