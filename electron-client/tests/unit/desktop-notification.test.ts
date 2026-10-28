import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import test, { afterEach } from 'node:test'
import { closeDesktopNotifications, showDesktopNotification, type DesktopNotificationApi } from '../../src/main/platform/desktop-notification.js'
import { errorCodes } from '../../src/contracts/errors.js'
import { FocusService } from '../../src/main/services/focus-service.js'

class TestNotification extends EventEmitter {
  shows = 0
  closes = 0
  onShow: () => void = () => {}
  show(): void { this.shows++; this.onShow() }
  close(): void { this.closes++; this.emit('close') }
}

afterEach(closeDesktopNotifications)

function fixture() {
  const notifications: TestNotification[] = []
  const api: DesktopNotificationApi = {
    isSupported: () => true,
    create: options => {
      assert.ok(options.title)
      assert.ok(options.body)
      assert.equal(options.closeButtonText, '关闭')
      const notification = new TestNotification()
      notifications.push(notification)
      return notification
    }
  }
  return { api, notifications }
}

test('通知等待接收回执，回执后保留生命周期监听，迟到失败不改变已返回结果', async () => {
  const f = fixture()
  let completed = false
  const pending = showDesktopNotification('标题', '内容', f.api).then(() => { completed = true })
  const notification = f.notifications[0]!
  assert.equal(notification.shows, 1)
  await Promise.resolve()
  assert.equal(completed, false)
  notification.emit('show')
  await pending
  assert.equal(completed, true)
  assert.equal(notification.listenerCount('close'), 1)
  assert.equal(notification.closes, 0)
  notification.emit('failed', {}, '迟到的失败')
  assert.deepEqual(notification.eventNames(), [])
  assert.equal(notification.closes, 1)
})

test('系统拒绝、同步显示异常和不支持均不返回成功，不泄露原生诊断内容', async () => {
  for (const mode of ['failed', 'throw'] as const) {
    const notification = new TestNotification()
    notification.onShow = () => {
      if (mode === 'throw') throw new Error('private native details')
      notification.emit('failed', {}, 'private native details')
    }
    const pending = showDesktopNotification('标题', '内容', { isSupported: () => true, create: () => notification })
    await assert.rejects(pending, { code: errorCodes.nativeHostError, message: '系统未能接收通知，请检查通知权限' })
    assert.deepEqual(notification.eventNames(), [])
  }
  await assert.rejects(showDesktopNotification('标题', '内容', {
    isSupported: () => false, create: () => { throw new Error('不应创建通知') }
  }), { code: errorCodes.notSupported })
})

test('5秒无回执返回未确认，清理监听并隔离并发通知', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture()
  const successful = showDesktopNotification('第一条', '内容', f.api)
  const timeout = showDesktopNotification('第二条', '内容', f.api)
  const rejected = assert.rejects(timeout, { code: errorCodes.requestTimeout, message: '系统未确认接收通知，请检查通知权限' })
  f.notifications[0]!.emit('show')
  await successful
  t.mock.timers.tick(4999)
  assert.equal(f.notifications[1]!.listenerCount('show'), 1)
  t.mock.timers.tick(1)
  await rejected
  assert.equal(f.notifications[0]!.closes, 0)
  assert.equal(f.notifications[0]!.listenerCount('close'), 1)
  assert.deepEqual(f.notifications[1]!.eventNames(), [])
  assert.equal(f.notifications[1]!.closes, 1)
  f.notifications[1]!.emit('show')
})

test('用户点击或关闭会释放通知；尚未确认就关闭不会报成功', async () => {
  const f = fixture()
  const shown = showDesktopNotification('已接收', '内容', f.api)
  f.notifications[0]!.emit('show')
  await shown
  f.notifications[0]!.emit('click')
  assert.equal(f.notifications[0]!.closes, 1)
  assert.deepEqual(f.notifications[0]!.eventNames(), [])
  const pending = showDesktopNotification('待确认', '内容', f.api)
  const rejected = assert.rejects(pending, { code: errorCodes.cancelled })
  f.notifications[1]!.emit('close')
  await rejected
  assert.equal(f.notifications[1]!.closes, 0)
  assert.deepEqual(f.notifications[1]!.eventNames(), [])
})

