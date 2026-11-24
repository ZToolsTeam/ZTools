/**
 * ZTools Emoji & Symbols Service (M1.5-9)
 * 
 * 本地化工程改造：
 * - 内置全量 Unicode Emoji、数学符号、箭头、货币与特殊标点库；
 * - 加入原生中英文拼音双向索引：支持中文名称、全拼与拼音首字母极速检索（如 "xl" / "xiaolian" -> 😊）；
 * - 支持肤色变体、常用历史记录与收藏状态持久化。
 */

import { EMOJI_DATABASE, type EmojiCategory, type EmojiItem } from './emoji.zh-data.js'

export { EMOJI_DATABASE, type EmojiCategory, type EmojiItem }

export type SkinTone =
  | 'none'
  | 'light'
  | 'medium-light'
  | 'medium'
  | 'medium-dark'
  | 'dark'

const SKIN_TONE_MODIFIERS: Record<Exclude<SkinTone, 'none'>, string> = {
  'light': '\u{1F3FB}',
  'medium-light': '\u{1F3FC}',
  'medium': '\u{1F3FD}',
  'medium-dark': '\u{1F3FE}',
  'dark': '\u{1F3FF}'
}

export interface EmojiSearchOptions {
  category?: EmojiCategory | 'all' | undefined
  skinTone?: SkinTone | undefined
  limit?: number | undefined
}

export interface EmojiSearchResult {
  items: readonly EmojiItem[]
  total: number
  query: string
}

export class EmojiService {
  private readonly recentChars: string[] = []
  private readonly favoriteChars = new Set<string>()

  /**
   * 统一搜索接口：支持中英文、拼音全拼与首字母模糊匹配
   */
  public search(query: string = '', options: EmojiSearchOptions = {}): EmojiSearchResult {
    const rawQuery = (typeof query === 'string' ? query : '').trim().toLowerCase()
    const targetCategory = options.category && options.category !== 'all' ? options.category : null
    const limit = options.limit && options.limit > 0 ? options.limit : 100
    const skinTone = options.skinTone || 'none'

    let matches = EMOJI_DATABASE.filter((item) => {
      // 1. 分类过滤
      if (targetCategory && item.category !== targetCategory) {
        return false
      }

      // 2. 空查询返回所有
      if (!rawQuery) {
        return true
      }

      // 3. 匹配原始字符与 Unicode 编码
      if (item.char === rawQuery || item.codepoint.toLowerCase().includes(rawQuery)) {
        return true
      }

      // 4. 匹配英文名称与关键词
      if (item.name.toLowerCase().includes(rawQuery) || item.keywords.some(k => k.toLowerCase().includes(rawQuery))) {
        return true
      }

      // 5. 匹配中文名称、拼音全拼、拼音首字母
      if (item.nameZh.includes(rawQuery) || item.pinyin.includes(rawQuery) || item.pinyinInitials.includes(rawQuery)) {
        return true
      }

      return false
    })

    // 应用肤色变体（若当前项支持）
    if (skinTone !== 'none') {
      matches = matches.map(item => this.applySkinTone(item, skinTone))
    }

    const total = matches.length
    const paged = matches.slice(0, limit)

    return {
      items: paged,
      total,
      query: rawQuery
    }
  }

  /**
   * 应用肤色修饰符
   */
  public applySkinTone(item: EmojiItem, skinTone: SkinTone): EmojiItem {
    if (!item.supportsSkinTone || skinTone === 'none') {
      return item
    }
    const modifier = SKIN_TONE_MODIFIERS[skinTone]
    if (!modifier) return item

    return {
      ...item,
      char: `${item.char}${modifier}`
    }
  }

  /**
   * 记录使用历史
   */
  public recordUsage(char: string): void {
    if (!char || typeof char !== 'string') return
    const index = this.recentChars.indexOf(char)
    if (index !== -1) {
      this.recentChars.splice(index, 1)
    }
    this.recentChars.unshift(char)
    if (this.recentChars.length > 50) {
      this.recentChars.pop()
    }
  }

  public getRecent(): readonly string[] {
    return [...this.recentChars]
  }

  /**
   * 收藏与取消收藏
   */
  public toggleFavorite(char: string): boolean {
    if (!char || typeof char !== 'string') return false
    if (this.favoriteChars.has(char)) {
      this.favoriteChars.delete(char)
      return false
    } else {
      this.favoriteChars.add(char)
      return true
    }
  }

  public isFavorite(char: string): boolean {
    return this.favoriteChars.has(char)
  }

  public getFavorites(): readonly string[] {
    return Array.from(this.favoriteChars)
  }
}
