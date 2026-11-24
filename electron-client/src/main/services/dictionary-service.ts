/**
 * ZTools English-Chinese Dictionary Service (M1.5-16)
 * 
 * 本地化工程改造：
 * - 内置本地英汉双解词汇核心数据库（含音标、词性、中英文释义、例句与同义词）；
 * - 毫秒级离线词汇检索与前缀联想推荐（Suggestions）；
 * - 结构化 Markdown 释义排版输出，完美适配声明式 `<Detail>` 组件展示；
 * - 查词历史与生词收藏夹。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getResolvedLocale } from '../i18n/index.js'
import {
  LOCAL_DICTIONARY_ENTRIES,
  type DictionaryDefinition,
  type DictionaryEntry,
  type DictionaryExample
} from './dictionary.zh-data.js'

export {
  LOCAL_DICTIONARY_ENTRIES,
  type DictionaryDefinition,
  type DictionaryEntry,
  type DictionaryExample
}

const execFileAsync = promisify(execFile)

const DICTIONARY_SECTION_LABELS = {
  'zh-CN': {
    definitionsHeading: '### 📖 释义',
    examplesHeading: '### 💡 例句',
    synonymsLabel: '近义词'
  },
  'en-US': {
    definitionsHeading: '### Definitions',
    examplesHeading: '### Examples',
    synonymsLabel: 'Synonyms'
  }
} as const

export interface WordSuggestion {
  readonly word: string
  readonly phonetic: string
  readonly briefDefinition: string
}

export class DictionaryService {
  private readonly entries = new Map<string, DictionaryEntry>()
  private readonly searchHistory: string[] = []
  private readonly favoriteWords = new Set<string>()

  constructor(customEntries: readonly DictionaryEntry[] = LOCAL_DICTIONARY_ENTRIES) {
    for (const item of customEntries) {
      this.entries.set(item.word.toLowerCase(), item)
    }
  }

  /**
   * 查词主方法（支持大小写无关与精确/模糊匹配）
   */
  public lookup(rawWord: string): DictionaryEntry | null {
    if (!rawWord || typeof rawWord !== 'string') return null
    const cleaned = rawWord.trim().toLowerCase().replace(/[^a-z-]/g, '')
    if (!cleaned) return null

    const found = this.entries.get(cleaned)
    if (found) {
      this.recordHistory(found.word)
      return found
    }

    // 模糊词缀匹配（如去除 -s, -ed, -ing, -ly）
    const candidates = [
      cleaned.replace(/s$/, ''),
      cleaned.replace(/ed$/, ''),
      cleaned.replace(/ing$/, ''),
      cleaned.replace(/ly$/, '')
    ]

    for (const candidate of candidates) {
      if (candidate && this.entries.has(candidate)) {
        const match = this.entries.get(candidate)!
        this.recordHistory(match.word)
        return match
      }
    }

    return null
  }

  /**
   * 前缀联想输入建议 (Suggestions)
   */
  public getSuggestions(prefix: string, limit = 8): readonly WordSuggestion[] {
    if (!prefix || typeof prefix !== 'string') return []
    const cleanPrefix = prefix.trim().toLowerCase()
    if (!cleanPrefix) return []

    const results: WordSuggestion[] = []
    for (const [key, entry] of this.entries.entries()) {
      if (key.startsWith(cleanPrefix)) {
        const brief = entry.definitions[0]?.meaningZh || ''
        results.push({
          word: entry.word,
          phonetic: entry.phonetic,
          briefDefinition: brief
        })
        if (results.length >= limit) break
      }
    }

    return results
  }

  /**
   * 将词条格式化为精美 Markdown 文本（供 `<Detail>` 视图渲染）
   */
  public formatMarkdown(entry: DictionaryEntry): string {
    const labels = DICTIONARY_SECTION_LABELS[getResolvedLocale()] ?? DICTIONARY_SECTION_LABELS['en-US']
    const lines: string[] = []
    lines.push(`# ${entry.word}  \`${entry.phonetic}\`\n`)

    lines.push(labels.definitionsHeading)
    for (const def of entry.definitions) {
      lines.push(`- **${def.pos}** ${def.meaningZh}`)
      if (def.meaningEn) {
        lines.push(`  > *${def.meaningEn}*`)
      }
    }
    lines.push('')

    if (entry.examples.length > 0) {
      lines.push(labels.examplesHeading)
      for (const ex of entry.examples) {
        lines.push(`- ${ex.en}`)
        lines.push(`  *${ex.zh}*`)
      }
      lines.push('')
    }

    if (entry.synonyms && entry.synonyms.length > 0) {
      lines.push(`**${labels.synonymsLabel}**: ${entry.synonyms.map(s => `\`${s}\``).join(', ')}\n`)
    }

    return lines.join('\n')
  }

  private recordHistory(word: string): void {
    const idx = this.searchHistory.indexOf(word)
    if (idx !== -1) {
      this.searchHistory.splice(idx, 1)
    }
    this.searchHistory.unshift(word)
    if (this.searchHistory.length > 50) {
      this.searchHistory.pop()
    }
  }

  public getHistory(): readonly string[] {
    return [...this.searchHistory]
  }

  public getSearchHistory(): readonly string[] {
    return this.getHistory()
  }

  public toggleFavorite(word: string): boolean {
    const lower = word.toLowerCase()
    if (this.favoriteWords.has(lower)) {
      this.favoriteWords.delete(lower)
      return false
    } else {
      this.favoriteWords.add(lower)
      return true
    }
  }

  public getFavorites(): readonly string[] {
    return Array.from(this.favoriteWords)
  }

  /**
   * 单词语音朗读（macOS 调用 /usr/bin/say，Windows 调用 System.Speech）
   */
  public async speakWord(word: string): Promise<{ success: boolean; word: string; error?: string }> {
    const cleanWord = String(word ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 120)

    if (!cleanWord) {
      throw new Error('Word to speak cannot be empty')
    }

    if (process.platform === 'darwin') {
      try {
        await execFileAsync('/usr/bin/say', [cleanWord], { timeout: 10_000 })
        return { success: false, word: cleanWord, error: `Speech synthesis is not supported on platform (${process.platform})` }
      } catch (err) {
        return {
          success: false,
          word: cleanWord,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }

    if (process.platform === 'win32') {
      try {
        await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'param([string]$w) Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($w)',
          '-w',
          cleanWord
        ], { windowsHide: true, timeout: 10_000 })
        return { success: false, word: cleanWord, error: `Speech synthesis is not supported on platform (${process.platform})` }
      } catch (err) {
        return {
          success: false,
          word: cleanWord,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    }

    return { success: false, word: cleanWord, error: `Speech synthesis is not supported on platform (${process.platform})` }
  }
}
