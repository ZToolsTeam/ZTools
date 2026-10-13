import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { RuntimeCapabilityRequestCancellationService } from '../../src/main/services/runtime-capability-request-cancellation-service.js'

const first: CallerIdentity = { type: 'plugin', webContentsId: 7, pluginId: 'sample', pluginInstanceId: 'instance-a' }

test('only the exact plugin instance requestId is cancelled, with timeout and caller reasons preserved', () => {
  const service = new RuntimeCapabilityRequestCancellationService()
  const controller = new AbortController()
  const release = service.begin(first, 'request-a', controller)
  assert.deepEqual(service.cancel(first, 'request-a', 'cancel'), { requested: true })
  assert.equal(controller.signal.reason, 'CALLER_DESTROYED')

  const other = new AbortController()
  const releaseOther = service.begin(first, 'request-b', other)
  assert.deepEqual(service.cancel({ ...first, pluginInstanceId: 'instance-b' }, 'request-b', 'timeout'), { requested: true })
  assert.equal(other.signal.aborted, false, 'a different instance cannot cancel the active request')
  assert.deepEqual(service.cancel(first, 'request-b', 'timeout'), { requested: true })
  assert.equal(other.signal.reason, 'REQUEST_TIMEOUT')
  release(); releaseOther(); service.stop()
})

test('an early cancellation tombstone aborts only the matching later request and expires', () => {
  let now = 10
  const service = new RuntimeCapabilityRequestCancellationService(() => now)
  service.cancel(first, 'late-request', 'cancel')
  const canceled = new AbortController()
  const release = service.begin(first, 'late-request', canceled)
  assert.equal(canceled.signal.reason, 'CALLER_DESTROYED')
  release()

  service.cancel(first, 'expired-request', 'timeout')
  now += 10_001
  const current = new AbortController()
  const releaseCurrent = service.begin(first, 'expired-request', current)
  assert.equal(current.signal.aborted, false)
  releaseCurrent(); service.stop()
})

test('closed owner and service stop cancel active requests and discard early request ids', () => {
  const service = new RuntimeCapabilityRequestCancellationService()
  const active = new AbortController()
  service.begin(first, 'active', active)
  service.closeOwner(first.webContentsId)
  assert.equal(active.signal.reason, 'CALLER_DESTROYED')

  const stopping = new AbortController()
  service.begin(first, 'stopping', stopping)
  service.cancel(first, 'future', 'cancel')
  service.stop()
  assert.equal(stopping.signal.reason, 'APP_STOPPING')
  assert.throws(() => service.begin(first, 'future', new AbortController()), { code: 'APP_STOPPING' })
})
