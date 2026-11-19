import { invokeDllPluginCapability } from './native-ipc.js'

export interface SharedCapabilityItem {
  id: string
  title: string
  subtitle: string
  tag: string
  method: string
  params: Record<string, unknown>
}

export interface SharedInvocationResult {
  ok: boolean
  pluginName: string
  method: string
  data?: unknown
  error?: string
  fromFallback?: boolean
}

export function cloneCapabilityItems<T extends SharedCapabilityItem>(items: readonly T[]): T[] {
  return items.map((item) => ({
    ...item,
    params: { ...item.params }
  }))
}

export function filterCapabilityList<T extends SharedCapabilityItem>(items: T[], query: string): T[] {
  if (!Array.isArray(items)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return items
  return items.filter((item) => {
    if (!item || typeof item.title !== 'string') return false
    return (
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.tag.toLowerCase().includes(q) ||
      item.method.toLowerCase().includes(q)
    )
  })
}

export function validateCapabilityArgs(
  method: string,
  params: unknown,
  forbiddenPattern: RegExp,
  forbiddenReason: string
): { valid: boolean; error?: string } {
  if (typeof method !== 'string' || method.trim().length === 0) {
    return { valid: false, error: 'INVALID_METHOD: 调用方法名不能为空' }
  }
  if (method.length > 128 || !/^[A-Za-z0-9_]+$/.test(method.trim())) {
    return { valid: false, error: 'INVALID_METHOD_FORMAT: 方法名包含非法字符或超长' }
  }
  if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    return { valid: false, error: 'INVALID_PARAMS: 参数必须为非空对象' }
  }
  const record = params as Record<string, unknown>
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'string') {
      if (val.length > 4096) return { valid: false, error: `PARAM_TOO_LONG: 参数 ${key} 超过最大长度限制` }
      if (forbiddenPattern.test(val)) return { valid: false, error: `SECURITY_INTERCEPTED: ${forbiddenReason}` }
    } else if (typeof val === 'number') {
      if (!Number.isFinite(val) || val < -1000 || val > 100_000_000) {
        return { valid: false, error: `PARAM_OUT_OF_RANGE: 数值参数 ${key} 越界或非有限数` }
      }
    }
  }
  return { valid: true }
}

export async function invokeValidatedDllCapability(
  pluginName: string,
  method: string,
  params: Record<string, unknown>,
  forbiddenPattern: RegExp,
  forbiddenReason: string,
  hostBridge?: unknown
): Promise<SharedInvocationResult> {
  const check = validateCapabilityArgs(method, params, forbiddenPattern, forbiddenReason)
  if (!check.valid) throw new Error(check.error || '参数校验失败')
  const res = await invokeDllPluginCapability(pluginName, method, params, hostBridge)
  return {
    ok: res.ok,
    pluginName,
    method: method.trim(),
    data: res.data ?? undefined,
    error: res.error,
    fromFallback: res.fromFallback
  }
}
