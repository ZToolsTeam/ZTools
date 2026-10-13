import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'

interface NetworkSDK {
  download(url: string, ref: unknown, options?: unknown): Promise<unknown>
  upload(url: string, ref: unknown, options?: unknown): Promise<unknown>
}
const file = { grantId: 'a'.repeat(43), kind: 'file', displayName: 'upload.txt', operations: ['read'] }
const save = { grantId: 'b'.repeat(43), kind: 'save', displayName: 'download.txt', operations: ['write'] }
function fixture() {
  const source = ['fs.js', 'fs-reference.js', 'network.js', 'network-reference.js'].map(name =>
    fs.readFileSync('../frontend/public/js/cef-ipc/src/api/' + name, 'utf8').replace(/^export .+$/mg, '')).join('\n')
  const calls: { method: string; params: unknown; options: unknown }[] = []
  let result: unknown = { success: true, grantId: save.grantId, size: 3, statusCode: 200, statusText: 'OK' }
  const transport = { call: async (method: string, params: unknown, options: unknown) => { calls.push({ method, params: JSON.parse(JSON.stringify(params)), options: JSON.parse(JSON.stringify(options)) }); return result } }
  const Constructor = vm.runInNewContext(source + '\nReferenceNetworkAPI', { URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa,
    window: { __ztoolsElectron: { contractVersion: 2, transport: { methods: { network_http_download() {}, network_http_upload() {} } } } }
  }) as new (port: typeof transport) => NetworkSDK
  return { sdk: new Constructor(transport), calls, result: (value: unknown) => { result = value } }
}
test('SDK2 download/upload carry only opaque references, bounded headers and deadlines, with default no replacement', async () => {
  const f = fixture(); await f.sdk.download('https://example.invalid/file', save)
  assert.deepEqual(f.calls[0], { method: 'network_http_download', params: { url: 'https://example.invalid/file', saveGrantId: save.grantId, timeout: 120000, replace: false }, options: { timeout: 120000 } })
  f.result({ success: true, data: { statusCode: 201, statusText: 'Created', body: 'fixture' } })
  await f.sdk.upload('https://example.invalid/upload', file, { fieldName: 'document', timeout: 1000 })
  assert.deepEqual(f.calls[1], { method: 'network_http_upload', params: { url: 'https://example.invalid/upload', fileGrantId: file.grantId, timeout: 1000, fieldName: 'document' }, options: { timeout: 1000 } })
})
test('SDK2 network refuses legacy paths, wrong rights, unsafe input and hidden replacement options before IPC', async () => {
  const f = fixture()
  await assert.rejects(f.sdk.download('https://example.invalid/file', '/raw'), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.sdk.upload('https://example.invalid/file', save), { code: 'INVALID_REQUEST' })
  for (const options of [{ savePath: '/raw' }, { owner: 42 }, { replace: 'true' }, { timeout: 0 }, { headers: { Good: 'bad\r\nheader' } }]) {
    await assert.rejects(f.sdk.download('https://example.invalid/file', save, options), { code: 'INVALID_REQUEST' })
  }
  await assert.rejects(f.sdk.download('file:///raw', save), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.sdk.upload('https://user:password@example.invalid/', file), { code: 'INVALID_REQUEST' })
  assert.equal(f.calls.length, 0)
})
test('SDK2 malformed download receipts preserve uncertainty and reject path-bearing or oversized upload responses', async () => {
  const f = fixture()
  for (const result of [{ success: true, grantId: file.grantId, size: 1, statusCode: 200, statusText: 'OK' },
    { success: true, grantId: save.grantId, size: 1, statusCode: 200, statusText: 'OK', path: '/raw' }]) {
    f.result(result); await assert.rejects(f.sdk.download('https://example.invalid/file', save), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  }
  f.result({ success: false, error: { code: 'FILE_STAGING_RETAINED', message: 'native cleanup unconfirmed' } })
  await assert.rejects(f.sdk.download('https://example.invalid/file', save), { code: 'FILE_STAGING_RETAINED' })
  f.result({ success: true, data: { statusCode: 200, statusText: 'OK', body: 'fixture', filePath: '/raw' } })
  await assert.rejects(f.sdk.upload('https://example.invalid/file', file), { code: 'NETWORK_ERROR' })
})
