const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '../public/js/cef-ipc/src')
const read = name => fs.readFileSync(path.join(root, name), 'utf8').replace(/^export default .+$/m, '')
const save = { grantId: 's'.repeat(43), displayName: 'out.txt', kind: 'save', operations: ['write'] }
const reference = { grantId: 'r'.repeat(43), displayName: 'out.txt', kind: 'file', operations: ['read'],
  fileUrl: 'ztools://file/' + 'r'.repeat(43) + '/out.txt' }
const available = { success: true, status: 'committed', size: 4, reference }
const unavailable = { success: true, status: 'committed-reference-unavailable', size: 4,
  issues: [{ stage: 'reference', code: 'PERMISSION_DENIED' }] }
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture(cleanupMs = 30, revokeMode = 'success') {
  let finish
  const finishRevokes = []
  const response = new Promise(resolve => { finish = resolve })
  const calls = [], cancels = []
  const invoke = request => { calls.push({ method: 'original', ...request }); return response }
  const revoke = request => {
    calls.push({ method: 'revoke', ...request })
    if (revokeMode === 'pending') return new Promise(resolve => {
      finishRevokes.push(() => resolve({ messageId: request.messageId, success: true, data: { success: true } }))
    })
    if (revokeMode === 'throw') throw new Error('/private/raw')
    return Promise.resolve(revokeMode === 'failure'
      ? { messageId: request.messageId, success: false, error: { code: 'FILE_ERROR', message: '/private/raw' } }
      : { messageId: request.messageId, success: true, data: { success: true } })
  }
  const bridge = { contractVersion: 2, transport: { methods: {
    filesystem_write_file: invoke, filesystem_copy_file: invoke, filesystem_read_file: invoke, filesystem_revoke: revoke
  }, cancellations: {
    filesystem_write_file: async request => { cancels.push(request) },
    filesystem_copy_file: async request => { cancels.push(request) },
    filesystem_read_file: async request => { cancels.push(request) }
  } } }
  class Base {
    constructor() { this.config = { timeout: 1000 }; this.sequence = 0 }
    _generateMessageId(method) { return 'sdk:' + (++this.sequence) + ':' + method }
    _withRequestId(error, messageId) { Object.defineProperty(error, 'requestId', { value: messageId }); return error }
    call() { throw new Error('legacy must not run') }
    getPendingCallsCount() { return 0 }
    clearPendingCalls() {}
    destroy() { this.clearPendingCalls() }
  }
  const constructors = vm.runInNewContext([
    read('api/fs.js'), read('api/fs-reference.js'), read('core/reference-transport.js'),
    '({ ReferenceFileSystemAPI, ReferenceTransport })'
  ].join('\n'), { Transport: Base, window: { __ztoolsElectron: bridge }, TextEncoder, Uint8Array, ArrayBuffer,
    atob, btoa, setTimeout, clearTimeout })
  const port = new constructors.ReferenceTransport({ referenceCleanupMs: cleanupMs })
  return { port, api: new constructors.ReferenceFileSystemAPI(port), calls, cancels, bridge,
    finishRevoke() { finishRevokes.forEach(resolve => resolve()) },
    finish(data, outer = {}) { finish({ messageId: calls[0].messageId, success: true, data, ...outer }) } }
}

test('exact no-reference commit retains immutable bytes and sanitized ordered issues', async () => {
  for (const issues of [[{ stage: 'release', code: 'FILE_ERROR' }], unavailable.issues,
    [{ stage: 'reference', code: 'FILE_ERROR' }, { stage: 'release', code: 'FILE_ERROR' }]]) {
    const f = fixture(), pending = f.api.writeFile(save, 'data')
    await tick(); f.finish({ ...unavailable, issues })
    const receipt = await pending
    assert.deepEqual(plain(receipt), { ...unavailable, issues })
    assert.ok(Object.isFrozen(receipt)); assert.ok(Object.isFrozen(receipt.issues)); assert.ok(Object.isFrozen(receipt.issues[0]))
    assert.equal(Object.hasOwn(receipt, 'reference'), false); assert.equal(f.calls.length, 1)
  }
})

