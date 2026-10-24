/**
 * 声明式插件会话归属：作用域 window（真实 contextBridge 冻结语义）、引用计数 holder、
 * 插件专属通道、SecureStorage / terminateProcess 与 LocalStorage 明文迁移。
 * 宿主用内存替身实现 preload 同形的 transport.methods（返回 { success, data | error } 信封）。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { ZToolsHostError } from '@ztools/declarative-ui'
import {
  createPluginSessionHolder,
  createScopedHostBridge,
  createScopedWindow,
  SESSION_RELEASE_GRACE_MS
} from '../pluginSession.js'
import { createPluginHostApis } from '../pluginSecureStorage.js'
import { useDeclarativePluginSession } from '../composables/useDeclarativePluginSession.js'
import { loadInstalledDeclarativePlugin } from '../../utils/declarativePluginLoader.js'
import { createScopedLocalStorage } from '../../utils/pluginStorage.js'

const TOKEN_A = 'A'.repeat(43)

/** 内存宿主：记录每个信封，按令牌查归属；行为与主进程契约一致（未归属的 credential 调用报 PLUGIN_IDENTITY_REQUIRED） */
function createFakeHost() {
  const calls = []
  const sessions = new Map()
  const credentials = new Map()
  const db = new Map()
  let seq = 0
  const failures = new Map()
  const state = { encryption: 'available', openDelayMs: 0, openFails: false }
  const ok = (data) => ({ success: true, data })
  const fail = (code, message = code, details) => ({ success: false, error: { code, message, ...(details ? { details } : {}) } })
  const owner = (envelope) => sessions.get(envelope.pluginSession)?.pluginId
  const handlers = {
    async declarative_session_open(envelope) {
      if (state.openDelayMs) await new Promise((resolve) => setTimeout(resolve, state.openDelayMs))
      if (state.openFails) return fail('PLUGIN_NOT_FOUND', '插件已禁用')
      seq += 1
      const token = String(seq).padStart(43, 'T')
      const sessionId = `ds_${String(seq).padStart(16, '0')}`
      sessions.set(token, { pluginId: envelope.params.pluginId, sessionId })
      return ok({ success: true, data: { token, sessionId, pluginId: envelope.params.pluginId, permissions: [] } })
    },
    async declarative_session_close(envelope) {
      for (const [token, session] of sessions) if (session.sessionId === envelope.params.sessionId) sessions.delete(token)
      return ok({ success: true })
    },
    async credential_v1_status(envelope) {
      if (!owner(envelope)) return fail('PLUGIN_IDENTITY_REQUIRED')
      return ok({ success: true, data: state.encryption === 'available' ? { status: 'available' } : { status: 'unavailable', reason: state.encryption } })
    },
    async credential_v1_get(envelope) {
      const pluginId = owner(envelope)
      if (!pluginId) return fail('PLUGIN_IDENTITY_REQUIRED')
      if (state.encryption !== 'available') return fail('NOT_SUPPORTED', '安全凭据存储当前不可用')
      const key = `${pluginId}:${envelope.params.key}`
      return ok({ success: true, data: credentials.has(key) ? { status: 'present', value: credentials.get(key) } : { status: 'missing' } })
    },
    async credential_v1_set(envelope) {
      const pluginId = owner(envelope)
      if (!pluginId) return fail('PLUGIN_IDENTITY_REQUIRED')
      if (state.encryption !== 'available') return fail('NOT_SUPPORTED', '安全凭据存储当前不可用')
      const key = `${pluginId}:${envelope.params.key}`
      if (envelope.params.ifAbsent && credentials.has(key)) return ok({ success: true, data: 'EXISTS' })
      credentials.set(key, envelope.params.value)
      return ok({ success: true, data: 'OK' })
    },
    async credential_v1_delete(envelope) {
      const pluginId = owner(envelope)
      if (!pluginId) return fail('PLUGIN_IDENTITY_REQUIRED')
      credentials.delete(`${pluginId}:${envelope.params.key}`)
      return ok({ success: true, data: 'OK' })
    },
    async db_get(envelope) {
      const key = `${envelope.params.plugin_id}:${envelope.params.key}`
      return db.has(key) ? ok({ success: true, data: db.get(key) }) : fail('DATABASE_KEY_NOT_FOUND')
    },
    async db_put(envelope) {
      db.set(`${envelope.params.plugin_id}:${envelope.params.key}`, envelope.params.value)
      return ok({ success: true, data: 'OK' })
    },
    async db_compare_and_set(envelope) {
      const key = `${envelope.params.plugin_id}:${envelope.params.key}`
      const matches = (db.get(key) ?? null) === envelope.params.expectedValue
      if (matches) db.set(key, envelope.params.value)
      return ok({ success: true, data: matches })
    },
    async db_delete(envelope) {
      db.delete(`${envelope.params.plugin_id}:${envelope.params.key}`)
      return ok({ success: true, data: 'OK' })
    },
    async db_compact(envelope) {
      if (owner(envelope) !== envelope.params.plugin_id) return fail('PLUGIN_IDENTITY_REQUIRED')
      return ok({ success: true, data: { compacted: true, scheduled: false } })
    },
    async process_terminate_pid(envelope) {
      if (!owner(envelope)) return fail('PLUGIN_IDENTITY_REQUIRED')
      if (envelope.params.pid === 4) return fail('PROCESS_PROTECTED', '系统关键进程受保护', { reason: 'system', pid: 4 })
      if (envelope.params.pid === 77) return fail('PROCESS_TERMINATE_TIMEOUT', '超时', { stillRunning: [77] })
      return ok({ success: true, data: { pid: envelope.params.pid, mode: envelope.params.mode, tree: false, terminated: [envelope.params.pid] } })
    },
    async clipboard_read_text() {
      return ok({ success: true, data: 'clip' })
    }
  }
  const methods = {}
  for (const [name, handler] of Object.entries(handlers)) {
    methods[name] = vi.fn(async (envelope) => {
      calls.push({ method: name, envelope })
      const injected = failures.get(name)
      if (injected) {
        failures.delete(name)
        return fail(injected)
      }
      return handler(envelope)
    })
  }
  const setMessageCallback = vi.fn()
  const bridge = Object.freeze({
    contractVersion: 1,
    app: Object.freeze({ ready: vi.fn() }),
    transport: Object.freeze({ methods: Object.freeze(methods), setMessageCallback })
  })
  return { bridge, methods, calls, sessions, credentials, db, state, failures, setMessageCallback }
}

