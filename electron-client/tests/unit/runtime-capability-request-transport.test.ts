import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL } from '../../src/contracts/runtime-capability-request-cancel.js'
import { RuntimeCapabilityRequestCancellationService } from '../../src/main/services/runtime-capability-request-cancellation-service.js'
import { createRuntimeCapabilityRequestCancellationBridge } from '../../src/preload/runtime-capability-request-cancellation.js'

const handshake1 = { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 1 }
const handshake2 = { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2 }

test('preload creates only the fixed screen-request cancel method for authenticated top frames on both lanes', async () => {
  const calls: { channel: string; value: unknown }[] = []
  const port = { invoke: async (channel: string, value: unknown) => { calls.push({ channel, value }); return { success: true } } }
  for (const handshake of [handshake1, handshake2]) {
    const bridge = createRuntimeCapabilityRequestCancellationBridge(port, handshake, true)
    assert.ok(bridge)
    assert.deepEqual(Object.keys(bridge), ['runtime_capability_request'])
    const cancel = bridge.runtime_capability_request
    assert.ok(cancel)
    await cancel({ messageId: 'request-1', reason: 'cancel' })
    await assert.rejects(cancel({ messageId: 'request-2', reason: 'cancel', method: 'dllplugin_call' }))
  }
  assert.equal(createRuntimeCapabilityRequestCancellationBridge(port, handshake2, false), undefined)
  assert.equal(createRuntimeCapabilityRequestCancellationBridge(port, undefined, true), undefined)
  assert.deepEqual(calls, [
    { channel: RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL, value: { messageId: 'request-1', reason: 'cancel' } },
    { channel: RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL, value: { messageId: 'request-1', reason: 'cancel' } }
  ])
})

function createTransport(bridge: unknown) {
  const environment = {
    isElectron: () => true,
    isElectronEnvironment: () => true,
    getElectronTransport: () => bridge,
    showEnvironmentWarning: () => undefined,
    getInfo: () => ({ type: 'electron' })
  }
  const source = fs.readFileSync('../frontend/public/js/cef-ipc/src/core/transport.js', 'utf8').replace(/^export default Transport\s*$/m, '')
  const Transport = vm.runInNewContext(source + '\nTransport', {
    MockProvider: class {}, environment, window: { localStorage: undefined }, setTimeout, clearTimeout, console, Date, Promise, Map, Error
  }) as new (options: { timeout: number }) => { call(method: string, params: unknown, options: unknown): Promise<unknown> }
  return new Transport({ timeout: 1000 })
}

test('actual SDK Transport signal reaches the Main-owned request cancellation bridge on lane 1 and lane 2', async () => {
  for (const handshake of [handshake1, handshake2]) {
    const owner = { type: 'plugin' as const, webContentsId: 31, pluginId: 'sample', pluginInstanceId: 'instance-31' }
    const cancellations = new RuntimeCapabilityRequestCancellationService()
    const mainRequests = new Map<string, AbortController>()
    let mainController: AbortController | undefined
    let started!: () => void
    const requestStarted = new Promise<void>(resolve => { started = resolve })
    const method = (request: { messageId: string; params: unknown; timeoutMs: number }) => {
      const controller = new AbortController()
      mainController = controller
      const release = cancellations.begin(owner, request.messageId, controller)
      mainRequests.set(request.messageId, controller)
      started()
      return new Promise(resolve => controller.signal.addEventListener('abort', () => {
        release()
        mainRequests.delete(request.messageId)
        resolve({ messageId: request.messageId, success: false, error: {
          code: controller.signal.reason === 'REQUEST_TIMEOUT' ? 'REQUEST_TIMEOUT' : 'CALLER_DESTROYED',
          message: '模拟Main中止权限提示'
        } })
      }, { once: true }))
    }
    const cancellationBridge = createRuntimeCapabilityRequestCancellationBridge({
      async invoke(channel, value) {
        assert.equal(channel, RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL)
        const request = value as { messageId: string; reason: 'cancel' | 'timeout' }
        const result = cancellations.cancel(owner, request.messageId, request.reason)
        return { messageId: request.messageId, success: true, data: result }
      }
    }, handshake, true)
    const transport = createTransport({
      methods: { runtime_capability_request: method },
      cancellations: cancellationBridge
    })
    const controller = new AbortController()
    const request = transport.call('runtime_capability_request', { capability: 'screen.capture' }, {
      signal: controller.signal, timeout: 120000
    })
    await requestStarted
    const requestId = [...mainRequests.keys()][0]
    assert.ok(requestId)
    controller.abort()
    await assert.rejects(request, { code: 'CALLER_DESTROYED' })
    assert.equal(mainController?.signal.reason, 'CALLER_DESTROYED')
    assert.equal(mainRequests.has(requestId), false)
    cancellations.stop()
  }
})
