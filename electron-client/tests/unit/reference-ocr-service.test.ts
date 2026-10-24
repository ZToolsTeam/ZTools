import test from 'node:test'
import assert from 'node:assert/strict'
import { ReferenceOcrService } from '../../src/main/services/reference-ocr-service.js'
import { createReferenceOcrHandlers } from '../../src/main/ipc/reference-ocr-handlers.js'
const id = 'a'.repeat(43), caller = { type: 'main' as const, webContentsId: 42 }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=', 'base64')
const signal = () => new AbortController().signal
const recognized = () => ({ version: 1, success: true, provider: 'apple-vision-local', revision: 3, width: 1, height: 1, text: '中文 OCR', lines: [{ text: '中文 OCR', confidence: 0.9, box: [0, 0, 1, 1] }] })
function fixture() {
  let reads = 0, calls = 0; let bytes: Buffer = png
  let run = async (_request: unknown, _signal: AbortSignal): Promise<unknown> => recognized()
  const service = new ReferenceOcrService({ read: async (owner, grant, relative, maximum, signal) => {
    assert.equal(owner, 42); assert.equal(grant, id); assert.equal(relative, ''); assert.equal(maximum, 16 * 1024 * 1024); assert.equal(signal?.aborted, false); reads++; return bytes
  } }, { run: async (request, signal) => { calls++; return run(request, signal) } })
  return { service, counts: () => ({ reads, calls }), bytes: (value: Buffer) => { bytes = value }, run: (next: typeof run) => { run = next } }
}
test('OCR reference service reads only its owner grant and passes bounded bytes to local backend', async () => {
  const f = fixture(); f.run(async (request) => { assert.deepEqual(request, { version: 1, operation: 'recognize', imageBase64: png.toString('base64'), languages: ['zh-Hans', 'en-US'] }); return recognized() })
  const result = await createReferenceOcrHandlers(f.service).ocr_recognize_reference!.execute({ fileGrantId: id, languages: ['zh-Hans', 'en-US'] }, caller, signal()) as { success: boolean; text: string }
  assert.equal(result.success, true); assert.equal(result.text, '中文 OCR'); assert.deepEqual(f.counts(), { reads: 1, calls: 1 }); await f.service.stop()
})
test('OCR queries actual backend language support without opening a file', async () => {
  const f = fixture(); f.run(async request => { assert.deepEqual(request, { version: 1, operation: 'languages' }); return { version: 1, success: true, provider: 'apple-vision-local', revision: 3, languages: ['en-US', 'zh-Hans'] } })
  assert.deepEqual(await f.service.languages({}, caller, signal()), { success: true, provider: 'apple-vision-local', revision: 3, languages: ['en-US', 'zh-Hans'] }); assert.equal(f.counts().reads, 0)
})
test('OCR denies paths, cloud flags, excessive/duplicate languages before any read', async () => {
  const f = fixture()
  for (const params of [{ fileGrantId: 'C:/private.png' }, { fileGrantId: id, token: 'secret' }, { fileGrantId: id, languages: ['en-US', 'en-US'] }, { fileGrantId: id, languages: Array(9).fill('en-US') }, { fileGrantId: id, languages: ['bad/locale'] }]) await assert.rejects(f.service.recognize(params, caller, signal()))
  assert.deepEqual(f.counts(), { reads: 0, calls: 0 })
})
test('OCR rejects malformed image before launching helper', async () => {
  const f = fixture(); f.bytes(Buffer.from('not PNG')); await assert.rejects(f.service.recognize({ fileGrantId: id }, caller, signal())); assert.equal(f.counts().calls, 0)
})
test('OCR validates dimensions, confidence, text agreement and bounded lines; blank is legitimate', async () => {
  for (const patch of [{ width: 2 }, { text: 'different' }, { revision: 0 }, { lines: [{ text: '中文 OCR', confidence: NaN, box: [0, 0, 1, 1] }] }, { lines: [{ text: '中文 OCR', confidence: 0.5, box: [0.8, 0, 1, 1] }] }, { text: 'x'.repeat(1024 * 1024 + 1) }]) {
    const f = fixture(); f.run(async () => ({ ...recognized(), ...patch })); await assert.rejects(f.service.recognize({ fileGrantId: id }, caller, signal()))
  }
  const f = fixture(); f.run(async () => ({ ...recognized(), text: '', lines: [] })); assert.equal((await f.service.recognize({ fileGrantId: id }, caller, signal())).text, '')
})
test('OCR preabort, same-owner mutual exclusion and stop drain suppress late result', async () => {
  const f = fixture(), before = new AbortController(); before.abort(); await assert.rejects(f.service.recognize({ fileGrantId: id }, caller, before.signal), { code: 'CALLER_DESTROYED' }); assert.equal(f.counts().reads, 0)
  f.run((_request, aborted) => new Promise(resolve => aborted.addEventListener('abort', () => setTimeout(() => resolve(recognized()), 10), { once: true })))
  const pending = f.service.recognize({ fileGrantId: id }, caller, signal()); const rejected = assert.rejects(pending, { code: 'CALLER_DESTROYED' }); await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.service.languages({}, caller, signal()), { code: 'FILE_TOO_LARGE' }); await f.service.stop(); await rejected
  await assert.rejects(f.service.languages({}, caller, signal()), { code: 'CALLER_DESTROYED' })
})
