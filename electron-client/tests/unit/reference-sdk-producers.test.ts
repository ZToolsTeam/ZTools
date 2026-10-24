import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

interface WindowSDK {
  showOpenDialog(params?: unknown, options?: unknown): Promise<unknown>
  showSaveDialog(params?: unknown, options?: unknown): Promise<unknown>
}
interface ClipboardSDK {
  copyText(value: unknown): Promise<unknown>
  copyFile(value: unknown): Promise<unknown>
  hideAndPasteFile(): Promise<unknown>
  readFiles(): Promise<unknown>
  readImage(): Promise<unknown>
  onChange(handler: (value: unknown) => void): () => void
  offChange(handler?: (value: unknown) => void): void
}
interface ScreenSDK { capture(params?: unknown): Promise<unknown>; captureRegion(x: number, y: number, width: number, height: number): Promise<unknown> }
const file = { grantId: 'a'.repeat(43), displayName: 'file.png', kind: 'file', operations: ['read'] }
const save = { grantId: 'b'.repeat(43), displayName: 'output', kind: 'save', operations: ['write'] }
const fileUrl = 'ztools://file/' + file.grantId + '/file.png'
function stripModuleSyntax(source: string) {
  return source.split(/\r?\n/).map(line => {
    const trimmed = line.trim()
    if (trimmed.startsWith('import ')) return ''
    if (/^export\s+default\b/.test(trimmed) || /^export\s*\{/.test(trimmed)) return ''
    return line.replace(/^(\s*)export\s+/, '$1')
  }).join('\n')
}
function fixture() {
  const names = ['fs.js', 'fs-reference.js', 'window.js', 'clipboard.js', 'runtime-capability.js', 'screen.js', 'file-producers-reference.js']
  const source = names.map(name => stripModuleSyntax(fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name, 'utf8'))).join('\n')
  const calls: { method: string; params: unknown; options: { timeout?: number } }[] = []
  let result: unknown = { success: true }
  const transport = { isElectronEnvironment: () => true, call: async (method: string, params: unknown, options: { timeout?: number }) => { calls.push({ method, params: JSON.parse(JSON.stringify(params)), options }); return result } }
  const methods = Object.fromEntries([...source.matchAll(/'(window_show_[a-z_]+|clipboard_[a-z_]+|screen_capture)'/g)].map(match => [match[1], () => {}]))
  const eventHandlers = new Set<(value: unknown) => void>()
  const events = { on: (_key: string, handler: (value: unknown) => void) => { eventHandlers.add(handler) },
    off: (_key: string, handler: (value: unknown) => void) => { eventHandlers.delete(handler) } }
  let authorization: 'not-requested' | 'granted' = 'not-requested'
  const capabilityCalls: { method: string; capability: string; timeout?: number }[] = []
  const sys = {
    transport,
    getCapability: async (capability: string) => {
      capabilityCalls.push({ method: 'get', capability })
      return { authorization }
    },
    requestCapability: async (request: { capability: string }, options: { timeout?: number; signal?: AbortSignal }) => {
      capabilityCalls.push({ method: 'request', capability: request.capability,
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}) })
      if (options.signal?.aborted) throw Object.assign(new Error('aborted'), { code: 'CALLER_DESTROYED' })
      authorization = 'granted'
      return { authorization }
    }
  }
  const Constructors = vm.runInNewContext(source + '\n({ReferenceWindowAPI, ReferenceClipboardAPI, ReferenceScreenAPI, ScreenAPI})', {
    window: { __ztoolsElectron: { contractVersion: 2, transport: { methods } }, _writeFileArrayBuffer: () => { throw new Error('V8 must not run') } },
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa
  }) as { ReferenceWindowAPI: new (port: typeof transport) => WindowSDK; ReferenceClipboardAPI: new (port: typeof transport, events: unknown) => ClipboardSDK; ReferenceScreenAPI: new (port: typeof transport, sys?: unknown) => ScreenSDK; ScreenAPI: new (port: typeof transport, sys: unknown) => ScreenSDK & { captureReference(rect?: unknown): Promise<unknown> } }
  return { calls, result: (value: unknown) => { result = value }, window: new Constructors.ReferenceWindowAPI(transport),
    clipboard: new Constructors.ReferenceClipboardAPI(transport, events), screen: new Constructors.ReferenceScreenAPI(transport, sys),
    authorizedScreen: new Constructors.ScreenAPI(transport, sys), capabilityCalls, eventHandlers }
}

