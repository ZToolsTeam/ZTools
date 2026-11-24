/**
 * 声明式渲染器调用宿主 IPC 的唯一入口。
 *
 * preload 暴露的是 `window.__ztoolsElectron.transport.methods[method]({ messageId, params })`，
 * 返回 `{ success, data | error }` 信封。这里把它包装成 `methods[method](params)`：
 * 成功时返回处理函数的原始结果，失败时抛出带 code 的错误，调用方无需关心信封格式。
 */

const HOST_METHOD_FALLBACK_MESSAGES = {
  'zh-CN': {
    'declarativeLoader.hostMethodUnavailable': '宿主不支持方法: {method}',
    'declarativeLoader.hostMethodInvalidResponse': '宿主方法 {method} 返回了无效响应',
    'declarativeLoader.hostMethodFailed': '宿主方法 {method} 调用失败'
  },
  'en-US': {
    'declarativeLoader.hostMethodUnavailable': 'Host does not support method: {method}',
    'declarativeLoader.hostMethodInvalidResponse': 'Host method {method} returned an invalid response',
    'declarativeLoader.hostMethodFailed': 'Host method {method} failed'
  }
}

const HOST_CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const HOST_RAW_TECH_EN_RE =
  /^(?:(?:Type|Reference|Syntax|Range|URI|Eval|Aggregate|Internal|Abort|Fetch|Axios)?Error|DOMException)\s*:|\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EPIPE|EACCES|EPERM|ENOENT|EEXIST|EISDIR|ENOTDIR|ENOSPC|EAI_AGAIN|ERR_NETWORK|ERR_BAD_REQUEST|ERR_BAD_RESPONSE|ERR_CANCELED|ERR_TIMED_OUT|ERR_CONNECTION_REFUSED)\b|^(?:Failed to fetch|Network ?Error|Load failed|Request failed with status code \d+|Unexpected (?:token|end of JSON input)|Cannot read propert|JSON\.parse|timeout of \d+ms exceeded|socket hang up|HTTP \d{3}\b)/i

function resolveCurrentHostLocale() {
  const rawLocale =
    (typeof globalThis !== 'undefined' ? globalThis.__ztoolsLocale : '') ||
    (typeof document !== 'undefined' ? document.documentElement?.lang : '') ||
    'en-US'
  return String(rawLocale).toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/** 兼容纯 Node 沙箱测试（无 Vite @/i18n 别名解析）的翻译辅助函数 */
function translateHostMessage(key, params) {
  if (typeof globalThis !== 'undefined' && typeof globalThis.__ztoolsTranslate === 'function') {
    const resolved = globalThis.__ztoolsTranslate(key, params)
    if (resolved && resolved !== key) return resolved
  }
  const locale = resolveCurrentHostLocale()
  let text = HOST_METHOD_FALLBACK_MESSAGES[locale]?.[key] ?? HOST_METHOD_FALLBACK_MESSAGES['en-US'][key] ?? key
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
  }
  return text
}

function resolveHostErrorText(method, error) {
  const raw = typeof error?.message === 'string' ? error.message.trim() : ''
  if (raw) {
    const locale = resolveCurrentHostLocale()
    const blockedInEn = locale === 'en-US' && HOST_CJK_RE.test(raw)
    const blockedInZh = locale === 'zh-CN' && !HOST_CJK_RE.test(raw) && HOST_RAW_TECH_EN_RE.test(raw)
    if (!blockedInEn && !blockedInZh) {
      return raw
    }
  }
  return translateHostMessage('declarativeLoader.hostMethodFailed', { method })
}

let sequence = 0

function nextMessageId(method) {
  sequence = (sequence + 1) % 1_000_000
  return `decl_${method.slice(0, 64)}_${Date.now()}_${sequence}`
}

function getTransportMethods() {
  if (typeof window === 'undefined') return null
  return window.__ztoolsElectron?.transport?.methods || null
}

export class HostMethodError extends Error {
  constructor(method, error) {
    super(resolveHostErrorText(method, error))
    this.name = 'HostMethodError'
    this.method = method
    this.code = error?.code || 'HOST_METHOD_FAILED'
    // 宿主允许公开的结构化补充信息（例如结束进程超时时仍在运行的 pid）
    if (error?.details && typeof error.details === 'object') this.details = error.details
  }
}

/**
 * 调用一个宿主方法；宿主不存在该方法时抛出 code 为 HOST_METHOD_UNAVAILABLE 的错误。
 *
 * options.methods：改用指定的调用通道（例如插件专属、自动带会话令牌的通道），缺省为全局宿主通道；
 * options.timeoutMs：IPC 超时（毫秒），缺省由主进程按 10 秒处理。
 */
export async function callHostMethod(method, params = {}, options = {}) {
  const methods = options.methods || getTransportMethods()
  const fn = methods?.[method]
  if (typeof fn !== 'function') {
    throw new HostMethodError(method, {
      code: 'HOST_METHOD_UNAVAILABLE',
      message: translateHostMessage('declarativeLoader.hostMethodUnavailable', { method })
    })
  }
  const envelope = await fn({
    messageId: nextMessageId(method),
    params,
    ...(Number.isInteger(options.timeoutMs) ? { timeoutMs: options.timeoutMs } : {})
  })
  if (!envelope || typeof envelope !== 'object' || !('success' in envelope)) {
    throw new HostMethodError(method, {
      code: 'HOST_RESPONSE_INVALID',
      message: translateHostMessage('declarativeLoader.hostMethodInvalidResponse', { method })
    })
  }
  if (!envelope.success) throw new HostMethodError(method, envelope.error)
  return envelope.data
}

/**
 * 兼容旧调用写法：返回一个只读代理，`methods.clipboard_copy_text(params)` 等价于 callHostMethod。
 * 宿主不可用（例如单元测试、浏览器预览）时返回 null，调用方走各自的降级分支。
 */
export function getHostMethods() {
  const methods = getTransportMethods()
  if (!methods) return null
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string' || typeof methods[prop] !== 'function') return undefined
        return (params = {}) => callHostMethod(prop, params)
      }
    }
  )
}
