import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeImage } from 'electron'
import { ReferenceImageService, type ReferenceImageFactory } from '../../src/main/services/reference-image-service.js'
import type { PathGrantService } from '../../src/main/services/path-grant-service.js'
import { createReferenceImageHandlers } from '../../src/main/ipc/reference-image-handlers.js'

const fileGrantId = 'a'.repeat(43), saveGrantId = 'b'.repeat(43), caller = { type: 'main' as const, webContentsId: 42 }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=', 'base64')
function fixture() {
  const calls: unknown[] = [], written: Buffer[] = []
  let input: Buffer = png
  let readHook = async () => {}, saveHook = async () => {}, width = 100, height = 50
  const image = (w: number, h: number): ReturnType<ReferenceImageFactory['createFromBuffer']> => ({
    isEmpty: () => false, getSize: () => ({ width: w, height: h }),
    resize: options => { calls.push(options); return image(options.width!, options.height!) as NativeImage },
    crop: rect => { calls.push(rect); return image(rect.width, rect.height) as NativeImage },
    toBitmap: () => Buffer.alloc(w * h * 4, 100),
    toPNG: () => Buffer.from('png output'), toJPEG: quality => { calls.push(quality); return Buffer.from('jpg output') }
  })
  const grants: Pick<PathGrantService, 'read' | 'save'> = {
    read: async (owner, id, relative, maximum, signal) => { assert.equal(owner, 42); assert.equal(id, fileGrantId); assert.equal(relative, ''); assert.equal(maximum, 16 * 1024 * 1024); assert.ok(signal); await readHook(); return input },
    save: async (owner, id, bytes, replace, signal) => { assert.equal(owner, 42); assert.equal(id, saveGrantId); assert.equal(replace, false); assert.ok(signal); written.push(bytes); await saveHook(); return { status: 'committed', bytesWritten: bytes.length } }
  }
  const service = new ReferenceImageService(grants, { createFromBuffer: () => { calls.push('decode'); return image(width, height) },
    createFromBitmap: (_bytes, options) => image(options.width, options.height) })
  const params = { fileGrantId, saveGrantId, format: 'png', operation: 'convert' }
  return { service, params, calls, written, input: (bytes: Buffer) => { input = bytes }, size: (w: number, h: number) => { width = w; height = h },
    readHook: (hook: () => Promise<void>) => { readHook = hook }, saveHook: (hook: () => Promise<void>) => { saveHook = hook } }
}

test('shared image provider queries, converts, scales, crops and compresses using native grant bytes', async () => {
  const f = fixture(), signal = new AbortController().signal
  assert.deepEqual(await f.service.getInfo({ fileGrantId }, caller, signal), { success: true, width: 100, height: 50, format: 'png' })
  const converted = await f.service.transform(f.params, caller, signal)
  assert.deepEqual(converted, { success: true, status: 'committed', size: 10, width: 100, height: 50, format: 'png' })
  const resized = await f.service.transform({ ...f.params, operation: 'resize', width: 40, height: 40 }, caller, signal)
  assert.equal(resized.width, 40); assert.equal(resized.height, 20)
  const stretched = await f.service.transform({ ...f.params, operation: 'resize', width: 40, height: 40, keepAspectRatio: false }, caller, signal)
  assert.equal(stretched.height, 40)
  const scaled = await f.service.transform({ ...f.params, operation: 'scale', scaleX: 0.5, scaleY: 2 }, caller, signal)
  assert.equal(scaled.width, 50); assert.equal(scaled.height, 100)
  const cropped = await f.service.transform({ ...f.params, operation: 'crop', rect: { x: 10, y: 5, width: 20, height: 15 } }, caller, signal)
  assert.equal(cropped.width, 20); assert.equal(cropped.height, 15)
  const compressed = await f.service.transform({ ...f.params, operation: 'compress', format: 'jpg', quality: 70 }, caller, signal)
  assert.equal(compressed.format, 'jpg'); assert.ok(f.calls.includes(70)); assert.equal(f.written.length, 6)
})

