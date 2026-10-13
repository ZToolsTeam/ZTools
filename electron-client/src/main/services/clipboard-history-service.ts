import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export type ClipboardFormatType = 'text' | 'html' | 'image' | 'files'

export interface ClipboardItemRecord {
  id: string
  content: string
  text_preview: string
  format_type: ClipboardFormatType
  sha256: string
  char_count: number
  source_app_name: string | null
  source_app_path: string | null
  is_pinned: number
  created_at: number
  updated_at: number
}

export interface ClipboardRecordInput {
  content: string
  format_type?: ClipboardFormatType
  source_app_name?: string | null
  source_app_path?: string | null
  text_preview?: string | null
  sensitive_marker?: boolean
  ignore_processing?: boolean
}

export interface ClipboardQueryOptions {
  search?: string
  format?: string
  pinnedOnly?: boolean
  limit?: number
  offset?: number
}

export interface SequentialPasteResult {
  success: boolean
  item: ClipboardItemRecord | null
  sequenceIndex: number
  total: number
  message?: string
}

export interface ClipboardHistoryServiceOptions {
  dbPath?: string
  maxTextBytes?: number
  maxPreviewChars?: number
  sequenceTimeoutMs?: number
  retentionMaxItems?: number
  appBlacklist?: string[]
}

const DEFAULT_APP_BLACKLIST = [
  '1password',
  'bitwarden',
  'keepass',
  'keepassxc',
  'lastpass',
  'enpass',
  'dashlane',
  'nordpass',
  'roboform',
  'authy',
  'authenticator',
  'totp'
]

/**
 * Windows 原生敏感剪贴板保护标记 (对齐 Raycast §7.1 逆向事实)
 */
export const SENSITIVE_CLIPBOARD_FORMATS = [
  'Clipboard Viewer Ignore',
  'CanIncludeInClipboardHistory',
  'ExcludeClipboardContentFromMonitorProcessing'
]

/**
 * 计算字符串的香农信息熵 (Shannon Entropy)
 * 用于高熵密码、API Key、Token 脱敏识别
 */
export function calculateShannonEntropy(str: string): number {
  if (!str || str.length === 0) return 0
  const frequencies = new Map<string, number>()
  for (const char of str) {
    frequencies.set(char, (frequencies.get(char) || 0) + 1)
  }
  let entropy = 0
  const len = str.length
  for (const count of frequencies.values()) {
    const p = count / len
    entropy -= p * Math.log2(p)
  }
  return entropy
}

/**
 * 判断是否为高熵机密/密码
 */
export function isHighEntropyPassword(text: string): boolean {
  if (!text || typeof text !== 'string') return false
  const trimmed = text.trim()
  // 长度在 12 到 128 之间，且不包含空白字符
  if (trimmed.length < 12 || trimmed.length > 128 || /\s/.test(trimmed)) {
    return false
  }
  // 检查字符多样性（至少包含大小写字母、数字或符号中的 3 种）
  let varieties = 0
  if (/[a-z]/.test(trimmed)) varieties++
  if (/[A-Z]/.test(trimmed)) varieties++
  if (/[0-9]/.test(trimmed)) varieties++
  if (/[^a-zA-Z0-9]/.test(trimmed)) varieties++
  if (varieties < 3) return false

  const entropy = calculateShannonEntropy(trimmed)
  // 香农熵超过 3.6 认定为随机高熵凭据
  return entropy >= 3.6
}

/**
 * 剪贴板历史核心服务 (SQLite WAL 驱动，对齐 Raycast REA 规范)
 */
export class ClipboardHistoryService {
  private db: DatabaseSync | null = null
  private dbPath: string
  private readonly maxTextBytes: number
  private readonly maxPreviewChars: number
  private readonly sequenceTimeoutMs: number
  private readonly retentionMaxItems: number
  private readonly appBlacklist: Set<string>

  // 流水粘贴状态机
  private sequencePointer = 0
  private lastPasteTimestamp = 0

  constructor(options: ClipboardHistoryServiceOptions = {}) {
    this.dbPath = options.dbPath || ':memory:'
    this.maxTextBytes = options.maxTextBytes ?? 5 * 1024 * 1024 // 5MB
    this.maxPreviewChars = options.maxPreviewChars ?? 300
    this.sequenceTimeoutMs = options.sequenceTimeoutMs ?? 60_000 // 60s
    this.retentionMaxItems = options.retentionMaxItems ?? 1000

    this.appBlacklist = new Set(
      (options.appBlacklist || DEFAULT_APP_BLACKLIST).map((name) => name.toLowerCase())
    )

    this.initDatabase()
  }

  private initDatabase(): void {
    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }

    try {
      this.db = new DatabaseSync(this.dbPath)
    } catch (err: any) {
      if (this.dbPath !== ':memory:') {
        console.warn(`[ClipboardHistoryService] SQLite 数据库初始化异常 (${err.message})，清理残留 WAL 并自动恢复...`)
        try {
          fs.rmSync(`${this.dbPath}-shm`, { force: true })
          fs.rmSync(`${this.dbPath}-wal`, { force: true })
        } catch {}
        try {
          this.db = new DatabaseSync(this.dbPath)
        } catch {
          try {
            fs.renameSync(this.dbPath, `${this.dbPath}.corrupt.${Date.now()}`)
          } catch {}
          this.db = new DatabaseSync(this.dbPath)
        }
      } else {
        throw err
      }
    }

