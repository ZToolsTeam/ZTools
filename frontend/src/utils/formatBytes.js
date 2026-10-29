/**
 * 字节数转成易读的大小（1.2 MB / 54 KB / 512 B）。
 * 不是有效的正数时返回空字符串，由调用方决定隐藏还是显示占位，不编造「未知」之类的值。
 * 已带单位的字符串（如后台直接给出的 "1.2 MB"）原样返回。
 */
export function formatBytes(value) {
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return ''
    if (!/^\d+(\.\d+)?$/.test(text)) return text
    value = Number(text)
  }
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const KB = 1024
  const MB = KB * 1024
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`
  return `${Math.round(bytes)} B`
}
