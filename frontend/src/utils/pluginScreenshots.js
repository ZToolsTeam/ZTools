/**
 * 插件详情页截图的数据整理（插件市场目录条目与随客户端内置插件共用）
 *
 * - 插件市场：目录条目的 screenshots 由发布脚本写入 [{ url, title, width, height }]，只接受 https 地址；
 *   其它协议（javascript:、data:、file: 等）与格式不对的条目直接丢弃，最多保留 5 张；
 * - 内置插件：截图随客户端分发，地址由 bundledPlugins.js 按本地副本生成，不经过这里，也不回退到网络。
 */

export const MAX_PLUGIN_SCREENSHOTS = 5

function positiveInt(value) {
  const n = Number(value)
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

/** 目录条目里的截图地址是否可以展示：只认 https，且不含空白与引号 */
export function isSafeCatalogScreenshotUrl(url) {
  if (typeof url !== 'string' || !url || /[\s"'<>\\]/.test(url)) return false
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 整理目录条目的截图列表
 * @param {unknown} raw
 * @returns {Array<{ url: string, title: string, width?: number, height?: number }>}
 */
export function normalizeCatalogScreenshots(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const shot of raw) {
    if (!shot || typeof shot !== 'object' || !isSafeCatalogScreenshotUrl(shot.url)) continue
    out.push({
      url: shot.url,
      title: typeof shot.title === 'string' ? shot.title : '',
      width: positiveInt(shot.width),
      height: positiveInt(shot.height)
    })
    if (out.length >= MAX_PLUGIN_SCREENSHOTS) break
  }
  return out
}