test('zero and maximum bytes are valid, mismatch and malformed issue data are rejected', async () => {
  for (const size of [0, 16 * 1024 * 1024]) {
    const f = fixture(), pending = f.api.writeFile(save, new Uint8Array(size))
    await tick(); f.finish({ ...unavailable, size }); assert.equal((await pending).size, size)
  }
  const invalid = [
    { ...unavailable, size: 3 }, { ...unavailable, size: -1 }, { ...unavailable, size: 16 * 1024 * 1024 + 1 },
    { ...unavailable, size: Number.MAX_SAFE_INTEGER + 1 }, { ...unavailable, issues: [] },
    { ...unavailable, issues: [...unavailable.issues, ...unavailable.issues] },
    { ...unavailable, issues: [{ stage: 'release', code: 'PERMISSION_DENIED' }] },
    { ...unavailable, issues: [{ stage: 'release', code: 'FILE_ERROR' }, ...unavailable.issues] },
    { ...unavailable, issues: [{ stage: 'reference', code: 'FILE_ERROR', message: '/private/raw' }] },
    { ...unavailable, issues: [{ stage: 'reference', code: 'OTHER' }] },
    { ...unavailable, issues: [...unavailable.issues, { stage: 'release', code: 'FILE_ERROR' }, { stage: 'release', code: 'FILE_ERROR' }] },
    ...['reference', 'grantId', 'path', 'fileUrl', 'owner'].map(key => ({ ...unavailable, [key]: reference })),
    Object.assign(Object.create({ hidden: true }), unavailable),
    Object.defineProperty({ ...unavailable }, 'hidden', { value: 'private' }),
    { ...unavailable, [Symbol('hidden')]: 'private' },
    Object.defineProperty({ ...unavailable }, 'size', { get() { throw new Error('/private/raw') } })
  ]
  for (const data of invalid) {
    const f = fixture(), pending = f.api.writeFile(save, 'data')
    const rejection = assert.rejects(pending)
    await tick(); f.finish(data); await rejection
    assert.equal(f.calls.length, 1)
  }
})

test('requested cancel preserves exact no-reference Main commit without revoke', async () => {
  const f = fixture(), controller = new AbortController()
  const pending = f.api.writeFile(save, 'data', { signal: controller.signal })
  await tick(); controller.abort(); f.finish(unavailable)
  assert.deepEqual(plain(await pending), unavailable); assert.equal(f.calls.length, 1); assert.equal(f.cancels.length, 1)
})

test('requested cancel revokes available artifact exactly once before delivering no-capability commit', async () => {
  for (const mode of ['success', 'failure', 'throw', 'pending']) {
    const f = fixture(10, mode), controller = new AbortController()
    const pending = f.api.writeFile(save, 'data', { signal: controller.signal })
    await tick(); controller.abort(); f.finish(available)
    const receipt = await pending
    assert.deepEqual(plain(receipt), { ...unavailable, issues: [...unavailable.issues,
      ...(mode === 'success' ? [] : [{ stage: 'release', code: 'FILE_ERROR' }])] })
    assert.equal(f.calls.length, 2); assert.deepEqual(plain(f.calls[1].params), { grantId: reference.grantId })
    assert.ok(f.calls[1].timeoutMs >= 1 && f.calls[1].timeoutMs <= 10)
    assert.equal(Object.hasOwn(receipt, 'reference'), false)
    await tick(); assert.equal(f.port.getPendingCallsCount(), mode === 'pending' ? 1 : 0)
    if (mode === 'pending') {
      f.finishRevoke(); await tick(); assert.equal(f.port.getPendingCallsCount(), 0)
      assert.deepEqual(plain(await pending), plain(receipt), 'late cleanup does not erase the previously reported release issue')
    }
  }
})

test('deadline already unknown keeps original slot reserved, late grant cleanup never changes public result', async () => {
  const f = fixture(5), controller = new AbortController()
  const pending = f.api.writeFile(save, 'data', { signal: controller.signal })
  const rejected = assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await tick(); controller.abort(); await rejected
  assert.equal(f.port.getPendingCallsCount(), 1)
  f.finish(available); await tick(); await tick()
  assert.equal(f.calls.length, 2); assert.equal(f.port.getPendingCallsCount(), 0)
  await assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
})

test('destroyed transport still cleans a late committed grant using the captured original bridge', async () => {
  const f = fixture(5), pending = f.api.writeFile(save, 'data')
  const rejected = assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await tick(); f.port.destroy(); await rejected
  const originalRevoke = f.bridge.transport.methods.filesystem_revoke
  f.bridge.transport.methods.filesystem_revoke = () => { throw new Error('replaced bridge must not run') }
  f.finish(available); await tick(); await tick()
  assert.equal(f.calls.length, 2); assert.equal(f.port.getPendingCallsCount(), 0)
  f.bridge.transport.methods.filesystem_revoke = originalRevoke
})

test('other methods and unmatched outer responses never gain write commit semantics', async () => {
  for (const method of ['filesystem_copy_file', 'filesystem_read_file']) {
    const f = fixture(), controller = new AbortController()
    const pending = f.port.call(method, {}, { signal: controller.signal })
    const rejected = assert.rejects(pending, { code: method === 'filesystem_copy_file' ? 'FILE_WRITE_OUTCOME_UNKNOWN' : 'FILE_ERROR' })
    await tick(); controller.abort(); f.finish(unavailable); await rejected; assert.equal(f.calls.length, 1)
  }
  const f = fixture(), controller = new AbortController()
  const pending = f.api.writeFile(save, 'data', { signal: controller.signal })
  const rejected = assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await tick(); controller.abort(); f.finish(available, { messageId: 'unrelated' }); await rejected
  assert.equal(f.calls.length, 1)
})

