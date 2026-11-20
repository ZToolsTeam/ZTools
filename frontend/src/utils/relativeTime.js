import { resolveLocale } from '@/utils/locale'
import { getCurrentLocale } from '@/i18n'

const rtfCache = new Map()
const dtfCache = new Map()

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
