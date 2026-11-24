import { resolveLocale } from '@/utils/locale'
import { getCurrentLocale } from '@/i18n'

const rtfCache = new Map()
const dtfCache = new Map()
const dateDtfCache = new Map()
const dateTimeDtfCache = new Map()

function getRelativeTimeFormatter(locale) {
  let formatter = rtfCache.get(locale)
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    rtfCache.set(locale, formatter)
  }
  return formatter
}

function getMonthDayFormatter(locale) {
  let formatter = dtfCache.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
    dtfCache.set(locale, formatter)
  }
  return formatter
}

function getDateFormatter(locale) {
  let formatter = dateDtfCache.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' })
    dateDtfCache.set(locale, formatter)
  }
  return formatter
}

function getDateTimeFormatter(locale) {
  let formatter = dateTimeDtfCache.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
    dateTimeDtfCache.set(locale, formatter)
  }
  return formatter
}

/**
 * 解析时间戳、Date 对象、ISO 字符串或空格分隔的日期时间字符串（如 "2026-10-27 16:22:00"）
 * 非法或空值返回 null
 * @param {number|string|Date} value
 * @returns {Date|null}
 */
export function parseDateInput(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    // 兼容后端返回 "YYYY-MM-DD HH:mm:ss" 空格分隔格式
    const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(trimmed)
      ? trimmed.replace(/\s+/, 'T')
      : trimmed
    const date = new Date(normalized)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

/**
 * 本地化年月日格式化（按当前或指定 locale 输出）
 * @param {number|string|Date} value
 * @param {string} [locale]
 * @returns {string}
 */
export function formatLocalizedDate(value, locale) {
  const date = parseDateInput(value)
  if (!date) return ''
  const targetLocale = locale !== undefined ? resolveLocale(locale) : getCurrentLocale()
  return getDateFormatter(targetLocale).format(date)
}

/**
 * 本地化日期时间格式化（精确到分钟，按当前或指定 locale 输出）
 * @param {number|string|Date} value
 * @param {string} [locale]
 * @returns {string}
 */
export function formatLocalizedDateTime(value, locale) {
  const date = parseDateInput(value)
  if (!date) return ''
  const targetLocale = locale !== undefined ? resolveLocale(locale) : getCurrentLocale()
  return getDateTimeFormatter(targetLocale).format(date)
}

/**
 * 指定天数窗口内的相对时间，超过窗口回落本地化年月日
 * @param {number|string|Date} value
 * @param {{ now?: number, maxDays?: number, locale?: string }} [options]
 * @returns {string}
 */
export function formatRelativeTimeWithinDays(value, { now = Date.now(), maxDays = 30, locale } = {}) {
  const date = parseDateInput(value)
  if (!date || !Number.isFinite(now)) return ''
  const time = date.getTime()
  const targetLocale = locale !== undefined ? resolveLocale(locale) : getCurrentLocale()
  if (time > now + 60_000) return getDateFormatter(targetLocale).format(date)

  const rtf = getRelativeTimeFormatter(targetLocale)
  const minutes = Math.floor(Math.max(0, now - time) / 60_000)
  if (minutes < 1) return rtf.format(0, 'second')
  if (minutes < 60) return rtf.format(-minutes, 'minute')

  const hours = Math.floor(minutes / 60)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (time >= startOfToday) return rtf.format(-hours, 'hour')
  if (time >= startOfToday - 86_400_000) return rtf.format(-1, 'day')

  const days = Math.ceil((startOfToday - time) / 86_400_000)
  if (days < maxDays) return rtf.format(-days, 'day')

  return getDateFormatter(targetLocale).format(date)
}

/**
 * 「最近使用」的相对时间，基于 Intl.RelativeTimeFormat 按当前或指定 locale 格式化。
 * 非法、零、负数或未来时间返回空字符串（界面上不显示，而不是显示错误时间）。
 * @param {number} time - 毫秒时间戳
 * @param {number} [now]
 * @param {string} [locale]
 */
export function formatRelativeTime(time, now = Date.now(), locale) {
  if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(now) || time > now + 60_000) return ''
  const targetLocale = locale !== undefined ? resolveLocale(locale) : getCurrentLocale()
  const rtf = getRelativeTimeFormatter(targetLocale)

  const minutes = Math.floor(Math.max(0, now - time) / 60_000)
  if (minutes < 1) return rtf.format(0, 'second')
  if (minutes < 60) return rtf.format(-minutes, 'minute')

  const hours = Math.floor(minutes / 60)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (time >= startOfToday) return rtf.format(-hours, 'hour')
  if (time >= startOfToday - 86_400_000) return rtf.format(-1, 'day')

  const days = Math.ceil((startOfToday - time) / 86_400_000)
  if (days < 7) return rtf.format(-days, 'day')

  return getMonthDayFormatter(targetLocale).format(new Date(time))
}