test('64 pending cleanup operations retain original capacity until real cleanup convergence', async () => {
  const f = fixture(5, 'pending'), responses = []
  f.bridge.transport.methods.filesystem_write_file = request => new Promise(resolve => {
    responses.push(() => resolve({ messageId: request.messageId, success: true, data: available }))
  })
  const controllers = Array.from({ length: 64 }, () => new AbortController())
  const pending = controllers.map(controller => f.api.writeFile(save, 'data', { signal: controller.signal }))
  await tick(); controllers.forEach(controller => controller.abort()); responses.forEach(resolve => resolve())
  const receipts = await Promise.all(pending)
  assert.equal(receipts.length, 64)
  assert.ok(receipts.every(receipt => receipt.issues[1].stage === 'release'))
  assert.equal(f.port.getPendingCallsCount(), 64)
  await assert.rejects(f.api.writeFile(save, 'data'), { code: 'PERMISSION_DENIED' })
  assert.equal(f.calls.length, 64, 'one revoke per original request; no second cleanup queue')
  f.finishRevoke(); await tick(); assert.equal(f.port.getPendingCallsCount(), 0)
})

test('receipt and outer accessors are never read as Main commit evidence', async () => {
  for (const field of ['success', 'status', 'size', 'issues']) {
    let reads = 0
    const data = Object.defineProperty({ ...unavailable }, field, { enumerable: true,
      get() { reads++; return unavailable[field] } })
    const f = fixture(), controller = new AbortController()
    const pending = f.api.writeFile(save, 'data', { signal: controller.signal })
    const rejected = assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
    await tick(); controller.abort(); f.finish(data); await rejected
    assert.equal(reads, 0); assert.equal(f.calls.length, 1)
  }
  const f = fixture(), controller = new AbortController()
  const pending = f.api.writeFile(save, 'data', { signal: controller.signal })
  const rejected = assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  await tick(); controller.abort()
  f.finish(available, { success: true, extra: 'untrusted' }); await rejected
  assert.equal(f.calls.length, 1)
})

test('available and unknown branches remain exact, and absent revoke never returns a cancelled capability', async () => {
  const normal = fixture(), committed = normal.api.writeFile(save, 'data')
  await tick(); normal.finish(available)
  assert.deepEqual(plain(await committed), available); assert.equal(normal.calls.length, 1)
  const unknown = fixture(), pending = unknown.api.writeFile(save, 'data')
  await tick(); unknown.finish({ success: false, status: 'result-unknown', code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.deepEqual(plain(await pending), { success: false, status: 'result-unknown', code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  const missing = fixture(), controller = new AbortController()
  delete missing.bridge.transport.methods.filesystem_revoke
  const cancelled = missing.api.writeFile(save, 'data', { signal: controller.signal })
  await tick(); controller.abort(); missing.finish(available)
  assert.deepEqual(plain(await cancelled), { ...unavailable, issues: [...unavailable.issues, { stage: 'release', code: 'FILE_ERROR' }] })
  assert.equal(missing.calls.length, 1)
})

test('hidden issue indices and malformed operations indices cannot establish an exact commit', async () => {
  const hiddenIssues = [{ stage: 'reference', code: 'FILE_ERROR' }]
  Object.defineProperty(hiddenIssues, '0', { enumerable: false })
  const accessorIssues = [unavailable.issues[0]]
  Object.defineProperty(accessorIssues, '0', { get() { throw new Error('must not read accessor') } })
  const inheritedIssues = new Array(1)
  Object.setPrototypeOf(inheritedIssues, { 0: unavailable.issues[0] })
  const hiddenOperations = ['read']
  Object.defineProperty(hiddenOperations, '0', { enumerable: false })
  const accessorOperations = ['read']
  Object.defineProperty(accessorOperations, '0', { get() { throw new Error('must not read accessor') } })
  const inheritedOperations = new Array(1)
  Object.setPrototypeOf(inheritedOperations, { 0: 'read' })
  const extraOperations = Object.assign(['read'], { private: 'private' })
  for (const data of [
    ...[hiddenIssues, accessorIssues, inheritedIssues, new Array(1), Object.assign([unavailable.issues[0]], { extra: 'private' })]
      .map(issues => ({ ...unavailable, issues })),
    ...[hiddenOperations, accessorOperations, inheritedOperations, new Array(1), extraOperations, undefined]
      .map(operations => ({ ...available, reference: { ...reference, operations } }))]) {
    const f = fixture(), controller = new AbortController()
    const pending = f.api.writeFile(save, 'data', { signal: controller.signal })
    const rejected = assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
    await tick(); controller.abort(); f.finish(data); await rejected
    assert.equal(f.calls.length, 1, 'invalid array descriptor cannot trigger artifact cleanup or deliver commit')
  }
})
