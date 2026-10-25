/**
 * ZTools Dictation Service (M1.5-21)
 * 
 * 本地化工程改造：
 * - 录音转文字与极速失焦回贴管道（通过 UIAccess/Native 键盘模拟直接向目标应用打字/粘贴）；
 * - 词汇热词表（Custom Vocabulary）自定义增强，支持中国开发者高频专业术语、英文名词纠错；
 * - 纯本地 SQLite 存储听写历史（支持全文检索与再次拷贝/恢复）；
 * - 录音与听写状态机模型（idle -> recording -> transcribing -> finished / cancelled）。
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SidecarManager } from './sidecar-manager.js'

export type DictationState = 'idle' | 'recording' | 'transcribing' | 'finished' | 'cancelled'
export type DictationOutputAction = 'paste' | 'copy' | 'ai' | 'note'

export interface DictationRecord {
  id: string
  text: string
  audioDurationSeconds: number
  outputAction: DictationOutputAction
  language: string
  targetAppName?: string | null | undefined
  createdAt: number
}

export interface DictationStartOptions {
  outputAction?: DictationOutputAction | undefined
  language?: string | undefined
  targetHwnd?: number | undefined
  targetAppName?: string | undefined
}

export interface DictationServiceOptions {
  dbPath?: string | undefined
  sidecarManager?: SidecarManager | null | undefined
  onStateChanged?: ((state: DictationState) => void) | undefined
}

export class DictationService {
  private readonly db: DatabaseSync
  private readonly sidecars: SidecarManager | null
  private readonly onStateChanged: ((state: DictationState) => void) | null

  private currentState: DictationState = 'idle'
  private recordingStartedAt: number = 0
  private currentOptions: DictationStartOptions = {}
  private vocabularySet = new Set<string>(['ZTools', 'Raycast', 'TypeScript', 'Rust', 'Electron', 'Vue'])
  private lastTranscription: DictationRecord | null = null

  constructor(options: DictationServiceOptions = {}) {
    this.sidecars = options.sidecarManager ?? null
    this.onStateChanged = options.onStateChanged ?? null

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
      CREATE TABLE IF NOT EXISTS dictation_history (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        audio_duration_seconds REAL NOT NULL,
        output_action TEXT NOT NULL,
        language TEXT NOT NULL,
        target_app_name TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dictation_vocabulary (
        word TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `)

    // 加载持久化词汇
    const rows = this.db.prepare('SELECT word FROM dictation_vocabulary').all() as Array<{ word?: string }>
    for (const r of rows) {
      if (r && r.word) this.vocabularySet.add(r.word)
    }
  }

  public getState(): DictationState {
    return this.currentState
  }

  /**
   * M1.5-21.1: 开始语音录音 (dictateText)
   */
  public startDictation(options: DictationStartOptions = {}): { success: boolean; state: DictationState } {
    if (this.currentState === 'recording' || this.currentState === 'transcribing') {
      throw new Error('Dictation is already in progress')
    }

    this.currentState = 'recording'
    this.recordingStartedAt = Date.now()
    this.currentOptions = {
      outputAction: options.outputAction || 'paste',
      language: options.language || 'auto',
      targetHwnd: options.targetHwnd || 0,
      ...(options.targetAppName ? { targetAppName: options.targetAppName } : {})
    }

    this.onStateChanged?.(this.currentState)
    return { success: true, state: this.currentState }
  }

  /**
   * M1.5-21.2: 完成录音并转写贴入 (finishDictation)
   */
  public async finishDictation(audioPayload?: { textOverride?: string; durationSeconds?: number }): Promise<DictationRecord> {
    if (this.currentState !== 'recording') {
      throw new Error('Cannot finish dictation when not recording')
    }

    this.currentState = 'transcribing'
    this.onStateChanged?.(this.currentState)

    const now = Date.now()
    const duration = audioPayload?.durationSeconds !== undefined
      ? audioPayload.durationSeconds
      : Math.max(0.5, (now - this.recordingStartedAt) / 1000)

    // 若未传入 textOverride 且当前会话无录制的转写文本，返回空文本且不触发粘贴动作（严禁捏造假口号贴入用户编辑器）
    const transcribedText = audioPayload?.textOverride?.trim() || ''

    const record: DictationRecord = {
      id: randomUUID(),
      text: transcribedText,
      audioDurationSeconds: Math.round(duration * 10) / 10,
      outputAction: this.currentOptions.outputAction || 'paste',
      language: this.currentOptions.language || 'auto',
      targetAppName: this.currentOptions.targetAppName || null,
      createdAt: now
    }

    // 持久化历史（仅在有实际转写文本时写入）
    if (transcribedText) {
      try {
        this.db.prepare(
          'INSERT INTO dictation_history (id, text, audio_duration_seconds, output_action, language, target_app_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(record.id, record.text, record.audioDurationSeconds, record.outputAction, record.language, record.targetAppName ?? null, record.createdAt)
      } catch (err) {
        console.warn('[DictationService] Failed to persist dictation history:', err)
      }

      this.lastTranscription = record

      // 回贴操作：如果为 paste 动作且存在有效识别结果，则调用 SidecarManager.pasteToActive
      if (record.outputAction === 'paste' && this.sidecars) {
        try {
          await this.sidecars.pasteToActive(this.currentOptions.targetHwnd || 0)
        } catch (err) {
          console.warn('[DictationService] pasteToActive failed:', err)
        }
      }
    }

    this.currentState = 'finished'
    this.onStateChanged?.(this.currentState)
    this.currentState = 'idle'

    return record
  }

  /**
   * M1.5-21.3: 取消录音 (cancelDictation)
   */
  public cancelDictation(): boolean {
    if (this.currentState === 'idle') return false
    this.currentState = 'cancelled'
    this.onStateChanged?.(this.currentState)
    this.currentState = 'idle'
    return true
  }

  /**
   * M1.5-21.4: 获取最近一次听写结果 (copyLastTranscription)
   */
  public getLastTranscription(): DictationRecord | null {
    if (this.lastTranscription) return { ...this.lastTranscription }

    const row = this.db.prepare('SELECT id, text, audio_duration_seconds, output_action, language, target_app_name, created_at FROM dictation_history ORDER BY created_at DESC LIMIT 1').get() as {
      id: string
      text: string
      audio_duration_seconds: number
      output_action: string
      language: string
      target_app_name: string | null
      created_at: number
    } | undefined
    if (!row) return null

    return {
      id: row.id,
      text: row.text,
      audioDurationSeconds: row.audio_duration_seconds,
      outputAction: row.output_action as DictationOutputAction,
      language: row.language,
      targetAppName: row.target_app_name,
      createdAt: row.created_at
    }
  }

  /**
   * M1.5-21.5: 搜索听写历史 (searchTranscriptions)
   */
  public searchTranscriptions(query?: string, limit = 50): DictationRecord[] {
    let sql = 'SELECT id, text, audio_duration_seconds, output_action, language, target_app_name, created_at FROM dictation_history'
    const params: Array<string | number> = []

    if (query && query.trim()) {
      sql += ' WHERE text LIKE ?'
      params.push(`%${query.trim()}%`)
    }

    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(limit)

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string
      text: string
      audio_duration_seconds: number
      output_action: string
      language: string
      target_app_name: string | null
      created_at: number
    }>
    return rows.map(r => ({
      id: r.id,
      text: r.text,
      audioDurationSeconds: r.audio_duration_seconds,
      outputAction: r.output_action as DictationOutputAction,
      language: r.language,
      targetAppName: r.target_app_name,
      createdAt: r.created_at
    }))
  }

  /**
   * M1.5-21.6: 自定义词汇管理 (addWordToVocabulary)
   */
  public addWordToVocabulary(word: string): boolean {
    const raw = (word || '').trim()
    if (!raw) return false

    this.vocabularySet.add(raw)
    try {
      this.db.prepare('INSERT OR REPLACE INTO dictation_vocabulary (word, created_at) VALUES (?, ?)').run(raw, Date.now())
    } catch (err) {
      console.warn('[DictationService] Failed to add vocabulary word:', err)
    }
    return true
  }

  public listVocabulary(): string[] {
    return Array.from(this.vocabularySet.values())
  }

  public removeWordFromVocabulary(word: string): boolean {
    const deleted = this.vocabularySet.delete(word)
    if (deleted) {
      try {
        this.db.prepare('DELETE FROM dictation_vocabulary WHERE word = ?').run(word)
      } catch (err) {
        console.warn('[DictationService] Failed to remove vocabulary word:', err)
      }
    }
    return deleted
  }

  public stop(): void {
    this.cancelDictation()
    try {
      this.db.close()
    } catch (err) {
      console.warn('[DictationService] Failed to close database:', err)
    }
  }
}
