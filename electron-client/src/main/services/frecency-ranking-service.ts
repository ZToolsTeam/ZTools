import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * Frecency 权重配置
 * - 1 小时内：权重 100
 * - 24 小时内：权重 70
 * - 7 天内：权重 30
 * - 30 天内：权重 10
 * - 30 天以上：权重 1
 */
export const FRECENCY_WEIGHTS = {
  ONE_HOUR: 100,
  ONE_DAY: 70,
  ONE_WEEK: 30,
  ONE_MONTH: 10,
  OLDER: 1
} as const

export const ONE_HOUR_MS = 60 * 60 * 1000
export const ONE_DAY_MS = 24 * ONE_HOUR_MS
export const ONE_WEEK_MS = 7 * ONE_DAY_MS
export const ONE_MONTH_MS = 30 * ONE_DAY_MS

export const DEFAULT_MAX_ITEMS = 500
export const MAX_RECENT_TIMESTAMPS = 50

export interface FrecencyItemData {
  commandId: string
  alias?: string | undefined
  totalCount: number
  lastUsedAt: number
  recentTimestamps: number[]
}

export interface FrecencyStorageDocument {
  version: 1
  entries: Record<string, FrecencyItemData>
}

export interface FrecencyServiceOptions {
  storageFilePath?: string | undefined
  maxItems?: number | undefined
  debounceMs?: number | undefined
  nowProvider?: (() => number) | undefined
}

export interface RankItemOptions<T> {
  getId: (item: T) => string
  getAlias?: (item: T) => string | undefined
  getTitle?: (item: T) => string | undefined
  getSubtitle?: (item: T) => string | undefined
  getKeywords?: (item: T) => string[] | undefined
  now?: number
}

/**
 * 计算单次调用基于时间衰减的权重分
 */
export function calculateUsageWeight(timestamp: number, now: number): number {
  if (!Number.isFinite(timestamp)) return 0
  // 时间戳回拨保护：如果时间戳在未来，clamp 为当前时间
  const age = Math.max(0, now - timestamp)

  if (age <= ONE_HOUR_MS) return FRECENCY_WEIGHTS.ONE_HOUR
  if (age <= ONE_DAY_MS) return FRECENCY_WEIGHTS.ONE_DAY
  if (age <= ONE_WEEK_MS) return FRECENCY_WEIGHTS.ONE_WEEK
  if (age <= ONE_MONTH_MS) return FRECENCY_WEIGHTS.ONE_MONTH
  return FRECENCY_WEIGHTS.OLDER
}

/**
 * 计算条目的 Frecency 复合得分
 */
export function calculateFrecencyScore(
  item: Readonly<FrecencyItemData>,
  now: number = Date.now()
): number {
  if (!item || item.totalCount <= 0) return 0

  let score = 0
  const timestamps = item.recentTimestamps || []

  // 累加最近时间戳滑动窗口得分
  for (const ts of timestamps) {
    score += calculateUsageWeight(ts, now)
  }

  // 如果调用次数多于窗口记录数，历史超额调用提供微弱基础支撑（防止完全被忽视）
  if (item.totalCount > timestamps.length) {
    const olderCount = Math.min(item.totalCount - timestamps.length, 1000)
    score += olderCount * FRECENCY_WEIGHTS.OLDER
  }

  return score
}

export class FrecencyRankingService {
  readonly #entries = new Map<string, FrecencyItemData>()
  readonly #shortcuts = new Map<string, string>() // commandId -> accelerator
  readonly #shortcutHandlers = new Map<string, () => void>()
  readonly #storageFilePath?: string | undefined
  readonly #maxItems: number
  readonly #debounceMs: number
  readonly #nowProvider: () => number

  #dirty = false
  #saveTimer: NodeJS.Timeout | null = null
  #savingPromise: Promise<void> | null = null

  constructor(options: FrecencyServiceOptions = {}) {
    this.#storageFilePath = options.storageFilePath
    this.#maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS
    this.#debounceMs = options.debounceMs ?? 500
    this.#nowProvider = options.nowProvider ?? (() => Date.now())
  }

  get size(): number {
    return this.#entries.size
  }

  getEntry(commandId: string): Readonly<FrecencyItemData> | undefined {
    if (!commandId || typeof commandId !== 'string') return undefined
    return this.#entries.get(commandId.toLowerCase())
  }

