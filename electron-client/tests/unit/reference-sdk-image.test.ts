import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

const file = { grantId: 'a'.repeat(43), kind: 'file', displayName: 'input.png', operations: ['read'] }
const save = { grantId: 'b'.repeat(43), kind: 'save', displayName: 'output.jpg', operations: ['write'] }
interface API {
  getInfo(input: unknown): Promise<unknown>
  convert(input: unknown, output: unknown, format: string, quality?: number): Promise<unknown>
  resize(input: unknown, output: unknown, width: number, height: number, options?: unknown): Promise<unknown>
  scale(input: unknown, output: unknown, scaleX: number, scaleY?: number): Promise<unknown>
  crop(input: unknown, output: unknown, rect: unknown): Promise<unknown>
  compress(input: unknown, output: unknown, quality?: number): Promise<unknown>
}
function fixture() {
  const source = ['fs-reference', 'image-reference'].map(file => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + file + '.js', 'utf8').replace(/^export .+$/mg, '')).join('\n')
  const calls: { method: string; params: unknown }[] = []
  let result: unknown = { success: true, status: 'committed', width: 20, height: 10, format: 'jpg', size: 200 }
  const Constructor = vm.runInNewContext(source + '\nReferenceImageAPI', { window: { __ztoolsElectron: { contractVersion: 2,
    transport: { methods: { image_get_info() {}, image_transform() {} } } } }, TextEncoder }) as new (transport: unknown) => API
  const api = new Constructor({ call: async (method: string, params: unknown) => { calls.push({ method, params: JSON.parse(JSON.stringify(params)) }); return result } })
  return { api, calls, response: (value: unknown) => { result = value } }
}

test('image SDK sends only FileRef/SaveRef IDs and maps conversion, resize, scale, crop and compression', async () => {
  const f = fixture()
  await f.api.convert(file, save, 'jpg', 75)
  assert.deepEqual(f.calls[0], { method: 'image_transform', params: { operation: 'convert', fileGrantId: file.grantId,
    saveGrantId: save.grantId, format: 'jpg', replace: false, quality: 75 } })
  await f.api.resize(file, save, 20, 10); await f.api.scale(file, save, 0.5)
  await f.api.crop(file, save, { x: 0, y: 0, width: 20, height: 10 }); await f.api.compress(file, save, 50)
  assert.deepEqual(f.calls.map(call => (call.params as { operation: string }).operation), ['convert', 'resize', 'scale', 'crop', 'compress'])
  assert.ok(!JSON.stringify(f.calls).includes('output.jpg'))
  f.response({ success: true, width: 100, height: 50, format: 'png' })
  const info = await f.api.getInfo(file); assert.ok(Object.isFrozen(info))
})
test('image SDK refuses raw paths, malformed dimensions and invalid save receipts', async () => {
  const f = fixture()
  await assert.rejects(f.api.convert('/raw/file.png', save, 'jpg'), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.api.resize(file, save, 0, 10), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.api.scale(file, save, Infinity), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.api.crop(file, save, { x: -1, y: 0, width: 1, height: 1 }), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.api.convert(file, save, 'gif'), { code: 'INVALID_REQUEST' })
  assert.equal(f.calls.length, 0)
  f.response({ success: true, status: 'pending', width: 20, height: 10, format: 'jpg', size: 200 })
  await assert.rejects(f.api.compress(file, save), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  f.response({ success: true, status: 'committed', width: NaN, height: 10, format: 'jpg', size: 200 })
  await assert.rejects(f.api.compress(file, save), { code: 'FILE_ERROR' })
})


test('existing public ImageAPI dispatches implemented contract2 functions through the shared provider', async () => {
  const files = ['fs-reference', 'image-reference', 'image']
  const source = files.map(file => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + file + '.js', 'utf8').replace(/^export .+$/mg, '')).join('\n')
  const calls: string[] = []
  const result = { success: true, status: 'committed', width: 20, height: 10, format: 'jpg', size: 100 }
  const Constructor = vm.runInNewContext(source + '\nImageAPI', { window: { __ztoolsElectron: { contractVersion: 2,
    transport: { methods: { image_get_info() {}, image_transform() {} } } }, ztools: { dllplugin: { callAsync: () => { throw new Error('old DLL path must not run') } } } }, TextEncoder }) as new (transport: unknown) => API
  const api = new Constructor({ call: async (_method: string, params: { operation?: string }) => { calls.push(params.operation ?? 'info'); return result } })
  assert.equal(await api.convert(file, save, 'jpg'), true); assert.equal(await api.resize(file, save, 20, 10), true)
  assert.equal(await api.scale(file, save, 0.5), true); assert.equal(await api.crop(file, save, { x: 0, y: 0, width: 20, height: 10 }), true)
  assert.equal(await api.compress(file, save), true)
  await api.getInfo(file)
  assert.deepEqual(calls, ['convert', 'resize', 'scale', 'crop', 'compress', 'info'])
})


