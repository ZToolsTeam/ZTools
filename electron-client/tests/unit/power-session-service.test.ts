import assert from 'node:assert/strict'
import test from 'node:test'
import { PowerSessionService } from '../../src/main/services/power-session-service.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { isPlatformSupportedMethod, type CallerIdentity } from '../../src/contracts/capabilities.js'

const caller: CallerIdentity = { type: 'plugin', webContentsId: 1, pluginId: 'caffeine' }
function fixture() {
  const active = new Map<number, string>()
  let next = 0
  const faults = { start: false, stop: new Set<number>() }
  const service = new PowerSessionService({
    startPreventSleep(mode = 'display') {
      if (faults.start) throw new Error('系统无法创建断言')
      active.set(++next, mode)
      return next
    },
    stopPreventSleep(id) {
      if (faults.stop.has(id)) throw new Error('系统暂时无法停止')
      active.delete(id)
    }
  })
  return { service, active, faults }
}

test('电源会话两平台可用，参数契约拒绝不完整与越界输入', () => {
  assert.equal(isPlatformSupportedMethod('system_power_session', 'darwin'), true)
  assert.equal(isPlatformSupportedMethod('system_power_session', 'win32'), true)
  validateMethodParams('system_power_session', { action: 'start', mode: 'system', durationMinutes: 1 })
  for (const params of [{}, { action: ['status'] }, { action: 'start', durationMinutes: 0.5 }, { action: 'start', durationMinutes: 10081 }, { action: 'start', mode: 'bad' }, { action: 'status', dryRun: true }]) {
    assert.throws(() => validateMethodParams('system_power_session', params))
  }
})

test('定时器独立于页面，真实时钟推进到期后自动释放断言', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 })
  const { service, active } = fixture()
  try {
    assert.equal(service.execute({ action: 'status' }, caller).active, false)
    const result = service.execute({ action: 'start', mode: 'system', durationMinutes: 1 }, caller)
    assert.equal(result.expiresAtMs, 160000)
    assert.deepEqual([...active.values()], ['system'])
    t.mock.timers.tick(59000)
    assert.equal(service.execute({ action: 'status' }, caller).remainingMs, 1000)
    t.mock.timers.tick(1000)
    assert.equal(active.size, 0)
    assert.equal(service.execute({ action: 'status' }, caller).active, false)
  } finally { service.stop() }
})

test('不同插件与窗口互不停止，窗口销毁只清理自身资源，失效归属不能调用', () => {
  const { service, active } = fixture()
  const ownerA: CallerIdentity = { type: 'main', webContentsId: 2, attributedPlugin: { pluginId: 'caffeine', sessionId: 'a', permissions: new Set(), source: 'installed' } }
  const ownerB: CallerIdentity = { ...ownerA, attributedPlugin: { ...ownerA.attributedPlugin!, pluginId: 'other' } }
  try {
    for (const owner of [caller, ownerA, ownerB]) service.execute({ action: 'start' }, owner)
    assert.equal(active.size, 3)
    service.execute({ action: 'stop' }, ownerB)
    assert.equal(service.execute({ action: 'status' }, ownerA).active, true)
    assert.throws(() => service.execute({ action: 'stop' }, { ...ownerA, stalePluginSession: true }))
    service.releaseWindow(2)
    assert.equal(active.size, 1)
    assert.equal(service.execute({ action: 'status' }, caller).active, true)
  } finally { service.stop(); assert.equal(active.size, 0) }
})

test('重新开始取消旧倒计时；切换停止后没有遗留定时器', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 })
  const { service, active } = fixture()
  try {
    service.execute({ action: 'start', durationMinutes: 1 }, caller)
    t.mock.timers.tick(30000)
    service.execute({ action: 'start', durationMinutes: 0, mode: 'display' }, caller)
    t.mock.timers.tick(120000)
    assert.equal(active.size, 1)
    assert.equal(service.execute({ action: 'status' }, caller).expiresAtMs, null)
    assert.equal(service.execute({ action: 'toggle' }, caller).active, false)
    assert.equal(active.size, 0)
  } finally { service.stop() }
})

test('原生启动或停止失败不伪报成功；一项释放失败不跳过其他项，恢复后重试释放', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 })
  t.mock.method(console, 'error', () => {})
  const { service, active, faults } = fixture()
  try {
    service.execute({ action: 'start' }, caller)
    faults.stop.add(1)
    assert.throws(() => service.execute({ action: 'start' }, caller))
    assert.throws(() => service.execute({ action: 'stop' }, caller))
    assert.equal(active.size, 1)
    assert.equal(service.execute({ action: 'status' }, caller).active, true)
    service.execute({ action: 'start' }, { ...caller, webContentsId: 2 })
    service.stop()
    assert.deepEqual([...active.keys()], [1])
    faults.stop.clear()
    t.mock.timers.tick(1000)
    assert.equal(active.size, 0)
    faults.start = true
    assert.throws(() => service.execute({ action: 'start' }, caller))
    assert.equal(service.execute({ action: 'status' }, caller).active, false)
  } finally { faults.stop.clear(); service.stop() }
})

test('[回归] 插件卸载、停用或下架时释放它在主窗口建立的不限时防休眠，其他插件的会话保留', () => {
  const { service, active } = fixture()
  const attributed = (pluginId: string): CallerIdentity => ({
    type: 'main', webContentsId: 1,
    attributedPlugin: { pluginId, sessionId: `s-${pluginId}`, permissions: new Set(['system']), source: 'installed' }
  })
  service.execute({ action: 'start', mode: 'display', durationMinutes: 0 }, attributed('caffeine'))
  service.execute({ action: 'start', mode: 'system', durationMinutes: 0 }, attributed('other-plugin'))
  assert.equal(active.size, 2)
  service.releasePlugin(' Caffeine ')
  assert.equal(active.size, 1)
  assert.equal(service.execute({ action: 'status' }, attributed('caffeine')).active, false)
  assert.equal(service.execute({ action: 'status' }, attributed('other-plugin')).active, true)
  service.releasePlugin('caffeine')
  assert.equal(active.size, 1)
  service.stop()
})

test('[失败重试] 释放插件会话时系统暂时无法停止断言，保留句柄稍后重试，不遗失原生断言', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 })
  const { service, active, faults } = fixture()
  service.execute({ action: 'start', durationMinutes: 0 }, caller)
  const [id] = [...active.keys()]
  faults.stop.add(id!)
  service.releasePlugin('caffeine')
  assert.equal(active.size, 1)
  faults.stop.delete(id!)
  t.mock.timers.tick(1000)
  assert.equal(active.size, 0)
})
