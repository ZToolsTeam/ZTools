/**
 * ZTools Focus Service (M1.5-19)
 * 
 * 本地化工程改造：
 * - 专注工作法 / 番茄钟生命周期管理（idle -> running <-> paused -> completed/cancelled）；
 * - 托盘与 HUD 状态联动，毫秒级精准计时与动态剩余时间广播；
 * - 纯本地 SQLite 存储专注分类与历史完成记录（支持今日专注时长、连续专注天数统计）；
 * - 专注分类预置（工作、阅读、编程、深度思考）与自定义增删查改。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { SUPPORTED_LOCALES, t } from '../i18n/index.js'
import type { HudService } from './hud-service.js'

import { projectFocus, readFocusState, type FocusSessionState } from './focus-session.js'

/**
 * 专注服务的错误：用 ZToolsError 让中文原因原样返回给插件（普通 Error 经 IPC 只会显示「宿主内部错误」）；
 * 错误码沿用此前普通 Error 对外的 INTERNAL_ERROR，不改变调用方看到的错误码。
 */
function focusError(message: string): ZToolsError {
  return new ZToolsError(errorCodes.internalError, message)
}
export type { FocusSessionState, FocusSessionStatus, FocusSessionPresentation } from './focus-session.js'

export interface FocusCategory {
  id: string
  name: string
  color: string
  icon: string
  defaultDurationMinutes: number
  pinyin: string
}

export interface StartFocusSessionInput {
  title?: string
  categoryId?: string
  durationMinutes?: number
  mode?: 'single' | 'pomodoro'
}

export interface FocusHistoryRecord {
  id: string
  title: string
  categoryName: string
  durationMinutes: number
  completedAt: number
}

export interface FocusStats {
  todayFocusMinutes: number
  totalFocusedMinutes: number
  totalCompletedSessions: number
  currentStreakDays: number
}

export interface FocusServiceOptions {
  dbPath?: string | undefined
  hudService?: HudService | null | undefined
  snoozeDurationMs?: number | undefined
  onTick?: ((state: FocusSessionState) => void) | undefined
  now?: (() => number) | undefined
  onNotification?: ((title: string, message: string) => Promise<void> | void) | undefined
}

interface DefaultCategorySpec {
  readonly id: string
  readonly nameKey: string
  readonly color: string
  readonly icon: string
  readonly defaultDurationMinutes: number
  readonly pinyin: string
}

const DEFAULT_CATEGORY_SPECS: readonly DefaultCategorySpec[] = [
  { id: 'cat-work', nameKey: 'focus.category.work', color: '#3B82F6', icon: 'briefcase', defaultDurationMinutes: 25, pinyin: 'shendugongzuo' },
  { id: 'cat-code', nameKey: 'focus.category.code', color: '#10B981', icon: 'code', defaultDurationMinutes: 45, pinyin: 'jikebiancheng' },
  { id: 'cat-read', nameKey: 'focus.category.read', color: '#F59E0B', icon: 'book', defaultDurationMinutes: 30, pinyin: 'chenjinyuedu' },
  { id: 'cat-learn', nameKey: 'focus.category.learn', color: '#8B5CF6', icon: 'academic-cap', defaultDurationMinutes: 50, pinyin: 'jishuyanxi' }
]

const DEFAULT_CATEGORY_BY_ID = new Map<string, DefaultCategorySpec>(
  DEFAULT_CATEGORY_SPECS.map((spec) => [spec.id, spec])
)

/** 若为内置预置分类且未被用户自定义改名，则按当前语言动态解析名称 */
function resolveCategoryName(id: string, storedName: string): string {
  const spec = DEFAULT_CATEGORY_BY_ID.get(id)
  if (!spec) return storedName
  const isBuiltinName = SUPPORTED_LOCALES.some((locale) => t(spec.nameKey, undefined, locale) === storedName)
  return isBuiltinName ? t(spec.nameKey) : storedName
}

function categorySearchableNames(id: string, resolvedName: string): string[] {
  const spec = DEFAULT_CATEGORY_BY_ID.get(id)
  if (!spec) return [resolvedName]
  const names = new Set<string>([resolvedName])
  for (const locale of SUPPORTED_LOCALES) {
    names.add(t(spec.nameKey, undefined, locale))
  }
  return [...names]
}

interface FocusCategoryRow {
  id: string
  name: string
  color: string
  icon: string
  default_duration_minutes: number
  pinyin: string
}

export class FocusService {
  private readonly db: DatabaseSync
  private readonly hudService: HudService | null | undefined
  private readonly snoozeDurationMs: number
  private readonly onTick: ((state: FocusSessionState) => void) | undefined

