/**
 * ZTools Calendar Service (M1.5-22)
 * 
 * 本地化工程改造：
 * - 纯本地 SQLite 存储（calendar_events 表），离线可用；
 * - 智能提取主流会议直达链接（腾讯会议 meeting.tencent.com、飞书会议 vc.feishu.cn、钉钉会议、Zoom、Microsoft Teams、Google Meet）；
 * - 本地 ICS 日历标准格式（RFC 5545）事件导入与生成导出；
 * - 支持中文拼音首字母模糊检索日程与会议。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { extractPinyinAndAcronym } from './pinyin-helper.js'

export const DEFAULT_CALENDAR_NAME = 'Calendar'
export const MAX_CALENDAR_NAME_LENGTH = 64
export const MAX_LIST_EVENTS_LIMIT = 1000
export const MAX_EXPORT_EVENT_IDS = 1000

export interface CalendarEvent {
  id: string
  title: string
  description?: string | undefined
  location?: string | undefined
  startTime: number
  endTime: number
  allDay: boolean
  conferenceUrl?: string | undefined
  conferenceType?: 'tencent' | 'feishu' | 'dingtalk' | 'zoom' | 'teams' | 'google' | 'webex' | 'other' | undefined
  calendarName: string
  pinyin: string
  createdAt: number
  updatedAt: number
}

export interface CreateEventInput {
  title: string
  description?: string | undefined
  location?: string | undefined
  startTime: number
  endTime: number
  allDay?: boolean | undefined
  conferenceUrl?: string | undefined
  calendarName?: string | undefined
}

export interface ListEventsOptions {
  search?: string | undefined
  /** 只返回结束时间 >= startTime 的日程 */
  startTime?: number | undefined
  /** 只返回开始时间 <= endTime 的日程 */
  endTime?: number | undefined
  limit?: number | undefined
  /** 按开始时间排序方向，默认升序 */
  order?: 'asc' | 'desc' | undefined
}

export interface CalendarServiceOptions {
  dbPath?: string | undefined
}

/** 已知会议平台：按域名（含子域名）识别，路径规则用来排除平台首页等非会议链接 */
const CONFERENCE_PLATFORMS: ReadonlyArray<{
  domains: readonly string[]
  type: NonNullable<CalendarEvent['conferenceType']>
  path?: RegExp
}> = [
  { domains: ['meeting.tencent.com', 'voovmeeting.com'], type: 'tencent' },
  { domains: ['vc.feishu.cn', 'meetings.feishu.cn', 'vc.larksuite.com'], type: 'feishu' },
  { domains: ['meeting.dingtalk.com'], type: 'dingtalk' },
  { domains: ['zoom.us', 'zoom.com', 'zoom.com.cn'], type: 'zoom', path: /^\/(?:j|my|s|w|wc)\/[^/]/i },
  { domains: ['teams.microsoft.com', 'teams.live.com'], type: 'teams' },
  { domains: ['meet.google.com'], type: 'google', path: /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i },
  { domains: ['webex.com'], type: 'webex' }
]