test('public Base64 and image info SDK methods carry cancellation and return references without old paths', async () => {
  const source = ['fs-reference', 'image-reference', 'image'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join('\n')
  const calls: { method: string; params: unknown; signal: unknown }[] = []
  const cached = { ...file, grantId: 'c'.repeat(43), displayName: 'encoded.b64' }
  const port = () => {}
  const Constructor = vm.runInNewContext(source + '\nImageAPI', { window: { __ztoolsElectron: { contractVersion: 2,
    transport: { methods: { image_get_info: port, image_encode_base64: port, image_decode_base64: port },
      cancellations: { image_get_info: port, image_encode_base64: port, image_decode_base64: port } } } }, TextEncoder }) as new (transport: unknown) => {
      imageToBase64(input: unknown, format: undefined, options: unknown): Promise<{ reference: unknown; filePath?: string }>
      base64ToImage(input: unknown, output: unknown, format: string, options: unknown): Promise<boolean>
      getInfo(input: unknown, options: unknown): Promise<unknown>
    }
  const api = new Constructor({ supportsAbortSignal: true, call: async (method: string, params: unknown, options: { signal: unknown }) => {
    calls.push({ method, params: JSON.parse(JSON.stringify(params)), signal: options.signal })
    return method === 'image_encode_base64' ? { success: true, reference: cached, fileUrl: 'ztools://file/' + cached.grantId + '/encoded.b64', mimeType: 'image/png', size: 100 } :
      { success: true, status: 'committed', width: 20, height: 10, format: 'jpg', size: 100 }
  } })
  const signal = new AbortController().signal
  const encoded = await api.imageToBase64(file, undefined, { signal })
  assert.equal(encoded.filePath, undefined); assert.equal((encoded.reference as { grantId: string }).grantId, cached.grantId)
  assert.equal(await api.base64ToImage(cached, save, 'jpg', { signal }), true)
  await api.getInfo(file, { signal })
  assert.deepEqual(calls.map(call => call.method), ['image_encode_base64', 'image_decode_base64', 'image_get_info'])
  assert.ok(calls.every(call => call.signal === signal)); assert.ok(!JSON.stringify(calls).includes('output.jpg'))
})


test('public image transforms forward real cancellation and resolve one-axis resize before saving', async () => {
  const source = ['fs-reference', 'image-reference', 'image'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join('\n')
  const calls: { method: string; params: Record<string, unknown>; signal: unknown }[] = [], port = () => {}
  const Constructor = vm.runInNewContext(source + '\nImageAPI', { window: { __ztoolsElectron: { contractVersion: 2,
    transport: { methods: { image_get_info: port, image_transform: port }, cancellations: { image_get_info: port, image_transform: port } } } }, TextEncoder }) as new (transport: unknown) => Record<string, (...args: unknown[]) => Promise<unknown>>
  const api = new Constructor({ supportsAbortSignal: true, call: async (method: string, params: Record<string, unknown>, options: { signal: unknown }) => {
    calls.push({ method, params: JSON.parse(JSON.stringify(params)), signal: options.signal })
    return { success: true, status: 'committed', width: 20, height: 10, format: 'jpg', size: 100 }
  } })
  const signal = new AbortController().signal, options = { signal }
  for (const [method, args] of [['convert', [file, save, 'jpg', 85, options]], ['resize', [file, save, 20, 10, options]],
    ['scale', [file, save, 0.5, 0.5, options]], ['crop', [file, save, { x: 0, y: 0, width: 20, height: 10 }, options]],
    ['rotate', [file, save, 45, options]], ['flip', [file, save, 'vertical', options]], ['compress', [file, save, 75, options]]] as const) {
    assert.equal(await api[method]!(...args), true)
  }
  assert.ok(calls.every(call => call.signal === signal)); assert.equal(calls.length, 7)
  await api.resize!(file, save, 0, 5, options)
  assert.equal(calls[7]!.method, 'image_get_info')
  assert.equal(calls[8]!.params.width, 10); assert.equal(calls[8]!.params.height, 5)
  assert.ok(!JSON.stringify(calls).includes('output.jpg'))
})

test('public image preview forwards cancellation and accepts only a controlled read-only cache result', async () => {
  const source = ['fs-reference', 'image-reference', 'image'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join('\n')
  const port = () => {}, calls: { method: string; params: unknown; signal: unknown }[] = [], cached = { ...file, grantId: 'c'.repeat(43) }
  let result: unknown = { success: true, reference: cached, fileUrl: 'ztools://file/' + cached.grantId + '/' + encodeURIComponent(cached.displayName), size: 100, width: 10, height: 20, format: 'png' }
  const Constructor = vm.runInNewContext(source + '\nImageAPI', { window: { __ztoolsElectron: { contractVersion: 2,
    transport: { methods: { image_preview: port }, cancellations: { image_preview: port } } } }, TextEncoder }) as new (transport: unknown) => { preview(...args: unknown[]): Promise<{ reference: unknown }> }
  const api = new Constructor({ supportsAbortSignal: true, call: async (method: string, params: unknown, options: { signal: unknown }) => {
    calls.push({ method, params: JSON.parse(JSON.stringify(params)), signal: options.signal }); return result
  } })
  const signal = new AbortController().signal
  assert.equal(((await api.preview(file, 'rotate', { angle: 90 }, { format: 'png', signal })).reference as { grantId: string }).grantId, cached.grantId)
  assert.deepEqual(calls, [{ method: 'image_preview', params: { fileGrantId: file.grantId, operation: 'rotate', angle: 90, format: 'png' }, signal }])
  await assert.rejects(api.preview(file, 'convert', { saveGrantId: save.grantId }))
  result = { success: true, reference: save, fileUrl: 'C:/preview.png', size: 100, width: 10, height: 20, format: 'png' }
  await assert.rejects(api.preview(file, 'convert'), { code: 'FILE_ERROR' })
})

test('public image PDF API sends only file grant lists and SaveRef with real cancellation', async () => {
  const source = ['fs-reference', 'image-reference', 'image'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join('\n')
  const port = () => {}, signal = new AbortController().signal, calls: unknown[] = []
  let result = { success: true, status: 'committed', size: 100, pageCount: 2 }
  const Constructor = vm.runInNewContext(source + '\nImageAPI', { window: { __ztoolsElectron: { contractVersion: 2,
    transport: { methods: { image_to_pdf: port }, cancellations: { image_to_pdf: port } } } }, TextEncoder }) as new (transport: unknown) => { imagesToPDF(...args: unknown[]): Promise<boolean> }
  const api = new Constructor({ supportsAbortSignal: true, call: async (method: string, params: unknown, options: unknown) => { calls.push({ method, params: JSON.parse(JSON.stringify(params)), options: { signal: (options as { signal: unknown }).signal } }); return result } })
  assert.equal(await api.imagesToPDF([file, file], save, { signal }), true)
  assert.deepEqual(calls, [{ method: 'image_to_pdf', params: { fileGrantIds: [file.grantId, file.grantId], saveGrantId: save.grantId, replace: false }, options: { signal } }])
  await assert.rejects(api.imagesToPDF([], save))
  result = { ...result, status: 'unknown' }; await assert.rejects(api.imagesToPDF([file, file], save), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
})
