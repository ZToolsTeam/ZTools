/**
 * 声明式插件的会话归属（渲染层）。
 *
 * 声明式插件和宿主界面跑在同一个 JS 上下文里，主进程只看得到「主窗口」。宿主在打开插件时向主进程申请会话
 * （declarative_session_open，主进程自己读 plugin.json），拿到随机令牌后放进只属于这个插件的调用通道：
 * 插件代码里的 `window.__ztoolsElectron.transport.methods.x(...)` 会自动带上令牌，主进程按「令牌 + 发送窗口」
 * 查出 pluginId。插件源码零修改。
 *
 * 注意：这不是安全隔离边界。存心作恶的插件仍能拿到原始通道（例如 globalThis 之外的引用）以宿主身份调用，
 * 也能自己申请别的插件的会话；这一层只保证正常插件的调用被准确归属，需要归属的新能力拒绝未归属调用。
 *
 * 会话状态（每个渲染进程里每个插件一份，多个挂载点 / no-view 命令共享，引用计数）：
 *   Idle --acquire(0→1)--> Opening --成功--> Active(token) --release(1→0)--> Closing(宽限期) --> Idle
 *                            └--失败--> Idle（下次 acquire 重试）      ↑ 宽限期内再次 acquire 直接复用
 * 释放时先等宽限期（让卸载过程中的保存调用仍带令牌）与在途调用结束（最长 2 秒），再清令牌、发 close。
 */
import { callHostMethod } from './hostMethods.js'

export const SESSION_RELEASE_GRACE_MS = 250
export const SESSION_INFLIGHT_SETTLE_MAX_MS = 2_000

const holders = new Map()

function logWarn(...args) {
  try {
    console.warn(...args)
  } catch (err) {
    void err
  }
}

/**
 * @param {string} pluginId
 * @param {{ call?: typeof callHostMethod, graceMs?: number, settleMaxMs?: number }} [options]
 */
export function createPluginSessionHolder(pluginId, options = {}) {
  const call = options.call || callHostMethod
  const graceMs = options.graceMs ?? SESSION_RELEASE_GRACE_MS
  const settleMaxMs = options.settleMaxMs ?? SESSION_INFLIGHT_SETTLE_MAX_MS
  let refs = 0
  let token = null
  let sessionId = null
  let opening = null
  let closeTimer = null
  let inflight = 0
  let settleWaiters = []
  let lastError = null
  let generation = 0

  function settled() {
    if (inflight > 0) return
    const waiters = settleWaiters
    settleWaiters = []
    for (const resolve of waiters) resolve()
  }

  function waitInflight() {
    if (inflight === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        settleWaiters = settleWaiters.filter((item) => item !== done)
        resolve()
      }, settleMaxMs)
      const done = () => {
        clearTimeout(timer)
        resolve()
      }
      settleWaiters.push(done)
    })
  }

  async function open() {
    const myGeneration = generation
    try {
      const result = await call('declarative_session_open', { pluginId })
      const data = result?.data
      if (!data || typeof data.token !== 'string' || typeof data.sessionId !== 'string') {
        throw Object.assign(new Error('宿主返回的插件会话无效'), { code: 'HOST_RESPONSE_INVALID' })
      }
      if (myGeneration !== generation || refs === 0) {
        // 打开途中已全部释放：立即关闭，不留残留
        void call('declarative_session_close', { sessionId: data.sessionId }).catch((err) => logWarn('[plugin-session] 关闭孤儿会话失败:', err))
        return
      }
      token = data.token
      sessionId = data.sessionId
      lastError = null
    } catch (error) {
      lastError = error
      // 宿主过旧（无此方法）属于预期；其余记 warn。插件照常渲染，需要归属的能力会报明确错误
      if (error?.code !== 'HOST_METHOD_UNAVAILABLE') {
        logWarn(`[plugin-session] 插件 ${pluginId} 会话申请失败：${error?.message || error}`)
      }
    } finally {
      if (myGeneration === generation) opening = null
    }
  }

  async function closeNow() {
    closeTimer = null
    if (refs > 0) return
    await waitInflight()
    if (refs > 0) return
    const closing = sessionId
    generation += 1
    token = null
    sessionId = null
    opening = null
    if (closing) {
      try {
        await call('declarative_session_close', { sessionId: closing })
      } catch (err) {
        logWarn('[plugin-session] 关闭插件会话失败:', err)
      }
    }
  }

  function release() {
    if (refs === 0) return
    refs -= 1
    if (refs > 0) return
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = setTimeout(() => { void closeNow() }, graceMs)
  }

  return {
    pluginId,
    /** 引用计数 +1；返回幂等的 release。会话打开失败也会 resolve（不阻塞渲染） */
    async acquire() {
      refs += 1
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      if (!token && !opening) opening = open()
      if (opening) await opening
      let released = false
      return () => {
        if (released) return
        released = true
        release()
      }
    },
    get token() {
      return token
    },
    get pending() {
      return opening
    },
    get refs() {
      return refs
    },
    get lastError() {
      return lastError
    },
    /** 记录一次带令牌的在途调用；release 会等它结束再关闭会话 */
    track(run) {
      inflight += 1
      let result
      try {
        result = Promise.resolve(run())
      } catch (error) {
        inflight -= 1
        settled()
        return Promise.reject(error)
      }
      return result.finally(() => {
        inflight -= 1
        settled()
      })
    }
  }
}