test('退出关闭已接收通知、拒绝未确认通知，重复清理不重复关闭', async () => {
  const f = fixture()
  const shown = showDesktopNotification('已接收', '内容', f.api)
  f.notifications[0]!.emit('show')
  await shown
  const pending = showDesktopNotification('待确认', '内容', f.api)
  const rejected = assert.rejects(pending, { code: errorCodes.appStopping })
  closeDesktopNotifications()
  closeDesktopNotifications()
  await rejected
  assert.ok(f.notifications.every(notification => notification.closes === 1 && notification.eventNames().length === 0))
})

test('系统未报告关闭事件时也只保留最近64条，逐出最旧通知不影响新通知', async () => {
  const f = fixture()
  for (let i = 0; i < 80; i++) {
    const pending = showDesktopNotification(`通知${i}`, '内容', f.api)
    f.notifications[i]!.emit('show')
    await pending
  }
  assert.ok(f.notifications.slice(0, 16).every(notification => notification.closes === 1 && notification.eventNames().length === 0))
  assert.ok(f.notifications.slice(16).every(notification => notification.closes === 0 && notification.listenerCount('close') === 1))
  closeDesktopNotifications()
  assert.ok(f.notifications.every(notification => notification.closes === 1))
})

test('容量淘汰未确认的请求必须拒绝；原生关闭抛错不阻止清理其余通知', async t => {
  const warnings: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
  const f = fixture()
  const pending = Array.from({ length: 65 }, (_, i) => showDesktopNotification(`待确认${i}`, '内容', f.api))
  const results = Promise.allSettled(pending)
  f.notifications[1]!.close = () => { throw new Error('原生关闭失败') }
  closeDesktopNotifications()
  const settled = await results
  assert.equal(settled[0]?.status, 'rejected')
  if (settled[0]?.status === 'rejected') assert.equal(settled[0].reason.code, errorCodes.cancelled)
  assert.ok(settled.slice(1).every(result => result.status === 'rejected' && result.reason.code === errorCodes.appStopping))
  assert.ok(f.notifications.every(notification => notification.eventNames().length === 0))
  assert.ok(f.notifications.slice(2).every(notification => notification.closes === 1))
  assert.equal(warnings.length, 1)
  closeDesktopNotifications()
  assert.equal(warnings.length, 1)
})

test('真实垃圾回收不提前释放已接收通知，用户关闭后对象可以回收', () => {
  const script = `
    const assert = require('node:assert/strict');
    const { EventEmitter } = require('node:events');
    const { setImmediate: turn } = require('node:timers/promises');
    const { showDesktopNotification } = require(process.argv[1]);
    let weak;
    const api = { isSupported: () => true, create: () => {
      const notice = new EventEmitter();
      notice.show = () => notice.emit('show');
      notice.close = () => notice.emit('close');
      weak = new WeakRef(notice);
      return notice;
    }};
    async function collect() { for (let i = 0; i < 8; i++) { await turn(); global.gc(); } }
    (async () => {
      await showDesktopNotification('GC测试', '隔离边界，无系统通知', api);
      await collect();
      assert.ok(weak.deref(), '系统通知尚未关闭，不得被GC提前移除');
      weak.deref().emit('close');
      await collect();
      assert.equal(weak.deref(), undefined, '用户关闭后应释放对象');
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  execFileSync(process.execPath, ['--expose-gc', '-e', script, require.resolve('../../src/main/platform/desktop-notification.js')], { timeout: 5000 })
})

test('番茄钟接收通知适配器的失败状态，并保留真实完成记录', async () => {
  const f = fixture()
  let now = Date.now()
  const focus = new FocusService({ now: () => now })
  focus.setNotificationHandler((title, body) => showDesktopNotification(title, body, f.api))
  try {
    focus.startSession({ mode: 'pomodoro' })
    now += 25 * 60_000
    assert.equal(focus.getCurrentSession()?.phase, 'short_break')
    f.notifications[0]!.emit('failed', {}, 'UNErrorDomain error 1')
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.match(focus.getCurrentSession()?.notificationWarning ?? '', /检查通知权限/)
    assert.equal(focus.getStats().totalCompletedSessions, 1)
  } finally { focus.stop() }
})
