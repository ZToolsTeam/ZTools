import { randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export interface SnippetRecord {
  id: string
  name: string
  keyword: string
  snippet: string
  enabled: boolean
  created_at: number
  updated_at: number
}

export interface SnippetInput {
  name: string
  keyword: string
  snippet: string
  enabled?: boolean
}

export interface MacroContext {
  clipboard?: string | undefined
  now?: Date | undefined
}

export interface MacroExpandResult {
  expanded: string
  cursorOffset: number // 从末尾往前数的光标字符偏移量
  hasCursor: boolean
}

export interface SnippetMatchResult {
  matched: boolean
  snippet?: SnippetRecord
  keyword?: string
  backspaceCount?: number
  expanded?: string
  cursorOffset?: number
}

export interface SnippetImportResult {
  total: number
  imported: number
  updated: number
  failed: number
  errors: string[]
}

export interface SnippetsServiceOptions {
  dbPath?: string | undefined
  onSnippetsChanged?: ((snippets: SnippetRecord[]) => void) | undefined
}

/**
 * 宏展开解析器 (支持 {clipboard}, {date}, {time}, {datetime}, {year}, {month}, {day}, {uuid}, {cursor})
 */
export function expandSnippetMacros(template: string, context: MacroContext = {}): MacroExpandResult {
  if (!template || typeof template !== 'string') {
    return { expanded: '', cursorOffset: 0, hasCursor: false }
  }

  const d = context.now || new Date()
  const year = String(d.getFullYear())
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')

  const dateStr = `${year}-${month}-${day}`
  const timeStr = `${hours}:${minutes}:${seconds}`
  const datetimeStr = `${dateStr} ${timeStr}`
  const clipboardText = context.clipboard ?? ''

  let text = template
    .replace(/\{clipboard\}/gi, clipboardText)
    .replace(/\{date\}/gi, dateStr)
    .replace(/\{time\}/gi, timeStr)
    .replace(/\{datetime\}/gi, datetimeStr)
    .replace(/\{year\}/gi, year)
    .replace(/\{month\}/gi, month)
    .replace(/\{day\}/gi, day)

  // 处理 {uuid}
  while (/\{uuid\}/i.test(text)) {
    text = text.replace(/\{uuid\}/i, randomUUID())
  }

  // 处理 {cursor} 光标回退
  const cursorIndex = text.indexOf('{cursor}')
  if (cursorIndex !== -1) {
    const before = text.slice(0, cursorIndex)
    const after = text.slice(cursorIndex + '{cursor}'.length)
    const expanded = before + after
    const cursorOffset = after.length // 从末尾向左移动的步数
    return {
      expanded,
      cursorOffset,
      hasCursor: true
    }
  }

  return {
    expanded: text,
    cursorOffset: 0,
    hasCursor: false
  }
}

/**
 * 快捷短语与宏展开服务 (Snippets Service)
 */
export class SnippetsService {
  private db: DatabaseSync | null = null
  private dbPath: string
  private onSnippetsChanged?: ((snippets: SnippetRecord[]) => void) | undefined

  constructor(options: SnippetsServiceOptions = {}) {
    this.dbPath = options.dbPath || ':memory:'
    this.onSnippetsChanged = options.onSnippetsChanged
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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snippets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        keyword TEXT NOT NULL UNIQUE,
        snippet TEXT NOT NULL,
        enabled INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snippets_keyword ON snippets(keyword);
      CREATE INDEX IF NOT EXISTS idx_snippets_enabled ON snippets(enabled);
    `)
  }

  /**
   * 获取全部短语列表
   */
  public listSnippets(query?: string): SnippetRecord[] {
    if (!this.db) throw new Error('Database is closed')

    if (query && query.trim()) {
      const q = `%${query.trim()}%`
      const stmt = this.db.prepare(`
        SELECT * FROM snippets
        WHERE name LIKE ? OR keyword LIKE ? OR snippet LIKE ?
        ORDER BY updated_at DESC
      `)
      const rows = stmt.all(q, q, q) as any[]
      return rows.map(r => this.mapRow(r))
    }

    const stmt = this.db.prepare('SELECT * FROM snippets ORDER BY updated_at DESC')
    const rows = stmt.all() as any[]
    return rows.map(r => this.mapRow(r))
  }

  /**
   * 获取所有已启用的短语（按 keyword 长度降序排序，长词优先匹配）
   */
  public getEnabledSnippets(): SnippetRecord[] {
    if (!this.db) throw new Error('Database is closed')
    const stmt = this.db.prepare('SELECT * FROM snippets WHERE enabled = 1 ORDER BY LENGTH(keyword) DESC')
    const rows = stmt.all() as any[]
    return rows.map(r => this.mapRow(r))
  }

  /**
   * 创建新短语
   */
  public createSnippet(input: SnippetInput, now = Date.now()): SnippetRecord {
    if (!this.db) throw new Error('Database is closed')
    this.validateSnippetInput(input)

    const id = randomUUID()
    const enabled = input.enabled !== false ? 1 : 0

    const stmt = this.db.prepare(`
      INSERT INTO snippets (id, name, keyword, snippet, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    try {
      stmt.run(id, input.name.trim(), input.keyword.trim(), input.snippet, enabled, now, now)
    } catch (err: any) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        throw new Error(`触发词 "${input.keyword}" 已存在，不可重复`)
      }
      throw err
    }

    this.notifyChanged()

    return {
      id,
      name: input.name.trim(),
      keyword: input.keyword.trim(),
      snippet: input.snippet,
      enabled: enabled === 1,
      created_at: now,
      updated_at: now
    }
  }

  /**
   * 更新短语
   */
  public updateSnippet(
    id: string,
    updates: Partial<SnippetInput>,
    now = Date.now()
  ): SnippetRecord {
    if (!this.db) throw new Error('Database is closed')
    if (!id || typeof id !== 'string') throw new Error('无效的短语 ID')

    const existingStmt = this.db.prepare('SELECT * FROM snippets WHERE id = ?')
    const existing = existingStmt.get(id) as any
    if (!existing) {
      throw new Error(`未找到 ID 为 "${id}" 的短语`)
    }

    const name = updates.name !== undefined ? updates.name.trim() : existing.name
    const keyword = updates.keyword !== undefined ? updates.keyword.trim() : existing.keyword
    const snippet = updates.snippet !== undefined ? updates.snippet : existing.snippet
    const enabled = updates.enabled !== undefined ? (updates.enabled ? 1 : 0) : existing.enabled

    if (!name) throw new Error('短语名称不能为空')
    if (!keyword) throw new Error('触发词不能为空')
    if (typeof snippet !== 'string') throw new Error('短语内容必须为字符串')

    const updateStmt = this.db.prepare(`
      UPDATE snippets
      SET name = ?, keyword = ?, snippet = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `)

    try {
      updateStmt.run(name, keyword, snippet, enabled, now, id)
    } catch (err: any) {
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        throw new Error(`触发词 "${keyword}" 与其他短语冲突`)
      }
      throw err
    }

    this.notifyChanged()

    return {
      id,
      name,
      keyword,
      snippet,
      enabled: enabled === 1,
      created_at: Number(existing.created_at),
      updated_at: now
    }
  }

  /**
   * 切换启用状态
   */
  public toggleSnippet(id: string): boolean {
    if (!this.db) throw new Error('Database is closed')
    const stmt = this.db.prepare('SELECT enabled FROM snippets WHERE id = ?')
    const row = stmt.get(id) as { enabled: number } | undefined
    if (!row) return false

    const newEnabled = row.enabled === 1 ? 0 : 1
    const updateStmt = this.db.prepare('UPDATE snippets SET enabled = ?, updated_at = ? WHERE id = ?')
    updateStmt.run(newEnabled, Date.now(), id)

    this.notifyChanged()
    return true
  }

  /**
   * 删除短语
   */
  public deleteSnippet(id: string): boolean {
    if (!this.db) throw new Error('Database is closed')
    const stmt = this.db.prepare('DELETE FROM snippets WHERE id = ?')
    const res = stmt.run(id)
    const success = res.changes > 0
    if (success) {
      this.notifyChanged()
    }
    return success
  }

  /**
   * 触发词后缀匹配与宏展开 (用于键盘钩子或输入流监听)
   */
  public matchAndExpand(typedText: string, clipboardContent?: string): SnippetMatchResult {
    if (!typedText || typeof typedText !== 'string') {
      return { matched: false }
    }

    const enabledSnippets = this.getEnabledSnippets()
    for (const snip of enabledSnippets) {
      if (typedText.endsWith(snip.keyword)) {
        const { expanded, cursorOffset } = expandSnippetMacros(snip.snippet, {
          clipboard: clipboardContent,
          now: new Date()
        })
        return {
          matched: true,
          snippet: snip,
          keyword: snip.keyword,
          backspaceCount: snip.keyword.length,
          expanded,
          cursorOffset
        }
      }
    }

    return { matched: false }
  }

  /**
   * 批量导入短语 (JSON Array)
   */
  public importSnippets(data: string | any[]): SnippetImportResult {
    if (!this.db) throw new Error('Database is closed')

    let items: any[]
    if (typeof data === 'string') {
      try {
        items = JSON.parse(data)
      } catch (err: any) {
        throw new Error(`JSON 解析失败: ${err.message}`)
      }
    } else if (Array.isArray(data)) {
      items = data
    } else {
      throw new Error('导入数据必须为 JSON 字符串或数组')
    }

    let imported = 0
    let updated = 0
    let failed = 0
    const errors: string[] = []
    const now = Date.now()

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (!item || typeof item !== 'object') {
        failed++
        errors.push(`第 ${i + 1} 项数据格式错误`)
        continue
      }

      const name = typeof item.name === 'string' ? item.name.trim() : ''
      const keyword = typeof item.keyword === 'string' ? item.keyword.trim() : ''
      const snippet = typeof item.snippet === 'string' ? item.snippet : ''
      const enabled = item.enabled !== false

      if (!name || !keyword || !snippet) {
        failed++
        errors.push(`第 ${i + 1} 项缺少必要字段 (name, keyword, snippet)`)
        continue
      }

      // Check if keyword exists
      const existing = this.db.prepare('SELECT id FROM snippets WHERE keyword = ?').get(keyword) as { id: string } | undefined
      if (existing) {
        this.db.prepare(`
          UPDATE snippets
          SET name = ?, snippet = ?, enabled = ?, updated_at = ?
          WHERE id = ?
        `).run(name, snippet, enabled ? 1 : 0, now, existing.id)
        updated++
      } else {
        const id = item.id && typeof item.id === 'string' ? item.id : randomUUID()
        this.db.prepare(`
          INSERT INTO snippets (id, name, keyword, snippet, enabled, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(id, name, keyword, snippet, enabled ? 1 : 0, now, now)
        imported++
      }
    }

    this.notifyChanged()

    return {
      total: items.length,
      imported,
      updated,
      failed,
      errors
    }
  }

  /**
   * 导出全部短语为 JSON
   */
  public exportSnippets(): SnippetRecord[] {
    return this.listSnippets()
  }

  private validateSnippetInput(input: SnippetInput): void {
    if (!input || typeof input !== 'object') {
      throw new Error('入参必须为对象')
    }
    if (!input.name || typeof input.name !== 'string' || !input.name.trim()) {
      throw new Error('短语名称不能为空')
    }
    if (!input.keyword || typeof input.keyword !== 'string' || !input.keyword.trim()) {
      throw new Error('触发词不能为空')
    }
    if (typeof input.snippet !== 'string') {
      throw new Error('短语内容必须为字符串')
    }
  }

  private mapRow(row: any): SnippetRecord {
    return {
      id: String(row.id),
      name: String(row.name),
      keyword: String(row.keyword),
      snippet: String(row.snippet),
      enabled: Number(row.enabled) === 1,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at)
    }
  }

  private notifyChanged(): void {
    if (this.onSnippetsChanged) {
      try {
        const current = this.listSnippets()
        this.onSnippetsChanged(current)
      } catch (err) {
        console.warn('[SnippetsService] onSnippetsChanged callback error:', err)
      }
    }
  }

  public stop(): void {
    if (this.db) {
      try {
        this.db.close()
      } catch {
        // Ignore close errors
      }
      this.db = null
    }
  }
}