let host

beforeAll(() => {
  host = createFakeHost()
  // 与 contextBridge.exposeInMainWorld 相同的冻结语义：writable:false + configurable:false
  Object.defineProperty(window, '__ztoolsElectron', { value: host.bridge, writable: false, configurable: false, enumerable: true })
})

afterEach(() => {
  vi.useRealTimers()
  host.calls.length = 0
  host.state.encryption = 'available'
  host.state.openDelayMs = 0
  host.state.openFails = false
  host.failures.clear()
  host.credentials.clear()
  host.db.clear()
  globalThis.localStorage?.clear?.()
})

function pluginFiles(source) {
  return async (_pluginId, relPath) => {
    if (relPath === 'plugin.json') return JSON.stringify({ id: 'probe', name: 'Probe', entry: 'dist/index.js', permissions: [] })
    if (relPath === 'dist/index.js') return source
    throw Object.assign(new Error(`missing ${relPath}`), { code: 'PLUGIN_RESOURCE_NOT_FOUND' })
  }
}

async function loadProbe(source, holder) {
  return loadInstalledDeclarativePlugin('probe', { readFile: pluginFiles(source), sessionHolder: holder })
}

describe('作用域 window：真实 contextBridge 冻结语义下不触发 Proxy 不变式', () => {
  it('以真实 window 作 Proxy target 改写 __ztoolsElectron 会抛 TypeError（复现评审 B1）', () => {
    const naive = new Proxy(window, { get: (target, key) => (key === '__ztoolsElectron' ? {} : Reflect.get(target, key)) })
    expect(() => naive.__ztoolsElectron).toThrow(TypeError)
  })

  it('插件代码通过 window / globalThis / self 调宿主都自动带令牌；非信封调用按 preload 规则规范化', async () => {
    const holder = createPluginSessionHolder('probe')
    const release = await holder.acquire()
    const exportsHolder = await loadInstalledDeclarativePlugin('probe', {
      readFile: pluginFiles(`
        exports.default = async function Probe() {
          const a = await window.__ztoolsElectron.transport.methods.clipboard_read_text({ messageId: 'm-1', params: {} })
          const b = await globalThis.__ztoolsElectron.transport.methods.clipboard_read_text({ any: 1 })
          const c = await self.__ztoolsElectron.transport.methods.credential_v1_status({ messageId: 'm-3', params: {}, timeoutMs: 500 })
          return [a, b, c]
        }
      `),
      sessionHolder: holder
    })
    const [a, b, c] = await exportsHolder.command()
    expect(a.success).toBe(true)
    expect(b.success).toBe(true)
    expect(c.data.data).toEqual({ status: 'available' })
    const envelopes = host.calls.filter((item) => item.method !== 'declarative_session_open').map((item) => item.envelope)
    expect(envelopes[0]).toEqual({ messageId: 'm-1', params: {}, pluginSession: holder.token })
    expect(envelopes[1].params).toEqual({ any: 1 })
    expect(envelopes[1].messageId).toMatch(/^scoped:\d+:\d+$/)
    expect(envelopes[1].pluginSession).toBe(holder.token)
    expect(envelopes[2]).toEqual({ messageId: 'm-3', params: {}, timeoutMs: 500, pluginSession: holder.token })
    release()
  })

  it('原生方法可用且绑定结果稳定；构造函数保留静态成员；in / 描述符 / 枚举 / instanceof 不抛错', async () => {
    const holder = createPluginSessionHolder('probe')
    globalThis.__realWindowProbe = window
    const loaded = await loadProbe(`
      const topThis = this
      exports.default = function Probe() {
        const results = {}
        results.sameTimeout = window.setTimeout === window.setTimeout
        const timer = window.setTimeout(() => {}, 0)
        window.clearTimeout(timer)
        results.timerType = timer !== undefined
        results.url = new window.URL('https://example.com/a?b=1').searchParams.get('b')
        results.promise = typeof window.Promise.resolve
        results.has = '__ztoolsElectron' in window
        results.descriptorConfigurable = Object.getOwnPropertyDescriptor(window, '__ztoolsElectron').configurable
        results.keys = Object.keys(window).includes('__ztoolsElectron')
        results.instance = Object.getPrototypeOf(window) === Object.getPrototypeOf(__realWindowProbe)
        results.selfIsWindow = self === window && globalThis === window && window.window === window
        results.thisIsScoped = topThis === window
        results.document = typeof window.document.createElement
        window.__probeCustom = 42
        results.custom = window.__probeCustom
        return results
      }
    `, holder)
    const results = loaded.command()
    expect(results).toEqual({
      sameTimeout: true, timerType: true, url: '1', promise: 'function', has: true,
      descriptorConfigurable: true, keys: true, instance: true, selfIsWindow: true, thisIsScoped: true,
      document: 'function', custom: 42
    })
    expect(window.__probeCustom).toBe(42)
    delete window.__probeCustom
  })

  it('插件改写 / 删除 __ztoolsElectron 不影响作用域桥；顶层 const self 不语法冲突；setMessageCallback 被拦截', async () => {
    const holder = createPluginSessionHolder('probe')
    const release = await holder.acquire()
    const loaded = await loadProbe(`
      const self = 'shadowed-by-plugin'
      exports.default = async function Probe() {
        let assignThrew = false
        try { 'use strict'; window.__ztoolsElectron = { transport: { methods: {} } } } catch { assignThrew = true }
        const deleted = delete window.__ztoolsElectron
        window.__ztoolsElectron.transport.setMessageCallback(() => {})
        const res = await window.__ztoolsElectron.transport.methods.clipboard_read_text({ messageId: 'm-9', params: {} })
        return { self, deleted, res }
      }
    `, holder)
    const result = await loaded.command()
    expect(result.self).toBe('shadowed-by-plugin')
    expect(result.deleted).toBe(false)
    expect(result.res.success).toBe(true)
    expect(host.setMessageCallback).not.toHaveBeenCalled()
    expect(host.calls.at(-1).envelope.pluginSession).toBe(holder.token)
    release()
  })
})