/** 每个渲染进程里每个插件共享一个 holder（同一插件的多个功能 / 挂载点共用一个会话） */
export function getPluginSessionHolder(pluginId) {
  const key = String(pluginId || '').trim().toLowerCase()
  if (!key) return null
  let holder = holders.get(key)
  if (!holder) {
    holder = createPluginSessionHolder(key)
    holders.set(key, holder)
  }
  return holder
}

/** 测试用：清空 holder 缓存 */
export function resetPluginSessionHoldersForTest() {
  holders.clear()
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

let scopedSequence = 0
function nextScopedMessageId() {
  scopedSequence = (scopedSequence + 1) % Number.MAX_SAFE_INTEGER
  return `scoped:${Date.now()}:${scopedSequence}`
}

/**
 * 插件专属的宿主通道：方法表与原始通道一致，调用时按 preload 同样的规则规范成信封后附上会话令牌。
 * 原始方法表在插件代码运行前取出并保存在闭包里，插件后来改写全局也影响不到这里。
 * setMessageCallback 被拦截（插件调用它会顶掉宿主唯一的消息回调）。
 */
export function createScopedHostBridge(holder, realBridge) {
  if (!realBridge || typeof realBridge !== 'object') return realBridge
  const realTransport = realBridge?.transport
  const realMethods = realTransport?.methods
  if (!holder || !realMethods || typeof realMethods !== 'object') return realBridge

  const methods = {}
  for (const name of Object.keys(realMethods)) {
    const original = realMethods[name]
    if (typeof original !== 'function') continue
    methods[name] = async (request) => {
      const source = isRecord(request) ? request : {}
      const hasEnvelope = 'messageId' in source || 'params' in source
      const envelope = {
        messageId: typeof source.messageId === 'string' && source.messageId ? source.messageId : nextScopedMessageId(),
        params: hasEnvelope ? source.params : request,
        ...(Object.hasOwn(source, 'timeoutMs') ? { timeoutMs: source.timeoutMs } : {})
      }
      const pending = holder.pending
      if (pending) await pending
      const token = holder.token
      if (!token && name === 'system_power_session') {
        throw Object.assign(new Error('插件会话尚未就绪，请重新打开插件后重试'), { code: 'PLUGIN_SESSION_REQUIRED' })
      }
      if (!token) return original(envelope)
      return holder.track(() => original({ ...envelope, pluginSession: token }))
    }
  }
  let warned = false
  const transport = Object.freeze({
    ...(realTransport.cancellations ? { cancellations: realTransport.cancellations } : {}),
    methods: Object.freeze(methods),
    setMessageCallback() {
      if (!warned) {
        warned = true
        logWarn(`[plugin-session] 插件 ${holder.pluginId} 调用了 setMessageCallback，已忽略（该回调由宿主独占）`)
      }
    }
  })
  return Object.freeze({ ...realBridge, transport })
}

/**
 * 插件专属的 window 视图：只有 __ztoolsElectron 换成插件专属通道，其余属性全部转发到真实 window。
 *
 * contextBridge 暴露的 __ztoolsElectron 是 writable:false + configurable:false 的数据属性，
 * 以真实 window 作 Proxy target 改写它会违反 Proxy 不变式而抛 TypeError，所以 target 用空对象，
 * 所有 trap 转发到真实 window；转发出去的属性描述符一律报成 configurable:true（空 target 的不变式要求）。
 * 原生方法（无 prototype 的函数，如 setTimeout / fetch）绑定到真实 window 并缓存，保证
 * `w.setTimeout === w.setTimeout` 且不会 Illegal invocation；构造函数（带 prototype，如 URL）原样返回。
 */
export function createScopedWindow(realWindow, scopedBridge) {
  const bound = new WeakMap()
  const scopedApis = new WeakMap()
  const target = {}
  let proxy
  const handler = {
    get(_target, key) {
      if (key === '__ztoolsElectron') return scopedBridge
      if (key === 'window' || key === 'self' || key === 'globalThis') return proxy
      const value = Reflect.get(realWindow, key)
      if (key === 'ztools' && value?.sys && typeof value.sys.managePowerSession === 'function') {
        if (!scopedApis.has(value)) {
          // 只为新增的会话型 API 绑定插件通道，不改变已有 SDK 方法的返回契约。
          const transport = { call: async (method, params) => {
            const call = scopedBridge?.transport?.methods?.[method]
            if (typeof call !== 'function') throw new Error(`宿主不支持方法: ${method}`)
            return call({ params })
          } }
          const sys = Object.create(value.sys)
          Object.defineProperty(sys, 'managePowerSession', {
            value: options => value.sys.managePowerSession.call({ transport }, options)
          })
          const sdk = Object.create(value)
          Object.defineProperty(sdk, 'sys', { value: sys })
          scopedApis.set(value, sdk)
        }
        return scopedApis.get(value)
      }
      if (typeof value === 'function' && !('prototype' in value)) {
        let wrapped = bound.get(value)
        if (!wrapped) {
          wrapped = value.bind(realWindow)
          bound.set(value, wrapped)
        }
        return wrapped
      }
      return value
    },
    set(_target, key, value) {
      if (key === '__ztoolsElectron') return false
      return Reflect.set(realWindow, key, value)
    },
    has(_target, key) {
      return key === '__ztoolsElectron' || Reflect.has(realWindow, key)
    },
    deleteProperty(_target, key) {
      if (key === '__ztoolsElectron') return false
      return Reflect.deleteProperty(realWindow, key)
    },
    ownKeys() {
      const keys = Reflect.ownKeys(realWindow)
      return keys.includes('__ztoolsElectron') ? keys : [...keys, '__ztoolsElectron']
    },
    getOwnPropertyDescriptor(_target, key) {
      if (key === '__ztoolsElectron') {
        return { value: scopedBridge, writable: false, enumerable: true, configurable: true }
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(realWindow, key)
      if (!descriptor) return undefined
      // 在 target 上定义过的不可配置属性必须如实报告
      const own = Reflect.getOwnPropertyDescriptor(target, key)
      if (own && own.configurable === false) return own
      return { ...descriptor, configurable: true }
    },
    defineProperty(_target, key, descriptor) {
      if (key === '__ztoolsElectron') return false
      const ok = Reflect.defineProperty(realWindow, key, descriptor)
      // 不可配置属性必须同时存在于 target 上，否则违反 Proxy 不变式
      if (ok && descriptor.configurable === false) Reflect.defineProperty(target, key, descriptor)
      return ok
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(realWindow)
    }
  }
  proxy = new Proxy(target, handler)
  return proxy
}