test('SDK2 dialogs return only references, reject old paths, and wait indefinitely for native user selection', async () => {
  const f = fixture(); f.result({ success: true, canceled: false, references: [file] })
  assert.deepEqual(JSON.parse(JSON.stringify(await f.window.showOpenDialog({ properties: ['openFile'] }))), { success: true, canceled: false, references: [file] })
  assert.equal(f.calls[0]!.options.timeout, Infinity)
  await assert.rejects(f.window.showOpenDialog({ defaultPath: '/raw' }), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.window.showSaveDialog({ defaultName: '../raw' }), { code: 'INVALID_REQUEST' })
  f.result({ success: true, canceled: false, references: [save] }); await f.window.showSaveDialog({ defaultName: 'output' })
  f.result({ success: true, canceled: false, references: [file], filePaths: ['/raw'] })
  await assert.rejects(f.window.showOpenDialog(), { code: 'FILE_ERROR' })
})

test('SDK2 clipboard text/file calls preserve FileRef and never use temporary raw paths or V8 fallback', async () => {
  const f = fixture(); await f.clipboard.copyText(file)
  assert.deepEqual(f.calls[0]!.params, { fileGrantId: file.grantId })
  await f.clipboard.copyText('plain text'); assert.deepEqual(f.calls[1]!.params, { text: 'plain text' })
  await assert.rejects(f.clipboard.copyFile('/raw'), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.clipboard.copyText({ tempFile: '/raw' }), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.clipboard.hideAndPasteFile(), { code: 'NOT_SUPPORTED' })
  f.result({ success: true, files: [file], errors: [] }); await f.clipboard.readFiles()
  f.result({ success: true, files: ['/raw'], errors: [] }); await assert.rejects(f.clipboard.readFiles(), { code: 'FILE_ERROR' })
})

test('SDK2 direct images are bounded and generated image/capture results validate references and dimensions', async () => {
  const f = fixture(); f.result({ success: true, image: 'data:image/png;base64,AP8H', useReference: false })
  await f.clipboard.readImage()
  f.result({ success: true, image: '', useReference: false, tempFile: '/raw' }); await assert.rejects(f.clipboard.readImage(), { code: 'FILE_ERROR' })
  const captured = { success: true, reference: file, fileUrl, size: 3, width: 1, height: 1 }
  f.result(captured)
  await f.authorizedScreen.captureReference({ x: 0, y: 0, width: 1, height: 1 })
  assert.deepEqual(f.capabilityCalls.map(call => call.method), ['get', 'request'])
  assert.equal(f.capabilityCalls[0]?.capability, 'screen.capture')
  assert.equal(f.capabilityCalls[1]?.capability, 'screen.capture')
  assert.equal(f.capabilityCalls[1]?.timeout, 120000)
  f.result(captured); await f.screen.captureRegion(0, 0, 1, 1)
  assert.deepEqual(f.calls.at(-1)!.params, { rect: { x: 0, y: 0, width: 1, height: 1 } })
  f.result({ ...captured, useReference: true }); await f.clipboard.readImage()
  for (const invalid of [{ ...captured, fileUrl: 'file:///raw' }, { ...captured, width: 0 }, { ...captured, size: 16 * 1024 * 1024 + 1 }, { ...captured, tempFile: '/raw' }]) {
    f.result(invalid); await assert.rejects(f.screen.capture(), { code: 'FILE_ERROR' })
  }
})

test('SDK2 clipboard events require reference payloads and dispose only listeners created by this API', () => {
  const f = fixture(), delivered: unknown[] = []
  const foreign = () => {}; f.eventHandlers.add(foreign)
  const dispose = f.clipboard.onChange(value => { delivered.push(value) })
  const payload = { contractVersion: 2, type: 'files', files: [file], errors: [], hasData: true }
  for (const handler of f.eventHandlers) handler({ type: 'clipboard_change', payload })
  assert.equal(delivered.length, 1)
  const owned = [...f.eventHandlers].find(handler => handler !== foreign)!
  for (const malformed of [{ ...payload, files: ['/raw'] }, { ...payload, contractVersion: 1 }, { ...payload, path: '/raw' }, { ...payload, hasData: false }]) {
    assert.throws(() => owned({ type: 'clipboard_change', payload: malformed }), { code: 'FILE_ERROR' })
  }
  assert.equal(delivered.length, 1)
  dispose(); dispose(); f.clipboard.offChange()
  assert.deepEqual([...f.eventHandlers], [foreign])
})
