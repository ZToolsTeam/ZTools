import assert from 'node:assert/strict'
import test from 'node:test'
import { persistAnchoredDownload } from '../../src/main/services/anchored-download.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import type { PathGrantService } from '../../src/main/services/path-grant-service.js'

function fixture() {
  let committed = false, expectedSize: number | undefined
  const pieces: Buffer[] = []
  const grants: Pick<PathGrantService, 'streamSave'> = { streamSave: async (owner, id, expected, chunks, replace, signal) => {
    assert.equal(owner, 42); assert.equal(id, 'opaque-save'); assert.equal(replace, false)
    expectedSize = expected; let received = 0
    for await (const chunk of chunks) { assert.ok(chunk.length <= 65536); assert.equal(signal?.aborted, false); received += chunk.length; pieces.push(chunk) }
    if (expected !== undefined && expected !== received) throw new ZToolsError(errorCodes.fileError, 'short stream')
    committed = true; return { status: 'committed', bytesWritten: received }
  } }
  return { grants, pieces, state: () => ({ committed, expectedSize }) }
}

test('downloads stream known, unknown and decoded lengths into opaque saves without returning paths', async () => {
  for (const headers of [{ 'content-length': '65537' }, {}, { 'content-length': '2', 'content-encoding': 'gzip' }]) {
    const f = fixture(), data = Buffer.alloc(65537, 17)
    const response = new Response(data, { headers })
    const result = await persistAnchoredDownload({ response, owner: 42, saveGrantId: 'opaque-save', grants: f.grants, signal: new AbortController().signal })
    assert.equal(result.grantId, 'opaque-save'); assert.equal(result.size, 65537); assert.equal('path' in result, false)
    assert.deepEqual(Buffer.concat(f.pieces), data); assert.equal(f.state().committed, true)
    assert.equal(f.state().expectedSize, 'content-encoding' in headers || !('content-length' in headers) ? undefined : 65537)
  }
})

test('HTTP/header/size/short-body failures cancel the response and never report a successful commit', async () => {
  for (const mode of ['http', 'invalid-header', 'declared-limit', 'actual-limit', 'short']) {
    const f = fixture(); let cancelled = 0
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('four')); if (mode === 'short') controller.close() }, cancel() { cancelled++ } }),
      { status: mode === 'http' ? 500 : 200, headers: mode === 'invalid-header' ? { 'content-length': '-1' } : mode === 'declared-limit' ? { 'content-length': '100' } : mode === 'short' ? { 'content-length': '5' } : {} })
    await assert.rejects(persistAnchoredDownload({ response, owner: 42, saveGrantId: 'opaque-save', grants: f.grants, signal: new AbortController().signal, maxBytes: mode === 'actual-limit' ? 3 : 10 }))
    assert.equal(f.state().committed, false); assert.equal(cancelled, mode === 'short' ? 0 : 1)
    assert.equal(response.body!.locked, false)
  }
})

test('caller cancellation aborts a stalled response and propagates uncertain native commit unchanged', async () => {
  const f = fixture(), controller = new AbortController(); let cancelled = 0
  const response = new Response(new ReadableStream({ cancel() { cancelled++ } }))
  const pending = persistAnchoredDownload({ response, owner: 42, saveGrantId: 'opaque-save', grants: f.grants, signal: controller.signal })
  const rejected = assert.rejects(pending)
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await rejected
  assert.equal(cancelled, 1); assert.equal(response.body!.locked, false)
  const unknown = { streamSave: async () => { throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, 'commit unknown') } }
  await assert.rejects(persistAnchoredDownload({ response: new Response('body'), owner: 42, saveGrantId: 'opaque-save', grants: unknown, signal: new AbortController().signal }), { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
})