  getScore(commandId: string, now?: number): number {
    const entry = this.getEntry(commandId)
    if (!entry) return 0
    return calculateFrecencyScore(entry, now ?? this.#nowProvider())
  }

  /**
   * 记录命令调用
   */
  recordUsage(commandId: string, timestamp?: number): boolean {
    if (!commandId || typeof commandId !== 'string') return false
    const trimmedId = commandId.trim()
    if (!trimmedId) return false

    const now = this.#nowProvider()
    let effectiveTs = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : now

    // 时间戳回拨保护：如果给入的时间戳大于当前时间，clamp 为当前时间
    if (effectiveTs > now) {
      effectiveTs = now
    }

    const key = trimmedId.toLowerCase()
    let entry = this.#entries.get(key)

    if (!entry) {
      entry = {
        commandId: trimmedId,
        totalCount: 1,
        lastUsedAt: effectiveTs,
        recentTimestamps: [effectiveTs]
      }
      this.#entries.set(key, entry)
    } else {
      // 防十万次调用数值溢出
      entry.totalCount = Math.min(Number.MAX_SAFE_INTEGER, entry.totalCount + 1)
      entry.lastUsedAt = Math.max(entry.lastUsedAt, effectiveTs)

      // 滑动窗口保留最新时间戳
      entry.recentTimestamps.push(effectiveTs)
      if (entry.recentTimestamps.length > MAX_RECENT_TIMESTAMPS) {
        entry.recentTimestamps.splice(0, entry.recentTimestamps.length - MAX_RECENT_TIMESTAMPS)
      }
    }

    // 脏数据修剪：当条目超出上限时淘汰最冷门项
    if (this.#entries.size > this.#maxItems) {
      this.#pruneColdEntries(now)
    }

    this.#markDirty()
    return true
  }

  /**
   * 设置短别名（Alias）
   */
  setAlias(commandId: string, alias?: string): boolean {
    if (!commandId || typeof commandId !== 'string') return false
    const key = commandId.trim().toLowerCase()
    let entry = this.#entries.get(key)

    const normalizedAlias = alias && typeof alias === 'string' ? alias.trim().toLowerCase() : undefined

    if (!entry) {
      if (!normalizedAlias) return true
      entry = {
        commandId: commandId.trim(),
        alias: normalizedAlias,
        totalCount: 0,
        lastUsedAt: 0,
        recentTimestamps: []
      }
      this.#entries.set(key, entry)
    } else {
      if (normalizedAlias) {
        entry.alias = normalizedAlias
      } else {
        delete entry.alias
      }
    }

    this.#markDirty()
    return true
  }

  getAlias(commandId: string): string | undefined {
    return this.getEntry(commandId)?.alias
  }

  /**
   * 注册独立全局快捷键映射
   */
  registerShortcut(commandId: string, accelerator: string, handler?: () => void): boolean {
    if (!commandId || !accelerator) return false
    const key = commandId.trim().toLowerCase()
    this.#shortcuts.set(key, accelerator.trim())
    if (handler) {
      this.#shortcutHandlers.set(key, handler)
    }
    return true
  }

  unregisterShortcut(commandId: string): void {
    if (!commandId) return
    const key = commandId.trim().toLowerCase()
    this.#shortcuts.delete(key)
    this.#shortcutHandlers.delete(key)
  }

  getShortcut(commandId: string): string | undefined {
    return this.#shortcuts.get(commandId.trim().toLowerCase())
  }

  listShortcuts(): Map<string, string> {
    return new Map(this.#shortcuts)
  }

  dispatchShortcut(accelerator: string): boolean {
    const normalized = accelerator.replace(/\s+/g, '').toLowerCase()
    for (const [commandId, acc] of this.#shortcuts.entries()) {
      if (acc.replace(/\s+/g, '').toLowerCase() === normalized) {
        this.recordUsage(commandId)
        const handler = this.#shortcutHandlers.get(commandId)
        if (handler) {
          handler()
          return true
        }
      }
    }
    return false
  }

  /**
   * 核心排序函数：自适应 Frecency 复合排序与短别名置顶
   */
  rankItems<T>(
    items: T[],
    optionsOrGetId: ((item: T) => string) | RankItemOptions<T>,
    query?: string
  ): T[] {
    if (!Array.isArray(items) || items.length === 0) return []

    const options: RankItemOptions<T> = typeof optionsOrGetId === 'function'
      ? { getId: optionsOrGetId }
      : optionsOrGetId

    const getId = options.getId
    const now = options.now ?? this.#nowProvider()
    const trimmedQuery = (query || '').trim().toLowerCase()

    // 1. 当 query 为空时：按纯 Frecency 分数从高到低排列
    if (!trimmedQuery) {
      return [...items].sort((a, b) => {
        const idA = getId(a)
        const idB = getId(b)
        const scoreA = this.getScore(idA, now)
        const scoreB = this.getScore(idB, now)
        if (scoreB !== scoreA) return scoreB - scoreA

        // 次级依据：最后使用时间
        const lastA = this.getEntry(idA)?.lastUsedAt ?? 0
        const lastB = this.getEntry(idB)?.lastUsedAt ?? 0
        return lastB - lastA
      })
    }

    // 2. 当 query 存在时：结合 Match Score 与 Frecency 进行智能融合排序
    interface ScoredItem {
      item: T
      matchScore: number
      frecencyScore: number
      isExactAlias: boolean
      index: number
    }

    const scoredItems: ScoredItem[] = []

    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      if (item === undefined || item === null) continue

      const id = getId(item)
      const entry = this.getEntry(id)
      const frecencyScore = this.getScore(id, now)

      // 获取短别名（优先以注册/记录的别名，次选 item 携带的别名）
      const rec = typeof item === 'object' ? (item as Record<string, unknown>) : {}
      const rawAlias = typeof rec.alias === 'string' ? rec.alias : undefined
      const itemAlias = options.getAlias?.(item) ?? rawAlias
      const effectiveAlias = (entry?.alias || itemAlias || '').trim().toLowerCase()

      const rawTitle = typeof rec.name === 'string' ? rec.name : typeof rec.title === 'string' ? rec.title : undefined
      const rawSubtitle = typeof rec.description === 'string' ? rec.description : typeof rec.subtitle === 'string' ? rec.subtitle : undefined
      const rawKeywords = Array.isArray(rec.keywords) ? (rec.keywords as string[]) : []
      const title = (options.getTitle?.(item) ?? rawTitle ?? id).toString().toLowerCase()
      const subtitle = (options.getSubtitle?.(item) ?? rawSubtitle ?? '').toString().toLowerCase()
      const keywords = (options.getKeywords?.(item) ?? rawKeywords) as string[]

      let matchScore = 0
      let isExactAlias = false

      // (1) 短别名精确命中：拥有绝对最高置顶优先级（置满 1,000,000 分）
      if (effectiveAlias && effectiveAlias === trimmedQuery) {
        isExactAlias = true
        matchScore = 1_000_000
      } else if (title === trimmedQuery) {
        // (2) 标题完全匹配
        matchScore = 100_000
      } else if (title.startsWith(trimmedQuery)) {
        // (3) 标题前缀匹配
        matchScore = 50_000 + (100 - Math.min(title.length, 100))
      } else if (title.includes(trimmedQuery)) {
        // (4) 标题包含匹配
        matchScore = 20_000
      } else if (effectiveAlias && effectiveAlias.startsWith(trimmedQuery)) {
        // (5) 别名前缀匹配
        matchScore = 15_000
      } else if (subtitle.includes(trimmedQuery)) {
        // (6) 副标题包含匹配
        matchScore = 5_000
      } else if (keywords.some((kw) => typeof kw === 'string' && kw.toLowerCase().includes(trimmedQuery))) {
        // (7) 关键字匹配
        matchScore = 3_000
      } else {
        // 未匹配，不纳入结果
        matchScore = 0
      }

      if (matchScore > 0) {
        scoredItems.push({
          item,
          matchScore,
          frecencyScore,
          isExactAlias,
          index
        })
      }
    }

    // 排序逻辑：
    // 1. 精确别名命中绝对排第一；
    // 2. 在 Match Score 相同或处于相近层级时，Frecency 分数高的项绝对优先置顶；
    // 3. 次级平局时按原出现次序稳定排序。
    scoredItems.sort((a, b) => {
      // 别名绝对置顶
      if (a.isExactAlias !== b.isExactAlias) {
        return a.isExactAlias ? -1 : 1
      }

      // 如果匹配分数差距很大（不同匹配层级，如全等 vs 包含），以匹配层级为主
      // 但在同层级（例如都是标题包含，或都是前缀匹配），Frecency 起决定性作用
      const matchDiff = b.matchScore - a.matchScore
      if (Math.abs(matchDiff) >= 10_000) {
        return matchDiff
      }

      // 在相似匹配度下，比较 Frecency 得分
      if (b.frecencyScore !== a.frecencyScore) {
        return b.frecencyScore - a.frecencyScore
      }

      // 如果 Frecency 也相同，比较原始匹配细分
      if (matchDiff !== 0) return matchDiff

      // 稳定次序
      return a.index - b.index
    })

    return scoredItems.map((entry) => entry.item)
  }

  /**
   * 淘汰最冷门项（LRU/LFU 混合淘汰）
   */
  #pruneColdEntries(now: number): void {
    const list: Array<{ key: string; score: number; lastUsed: number }> = []

    for (const [key, entry] of this.#entries.entries()) {
      list.push({
        key,
        score: calculateFrecencyScore(entry, now),
        lastUsed: entry.lastUsedAt
      })
    }

    // 按得分从高到低排序，得分相同按最后使用时间从新到旧
    list.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.lastUsed - a.lastUsed
    })

    // 保留前 maxItems 个，移除多余的冷门项
    if (list.length > this.#maxItems) {
      const toRemove = list.slice(this.#maxItems)
      for (const item of toRemove) {
        this.#entries.delete(item.key)
      }
    }
  }

  #markDirty(): void {
    this.#dirty = true
    if (!this.#storageFilePath) return

    if (!this.#saveTimer) {
      this.#saveTimer = setTimeout(() => {
        this.#saveTimer = null
        void this.flush().catch((err) => {
          console.warn('[FrecencyRankingService] 防抖写盘失败:', err)
        })
      }, this.#debounceMs)
    }
  }

  /**
   * 立即持久化当前 Frecency 数据
   */
  async flush(): Promise<void> {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer)
      this.#saveTimer = null
    }

    const storagePath = this.#storageFilePath
    if (!this.#dirty || !storagePath) return

    if (this.#savingPromise) {
      return this.#savingPromise
    }

    this.#savingPromise = (async () => {
      try {
        const doc: FrecencyStorageDocument = {
          version: 1,
          entries: Object.fromEntries(this.#entries)
        }
        const dir = path.dirname(storagePath)
        await fs.mkdir(dir, { recursive: true })
        const tmp = `${storagePath}.${process.pid}.${Date.now()}.tmp`
        await fs.writeFile(tmp, JSON.stringify(doc, null, 2), 'utf8')
        await fs.rename(tmp, storagePath)
        this.#dirty = false
      } finally {
        this.#savingPromise = null
      }
    })()

    return this.#savingPromise
  }

  /**
   * 从文件加载历史数据
   */
  async load(): Promise<void> {
    const storagePath = this.#storageFilePath
    if (!storagePath) return
    try {
      const content = await fs.readFile(storagePath, 'utf8')
      const doc = JSON.parse(content) as FrecencyStorageDocument
      if (doc && doc.version === 1 && typeof doc.entries === 'object' && doc.entries !== null) {
        this.#entries.clear()
        for (const [key, value] of Object.entries(doc.entries)) {
          if (value && typeof value.commandId === 'string' && Number.isFinite(value.totalCount)) {
            this.#entries.set(key.toLowerCase(), {
              commandId: value.commandId,
              alias: typeof value.alias === 'string' ? value.alias : undefined,
              totalCount: value.totalCount,
              lastUsedAt: Number.isFinite(value.lastUsedAt) ? value.lastUsedAt : 0,
              recentTimestamps: Array.isArray(value.recentTimestamps)
                ? value.recentTimestamps.filter((t) => Number.isFinite(t))
                : []
            })
          }
        }
      }
    } catch (err) {
      // 文件不存在或已损坏时安全重置为空状态并记录告警
      console.warn('[FrecencyRankingService] Failed to load frecency storage:', err)
    }
  }

  clear(): void {
    if (this.#saveTimer) {
      clearTimeout(this.#saveTimer)
      this.#saveTimer = null
    }
    this.#entries.clear()
    this.#shortcuts.clear()
    this.#shortcutHandlers.clear()
    this.#dirty = true
  }
}
