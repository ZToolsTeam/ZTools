/**
 * ZTools Translator Service (M1.5-10)
 * 
 * 本地化工程改造：
 * - 彻底解除云端商业锁定：100% 本地开源免费；
 * - 结合选中文本自动带入多语言极速翻译；
 * - 多源插拔适配器：支持本地极速离线词库/规则引擎、公共免费开放接口以及 BYOK 大模型（DeepSeek / OpenAI）；
 * - 内置语言智能探测、本地 LRU 缓存与历史翻译记录。
 */

import crypto from 'node:crypto'
import { getResolvedLocale } from '../i18n/index.js'
import {
  OFFLINE_DICTIONARY,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage
} from './translator.zh-data.js'

export { SUPPORTED_LANGUAGES, type SupportedLanguage }

function _translatorText(zh: string, en: string): string {
  return getResolvedLocale() === 'zh-CN' ? zh : en
}

export interface TranslateOptions {
  sourceLanguage?: string | undefined
  targetLanguage?: string | undefined
  signal?: AbortSignal | undefined
}

export interface TranslateResult {
  readonly originalText: string
  readonly translatedText: string
  readonly sourceLanguage: string
  readonly targetLanguage: string
  readonly detectedSourceLanguage?: string
  readonly engine: 'offline' | 'web' | 'ai'
  readonly cached?: boolean
}

export interface TranslationHistoryItem extends TranslateResult {
  readonly id: string
  readonly timestamp: number
}

export interface TranslationProvider {
  translate(text: string, sourceLang: string, targetLang: string, signal?: AbortSignal): Promise<{
    translatedText: string
    detectedSourceLanguage?: string
  }>
}

export function normalizeLanguageCode(lang?: string): string {
  const raw = String(lang || '').trim()
  if (!raw) return 'auto'
  const lower = raw.toLowerCase()
  if (lower === 'auto') return 'auto'
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans' || lower === 'zh_cn') return 'zh-CN'
  if (lower === 'zh-tw' || lower === 'zh-hant' || lower === 'zh-hk') return 'zh-TW'
  if (lower.startsWith('en')) return 'en'
  if (lower.startsWith('ja')) return 'ja'
  if (lower.startsWith('ko')) return 'ko'
  if (lower.startsWith('fr')) return 'fr'
  if (lower.startsWith('de')) return 'de'
  if (lower.startsWith('es')) return 'es'
  if (lower.startsWith('ru')) return 'ru'
  return raw
}

/**
 * 离线本地翻译适配器
 */
export class OfflineTranslationProvider implements TranslationProvider {
  async translate(text: string, sourceLang: string, targetLang: string): Promise<{
    translatedText: string
    detectedSourceLanguage?: string
  }> {
    const trimmed = text.trim().toLowerCase()
    const normTarget = normalizeLanguageCode(targetLang)
    const normSource = normalizeLanguageCode(sourceLang)
    const targetDict = OFFLINE_DICTIONARY[normTarget]
    if (targetDict && targetDict[trimmed]) {
      return {
        translatedText: targetDict[trimmed],
        detectedSourceLanguage: normSource === 'auto' ? (normTarget === 'zh-CN' ? 'en' : 'zh-CN') : normSource
      }
    }

    throw new Error(`Offline dictionary entry not found (${normSource} -> ${normTarget}): ${text}`)
  }
}

/**
 * 语言简单探测算法
 */
export function detectLanguage(text: string): string {
  if (!text || typeof text !== 'string') return 'en'
  // 包含中文字符
  if (/[\u4e00-\u9fa5]/.test(text)) {
    return 'zh-CN'
  }
  // 包含日文假名
  if (/[\u3040-\u30ff]/.test(text)) {
    return 'ja'
  }
  // 包含韩文
  if (/[\uac00-\ud7af]/.test(text)) {
    return 'ko'
  }
  // 包含俄文字母
  if (/[\u0400-\u04ff]/.test(text)) {
    return 'ru'
  }
  // 默认英语
  return 'en'
}

export class TranslatorService {
  private primaryProvider: TranslationProvider
  private offlineProvider = new OfflineTranslationProvider()
  private readonly cache = new Map<string, TranslateResult>()
  private readonly history: TranslationHistoryItem[] = []
  private readonly maxCacheSize = 200