  private currentSession: FocusSessionState | null = null
  private tickerTimer: NodeJS.Timeout | null = null
  private lastTickTimestamp: number = 0
  private readonly now: () => number
  private failure: Error | null = null
  private notificationWarning: string | undefined
  private notify: ((title: string, message: string) => Promise<void> | void) | undefined
  private stopped = false

  constructor(options: FocusServiceOptions = {}) {
    this.hudService = options.hudService
    this.snoozeDurationMs = options.snoozeDurationMs || 180000 // 3 分钟
    this.onTick = options.onTick
    this.now = options.now ?? Date.now
    this.notify = options.onNotification

    const dbPath = options.dbPath || ':memory:'
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
    this.db = new DatabaseSync(dbPath)
    this.initDatabase()
    try {
      const row = this.db.prepare('SELECT payload FROM focus_state WHERE id = 1').get() as { payload: string } | undefined
      if (row) {
        const saved = readFocusState(row.payload)
        this.currentSession = saved.session
        this.lastTickTimestamp = saved.anchor
        if (this.currentSession.status === 'running') this.startTicker()
      }
    } catch (error) {
      this.failure = focusError(t('focus.error.readStateFailed', { detail: String(error) }))
    }
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS focus_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        icon TEXT NOT NULL,
        default_duration_minutes INTEGER NOT NULL,
        pinyin TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS focus_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS focus_history (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category_name TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
    `)

    const columns = this.db.prepare('PRAGMA table_info(focus_history)').all() as { name: string }[]
    if (!columns.some(column => column.name === 'mode')) this.db.exec("ALTER TABLE focus_history ADD COLUMN mode TEXT NOT NULL DEFAULT 'single'")

    // 初始化默认分类
    const countRow = this.db.prepare('SELECT count(*) as count FROM focus_categories').get() as { count: number }
    if (!countRow || countRow.count === 0) {
      const stmt = this.db.prepare(
        'INSERT INTO focus_categories (id, name, color, icon, default_duration_minutes, pinyin) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const cat of DEFAULT_CATEGORY_SPECS) {
        stmt.run(cat.id, t(cat.nameKey), cat.color, cat.icon, cat.defaultDurationMinutes, cat.pinyin)
      }
    }
  }

  public setNotificationHandler(handler: (title: string, message: string) => Promise<void> | void): void {
    this.notify = handler
  }

  private assertAvailable(): void {
    if (this.stopped) throw focusError(t('focus.error.serviceStopped'))
    if (this.failure) throw this.failure
  }

  private present(message: string): void {
    void this.hudService?.showHUD(message).catch(error => console.warn('专注提示失败', error))
  }

  private remind(title: string, message: string): void {
    if (!this.notify) { this.notificationWarning = t('focus.warning.notificationDisconnected'); return }
    this.notificationWarning = undefined
    try {
      void Promise.resolve(this.notify(title, message)).catch(error => {
        this.notificationWarning = t('focus.warning.notificationFailed', { detail: error instanceof Error ? error.message : String(error) })
        console.warn(this.notificationWarning)
      })
    } catch (error) { this.notificationWarning = t('focus.warning.notificationFailed', { detail: error instanceof Error ? error.message : String(error) }) }
  }

  private save(state: FocusSessionState, anchor: number, history?: FocusHistoryRecord): void {
    this.assertAvailable()
    const payload = JSON.stringify({ version: 1, anchor, session: state })
    // 所有入口共用重启时的读取契约，不能写入下次启动无法恢复的状态。
    readFocusState(payload)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (history) this.db.prepare('INSERT INTO focus_history (id, title, category_name, duration_minutes, completed_at, mode) VALUES (?, ?, ?, ?, ?, ?)')
        .run(history.id, history.title, history.categoryName, history.durationMinutes, history.completedAt, this.currentSession?.mode ?? state.mode)
      this.db.prepare('INSERT INTO focus_state (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
        .run(payload)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (rollbackError) { console.error('专注状态回滚失败', rollbackError) }
      throw focusError(t('focus.error.saveStateFailed', { detail: String(error) }))
    }
    this.currentSession = state
    this.lastTickTimestamp = anchor
    if (state.status === 'running') this.startTicker()
    else this.stopTicker()
  }

  public startSession(input: StartFocusSessionInput = {}): FocusSessionState {
    this.assertAvailable()
    const existing = this.getCurrentSession()
    if (existing?.status === 'running' || existing?.status === 'paused') throw focusError(t('focus.error.sessionAlreadyActive'))
    if (input.mode !== undefined && input.mode !== 'single' && input.mode !== 'pomodoro') throw focusError(t('focus.error.invalidMode'))
    if (input.title !== undefined && (typeof input.title !== 'string' || input.title.length > 300)) throw focusError(t('focus.error.invalidTitle'))
    if (input.durationMinutes !== undefined && (!Number.isFinite(input.durationMinutes) || input.durationMinutes < 1 || input.durationMinutes > 1440)) throw focusError(t('focus.error.invalidDuration'))
    const categories = this.listCategories()
    const target = (input.categoryId ? categories.find(c => c.id === input.categoryId) : categories[0])
    if (!target) throw focusError(t('focus.error.categoryNotFound'))
    const mode = input.mode ?? 'single'
    const duration = mode === 'pomodoro' ? 25 : input.durationMinutes ?? target.defaultDurationMinutes
    if (!Number.isFinite(duration) || duration < 1 || duration > 1440) throw focusError(t('focus.error.invalidCategoryDuration'))
    const title = input.title?.trim() || t('focus.session.defaultTitle', { category: target.name })
    if (typeof target.name !== 'string' || !target.name.trim() || target.name.length > 300) throw focusError(t('focus.error.invalidCategoryNameLength'))
    if (title.length > 300) throw focusError(t('focus.error.titleTooLong'))
    const totalDurationMs = Math.round(duration * 60_000), now = this.now()
    const count = this.db.prepare("SELECT count(*) AS count FROM focus_history WHERE mode = 'pomodoro'").get() as { count: number }
    this.save({ id: randomUUID(), title, categoryId: target.id,
      categoryName: target.name, totalDurationMs, elapsedMs: 0, remainingMs: totalDurationMs, progress: 0,
      status: 'running', presentation: 'panel', startedAt: now, pausedAt: null, completedAt: null,
      mode, phase: 'focus', completedCycles: count.count }, now)
    this.present(t('focus.hud.started', { title: this.currentSession!.title, minutes: duration }))
    return this.getCurrentSession()!
  }

  public toggleSession(): FocusSessionState {
    const current = this.getCurrentSession()
    if (current?.status === 'running') return this.pauseSession()
    if (current?.status === 'paused') return this.resumeSession()
    return this.startSession()
  }

  public pauseSession(): FocusSessionState {
    const current = this.getCurrentSession()
    if (current?.status !== 'running') throw focusError(t('focus.error.noRunningSession'))
    const now = this.now()
    this.save({ ...current, status: 'paused', pausedAt: now }, now)
    this.present(t('focus.hud.paused', { title: current.title }))
    return this.getCurrentSession()!
  }

  public resumeSession(): FocusSessionState {
    const current = this.getCurrentSession()
    if (current?.status !== 'paused') throw focusError(t('focus.error.noPausedSession'))
    this.save({ ...current, status: 'running', pausedAt: null }, this.now())
    this.present(t('focus.hud.resumed', { title: current.title }))
    return this.getCurrentSession()!
  }

  public completeSession(): FocusSessionState {
    const current = this.getCurrentSession()
    if (!current || !['running', 'paused'].includes(current.status)) throw focusError(t('focus.error.noCompletableSession'))
    const now = this.now()
    const history = current.phase === 'focus' ? { id: current.id, title: current.title, categoryName: current.categoryName,
      durationMinutes: Math.max(1, Math.round(current.elapsedMs / 60_000)), completedAt: now } : undefined
    this.save({ ...current, status: 'completed', completedAt: now, remainingMs: 0, progress: 1 }, now, history)
    this.present(t('focus.hud.completed'))
    return this.getCurrentSession()!
  }

  public cancelSession(): FocusSessionState {
    const current = this.getCurrentSession()
    if (!current || !['running', 'paused'].includes(current.status)) throw focusError(t('focus.error.noCancellableSession'))
    this.save({ ...current, status: 'cancelled' }, this.now())
    this.present(t('focus.hud.cancelled'))
    return this.getCurrentSession()!
  }

  private advance(now: number): FocusSessionState | null {
    this.assertAvailable()
    if (!this.currentSession) return null
    const current = projectFocus(this.currentSession, this.lastTickTimestamp, now)
    if (current.status !== 'running' || current.remainingMs > 0) return current
    const end = this.lastTickTimestamp + this.currentSession.remainingMs
    const history = current.phase === 'focus' ? { id: current.id, title: current.title, categoryName: current.categoryName,
      durationMinutes: current.totalDurationMs / 60_000, completedAt: end } : undefined
    let next: FocusSessionState = { ...current, status: 'completed', completedAt: end }
    let message = current.phase === 'focus'
      ? t('focus.notification.roundCompleted')
      : t('focus.notification.breakEnded')
    if (current.mode === 'pomodoro' && current.phase === 'focus') {
      const completedCycles = current.completedCycles + 1, long = completedCycles % 4 === 0, totalDurationMs = (long ? 15 : 5) * 60_000
      next = projectFocus({ ...current, phase: long ? 'long_break' : 'short_break', title: long ? t('focus.break.longTitle') : t('focus.break.shortTitle'),
        completedCycles, totalDurationMs, elapsedMs: 0, remainingMs: totalDurationMs, progress: 0, startedAt: end }, end, now)
      if (next.remainingMs === 0) next = { ...next, status: 'completed', completedAt: end + totalDurationMs }
      message = next.status === 'completed'
        ? t('focus.notification.roundAndBreakEnded')
        : t('focus.notification.enterBreak', { minutes: long ? 15 : 5 })
    }
    this.save(next, now, history)
    if (current.mode === 'pomodoro') this.remind(t('focus.notification.pomodoroTitle'), message)
    else this.present(t('focus.hud.completed'))
    return { ...next }
  }

  public getCurrentSession(): FocusSessionState | null {
    const state = this.advance(this.now())
    return state ? { ...state, ...(this.notificationWarning ? { notificationWarning: this.notificationWarning } : {}) } : null
  }

  public getSnoozeDurationMs(): number {
    return this.snoozeDurationMs
  }

  /**
   * M1.5-19.6: 分类管理与查询 (searchCategories, createCategory)
   */
  public listCategories(search?: string): FocusCategory[] {
    const rows = this.db.prepare('SELECT id, name, color, icon, default_duration_minutes, pinyin FROM focus_categories').all() as unknown as FocusCategoryRow[]
    const list: FocusCategory[] = rows.map(r => ({
      id: r.id,
      name: resolveCategoryName(r.id, r.name),
      color: r.color,
      icon: r.icon,
      defaultDurationMinutes: r.default_duration_minutes,
      pinyin: r.pinyin
    }))

    if (!search || !search.trim()) return list
    const q = search.trim().toLowerCase()
    return list.filter(c =>
      categorySearchableNames(c.id, c.name).some(name => name.toLowerCase().includes(q)) ||
      c.pinyin.includes(q)
    )
  }

  public createCategory(input: { name: string; color?: string; icon?: string; defaultDurationMinutes?: number }): FocusCategory {
    const name = input.name?.trim()
    if (!name) throw focusError(t('focus.error.emptyCategoryName'))

    const id = `cat-${randomUUID().slice(0, 8)}`
    const color = input.color || '#3B82F6'
    const icon = input.icon || 'target'
    const defaultDurationMinutes = input.defaultDurationMinutes && input.defaultDurationMinutes > 0 ? input.defaultDurationMinutes : 25
    const pinyin = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')

    this.db.prepare(
      'INSERT INTO focus_categories (id, name, color, icon, default_duration_minutes, pinyin) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, name, color, icon, defaultDurationMinutes, pinyin)

    return { id, name, color, icon, defaultDurationMinutes, pinyin }
  }

  /**
   * M1.5-19.7: 统计数据 (getStats)
   */
  public getStats(): FocusStats {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const todayTimestamp = todayStart.getTime()

    const rows = this.db.prepare('SELECT duration_minutes, completed_at FROM focus_history ORDER BY completed_at DESC').all() as { duration_minutes: number; completed_at: number }[]

    let todayFocusMinutes = 0
    let totalFocusedMinutes = 0
    const completedDays = new Set<number>()
    for (const r of rows) {
      totalFocusedMinutes += r.duration_minutes
      const day = new Date(r.completed_at)
      day.setHours(0, 0, 0, 0)
      completedDays.add(day.getTime())
      if (r.completed_at >= todayTimestamp) {
        todayFocusMinutes += r.duration_minutes
      }
    }

    // 今日尚未完成时，连续记录从昨天起算；按本地日历递减以兼容夏令时。
    const streakDay = new Date(todayTimestamp)
    if (!completedDays.has(streakDay.getTime())) streakDay.setDate(streakDay.getDate() - 1)
    let currentStreakDays = 0
    while (completedDays.has(streakDay.getTime())) {
      currentStreakDays += 1
      streakDay.setDate(streakDay.getDate() - 1)
    }

    return {
      todayFocusMinutes,
      totalFocusedMinutes,
      totalCompletedSessions: rows.length,
      currentStreakDays
    }
  }

  private startTicker(): void {
    if (this.tickerTimer) return
    this.tickerTimer = setInterval(() => {
      try {
        const state = this.getCurrentSession()
        if (state) {
          try { this.onTick?.(state) } catch (error) { console.warn('专注状态监听失败', error) }
        }
      } catch (error) {
        this.failure = focusError(t('focus.error.persistTickFailed', { detail: String(error) }))
        this.stopTicker()
        console.error(this.failure)
      }
    }, 1000)
    this.tickerTimer.unref()
  }

  private stopTicker(): void {
    if (this.tickerTimer) clearInterval(this.tickerTimer)
    this.tickerTimer = null
  }

  public stop(): void {
    if (this.stopped) return
    this.stopTicker()
    this.db.close()
    this.stopped = true
  }
}
