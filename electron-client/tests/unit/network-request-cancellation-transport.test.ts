import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { NetworkRequestCancellationService } from '../../src/main/services/network-request-cancellation-service.js'

const owner = { type: 'plugin' as const, webContentsId: 51, pluginId: 'exchange-rate', pluginInstanceId: 'instance-51' }

function createTransport(bridge: unknown, timerCalls: Array<{ id: number; callback: () => void; delay: number }> = []) {
  let timerSequence = 0
  const timers = new Map<number, { callback: () => void; delay: number }>()
  const setTimer = (callback: () => void, delay: number) => {
    const id = ++timerSequence
    timers.set(id, { callback, delay })
    timerCalls.push({ id, callback, delay })
    return id
  }
  const clearTimer = (id: number) => { timers.delete(id) }
  const source = fs.readFileSync('../frontend/public/js/cef-ipc/src/core/transport.js', 'utf8')
    .replace(/^export default Transport\s*$/m, '')
  const Transport = vm.runInNewContext(`${source}\nTransport`, {
    MockProvider: class {},
    environment: {
      isElectron: () => true,
      getElectronTransport: () => bridge,
      showEnvironmentWarning: () => undefined,
      getInfo: () => ({ type: 'electron' })
    },
    window: { localStorage: undefined },
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    console,
    Date,
    Promise,
    Map,
    Error
  }) as new (options: { timeout: number }) => {
    call(method: string, params: unknown, options: { signal?: AbortSignal; timeout: number }): Promise<unknown>
  }
  return { transport: new Transport({ timeout: 1000 }), timers }
}

test('network Transport waits for Main request response after cancellation acknowledgement', async () => {
  const service = new NetworkRequestCancellationService()
  const active = new Map<string, { controller: AbortController; resolve: (value: unknown) => void }>()
  let started!: () => void
  const requestStarted = new Promise<void>(resolve => { started = resolve })
  const method = (request: { messageId: string }) => new Promise(resolve => {
    const controller = new AbortController()
    const release = service.begin(owner, 'network_http_request', request.messageId, controller)
    active.set(request.messageId, { controller, resolve: value => { release(); resolve(value) } })
    started()
  })
  const cancel = async (request: { messageId: string; reason: 'cancel' | 'timeout' }) => {
    service.cancel(owner, request.messageId, request.reason)
    return { messageId: request.messageId, success: true, data: { accepted: true, terminal: false } }
  }
  const { transport } = createTransport({ methods: { network_http_request: method }, cancellations: { network_http_request: cancel } })
  const controller = new AbortController()
  let settled = false
  const pending = transport.call('network_http_request', { method: 'GET', url: 'http://127.0.0.1/private' }, {
    signal: controller.signal,
    timeout: 120_000
  }).finally(() => { settled = true })

  await requestStarted
  const activeRequest = [...active.entries()][0]
  assert.ok(activeRequest)
  const [messageId, request] = activeRequest
  assert.ok(messageId)
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(request.controller.signal.reason, 'CALLER_DESTROYED')
  assert.equal(settled, false, 'cancel bridge ACK is not proof the request handler settled')

  request.resolve({ messageId, success: false, error: { code: 'CALLER_DESTROYED', message: '调用者已销毁' } })
  await assert.rejects(pending, { code: 'CALLER_DESTROYED' })
  assert.equal(settled, true)
  service.stop()
})

test('network Transport waits for the request result when the cancellation channel rejects', async () => {
  let requestId = ''
  let resolveRequest!: (value: unknown) => void
  const method = (request: { messageId: string }) => {
    requestId = request.messageId
    return new Promise(resolve => { resolveRequest = resolve })
  }
  const cancel = async () => { throw new Error('cancel channel unavailable') }
  const { transport } = createTransport({ methods: { network_http_request: method }, cancellations: { network_http_request: cancel } })
  const controller = new AbortController()
  let settled = false
  const pending = transport.call('network_http_request', {}, { signal: controller.signal, timeout: 120_000 })
    .finally(() => { settled = true })

  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(requestId)
  assert.equal(settled, false, 'cancel transport failure is not evidence that the network request settled')

  resolveRequest({ messageId: requestId, success: false, error: { code: 'CALLER_DESTROYED', message: '调用者已销毁' } })
  await assert.rejects(pending, { code: 'CALLER_DESTROYED' })
  assert.equal(settled, true)
})

test('network Transport redacts request URLs, headers, and bodies from debug call records', async () => {
  const { transport } = createTransport({ methods: {
    network_http_request: async (request: { messageId: string }) => ({
      messageId: request.messageId,
      success: true,
      data: { statusCode: 200, body: 'ok' }
    })
  } })
  const records: unknown[][] = []
  ;(transport as unknown as { _log: (...values: unknown[]) => void })._log = (...values) => records.push(values)
  const secret = 'v217-secret-log-canary'

  await transport.call('network_http_request', {
    url: `https://example.invalid/?token=${secret}`,
    headers: { Authorization: `Bearer ${secret}` },
    body: secret
  }, { timeout: 1_000 })

  assert.equal(JSON.stringify(records).includes(secret), false)
  assert.equal(records.filter(record => record.includes('[REDACTED]')).length, 2)
})

test('network Transport reports unconfirmed cancellation if the original request never settles', async () => {
  const timerCalls: Array<{ id: number; callback: () => void; delay: number }> = []
  let requestId = ''
  const method = (request: { messageId: string }) => {
    requestId = request.messageId
    return new Promise(() => undefined)
  }
  const cancel = async (request: { messageId: string }) => ({
    messageId: request.messageId, success: true, data: { accepted: true, terminal: false }
  })
  const { transport } = createTransport({ methods: { network_http_request: method }, cancellations: { network_http_request: cancel } }, timerCalls)
  const controller = new AbortController()
  const pending = transport.call('network_http_request', {}, { signal: controller.signal, timeout: 120_000 })
  controller.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(requestId)
  const deadline = timerCalls.find(timer => timer.delay === 30_000)
  assert.ok(deadline)
  deadline.callback()
  await assert.rejects(pending, { code: 'CANCELLATION_UNCONFIRMED' })
})