describe('会话 holder：引用计数、宽限期、在途调用、失败重试', () => {
  it('两次 acquire 只打开一次；全部 release 后宽限期结束才关闭；宽限期内再 acquire 复用', async () => {
    vi.useFakeTimers()
    const holder = createPluginSessionHolder('probe', { graceMs: 100 })
    const [releaseA, releaseB] = await Promise.all([holder.acquire(), holder.acquire()])
    expect(host.calls.filter((item) => item.method === 'declarative_session_open')).toHaveLength(1)
    const token = holder.token
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    releaseA()
    releaseA()
    expect(holder.refs).toBe(1)
    releaseB()
    expect(holder.token).toBe(token)
    await vi.advanceTimersByTimeAsync(50)
    const releaseC = await holder.acquire()
    await vi.advanceTimersByTimeAsync(200)
    expect(holder.token).toBe(token)
    expect(host.calls.filter((item) => item.method === 'declarative_session_close')).toHaveLength(0)
    releaseC()
    await vi.advanceTimersByTimeAsync(150)
    expect(holder.token).toBe(null)
    expect(host.calls.filter((item) => item.method === 'declarative_session_close')).toHaveLength(1)
  })

  it('卸载过程中发出的保存调用仍带令牌；在途调用结束后才关闭（最长 2 秒）', async () => {
    vi.useFakeTimers()
    const holder = createPluginSessionHolder('probe', { graceMs: 10, settleMaxMs: 2_000 })
    const release = await holder.acquire()
    const bridge = createScopedHostBridge(holder, host.bridge)
    let finish
    host.methods.credential_v1_set.mockImplementationOnce(async (envelope) => {
      host.calls.push({ method: 'credential_v1_set', envelope })
      await new Promise((resolve) => { finish = resolve })
      return { success: true, data: { success: true, data: 'OK' } }
    })
    release()
    // 模拟插件 effect cleanup：release 之后立即保存
    const saving = bridge.transport.methods.credential_v1_set({ messageId: 'save', params: { key: 'k', value: 'v' } })
    await vi.advanceTimersByTimeAsync(500)
    expect(host.calls.find((item) => item.method === 'credential_v1_set').envelope.pluginSession).toBeTruthy()
    expect(host.calls.filter((item) => item.method === 'declarative_session_close')).toHaveLength(0)
    finish()
    await saving
    await vi.advanceTimersByTimeAsync(10)
    expect(host.calls.filter((item) => item.method === 'declarative_session_close')).toHaveLength(1)
  })

  it('在途调用一直不结束：最多等 2 秒仍会关闭会话', async () => {
    vi.useFakeTimers()
    const holder = createPluginSessionHolder('probe', { graceMs: 10, settleMaxMs: 2_000 })
    const release = await holder.acquire()
    void holder.track(() => new Promise(() => {}))
    release()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(holder.token).not.toBe(null)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(holder.token).toBe(null)
  })

  it('打开失败不阻塞渲染，下次 acquire 重试；打开途中全部释放则立即关闭不留残留', async () => {
    const holder = createPluginSessionHolder('probe', { graceMs: 0 })
    host.state.openFails = true
    const release = await holder.acquire()
    expect(holder.token).toBe(null)
    expect(holder.lastError?.code).toBe('PLUGIN_NOT_FOUND')
    release()
    host.state.openFails = false
    const release2 = await holder.acquire()
    expect(holder.token).toBeTruthy()
    release2()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const openSessionsOf = (pluginId) => [...host.sessions.values()].filter((item) => item.pluginId === pluginId).length
    host.state.openDelayMs = 30
    const slowHolder = createPluginSessionHolder('slow-probe', { graceMs: 0 })
    const releaseSlow = await slowHolder.acquire()
    releaseSlow()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(openSessionsOf('slow-probe')).toBe(0)
    // 打开途中全部释放：open 返回后立即关闭
    const racing = createPluginSessionHolder('racing', { graceMs: 0 })
    const pendingAcquire = racing.acquire()
    const pendingOpen = racing.pending
    pendingAcquire.then((release) => release())
    await pendingOpen
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(openSessionsOf('racing')).toBe(0)
  })

  it('作用域通道在会话打开中等待令牌，首个调用不丢归属；没有会话时不带令牌（与改动前一致）', async () => {
    host.state.openDelayMs = 20
    const holder = createPluginSessionHolder('probe')
    const bridge = createScopedHostBridge(holder, host.bridge)
    const acquiring = holder.acquire()
    const result = await bridge.transport.methods.clipboard_read_text({ messageId: 'first', params: {} })
    expect(result.success).toBe(true)
    expect(host.calls.find((item) => item.envelope.messageId === 'first').envelope.pluginSession).toBe(holder.token)
    const release = await acquiring
    release()
    const idle = createPluginSessionHolder('idle')
    const idleBridge = createScopedHostBridge(idle, host.bridge)
    await idleBridge.transport.methods.clipboard_read_text({ messageId: 'anon', params: {} })
    expect(host.calls.find((item) => item.envelope.messageId === 'anon').envelope).toEqual({ messageId: 'anon', params: {} })
  })

  it('挂载点：插件对象一出现就同步 acquire，换插件释放旧会话，卸载释放', async () => {
    const holderA = createPluginSessionHolder('plugin-a', { graceMs: 0 })
    const holderB = createPluginSessionHolder('plugin-b', { graceMs: 0 })
    const plugin = ref({ session: holderA })
    const App = defineComponent({
      setup() {
        useDeclarativePluginSession(plugin)
        return () => h('div')
      }
    })
    const app = createApp(App)
    app.mount(document.createElement('div'))
    expect(holderA.refs).toBe(1)
    expect(holderA.pending).toBeTruthy()
    await holderA.pending
    plugin.value = { session: holderB }
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(holderA.refs).toBe(0)
    expect(holderB.refs).toBe(1)
    await holderB.pending
    plugin.value = { name: '官方内置示例，没有 session' }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(holderB.refs).toBe(0)
    plugin.value = { session: holderA }
    app.unmount()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(holderA.refs).toBe(0)
  })
})

