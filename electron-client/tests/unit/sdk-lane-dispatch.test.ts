import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import {
  createSdkLaneHandshakeReply,
  dispatchTrustedSdkLaneCall,
  getTrustedSdkLaneContext,
  isCurrentTrustedSdkLaneContext,
  selectTrustedSdkLaneDispatch,
  type SdkLaneIpcEvent,
  type SdkLaneRegistry,
  type SdkLaneTarget
} from '../../src/main/ipc/sdk-lane-dispatch.js'

function fixture(lane: 1 | 2 = 2) {
  let url = 'ztools://plugins/example/index.html'
  const mainFrame = Object.defineProperty({}, 'url', { get: () => url }) as { readonly url: string }
  const target: SdkLaneTarget = {
    id: 42,
    isDestroyed: () => false,
    mainFrame
  }
  let caller: CallerIdentity | undefined = {
    type: 'plugin', webContentsId: target.id, pluginId: 'example', pluginInstanceId: 'instance-1'
  }
  let sdkApiLane: number | undefined = lane
  const registry: SdkLaneRegistry = {
    get: id => caller?.webContentsId === id ? caller : undefined,
    getWebContents: id => id === target.id && caller ? target : undefined,
    getSdkApiLane: owner => owner && caller && owner.type === caller.type && owner.webContentsId === caller.webContentsId &&
      owner.pluginId === caller.pluginId && owner.pluginInstanceId === caller.pluginInstanceId
      ? sdkApiLane as 1 | 2 | undefined : undefined
  }
  const event: SdkLaneIpcEvent = { sender: target, senderFrame: target.mainFrame }
  return {
    target, event, registry,
    setUrl: (value: string) => { url = value },
    setLane: (value: number | undefined) => { sdkApiLane = value },
    setCaller: (value: CallerIdentity | undefined) => { caller = value }
  }
}

test('a registered main window keeps lane 1 while the handshake advertises host maximum 2', () => {
  const url = 'ztools://web/index.html'
  const mainFrame = { url }
  const target: SdkLaneTarget = { id: 41, isDestroyed: () => false, mainFrame }
  const caller: CallerIdentity = { type: 'main', webContentsId: target.id }
  const registry: SdkLaneRegistry = {
    get: id => id === target.id ? caller : undefined,
    getWebContents: id => id === target.id ? target : undefined,
    getSdkApiLane: owner => owner?.type === 'main' && owner.webContentsId === target.id ? 1 : undefined
  }
  const event: SdkLaneIpcEvent = { sender: target, senderFrame: mainFrame }
  assert.deepEqual(createSdkLaneHandshakeReply(registry, event, 0, false, 2), {
    hostMaximumSdkContractVersion: 2, windowSdkApiLane: 1
  })
  assert.equal(createSdkLaneHandshakeReply(registry, event, 1, false, 2), null)
})

test('a lane 1 plugin handshake only returns exact Main-derived metadata for its registered frame', () => {
  const f = fixture(1)
  assert.deepEqual(createSdkLaneHandshakeReply(f.registry, f.event, 0, false, 2), {
    hostMaximumSdkContractVersion: 2, windowSdkApiLane: 1
  })
  assert.equal(createSdkLaneHandshakeReply(f.registry, f.event, 1, false, 2), null)
  assert.equal(createSdkLaneHandshakeReply(f.registry, f.event, 0, true, 2), null)

  f.setCaller(undefined)
  assert.equal(createSdkLaneHandshakeReply(f.registry, f.event, 0, false, 2), null)
})

test('handshake rejects foreign senders, subframes, forged URLs, and lane above host maximum', () => {
  const f = fixture(2)
  assert.equal(createSdkLaneHandshakeReply(f.registry, { ...f.event, sender: { ...f.target } }, 0, false, 2), null)
  assert.equal(createSdkLaneHandshakeReply(f.registry, { ...f.event, senderFrame: { url: f.target.mainFrame.url } }, 0, false, 2), null)

  f.setUrl('https://example.invalid/')
  assert.equal(createSdkLaneHandshakeReply(f.registry, f.event, 0, false, 2), null)
  f.setUrl('ztools://plugins/other/index.html')
  assert.equal(createSdkLaneHandshakeReply(f.registry, f.event, 0, false, 2), null)
  f.setUrl('ztools://plugins/example/index.html')
  assert.equal(createSdkLaneHandshakeReply(f.registry, f.event, 0, false, 1), null)
})

test('lane 1 preserves legacy methods and malformed/unknown requests reach the legacy parser', () => {
  const f = fixture(1)
  assert.deepEqual(selectTrustedSdkLaneDispatch(f.registry, f.event, {
    method: 'clipboard_read_text', params: {}, sdkApiLane: 2, contractVersion: 2
  }, 2), { kind: 'legacy', lane: 1 })
  assert.deepEqual(selectTrustedSdkLaneDispatch(f.registry, f.event, {
    method: 'filesystem_derive_read', params: {}, sdkApiLane: 2
  }, 2), { kind: 'legacy', lane: 1 })
  assert.deepEqual(selectTrustedSdkLaneDispatch(f.registry, f.event, { method: 'not_a_method' }, 2), {
    kind: 'legacy', lane: 1
  })
  assert.deepEqual(selectTrustedSdkLaneDispatch(f.registry, f.event, null, 2), {
    kind: 'legacy', lane: 1
  })
})

