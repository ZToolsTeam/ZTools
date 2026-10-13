import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const id = 'a'.repeat(43), ref = { grantId: id, kind: 'file', operations: ['read'], displayName: 'ocr.png' }
function fixture(version = 2) {
  const methods = { ocr_recognize_reference() {}, ocr_local_languages() {} }, calls: { method: string; params: unknown; options: unknown }[] = []
  const source = ['fs-reference', 'ocr-reference', 'ocr'].map(name => fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name + '.js', 'utf8').replace(/^export .+$/mg, '')).join('\n')
  const Constructor = vm.runInNewContext(source + '\nOCRAPI', { window: { __ztoolsElectron: { contractVersion: version, transport: { methods, cancellations: methods } } }, TextEncoder }) as new (transport: unknown) => { recognizeLocal(file: unknown, options?: unknown): Promise<any>; getLocalLanguages(options?: unknown): Promise<any> }
  let response: unknown = { success: true, provider: 'apple-vision-local', revision: 3, width: 1, height: 1, text: 'OCR', lines: [{ text: 'OCR', confidence: 0.9, box: [0, 0, 1, 1] }] }
  const api = new Constructor({ supportsAbortSignal: true, call: async (method: string, params: unknown, options: unknown) => { calls.push({ method, params, options }); return response } })
  return { api, calls, response: (value: unknown) => { response = value } }
}
test('OCR public SDK forwards FileRef/languages/cancellation and freezes local lines', async () => {
  const f = fixture(), signal = new AbortController().signal; const result = await f.api.recognizeLocal(ref, { languages: ['en-US'], signal })
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0]?.params)), { fileGrantId: id, languages: ['en-US'] }); assert.equal(f.calls[0]?.method, 'ocr_recognize_reference'); assert.equal((f.calls[0]?.options as { signal: AbortSignal }).signal, signal)
  assert.equal(result.text, 'OCR'); assert.ok(Object.isFrozen(result.lines[0].box)); assert.ok(Object.isFrozen(result.lines))
})
test('OCR SDK queries runtime languages without accepting cached assumed support', async () => {
  const f = fixture(); f.response({ success: true, provider: 'apple-vision-local', revision: 2, languages: ['en-US'] }); const result = await f.api.getLocalLanguages(); assert.ok(Object.isFrozen(result.languages)); assert.equal(f.calls[0]?.method, 'ocr_local_languages')
})
test('OCR SDK denies old host, raw paths, cloud/token options, duplicate language and preabort', async () => {
  const f = fixture(); await assert.rejects(f.api.recognizeLocal('C:/ocr.png'), { code: 'INVALID_REQUEST' })
  for (const options of [{ token: 'private' }, { languages: ['en-US', 'en-US'] }, { languages: ['invalid/name'] }, { languages: Array(9).fill('en-US') }]) await assert.rejects(f.api.recognizeLocal(ref, options), { code: 'INVALID_REQUEST' })
  const c = new AbortController(); c.abort(); await assert.rejects(f.api.recognizeLocal(ref, { signal: c.signal }), { code: 'CALLER_DESTROYED' }); assert.equal(f.calls.length, 0)
  const old = fixture(1); await assert.rejects(old.api.recognizeLocal(ref), { code: 'NOT_SUPPORTED' }); assert.equal(old.calls.length, 0)
})
test('OCR SDK rejects inconsistent text, malformed boxes, unknown backend and overlarge response', async () => {
  for (const patch of [{ text: 'different' }, { provider: 'cloud' }, { width: 8193 }, { text: 'x'.repeat(1024 * 1024 + 1) }, { lines: [{ text: 'OCR', confidence: 1.1, box: [0, 0, 1, 1] }] }]) {
    const f = fixture(); f.response({ success: true, provider: 'apple-vision-local', revision: 3, width: 1, height: 1, text: 'OCR', lines: [{ text: 'OCR', confidence: 0.9, box: [0, 0, 1, 1] }], ...patch }); await assert.rejects(f.api.recognizeLocal(ref))
  }
})