describe('SecureStorage / terminateProcess：走插件专属通道', () => {
  async function setup(pluginId = 'google-auth') {
    const holder = createPluginSessionHolder(pluginId)
    const release = await holder.acquire()
    const bridge = createScopedHostBridge(holder, host.bridge)
    const apis = createPluginHostApis({ pluginId, methods: bridge.transport.methods })
    return { holder, release, apis, local: createScopedLocalStorage(pluginId) }
  }

  it('status 映射：可用 / 系统不可用 / 宿主过旧 / 未归属', async () => {
    const { apis, release } = await setup()
    expect(await apis.SecureStorage.status()).toEqual({ available: true })
    host.state.encryption = 'insecure-backend'
    expect(await apis.SecureStorage.status()).toEqual({ available: false, reason: 'insecure-backend' })
    const unattributed = createPluginHostApis({ pluginId: 'google-auth' })
    expect(await unattributed.SecureStorage.status()).toEqual({ available: false, reason: 'identity-required' })
    const oldHost = createPluginHostApis({ pluginId: 'google-auth', methods: {} })
    expect(await oldHost.SecureStorage.status()).toEqual({ available: false, reason: 'host-unsupported' })
    release()
  })

  it('读写删、JSON 往返、超大值、非法 key、不可序列化值、加密不可用绝不写明文', async () => {
    const { apis, release } = await setup()
    await apis.SecureStorage.setItem('accounts.v1', [{ secret: 'JBSWY3DP', issuer: 'G' }])
    expect(await apis.SecureStorage.getItem('accounts.v1')).toEqual([{ secret: 'JBSWY3DP', issuer: 'G' }])
    expect(await apis.SecureStorage.getItem('missing')).toBeUndefined()
    await expect(apis.SecureStorage.setItem('big', 'x'.repeat(64 * 1024))).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' })
    await expect(apis.SecureStorage.setItem('../evil', 1)).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' })
    await expect(apis.SecureStorage.setItem('fn', () => 1)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const circular = {}
    circular.self = circular
    await expect(apis.SecureStorage.setItem('circular', circular)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    host.credentials.set('google-auth:corrupt', '{not json')
    await expect(apis.SecureStorage.getItem('corrupt')).rejects.toMatchObject({ code: 'DATA_CORRUPT' })

    host.state.encryption = 'insecure-backend'
    const dbBefore = new Map(host.db)
    await expect(apis.SecureStorage.setItem('accounts.v1', [])).rejects.toBeInstanceOf(ZToolsHostError)
    await expect(apis.SecureStorage.setItem('accounts.v1', [])).rejects.toMatchObject({ code: 'SECURE_STORAGE_UNAVAILABLE' })
    expect(host.db).toEqual(dbBefore)
    expect(globalThis.localStorage.length).toBe(0)
    host.state.encryption = 'available'
    await apis.SecureStorage.removeItem('accounts.v1')
    expect(await apis.SecureStorage.getItem('accounts.v1')).toBeUndefined()
    release()
  })

  it('importFromLocalStorage 四个分支：不存在 / 迁移 / 已迁移 / 两边不同交给插件合并', async () => {
    const { apis, local, release } = await setup()
    expect(await apis.SecureStorage.importFromLocalStorage('google-auth.accounts.v1')).toEqual({ status: 'not-found' })

    // 旧明文同时在宿主库与浏览器旧键
    await local.setItem('google-auth.accounts.v1', [{ secret: 'S1' }])
    globalThis.localStorage.setItem('raycast_google-auth.accounts.v1', JSON.stringify([{ secret: 'S1' }]))
    expect(await apis.SecureStorage.importFromLocalStorage('google-auth.accounts.v1')).toEqual({ status: 'imported', value: [{ secret: 'S1' }] })
    expect(host.db.has('google-auth:ls:google-auth.accounts.v1')).toBe(false)
    expect(globalThis.localStorage.getItem('raycast_google-auth.accounts.v1')).toBe(null)
    expect(host.calls.some((item) => item.method === 'db_compact' && item.envelope.pluginSession)).toBe(true)
    expect(await local.getItem('google-auth.accounts.v1')).toBeUndefined()

    expect(await apis.SecureStorage.importFromLocalStorage('google-auth.accounts.v1')).toEqual({ status: 'kept-secure', value: [{ secret: 'S1' }] })

    // 降级到旧版插件又写了明文：相同 → 直接删明文；不同 → 返回 legacyValue，由插件合并
    await local.setItem('google-auth.accounts.v1', [{ secret: 'S1' }])
    expect((await apis.SecureStorage.importFromLocalStorage('google-auth.accounts.v1')).legacyValue).toBeUndefined()
    expect(host.db.has('google-auth:ls:google-auth.accounts.v1')).toBe(false)
    await local.setItem('google-auth.accounts.v1', [{ secret: 'S2' }])
    expect(await apis.SecureStorage.importFromLocalStorage('google-auth.accounts.v1')).toEqual({
      status: 'kept-secure', value: [{ secret: 'S1' }], legacyValue: [{ secret: 'S2' }]
    })
    expect(host.db.has('google-auth:ls:google-auth.accounts.v1')).toBe(true)
    await apis.SecureStorage.setItem('google-auth.accounts.v1', [{ secret: 'S1' }, { secret: 'S2' }])
    await apis.SecureStorage.discardLocalStorage('google-auth.accounts.v1')
    expect(host.db.has('google-auth:ls:google-auth.accounts.v1')).toBe(false)
    release()
  })

  it('迁移每一步失败都不删明文，可重入；另一个窗口抢先迁移（EXISTS）以加密存储为准', async () => {
    const { apis, local, release } = await setup()
    const key = 'google-auth.accounts.v1'
    await local.setItem(key, [{ secret: 'P' }])

    host.failures.set('credential_v1_set', 'STORAGE_ERROR')
    await expect(apis.SecureStorage.importFromLocalStorage(key)).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
    expect(host.db.has(`google-auth:ls:${key}`)).toBe(true)

    // 写入成功但读回不一致
    host.methods.credential_v1_get.mockImplementationOnce(async () => ({ success: true, data: { success: true, data: { status: 'missing' } } }))
    host.methods.credential_v1_get.mockImplementationOnce(async () => ({ success: true, data: { success: true, data: { status: 'present', value: '"tampered"' } } }))
    await expect(apis.SecureStorage.importFromLocalStorage(key)).rejects.toMatchObject({ code: 'MIGRATION_VERIFY_FAILED' })
    expect(host.db.has(`google-auth:ls:${key}`)).toBe(true)
    host.credentials.clear()

    // 删除明文失败：加密值已在，明文也还在；重入后两边相同 → 删明文
    host.failures.set('db_delete', 'STORAGE_ERROR')
    await expect(apis.SecureStorage.importFromLocalStorage(key)).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
    expect(host.db.has(`google-auth:ls:${key}`)).toBe(true)
    expect(host.credentials.get(`google-auth:${key}`)).toBe(JSON.stringify([{ secret: 'P' }]))
    expect(await apis.SecureStorage.importFromLocalStorage(key)).toEqual({ status: 'kept-secure', value: [{ secret: 'P' }] })
    expect(host.db.has(`google-auth:ls:${key}`)).toBe(false)

    // 压缩失败不影响迁移结果
    host.credentials.clear()
    await local.setItem(key, [{ secret: 'Q' }])
    host.failures.set('db_compact', 'STORAGE_ERROR')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await apis.SecureStorage.importFromLocalStorage(key)).status).toBe('imported')
    warn.mockRestore()

    // 另一个窗口在本窗口读 S 之后、写入之前完成了迁移并新增了账号
    host.credentials.clear()
    await local.setItem(key, [{ secret: 'OLD' }])
    host.methods.credential_v1_get.mockImplementationOnce(async () => ({ success: true, data: { success: true, data: { status: 'missing' } } }))
    host.credentials.set(`google-auth:${key}`, JSON.stringify([{ secret: 'OLD' }, { secret: 'NEW' }]))
    expect(await apis.SecureStorage.importFromLocalStorage(key)).toEqual({
      status: 'kept-secure', value: [{ secret: 'OLD' }, { secret: 'NEW' }], legacyValue: [{ secret: 'OLD' }]
    })
    expect(host.credentials.get(`google-auth:${key}`)).toBe(JSON.stringify([{ secret: 'OLD' }, { secret: 'NEW' }]), '新数据不会被旧明文覆盖')
    release()
  })

  it('同一 key 的并发迁移在渲染侧串行，只写入一次', async () => {
    const { apis, local, release } = await setup()
    await local.setItem('k1', { v: 1 })
    const results = await Promise.all([apis.SecureStorage.importFromLocalStorage('k1'), apis.SecureStorage.importFromLocalStorage('k1')])
    expect(results.map((item) => item.status)).toEqual(['imported', 'kept-secure'])
    expect(host.calls.filter((item) => item.method === 'credential_v1_set')).toHaveLength(1)
    release()
  })

  it('terminateProcess：带令牌、IPC 超时 = 等待时间 + 5 秒、错误码与 details 透传、宿主过旧报 HOST_FEATURE_UNAVAILABLE', async () => {
    const { apis, release } = await setup('kill-process')
    expect(await apis.terminateProcess(1234, { mode: 'force', tree: true, expectedName: 'sleep' })).toEqual({
      pid: 1234, mode: 'force', tree: false, terminated: [1234]
    })
    const envelope = host.calls.find((item) => item.method === 'process_terminate_pid').envelope
    expect(envelope.params).toEqual({ pid: 1234, mode: 'force', tree: true, expectedName: 'sleep' })
    expect(envelope.timeoutMs).toBe(7_000)
    expect(envelope.pluginSession).toBeTruthy()
    await apis.terminateProcess(55, { timeoutMs: 10_000 })
    expect(host.calls.filter((item) => item.method === 'process_terminate_pid').at(-1).envelope.timeoutMs).toBe(15_000)
    await expect(apis.terminateProcess(4, { mode: 'force' })).rejects.toMatchObject({
      name: 'ZToolsHostError', code: 'PROCESS_PROTECTED', details: { reason: 'system', pid: 4 }
    })
    await expect(apis.terminateProcess(77)).rejects.toMatchObject({ code: 'PROCESS_TERMINATE_TIMEOUT', details: { stillRunning: [77] } })
    for (const pid of [0, 1, -5, 1.5, '12', 2 ** 32]) await expect(apis.terminateProcess(pid)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    const unattributed = createPluginHostApis({ pluginId: 'kill-process' })
    await expect(unattributed.terminateProcess(1234)).rejects.toMatchObject({ code: 'PLUGIN_IDENTITY_REQUIRED' })
    const oldHost = createPluginHostApis({ pluginId: 'kill-process', methods: {} })
    await expect(oldHost.terminateProcess(1234)).rejects.toMatchObject({ code: 'HOST_FEATURE_UNAVAILABLE' })
    release()
  })
})

describe('LocalStorage 删除不复活', () => {
  it('removeItem 同时删除浏览器旧键，之后 getItem 不会把旧值迁移回来', async () => {
    const local = createScopedLocalStorage('memo')
    globalThis.localStorage.setItem('raycast_notes', JSON.stringify(['old']))
    expect(await local.getItem('notes')).toEqual(['old'])
    await local.removeItem('notes')
    expect(globalThis.localStorage.getItem('raycast_notes')).toBe(null)
    expect(await local.getItem('notes')).toBeUndefined()
  })
})

describe('宽限期常量', () => {
  it('宽限期足够覆盖一次同步卸载的保存调用', () => {
    expect(SESSION_RELEASE_GRACE_MS).toBeGreaterThanOrEqual(100)
    expect(createScopedWindow).toBeTypeOf('function')
    expect(TOKEN_A).toHaveLength(43)
  })
})
