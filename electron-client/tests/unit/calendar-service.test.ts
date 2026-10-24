import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { CalendarService, detectConference } from '../../src/main/services/calendar-service.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'

const HOUR = 3600 * 1000
const DAY = 24 * HOUR

function tempDb(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-calendar-'))
  return { dir, dbPath: path.join(dir, 'calendar.sqlite') }
}

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function countVevents(ics: string): number {
  return ics.split('\r\n').filter((line) => line === 'BEGIN:VEVENT').length
}

test('listEvents：日程超过 50 条时按时间窗口仍能查到未来日程，countEvents 返回真实总数', (t) => {
  const service = new CalendarService()
  t.after(() => service.stop())
  const today = startOfToday()
  // 45 条历史日程 + 今天、明天共 10 条
  for (let i = 0; i < 45; i++) {
    const start = today - (60 - i) * DAY
    service.createEvent({ title: `历史日程 ${i}`, startTime: start, endTime: start + HOUR })
  }
  for (let i = 0; i < 9; i++) {
    const start = today + 10 * HOUR + i * HOUR
    service.createEvent({ title: `今天日程 ${i}`, startTime: start, endTime: start + HOUR })
  }
  const tomorrow = today + DAY + HOUR
  const overflow = service.createEvent({ title: 'V溢出 跨午夜测试', startTime: tomorrow, endTime: tomorrow + HOUR })

  // 旧行为：默认只取最早 50 条，未来日程被截掉
  const defaults = service.listEvents()
  assert.equal(defaults.length, 50)
  assert.ok(!defaults.some((e) => e.id === overflow.id))

  // 从今天 0 点起加载：未来日程都在
  const fromToday = service.listEvents({ startTime: today, limit: 500 })
  assert.equal(fromToday.length, 10)
  assert.equal(fromToday[fromToday.length - 1]?.id, overflow.id)
  assert.equal(service.countEvents({ startTime: today }), 10)
  assert.equal(service.countEvents(), 55)

  // 搜索走宿主：全部时间范围都能搜到（中文与拼音）
  assert.deepEqual(service.listEvents({ search: 'V溢出', limit: 500 }).map((e) => e.id), [overflow.id])
  assert.equal(service.countEvents({ search: '历史' }), 45)
  assert.ok(service.listEvents({ search: 'yichu' }).some((e) => e.id === overflow.id))

  // 历史日程按时间倒序，最近的在前
  const past = service.listEvents({ endTime: today - 1, order: 'desc', limit: 3 })
  assert.deepEqual(past.map((e) => e.title), ['历史日程 44', '历史日程 43', '历史日程 42'])
})

test('[边界] listEvents 的 limit 被限制在 1000 以内，非法 limit 回落默认值；LIKE 通配符按字面匹配', (t) => {
  const service = new CalendarService()
  t.after(() => service.stop())
  const now = Date.now()
  service.createEvent({ title: '完成率 100%', startTime: now, endTime: now + HOUR })
  service.createEvent({ title: '完成率 1000', startTime: now, endTime: now + HOUR })
  assert.equal(service.listEvents({ limit: 5000 }).length, 2)
  assert.equal(service.listEvents({ limit: -1 }).length, 2)
  assert.deepEqual(service.listEvents({ search: '100%' }).map((e) => e.title), ['完成率 100%'])
  assert.equal(service.countEvents({ search: '_' }), 0)
})

test('所属日历：新建时保存 calendarName，重新打开数据库仍是所选日历；未传时默认 Calendar', (t) => {
  const { dir, dbPath } = tempDb()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const now = Date.now()
  const first = new CalendarService({ dbPath })
  const eng = first.createEvent({ title: '架构评审', startTime: now, endTime: now + HOUR, calendarName: 'Engineering' })
  const plain = first.createEvent({ title: '无分组', startTime: now, endTime: now + HOUR })
  assert.equal(eng.calendarName, 'Engineering')
  assert.equal(plain.calendarName, 'Calendar')
  first.stop()

  const reopened = new CalendarService({ dbPath })
  t.after(() => reopened.stop())
  const byId = new Map(reopened.listEvents().map((e) => [e.id, e]))
  assert.equal(byId.get(eng.id)?.calendarName, 'Engineering')
  assert.equal(byId.get(plain.id)?.calendarName, 'Calendar')
  assert.match(reopened.exportToIcs(reopened.getEventsByIds([eng.id])), /CATEGORIES:Engineering/)
  // 按日历名也能搜到
  assert.deepEqual(reopened.listEvents({ search: 'engineering' }).map((e) => e.id), [eng.id])
})

