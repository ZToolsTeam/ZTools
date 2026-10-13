import assert from 'node:assert/strict'
import test from 'node:test'
import { anchoredFileCapabilityResponse } from '../../src/main/protocol/anchored-file-capability.js'
import type { PathResourceLease } from '../../src/main/services/path-grant-service.js'

function fixture(data: Buffer, name = 'fixture.mp4') {
  let closes = 0, reads = 0
  const controller = new AbortController()
  const lease: PathResourceLease = { metadata: { size: data.length, isDirectory: false, lastModifiedMs: 1000 },
    displayName: name, signal: controller.signal, close: () => { closes++; controller.abort() },
    read: async (offset, length) => { reads++; assert.ok(length <= 65536); return data.subarray(offset, offset + length) } }
  return { lease, grants: { openResource: async () => lease }, counts: () => ({ closes, reads }) }
}

test('anchored media streams bounded native chunks with no prefetch or path fetch and closes once', async () => {
  const data = Buffer.alloc(65537, 7), f = fixture(data)
  const response = await anchoredFileCapabilityResponse(new Request('ztools://file/test'), f.grants)
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-length'), '65537')
  assert.equal(response.headers.get('content-type'), 'video/mp4')
  assert.deepEqual(f.counts(), { reads: 0, closes: 0 })
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data)
  assert.deepEqual(f.counts(), { reads: 2, closes: 1 })
})

test('single ranges, suffix ranges, HEAD and empty resources preserve HTTP bounds', async () => {
  for (const [header, expected, contentRange] of [['bytes=1-3', 'ynt', 'bytes 1-3/9'], ['bytes=-2', 'ic', 'bytes 7-8/9'],
    ['bytes=7-', 'ic', 'bytes 7-8/9'], ['bytes=7-999', 'ic', 'bytes 7-8/9']] as const) {
    const f = fixture(Buffer.from('synthetic'))
    const response = await anchoredFileCapabilityResponse(new Request('ztools://file/test', { headers: { range: header } }), f.grants)
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), contentRange)
    assert.equal(await response.text(), expected); assert.equal(f.counts().closes, 1)
  }
  const f = fixture(Buffer.from('synthetic'))
  const head = await anchoredFileCapabilityResponse(new Request('ztools://file/test', { method: 'HEAD', headers: { range: 'bytes=99-' } }), f.grants)
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '9'); assert.equal(await head.text(), '')
  assert.deepEqual(f.counts(), { reads: 0, closes: 1 })
  const empty = fixture(Buffer.alloc(0)), result = await anchoredFileCapabilityResponse(new Request('ztools://file/test'), empty.grants)
  assert.equal(result.status, 200); assert.equal(result.headers.get('content-length'), '0'); assert.equal(empty.counts().closes, 1)
})

test('invalid ranges refuse reads, executable content gets inert MIME, cancellation and short reads close', async () => {
  for (const header of ['bytes=9-', 'bytes=-0', 'bytes=3-1', 'bytes=0-1,4-5', 'bytes=9007199254740992-', 'other=1-2']) {
    const f = fixture(Buffer.from('synthetic'))
    const response = await anchoredFileCapabilityResponse(new Request('ztools://file/test', { headers: { range: header } }), f.grants)
    assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */9')
    assert.deepEqual(f.counts(), { reads: 0, closes: 1 })
  }
  const f = fixture(Buffer.from('<script>'), 'selected.html')
  const response = await anchoredFileCapabilityResponse(new Request('ztools://file/test'), f.grants)
  assert.equal(response.headers.get('content-type'), 'application/octet-stream')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.match(response.headers.get('content-security-policy')!, /sandbox/)
  await response.body!.cancel(); assert.deepEqual(f.counts(), { reads: 0, closes: 1 })
  const short = fixture(Buffer.from('synthetic')); short.lease.read = async () => Buffer.alloc(0)
  const broken = await anchoredFileCapabilityResponse(new Request('ztools://file/test'), short.grants)
  await assert.rejects(broken.arrayBuffer()); assert.equal(short.counts().closes, 1)
  let opened = false
  const denied = { openResource: async (): Promise<PathResourceLease> => { opened = true; throw new Error('private path') } }
  assert.equal((await anchoredFileCapabilityResponse(new Request('ztools://file/test', { method: 'POST' }), denied)).status, 405)
  assert.equal(opened, false)
  assert.equal((await anchoredFileCapabilityResponse(new Request('ztools://file/test'), denied)).status, 404)
})