test('lane 2 selects reference before legacy envelope parsing and never trusts request lane fields', () => {
  const f = fixture(2)
  const oversizedReferenceRequest = {
    messageId: 'reference-large', method: 'filesystem_write_file', params: { payload: 'x'.repeat(1_100_000) },
    sdkApiLane: 1, contractVersion: 1
  }
  const route = selectTrustedSdkLaneDispatch(f.registry, f.event, oversizedReferenceRequest, 2)
  assert.equal(route.kind, 'reference')
  if (route.kind === 'reference') assert.equal(route.context.caller.pluginInstanceId, 'instance-1')

  assert.deepEqual(selectTrustedSdkLaneDispatch(f.registry, f.event, {
    method: 'filesystem_derive_read', params: {}, sdkApiLane: 1
  }, 2).kind, 'reference')
  assert.deepEqual(selectTrustedSdkLaneDispatch(f.registry, f.event, {
    method: 'process_start', params: { path: 'C:/tool.exe' }, sdkApiLane: 2
  }, 2), { kind: 'reject', code: 'NOT_SUPPORTED' })
  assert.deepEqual(selectTrustedSdkLaneDispatch(f.registry, f.event, {
    method: 'clipboard_read_text', params: {}, sdkApiLane: 1
  }, 2).kind, 'reference')
})

test('selected lane 2 call uses the reference endpoint, while a missing endpoint never falls back', async () => {
  const f = fixture(2), request = {
    messageId: 'route-before-parse', method: 'filesystem_write_file', params: { payload: 'x'.repeat(1_100_000) },
    sdkApiLane: 1
  }
  const decision = selectTrustedSdkLaneDispatch(f.registry, f.event, request, 2)
  let referenceCalls = 0, legacyCalls = 0
  const legacy = async () => {
    legacyCalls++
    return { messageId: request.messageId, success: true as const, data: 'legacy' }
  }
  const endpoint = {
    call: async () => {
      referenceCalls++
      return { messageId: request.messageId, success: true as const, data: 'reference' }
    }
  }
  assert.deepEqual(await dispatchTrustedSdkLaneCall({ decision, event: f.event, value: request, reference: endpoint, legacy }), {
    messageId: request.messageId, success: true, data: 'reference'
  })
  assert.deepEqual(await dispatchTrustedSdkLaneCall({ decision, event: f.event, value: request, legacy }), {
    messageId: request.messageId, success: false,
    error: { code: 'NOT_SUPPORTED', message: '文件引用运行时尚未接线' }
  })
  assert.equal(referenceCalls, 1)
  assert.equal(legacyCalls, 0)
})

test('cancel and native file-drop methods select only the trusted reference route on lane 2', () => {
  const f = fixture(2)
  for (const method of ['filesystem_write_file', 'filesystem_derive_read', 'filesystem_read_file']) {
    assert.equal(selectTrustedSdkLaneDispatch(f.registry, f.event, { method }, 2).kind, 'reference', method)
  }
  f.setLane(1)
  assert.deepEqual(selectTrustedSdkLaneDispatch(f.registry, f.event, { method: 'filesystem_read_file' }, 2), {
    kind: 'legacy', lane: 1
  })
})

test('stale generation is rejected before the selected endpoint can observe the request', async () => {
  const f = fixture(2), request = { messageId: 'stale', method: 'filesystem_derive_read', params: {} }
  const decision = selectTrustedSdkLaneDispatch(f.registry, f.event, request, 2)
  f.setCaller({ type: 'plugin', webContentsId: 42, pluginId: 'example', pluginInstanceId: 'instance-2' })
  let referenceCalls = 0, legacyCalls = 0
  const result = await dispatchTrustedSdkLaneCall({
    decision, event: f.event, value: request,
    reference: { call: async () => { referenceCalls++; return { messageId: 'stale', success: true as const, data: null } } },
    legacy: async () => { legacyCalls++; return { messageId: 'stale', success: true as const, data: null } }
  })
  assert.deepEqual(result, {
    messageId: 'stale', success: false,
    error: { code: 'PERMISSION_DENIED', message: '调用者身份或页面已失效' }
  })
  assert.equal(referenceCalls, 0)
  assert.equal(legacyCalls, 0)
})

test('lane 2 has no route when host maximum is 1 and invalid owners do not fall back to legacy', () => {
  const f = fixture(2)
  assert.deepEqual(selectTrustedSdkLaneDispatch(f.registry, f.event, {
    method: 'filesystem_read_file', params: {}
  }, 1), { kind: 'reject', code: 'NOT_SUPPORTED' })

  assert.deepEqual(selectTrustedSdkLaneDispatch(f.registry, { ...f.event, senderFrame: null }, {
    method: 'clipboard_read_text', params: {}
  }, 2), { kind: 'reject', code: 'PERMISSION_DENIED' })
  f.setUrl('https://example.invalid/')
  assert.deepEqual(selectTrustedSdkLaneDispatch(f.registry, f.event, {
    method: 'filesystem_derive_read', params: {}
  }, 2), { kind: 'reject', code: 'PERMISSION_DENIED' })

  f.setUrl('ztools://plugins/example/index.html')
  f.setLane(undefined)
  assert.deepEqual(selectTrustedSdkLaneDispatch(f.registry, f.event, {
    method: 'clipboard_read_text', params: {}
  }, 2), { kind: 'reject', code: 'NOT_SUPPORTED' })
})

test('full owner generation is revalidated after an asynchronous legacy lane 2 call', () => {
  const f = fixture(2)
  const context = getTrustedSdkLaneContext(f.registry, f.event)
  assert.ok(context)
  assert.equal(isCurrentTrustedSdkLaneContext(context), true)
  f.setCaller({ type: 'plugin', webContentsId: 42, pluginId: 'example', pluginInstanceId: 'instance-2' })
  assert.equal(isCurrentTrustedSdkLaneContext(context), false)
})
