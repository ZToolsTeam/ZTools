/**
 * 声明式渲染器调用宿主 IPC 的唯一入口。
 *
 * preload 暴露的是 `window.__ztoolsElectron.transport.methods[method]({ messageId, params })`，
 * 返回 `{ success, data | error }` 信封。这里把它包装成 `methods[method](params)`：
 * 成功时返回处理函数的原始结果，失败时抛出带 code 的错误，调用方无需关心信封格式。
 */

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
    super(error?.message || `宿主方法 ${method} 调用失败`)
    this.name = 'HostMethodError'
    this.method = method
    this.code = error?.code || 'HOST_METHOD_FAILED'
  }
}

/**
 * 调用一个宿主方法；宿主不存在该方法时抛出 code 为 HOST_METHOD_UNAVAILABLE 的错误。
 */
export async function callHostMethod(method, params = {}) {
  const methods = getTransportMethods()
  const fn = methods?.[method]
  if (typeof fn !== 'function') {
    throw new HostMethodError(method, { code: 'HOST_METHOD_UNAVAILABLE', message: `宿主未提供 ${method}` })
  }
  const envelope = await fn({ messageId: nextMessageId(method), params })
  if (!envelope || typeof envelope !== 'object' || !('success' in envelope)) {
    throw new HostMethodError(method, { code: 'HOST_RESPONSE_INVALID', message: `宿主方法 ${method} 返回了无法识别的结果` })
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