    // 启用 WAL 模式与正常同步级别
    try {
      this.db.exec('PRAGMA journal_mode = WAL;')
      this.db.exec('PRAGMA synchronous = NORMAL;')
    } catch {
      // Memory db may not support WAL
    }

    // 创表与索引
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS clipboard_items (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        text_preview TEXT,
        format_type TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        char_count INTEGER NOT NULL,
        source_app_name TEXT,
        source_app_path TEXT,
        is_pinned INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_clipboard_created ON clipboard_items(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_clipboard_sha256 ON clipboard_items(sha256);
      CREATE INDEX IF NOT EXISTS idx_clipboard_pinned ON clipboard_items(is_pinned DESC, updated_at DESC);
    `)
  }

  /**
   * 记录新的剪贴板条目（含黑名单过滤、大图/长文本截断、高熵脱敏与 SHA-256 去重）
   */
  public recordItem(input: ClipboardRecordInput, now = Date.now()): ClipboardItemRecord | null {
    if (!this.db) throw new Error('Database is closed')
    if (!input || typeof input.content !== 'string' || input.content.length === 0) {
      return null
    }

    // 0. 敏感格式保护标记拦截 (Windows Clipboard Viewer Ignore / CanIncludeInClipboardHistory 保护)
    if (input.sensitive_marker || input.ignore_processing) {
      return null
    }

    // 1. 密码管理器黑名单拦截
    if (input.source_app_name) {
      const normalizedApp = input.source_app_name.toLowerCase().trim()
      for (const blocked of this.appBlacklist) {
        if (normalizedApp.includes(blocked)) {
          // 静默抛弃来自密码管理器的复制事件
          return null
        }
      }
    }

    let content = input.content
    let charCount = content.length

    // 2. 长文本截断保护（防止恶意写入百兆长文本打爆内存）
    if (content.length > this.maxTextBytes) {
      content = content.slice(0, this.maxTextBytes) + `\n... [已自动截断，原长 ${charCount} 字符]`
      charCount = content.length
    }

    const sha256 = createHash('sha256').update(content).digest('hex')
    const formatType: ClipboardFormatType = input.format_type || 'text'

    // 3. 高熵密码与机密识别脱敏
    let preview = input.text_preview || content.slice(0, this.maxPreviewChars)
    if (isHighEntropyPassword(content)) {
      preview = '•••••••••••••••• [高熵敏感机密已脱敏]'
    } else if (preview.length > this.maxPreviewChars) {
      preview = preview.slice(0, this.maxPreviewChars) + '...'
    }

    // 4. SHA-256 去重：若已存在相同哈希，仅更新时间戳并移至顶端
    const existingStmt = this.db.prepare('SELECT * FROM clipboard_items WHERE sha256 = ?')
    const existing = existingStmt.get(sha256) as ClipboardItemRecord | undefined

    if (existing) {
      const updateStmt = this.db.prepare(`
        UPDATE clipboard_items
        SET updated_at = ?, source_app_name = COALESCE(?, source_app_name), source_app_path = COALESCE(?, source_app_path)
        WHERE id = ?
      `)
      updateStmt.run(now, input.source_app_name ?? null, input.source_app_path ?? null, existing.id)

      return {
        ...existing,
        updated_at: now,
        source_app_name: input.source_app_name ?? existing.source_app_name,
        source_app_path: input.source_app_path ?? existing.source_app_path
      }
    }

    // 5. 插入全新条目
    const id = randomUUID()
    const insertStmt = this.db.prepare(`
      INSERT INTO clipboard_items (
        id, content, text_preview, format_type, sha256,
        char_count, source_app_name, source_app_path, is_pinned,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `)

    insertStmt.run(
      id,
      content,
      preview,
      formatType,
      sha256,
      charCount,
      input.source_app_name ?? null,
      input.source_app_path ?? null,
      now,
      now
    )

    this.enforceRetentionLimit()

    return {
      id,
      content,
      text_preview: preview,
      format_type: formatType,
      sha256,
      char_count: charCount,
      source_app_name: input.source_app_name ?? null,
      source_app_path: input.source_app_path ?? null,
      is_pinned: 0,
      created_at: now,
      updated_at: now
    }
  }

  /**
   * 查询剪贴板历史
   */
  public queryItems(options: ClipboardQueryOptions = {}): ClipboardItemRecord[] {
    if (!this.db) throw new Error('Database is closed')

    const conditions: string[] = []
    const params: (string | number)[] = []

    if (options.pinnedOnly) {
      conditions.push('is_pinned = 1')
    }

    if (options.format && options.format !== 'all') {
      conditions.push('format_type = ?')
      params.push(options.format)
    }

    if (options.search && options.search.trim()) {
      const q = `%${options.search.trim()}%`
      conditions.push('(text_preview LIKE ? OR content LIKE ? OR source_app_name LIKE ?)')
      params.push(q, q, q)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
    const offset = Math.max(0, options.offset ?? 0)

    const sql = `
      SELECT * FROM clipboard_items
      ${whereClause}
      ORDER BY is_pinned DESC, updated_at DESC
      LIMIT ? OFFSET ?
    `
    params.push(limit, offset)

    const stmt = this.db.prepare(sql)
    return stmt.all(...params) as unknown as ClipboardItemRecord[]
  }

  /**
   * 置顶/取消置顶
   */
  public togglePin(id: string): boolean {
    if (!this.db) throw new Error('Database is closed')
    if (!id || typeof id !== 'string') return false

    const itemStmt = this.db.prepare('SELECT is_pinned FROM clipboard_items WHERE id = ?')
    const item = itemStmt.get(id) as { is_pinned: number } | undefined
    if (!item) return false

    const newPinned = item.is_pinned === 1 ? 0 : 1
    const updateStmt = this.db.prepare('UPDATE clipboard_items SET is_pinned = ? WHERE id = ?')
    updateStmt.run(newPinned, id)
    return true
  }

  /**
   * 删除指定条目
   */
  public deleteItem(id: string): boolean {
    if (!this.db) throw new Error('Database is closed')
    if (!id || typeof id !== 'string') return false

    const stmt = this.db.prepare('DELETE FROM clipboard_items WHERE id = ?')
    const res = stmt.run(id)
    return res.changes > 0
  }

  /**
   * 清空未置顶的全部历史记录
   */
  public clearUnpinned(): number {
    if (!this.db) throw new Error('Database is closed')
    const stmt = this.db.prepare('DELETE FROM clipboard_items WHERE is_pinned = 0')
    const res = stmt.run()
    return Number(res.changes)
  }

  /**
   * 流水粘贴 (Paste Sequentially)
   * 依次取出历史条目回贴，每次指针自动下移；若超过 sequenceTimeout 则自动从头开始
   */
  public pasteSequential(
    pasteCallback?: (text: string) => Promise<void> | void,
    now = Date.now()
  ): SequentialPasteResult {
    if (!this.db) throw new Error('Database is closed')

    // 检查超时重置
    if (this.lastPasteTimestamp > 0 && now - this.lastPasteTimestamp > this.sequenceTimeoutMs) {
      this.sequencePointer = 0
    }

    const allItems = this.queryItems({ limit: 200 })
    if (allItems.length === 0) {
      return {
        success: false,
        item: null,
        sequenceIndex: 0,
        total: 0,
        message: '剪贴板历史为空'
      }
    }

    // 若指针超界则循环回 0
    if (this.sequencePointer >= allItems.length) {
      this.sequencePointer = 0
    }

    const currentItem = allItems[this.sequencePointer]
    if (!currentItem) {
      return {
        success: false,
        item: null,
        sequenceIndex: -1,
        total: allItems.length,
        message: '未找到指定条目'
      }
    }
    const currentIndex = this.sequencePointer

    // 指针后移并更新时间戳
    this.sequencePointer = (this.sequencePointer + 1) % allItems.length
    this.lastPasteTimestamp = now

    if (pasteCallback && currentItem.content) {
      try {
        void pasteCallback(currentItem.content)
      } catch (err) {
        console.warn('[ClipboardHistoryService] Sequential paste callback error:', err)
      }
    }

    return {
      success: true,
      item: currentItem,
      sequenceIndex: currentIndex,
      total: allItems.length
    }
  }

  /**
   * 重置流水粘贴指针
   */
  public resetPasteSequence(): { success: boolean; sequenceIndex: number } {
    this.sequencePointer = 0
    this.lastPasteTimestamp = 0
    return {
      success: true,
      sequenceIndex: 0
    }
  }

  /**
   * 获取当前流水粘贴状态
   */
  public getSequentialStatus(now = Date.now()) {
    const isExpired = this.lastPasteTimestamp > 0 && now - this.lastPasteTimestamp > this.sequenceTimeoutMs
    return {
      sequencePointer: isExpired ? 0 : this.sequencePointer,
      lastPasteTimestamp: this.lastPasteTimestamp,
      isExpired
    }
  }

  /**
   * 容量上限维护
   */
  private enforceRetentionLimit(): void {
    if (!this.db) return
    const countStmt = this.db.prepare('SELECT COUNT(*) AS total FROM clipboard_items WHERE is_pinned = 0')
    const countRow = countStmt.get() as { total: number } | undefined
    const unpinnedCount = countRow ? Number(countRow.total) : 0

    if (unpinnedCount > this.retentionMaxItems) {
      const deleteExcess = this.db.prepare(`
        DELETE FROM clipboard_items
        WHERE id IN (
          SELECT id FROM clipboard_items
          WHERE is_pinned = 0
          ORDER BY updated_at ASC
          LIMIT ?
        )
      `)
      deleteExcess.run(unpinnedCount - this.retentionMaxItems)
    }
  }

  /**
   * 关闭数据库连接
   */
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

  public close(): void {
    this.stop()
  }
}
