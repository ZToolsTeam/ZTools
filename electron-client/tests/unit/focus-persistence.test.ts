import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { FocusService } from '../../src/main/services/focus-service.js'
import { HudService } from '../../src/main/services/hud-service.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import { toPublicError } from '../../src/contracts/errors.js'

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-persistent-')), dbPath = path.join(directory, 'focus.sqlite')
  let now = Date.now()
  const notices: string[] = [], hudMessages: string[] = [], instances: FocusService[] = []
  const hud = new HudService({ onShow: payload => { hudMessages.push(payload.message) } })
  const open = () => { const s = new FocusService({ dbPath, now: () => now, hudService: hud, onNotification: (_title, body) => { notices.push(body) } }); instances.push(s); return s }
  return { dbPath, open, notices, hudMessages, add: (ms: number) => { now += ms }, close: () => { for (const s of instances) s.stop(); hud.stop(); fs.rmSync(directory, { recursive: true, force: true }) } }
}

test('旧分类默认时长和生成标题也遵守恢复契约；非法值不覆盖已保存状态', () => {
  const f = fixture()
  try {
    let s = f.open(); s.startSession(); s.cancelSession()
    const db = new DatabaseSync(f.dbPath)
    try {
      const before = db.prepare('SELECT payload FROM focus_state').get()
      for (const input of [{ name: '超长时长', defaultDurationMinutes: 1441 }, { name: '非有限时长', defaultDurationMinutes: Infinity }, { name: '长'.repeat(296) }, { name: '长'.repeat(301) }]) {
        const category = s.createCategory(input)
        assert.throws(() => s.startSession({ categoryId: category.id }), /时长|标题|分类名称/)
        assert.deepEqual(db.prepare('SELECT payload FROM focus_state').get(), before)
      }
      s.stop(); s = f.open(); assert.equal(s.getCurrentSession()?.status, 'cancelled')
      const category = s.createCategory({ name: '长'.repeat(300), defaultDurationMinutes: 1440 })
      const session = s.startSession({ categoryId: category.id, title: '边界时长' })
      s.stop(); s = f.open(); assert.equal(s.getCurrentSession()?.id, session.id)
      assert.equal(s.getCurrentSession()?.totalDurationMs, 86_400_000)
    } finally { db.close() }
  } finally { f.close() }
})

test('普通专注自然到期仍显示完成 HUD，写入失败不提前提醒，重启不重复提醒', () => {
  const f = fixture()
  try {
    let s = f.open(); s.startSession({ durationMinutes: 1 }); f.add(60_000)
    const db = new DatabaseSync(f.dbPath)
    try {
      db.exec("CREATE TRIGGER fail_focus BEFORE INSERT ON focus_state BEGIN SELECT RAISE(ABORT, '故障注入'); END")
      assert.throws(() => s.getCurrentSession(), /无法保存/); assert.equal(f.hudMessages.includes('专注已达成'), false)
      db.exec('DROP TRIGGER fail_focus')
      assert.equal(s.getCurrentSession()?.status, 'completed'); assert.equal(f.hudMessages.at(-1), '专注已达成')
      assert.equal(f.notices.length, 0); s.stop(); s = f.open(); s.getCurrentSession()
      assert.equal(f.hudMessages.filter(message => message === '专注已达成').length, 1)
      assert.equal(s.getStats().totalCompletedSessions, 1)
    } finally { db.close() }
  } finally { f.close() }
})

test('真实 SQLite 保持运行、精确暂停和继续状态；重启不重新开始或丢失计时', () => {
  const f = fixture()
  try {
    let s = f.open(), first = s.startSession({ mode: 'pomodoro' })
    assert.equal(first.completedCycles, 0); f.add(1234)
    assert.equal(s.pauseSession().remainingMs, 1_500_000 - 1234)
    assert.throws(() => s.startSession({ mode: 'pomodoro' }), /已有进行中或暂停的计时/)
    s.stop(); f.add(40_000); s = f.open()
    assert.equal(s.getCurrentSession()?.status, 'paused'); assert.equal(s.getCurrentSession()?.remainingMs, 1_500_000 - 1234)
    s.resumeSession(); f.add(4321); s.stop(); f.add(5000); s = f.open()
    assert.equal(s.getCurrentSession()?.id, first.id); assert.equal(s.getCurrentSession()?.remainingMs, 1_500_000 - 1234 - 4321 - 5000)
    assert.equal(s.cancelSession().status, 'cancelled'); s.stop(); s = f.open(); assert.equal(s.getCurrentSession()?.status, 'cancelled'); assert.equal(s.getStats().totalCompletedSessions, 0)
  } finally { f.close() }
})

