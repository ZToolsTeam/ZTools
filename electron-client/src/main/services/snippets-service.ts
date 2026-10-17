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

export interface SnippetArgumentDescriptor {
  name: string
  type: 'text' | 'password' | 'dropdown'
  defaultValue: string
  options: string[]
  required: boolean
}

export interface MacroContext {
  clipboard?: string | undefined
  now?: Date | undefined
  args?: Record<string, string> | undefined
  previewPlaceholders?: boolean | undefined
}

export interface MacroExpandResult {
  expanded: string
  cursorOffset: number // 从末尾往前数的光标字符偏移量
  hasCursor: boolean
  arguments: SnippetArgumentDescriptor[]
}

export interface SnippetMatchResult {
  matched: boolean
  snippet?: SnippetRecord
  keyword?: string
  backspaceCount?: number
  expanded?: string
  cursorOffset?: number
  requiresArguments?: boolean
  arguments?: SnippetArgumentDescriptor[]
  targetWindowId?: string
  targetWindowMode?: 'launcher' | 'main'
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
 * 解析 Raycast 标准 {argument name="..." default="..." options="..." type="..."} 占位符定义
 * 同名参数自动去重合并
 */
export function parseSnippetArguments(template: string): SnippetArgumentDescriptor[] {
  if (!template || typeof template !== 'string') return []

  const results: SnippetArgumentDescriptor[] = []
  const seenNames = new Map<string, SnippetArgumentDescriptor>()
  const pattern = /\{argument(?:\s+([^}]*))?\}/gi

  let match: RegExpExecArray | null
  let fallbackIndex = 1

  while ((match = pattern.exec(template)) !== null) {
    const attrStr = (match[1] || '').trim()
    const attrs: Record<string, string> = {}

    const attrRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+))/g
    let attrMatch: RegExpExecArray | null
    while ((attrMatch = attrRegex.exec(attrStr)) !== null) {
      const k = (attrMatch[1] || '').toLowerCase()
      const v = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? ''
      attrs[k] = v
    }

    const name = (attrs.name || `Argument ${fallbackIndex++}`).trim()
    const defaultValue = attrs.default ?? ''
    const rawOptions = attrs.options
      ? attrs.options
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : []

    let type: 'text' | 'password' | 'dropdown' = 'text'
    if (rawOptions.length > 0 || attrs.type === 'dropdown') {
      type = 'dropdown'
    } else if (attrs.type === 'password' || /password|secret|token|key|密码|密钥/i.test(name)) {
      type = 'password'
    }

    const required = attrs.optional !== 'true' && attrs.required !== 'false'

    if (!seenNames.has(name)) {
      const desc: SnippetArgumentDescriptor = {
        name,
        type,
        defaultValue: defaultValue || (rawOptions[0] ?? ''),
        options: rawOptions,
        required
      }
      seenNames.set(name, desc)
      results.push(desc)
    } else {
      const existing = seenNames.get(name)!
      if (!existing.defaultValue && defaultValue) {
        existing.defaultValue = defaultValue
      }
      if (existing.options.length === 0 && rawOptions.length > 0) {
        existing.options = rawOptions
        existing.type = 'dropdown'
      }
    }
  }

  return results
}

export function hasSnippetArguments(template: string): boolean {
  return parseSnippetArguments(template).length > 0
}

/**
 * 宏展开解析器 (支持 {clipboard}, {date}, {time}, {datetime}, {year}, {month}, {day}, {uuid}, {cursor}, {argument ...})
 */
export function expandSnippetMacros(template: string, context: MacroContext = {}): MacroExpandResult {
  if (!template || typeof template !== 'string') {
    return { expanded: '', cursorOffset: 0, hasCursor: false, arguments: [] }
  }

  const parsedArgs = parseSnippetArguments(template)
  const argDefaults = new Map<string, string>()
  for (const a of parsedArgs) {
    argDefaults.set(a.name, a.defaultValue)
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

  let fallbackIdx = 1
  let text = template
    .replace(/\{clipboard\}/gi, clipboardText)
    .replace(/\{date\}/gi, dateStr)
    .replace(/\{time\}/gi, timeStr)
    .replace(/\{datetime\}/gi, datetimeStr)
    .replace(/\{year\}/gi, year)
    .replace(/\{month\}/gi, month)
    .replace(/\{day\}/gi, day)
    .replace(/\{argument(?:\s+([^}]*))?\}/gi, (_full, attrStr = '') => {
      const attrs: Record<string, string> = {}
      const attrRegex = /([a-zA-Z0-9_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+))/g
      let m: RegExpExecArray | null
      while ((m = attrRegex.exec(String(attrStr))) !== null) {
        const k = (m[1] || '').toLowerCase()
        const v = m[2] ?? m[3] ?? m[4] ?? ''
        attrs[k] = v
      }
      const name = (attrs.name || `Argument ${fallbackIdx++}`).trim()
      const provided = context.args?.[name]
      if (provided !== undefined && provided !== '') {
        return String(provided)
      }
      const def = attrs.default ?? argDefaults.get(name) ?? ''
      if (def !== '') return def
      return context.previewPlaceholders ? `[${name}]` : ''
    })

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
      hasCursor: true,
      arguments: parsedArgs
    }
  }

  return {
    expanded: text,
    cursorOffset: 0,
    hasCursor: false,
    arguments: parsedArgs
  }
}

