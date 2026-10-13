import assert from 'node:assert/strict'
import test from 'node:test'
import { parseDownloadReference, parseUploadReference } from '../../src/contracts/path-transfer.js'
import { createReferenceNetworkHandlers } from '../../src/main/ipc/reference-network-handlers.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'

const caller = { type: 'main' as const, webContentsId: 42 }, id = 'a'.repeat(43)

test('reference transfers reject legacy paths, caller identity, unsafe URLs/headers, malformed timeouts and multipart names', () => {
  const base = { url: 'https://example.invalid/file', saveGrantId: id }
  assert.deepEqual(parseDownloadReference(base), { ...base, timeout: 120000, replace: false })
  for (const extra of [{ savePath: '/raw' }, { owner: 99 }, { replace: 'true' }, { timeout: 0 }, { timeout: 120001 },
    { url: 'file:///raw' }, { url: 'https://user:password@example.invalid/' }, { headers: null }, { headers: { Good: 'bad\r\nheader' } },
    { headers: { 'bad header': 'value' } }, { headers: { Good: 'x'.repeat(8193) } }]) {
    assert.throws(() => parseDownloadReference({ ...base, ...extra }), { code: 'INVALID_REQUEST' })
  }
  assert.throws(() => parseUploadReference({ url: base.url, fileGrantId: id, fieldName: 'bad\r\nfield' }), { code: 'INVALID_REQUEST' })
  assert.throws(() => parseUploadReference({ url: base.url, fileGrantId: id, filePath: '/raw' }), { code: 'INVALID_REQUEST' })
  const headers = { Authorization: 'synthetic', Accept: 'application/octet-stream' }
  const parsed = parseUploadReference({ url: base.url, fileGrantId: id, headers })
  assert.notEqual(parsed.headers, headers); assert.deepEqual(parsed.headers, headers)
})

test('reference handler parsing happens before network dispatch and cancellation preserves native write facts', async () => {
  let calls = 0
  const handlers = createReferenceNetworkHandlers({ downloadRef: async () => { calls++; return { success: true, grantId: id, size: 0, statusCode: 200, statusText: 'OK' } },
    uploadRef: async () => { calls++; return { success: true, data: { statusCode: 200, statusText: 'OK', body: '' } } } })
  await assert.rejects(handlers.network_http_download.execute({ url: 'https://example.invalid', savePath: '/raw' }, caller, new AbortController().signal), { code: 'INVALID_REQUEST' })
  const cancelled = new AbortController(); cancelled.abort(errorCodes.callerDestroyed)
  await assert.rejects(handlers.network_http_upload.execute({ url: 'https://example.invalid', fileGrantId: id }, caller, cancelled.signal), { code: 'CALLER_DESTROYED' })
  assert.equal(calls, 0)
  for (const code of [errorCodes.fileStagingRetained, errorCodes.fileWriteOutcomeUnknown]) {
    const preserving = createReferenceNetworkHandlers({ downloadRef: async () => { throw new ZToolsError(code, 'native fact') }, uploadRef: async () => { throw new Error('unused') } })
    await assert.rejects(preserving.network_http_download.execute({ url: 'https://example.invalid', saveGrantId: id }, caller, new AbortController().signal), { code })
  }
})

test('a handler timeout reaches the underlying transfer and never reports a late committed download as rolled back', async () => {
  const handlers = createReferenceNetworkHandlers({ downloadRef: async (_params, _caller, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    return { success: true, grantId: id, size: 1, statusCode: 200, statusText: 'OK' }
  }, uploadRef: async (_params, _caller, signal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    throw new ZToolsError(errorCodes.requestTimeout, 'timeout')
  } })
  await assert.rejects(handlers.network_http_download.execute({ url: 'https://example.invalid', saveGrantId: id, timeout: 5 }, caller, new AbortController().signal), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await assert.rejects(handlers.network_http_upload.execute({ url: 'https://example.invalid', fileGrantId: id, timeout: 5 }, caller, new AbortController().signal), { code: 'REQUEST_TIMEOUT' })
})
