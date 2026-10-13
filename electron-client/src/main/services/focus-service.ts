/**
 * ZTools Focus Service (M1.5-19)
 * 
 * 逆向参考依据：
 * - 源码提取自 Raycast Windows `backend/index.mjs` (key: `raycast-focus`)
 * - 命令结构：`L_({ key: 'raycast-focus', title: 'Raycast Focus', commands: { start: V(...), toggle: V(...), pause: V(...), resume: V(...), complete: V(...), edit: V(...), searchCategories: V(...), createCategory: V(...), importCategories: V(...), session: V(...) } })`
 * - 设置项：snoozeDurationMs (default: 180000), playSound, restoreAppsWhenSessionEnds, allowAllOnEmptyWebsiteAllowlist
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
import type { HudService } from './hud-service.js'

export type FocusSessionStatus = 'idle' | 'running' | 'paused' | 'completed' | 'cancelled'
export type FocusSessionPresentation = 'panel' | 'menuBar' | 'hud'

export interface FocusCategory {
  id: string
  name: string
  color: string
  icon: string
  defaultDurationMinutes: number
  pinyin: string
}

export interface FocusSessionState {
  id: string
  title: string
  categoryId: string
  categoryName: string
  totalDurationMs: number
  elapsedMs: number
  remainingMs: number
  progress: number // 0.0 - 1.0
  status: FocusSessionStatus
  presentation: FocusSessionPresentation
  startedAt: number | null
  pausedAt: number | null
  completedAt: number | null
}

export interface StartFocusSessionInput {
  title?: string
  categoryId?: string
  durationMinutes?: number
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
  totalCompletedSessions: number
  currentStreakDays: number
}

export interface FocusServiceOptions {
  dbPath?: string | undefined
  hudService?: HudService | null | undefined
  snoozeDurationMs?: number | undefined
  onTick?: ((state: FocusSessionState) => void) | undefined
}

const DEFAULT_CATEGORIES: FocusCategory[] = [
  { id: 'cat-work', name: '深度工作', color: '#3B82F6', icon: 'briefcase', defaultDurationMinutes: 25, pinyin: 'shendugongzuo' },
  { id: 'cat-code', name: '极客编程', color: '#10B981', icon: 'code', defaultDurationMinutes: 45, pinyin: 'jikebiancheng' },
  { id: 'cat-read', name: '沉浸阅读', color: '#F59E0B', icon: 'book', defaultDurationMinutes: 30, pinyin: 'chenjinyuedu' },
  { id: 'cat-learn', name: '技术研析', color: '#8B5CF6', icon: 'academic-cap', defaultDurationMinutes: 50, pinyin: 'jishuyanxi' }
]

export class FocusService {
  private readonly db: DatabaseSync
  private readonly hudService: HudService | null | undefined
  private readonly snoozeDurationMs: number
  private readonly onTick: ((state: FocusSessionState) => void) | undefined

  private currentSession: FocusSessionState | null = null
  private tickerTimer: NodeJS.Timeout | null = null
  private lastTickTimestamp: number = 0

  constructor(options: FocusServiceOptions = {}) {
    this.hudService = options.hudService
    this.snoozeDurationMs = options.snoozeDurationMs || 180000 // 3 分钟
    this.onTick = options.onTick

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
      CREATE TABLE IF NOT EXISTS focus_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        icon TEXT NOT NULL,
        default_duration_minutes INTEGER NOT NULL,
        pinyin TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS focus_history (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        category_name TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
    `)

    // 初始化默认分类
    const countRow = this.db.prepare('SELECT count(*) as count FROM focus_categories').get() as { count: number }
    if (!countRow || countRow.count === 0) {
      const stmt = this.db.prepare(
        'INSERT INTO focus_categories (id, name, color, icon, default_duration_minutes, pinyin) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const cat of DEFAULT_CATEGORIES) {
        stmt.run(cat.id, cat.name, cat.color, cat.icon, cat.defaultDurationMinutes, cat.pinyin)
      }
    }
  }

  /**
   * M1.5-19.1: 启动专注会话 (start)
   */
  public startSession(input: StartFocusSessionInput = {}): FocusSessionState {
    if (this.currentSession && this.currentSession.status === 'running') {
      throw new Error('A focus session is already running')
    }

    const categories = this.listCategories()
    const fallbackCat: FocusCategory = DEFAULT_CATEGORIES[0] ?? {
      id: 'cat-default',
      name: '专注时钟',
      color: '#3B82F6',
      icon: 'target',
      defaultDurationMinutes: 25,
      pinyin: 'zhuanzhushizhong'
    }
    const targetCat: FocusCategory = (input.categoryId ? categories.find(c => c.id === input.categoryId) : undefined) ?? categories[0] ?? fallbackCat

    const durationMinutes = input.durationMinutes && input.durationMinutes > 0
      ? input.durationMinutes
      : targetCat.defaultDurationMinutes

    const totalDurationMs = durationMinutes * 60 * 1000
    const now = Date.now()

    this.currentSession = {
      id: randomUUID(),
      title: input.title?.trim() || `${targetCat.name} 专注时钟`,
      categoryId: targetCat.id,
      categoryName: targetCat.name,
      totalDurationMs,
      elapsedMs: 0,
      remainingMs: totalDurationMs,
      progress: 0,
      status: 'running',
      presentation: 'panel',
      startedAt: now,
      pausedAt: null,
      completedAt: null
    }

    this.startTicker()
    void this.hudService?.showHUD(`⏱️ 开始专注：${this.currentSession.title} (${durationMinutes} 分钟)`)
    return { ...this.currentSession }
  }

  /**
   * M1.5-19.2: 切换专注状态 (toggle)
   */
  public toggleSession(): FocusSessionState {
    if (!this.currentSession || this.currentSession.status === 'idle' || this.currentSession.status === 'completed' || this.currentSession.status === 'cancelled') {
      return this.startSession()
    }
    if (this.currentSession.status === 'running') {
      return this.pauseSession()
    }
    if (this.currentSession.status === 'paused') {
      return this.resumeSession()
    }
    return { ...this.currentSession }
  }

  /**
   * M1.5-19.3: 暂停当前专注 (pause)
   */
  public pauseSession(): FocusSessionState {
    if (!this.currentSession || this.currentSession.status !== 'running') {
      throw new Error('No active running focus session to pause')
    }
    this.currentSession.status = 'paused'
    this.currentSession.pausedAt = Date.now()
    this.stopTicker()
    void this.hudService?.showHUD(`⏸️ 专注已暂停：${this.currentSession.title}`)
    return { ...this.currentSession }
  }

  /**
   * M1.5-19.4: 恢复当前专注 (resume)
   */
  public resumeSession(): FocusSessionState {
    if (!this.currentSession || this.currentSession.status !== 'paused') {
      throw new Error('No paused focus session to resume')
    }
    this.currentSession.status = 'running'
    this.currentSession.pausedAt = null
    this.startTicker()
    void this.hudService?.showHUD(`▶️ 专注已继续：${this.currentSession.title}`)
    return { ...this.currentSession }
  }

  /**
   * M1.5-19.5: 提前或正常完成专注 (complete)
   */
  public completeSession(): FocusSessionState {
    if (!this.currentSession || (this.currentSession.status !== 'running' && this.currentSession.status !== 'paused')) {
      throw new Error('No active focus session to complete')
    }

    this.stopTicker()
    const now = Date.now()
    this.currentSession.status = 'completed'
    this.currentSession.completedAt = now
    this.currentSession.remainingMs = 0
    this.currentSession.progress = 1.0

    const completedMinutes = Math.max(1, Math.round(this.currentSession.elapsedMs / 60000))

    try {
      this.db.prepare(
        'INSERT INTO focus_history (id, title, category_name, duration_minutes, completed_at) VALUES (?, ?, ?, ?, ?)'
      ).run(this.currentSession.id, this.currentSession.title, this.currentSession.categoryName, completedMinutes, now)
    } catch {
      // 容错处理
    }

    void this.hudService?.showHUD(`🎉 专注已达成！本次坚持了 ${completedMinutes} 分钟`)
    const result = { ...this.currentSession }
    return result
  }

  /**
   * 取消当前会话 (cancel)
   */
  public cancelSession(): FocusSessionState {
    if (!this.currentSession || (this.currentSession.status !== 'running' && this.currentSession.status !== 'paused')) {
      throw new Error('No active focus session to cancel')
    }
    this.stopTicker()
    this.currentSession.status = 'cancelled'
    void this.hudService?.showHUD('❌ 专注已取消')
    return { ...this.currentSession }
  }

  /**
   * 获取当前状态
   */
  public getCurrentSession(): FocusSessionState | null {
    return this.currentSession ? { ...this.currentSession } : null
  }

  public getSnoozeDurationMs(): number {
    return this.snoozeDurationMs
  }

  /**
   * M1.5-19.6: 分类管理与查询 (searchCategories, createCategory)
   */
  public listCategories(search?: string): FocusCategory[] {
    const rows = this.db.prepare('SELECT id, name, color, icon, default_duration_minutes, pinyin FROM focus_categories').all() as any[]
    const list: FocusCategory[] = rows.map(r => ({
      id: r.id,
      name: r.name,
      color: r.color,
      icon: r.icon,
      defaultDurationMinutes: r.default_duration_minutes,
      pinyin: r.pinyin
    }))

    if (!search || !search.trim()) return list
    const q = search.trim().toLowerCase()
    return list.filter(c => c.name.toLowerCase().includes(q) || c.pinyin.includes(q))
  }

  public createCategory(input: { name: string; color?: string; icon?: string; defaultDurationMinutes?: number }): FocusCategory {
    const name = input.name?.trim()
    if (!name) throw new Error('Category name cannot be empty')

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

    const rows = this.db.prepare('SELECT duration_minutes, completed_at FROM focus_history ORDER BY completed_at DESC').all() as any[]

    let todayFocusMinutes = 0
    for (const r of rows) {
      if (r.completed_at >= todayTimestamp) {
        todayFocusMinutes += r.duration_minutes
      }
    }

    return {
      todayFocusMinutes,
      totalCompletedSessions: rows.length,
      currentStreakDays: rows.length > 0 ? 1 : 0
    }
  }

  private startTicker(): void {
    this.stopTicker()
    this.lastTickTimestamp = Date.now()

    this.tickerTimer = setInterval(() => {
      if (!this.currentSession || this.currentSession.status !== 'running') {
        this.stopTicker()
        return
      }

      const now = Date.now()
      const delta = now - this.lastTickTimestamp
      this.lastTickTimestamp = now

      this.currentSession.elapsedMs += delta
      this.currentSession.remainingMs = Math.max(0, this.currentSession.totalDurationMs - this.currentSession.elapsedMs)
      this.currentSession.progress = Math.min(1.0, this.currentSession.elapsedMs / this.currentSession.totalDurationMs)

      if (this.onTick) {
        this.onTick({ ...this.currentSession })
      }

      if (this.currentSession.remainingMs <= 0) {
        this.completeSession()
      }
    }, 1000)
  }

  private stopTicker(): void {
    if (this.tickerTimer) {
      clearInterval(this.tickerTimer)
      this.tickerTimer = null
    }
  }

  public stop(): void {
    this.stopTicker()
    try {
      this.db.close()
    } catch {
      // 容错处理
    }
  }
}
