import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileCapabilityResponse } from '../../src/main/protocol/file-capability.js'

test('legacy authorized media normalizes ranges and synthesizes partial response headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ztools-media-range-'))
  const target = join(root, 'sample.mp4'), data = Buffer.from('synthetic')
  await writeFile(target, data)
  try {
    let fetches = 0
    const files = { resolveFileCapability: async () => target }
    for (const [range, expected, contentRange] of [['bytes=1-3', 'ynt', 'bytes 1-3/9'], ['bytes=-2', 'ic', 'bytes 7-8/9'], ['bytes=7-999', 'ic', 'bytes 7-8/9']] as const) {
      const response = await fileCapabilityResponse(new Request('ztools://file/test', { headers: { range, Authorization: 'never-forward' } }), files, async (_url, init) => {
        fetches++
        const headers = new Headers(init.headers)
        assert.equal(headers.get('authorization'), null)
        const [start, end] = headers.get('range')!.slice(6).split('-').map(Number)
        return new Response(data.subarray(start, end! + 1), { status: 200, headers: { 'Content-Type': 'video/mp4' } })
      })
      assert.equal(response.status, 206)
      assert.equal(response.headers.get('content-range'), contentRange)
      assert.equal(response.headers.get('content-length'), String(expected.length))
      assert.equal(await response.text(), expected)
    }
    for (const range of ['bytes=9-', 'bytes=-0', 'bytes=3-1', 'bytes=0-1,4-5', 'bytes=9007199254740992-', 'other=1-2']) {
      const response = await fileCapabilityResponse(new Request('ztools://file/test', { headers: { range } }), files, async () => { throw new Error('must not fetch') })
      assert.equal(response.status, 416)
      assert.equal(response.headers.get('content-range'), 'bytes */9')
    }
    assert.equal(fetches, 3)
    const head = await fileCapabilityResponse(new Request('ztools://file/test', { method: 'HEAD', headers: { range: 'bytes=99-' } }), files, async (_url, init) => {
      assert.equal(init.method, 'HEAD'); assert.equal(init.headers, undefined)
      return new Response(null, { status: 200 })
    })
    assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '9'); assert.equal(await head.text(), '')
    const full = await fileCapabilityResponse(new Request('ztools://file/test'), files, async (_url, init) => {
      assert.equal(init.headers, undefined); return new Response(data)
    })
    assert.equal(full.status, 200); assert.equal(await full.text(), 'synthetic')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('legacy media preserves method and authorization guards before fetch', async () => {
  let resolves = 0, fetches = 0
  const files = { resolveFileCapability: async () => { resolves++; throw new Error('private path') } }
  const fetchFile = async () => { fetches++; return new Response('unreachable') }
  assert.equal((await fileCapabilityResponse(new Request('ztools://file/test', { method: 'POST' }), files, fetchFile)).status, 405)
  assert.equal(resolves, 0)
  assert.equal((await fileCapabilityResponse(new Request('ztools://file/test'), files, fetchFile)).status, 404)
  assert.equal(resolves, 1); assert.equal(fetches, 0)
})
