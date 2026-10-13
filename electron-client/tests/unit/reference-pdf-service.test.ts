import test from 'node:test'
import assert from 'node:assert/strict'
import { ReferencePdfService } from '../../src/main/services/reference-pdf-service.js'
import { createReferenceImageHandlers } from '../../src/main/ipc/reference-image-handlers.js'
import type { ReferenceImageService } from '../../src/main/services/reference-image-service.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
const input = 'a'.repeat(43), output = 'b'.repeat(43), caller: CallerIdentity = { type: 'main', webContentsId: 42 }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP9sAAAAASUVORK5CYII=', 'base64')
function fixture() {
  let reads = 0, writes = 0, html = '', rendered = 0
  let render = async (_html: string, _signal: AbortSignal) => Buffer.from('%PDF-1.7\n%%EOF')
  let save = async () => ({ status: 'committed' as const, bytesWritten: 14 })
  const service = new ReferencePdfService({ read: async () => { reads++; return png }, save: async () => { writes++; return save() } },
    { createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }) }) },
    { render: async (value, signal) => { html = value; rendered++; return render(value, signal) }, stop: () => {} })
  return { service, counts: () => ({ reads, writes, rendered, html }), render: (next: typeof render) => { render = next }, save: (next: typeof save) => { save = next } }
}
test('PDF service renders ordered bounded image data and saves through a retained grant', async () => {
  const f = fixture(), signal = new AbortController().signal
  const result = await f.service.convert({ fileGrantIds: [input, input], saveGrantId: output }, caller, signal)
  assert.deepEqual(result, { success: true, status: 'committed', pageCount: 2, size: 14 })
  assert.equal(f.counts().reads, 2); assert.equal(f.counts().writes, 1)
  assert.equal((f.counts().html.match(/<section /g) ?? []).length, 2); assert.ok(f.counts().html.includes('data:image/png;base64,'))
  assert.ok(!f.counts().html.includes(input)); assert.ok(f.counts().html.includes('@page p1'))
  const handlers = createReferenceImageHandlers({} as ReferenceImageService, f.service)
  assert.equal((await handlers.image_to_pdf!.execute({ fileGrantIds: [input], saveGrantId: output }, caller, signal) as { pageCount: number }).pageCount, 1)
})
test('PDF validates input count, grant kinds at the writer and unknown options before rendering', async () => {
  const f = fixture(), signal = new AbortController().signal
  for (const params of [{ fileGrantIds: [], saveGrantId: output }, { fileGrantIds: Array(65).fill(input), saveGrantId: output },
    { fileGrantIds: [input], saveGrantId: output, path: 'C:/x.pdf' }, { fileGrantIds: ['bad'], saveGrantId: output }, { fileGrantIds: [input], saveGrantId: output, replace: 1 }]) {
    await assert.rejects(f.service.convert(params, caller, signal))
  }
  assert.equal(f.counts().rendered, 0); assert.equal(f.counts().writes, 0)
})
test('PDF refuses a non-PDF renderer result without writing', async () => {
  const f = fixture(); f.render(async () => png)
  await assert.rejects(f.service.convert({ fileGrantIds: [input], saveGrantId: output }, caller, new AbortController().signal), { code: 'FILE_ERROR' })
  assert.equal(f.counts().writes, 0)
})
test('PDF cancellation before rendering or during its renderer prevents any external save', async () => {
  const f = fixture(), before = new AbortController(); before.abort()
  await assert.rejects(f.service.convert({ fileGrantIds: [input], saveGrantId: output }, caller, before.signal), { code: 'CALLER_DESTROYED' })
  assert.equal(f.counts().reads, 0)
  const controller = new AbortController()
  f.render((_html, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }) }))
  const pending = f.service.convert({ fileGrantIds: [input], saveGrantId: output }, caller, controller.signal)
  await new Promise(resolve => setImmediate(resolve)); controller.abort()
  await assert.rejects(pending, { code: 'CALLER_DESTROYED' }); assert.equal(f.counts().writes, 0)
})
test('PDF late save cancellation reports unknown outcome rather than claiming no output', async () => {
  const f = fixture(), controller = new AbortController(); f.save(async () => { controller.abort(); return { status: 'committed', bytesWritten: 14 } })
  await assert.rejects(f.service.convert({ fileGrantIds: [input], saveGrantId: output }, caller, controller.signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.equal(f.counts().writes, 1)
})
test('PDF owner concurrency is bounded and stop cancels the active request', async () => {
  const f = fixture(), signal = new AbortController().signal
  f.render((_html, aborted) => new Promise((_resolve, reject) => aborted.addEventListener('abort', () => reject(new Error('stopped')), { once: true })))
  const pending = f.service.convert({ fileGrantIds: [input], saveGrantId: output }, caller, signal)
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(f.service.convert({ fileGrantIds: [input], saveGrantId: output }, caller, signal), { code: 'FILE_TOO_LARGE' })
  f.service.stop(); await assert.rejects(pending, { code: 'CALLER_DESTROYED' })
  await assert.rejects(f.service.convert({ fileGrantIds: [input], saveGrantId: output }, caller, signal), { code: 'CALLER_DESTROYED' })
})