test('bad image inputs, bounds and options produce errors without writing any output', async () => {
  const f = fixture(), signal = new AbortController().signal
  for (const params of [{ ...f.params, input: '/raw' }, { ...f.params, format: 'gif' }, { ...f.params, quality: 0 },
    { ...f.params, operation: 'crop', rect: { x: 90, y: 0, width: 20, height: 10 } },
    { ...f.params, operation: 'resize', width: 8192, height: 8192 }, { ...f.params, operation: 'convert', width: 10 },
    { ...f.params, operation: 'scale', scaleX: NaN, scaleY: 1 }]) await assert.rejects(f.service.transform(params, caller, signal))
  const huge = Buffer.from(png); huge.writeUInt32BE(100000, 16); f.input(huge)
  await assert.rejects(f.service.getInfo({ fileGrantId }, caller, signal), { code: 'FILE_TOO_LARGE' })
  f.input(Buffer.from('not an image')); await assert.rejects(f.service.getInfo({ fileGrantId }, caller, signal), { code: 'FILE_ERROR' })
  assert.equal(f.written.length, 0)
})

test('image cancellation before write avoids output and late save cancellation reports unknown outcome', async () => {
  const f = fixture(), early = new AbortController(); early.abort()
  await assert.rejects(f.service.transform(f.params, caller, early.signal), { code: 'CALLER_DESTROYED' }); assert.equal(f.calls.length, 0)
  const beforeDecode = new AbortController(); f.readHook(async () => { beforeDecode.abort() })
  await assert.rejects(f.service.transform(f.params, caller, beforeDecode.signal), { code: 'CALLER_DESTROYED' }); assert.equal(f.written.length, 0)
  f.readHook(async () => {}); const afterSave = new AbortController(); f.saveHook(async () => { afterSave.abort() })
  await assert.rejects(f.service.transform(f.params, caller, afterSave.signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' }); assert.equal(f.written.length, 1)
})

test('image requests have functional concurrency/stop semantics and concrete handler wiring', async () => {
  const f = fixture(), signal = new AbortController().signal
  let finish!: () => void; f.readHook(() => new Promise(resolve => { finish = resolve }))
  const pending = f.service.getInfo({ fileGrantId }, caller, signal)
  await assert.rejects(f.service.getInfo({ fileGrantId }, caller, signal), { code: 'FILE_TOO_LARGE' })
  f.service.stop(); finish(); await assert.rejects(pending, { code: 'CALLER_DESTROYED' })
  const next = fixture(), handlers = createReferenceImageHandlers(next.service)
  assert.equal((await handlers.image_get_info!.execute({ fileGrantId }, caller, signal) as { width: number }).width, 100)
  assert.equal((await handlers.image_transform!.execute(next.params, caller, signal) as { status: string }).status, 'committed')
})


test('image rotation and flips process pixels with cancellation points', async () => {
  const f = fixture(), signal = new AbortController().signal
  const rotated = await f.service.transform({ ...f.params, operation: 'rotate', angle: 90 }, caller, signal)
  assert.equal(rotated.width, 50); assert.equal(rotated.height, 100)
  const angled = await f.service.transform({ ...f.params, operation: 'rotate', angle: 45 }, caller, signal)
  assert.equal(angled.width, 107); assert.equal(angled.height, 107)
  for (const direction of ['horizontal', 'vertical']) {
    const flipped = await f.service.transform({ ...f.params, operation: 'flip', direction }, caller, signal)
    assert.equal(flipped.width, 100); assert.equal(flipped.height, 50)
  }
  const controller = new AbortController()
  const pending = f.service.transform({ ...f.params, operation: 'rotate', angle: 45 }, caller, controller.signal)
  setImmediate(() => controller.abort())
  await assert.rejects(pending, { code: 'CALLER_DESTROYED' }); assert.equal(f.written.length, 4)
})


test('Base64 decode accepts raw text and data URI but rejects malformed input before saving', async () => {
  const f = fixture(), signal = new AbortController().signal
  const params = { fileGrantId, saveGrantId, format: 'png' }
  for (const text of [png.toString('base64'), 'data:image/png;base64,' + png.toString('base64')]) {
    f.input(Buffer.from(text)); assert.equal((await f.service.decodeBase64(params, caller, signal)).status, 'committed')
  }
  for (const text of ['bad!', 'AB==', 'data:image/jpeg;base64,' + png.toString('base64'), 'data:image/svg+xml;base64,AAAA']) {
    f.input(Buffer.from(text)); await assert.rejects(f.service.decodeBase64(params, caller, signal), { code: 'INVALID_REQUEST' })
  }
  assert.equal(f.written.length, 2)
  f.input(Buffer.from(png.toString('base64')))
  const controller = new AbortController(); f.saveHook(async () => controller.abort())
  await assert.rejects(f.service.decodeBase64(params, caller, controller.signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  const noCache = fixture(); await assert.rejects(noCache.service.encodeBase64({ fileGrantId }, caller, signal), { code: 'METHOD_NOT_FOUND' })
})


test('image previews use the shared transforms and only return a private read-only cache reference', async () => {
  const signal = new AbortController().signal, reference = { grantId: 'c'.repeat(43), kind: 'file' as const, displayName: 'preview.png', operations: ['read' as const] }
  let cached = 0, revoked = 0, saved = 0
  const image: ReturnType<ReferenceImageFactory['createFromBuffer']> = { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }),
    resize: () => image as NativeImage, crop: () => image as NativeImage, toBitmap: () => Buffer.alloc(4), toPNG: () => png, toJPEG: () => png }
  const service = new ReferenceImageService({ read: async () => png, save: async () => { saved++; return { status: 'committed', bytesWritten: 1 } } },
    { createFromBuffer: () => image, createFromBitmap: () => image }, {
      writeGeneratedCacheFile: async bytes => { cached++; return { success: true, reference, fileUrl: 'ztools://file/' + reference.grantId + '/preview.png', size: bytes.length } },
      revokeReference: async () => { revoked++ }
    })
  const result = await service.preview({ fileGrantId, operation: 'resize', width: 1, height: 1, format: 'png' }, caller, signal)
  assert.ok('reference' in result)
  assert.equal(result.reference.grantId, reference.grantId); assert.equal(result.width, 1); assert.equal(cached, 1); assert.equal(saved, 0)
  await assert.rejects(service.preview({ fileGrantId, saveGrantId, operation: 'convert', format: 'png' }, caller, signal), { code: 'INVALID_REQUEST' })
  assert.equal(revoked, 0)
})

test('late cancelled image cache previews revoke their created reference and never save external output', async () => {
  const controller = new AbortController(), reference = { grantId: 'c'.repeat(43), kind: 'file' as const, displayName: 'preview.png', operations: ['read' as const] }
  const image: ReturnType<ReferenceImageFactory['createFromBuffer']> = { isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }),
    resize: () => image as NativeImage, crop: () => image as NativeImage, toBitmap: () => Buffer.alloc(4), toPNG: () => png, toJPEG: () => png }
  let revoked = 0, saved = 0
  const service = new ReferenceImageService({ read: async () => png, save: async () => { saved++; return { status: 'committed', bytesWritten: 1 } } },
    { createFromBuffer: () => image, createFromBitmap: () => image }, {
      writeGeneratedCacheFile: async bytes => { controller.abort(); return { success: true, reference, fileUrl: 'ztools://file/' + reference.grantId + '/preview.png', size: bytes.length } },
      revokeReference: async () => { revoked++ }
    })
  await assert.rejects(service.preview({ fileGrantId, operation: 'convert', format: 'png' }, caller, controller.signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.equal(revoked, 1); assert.equal(saved, 0)
})