/** 网址候选：不含空白、引号、尖括号与各类括号（会议链接不含括号，这样 Markdown 的 [文字](链接) 不会把右括号带进来） */
const URL_CANDIDATE_RE = /https?:\/\/[^\s"'<>()[\]{}（）【】「」『』《》，。；：！？、]+/gi
/** 链接结尾的标点（句末标点、Markdown 强调符号等）不属于链接 */
const URL_TRAILING_PUNCTUATION_RE = /[.,;:!?*_~`'"]+$/

function matchConferencePlatform(url: string): NonNullable<CalendarEvent['conferenceType']> | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined
  const host = parsed.hostname.toLowerCase()
  for (const platform of CONFERENCE_PLATFORMS) {
    if (!platform.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) continue
    if (platform.path ? !platform.path.test(parsed.pathname) : parsed.pathname.length <= 1) continue
    return platform.type
  }
  return undefined
}

/**
 * 从标题、备注、地点等自由文本里识别会议链接：只认已知会议平台的链接，
 * 普通网址不算会议；结尾标点会被去掉。
 */
export function detectConference(text: string): { url?: string; type?: CalendarEvent['conferenceType'] } {
  if (!text || typeof text !== 'string') return {}
  for (const match of text.matchAll(URL_CANDIDATE_RE)) {
    const url = match[0].replace(URL_TRAILING_PUNCTUATION_RE, '')
    const type = matchConferencePlatform(url)
    if (type) return { url, type }
  }
  return {}
}

/** 用户显式填写的会议链接：原样保留，只要求是 http/https 网址 */
function normalizeExplicitConferenceUrl(raw: string): { url: string; type: NonNullable<CalendarEvent['conferenceType']> } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ZToolsError(errorCodes.invalidRequest, '会议链接必须是以 http:// 或 https:// 开头的网址')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ZToolsError(errorCodes.invalidRequest, '会议链接必须是以 http:// 或 https:// 开头的网址')
  }
  return { url: raw, type: matchConferencePlatform(raw) ?? 'other' }
}

function normalizeCalendarName(raw: unknown): string {
  if (raw === undefined || raw === null) return DEFAULT_CALENDAR_NAME
  if (typeof raw !== 'string') {
    throw new ZToolsError(errorCodes.invalidRequest, 'calendarName 无效')
  }
  const name = raw.trim()
  if (name.length > MAX_CALENDAR_NAME_LENGTH) {
    throw new ZToolsError(errorCodes.invalidRequest, `日历名称不能超过 ${MAX_CALENDAR_NAME_LENGTH} 个字符`)
  }
  return name || DEFAULT_CALENDAR_NAME
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

function escapeIcsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

export class CalendarService {
  private readonly db: DatabaseSync

  constructor(options: CalendarServiceOptions = {}) {
    const dbPath = options.dbPath || ':memory:'
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
    this.db = new DatabaseSync(dbPath)
    this.initDatabase()
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        location TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        all_day INTEGER NOT NULL,
        conference_url TEXT,
        conference_type TEXT,
        calendar_name TEXT NOT NULL DEFAULT 'Calendar',
        pinyin TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    // 旧库没有 calendar_name 列：补列（幂等，已有列时跳过）
    const columns = this.db.prepare('PRAGMA table_info(calendar_events)').all() as Array<{ name?: string }>
    if (!columns.some((column) => column.name === 'calendar_name')) {
      this.db.exec("ALTER TABLE calendar_events ADD COLUMN calendar_name TEXT NOT NULL DEFAULT 'Calendar'")
    }
    // 不再往空库里预置演示日程（旧版本写过两条带假会议链接的，已写入的不自动删，用户可在日历里自行删除）
  }

  private normalizeTimeInput(val: number | string | undefined, fallbackOffsetMs: number): number {
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val
    }
    if (typeof val === 'string' && val.trim()) {
      const trimmed = val.trim()
      const hmMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/)
      if (hmMatch) {
        const d = new Date()
        d.setHours(Number(hmMatch[1]), Number(hmMatch[2]), 0, 0)
        return d.getTime()
      }
      const parsed = Date.parse(trimmed)
      if (!Number.isNaN(parsed)) {
        return parsed
      }
    }
    return Date.now() + fallbackOffsetMs
  }

  /**
   * M1.5-22.1: 创建日程 (createEvent)
   */
  public createEvent(input: CreateEventInput): CalendarEvent {
    if (!input || !input.title || !input.title.trim()) {
      throw new Error('Event title cannot be empty')
    }
    const startTime = typeof input.startTime === 'string'
      ? this.normalizeTimeInput(input.startTime, 0)
      : input.startTime
    const endTime = typeof input.endTime === 'string'
      ? this.normalizeTimeInput(input.endTime, 3600 * 1000)
      : input.endTime

    if (!startTime || !endTime || endTime < startTime) {
      throw new Error('Invalid event start or end time')
    }

    const id = randomUUID()
    const title = input.title.trim()
    const rawDesc = input.description ?? (input as { notes?: string }).notes
    const description = rawDesc?.trim() || ''
    const location = input.location?.trim() || ''
    const allDay = !!input.allDay
    const calendarName = normalizeCalendarName(input.calendarName)

    // 会议链接：用户填写的原样保留；没填时只从文本里识别已知会议平台的链接
    let conferenceUrl = typeof input.conferenceUrl === 'string' ? input.conferenceUrl.trim() : undefined
    let conferenceType: CalendarEvent['conferenceType'] = undefined

    if (conferenceUrl) {
      const explicit = normalizeExplicitConferenceUrl(conferenceUrl)
      conferenceUrl = explicit.url
      conferenceType = explicit.type
    } else {
      conferenceUrl = undefined
      const detected = detectConference(`${title} ${description} ${location}`)
      if (detected.url) {
        conferenceUrl = detected.url
        conferenceType = detected.type
      }
    }

    const { pinyin: py, acronym } = extractPinyinAndAcronym(title)
    const pinyin = `${py} ${acronym}`.trim()
    const now = Date.now()

    this.db.prepare(`
      INSERT INTO calendar_events (
        id, title, description, location, start_time, end_time, all_day,
        conference_url, conference_type, calendar_name, pinyin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, title, description, location, startTime, endTime, allDay ? 1 : 0,
      conferenceUrl || null, conferenceType || null, calendarName, pinyin, now, now
    )

    return {
      id,
      title,
      description,
      location,
      startTime,
      endTime,
      allDay,
      conferenceUrl,
      conferenceType,
      calendarName,
      pinyin,
      createdAt: now,
      updatedAt: now
    }
  }

  /**
   * M1.5-22.2: 查看近期日程 (mySchedule)
   */
  public getUpcomingEvents(withinHours = 24): CalendarEvent[] {
    const now = Date.now()
    const maxTime = now + withinHours * 3600 * 1000

    const rows = this.db.prepare(`
      SELECT * FROM calendar_events
      WHERE end_time >= ? AND start_time <= ?
      ORDER BY start_time ASC
    `).all(now - 30 * 60 * 1000, maxTime) as any[]

    return rows.map(r => this.mapRowToEvent(r))
  }

  private buildEventFilter(options: ListEventsOptions): { where: string; params: Array<string | number> } {
    let where = 'WHERE 1=1'
    const params: Array<string | number> = []

    if (typeof options.search === 'string' && options.search.trim()) {
      const q = `%${escapeLike(options.search.trim().toLowerCase())}%`
      where += " AND (LOWER(title) LIKE ? ESCAPE '\\' OR pinyin LIKE ? ESCAPE '\\' OR LOWER(description) LIKE ? ESCAPE '\\'" +
        " OR LOWER(location) LIKE ? ESCAPE '\\' OR LOWER(calendar_name) LIKE ? ESCAPE '\\')"
      params.push(q, q, q, q, q)
    }

    if (typeof options.startTime === 'number' && Number.isFinite(options.startTime)) {
      where += ' AND end_time >= ?'
      params.push(options.startTime)
    }

    if (typeof options.endTime === 'number' && Number.isFinite(options.endTime)) {
      where += ' AND start_time <= ?'
      params.push(options.endTime)
    }

    return { where, params }
  }

  /**
   * 搜索与列出日程 (listEvents)：默认最多 50 条，limit 上限 1000；总数用 countEvents 查询
   */
  public listEvents(options: ListEventsOptions = {}): CalendarEvent[] {
    const { where, params } = this.buildEventFilter(options)
    const rawLimit = Number.isInteger(options.limit) && (options.limit as number) > 0 ? (options.limit as number) : 50
    const limit = Math.min(rawLimit, MAX_LIST_EVENTS_LIMIT)
    const direction = options.order === 'desc' ? 'DESC' : 'ASC'
    const rows = this.db
      .prepare(`SELECT * FROM calendar_events ${where} ORDER BY start_time ${direction}, id ASC LIMIT ?`)
      .all(...params, limit) as any[]
    return rows.map(r => this.mapRowToEvent(r))
  }

  /**
   * 统计符合条件的日程总数（与 listEvents 使用相同的筛选条件，不受 limit 影响）
   */
  public countEvents(options: Omit<ListEventsOptions, 'limit' | 'order'> = {}): number {
    const { where, params } = this.buildEventFilter(options)
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM calendar_events ${where}`).get(...params) as { total?: number } | undefined
    return Number(row?.total ?? 0)
  }

  /**
   * 按 id 读取日程（导出指定日程用）：去重，按开始时间升序；不存在的 id 忽略
   */
  public getEventsByIds(ids: readonly string[]): CalendarEvent[] {
    if (!Array.isArray(ids)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'eventIds 必须是数组')
    }
    const unique = [...new Set(ids)]
    if (unique.length > MAX_EXPORT_EVENT_IDS) {
      throw new ZToolsError(errorCodes.invalidRequest, `一次最多导出 ${MAX_EXPORT_EVENT_IDS} 个日程`)
    }
    if (unique.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'eventIds 包含无效的日程 ID')
    }
    if (unique.length === 0) return []
    const placeholders = unique.map(() => '?').join(', ')
    const rows = this.db
      .prepare(`SELECT * FROM calendar_events WHERE id IN (${placeholders}) ORDER BY start_time ASC, id ASC`)
      .all(...unique) as any[]
    return rows.map(r => this.mapRowToEvent(r))
  }

  /**
   * 删除日程
   */
  public deleteEvent(id: string): boolean {
    const res = this.db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
    return res.changes > 0
  }

  /**
   * 导出为标准 ICS 文本
   */
  public exportToIcs(events?: CalendarEvent[]): string {
    const list = events || this.listEvents({ limit: MAX_LIST_EVENTS_LIMIT })
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//ZTools//Calendar Service//CN',
      'CALSCALE:GREGORIAN'
    ]

    for (const evt of list) {
      const dtStart = new Date(evt.startTime).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'
      const dtEnd = new Date(evt.endTime).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z'

      lines.push('BEGIN:VEVENT')
      lines.push(`UID:${evt.id}`)
      lines.push(`SUMMARY:${evt.title}`)
      if (evt.description) lines.push(`DESCRIPTION:${evt.description.replace(/\n/g, '\\n')}`)
      if (evt.location) lines.push(`LOCATION:${evt.location}`)
      if (evt.conferenceUrl) lines.push(`URL:${evt.conferenceUrl}`)
      if (evt.calendarName) lines.push(`CATEGORIES:${escapeIcsText(evt.calendarName)}`)
      lines.push(`DTSTART:${dtStart}`)
      lines.push(`DTEND:${dtEnd}`)
      lines.push('END:VEVENT')
    }

    lines.push('END:VCALENDAR')
    return lines.join('\r\n')
  }

  private mapRowToEvent(r: any): CalendarEvent {
    return {
      id: r.id,
      title: r.title,
      description: r.description || undefined,
      location: r.location || undefined,
      startTime: r.start_time,
      endTime: r.end_time,
      allDay: r.all_day === 1,
      conferenceUrl: r.conference_url || undefined,
      conferenceType: r.conference_type || undefined,
      calendarName: r.calendar_name || DEFAULT_CALENDAR_NAME,
      pinyin: r.pinyin,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }
  }

  public stop(): void {
    try {
      this.db.close()
    } catch {
      // 容错处理
    }
  }
}
