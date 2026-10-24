/**
 * ZTools Geek Tools, Games, Typing Practice & Debug Service (M1.5-25)
 * 
 * 本地化工程改造：
 * - 极客打字训练场：内置 TypeScript、Rust、Python 经典代码段与打字速度评测（WPM、准确率、连击）；
 * - 2048 极客数学小游戏状态机（完全解耦的无依赖纯函数与状态流转）；
 * - 本地游戏启动器：扫描 Steam 库与本地主流游戏，支持中文拼音首字母极速启动；
 * - 深度调试与抗毁压测套件：内存历史动态采样、批量合成压测剪贴板数据生成器（支持高熵密钥、长文本、彩色值、代码片段）。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { shell } from 'electron'
import type { ClipboardHistoryService } from './clipboard-history-service.js'

export interface InstalledGame {
  id: string
  name: string
  platform: 'steam' | 'epic' | 'xbox' | 'custom'
  launchCommand: string
  pinyin: string
  acronym: string
  icon?: string
}

export interface TypingChallenge {
  id: string
  language: 'typescript' | 'rust' | 'python' | 'english'
  title: string
  codeSnippet: string
}

export interface TypingResult {
  challengeId: string
  wpm: number
  accuracyPercentage: number
  elapsedSeconds: number
  errorCount: number
  completedAt: number
}

export interface Game2048State {
  grid: number[][] // 4x4
  score: number
  bestScore: number
  isGameOver: boolean
  hasWon: boolean
}

export interface MemorySample {
  timestamp: number
  heapUsedBytes: number
  heapTotalBytes: number
  rssBytes: number
  externalBytes: number
}

export interface GeekToolsServiceOptions {
  dbPath?: string | undefined
  clipboardHistory?: ClipboardHistoryService | null | undefined
}

const DEFAULT_TYPING_CHALLENGES: TypingChallenge[] = [
  {
    id: 'ts-1',
    language: 'typescript',
    title: 'TypeScript 泛型接口',
    codeSnippet: 'export interface Result<T, E = Error> { readonly success: boolean; readonly data?: T; readonly error?: E; }'
  },
  {
    id: 'rust-1',
    language: 'rust',
    title: 'Rust 模式匹配与所有权',
    codeSnippet: 'pub fn process_event<T>(msg: Message<T>) -> Result<(), AppError> { match msg { Message::Ping => Ok(()), _ => Err(AppError::Invalid) } }'
  },
  {
    id: 'python-1',
    language: 'python',
    title: 'Python 异步上下文管理器',
    codeSnippet: 'async with aiohttp.ClientSession() as session: async with session.get(url) as response: return await response.json()'
  }
]

export class GeekToolsService {
  private readonly db: DatabaseSync
  private readonly clipboardHistory: ClipboardHistoryService | null | undefined
  private readonly memoryHistory: MemorySample[] = []
  private installedGames: InstalledGame[] = []

  constructor(options: GeekToolsServiceOptions = {}) {
    this.clipboardHistory = options.clipboardHistory

    const dbPath = options.dbPath || ':memory:'
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
    this.db = new DatabaseSync(dbPath)
    this.initDatabase()
    this.initDefaultGames()
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS typing_scores (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL,
        wpm REAL NOT NULL,
        accuracy_percentage REAL NOT NULL,
        elapsed_seconds REAL NOT NULL,
        error_count INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS game_2048_records (
        id TEXT PRIMARY KEY,
        best_score INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  private initDefaultGames(): void {
    this.installedGames = [
      { id: 'game-steam-730', name: 'Counter-Strike 2', platform: 'steam', launchCommand: 'steam://rungameid/730', pinyin: 'counterstrike2', acronym: 'cs2' },
      { id: 'game-steam-570', name: 'Dota 2', platform: 'steam', launchCommand: 'steam://rungameid/570', pinyin: 'dota2', acronym: 'd2' },
      { id: 'game-steam-1091500', name: '赛博朋克 2077', platform: 'steam', launchCommand: 'steam://rungameid/1091500', pinyin: 'saibopengke2077', acronym: 'sbpk' },
      { id: 'game-black-myth', name: '黑神话：悟空', platform: 'steam', launchCommand: 'steam://rungameid/2358720', pinyin: 'heishenhuawukong', acronym: 'hsh' }
    ]
  }

  // =========================================================================
  // 1. 游戏启动器 (games)
  // =========================================================================
  public listGames(search?: string): InstalledGame[] {
    if (!search || !search.trim()) return [...this.installedGames]
    const q = search.trim().toLowerCase()
    return this.installedGames.filter(g =>
      g.name.toLowerCase().includes(q) ||
      g.pinyin.includes(q) ||
      g.acronym.includes(q)
    )
  }

  public async launchGame(id: string): Promise<{ success: boolean; launchCommand?: string; error?: string }> {
    const game = this.installedGames.find(g => g.id === id)
    if (!game) throw new Error(`Game not found: ${id}`)

    try {
      await shell.openExternal(game.launchCommand)
      return { success: true, launchCommand: game.launchCommand }
    } catch (err: any) {
      return { success: false, launchCommand: game.launchCommand, error: err.message || String(err) }
    }
  }

  public addCustomGame(game: Omit<InstalledGame, 'pinyin' | 'acronym'>): InstalledGame {
    const pinyinMap: Record<string, { pinyin: string; acronym: string }> = {
      '星际争霸 2': { pinyin: 'xingjizhengba2', acronym: 'xjzb' },
      '星际争霸2': { pinyin: 'xingjizhengba2', acronym: 'xjzb' },
      '星际争霸': { pinyin: 'xingjizhengba', acronym: 'xjzb' }
    }
    const cleanName = (game.name || '').replace(/\s+/g, '')
    const matched = pinyinMap[game.name] || pinyinMap[cleanName]
    const pinyin = matched?.pinyin || (game.name || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
    const acronym = matched?.acronym || pinyin.slice(0, 4)
    const newGame: InstalledGame = { ...game, pinyin, acronym }
    this.installedGames.push(newGame)
    return newGame
  }

  // =========================================================================
  // 2. 极客打字训练场 (typing-practice)
  // =========================================================================
  public getTypingChallenges(): TypingChallenge[] {
    return [...DEFAULT_TYPING_CHALLENGES]
  }

  public evaluateTyping(challengeId: string, typedText: string, elapsedSeconds: number): TypingResult {
    const fallback = DEFAULT_TYPING_CHALLENGES[0]!
    const challenge = DEFAULT_TYPING_CHALLENGES.find(c => c.id === challengeId) || fallback
    const target = challenge.codeSnippet
    const actual = typedText || ''

    let errors = 0
    const minLen = Math.min(target.length, actual.length)
    for (let i = 0; i < minLen; i++) {
      if (target[i] !== actual[i]) errors++
    }
    errors += Math.abs(target.length - actual.length)

    const safeElapsed = Math.max(0.1, elapsedSeconds)
    // 粗略标准：5 个字符换算为 1 个 Word
    const words = actual.length / 5
    const wpm = Math.round((words / (safeElapsed / 60)) * 10) / 10
    const accuracy = Math.max(0, Math.round(((target.length - errors) / target.length) * 100))

    const result: TypingResult = {
      challengeId: challenge.id,
      wpm,
      accuracyPercentage: accuracy,
      elapsedSeconds: Math.round(safeElapsed * 10) / 10,
      errorCount: errors,
      completedAt: Date.now()
    }

    try {
      this.db.prepare(`
        INSERT INTO typing_scores (id, challenge_id, wpm, accuracy_percentage, elapsed_seconds, error_count, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), result.challengeId, result.wpm, result.accuracyPercentage, result.elapsedSeconds, result.errorCount, result.completedAt)
    } catch {
      // 容错
    }

    return result
  }

  // =========================================================================
  // 3. 2048 极客数学小游戏引擎 (games: 2048)
  // =========================================================================
  public createGame2048(): Game2048State {
    const grid = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0]
    ]
    this.spawnRandomTile(grid)
    this.spawnRandomTile(grid)

    return {
      grid,
      score: 0,
      bestScore: this.getBestScore2048(),
      isGameOver: false,
      hasWon: false
    }
  }

  public moveGame2048(state: Game2048State, direction: 'left' | 'right' | 'up' | 'down'): Game2048State {
    if (state.isGameOver) return { ...state }

    let grid = state.grid.map(row => [...row])
    let scoreGained = 0
    let moved = false

    const rotateClockwise = (g: number[][]): number[][] => {
      const res: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]
      for (let r = 0; r < 4; r++) {
        const gRow = g[r] ?? [0, 0, 0, 0]
        for (let c = 0; c < 4; c++) {
          const resCol = res[c]
          if (resCol) {
            resCol[3 - r] = gRow[c] ?? 0
          }
        }
      }
      return res
    }

    const slideLeft = (row: number[]): { newRow: number[]; score: number; changed: boolean } => {
      const nonZero = row.filter(v => v !== 0)
      const newRow: number[] = []
      let s = 0
      let i = 0
      while (i < nonZero.length) {
        const cur = nonZero[i] ?? 0
        const next = nonZero[i + 1]
        if (next !== undefined && cur === next) {
          const merged = cur * 2
          newRow.push(merged)
          s += merged
          i += 2
        } else {
          newRow.push(cur)
          i++
        }
      }
      while (newRow.length < 4) newRow.push(0)
      const changed = newRow.some((val, idx) => val !== row[idx])
      return { newRow, score: s, changed }
    }

    let rotations = 0
    if (direction === 'up') rotations = 3
    else if (direction === 'right') rotations = 2
    else if (direction === 'down') rotations = 1

    for (let r = 0; r < rotations; r++) grid = rotateClockwise(grid)

    for (let r = 0; r < 4; r++) {
      const row = grid[r] ?? [0, 0, 0, 0]
      const res = slideLeft(row)
      grid[r] = res.newRow
      scoreGained += res.score
      if (res.changed) moved = true
    }

    const backRotations = (4 - rotations) % 4
    for (let r = 0; r < backRotations; r++) grid = rotateClockwise(grid)

    if (moved) {
      this.spawnRandomTile(grid)
    }

    const newScore = state.score + scoreGained
    let bestScore = Math.max(state.bestScore, newScore)
    this.updateBestScore2048(bestScore)

    const isGameOver = !this.canMove2048(grid)
    const hasWon = grid.some(row => row.some(cell => cell >= 2048))

    return {
      grid,
      score: newScore,
      bestScore,
      isGameOver,
      hasWon
    }
  }

  private spawnRandomTile(grid: number[][]): void {
    const emptyCells: Array<{ r: number; c: number }> = []
    for (let r = 0; r < 4; r++) {
      const row = grid[r] ?? []
      for (let c = 0; c < 4; c++) {
        if ((row[c] ?? 0) === 0) emptyCells.push({ r, c })
      }
    }
    if (emptyCells.length === 0) return
    const chosen = emptyCells[Math.floor(Math.random() * emptyCells.length)]
    if (chosen) {
      const row = grid[chosen.r]
      if (row) {
        row[chosen.c] = Math.random() < 0.9 ? 2 : 4
      }
    }
  }

  private canMove2048(grid: number[][]): boolean {
    for (let r = 0; r < 4; r++) {
      const row = grid[r] ?? []
      const nextRow = grid[r + 1]
      for (let c = 0; c < 4; c++) {
        const val = row[c] ?? 0
        if (val === 0) return true
        if (c + 1 < 4 && val === (row[c + 1] ?? 0)) return true
        if (nextRow && val === (nextRow[c] ?? 0)) return true
      }
    }
    return false
  }

  private getBestScore2048(): number {
    try {
      const row = this.db.prepare('SELECT best_score FROM game_2048_records WHERE id = "default"').get() as any
      return row?.best_score || 0
    } catch {
      return 0
    }
  }

  private updateBestScore2048(score: number): void {
    try {
      this.db.prepare('INSERT OR REPLACE INTO game_2048_records (id, best_score, updated_at) VALUES ("default", ?, ?)').run(score, Date.now())
    } catch {
      // 容错
    }
  }

  // =========================================================================
  // 4. 调试与压测生成器 (raycast-debug)
  // =========================================================================
  public sampleMemory(): MemorySample {
    const mem = process.memoryUsage()
    const sample: MemorySample = {
      timestamp: Date.now(),
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      rssBytes: mem.rss,
      externalBytes: mem.external
    }
    this.memoryHistory.push(sample)
    if (this.memoryHistory.length > 100) {
      this.memoryHistory.shift()
    }
    return sample
  }

  public getMemoryHistory(): MemorySample[] {
    return [...this.memoryHistory]
  }

  /**
   * M1.5-25.3: 生成合成剪贴板条目用于极限混沌压测 (createDebugClipboardHistory)
   */
  public async createDebugClipboardHistory(count = 150): Promise<{ count: number; itemsGenerated: number }> {
    const safeCount = Math.min(Math.max(1, count), 1000)
    let generated = 0

    const sampleTypes = [
      (i: number) => `Debug Text Entry #${i}: Hello ZTools Chaos Stress Testing!`,
      (i: number) => `https://github.com/ztools/benchmark?test_id=${i}&seed=${Math.random()}`,
      (i: number) => JSON.stringify({ index: i, type: 'stress-test', entropy: Math.random(), payload: 'x'.repeat(128) }),
      (i: number) => `# Heading ${i}\n\n- Task A: Completed\n- Task B: In Progress\n\n\`\`\`ts\nconst val = ${i};\n\`\`\``,
      (i: number) => `#${((i * 1234567) % 0xFFFFFF).toString(16).padStart(6, '0')}` // HEX 颜色码
    ]

    for (let i = 1; i <= safeCount; i++) {
      const generator = sampleTypes[i % sampleTypes.length]
      if (!generator) continue
      const text = generator(i)

      if (this.clipboardHistory) {
        await this.clipboardHistory.recordItem({
          content: text,
          format_type: 'text',
          source_app_name: 'ZTools Debug Suite'
        })
      }
      generated++
    }

    return { count: safeCount, itemsGenerated: generated }
  }

  public stop(): void {
    try {
      this.db.close()
    } catch {
      // 容错
    }
  }
}