test('跨重启完成只记一次；短休与第四轮长休按原截止时刻推进，过期不虚构更多专注', () => {
  const f = fixture()
  try {
    let s = f.open()
    for (let i = 1; i <= 4; i++) {
      s.startSession({ mode: 'pomodoro' }); s.stop(); f.add(25 * 60_000 + 2345); s = f.open()
      const current = s.getCurrentSession()!
      assert.equal(current.phase, i === 4 ? 'long_break' : 'short_break'); assert.equal(current.completedCycles, i)
      assert.equal(current.remainingMs, (i === 4 ? 15 : 5) * 60_000 - 2345)
      assert.equal(s.getStats().totalCompletedSessions, i)
      s.stop(); s = f.open(); assert.equal(s.getStats().totalCompletedSessions, i); s.getCurrentSession(); assert.equal(f.notices.filter(n => n.includes('进入')).length, i)
      f.add(16 * 60_000); assert.equal(s.getCurrentSession()?.status, 'completed')
    }
    s.startSession({ mode: 'pomodoro' }); s.stop(); f.add(24 * 3600_000); s = f.open()
    assert.equal(s.getCurrentSession()?.status, 'completed'); assert.equal(s.getCurrentSession()?.completedCycles, 5)
    assert.equal(s.getStats().totalCompletedSessions, 5); assert.equal(s.getStats().totalFocusedMinutes, 125)
  } finally { f.close() }
})

test('状态损坏或写入失败时保留原记录，不显示假启动或假完成', () => {
  const f = fixture()
  try {
    let s = f.open(); s.startSession({ mode: 'pomodoro' }); const db = new DatabaseSync(f.dbPath)
    try {
      const before = db.prepare('SELECT payload FROM focus_state').get()
      db.exec("CREATE TRIGGER fail_focus BEFORE INSERT ON focus_state BEGIN SELECT RAISE(ABORT, '故障注入'); END")
      assert.throws(() => s.pauseSession(), /无法保存/); assert.equal(s.getCurrentSession()?.status, 'running'); assert.deepEqual(db.prepare('SELECT payload FROM focus_state').get(), before)
      f.add(26 * 60_000); assert.throws(() => s.getCurrentSession(), /无法保存/); assert.equal(s.getStats().totalCompletedSessions, 0)
      db.exec('DROP TRIGGER fail_focus'); assert.equal(s.getCurrentSession()?.phase, 'short_break'); assert.equal(s.getStats().totalCompletedSessions, 1)
      s.stop(); db.prepare('UPDATE focus_state SET payload = ?').run('{损坏数据'); s = f.open()
      assert.throws(() => s.getCurrentSession(), /原数据/); assert.throws(() => s.startSession(), /原数据/); assert.equal(db.prepare('SELECT payload FROM focus_state').get()?.payload, '{损坏数据')
    } finally { db.close() }
  } finally { f.close() }
})

test('通知失败可见且不撤销真实完成；不依赖页面存活', async () => {
  const f = fixture()
  try {
    const s = f.open(); s.setNotificationHandler(async () => { throw new Error('通知权限关闭') })
    s.startSession({ mode: 'pomodoro' }); f.add(25 * 60_000); assert.equal(s.getCurrentSession()?.phase, 'short_break')
    await Promise.resolve(); assert.match(s.getCurrentSession()?.notificationWarning ?? '', /权限关闭/); assert.equal(s.getStats().totalCompletedSessions, 1)
  } finally { f.close() }
})

test('IPC 与直接调用拒绝非法时长、类型和模式，不写入新状态', () => {
  const f = fixture()
  try {
    const s = f.open()
    for (const input of [{ durationMinutes: 0 }, { durationMinutes: -1 }, { durationMinutes: Infinity }, { durationMinutes: 1441 }, { durationMinutes: '25' }, { mode: ['pomodoro'] }, { title: 'x'.repeat(301) }]) {
      assert.throws(() => validateMethodParams('focus_start', input)); assert.throws(() => s.startSession(input as never))
    }
    assert.throws(() => validateMethodParams('focus_start', { unknown: 1 })); assert.equal(s.getCurrentSession(), null)
    validateMethodParams('focus_start', { mode: 'pomodoro', title: '专注' })
  } finally { f.close() }
})

test('专注服务的错误为中文且经 IPC 原样返回（错误码保持 INTERNAL_ERROR），插件旧的英文兜底规则不受影响', () => {
  const f = fixture()
  try {
    const s = f.open()
    const publicOf = (fn: () => unknown) => {
      try { fn() } catch (error) { return toPublicError(error) }
      assert.fail('应当抛出错误')
    }
    const cases: Array<[() => unknown, RegExp]> = [
      [() => s.pauseSession(), /^当前没有进行中的计时/],
      [() => s.resumeSession(), /^当前没有暂停的计时/],
      [() => s.completeSession(), /^当前没有可完成的计时/],
      [() => s.cancelSession(), /^当前没有可取消的计时/],
      [() => s.createCategory({ name: '   ' }), /^专注分类名称不能为空$/],
      [() => s.startSession({ mode: 'bad' as never }), /^专注模式无效$/]
    ]
    for (const [fn, pattern] of cases) {
      const error = publicOf(fn)
      assert.equal(error.code, 'INTERNAL_ERROR')
      assert.match(error.message, pattern)
      assert.equal(/[A-Za-z]{4,}/.test(error.message), false, `不应再有英文原因：${error.message}`)
    }
    s.startSession({ mode: 'pomodoro' })
    const conflict = publicOf(() => s.startSession({ mode: 'pomodoro' }))
    assert.deepEqual(conflict, { code: 'INTERNAL_ERROR', message: '已有进行中或暂停的计时，请先继续或取消当前计时' })
    s.stop()
    assert.deepEqual(publicOf(() => s.getCurrentSession()), { code: 'INTERNAL_ERROR', message: '专注服务已停止' })
  } finally { f.close() }
})
