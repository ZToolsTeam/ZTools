import { createI18n, useI18n } from 'vue-i18n'
import { setRuntimeLocale } from '@ztools/declarative-ui'
import { localeMessages as editionLocaleMessages } from '@edition-locales'
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  resolveLocale
} from '@/utils/locale'
import zhCN from '@/locales/zh-CN.json'
import enUS from '@/locales/en-US.json'

export const LOCALE_STORAGE_KEY = 'ztools_locale'

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepMergeObjects(target, source) {
  const result = { ...target }
  if (!isPlainObject(source)) return result
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const srcVal = source[key]
    const dstVal = result[key]
    if (isPlainObject(dstVal) && isPlainObject(srcVal)) {
      result[key] = deepMergeObjects(dstVal, srcVal)
    } else if (srcVal !== undefined) {
      result[key] = srcVal
    }
  }
  return result
}

/**
 * 合并基础词条与 @edition 扩展词条（Open-Core 零泄漏：仅合并受支持的语言键，不修改源对象）
 */
export function mergeLocaleMessages(baseMessages, extraMessages) {
  const merged = {}
  for (const locale of SUPPORTED_LOCALES) {
    const base = isPlainObject(baseMessages?.[locale]) ? baseMessages[locale] : {}
    const extra = isPlainObject(extraMessages?.[locale]) ? extraMessages[locale] : null
    merged[locale] = extra ? deepMergeObjects(base, extra) : { ...base }
  }
  return merged
}

/**
 * 零闪屏同步解析初始 Locale：
 * 1. window.__ztoolsElectron?.initialLocale
 * 2. localStorage.getItem('ztools_locale')
 * 3. navigator.language
 */
export function detectInitialLocale(env = {}) {
  const win = env.window !== undefined ? env.window : (typeof window !== 'undefined' ? window : undefined)
  const nav = env.navigator !== undefined ? env.navigator : (typeof navigator !== 'undefined' ? navigator : undefined)
  const storage = env.localStorage !== undefined
    ? env.localStorage
    : (typeof localStorage !== 'undefined' ? localStorage : undefined)

  const systemLocale = (typeof nav?.language === 'string' && nav.language.trim())
    ? nav.language
    : DEFAULT_LOCALE

  const electronInitial = win?.__ztoolsElectron?.initialLocale
  if (typeof electronInitial === 'string' && electronInitial.trim()) {
    return resolveLocale(electronInitial, systemLocale)
  }

  let storedLocale = null
  try {
    storedLocale = storage?.getItem?.(LOCALE_STORAGE_KEY) ?? null
  } catch {
    storedLocale = null
  }
  if (typeof storedLocale === 'string' && storedLocale.trim()) {
    return resolveLocale(storedLocale, systemLocale)
  }

  return resolveLocale('system', systemLocale)
}

const baseMessages = {
  'zh-CN': zhCN,
  'en-US': enUS
}

export const messages = mergeLocaleMessages(baseMessages, editionLocaleMessages)

function syncRuntimeLocale(resolved) {
  if (typeof globalThis !== 'undefined') {
    globalThis.__ztoolsLocale = resolved
  }
  try {
    setRuntimeLocale(resolved)
  } catch {
    // 非声明式运行时测试环境容错
  }
}

const initialLocale = detectInitialLocale()
syncRuntimeLocale(initialLocale)

if (typeof document !== 'undefined' && document.documentElement) {
  document.documentElement.lang = initialLocale
}

export const i18n = createI18n({
  legacy: false,
  locale: initialLocale,
  fallbackLocale: DEFAULT_LOCALE,
  messages
})

/** 获取当前生效的规范 Locale（响应式读取） */
export function getCurrentLocale() {
  return resolveLocale(i18n.global.locale.value)
}

/** 同步切换全局 i18n 语言、更新 <html lang> 并同步声明式插件运行时语言 */
export function setI18nLocale(nextLocale) {
  const resolved = resolveLocale(nextLocale)
  i18n.global.locale.value = resolved
  syncRuntimeLocale(resolved)
  if (typeof document !== 'undefined' && document.documentElement) {
    document.documentElement.lang = resolved
  }
  return resolved
}

/** 非组件或通用翻译函数（响应式绑定到 i18n.global） */
export function t(key, params) {
  return params !== undefined ? i18n.global.t(key, params) : i18n.global.t(key)
}

/**
 * 组件内安全使用 i18n：
 * 优先使用 vue-i18n 的 useI18n()，在独立挂载组件的单测环境下自动回落到全局 i18n.global。
 */
export function useAppI18n() {
  try {
    return useI18n()
  } catch {
    return {
      t: i18n.global.t,
      locale: i18n.global.locale
    }
  }
}

export default i18n
