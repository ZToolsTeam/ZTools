import { getCurrentLocale, t } from '@/i18n'

const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
// 中文界面下识别典型未本地化的纯英文底层技术报错（JS 异常、Node/POSIX 错误码、Fetch/Axios 网络错误等）
const RAW_TECHNICAL_EN_ERROR_RE =
  /^(?:(?:Type|Reference|Syntax|Range|URI|Eval|Aggregate|Internal|Abort|Fetch|Axios)?Error|DOMException)\s*:|\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|EACCES|EPERM|ENOENT|EEXIST|EISDIR|ENOTDIR|ENOSPC|EAI_AGAIN|ERR_NETWORK|ERR_BAD_REQUEST|ERR_BAD_RESPONSE|ERR_CANCELED|ERR_TIMED_OUT|ERR_CONNECTION_REFUSED|ERR_INVALID_URL)\b|^(?:Failed to fetch|Network ?Error|Load failed|Request failed with status code \d+|Unexpected (?:token|end of JSON input)|Cannot read propert|JSON\.parse|timeout of \d+ms exceeded|socket hang up|HTTP \d{3}\b|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)/i

function isDisplayableInCurrentLocale(text) {
  if (!text) return false
  const locale = getCurrentLocale()
  if (locale === 'en-US' && CJK_CHAR_RE.test(text)) {
    return false
  }
  if (locale === 'zh-CN' && !CJK_CHAR_RE.test(text) && RAW_TECHNICAL_EN_ERROR_RE.test(text)) {
    return false
  }
  return true
}

/**
 * 统一解析错误/响应对象的展示消息（避免 `err.message || t(...)` 透传反模式）：
 * 1. 提取非空消息文本（宿主已按当前语言生成的提示文案）；
 * 2. 在英文模式（en-US）下若原始消息包含中文（CJK），禁止直出并回退到 `t(fallbackKey, fallbackParams)`；
 * 3. 在中文模式（zh-CN）下若原始消息为未本地化的英文底层技术报错，禁止直出并回退到 `t(fallbackKey, fallbackParams)`；
 * 4. 若无有效消息则动态回退到 `t(fallbackKey, fallbackParams)`。
 *
 * @param {unknown} source - Error 实例、IPC 响应对象、或字符串
 * @param {string} fallbackKey - i18n 回退键
 * @param {Record<string, unknown>} [fallbackParams] - i18n 插值参数
 * @returns {string}
 */
export function resolveErrorMessage(source, fallbackKey, fallbackParams) {
  const rawText = extractErrorText(source)
  if (isDisplayableInCurrentLocale(rawText)) {
    return rawText
  }

  return fallbackParams !== undefined ? t(fallbackKey, fallbackParams) : t(fallbackKey)
}

/**
 * 解析操作成功响应的展示文案（优先使用显式非空消息；英文模式下拦截中文文案并回退 `t(fallbackKey, fallbackParams)`）。
 *
 * @param {unknown} response
 * @param {string} fallbackKey
 * @param {Record<string, unknown>} [fallbackParams]
 * @returns {string}
 */
export function resolveResponseMessage(response, fallbackKey, fallbackParams) {
  if (typeof response === 'string') {
    const trimmed = response.trim()
    if (isDisplayableInCurrentLocale(trimmed)) {
      return trimmed
    }
  }
  if (response && typeof response === 'object') {
    const msg = typeof response.message === 'string' ? response.message.trim() : ''
    if (isDisplayableInCurrentLocale(msg)) {
      return msg
    }
  }
  return fallbackParams !== undefined ? t(fallbackKey, fallbackParams) : t(fallbackKey)
}

function extractErrorText(source) {
  if (typeof source === 'string') {
    return source.trim()
  }
  if (!source || typeof source !== 'object') {
    return ''
  }
  if (typeof source.error === 'string' && source.error.trim()) {
    return source.error.trim()
  }
  if (source.error && typeof source.error === 'object' && typeof source.error.message === 'string' && source.error.message.trim()) {
    return source.error.message.trim()
  }
  if (typeof source.message === 'string' && source.message.trim()) {
    return source.message.trim()
  }
  return ''
}
