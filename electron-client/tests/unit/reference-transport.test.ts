import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createReferenceTransportBridge } from '../../src/preload/reference-transport.js'
import {
  parseReferenceRequest,
  parseReferenceCancellation,
  REFERENCE_CANCEL_CHANNEL,
  REFERENCE_METHODS
} from '../../src/contracts/reference-transport.js'
import { SDK_LANE_HANDSHAKE_CHANNEL } from '../../src/contracts/sdk-lane-handshake.js'
import { RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL } from '../../src/contracts/runtime-capability-request-cancel.js'
import { NETWORK_REQUEST_CANCEL_CHANNEL } from '../../src/contracts/network-request-cancel.js'
import { parseRequest } from '../../src/contracts/ipc.js'
import { ReferenceRequestTracker } from '../../src/main/services/reference-request-tracker.js'

interface TransportPort {
  call(method: string, params?: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<unknown>
  getPendingCallsCount(): number
  destroy(): void
}

test('SDK2 direct clipboard text has a bounded large IPC limit without widening legacy or ordinary requests', () => {
  const value = { messageId: 'text', method: 'clipboard_copy_text', params: { text: 'x'.repeat(2 * 1024 * 1024) } }
  assert.equal(parseReferenceRequest(value).params, value.params)
  // 旧通道的剪贴板文本与直连通道同为 8 MiB 上限（宿主剪贴板上限），其它普通请求仍是 1 MiB
  assert.equal(parseRequest(value).params, value.params)
  assert.throws(() => parseRequest({ ...value, method: 'filesystem_read_file' }), { code: 'INVALID_REQUEST' })
  assert.throws(() => parseRequest({ ...value, params: { text: 'x'.repeat(8 * 1024 * 1024 + 1024) } }), { code: 'INVALID_REQUEST' })
  assert.throws(() => parseReferenceRequest({ ...value, method: 'filesystem_read_file' }), { code: 'INVALID_REQUEST' })
  assert.throws(() => parseReferenceRequest({ ...value, params: { text: 'x'.repeat(8 * 1024 * 1024 + 1024) } }), { code: 'INVALID_REQUEST' })
  assert.throws(() => parseReferenceRequest({ ...value, owner: 99 }), { code: 'INVALID_REQUEST' })
  assert.throws(() => parseReferenceRequest({ messageId: 'text', method: value.method }), { code: 'INVALID_REQUEST' })
  const cycle: { parent?: unknown } = {}; cycle.parent = cycle
  assert.throws(() => parseReferenceRequest({ ...value, params: cycle }), { code: 'INVALID_REQUEST' })
  assert.throws(() => parseReferenceRequest({ ...value, params: undefined }), { code: 'INVALID_REQUEST' })
})
function fixture(cleanupMs = 100) {
  const invocations: { messageId: string; params: unknown; timeoutMs: number }[] = []
  const cancellations: unknown[] = []
  let resolve!: (value: unknown) => void
  const response = new Promise(resolveResponse => { resolve = resolveResponse })
  const invoke = (request: { messageId: string; params: unknown; timeoutMs: number }) => { invocations.push(request); return response }
  const cancel = async (request: unknown) => { cancellations.push(request) }
  const methods = { filesystem_write_file: invoke, filesystem_read_file: invoke, network_http_request: invoke }
  const window = { __ztoolsElectron: { contractVersion: 2, transport: { methods,
    cancellations: { filesystem_write_file: cancel, filesystem_read_file: cancel, network_http_request: cancel } } } }
  class Base {
    config = { timeout: 1000 }
    sequence = 0
    _generateMessageId(method: string) { return 'id:' + (++this.sequence) + ':' + method }
    _withRequestId(error: Error, messageId: string) {
      Object.defineProperty(error, 'requestId', { value: messageId, enumerable: false })
      return error
    }
    call() { throw new Error('legacy transport must not run') }
    getPendingCallsCount() { return 0 }
    clearPendingCalls() {}
    destroy() { this.clearPendingCalls() }
  }
  const source = fs.readFileSync('../frontend/public/js/cef-ipc/src/core/reference-transport.js', 'utf8').replace(/^export default .+$/m, '')
  const Constructor = vm.runInNewContext(source + '\nReferenceTransport', { Transport: Base, window, setTimeout, clearTimeout }) as
    new (config: { referenceCleanupMs: number }) => TransportPort
  return { port: new Constructor({ referenceCleanupMs: cleanupMs }), invocations, cancellations, resolve, window }
}

function sdk2NetworkFixture(cleanupMs = 100) {
  const events: string[] = []
  const invocations: { messageId: string; params: Record<string, unknown>; timeoutMs: number }[] = []
  const cancellations: { messageId: string; reason: string }[] = []
  let resolve!: (value: unknown) => void
  const response = new Promise(resolveResponse => { resolve = resolveResponse })
  const invoke = (request: { messageId: string; params: Record<string, unknown>; timeoutMs: number }) => {
    events.push('request')
    invocations.push(request)
    return response
  }
  const cancel = async (request: { messageId: string; reason: string }) => {
    events.push('cancel')
    cancellations.push(request)
    return { messageId: request.messageId, success: true, data: { accepted: true } }
  }
  const window = { __ztoolsElectron: { contractVersion: 2, transport: {
    methods: { network_http_request: invoke },
    cancellations: { network_http_request: cancel }
  } } }
  class Base {
    config = { timeout: 1000 }
    sequence = 0
    _generateMessageId(method: string) { return 'id:' + (++this.sequence) + ':' + method }
    _withRequestId(error: Error, messageId: string) {
      Object.defineProperty(error, 'requestId', { value: messageId, enumerable: false })
      return error
    }
    call() { throw new Error('legacy transport must not run') }
    getPendingCallsCount() { return 0 }
    clearPendingCalls() {}
    destroy() { this.clearPendingCalls() }
  }
  const transportSource = fs.readFileSync('../frontend/public/js/cef-ipc/src/core/reference-transport.js', 'utf8').replace(/^export default .+$/m, '')
  const TransportConstructor = vm.runInNewContext(transportSource + '\nReferenceTransport', {
    Transport: Base, window, setTimeout, clearTimeout
  }) as new (config: { referenceCleanupMs: number }) => TransportPort
  const networkSource = fs.readFileSync('../frontend/public/js/cef-ipc/src/api/network.js', 'utf8').replace(/^export default .+$/m, '')
  const referenceNetworkSource = fs.readFileSync('../frontend/public/js/cef-ipc/src/api/network-reference.js', 'utf8').replace(/^export default .+$/m, '')
  class ReferenceFileSystemFixture { constructor(_transport: unknown) {} }
  const NetworkConstructor = vm.runInNewContext(`${networkSource}\n${referenceNetworkSource}\nReferenceNetworkAPI`, {
    ReferenceFileSystemAPI: ReferenceFileSystemFixture
  }) as new (transport: TransportPort) => { request(options: Record<string, unknown>): Promise<unknown> }
  const port = new TransportConstructor({ referenceCleanupMs: cleanupMs })
  return { api: new NetworkConstructor(port), port, invocations, cancellations, events, resolve, window }
}

test('preload exposes only fixed file methods and refuses renderer method/channel/owner injection', async () => {
  const calls: { channel: string; value: unknown }[] = []
  const bridge = createReferenceTransportBridge(
    { invoke: async (channel, value) => { calls.push({ channel, value }); return true } },
    { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2 },
    true
  )!
  assert.ok(Object.isFrozen(bridge)); assert.ok(Object.isFrozen(bridge.methods)); assert.ok(Object.isFrozen(bridge.cancellations))
  assert.deepEqual(Object.keys(bridge.methods).sort(), [...REFERENCE_METHODS].sort())
  assert.equal(bridge.methods.dllplugin_call, undefined)
  await bridge.cancellations.filesystem_write_file!({ messageId: 'write', reason: 'cancel' })
  assert.deepEqual(calls[0], { channel: REFERENCE_CANCEL_CHANNEL, value: { messageId: 'write', method: 'filesystem_write_file', reason: 'cancel' } })
  for (const extra of [{ owner: 42 }, { method: 'dllplugin_call' }, { channel: 'arbitrary' }, { reason: 'app-stop' }]) {
    await assert.rejects(bridge.cancellations.filesystem_write_file!({ messageId: 'write', reason: 'cancel', ...extra }))
  }
  await assert.rejects(bridge.methods.filesystem_read_file!({ messageId: 'read', params: {}, method: 'dllplugin_call' }))
  assert.equal(calls.length, 1)
  assert.throws(() => parseReferenceCancellation({ messageId: 'write', method: 'dllplugin_call', reason: 'cancel' }), { code: 'INVALID_REQUEST' })
})

test('reference methods require an exact Main handshake selecting lane 2 and the top frame', () => {
  const port = { invoke: async () => undefined }
  for (const invalid of [
    undefined,
    null,
    {},
    { hostMaximumSdkContractVersion: 1, windowSdkApiLane: 2 },
    { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 3 },
    { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2, lane: 2 }
  ]) {
    assert.equal(createReferenceTransportBridge(port, invalid, true), undefined)
  }
  assert.equal(createReferenceTransportBridge(port, { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2 }, false), undefined)
  assert.equal(createReferenceTransportBridge(port, { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 1 }, true), undefined)
})

interface EsbuildResult { outputFiles?: Array<{ text: string }> }
interface EsbuildApi {
  buildSync(options: {
    absWorkingDir: string
    entryPoints: string[]
    bundle: true
    platform: 'browser'
    format: 'cjs'
    target: string
    external: string[]
    write: false
    logLevel: 'silent'
  }): EsbuildResult
}

function bundleSandboxPreload(): string {
  const electronRoot = process.cwd()
  const esbuildPath = path.resolve(electronRoot, '..', 'frontend', 'node_modules', 'esbuild')
  const esbuild = require(esbuildPath) as EsbuildApi
  const result = esbuild.buildSync({
    absWorkingDir: electronRoot,
    entryPoints: ['src/preload/main.ts'],
    bundle: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    external: ['electron'],
    write: false,
    logLevel: 'silent'
  })
  const code = result.outputFiles?.[0]?.text
  assert.equal(typeof code, 'string', 'esbuild must return the in-memory sandbox preload bundle')
  return code!
}

interface PreloadBridgeFixture {
  contractVersion: number
  transport: {
    methods: Record<string, (request: unknown) => Promise<unknown>>
    cancellations?: Record<string, (request: unknown) => Promise<unknown>>
  }
}

function loadSandboxPreload(code: string, options: {
  handshake?: unknown
  handshakeSequence?: unknown[]
  isMainFrame?: boolean
  throwOnHandshake?: boolean
} = {}) {
  const exposures = new Map<string, unknown>()
  const invocations: { channel: string; value: unknown }[] = []
  const syncCalls: { channel: string; argumentCount: number }[] = []
  let handshakeIndex = 0
  const frame: { top?: unknown; addEventListener: () => void } = { addEventListener: () => undefined }
  frame.top = options.isMainFrame === false ? {} : frame
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, value: unknown) => exposures.set(name, value) },
    ipcRenderer: {
      on: () => undefined,
      sendSync: (channel: string, ...args: unknown[]) => {
        syncCalls.push({ channel, argumentCount: args.length })
        if (options.throwOnHandshake) throw new Error('Main handshake unavailable')
        if (options.handshakeSequence) return options.handshakeSequence[handshakeIndex++]
        return options.handshake
      },
      invoke: async (channel: string, value: unknown) => { invocations.push({ channel, value }); return true }
    },
    webUtils: { getPathForFile: () => '/fixture/file' }
  }
  vm.runInNewContext(code, {
    require: (specifier: string) => {
      assert.equal(specifier, 'electron', 'sandbox preload may require only Electron')
      return electron
    },
    exports: {},
    module: { exports: {} },
    window: frame,
    document: { addEventListener: () => undefined, removeEventListener: () => undefined },
    process: { argv: [] },
    Buffer: { byteLength: (value: string, encoding: string) => Buffer.byteLength(value, encoding as BufferEncoding) },
    File: class FileFixture {}
  }, { filename: 'sandbox-preload.cjs' })
  return {
    bridge: exposures.get('__ztoolsElectron') as PreloadBridgeFixture | undefined,
    invocations,
    syncCalls
  }
}

