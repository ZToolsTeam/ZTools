import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
const id = 'a'.repeat(43), directoryId = 'b'.repeat(43), reference = { grantId: id, kind: 'file', displayName: 'clipboard.png', operations: ['read'] }
function fixture() {
  const methods = Object.fromEntries(['clipboard_copy_text', 'clipboard_copy_image', 'clipboard_read_text', 'clipboard_clear', 'clipboard_read_image', 'clipboard_read_files', 'filesystem_read_file', 'filesystem_revoke'].map(name => [name, () => {}]))
  const source = ['fs-reference', 'clipboard'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join(String.fromCharCode(10))
  const Constructor = vm.runInNewContext(source + String.fromCharCode(10) + 'ClipboardAPI', { window: { __ztoolsElectron: { contractVersion: 2, transport: { methods, cancellations: methods } }, _writeFileArrayBuffer() { throw new Error('raw path must not run') } }, TextEncoder, Uint8Array, atob, btoa }) as new (transport: unknown, events: unknown) => {
    copyText(value: unknown, options?: unknown): Promise<boolean>; copyImage(value: unknown, options?: unknown): Promise<boolean>; readImage(options?: unknown): Promise<string>; readImageReference(options?: unknown): Promise<string | { toDataURL(options?: unknown): Promise<string>; release(): Promise<unknown> }>; readFilesDetailed(options?: unknown): Promise<{ files: unknown[]; errors: unknown[] }>; readText(): Promise<string>; clear(): Promise<boolean>
  }
  const calls: { method: string; params: unknown; options: unknown }[] = []
  let image: unknown = { success: true, useReference: true, reference, fileUrl: 'ztools://file/' + id + '/clipboard.png', size: 3, width: 1, height: 1 }
  let files: unknown = { success: true, files: [reference, { grantId: directoryId, kind: 'directory', displayName: 'folder', operations: ['read', 'list'] }], errors: [{ index: 2, code: 'FILE_ERROR', message: '已移除' }] }
  let read = async () => ({ success: true, content: 'YWJj', size: 3 })
  const api = new Constructor({ supportsAbortSignal: true, call: async (method: string, params: unknown, options: unknown) => {
    calls.push({ method, params, options })
    if (method === 'clipboard_read_image') return image
    if (method === 'clipboard_read_files') return files
    if (method === 'filesystem_read_file') return read()
    if (method === 'clipboard_read_text') return { success: true, text: 'actual text' }
    return { success: true }
  } }, {})
  return { api, calls, image: (value: unknown) => { image = value }, files: (value: unknown) => { files = value }, read: (fn: typeof read) => { read = fn } }
}
test('clipboard text and image copies forward opaque refs/signals and bounded direct text without temp paths', async () => {
  const f = fixture(), signal = new AbortController().signal
  assert.equal(await f.api.copyText('中文'.repeat(150000), { signal }), true); assert.equal(await f.api.copyText(reference), true); assert.equal(await f.api.copyImage(reference, { signal }), true)
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1]?.params)), { fileGrantId: id }); assert.deepEqual(JSON.parse(JSON.stringify(f.calls[2]?.params)), { fileGrantId: id }); assert.equal((f.calls[0]?.options as { signal: AbortSignal }).signal, signal)
  await assert.rejects(f.api.copyText('x'.repeat(8 * 1024 * 1024 + 1)), { code: 'RESPONSE_TOO_LARGE' }); await assert.rejects(f.api.copyImage('x'.repeat(700 * 1024 + 1)), { code: 'FILE_TOO_LARGE' })
})
test('clipboard explicit image ref is frozen, readable and release is idempotent', async () => {
  const f = fixture(), result = await f.api.readImageReference()
  assert.notEqual(typeof result, 'string'); if (typeof result === 'string') return
  assert.ok(Object.isFrozen(result)); assert.equal(await result.toDataURL(), 'data:image/png;base64,YWJj')
  await result.release(); await result.release(); assert.equal(f.calls.filter(call => call.method === 'filesystem_revoke').length, 1)
  await assert.rejects(result.toDataURL(), { code: 'PERMISSION_DENIED' })
})
test('clipboard readImage convenience releases on success and read failure; small/empty images are direct', async () => {
  const f = fixture(); assert.equal(await f.api.readImage(), 'data:image/png;base64,YWJj'); assert.equal(f.calls.at(-1)?.method, 'filesystem_revoke')
  const g = fixture(); g.read(async () => { throw new Error('read failed') }); await assert.rejects(g.api.readImage(), /read failed/); assert.equal(g.calls.at(-1)?.method, 'filesystem_revoke')
  const h = fixture(); h.image({ success: true, useReference: false, image: '' }); assert.equal(await h.api.readImage(), '')
  h.image({ success: true, useReference: false, image: 'data:image/png;base64,YWJj' }); assert.equal(await h.api.readImage(), 'data:image/png;base64,YWJj')
})
test('clipboard image metadata failure releases a valid delivered ref and preabort calls nothing', async () => {
  const f = fixture(); f.image({ success: true, useReference: true, reference, fileUrl: 'file:///raw', size: 3, width: 1, height: 1 }); await assert.rejects(f.api.readImageReference(), { code: 'CLIPBOARD_ERROR' }); assert.equal(f.calls.at(-1)?.method, 'filesystem_revoke')
  const g = fixture(), controller = new AbortController(); controller.abort(); await assert.rejects(g.api.readImage({ signal: controller.signal }), { code: 'CALLER_DESTROYED' }); assert.equal(g.calls.length, 0)
})
test('clipboard detailed file read preserves owner refs/errors and cleans partial invalid delivery', async () => {
  const f = fixture(), result = await f.api.readFilesDetailed(); assert.equal(result.files.length, 2); assert.equal(result.errors.length, 1); assert.ok(Object.isFrozen(result.files)); assert.ok(Object.isFrozen(result.files[0]))
  const g = fixture(); g.files({ success: true, files: [reference, reference], errors: [] }); await assert.rejects(g.api.readFilesDetailed(), { code: 'CLIPBOARD_ERROR' }); assert.equal(g.calls.at(-1)?.method, 'filesystem_revoke')
  const h = fixture(); h.files({ success: true, files: ['raw/path'], errors: [] }); await assert.rejects(h.api.readFilesDetailed(), { code: 'FILE_ERROR' })
  assert.equal(await f.api.readText(), 'actual text'); assert.equal(await f.api.clear(), true)
})