test('[迁移] 旧库没有 calendar_name 列：启动时补列（重复启动幂等），旧日程读作 Calendar 且可写入新日历', (t) => {
  const { dir, dbPath } = tempDb()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(`
    CREATE TABLE calendar_events (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, location TEXT,
      start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, all_day INTEGER NOT NULL,
      conference_url TEXT, conference_type TEXT, pinyin TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  legacy.prepare(`INSERT INTO calendar_events VALUES ('old-1', '旧日程', '', '', 1, 2, 0, NULL, NULL, 'jiu', 1, 1)`).run()
  legacy.close()

  for (let round = 0; round < 2; round++) {
    const service = new CalendarService({ dbPath })
    const old = service.listEvents().find((e) => e.id === 'old-1')
    assert.equal(old?.calendarName, 'Calendar')
    if (round === 0) {
      service.createEvent({ title: '迁移后新建', startTime: 10, endTime: 20, calendarName: 'Personal' })
    } else {
      assert.equal(service.listEvents({ search: '迁移后' })[0]?.calendarName, 'Personal')
    }
    service.stop()
  }
})

test('[异常] calendarName 超长或类型错误时拒绝，不写入数据库', (t) => {
  const service = new CalendarService()
  t.after(() => service.stop())
  const now = Date.now()
  assert.throws(
    () => service.createEvent({ title: 'x', startTime: now, endTime: now + 1, calendarName: 'a'.repeat(65) }),
    (error: { code?: string }) => error.code === 'INVALID_REQUEST'
  )
  assert.throws(
    () => service.createEvent({ title: 'x', startTime: now, endTime: now + 1, calendarName: 42 as unknown as string }),
    (error: { code?: string }) => error.code === 'INVALID_REQUEST'
  )
  assert.equal(service.countEvents(), 0)
  // 空白日历名回落默认值
  assert.equal(service.createEvent({ title: 'x', startTime: now, endTime: now + 1, calendarName: '   ' }).calendarName, 'Calendar')
})

test('会议识别：只认已知会议平台，普通网址与 Markdown 链接不算会议，结尾标点不进链接', () => {
  assert.deepEqual(detectConference('第二行 **加粗** [链接](https://example.com)'), {})
  assert.deepEqual(detectConference('参考文档 https://example.com/docs.'), {})
  assert.deepEqual(detectConference('[入会](https://us02web.zoom.us/j/123456?pwd=abc)'), {
    url: 'https://us02web.zoom.us/j/123456?pwd=abc',
    type: 'zoom'
  })
  assert.deepEqual(detectConference('Zoom (https://zoom.us/j/987654321).'), { url: 'https://zoom.us/j/987654321', type: 'zoom' })
  assert.deepEqual(detectConference('腾讯会议：https://meeting.tencent.com/dm/abc123。请准时'), {
    url: 'https://meeting.tencent.com/dm/abc123',
    type: 'tencent'
  })
  assert.equal(detectConference('https://vc.feishu.cn/j/888999111!').url, 'https://vc.feishu.cn/j/888999111')
  assert.equal(detectConference('https://meet.google.com/abc-defg-hij').type, 'google')
  assert.equal(detectConference('https://company.webex.com/meet/alice').type, 'webex')
  // 仿冒域名与平台首页不算会议
  assert.deepEqual(detectConference('https://evil-zoom.us/j/1'), {})
  assert.deepEqual(detectConference('https://zoom.us.evil.com/j/1'), {})
  assert.deepEqual(detectConference('https://zoom.us/'), {})
  assert.deepEqual(detectConference('https://meet.google.com/landing'), {})
  // 先出现的普通网址不影响后面的会议链接
  assert.equal(detectConference('文档 https://example.com 会议 https://teams.microsoft.com/l/meetup-join/19%3a').type, 'teams')
  assert.deepEqual(detectConference(''), {})
})

test('createEvent：备注里只有普通网址时不设置会议链接；显式填写的会议链接原样保留，非 http/https 拒绝', (t) => {
  const service = new CalendarService()
  t.after(() => service.stop())
  const now = Date.now()
  const plain = service.createEvent({ title: '写周报', description: '[链接](https://example.com)', startTime: now, endTime: now + HOUR })
  assert.equal(plain.conferenceUrl, undefined)
  assert.equal(plain.conferenceType, undefined)
  assert.equal(service.listEvents().find((e) => e.id === plain.id)?.conferenceUrl, undefined)

  const detected = service.createEvent({ title: '周会', description: '入会 [Zoom](https://zoom.us/j/111222333)', startTime: now, endTime: now + HOUR })
  assert.equal(detected.conferenceUrl, 'https://zoom.us/j/111222333')
  assert.equal(detected.conferenceType, 'zoom')

  const explicit = service.createEvent({ title: '外部会议', conferenceUrl: ' https://example.com/room?id=1 ', startTime: now, endTime: now + HOUR })
  assert.equal(explicit.conferenceUrl, 'https://example.com/room?id=1')
  assert.equal(explicit.conferenceType, 'other')

  for (const bad of ['zoommtg://zoom.us/join?confno=1', 'javascript:alert(1)', 'zoom.us/j/1']) {
    assert.throws(
      () => service.createEvent({ title: '坏链接', conferenceUrl: bad, startTime: now, endTime: now + HOUR }),
      (error: { code?: string }) => error.code === 'INVALID_REQUEST',
      bad
    )
  }
  assert.equal(service.countEvents({ search: '坏链接' }), 0)
})

test('按 id 导出 ICS：只包含指定日程；空数组导出空日历；未知 id 忽略；重复 id 去重', (t) => {
  const service = new CalendarService()
  t.after(() => service.stop())
  const now = Date.now()
  const gym = service.createEvent({ title: '健身', startTime: now, endTime: now + HOUR, calendarName: 'Personal, Home' })
  service.createEvent({ title: '周会', startTime: now, endTime: now + HOUR })
  service.createEvent({ title: '评审', startTime: now, endTime: now + HOUR })

  const one = service.exportToIcs(service.getEventsByIds([gym.id]))
  assert.equal(countVevents(one), 1)
  assert.match(one, /SUMMARY:健身/)
  assert.match(one, /CATEGORIES:Personal\\, Home/)
  assert.equal(countVevents(service.exportToIcs(service.getEventsByIds([]))), 0)
  assert.equal(countVevents(service.exportToIcs(service.getEventsByIds(['missing']))), 0)
  assert.equal(countVevents(service.exportToIcs(service.getEventsByIds([gym.id, gym.id]))), 1)
  // 不传时仍导出全部
  assert.equal(countVevents(service.exportToIcs()), 3)

  assert.throws(() => service.getEventsByIds(Array.from({ length: 1001 }, (_, i) => `id-${i}`)), (e: { code?: string }) => e.code === 'INVALID_REQUEST')
  assert.throws(() => service.getEventsByIds([123 as unknown as string]), (e: { code?: string }) => e.code === 'INVALID_REQUEST')
  assert.throws(() => service.getEventsByIds('abc' as unknown as string[]), (e: { code?: string }) => e.code === 'INVALID_REQUEST')
})

test('[契约] calendar_* 方法参数校验：放行插件实际发送的字段，拒绝越界与未知字段', () => {
  validateMethodParams('calendar_list_events', {})
  validateMethodParams('calendar_list_events', { scope: 'all' })
  validateMethodParams('calendar_list_events', { search: '健身', startTime: Date.now(), limit: 500, order: 'desc' })
  validateMethodParams('calendar_count_events', { startTime: 0, endTime: Date.now(), search: 'x' })
  for (const bad of [{ limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { order: 'up' }, { startTime: 'today' }, { search: 'x'.repeat(257) }, { evil: 1 }]) {
    assert.throws(() => validateMethodParams('calendar_list_events', bad), /无效|超出范围|未知字段/, JSON.stringify(bad))
  }
  assert.throws(() => validateMethodParams('calendar_count_events', { limit: 5 }), /未知字段/)
  validateMethodParams('calendar_export_ics', { eventIds: ['a', 'b'] })
  validateMethodParams('calendar_export_ics', { eventIds: [] })
  assert.throws(() => validateMethodParams('calendar_export_ics', { eventIds: 'a' }))
  assert.throws(() => validateMethodParams('calendar_export_ics', { eventIds: ['x'.repeat(129)] }))
  assert.throws(() => validateMethodParams('calendar_export_ics', { eventIds: Array.from({ length: 1001 }, () => 'a') }))
  validateMethodParams('calendar_create_event', { title: 't', startTime: '10:00', endTime: '11:00', calendarName: 'Work', attendees: [] })
  assert.throws(() => validateMethodParams('calendar_create_event', { title: 't', calendarName: 'x'.repeat(65) }))
  assert.throws(() => validateMethodParams('calendar_create_event', { title: 't', calendarName: 1 }))
})