/**
 * 快捷短语与宏展开服务 (Snippets Service)
 */
export class SnippetsService {
  private db: DatabaseSync | null = null
  private dbPath: string
  private onSnippetsChanged?: ((snippets: SnippetRecord[]) => void) | undefined
  private lastExternalWindowId = 'external-editor-window'

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
   * 记录触发短语前的外部活动窗口句柄（过滤 ZTools 自身窗口，确保参数表单填完后回贴到原外部编辑器）
   */
  public recordExternalWindow(windowId: string): string {
    const cleaned = String(windowId || '').trim()
    if (
      cleaned &&
      cleaned.toLowerCase() !== 'ztools' &&
      !cleaned.toLowerCase().startsWith('ztools-')
    ) {
      this.lastExternalWindowId = cleaned
    }
    return this.lastExternalWindowId
  }

  public getLastExternalWindow(): string {
    return this.lastExternalWindowId
  }

  /**
   * 触发词后缀匹配与宏展开 (用于键盘钩子或输入流监听)
   * 若短语包含 {argument ...} 动态参数且未传入 args，则标记 requiresArguments: true 并指定由轻量 LauncherWindow 承载弹窗
   */
  public matchAndExpand(
    typedText: string,
    clipboardContent?: string,
    options: { args?: Record<string, string>; activeWindowId?: string } = {}
  ): SnippetMatchResult {
    if (!typedText || typeof typedText !== 'string') {
      return { matched: false }
    }

    if (options.activeWindowId) {
      this.recordExternalWindow(options.activeWindowId)
    }

    const enabledSnippets = this.getEnabledSnippets()
    for (const snip of enabledSnippets) {
      if (typedText.endsWith(snip.keyword)) {
        const parsedArgs = parseSnippetArguments(snip.snippet)
        const hasUnfilledArgs =
          parsedArgs.length > 0 &&
          (!options.args ||
            parsedArgs.some(
              (a) => a.required && (options.args?.[a.name] === undefined || options.args?.[a.name] === '')
            ))

        const { expanded, cursorOffset } = expandSnippetMacros(snip.snippet, {
          clipboard: clipboardContent,
          now: new Date(),
          args: options.args,
          previewPlaceholders: hasUnfilledArgs
        })

        return {
          matched: true,
          snippet: snip,
          keyword: snip.keyword,
          backspaceCount: snip.keyword.length,
          expanded,
          cursorOffset,
          requiresArguments: hasUnfilledArgs,
          arguments: parsedArgs,
          targetWindowId: this.lastExternalWindowId,
          targetWindowMode: 'launcher'
        }
      }
    }

    return { matched: false }
  }

  /**
   * 完成动态参数表单填写并生成回填结果
   */
  public completeArgumentExpansion(
    snippetIdOrTemplate: string,
    args: Record<string, string>,
    context: { clipboard?: string; now?: Date; targetWindowId?: string } = {}
  ): MacroExpandResult & { targetWindowId: string } {
    let template = snippetIdOrTemplate
    if (this.db) {
      const row = this.db
        .prepare('SELECT snippet FROM snippets WHERE id = ? OR keyword = ?')
        .get(snippetIdOrTemplate, snippetIdOrTemplate) as { snippet: string } | undefined
      if (row && typeof row.snippet === 'string') {
        template = row.snippet
      }
    }

    if (context.targetWindowId) {
      this.recordExternalWindow(context.targetWindowId)
    }

    const res = expandSnippetMacros(template, {
      clipboard: context.clipboard,
      now: context.now || new Date(),
      args
    })

    return {
      ...res,
      targetWindowId: this.lastExternalWindowId
    }
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
