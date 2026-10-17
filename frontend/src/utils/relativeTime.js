/**
 * 「最近使用」的相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / M月D日。
 * 非法或未来时间返回空字符串（界面上不显示，而不是显示错误时间）。
 * @param {number} time - 毫秒时间戳
 * @param {number} [now]
 */
export function formatRelativeTime(time, now = Date.now()) {
  if (!Number.isFinite(time) || time <= 0 || time > now + 60_000) return ''
  const minutes = Math.floor(Math.max(0, now - time) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  const today = new Date(now)
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
  if (time >= startOfToday) return `${hours} 小时前`
  if (time >= startOfToday - 86_400_000) return '昨天'
  const days = Math.ceil((startOfToday - time) / 86_400_000)
  if (days < 7) return `${days} 天前`
  const date = new Date(time)
  return `${date.getMonth() + 1}月${date.getDate()}日`
}
