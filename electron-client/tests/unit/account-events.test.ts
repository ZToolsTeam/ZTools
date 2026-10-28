import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { publishAccountChanged } from '../../src/main/services/account-events.js'
import { EventService } from '../../src/main/services/event-service.js'

interface SentMessage {
  webContentsId: number
  value: unknown
}

class FakeRegistry {
  readonly sent: SentMessage[] = []
  send(webContentsId: number, _channel: string, value: unknown): boolean {
    this.sent.push({ webContentsId, value })
    return true
  }
  onRemoved(): () => void {
    return () => {}
  }
}

const mainCaller: CallerIdentity = { type: 'main', webContentsId: 1 }
const pluginCaller: CallerIdentity = { type: 'plugin', webContentsId: 2, pluginId: 'demo', pluginInstanceId: 'i-1' }

function envelopeOf(message: SentMessage): Record<string, unknown> {
  return (message.value as { msgData: { envelope: Record<string, unknown> } }).msgData.envelope
}

test('登录、退出事件只送到宿主主窗口，插件窗口即使订阅了也收不到，且不带任何账号信息', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry as never)
  events.subscribe({ key: 'user.logout' }, mainCaller)
  events.subscribe({ key: 'user.login' }, mainCaller)
  events.subscribe({ key: 'user.logout' }, pluginCaller)
  events.subscribe({ key: '*' }, pluginCaller)

  publishAccountChanged(events, 'user.login')
  publishAccountChanged(events, 'user.logout')

  assert.deepEqual(registry.sent.map((message) => message.webContentsId), [1, 1])
  const [login, logout] = registry.sent.map(envelopeOf)
  assert.equal(login?.type, 'user.login')
  assert.equal(logout?.type, 'user.logout')
  assert.deepEqual(logout?.payload, {})
  assert.deepEqual(logout?.source, { kind: 'host' })
})

test('事件发送失败只记日志，不影响登录、退出本身', () => {
  const warnings: string[] = []
  assert.doesNotThrow(() => publishAccountChanged(
    { publishHostToMain() { throw new Error('事件服务已停止') } },
    'user.logout',
    (message) => { warnings.push(message) }
  ))
  assert.deepEqual(warnings, ['发布 user.logout 事件失败:'])
})

test('插件与页面都不能伪造登录、退出事件（发布与请求通道都拦截），宿主仍可发出', () => {
  const registry = new FakeRegistry()
  const events = new EventService(registry as never)
  events.subscribe({ key: 'user.logout' }, mainCaller)
  for (const type of ['user.login', 'user.logout']) {
    for (const caller of [pluginCaller, mainCaller]) {
      const envelope = {
        envelopeId: `env_${type}_${caller.webContentsId}`, version: 'v1', timestamp: 1, type,
        scope: 'system', source: { kind: 'plugin' }, target: { broadcast: true }, payload: {}
      }
      assert.throws(() => events.publish({ envelope } as never, caller), { code: 'PERMISSION_DENIED' })
      assert.throws(() => events.request({ envelope } as never, caller), { code: 'PERMISSION_DENIED' })
    }
  }
  assert.equal(registry.sent.length, 0)

  publishAccountChanged(events, 'user.logout')
  assert.deepEqual(registry.sent.map((message) => message.webContentsId), [1])
})
