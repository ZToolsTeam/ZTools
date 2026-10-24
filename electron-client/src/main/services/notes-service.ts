/**
 * ZTools Notes Service (M1.5-11)
 * 
 * 本地化工程改造：
 * - 纯本地 SQLite 存储（基于 Node 22+ 原生 `node:sqlite` DatabaseSync），安全无云端强制同步捆绑；
 * - FTS5 原生虚拟表全文搜索索引与自动触发器同步，实现毫秒级全文检索（带 LIKE 平滑降级）；
 * - Markdown 文本摘要提取、字数统计与预计阅读耗时计算；
 * - 完整的回收站（软删除）、置顶与分类标签系统。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export interface NoteRecord {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly pinned: boolean
  readonly color: string
  readonly tags: readonly string[]
  readonly is_trash: boolean
  readonly created_at: number
  readonly updated_at: number
}

export interface NoteCreateInput {
  title?: string | undefined
  content: string
  tags?: string[] | undefined
  color?: string | undefined
  pinned?: boolean | undefined
}

export interface NoteUpdateInput {
  title?: string | undefined
  content?: string | undefined
  tags?: string[] | undefined
  color?: string | undefined
  pinned?: boolean | undefined
}

export interface NoteListOptions {
  includeTrash?: boolean
  onlyTrash?: boolean
  tag?: string
  pinnedFirst?: boolean
  limit?: number
}

export interface NoteSearchResult {
  readonly note: NoteRecord
  readonly excerpt: string
  readonly matchCount: number
}

export interface MarkdownMeta {
  readonly wordCount: number
  readonly readingMinutes: number
  readonly excerpt: string
}

export interface NotesServiceOptions {
  dbPath?: string
}

export class NotesService {
  private db: DatabaseSync | null = null
  private readonly dbPath: string
  private fts5Available = false

  constructor(options: NotesServiceOptions = {}) {
    this.dbPath = options.dbPath || ':memory:'
    this.initDatabase()
  }

  private initDatabase(): void {
    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }

    this.db = new DatabaseSync(this.dbPath)

    try {
      this.db.exec('PRAGMA journal_mode = WAL;')
      this.db.exec('PRAGMA synchronous = NORMAL;')
    } catch {
      // Memory DB fallback
    }

    // 1. 创建基础 notes 表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        color TEXT NOT NULL DEFAULT 'default',
        tags TEXT NOT NULL DEFAULT '[]',
        is_trash INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notes_trash ON notes(is_trash);
    `)

    // 2. 尝试初始化 FTS5 全文搜索虚拟表与同步触发器
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          title,
          content,
          content=notes,
          content_rowid=rowid
        );

        CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', old.rowid, old.title, old.content);
          INSERT INTO notes_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
        END;
      `)
      this.fts5Available = true
    } catch {
      // FTS5 不可用时降级为 LIKE 检索
      this.fts5Available = false
    }
  }

  public close(): void {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error('Database is closed')
    }
    return this.db
  }

  /**
   * 自动从 Markdown 首行提取标题（若未指定）
   */
  public extractTitleFromContent(content: string): string {
    if (!content || typeof content !== 'string') return '无标题笔记'
    const lines = content.split('\n')
    for (const rawLine of lines) {
      const line = rawLine.trim().replace(/^#+\s*/, '')
      if (line.length > 0) {
        return line.slice(0, 60)
      }
    }
    return '无标题笔记'
  }

  /**
   * Markdown 纯文本摘要与元信息计算
   */
  public parseMarkdownMeta(content: string, excerptLength = 120): MarkdownMeta {
    if (!content || typeof content !== 'string') {
      return { wordCount: 0, readingMinutes: 1, excerpt: '' }
    }

    // 剥离 Markdown 标点符号与特殊标签
    const clean = content
      .replace(/```[\s\S]*?```/g, '') // 代码块
      .replace(/`([^`]+)`/g, '$1')     // 行内代码
      .replace(/!\[.*?\]\(.*?\)/g, '')  // 图片
      .replace(/\[(.*?)\]\(.*?\)/g, '$1') // 链接
      .replace(/[#*~_>]/g, '')         // 标题与修饰符
      .replace(/\s+/g, ' ')
      .trim()

    const wordCount = clean.length
    const readingMinutes = Math.max(1, Math.ceil(wordCount / 300))
    const excerpt = clean.slice(0, excerptLength)

    return { wordCount, readingMinutes, excerpt }
  }

  /**
   * 创建笔记
   */
  public createNote(input: NoteCreateInput): NoteRecord {
    const db = this.requireDb()
    const now = Date.now()
    const id = randomUUID()
    const content = input.content ?? ''
    const title = input.title?.trim() || this.extractTitleFromContent(content)
    const color = input.color || 'default'
    const pinned = input.pinned ? 1 : 0
    const tagsJson = JSON.stringify(Array.isArray(input.tags) ? input.tags : [])

    const stmt = db.prepare(`
      INSERT INTO notes (id, title, content, pinned, color, tags, is_trash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
    `)
    stmt.run(id, title, content, pinned, color, tagsJson, now, now)

    return {
      id,
      title,
      content,
      pinned: Boolean(pinned),
      color,
      tags: Array.isArray(input.tags) ? input.tags : [],
      is_trash: false,
      created_at: now,
      updated_at: now
    }
  }

  /**
   * 获取单条笔记
   */
  public getNote(id: string): NoteRecord | null {
    const db = this.requireDb()
    const stmt = db.prepare('SELECT * FROM notes WHERE id = ?')
    const row = stmt.get(id) as Record<string, unknown> | undefined
    if (!row) return null

    return this.mapRow(row)
  }

  /**
   * 更新笔记
   */
  public updateNote(id: string, updates: NoteUpdateInput): NoteRecord {
    const db = this.requireDb()
    const existing = this.getNote(id)
    if (!existing) {
      throw new Error(`笔记不存在: ${id}`)
    }

    const now = Date.now()
    const newContent = updates.content !== undefined ? updates.content : existing.content
    const newTitle = updates.title !== undefined ? updates.title : (
      updates.content !== undefined ? this.extractTitleFromContent(newContent) : existing.title
    )
    const newPinned = updates.pinned !== undefined ? (updates.pinned ? 1 : 0) : (existing.pinned ? 1 : 0)
    const newColor = updates.color !== undefined ? updates.color : existing.color
    const newTags = updates.tags !== undefined ? updates.tags : existing.tags
    const tagsJson = JSON.stringify(newTags)

    const stmt = db.prepare(`
      UPDATE notes
      SET title = ?, content = ?, pinned = ?, color = ?, tags = ?, updated_at = ?
      WHERE id = ?
    `)
    stmt.run(newTitle, newContent, newPinned, newColor, tagsJson, now, id)

    return {
      id,
      title: newTitle,
      content: newContent,
      pinned: Boolean(newPinned),
      color: newColor,
      tags: newTags,
      is_trash: existing.is_trash,
      created_at: existing.created_at,
      updated_at: now
    }
  }

  /**
   * 切换置顶状态
   */
  public togglePin(id: string): boolean {
    const note = this.getNote(id)
    if (!note) throw new Error(`笔记不存在: ${id}`)
    const updated = this.updateNote(id, { pinned: !note.pinned })
    return updated.pinned
  }

  /**
   * 软删除（移至废纸篓）
   */
  public moveToTrash(id: string): void {
    const db = this.requireDb()
    const stmt = db.prepare('UPDATE notes SET is_trash = 1, updated_at = ? WHERE id = ?')
    stmt.run(Date.now(), id)
  }

  /**
   * 从废纸篓恢复
   */
  public restoreFromTrash(id: string): void {
    const db = this.requireDb()
    const stmt = db.prepare('UPDATE notes SET is_trash = 0, updated_at = ? WHERE id = ?')
    stmt.run(Date.now(), id)
  }

  /**
   * 永久删除单条笔记
   */
  public permanentlyDelete(id: string): boolean {
    const db = this.requireDb()
    const stmt = db.prepare('DELETE FROM notes WHERE id = ?')
    stmt.run(id)
    return true
  }

  /**
   * 清空废纸篓
   */
  public emptyTrash(): number {
    const db = this.requireDb()
    const countStmt = db.prepare('SELECT COUNT(*) as count FROM notes WHERE is_trash = 1')
    const countRow = countStmt.get() as { count: number } | undefined
    const total = countRow?.count ?? 0

    const delStmt = db.prepare('DELETE FROM notes WHERE is_trash = 1')
    delStmt.run()
    return total
  }

  /**
   * 保存笔记 (新建或更新)
   */
  public saveNote(input: {
    id?: string | undefined
    title?: string | undefined
    content: string
    pinned?: boolean | undefined
    color?: string | undefined
    tags?: string[] | undefined
  }): NoteRecord {
    if (input.id && this.getNote(input.id)) {
      return this.updateNote(input.id, input)
    }
    return this.createNote(input)
  }

  /**
   * 删除笔记 (默认软删除到废纸篓，permanent=true 则物理删除)
   */
  public deleteNote(id: string, permanent?: boolean | undefined): boolean {
    if (permanent) {
      return this.permanentlyDelete(id)
    }
    this.moveToTrash(id)
    return true
  }

  /**
   * 恢复笔记
   */
  public restoreNote(id: string): boolean {
    this.restoreFromTrash(id)
    return true
  }

  /**
   * 列出笔记
   */
  public listNotes(options: NoteListOptions = {}): readonly NoteRecord[] {
    const db = this.requireDb()
    const onlyTrash = options.onlyTrash === true
    const includeTrash = options.includeTrash === true
    const limit = options.limit && options.limit > 0 ? options.limit : 500

    let query = 'SELECT * FROM notes'
    const conditions: string[] = []
    const params: (string | number)[] = []

    if (onlyTrash) {
      conditions.push('is_trash = 1')
    } else if (!includeTrash) {
      conditions.push('is_trash = 0')
    }

    if (options.tag) {
      conditions.push('tags LIKE ?')
      params.push(`%"${options.tag}"%`)
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`
    }

    if (options.pinnedFirst !== false) {
      query += ' ORDER BY pinned DESC, updated_at DESC'
    } else {
      query += ' ORDER BY updated_at DESC'
    }

    query += ' LIMIT ?'
    params.push(limit)

    const stmt = db.prepare(query)
    const rows = (stmt as any).all(...params) as Record<string, unknown>[]
    return rows.map(r => this.mapRow(r))
  }

  /**
   * 全文检索笔记（优先 FTS5，平滑降级至 LIKE）
   */
  public searchNotes(query: string, options: { limit?: number; includeTrash?: boolean } = {}): readonly NoteSearchResult[] {
    const rawQuery = (typeof query === 'string' ? query : '').trim()
    if (!rawQuery) {
      return this.listNotes(options).map(note => ({
        note,
        excerpt: this.parseMarkdownMeta(note.content).excerpt,
        matchCount: 1
      }))
    }

    const db = this.requireDb()
    const limit = options.limit && options.limit > 0 ? options.limit : 50
    const trashFilter = options.includeTrash ? '' : 'AND n.is_trash = 0'

    if (this.fts5Available) {
      try {
        // FTS5 语法清理
        const sanitized = rawQuery.replace(/['"*]/g, ' ').trim()
        if (sanitized) {
          const ftsSql = `
            SELECT n.*, snippet(notes_fts, 1, '<b>', '</b>', '...', 15) as snip
            FROM notes_fts f
            JOIN notes n ON n.rowid = f.rowid
            WHERE notes_fts MATCH ? ${trashFilter}
            ORDER BY rank
            LIMIT ?
          `
          const stmt = db.prepare(ftsSql)
          const rows = stmt.all(sanitized, limit) as Record<string, unknown>[]
          if (rows.length > 0) {
            return rows.map(r => ({
              note: this.mapRow(r),
              excerpt: String(r.snip || this.parseMarkdownMeta(String(r.content || '')).excerpt),
              matchCount: 1
            }))
          }
        }
      } catch {
        // FTS 查询语法异常时无缝降级到普通 LIKE
      }
    }

    // LIKE 兜底检索
    const likeSql = `
      SELECT * FROM notes n
      WHERE (n.title LIKE ? OR n.content LIKE ?) ${trashFilter}
      ORDER BY n.pinned DESC, n.updated_at DESC
      LIMIT ?
    `
    const pattern = `%${rawQuery}%`
    const stmt = db.prepare(likeSql)
    const rows = stmt.all(pattern, pattern, limit) as Record<string, unknown>[]
    return rows.map(r => ({
      note: this.mapRow(r),
      excerpt: this.parseMarkdownMeta(String(r.content || '')).excerpt,
      matchCount: 1
    }))
  }

  /**
   * 统计有效笔记与废纸篓数量
   */
  public countNotes(): { active: number; trash: number; total: number } {
    const db = this.requireDb()
    const stmt = db.prepare(`
      SELECT 
        SUM(CASE WHEN is_trash = 0 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN is_trash = 1 THEN 1 ELSE 0 END) as trash,
        COUNT(*) as total
      FROM notes
    `)
    const row = stmt.get() as { active: number | null; trash: number | null; total: number } | undefined
    return {
      active: Number(row?.active ?? 0),
      trash: Number(row?.trash ?? 0),
      total: Number(row?.total ?? 0)
    }
  }

  private mapRow(row: Record<string, unknown>): NoteRecord {
    let tags: string[] = []
    try {
      if (typeof row.tags === 'string') {
        const parsed = JSON.parse(row.tags)
        if (Array.isArray(parsed)) tags = parsed
      }
    } catch {
      tags = []
    }

    return {
      id: String(row.id),
      title: String(row.title),
      content: String(row.content),
      pinned: Number(row.pinned) === 1,
      color: String(row.color || 'default'),
      tags,
      is_trash: Number(row.is_trash) === 1,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at)
    }
  }

  public stop(): void {
    if (this.db) {
      try {
        this.db.close()
      } catch {
        // Ignore close errors on shutdown
      }
      this.db = null
    }
  }
}
