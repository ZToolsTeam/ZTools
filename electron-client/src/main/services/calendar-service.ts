/**
 * ZTools Calendar Service (M1.5-22)
 * 
 * 逆向参考依据：
 * - 源码提取自 Raycast Windows `backend/index.mjs` (key: `calendar`)
 * - 命令结构：`L_({ key: 'calendar', title: 'Calendar', commands: { mySchedule: V(...), createEvent: V(...), aiExtension: V(...) }, dynamicCommands: { event: F_(...) } })`
 * - 核心动作：joinMeeting, openInCalendar, openLink, acceptEvent, declineEvent, copyEventDetails, dismissEvent, deleteEvent
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
import { extractPinyinAndAcronym } from './pinyin-helper.js'

export interface CalendarEvent {
  id: string
  title: string
  description?: string | undefined
  location?: string | undefined
  startTime: number
  endTime: number
  allDay: boolean
  conferenceUrl?: string | undefined
  conferenceType?: 'tencent' | 'feishu' | 'dingtalk' | 'zoom' | 'teams' | 'google' | 'other' | undefined
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
}

export interface CalendarServiceOptions {
  dbPath?: string | undefined
}

/** 智能探测会议平台与提取链接 */
export function detectConference(text: string): { url?: string; type?: CalendarEvent['conferenceType'] } {
  if (!text) return {}

  const patterns: Array<{ regex: RegExp; type: CalendarEvent['conferenceType'] }> = [
    { regex: /https?:\/\/meeting\.tencent\.com\/[a-zA-Z0-9_\-\/?=&]+/i, type: 'tencent' },
    { regex: /https?:\/\/voovmeeting\.com\/[a-zA-Z0-9_\-\/?=&]+/i, type: 'tencent' },
    { regex: /https?:\/\/vc\.feishu\.cn\/[a-zA-Z0-9_\-\/?=&]+/i, type: 'feishu' },
    { regex: /https?:\/\/meeting\.dingtalk\.com\/[a-zA-Z0-9_\-\/?=&]+/i, type: 'dingtalk' },
    { regex: /https?:\/\/([a-zA-Z0-9\-_]+\.)?zoom\.us\/[j|my]\/[0-9a-zA-Z_\-\/?=&]+/i, type: 'zoom' },
    { regex: /https?:\/\/teams\.microsoft\.com\/[a-zA-Z0-9_\-\/?=&%]+/i, type: 'teams' },
    { regex: /https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i, type: 'google' }
  ]

  for (const p of patterns) {
    const m = text.match(p.regex)
    if (m) {
      return { url: m[0], type: p.type }
    }
  }

  const genericUrlMatch = text.match(/https?:\/\/[^\s"'<>]+/i)
  if (genericUrlMatch) {
    return { url: genericUrlMatch[0], type: 'other' }
  }

  return {}
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
        pinyin TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  /**
   * M1.5-22.1: 创建日程 (createEvent)
   */
  public createEvent(input: CreateEventInput): CalendarEvent {
    if (!input || !input.title || !input.title.trim()) {
      throw new Error('Event title cannot be empty')
    }
    if (!input.startTime || !input.endTime || input.endTime < input.startTime) {
      throw new Error('Invalid event start or end time')
    }

    const id = randomUUID()
    const title = input.title.trim()
    const description = input.description?.trim() || ''
    const location = input.location?.trim() || ''
    const allDay = !!input.allDay

    // 智能提取会议链接
    let conferenceUrl = input.conferenceUrl?.trim()
    let conferenceType: CalendarEvent['conferenceType'] = undefined

    if (conferenceUrl) {
      const detected = detectConference(conferenceUrl)
      conferenceType = detected.type || 'other'
    } else {
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
        conference_url, conference_type, pinyin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, title, description, location, input.startTime, input.endTime, allDay ? 1 : 0,
      conferenceUrl || null, conferenceType || null, pinyin, now, now
    )

    return {
      id,
      title,
      description,
      location,
      startTime: input.startTime,
      endTime: input.endTime,
      allDay,
      conferenceUrl,
      conferenceType,
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

  /**
   * 搜索与列出日程 (listEvents)
   */
  public listEvents(options: { search?: string; startTime?: number; endTime?: number; limit?: number } = {}): CalendarEvent[] {
    let sql = 'SELECT * FROM calendar_events WHERE 1=1'
    const params: any[] = []

    if (options.search && options.search.trim()) {
      const q = options.search.trim().toLowerCase()
      sql += ' AND (LOWER(title) LIKE ? OR pinyin LIKE ? OR LOWER(description) LIKE ?)'
      params.push(`%${q}%`, `%${q}%`, `%${q}%`)
    }

    if (options.startTime !== undefined) {
      sql += ' AND end_time >= ?'
      params.push(options.startTime)
    }

    if (options.endTime !== undefined) {
      sql += ' AND start_time <= ?'
      params.push(options.endTime)
    }

    sql += ' ORDER BY start_time ASC LIMIT ?'
    params.push(options.limit || 50)

    const rows = this.db.prepare(sql).all(...params) as any[]
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
    const list = events || this.listEvents({ limit: 1000 })
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