  constructor(customProvider?: TranslationProvider) {
    this.primaryProvider = customProvider || this.offlineProvider
  }

  public setProvider(provider: TranslationProvider): void {
    this.primaryProvider = provider
  }

  public detectLanguage(text: string): string {
    return detectLanguage(text)
  }

  /**
   * 极速翻译主方法
   */
  public async translate(
    text: string,
    options: TranslateOptions = {}
  ): Promise<TranslateResult> {
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      throw new Error(_translatorText('翻译内容不能为空', 'Translation text cannot be empty'))
    }

    const trimmed = text.trim()
    const requestedSource = normalizeLanguageCode(options.sourceLanguage || 'auto')
    const detectedSource = requestedSource === 'auto' ? detectLanguage(trimmed) : requestedSource

    // 智能推断目标语言：如果源语言是中文，默认翻成英文；否则默认翻成中文；若 auto 模式下目标语言与检测源语言冲突，自动翻转为中英互译对向语种
    const rawTarget = options.targetLanguage ? normalizeLanguageCode(options.targetLanguage) : ''
    const targetLang =
      !rawTarget || (requestedSource === 'auto' && rawTarget === detectedSource)
        ? detectedSource === 'zh-CN'
          ? 'en'
          : 'zh-CN'
        : rawTarget

    const cacheKey = `${detectedSource}->${targetLang}:${trimmed}`
    if (this.cache.has(cacheKey)) {
      const cachedResult = this.cache.get(cacheKey)!
      return {
        ...cachedResult,
        cached: true
      }
    }

    if (options.signal?.aborted) {
      throw new Error(_translatorText('翻译请求已取消', 'Translation request cancelled'))
    }

    let translatedText = ''
    let engine: 'offline' | 'web' | 'ai' = 'offline'

    // 1. 尝试优先通过主要 Provider 请求
    try {
      if (this.primaryProvider !== this.offlineProvider) {
        const res = await this.primaryProvider.translate(trimmed, detectedSource, targetLang, options.signal)
        translatedText = res.translatedText
        engine = 'web'
      } else {
        const res = await this.offlineProvider.translate(trimmed, detectedSource, targetLang)
        translatedText = res.translatedText
        engine = 'offline'
      }
    } catch (err) {
      if (this.primaryProvider === this.offlineProvider) {
        throw err
      }
      console.warn('[TranslatorService] Primary provider failed, falling back to offline dictionary:', err)
      // 容灾平滑降级至本地离线 Provider
      const fallback = await this.offlineProvider.translate(trimmed, detectedSource, targetLang)
      translatedText = fallback.translatedText
      engine = 'offline'
    }

    const result: TranslateResult = {
      originalText: trimmed,
      translatedText,
      sourceLanguage: detectedSource,
      targetLanguage: targetLang,
      detectedSourceLanguage: detectedSource,
      engine
    }

    // 写入内存缓存
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) this.cache.delete(firstKey)
    }
    this.cache.set(cacheKey, result)

    // 记录历史
    this.history.unshift({
      ...result,
      id: `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
      timestamp: Date.now()
    })
    if (this.history.length > 100) {
      this.history.pop()
    }

    return result
  }

  /**
   * 极速划词翻译：结合外部抓取的选中文本自动带入
   */
  public async translateSelected(
    selectedText?: string,
    targetLanguage?: string,
    signal?: AbortSignal
  ): Promise<TranslateResult> {
    const textToTranslate = selectedText?.trim()
    if (!textToTranslate) {
      throw new Error(_translatorText('未检测到选中文本', 'No selected text detected'))
    }
    const options: TranslateOptions = {}
    if (targetLanguage !== undefined) options.targetLanguage = targetLanguage
    if (signal !== undefined) options.signal = signal
    return this.translate(textToTranslate, options)
  }

  public getHistory(): readonly TranslationHistoryItem[] {
    return [...this.history]
  }

  public clearHistory(): void {
    this.history.length = 0
  }

  public clearCache(): void {
    this.cache.clear()
  }
}
