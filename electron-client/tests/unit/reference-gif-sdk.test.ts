import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import vm from 'node:vm'
const id = 'a'.repeat(43), saveId = 's'.repeat(43)
function fixture(version = 2) {
  const methods = { image_to_gif() {} }, source = ['fs-reference', 'image-reference', 'image'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join(String.fromCharCode(10))
  const Constructor = vm.runInNewContext(source + String.fromCharCode(10) + 'ImageAPI', { window: { __ztoolsElectron: { contractVersion: version, transport: { methods, cancellations: methods } } }, TextEncoder }) as new (transport: unknown) => { imagesToGIF(images: unknown[], output: unknown, options?: unknown): Promise<boolean> }
  const calls: unknown[][] = []; let response = { success: true, status: 'committed', size: 100, frameCount: 2, width: 2, height: 2 }
  const api = new Constructor({ supportsAbortSignal: true, call: async (...args: unknown[]) => { calls.push(args); return response } })
  return { api, calls, ref: { grantId: id, kind: 'file', displayName: 'frame.png', operations: ['read'] }, save: { grantId: saveId, kind: 'save', displayName: 'output.gif', operations: ['write'] }, response: (value: typeof response) => { response = value }, value: () => response }
}
test('GIF SDK sends ordered opaque references, true signal and exact delay/once options', async () => {
  const f = fixture(), signal = new AbortController().signal
  assert.equal(await f.api.imagesToGIF([f.ref, f.ref], f.save, { interval: 250, loop: false, signal }), true)
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0]?.[1])), { fileGrantIds: [id, id], saveGrantId: saveId, interval: 250, loop: false, replace: false }); assert.equal((f.calls[0]?.[2] as { signal: AbortSignal }).signal, signal)
})
test('GIF SDK validates inputs, receipt, preabort and contract1 without fake concat fallback', async () => {
  const f = fixture()
  await assert.rejects(f.api.imagesToGIF(['/raw.png'], f.save), { code: 'INVALID_REQUEST' }); await assert.rejects(f.api.imagesToGIF([f.ref], f.save, { interval: 0 }), { code: 'INVALID_REQUEST' }); assert.equal(f.calls.length, 0)
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.api.imagesToGIF([f.ref], f.save, { signal: controller.signal }), { code: 'CALLER_DESTROYED' })
  f.response({ ...f.value(), status: 'unknown' }); await assert.rejects(f.api.imagesToGIF([f.ref, f.ref], f.save), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  const old = fixture(1); await assert.rejects(old.api.imagesToGIF([old.ref], old.save), { code: 'NOT_SUPPORTED' }); assert.equal(old.calls.length, 0)
})

test('GIF preview SDK freezes owner reference and releases invalid returned preview metadata', async () => {
  const methods = { image_preview_gif() {}, filesystem_revoke() {} }
  const source = ['fs-reference', 'image-reference'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join(String.fromCharCode(10))
  const Constructor = vm.runInNewContext(source + String.fromCharCode(10) + 'ReferenceImageAPI', { window: { __ztoolsElectron: { contractVersion: 2, transport: { methods, cancellations: methods } } }, TextEncoder }) as new (transport: unknown) => { previewGIF(images: unknown[], options?: unknown): Promise<{ reference: unknown }> }
  const ref = { grantId: id, kind: 'file', displayName: 'animation.gif', operations: ['read'] }, calls: unknown[][] = []
  let fileUrl = 'ztools://file/' + id + '/animation.gif'
  const api = new Constructor({ supportsAbortSignal: true, call: async (...args: unknown[]) => { calls.push(args); return args[0] === 'filesystem_revoke' ? { success: true } : { success: true, reference: ref, fileUrl, size: 100, frameCount: 1, width: 2, height: 2 } } })
  const signal = new AbortController().signal, result = await api.previewGIF([ref], { interval: 200, loop: true, signal })
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.reference)); assert.equal((calls[0]?.[2] as { signal: AbortSignal }).signal, signal)
  fileUrl = 'file:///private'; await assert.rejects(api.previewGIF([ref]), { code: 'FILE_ERROR' }); assert.equal(calls.at(-1)?.[0], 'filesystem_revoke')
})
