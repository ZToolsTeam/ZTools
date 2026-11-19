/**
 * 主进程归属与事件服务、渲染层会话和插件调用通道的真实装配测试。
 * 运行前执行 npm --prefix electron-client run build:test。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WindowRegistry } from '../electron-client/out-test/src/main/windows/window-registry.js'
import { EventService } from '../electron-client/out-test/src/main/services/event-service.js'
import { DeclarativePluginAttributionService } from '../electron-client/out-test/src/main/services/declarative-plugin-attribution-service.js'
import {
  createScopedHostBridge,
  getPluginSessionHolder,
  invalidatePluginSession,
  resetPluginSessionHoldersForTest
} from '../frontend/src/declarative/pluginSession.js'

const pluginId = 'sample-market-runtime'

class TestContents extends EventEmitter {
  constructor(id, receive = () => undefined) {
    super()
    this.id = id
    this.receive = receive
  }

  isDestroyed() { return false }
  send(_channel, message) { this.receive(message.msgData.envelope) }
}

async function setup(context, { beforeManifestRead } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-runtime-stop-'))
  await fs.writeFile(path.join(directory, 'plugin.json'), JSON.stringify({
    id: pluginId, version: '1.0.0', permissions: ['clipboard']
  }))
  const registry = new WindowRegistry()
  const delivered = []
  const pluginDelivered = []
  const main = registry.registerMain(new TestContents(1, envelope => {
    delivered.push(envelope)
    if (envelope.type === 'plugin_runtime_stopped' && envelope.source.kind === 'host') {
      invalidatePluginSession(envelope.payload.pluginId)
    }
  }))
  const plugin = registry.registerPlugin(new TestContents(2, envelope => pluginDelivered.push(envelope)), 'other-plugin', 'instance-1')
  const events = new EventService(registry)
  events.subscribe({ key: 'plugin_runtime_stopped' }, main)
  events.subscribe({ key: '*' }, plugin)
  const attribution = new DeclarativePluginAttributionService(registry, {
    readBundled: async () => undefined,
    readInstalled: async () => {
      await beforeManifestRead?.()
      return JSON.parse(await fs.readFile(path.join(directory, 'plugin.json'), 'utf8'))
    },
    isRevoked: async () => ({ revoked: false })
  }, { log: { info() {}, warn() {}, error() {} } })
  let calls = 0
  const handler = (run) => async request => {
    try { return { success: true, data: await run(request) } }
    catch (error) { return { success: false, error: { code: error.code, message: error.message } } }
  }
  const bridge = {
    transport: {
      methods: {
        declarative_session_open: handler(request => attribution.open(main, request.params)),
        declarative_session_close: handler(request => attribution.close(main, request.params)),
        clipboard_copy_text: handler(request => {
          calls += 1
          const caller = attribution.attributeCaller(main, { method: 'clipboard_copy_text', pluginSession: request.pluginSession })
          assert.equal(caller.attributedPlugin?.pluginId, pluginId)
          return { pluginId: caller.attributedPlugin.pluginId }
        })
      }
    }
  }
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { value: { __ztoolsElectron: bridge }, configurable: true })
  context.after(async () => {
    invalidatePluginSession(pluginId)
    resetPluginSessionHoldersForTest()
    attribution.stop()
    events.stop()
    assert.deepEqual(events.diagnostics(), { callers: 0, subscriptions: 0, pendingRequests: 0 })
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
    await fs.rm(directory, { recursive: true, force: true })
  })
  return { events, attribution, bridge, main, plugin, delivered, pluginDelivered, calls: () => calls }
}

test('宿主撤销并通知主窗口后，旧渲染通道失效，新挂载点重新取得有效归属', async context => {
  const fixture = await setup(context)
  const holder = getPluginSessionHolder(pluginId)
  const release = await holder.acquire()
  const scoped = createScopedHostBridge(holder, fixture.bridge)
  const send = () => scoped.transport.methods.clipboard_copy_text({ params: { text: 'verified' } })
  assert.equal((await send()).data.pluginId, pluginId)
  assert.equal(fixture.attribution.snapshot().length, 1)

  assert.equal(fixture.attribution.revokePlugin(pluginId), 1)
  assert.equal(fixture.events.publishHostToMain('plugin_runtime_stopped', { pluginId }).delivered, 1)
  assert.equal(fixture.delivered.length, 1)
  assert.equal(fixture.delivered[0].scope, 'system')
  assert.deepEqual(fixture.delivered[0].source, { kind: 'host' })
  assert.deepEqual(fixture.delivered[0].target, { main: true })
  assert.equal(fixture.pluginDelivered.length, 0)
  await assert.rejects(send, { code: 'PLUGIN_SESSION_EXPIRED' })
  assert.equal(fixture.calls(), 1, '旧代码不能退回不带令牌的宿主调用')
  assert.equal(fixture.attribution.snapshot().length, 0)
  release()

  const replacement = getPluginSessionHolder(pluginId)
  assert.notEqual(replacement, holder)
  const releaseReplacement = await replacement.acquire()
  const reopened = createScopedHostBridge(replacement, fixture.bridge)
  assert.equal((await reopened.transport.methods.clipboard_copy_text({ params: {} })).data.pluginId, pluginId)
  assert.equal(fixture.attribution.snapshot().length, 1)
  releaseReplacement()
})

test('清单读取在途时停止插件，迟到结果不能签发会话或复活旧渲染通道', async context => {
  let enterRead
  let completeRead
  const reading = new Promise(resolve => { enterRead = resolve })
  const barrier = new Promise(resolve => { completeRead = resolve })
  const fixture = await setup(context, {
    beforeManifestRead: async () => { enterRead(); await barrier }
  })
  const holder = getPluginSessionHolder(pluginId)
  const acquiring = holder.acquire()
  const rejected = assert.rejects(acquiring, { code: 'PLUGIN_SESSION_EXPIRED' })
  await reading
  assert.equal(fixture.attribution.revokePlugin(pluginId), 0)
  fixture.events.publishHostToMain('plugin_runtime_stopped', { pluginId })
  completeRead()
  await rejected
  assert.equal(fixture.attribution.snapshot().length, 0)
  assert.equal(holder.token, null)
  const scoped = createScopedHostBridge(holder, fixture.bridge)
  await assert.rejects(() => scoped.transport.methods.clipboard_copy_text({ params: {} }), { code: 'PLUGIN_SESSION_EXPIRED' })
  assert.equal(fixture.calls(), 0)
})

test('渲染层不能通过广播或请求伪造停止事件，已有会话保持可用', async context => {
  const fixture = await setup(context)
  const holder = getPluginSessionHolder(pluginId)
  const release = await holder.acquire()
  const envelope = {
    envelopeId: 'renderer-spoof', version: 'v1', timestamp: 0,
    type: 'plugin_runtime_stopped', scope: 'system',
    source: { kind: 'host' }, target: { main: true }, payload: { pluginId }
  }
  for (const caller of [fixture.main, fixture.plugin]) {
    for (const method of ['publish', 'request']) {
      assert.throws(() => fixture.events[method]({ envelope }, caller), { code: 'PERMISSION_DENIED' })
    }
  }
  assert.equal(fixture.delivered.length, 0)
  assert.equal(fixture.attribution.snapshot().length, 1)
  const scoped = createScopedHostBridge(holder, fixture.bridge)
  assert.equal((await scoped.transport.methods.clipboard_copy_text({ params: {} })).data.pluginId, pluginId)
  release()
})
