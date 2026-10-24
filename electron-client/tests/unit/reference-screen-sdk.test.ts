import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import { createReferenceScreenHandlers } from '../../src/main/ipc/reference-screen-handlers.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
const id = 'a'.repeat(43), reference = { grantId: id, kind: 'file', displayName: 'screen.png', operations: ['read'] }
function fixture(sys?: unknown) {
  const methods = Object.fromEntries(['screen_capture', 'filesystem_read_file', 'filesystem_revoke', 'screen_get_cursor_pos', 'screen_get_all_displays'].map(name => [name, () => {}]))
  const capabilitySource = fs.readFileSync('../frontend/public/js/cef-ipc/src/api/runtime-capability.js', 'utf8').replace(/^export /gm, '')
  const source = capabilitySource + String.fromCharCode(10) + ['fs-reference', 'screen'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^import .+$/mg, '').replace(/^export .+$/mg, '')).join(String.fromCharCode(10))
  const Constructor = vm.runInNewContext(source + String.fromCharCode(10) + 'ScreenAPI', { window: { __ztoolsElectron: { contractVersion: 2, transport: { methods, cancellations: methods } } }, TextEncoder, Uint8Array, atob, btoa }) as new (transport: unknown, sys?: unknown) => { capture(rect?: unknown, callback?: unknown, options?: unknown): Promise<string>; captureReference(rect?: unknown, options?: unknown): Promise<{ reference: unknown; fileUrl: string }>; getCursorScreenPoint(): Promise<unknown>; getAllDisplays(): Promise<unknown> }
  const calls: { method: string; params: unknown; options: unknown }[] = []
  let capture = { success: true, reference, fileUrl: 'ztools://file/' + id + '/screen.png', size: 3, width: 1, height: 1 }
  let read = async () => ({ success: true, content: 'YWJj', size: 3 })
  const api = new Constructor({ supportsAbortSignal: true, call: async (method: string, params: unknown, options: unknown) => {
    calls.push({ method, params, options })
    if (method === 'screen_capture') return capture
    if (method === 'filesystem_read_file') return read()
    if (method === 'screen_get_cursor_pos') return { success: true, x: -20, y: 10 }
    if (method === 'screen_get_all_displays') return { success: true, displays: [{ id: 1 }] }
    return { success: true }
  } }, sys)
  return { api, calls, capture: (value: typeof capture) => { capture = value }, value: () => capture, read: (fn: typeof read) => { read = fn } }
}
test('captureReference returns a frozen owned FileRef and forwards real cancellation without legacy paths', async () => {
  const f = fixture(), signal = new AbortController().signal, rect = { x: -2, y: 0, width: 1, height: 1 }
  const result = await f.api.captureReference(rect, { signal })
  assert.equal(result.fileUrl, f.value().fileUrl); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.reference))
  assert.equal(f.calls.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0]?.params)), { rect }); assert.equal((f.calls[0]?.options as { signal: AbortSignal }).signal, signal)
})
test('capture base64 reads native ref and releases it before callback, including read failures', async () => {
  const f = fixture(); let callback = ''
  assert.equal(await f.api.capture(undefined, (value: string) => { assert.equal(f.calls.at(-1)?.method, 'filesystem_revoke'); callback = value }), 'data:image/png;base64,YWJj')
  assert.equal(callback, 'data:image/png;base64,YWJj'); assert.deepEqual(f.calls.map(call => call.method), ['screen_capture', 'filesystem_read_file', 'filesystem_revoke'])
  const g = fixture(); g.read(async () => { throw new Error('read failed') })
  await assert.rejects(g.api.capture(), /read failed/); assert.equal(g.calls.at(-1)?.method, 'filesystem_revoke')
})
test('invalid capture metadata/URL revokes delivered reference, preabort makes no request', async () => {
  for (const change of [{ width: 0 }, { fileUrl: 'file:///private' }, { size: 17 * 1024 * 1024 }]) {
    const f = fixture(); f.capture({ ...f.value(), ...change })
    await assert.rejects(f.api.captureReference(), { code: 'SCREEN_ERROR' }); assert.equal(f.calls.at(-1)?.method, 'filesystem_revoke')
  }
  const g = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(g.api.captureReference(undefined, { signal: controller.signal }), { code: 'CALLER_DESTROYED' }); assert.equal(g.calls.length, 0)
})
test('screen queries use shared reference method ports and preserve negative cursor coordinates', async () => {
  const f = fixture(); assert.deepEqual(JSON.parse(JSON.stringify(await f.api.getCursorScreenPoint())), { x: -20, y: 10 }); assert.deepEqual(JSON.parse(JSON.stringify(await f.api.getAllDisplays())), [{ id: 1 }])
})
test('shared screen handlers validate arguments before adapter calls', async () => {
  let count = 0
  const handlers = createReferenceScreenHandlers({ getCursorScreenPoint: () => { count++; return { success: true, x: -5, y: 2 } }, getPrimaryDisplay: () => { throw new Error('unused') }, getAllDisplays: () => { throw new Error('unused') }, getDisplayNearestPoint: () => { throw new Error('unused') }, getDisplayMatching: () => { throw new Error('unused') } })
  const caller = { webContentsId: 1 } as CallerIdentity, signal = new AbortController().signal
  assert.deepEqual(await handlers.screen_get_cursor_pos!.execute({}, caller, signal), { success: true, x: -5, y: 2 }); assert.equal(count, 1)
  await assert.rejects(handlers.screen_get_cursor_pos!.execute({ path: 'raw' }, caller, signal), { code: 'INVALID_REQUEST' }); assert.equal(count, 1)
  await assert.rejects(handlers.screen_get_display_nearest!.execute({ point: { x: Infinity, y: 1 } }, caller, signal), { code: 'INVALID_REQUEST' })
})

test('SDK2 screen capture gates the normal reference request behind instance authorization', async () => {
  let requests = 0
  const sys = {
    transport: { isElectronEnvironment: () => true },
    async getCapability() { return { authorization: 'not-requested' } },
    async requestCapability() { requests += 1; return { authorization: 'granted' } }
  }
  const f = fixture(sys)
  await f.api.captureReference()
  assert.equal(requests, 1)
  assert.equal(f.calls[0]?.method, 'screen_capture')

  const denied = fixture({
    transport: { isElectronEnvironment: () => true },
    async getCapability() { return { authorization: 'denied' } },
    async requestCapability() { throw new Error('denied capture must not retry') }
  })
  await assert.rejects(denied.api.captureReference(), { code: 'PERMISSION_DENIED' })
  assert.deepEqual(denied.calls, [])
})
