import assert from 'node:assert/strict'
import test from 'node:test'
import { selectFileResourceRoute, dispatchFileResourceResponse } from '../../src/main/protocol/file-resource-dispatch.js'

test('resource selection uses independent Main token claims and rejects unknown or colliding claims', () => {
  const legacy = { claimsUrl: (url: string) => url.endsWith('/legacy') }
  const reference = { claimsUrl: (url: string) => url.endsWith('/reference') }
  assert.equal(selectFileResourceRoute('ztools://file/legacy', legacy, reference), 'legacy')
  assert.equal(selectFileResourceRoute('ztools://file/reference', legacy, reference), 'reference')
  assert.equal(selectFileResourceRoute('ztools://file/unknown', legacy, reference), 'deny')
  assert.equal(selectFileResourceRoute('ztools://file/reference', legacy), 'deny')
  assert.equal(selectFileResourceRoute('ztools://file/collision', { claimsUrl: () => true }, { claimsUrl: () => true }), 'deny')
  assert.equal(selectFileResourceRoute('invalid', { claimsUrl: () => { throw Error('private') } }, reference), 'deny')
})

test('expired, revoked or failing selected resources never retry the other transport', async () => {
  let legacyCalls = 0, referenceCalls = 0
  const legacy = { claimsUrl: () => false, respond: async () => { legacyCalls++; return new Response('private') } }
  const reference = { claimsUrl: () => true, respond: async () => { referenceCalls++; return new Response(null, { status: 404 }) } }
  const request = new Request('ztools://file/reference')
  assert.equal((await dispatchFileResourceResponse(request, legacy, reference)).status, 404)
  assert.equal((await dispatchFileResourceResponse(request, legacy, { ...reference, respond: async () => { throw Error('failed') } })).status, 404)
  assert.equal((await dispatchFileResourceResponse(new Request(request.url, { method: 'POST' }), legacy, reference)).status, 405)
  assert.equal(legacyCalls, 0); assert.equal(referenceCalls, 1)
  const success = await dispatchFileResourceResponse(new Request(request.url, { method: 'HEAD' }),
    { claimsUrl: () => true, respond: async incoming => { assert.equal(incoming.method, 'HEAD'); return new Response(null) } })
  assert.equal(success.status, 200)
})
