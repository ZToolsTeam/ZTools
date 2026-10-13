import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { GifReader } from 'omggif'
import { ReferenceGifService } from '../../src/main/services/reference-gif-service.js'
import { gifPngFixture, gifTestFactory } from '../helpers/gif-fixture.js'
const caller = { type: 'main' as const, webContentsId: 42 }, file = 'a'.repeat(43), second = 'b'.repeat(43), save = 's'.repeat(43)
const params = { fileGrantIds: [file, second], saveGrantId: save, interval: 250, loop: true }
const signal = () => new AbortController().signal
function fixture() {
  const images = [gifPngFixture(2, 2, [255, 0, 0, 255]), gifPngFixture(1, 1, [0, 0, 255, 255])], writes: Buffer[] = [], workers: Worker[] = [], reads: unknown[][] = []
  let receipt: { status: 'committed'; bytesWritten: number } | undefined
  const service = new ReferenceGifService({ read: async (...args) => { reads.push(args); return images[args[1] === file ? 0 : 1]! }, save: async (_owner, id, bytes, replace) => { assert.equal(id, save); assert.equal(replace, false); writes.push(bytes); return receipt ?? { status: 'committed', bytesWritten: bytes.length } } }, gifTestFactory,
    { createWorker: (url, options) => { const worker = new Worker(url, options); workers.push(worker); return worker } })
  return { service, images, writes, workers, reads, receipt: (value: typeof receipt) => { receipt = value } }
}
test('GIF uses actual encoder and independent decoder to verify frames, order, delays, infinite loop and white canvas', async () => {
  const f = fixture(), result = await f.service.convert(params, caller, signal())
  assert.deepEqual(result, { success: true, status: 'committed', size: f.writes[0]!.length, frameCount: 2, width: 2, height: 2 }); assert.equal(f.workers[0]?.threadId, -1)
  const gif = new GifReader(f.writes[0]!); assert.equal(gif.numFrames(), 2); assert.equal(gif.loopCount(), 0); assert.equal(gif.frameInfo(0).delay, 25); assert.equal(gif.frameInfo(1).delay, 25)
  const first = Buffer.alloc(16), next = Buffer.alloc(16); gif.decodeAndBlitFrameRGBA(0, first); gif.decodeAndBlitFrameRGBA(1, next)
  assert.deepEqual([...first.subarray(0, 4)], [255, 0, 0, 255]); assert.deepEqual([...next.subarray(0, 4)], [0, 0, 255, 255]); assert.deepEqual([...next.subarray(4, 8)], [255, 255, 255, 255])
  assert.deepEqual(f.reads[0]?.slice(0, 4), [42, file, '', 16 * 1024 * 1024]); await f.service.stop()
})
test('GIF once option omits looping extension and alpha is composited on white', async () => {
  const f = fixture(); f.images[0] = gifPngFixture(2, 2, [255, 0, 0, 0])
  await f.service.convert({ ...params, loop: false }, caller, signal())
  const gif = new GifReader(f.writes[0]!); assert.equal(gif.loopCount(), null)
  const pixels = Buffer.alloc(16); gif.decodeAndBlitFrameRGBA(0, pixels); assert.deepEqual([...pixels.subarray(0, 4)], [255, 255, 255, 255])
})
test('GIF invalid parameters and raw paths are rejected before reading', async () => {
  const f = fixture()
  for (const change of [{ interval: 0 }, { interval: 15 }, { loop: 'yes' }, { fileGrantIds: [] }, { fileGrantIds: ['/raw.png'] }, { saveGrantId: '/raw.gif' }, { output: 'raw' }]) await assert.rejects(f.service.convert({ ...params, ...change }, caller, signal()), { code: 'INVALID_REQUEST' })
  assert.equal(f.reads.length, 0); assert.equal(f.writes.length, 0)
})
test('GIF malformed images fail before worker and unconfirmed saves never report success', async () => {
  const f = fixture(); f.images[0] = Buffer.from('bad')
  await assert.rejects(f.service.convert(params, caller, signal()), { code: 'FILE_ERROR' }); assert.equal(f.workers.length, 0); assert.equal(f.writes.length, 0)
  const g = fixture(); g.receipt({ status: 'committed', bytesWritten: 1 })
  await assert.rejects(g.service.convert(params, caller, signal()), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
})
test('GIF cancel and timeout terminate actual worker before returning; no save occurs', async () => {
  const bytes = gifPngFixture(2, 2, [0, 255, 0, 255])
  for (const mode of ['abort', 'timeout'] as const) {
    let worker!: Worker, writes = 0; const controller = new AbortController()
    const service = new ReferenceGifService({ read: async () => bytes, save: async () => { writes++; return { status: 'committed', bytesWritten: 0 } } }, gifTestFactory,
      { timeoutMs: mode === 'timeout' ? 1 : 15000, createWorker: (url, options) => { worker = new Worker(url, options); if (mode === 'abort') setImmediate(() => controller.abort()); return worker } })
    await assert.rejects(service.convert(params, caller, controller.signal), { code: mode === 'abort' ? 'CALLER_DESTROYED' : 'REQUEST_TIMEOUT' })
    assert.equal(worker.threadId, -1); assert.equal(writes, 0); await service.stop()
  }
})
test('GIF stop drains pending reads, preabort and stopped calls make no further read', async () => {
  let finish!: (value: Buffer) => void, reads = 0, writes = 0
  const service = new ReferenceGifService({ read: () => { reads++; return new Promise(resolve => { finish = resolve }) }, save: async () => { writes++; return { status: 'committed', bytesWritten: 0 } } }, gifTestFactory)
  const pending = service.convert(params, caller, signal()), rejection = assert.rejects(pending, { code: 'CALLER_DESTROYED' })
  const stopped = service.stop(); finish(gifPngFixture(2, 2, [0, 0, 0, 255])); await stopped; await rejection
  await assert.rejects(service.convert(params, caller, signal()), { code: 'CALLER_DESTROYED' }); assert.equal(reads, 1); assert.equal(writes, 0)
  const f = fixture(), controller = new AbortController(); controller.abort(); await assert.rejects(f.service.convert(params, caller, controller.signal), { code: 'CALLER_DESTROYED' }); assert.equal(f.reads.length, 0)
})
test('GIF per-owner reservation prevents overlapping encodes', async () => {
  let finish!: (value: Buffer) => void
  const service = new ReferenceGifService({ read: () => new Promise(resolve => { finish = resolve }), save: async () => ({ status: 'committed', bytesWritten: 0 }) }, gifTestFactory)
  const pending = service.convert(params, caller, signal()), rejection = assert.rejects(pending, { code: 'CALLER_DESTROYED' })
  await assert.rejects(service.convert(params, caller, signal()), { code: 'FILE_TOO_LARGE' }); const stopped = service.stop(); finish(gifPngFixture(2, 2, [0, 0, 0, 255])); await stopped; await rejection
})

test('GIF preview generates real animation in owner cache without external SaveRef writes', async () => {
  const bytes = gifPngFixture(2, 2, [0, 0, 255, 255]); let cached: Buffer | undefined, writes = 0
  const reference = { grantId: 'c'.repeat(43), kind: 'file' as const, displayName: 'animation.gif', operations: ['read'] as const }
  const service = new ReferenceGifService({ read: async () => bytes, save: async () => { writes++; return { status: 'committed', bytesWritten: 0 } } }, gifTestFactory, {}, {
    writeGeneratedCacheFile: async (data, _caller, extension) => { assert.equal(extension, 'gif'); cached = data; return { success: true, reference, fileUrl: 'ztools://file/' + reference.grantId + '/animation.gif', size: data.length } }, revokeReference: async () => {}
  })
  const result = await service.preview({ fileGrantIds: [file, second], interval: 200, loop: true }, caller, signal())
  assert.ok('reference' in result); assert.equal(result.frameCount, 2); assert.equal(writes, 0); assert.equal(new GifReader(cached!).numFrames(), 2); await service.stop()
})
test('GIF preview cancellation after cache creation revokes late generated ownership', async () => {
  const bytes = gifPngFixture(2, 2, [0, 0, 255, 255]), controller = new AbortController(); let released = 0
  const reference = { grantId: 'c'.repeat(43), kind: 'file' as const, displayName: 'animation.gif', operations: ['read'] as const }
  const service = new ReferenceGifService({ read: async () => bytes, save: async () => { throw new Error('no external write') } }, gifTestFactory, {}, {
    writeGeneratedCacheFile: async data => { controller.abort(); return { success: true, reference, fileUrl: 'ztools://file/' + reference.grantId + '/animation.gif', size: data.length } }, revokeReference: async () => { released++ }
  })
  await assert.rejects(service.preview({ fileGrantIds: [file], interval: 200, loop: true }, caller, controller.signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' }); assert.equal(released, 1); await service.stop()
})