test('sandbox CJS bundle has no local or Node require and only externalizes Electron', () => {
  const code = bundleSandboxPreload()
  const required = [...code.matchAll(/\brequire\((['"])([^'"]+)\1\)/g)].map(match => match[2])
  assert.deepEqual([...new Set(required)], ['electron'])
  assert.doesNotMatch(code, /require\((['"])(?:node:|\.\.?\/)/)
  assert.doesNotMatch(code, /from\s+['"]node:/)
})

test('bundled preload exposes reference IPC only for a valid Main lane-2 handshake', async () => {
  const code = bundleSandboxPreload()
  const valid = { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 2 }
  const main = loadSandboxPreload(code, { handshake: valid })
  assert.equal(main.syncCalls.length, 1)
  assert.deepEqual(main.syncCalls[0], { channel: SDK_LANE_HANDSHAKE_CHANNEL, argumentCount: 0 })
  assert.equal(main.bridge?.contractVersion, 2, 'only this authenticated lane-2 window selects SDK contract 2')
  const methods = main.bridge?.transport.methods
  const cancellations = main.bridge?.transport.cancellations
  assert.ok(methods); assert.ok(cancellations)
  assert.deepEqual(Object.keys(cancellations).sort(), [...REFERENCE_METHODS, 'runtime_capability_request', 'network_http_request'].sort())
  await methods.filesystem_read_file!({ messageId: 'read-1', params: {} })
  await cancellations.filesystem_read_file!({ messageId: 'read-1', reason: 'cancel' })
  await methods.runtime_capability_request!({ messageId: 'cap-1', params: { capability: 'screen.capture' } })
  await cancellations.runtime_capability_request!({ messageId: 'cap-1', reason: 'cancel' })
  await cancellations.network_http_request!({ messageId: 'network-lane2-1', reason: 'cancel' })
  assert.deepEqual(main.invocations.map(call => ({ channel: call.channel, value: JSON.parse(JSON.stringify(call.value)) })), [
    { channel: 'ztools:call', value: { messageId: 'read-1', method: 'filesystem_read_file', params: {} } },
    { channel: REFERENCE_CANCEL_CHANNEL, value: { messageId: 'read-1', method: 'filesystem_read_file', reason: 'cancel' } },
    { channel: 'ztools:call', value: { messageId: 'cap-1', method: 'runtime_capability_request', params: { capability: 'screen.capture' } } },
    { channel: RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL, value: { messageId: 'cap-1', reason: 'cancel' } },
    { channel: NETWORK_REQUEST_CANCEL_CHANNEL, value: { messageId: 'network-lane2-1', reason: 'cancel' } }
  ])
  await assert.rejects(methods.filesystem_read_file!({ messageId: 'read-2', params: {}, channel: 'arbitrary' }))
  await assert.rejects(methods.filesystem_read_file!({ messageId: 'read-2', params: {}, method: 'dllplugin_call' }))
  await assert.rejects(cancellations.filesystem_read_file!({ messageId: 'read-1', reason: 'cancel', channel: 'arbitrary' }))
  assert.equal(main.invocations.length, 5)
  assert.equal(methods.arbitrary, undefined)
  assert.equal(cancellations.dllplugin_call, undefined)

  for (const handshake of [
    undefined,
    { hostMaximumSdkContractVersion: 1, windowSdkApiLane: 2 },
    { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 3 }
  ]) {
    const denied = loadSandboxPreload(code, { handshake })
    assert.equal(denied.bridge?.contractVersion, 1)
    assert.equal(denied.bridge?.transport.cancellations, undefined)
    assert.ok(denied.bridge?.transport.methods.filesystem_read_file, 'lane 1 keeps its legacy method')
  }
  const lane1 = loadSandboxPreload(code, { handshake: { hostMaximumSdkContractVersion: 2, windowSdkApiLane: 1 } })
  const lane1Cancellations = lane1.bridge?.transport.cancellations
  assert.deepEqual(Object.keys(lane1Cancellations ?? {}).sort(), ['runtime_capability_request', 'network_http_request'].sort())
  for (const method of REFERENCE_METHODS) assert.equal(lane1Cancellations?.[method], undefined)
  await lane1Cancellations?.runtime_capability_request?.({ messageId: 'cap-lane1', reason: 'timeout' })
  await lane1Cancellations?.network_http_request?.({ messageId: 'network-lane1-1', reason: 'timeout' })
  assert.deepEqual(lane1.invocations.map(call => ({ channel: call.channel, value: JSON.parse(JSON.stringify(call.value)) })), [{
    channel: RUNTIME_CAPABILITY_REQUEST_CANCEL_CHANNEL,
    value: { messageId: 'cap-lane1', reason: 'timeout' }
  }, {
    channel: NETWORK_REQUEST_CANCEL_CHANNEL,
    value: { messageId: 'network-lane1-1', reason: 'timeout' }
  }])
  const failed = loadSandboxPreload(code, { handshake: valid, throwOnHandshake: true })
  assert.equal(failed.bridge?.contractVersion, 1)
  assert.equal(failed.bridge?.transport.cancellations, undefined)
  const late = loadSandboxPreload(code, { handshakeSequence: [undefined, valid] })
  assert.equal(late.syncCalls.length, 1, 'preload does not retry or upgrade after the fixed synchronous handshake')
  assert.equal(late.bridge?.contractVersion, 1)
  assert.equal(late.bridge?.transport.cancellations, undefined)
  const iframe = loadSandboxPreload(code, { handshake: valid, isMainFrame: false })
  assert.equal(iframe.syncCalls.length, 0)
  assert.equal(iframe.bridge?.contractVersion, 1)
  assert.equal(iframe.bridge?.transport.cancellations, undefined)
})

test('Renderer abort sends exact cancellation and waits for the original native commit result', async () => {
  for (const code of ['FILE_WRITE_OUTCOME_UNKNOWN', 'FILE_STAGING_RETAINED']) {
    const f = fixture(), controller = new AbortController()
    const pending = f.port.call('filesystem_write_file', { saveGrantId: 'a'.repeat(43) }, { signal: controller.signal })
    let completed = false
    void pending.then(() => { completed = true }, () => { completed = true })
    await Promise.resolve(); controller.abort(); await Promise.resolve(); await Promise.resolve()
    assert.equal(completed, false)
    assert.deepEqual(JSON.parse(JSON.stringify(f.cancellations)), [{ messageId: f.invocations[0]!.messageId, reason: 'cancel' }])
    f.resolve({ messageId: f.invocations[0]!.messageId, success: false, error: { code, message: 'native fact' } })
    await assert.rejects(pending, { code })
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(f.port.getPendingCallsCount(), 0)
  }
})

test('SDK2 NetworkAPI carries its 300000ms deadline plus 250ms through the fixed network IPC bridge', async () => {
  const f = sdk2NetworkFixture(), controller = new AbortController()
  const pending = f.api.request({ method: 'GET', url: 'https://example.test/rates', timeout: 300000, signal: controller.signal })
  await Promise.resolve()
  assert.equal(f.invocations.length, 1)
  const request = f.invocations[0]!
  assert.equal(request.timeoutMs, 300250)
  assert.deepEqual(JSON.parse(JSON.stringify(request.params)), {
    method: 'GET', url: 'https://example.test/rates', timeout: 300000
  })
  assert.equal(Object.prototype.hasOwnProperty.call(request.params, 'signal'), false)
  controller.abort()
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(JSON.parse(JSON.stringify(f.cancellations)), [{ messageId: request.messageId, reason: 'cancel' }])
  f.resolve({ messageId: request.messageId, success: false, error: { code: 'CALLER_DESTROYED', message: 'cancelled' } })
  await assert.rejects(pending, error => {
    const requestError = error as Error & { readonly code?: string; readonly requestId?: string }
    return requestError.code === 'CALLER_DESTROYED' && requestError.requestId === request.messageId &&
      !Object.keys(requestError).includes('requestId')
  })

  const settledRace = sdk2NetworkFixture(), raceController = new AbortController()
  const raced = settledRace.api.request({ method: 'GET', url: 'https://example.test/rates', signal: raceController.signal })
  await Promise.resolve()
  raceController.abort()
  await Promise.resolve(); await Promise.resolve()
  settledRace.resolve({ messageId: settledRace.invocations[0]!.messageId, success: true, data: { statusCode: 200, body: 'settled' } })
  assert.deepEqual(await raced, { statusCode: 200, body: 'settled' }, 'a real Main completion wins the cancellation race')

  await assert.rejects(fixture().port.call('filesystem_read_file', {}, { timeout: 120001 }), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.port.call('network_http_request', {}, { timeout: 300251 }), { code: 'INVALID_REQUEST' })
})

test('SDK2 network cancellation handles pre-abort, cancel-before-invoke, and unconfirmed settlement distinctly', async () => {
  const pre = sdk2NetworkFixture(), preAborted = new AbortController(); preAborted.abort()
  await assert.rejects(pre.api.request({ method: 'GET', url: 'https://example.test', signal: preAborted.signal }), { code: 'CALLER_DESTROYED' })
  assert.equal(pre.invocations.length, 0)
  assert.equal(pre.cancellations.length, 0)

  const early = sdk2NetworkFixture()
  let abortListener: (() => void) | undefined
  const earlySignal = {
    aborted: false,
    addEventListener: (_type: string, listener: () => void) => { abortListener = listener; listener() },
    removeEventListener: () => undefined
  }
  const earlyPending = early.api.request({ method: 'GET', url: 'https://example.test', signal: earlySignal })
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(early.events, ['cancel', 'request'])
  assert.equal(early.cancellations[0]?.reason, 'cancel')
  early.resolve({ messageId: early.invocations[0]!.messageId, success: false, error: { code: 'CALLER_DESTROYED', message: 'early cancellation' } })
  await assert.rejects(earlyPending, { code: 'CALLER_DESTROYED' })
  assert.equal(typeof abortListener, 'function')

  const unknown = sdk2NetworkFixture(10), controller = new AbortController()
  const unknownPending = unknown.api.request({ method: 'GET', url: 'https://example.test', timeout: 300000, signal: controller.signal })
  await Promise.resolve(); controller.abort(); await Promise.resolve(); await Promise.resolve()
  await assert.rejects(unknownPending, { code: 'CANCELLATION_UNCONFIRMED' })
  unknown.resolve({ messageId: unknown.invocations[0]!.messageId, success: false, error: { code: 'CALLER_DESTROYED', message: 'late settle' } })
  assert.notEqual((await unknownPending.catch(error => error.code)), 'FILE_ERROR')
})

test('pre-abort dispatches nothing; timeout requests Main cancellation instead of local successful rollback', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(f.port.call('filesystem_write_file', {}, { signal: controller.signal }), { code: 'CALLER_DESTROYED' })
  assert.equal(f.invocations.length, 0)
  const pending = f.port.call('filesystem_read_file', {}, { timeout: 5 })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(JSON.parse(JSON.stringify(f.cancellations)), [{ messageId: f.invocations[0]!.messageId, reason: 'timeout' }])
  f.resolve({ messageId: f.invocations[0]!.messageId, success: false, error: { code: 'REQUEST_TIMEOUT', message: 'cancelled' } })
  await assert.rejects(pending, { code: 'REQUEST_TIMEOUT' })
})

test('noncooperating invoke remains reserved after bounded unknown; destroy cancels and late success is never delivered', async () => {
  const f = fixture(10), pending = f.port.call('filesystem_write_file')
  await Promise.resolve(); f.port.destroy()
  await assert.rejects(pending, { code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
  assert.equal(f.port.getPendingCallsCount(), 1)
  await assert.rejects(f.port.call('filesystem_read_file'), { code: 'CALLER_DESTROYED' })
  f.resolve({ messageId: f.invocations[0]!.messageId, success: true, data: { success: true } })
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(f.port.getPendingCallsCount(), 0)
})

test('matching Main cancellation preserves timeout reason across cancel-before-invoke registration', async () => {
  const tracker = new ReferenceRequestTracker({ isActive: () => true, onRemoved: () => () => {} })
  const value = parseReferenceCancellation({ messageId: 'read', method: 'filesystem_read_file', reason: 'timeout' })
  tracker.cancel(42, value.method, value.messageId, value.reason)
  let dispatched = false
  await assert.rejects(tracker.execute(42, value.method, value.messageId, async () => { dispatched = true }), { code: 'REQUEST_TIMEOUT' })
  assert.equal(dispatched, false); await tracker.stop()
})
