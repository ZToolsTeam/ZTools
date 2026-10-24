/**
 * 独立窗口带状态（usePopoutState）：校验 / 打包 / 取走的纯函数，DeclarativeView 根页面初值，
 * 以及 DeclarativePage 的弹出与独立窗口加载流程（真实 SDK 运行时 + 与主进程契约同形的 transport 替身）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { Detail, Action, ActionPanel, usePopoutState } from '@ztools/declarative-ui'
import {
  _resetLocalHandoffsForTesting,
  buildPopoutHandoff,
  checkPopoutValue,
  createHandoffId,
  isHandoffId,
  parsePopoutState,
  POPOUT_PATHS_MAX,
  POPOUT_STATE_MAX_BYTES,
  requestPopoutWindow,
  stashLocalHandoff,
  takePopoutHandoff
} from '../popoutHandoff.js'
import DeclarativeView from '../DeclarativeView.vue'
import { _resetKeymapForTesting } from '@/utils/keymap'

// ---------------------------------------------------------------------------
// 测试插件：根页面用 usePopoutState 保存文本与目录，二级页面也用一个（不应被带走）
// ---------------------------------------------------------------------------
const probe = vi.hoisted(() => ({ setText: null, setDir: null, push: null, renders: [] }))

function ChildPage() {
  const [child] = usePopoutState('child', 'child-init')
  return Detail({ markdown: `child:${child}` })
}

function ProbeRoot() {
  const [text, setText] = usePopoutState('text', 'init')
  const [dir, setDir] = usePopoutState('dir', '', { paths: (v) => (v ? [v] : []) })
  probe.setText = setText
  probe.setDir = setDir
  probe.renders.push(text)
  return Detail({
    markdown: `text:${text}|dir:${dir}`,
    actions: ActionPanel({}, [Action.Push({ title: '下一页', target: ChildPage })])
  })
}

const { routeState, mockPush } = vi.hoisted(() => ({
  routeState: { value: null },
  mockPush: vi.fn()
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useRoute: () => routeState.value,
    useRouter: () => ({ push: mockPush, back: vi.fn(), resolve: (loc) => ({ fullPath: String(loc?.name || '') }) })
  }
})

vi.mock('@/router', () => ({ default: { push: mockPush, replace: vi.fn(), currentRoute: { value: { name: 'my', path: '/' } } } }))

vi.mock('@/utils/officialPlugins', async (importOriginal) => {
  const actual = await importOriginal()
  const plugin = { pluginId: 'popout-probe', id: 'popout-probe', name: '交接探针', faIcon: 'fa-cube', command: ProbeRoot }
  return { ...actual, getOfficialPlugin: (id) => (id === 'popout-probe' ? plugin : actual.getOfficialPlugin(id)) }
})

vi.mock('@/utils/pluginVisibility', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, isPluginVisible: (value) => (value === 'popout-probe' || value === 'late-probe' ? true : actual.isPluginVisible(value)) }
})

// 已安装插件：代码加载慢于取交接状态
const lateLoad = vi.hoisted(() => ({ resolve: null }))
vi.mock('@/utils/declarativePluginLoader', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getCachedDeclarativePlugin: (id, options) => (id === 'late-probe' ? null : actual.getCachedDeclarativePlugin(id, options)),
    loadInstalledDeclarativePlugin: (id, options) => id === 'late-probe'
      ? new Promise((resolve) => { lateLoad.resolve = () => resolve({ pluginId: 'late-probe', id: 'late-probe', name: '慢加载', command: ProbeRoot }) })
      : actual.loadInstalledDeclarativePlugin(id, options)
  }
})

const { default: DeclarativePage } = await import('@/pages/DeclarativePage.vue')

/** 与 preload 同形的 transport.methods：返回 { success, data | error } 信封 */
function installFakeHost(handlers) {
  const calls = []
  const methods = {}
  for (const [name, handler] of Object.entries(handlers)) {
    methods[name] = async (envelope) => {
      calls.push({ method: name, params: envelope.params, timeoutMs: envelope.timeoutMs })
      try {
        return { success: true, data: await handler(envelope.params) }
      } catch (error) {
        return { success: false, error: { code: error.code || 'INTERNAL_ERROR', message: error.message } }
      }
    }
  }
  Object.defineProperty(window, '__ztoolsElectron', {
    value: { transport: { methods } },
    writable: false,
    configurable: true
  })
  return calls
}

function hostError(code, message = code) {
  return Object.assign(new Error(message), { code })
}

async function settle() {
  for (let i = 0; i < 8; i++) {
    await flushPromises()
    await nextTick()
  }
}

function setRoute({ name = 'declarative', pluginId = 'popout-probe', query = {} } = {}) {
  routeState.value = reactive({ name, params: { pluginId }, query })
  return routeState.value
}

let pinia = null
function mountWith(component, props) {
  return mount(component, { props, global: { plugins: [pinia] } })
}

beforeEach(() => {
  _resetKeymapForTesting()
  _resetLocalHandoffsForTesting()
  pinia = createPinia()
  setActivePinia(pinia)
  mockPush.mockReset()
  probe.renders.length = 0
})

afterEach(() => {
  delete window.__ztoolsElectron
  vi.useRealTimers()
})

describe('checkPopoutValue：只收纯 JSON，不偷偷转换', () => {
  it('接受普通对象 / 数组 / 原始值、Object.create(null)、共享引用（非循环）、对象属性为 undefined', () => {
    const shared = { a: 1 }
    for (const value of [null, true, 0, -1.5, '', '文本', [], [1, 'a', null], { a: { b: [shared, shared] } }, Object.assign(Object.create(null), { x: 1 }), { gone: undefined, kept: 1 }]) {
      expect(checkPopoutValue(value)).toEqual({ ok: true })
    }
  })

  it('拒绝函数 / Symbol / BigInt / 非有限数 / Date / Map / 类实例 / 循环 / 数组空位与 undefined / Symbol 键 / getter 抛错', () => {
    const cyclic = { a: {} }
    cyclic.a.back = cyclic
    const throwing = {}
    Object.defineProperty(throwing, 'x', { enumerable: true, get() { throw new Error('boom') } })
    class Model { constructor() { this.v = 1 } }
    const cases = [
      [() => 1, 'unsupported-function'],
      [{ fn: () => 1 }, 'unsupported-function'],
      [Symbol('s'), 'unsupported-symbol'],
      [10n, 'unsupported-bigint'],
      [NaN, 'non-finite-number'],
      [{ n: Infinity }, 'non-finite-number'],
      [new Date(), 'not-plain-object'],
      [new Map(), 'not-plain-object'],
      [new Model(), 'not-plain-object'],
      [cyclic, 'circular'],
      [[1, , 3], 'array-hole'], // eslint-disable-line no-sparse-arrays
      [[1, undefined], 'array-hole'],
      [{ [Symbol('k')]: 1 }, 'symbol-key'],
      [throwing, 'unreadable']
    ]
    for (const [value, reason] of cases) {
      expect(checkPopoutValue(value)).toEqual({ ok: false, reason })
    }
  })

  it('深度上限 32、节点上限 100k', () => {
    const nest = (depth) => {
      let value = 'leaf'
      for (let i = 0; i < depth; i++) value = [value]
      return value
    }
    expect(checkPopoutValue(nest(32)).ok).toBe(true)
    expect(checkPopoutValue(nest(33))).toEqual({ ok: false, reason: 'too-deep' })
    expect(checkPopoutValue(new Array(99_999).fill(0)).ok).toBe(true)
    expect(checkPopoutValue(new Array(100_000).fill(0))).toEqual({ ok: false, reason: 'too-many-nodes' })
  })
})

describe('buildPopoutHandoff / parsePopoutState', () => {
  it('不合格的项丢弃并记入 rejected；SDK 已拒绝的项也记入；顶层 undefined 静默跳过；只收合格项的路径', () => {
    const built = buildPopoutHandoff({
      entries: [
        { key: 'ok', value: { a: 1 }, paths: ['/Users/a/doc.txt', 'relative/x', '/Users/a/doc.txt', 'C:\\Data\\b.txt', '\\\\server\\share\\c', '/bad\0nul', 'x'.repeat(10), 7] },
        { key: 'fn', value: () => 1, paths: ['/should/not/transfer'] },
        { key: 'date', value: new Date(0) },
        { key: 'missing', value: undefined }
      ],
      rejected: ['paths-threw']
    })
    expect(built.keys).toEqual(['ok'])
    expect(built.rejected).toEqual(['paths-threw', 'fn', 'date'])
    expect(built.oversized).toBe(false)
    expect(built.paths).toEqual(['/Users/a/doc.txt', 'C:\\Data\\b.txt', '\\\\server\\share\\c'])
    const parsed = parsePopoutState(built.state)
    expect(parsed).toEqual({ seed: { ok: { a: 1 } }, rejected: ['paths-threw', 'fn', 'date'], oversized: false })
  })

  it('整体超过 256 KiB（按 UTF-8 字节）→ 整份不带，路径也不带', () => {
    const built = buildPopoutHandoff({
      entries: [{ key: 'big', value: '中'.repeat(Math.ceil(POPOUT_STATE_MAX_BYTES / 3) + 10), paths: ['/a'] }]
    })
    expect(built.oversized).toBe(true)
    expect(built.keys).toEqual([])
    expect(built.paths).toEqual([])
    expect(parsePopoutState(built.state)).toEqual({ seed: {}, rejected: [], oversized: true })
    expect(new TextEncoder().encode(built.state).length).toBeLessThan(1024)
  })

  it('路径条数 ≤ 2000、整个 window_open 请求序列化后 < 1 MiB（state 接近上限 + 大量长路径）', async () => {
    const paths = Array.from({ length: 3000 }, (_, i) => `/data/${i}/${'p'.repeat(300)}`)
    const built = buildPopoutHandoff({ entries: [{ key: 'list', value: paths, paths }] })
    expect(built.paths.length).toBeLessThanOrEqual(POPOUT_PATHS_MAX)
    const many = buildPopoutHandoff({ entries: [{ key: 'list', value: [], paths: Array.from({ length: 2500 }, (_, i) => `/p/${i}`) }] })
    expect(many.paths.length).toBe(POPOUT_PATHS_MAX)

    // 带引号的大 state：序列化后膨胀，路径预算相应收缩
    const quoted = '"'.repeat(POPOUT_STATE_MAX_BYTES / 2 - 64)
    let sent = null
    await requestPopoutWindow({
      pluginId: 'batch-rename',
      collected: { entries: [{ key: 'q', value: quoted, paths: Array.from({ length: 2000 }, (_, i) => `/very/long/${i}/${'q'.repeat(2000)}`) }] },
      call: async (method, params) => { sent = { method, params } }
    })
    const bytes = new TextEncoder().encode(JSON.stringify({ messageId: 'm', method: 'window_open', params: sent.params })).length
    expect(bytes).toBeLessThan(1024 * 1024)
    expect(sent.params.handoff.paths.length).toBeGreaterThan(0)
  })

  it('parsePopoutState 拒绝畸形文本', () => {
    for (const text of [undefined, 1, '', 'null', '[]', '{"entries":[]}', '{"entries":null}', '{oops', '{"v":1}']) {
      expect(parsePopoutState(text)).toBe(null)
    }
  })
})

describe('takePopoutHandoff / requestPopoutWindow', () => {
  const okResult = (state, more = {}) => ({ success: true, status: 'ok', pluginId: 'json-format', featureCode: '', state, ...more })
  const state = JSON.stringify({ v: 1, entries: { jsonText: '{}' }, rejected: ['fn'], oversized: false })

  it('ok：返回 seed 与提示；插件 ID / 功能码不符、none、state 畸形 → 不带状态', async () => {
    const id = createHandoffId()
    expect(isHandoffId(id)).toBe(true)
    const calls = []
    const call = async (method, params) => { calls.push([method, params]); return okResult(state) }
    expect(await takePopoutHandoff({ handoffId: id, pluginId: 'json-format', call })).toEqual({
      status: 'ok', seed: { jsonText: '{}' }, notice: '部分内容无法带到独立窗口'
    })
    expect(calls).toEqual([['window_popout_handoff_take', { handoffId: id }]])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect((await takePopoutHandoff({ handoffId: id, pluginId: 'crypto-tool', call })).status).toBe('mismatch')
    expect((await takePopoutHandoff({ handoffId: id, pluginId: 'json-format', featureCode: 'x', call })).status).toBe('mismatch')
    warn.mockRestore()
    expect((await takePopoutHandoff({ handoffId: id, pluginId: 'json-format', call: async () => ({ success: true, status: 'none' }) })).status).toBe('none')
    expect((await takePopoutHandoff({ handoffId: id, pluginId: 'json-format', call: async () => okResult('[1]') })).status).toBe('invalid')
    expect((await takePopoutHandoff({ handoffId: id, pluginId: 'json-format', call: async () => null })).status).toBe('none')
    // 非法编号不发请求
    const never = vi.fn()
    expect((await takePopoutHandoff({ handoffId: '../x', pluginId: 'json-format', call: never })).status).toBe('none')
    expect(never).not.toHaveBeenCalled()
  })

  it('失败与超时：宿主报错 → failed；宿主不返回 → 2 秒后 timeout，不会一直挂起', async () => {
    const id = createHandoffId()
    const failed = await takePopoutHandoff({ handoffId: id, pluginId: 'json-format', call: async () => { throw hostError('PERMISSION_DENIED') } })
    expect(failed.status).toBe('failed')
    const syncThrow = await takePopoutHandoff({ handoffId: id, pluginId: 'json-format', call: () => { throw hostError('HOST_METHOD_UNAVAILABLE') } })
    expect(syncThrow.status).toBe('failed')
    vi.useFakeTimers()
    const pending = takePopoutHandoff({ handoffId: id, pluginId: 'json-format', call: () => new Promise(() => {}) })
    await vi.advanceTimersByTimeAsync(1999)
    let settled = false
    pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await pending).toEqual({ status: 'timeout' })
  })

  it('同窗口兜底：内存里的交接只取一次，且优先于主进程', async () => {
    const id = createHandoffId()
    stashLocalHandoff(id, { pluginId: 'json-format', featureCode: '', state })
    const call = vi.fn(async () => okResult(JSON.stringify({ v: 1, entries: { jsonText: 'host' } })))
    expect((await takePopoutHandoff({ handoffId: id, pluginId: 'json-format', call })).seed).toEqual({ jsonText: '{}' })
    expect(call).not.toHaveBeenCalled()
    expect((await takePopoutHandoff({ handoffId: id, pluginId: 'json-format', call })).seed).toEqual({ jsonText: 'host' })
  })

  it('requestPopoutWindow：URL 编号与 handoff.id 一致、功能码同步；明确拒绝 → kept；宿主不支持 / 建窗失败 → fallback 并放进内存', async () => {
    let sent = null
    const opened = await requestPopoutWindow({
      pluginId: 'json-format',
      query: { q: 'a b', feature: 'fmt' },
      collected: { entries: [{ key: 'jsonText', value: '{"a":1}', paths: [] }], rejected: [] },
      call: async (method, params) => { sent = { method, params }; return { success: true } }
    })
    expect(opened.outcome).toBe('opened')
    expect(sent.method).toBe('window_open')
    const hash = new URL(sent.params.url).hash
    expect(hash.startsWith('#/popout/json-format?')).toBe(true)
    const query = new URLSearchParams(hash.split('?')[1])
    expect(query.get('handoff')).toBe(sent.params.handoff.id)
    expect(query.get('feature')).toBe('fmt')
    expect(query.get('q')).toBe('a b')
    expect(sent.params.handoff).toMatchObject({ pluginId: 'json-format', featureCode: 'fmt' })
    expect(sent.params.handoff.paths).toBeUndefined()
    expect(parsePopoutState(sent.params.handoff.state).seed).toEqual({ jsonText: '{"a":1}' })

    for (const code of ['PLUGIN_BUSY', 'INVALID_REQUEST', 'PERMISSION_DENIED', 'CANCELLED']) {
      const kept = await requestPopoutWindow({ pluginId: 'json-format', collected: null, call: async () => { throw hostError(code) } })
      expect(kept.outcome).toBe('kept')
      expect((await takePopoutHandoff({ handoffId: kept.handoffId, pluginId: 'json-format', call: async () => ({ status: 'none' }) })).status).toBe('none')
    }
    for (const code of ['HOST_METHOD_UNAVAILABLE', 'INTERNAL_ERROR', undefined]) {
      const fallback = await requestPopoutWindow({
        pluginId: 'json-format',
        collected: { entries: [{ key: 'jsonText', value: 'local' }] },
        call: async () => { throw hostError(code) }
      })
      expect(fallback.outcome).toBe('fallback')
      expect(fallback.query.handoff).toBe(fallback.handoffId)
      const taken = await takePopoutHandoff({ handoffId: fallback.handoffId, pluginId: 'json-format', call: async () => ({ status: 'none' }) })
      expect(taken.seed).toEqual({ jsonText: 'local' })
    }
  })

  it('搜索框内容很长（URL 超过 2048）：没接入交接状态的插件不发 window_open，同窗口放大且内容完整；接入的插件舍弃 q 后照常弹出', async () => {
    const longText = '时间戳'.repeat(1100) // 3300 字符，编码后远超 2048
    const calls = []
    const call = async (method, params) => { calls.push({ method, params }); return { success: true } }

    // 1. 没接入 usePopoutState（timestamp 等）：与接入前一致，走同窗口放大，q 原样保留
    const legacy = await requestPopoutWindow({ pluginId: 'timestamp', query: { q: longText, sel: 'row-1' }, collected: null, call })
    expect(legacy.outcome).toBe('fallback')
    expect(legacy.reason).toBe('url-too-long')
    expect(legacy.query.q).toBe(longText)
    expect(legacy.query.sel).toBe('row-1')
    expect(legacy.query.handoff).toBe(legacy.handoffId)
    expect(calls).toEqual([])

    // 2. 接入了（crypto-tool：输入本来就在交接状态里）：舍弃 q，URL 在上限内，其余短参数尽量保留
    const adopted = await requestPopoutWindow({
      pluginId: 'crypto-tool',
      query: { q: longText, seg: 'aes', feature: 'enc' },
      collected: { entries: [{ key: 'inputText', value: longText }] },
      call
    })
    expect(adopted.outcome).toBe('opened')
    expect(calls).toHaveLength(1)
    const { url, handoff } = calls[0].params
    expect(url.length).toBeLessThanOrEqual(2048)
    const query = new URLSearchParams(new URL(url).hash.split('?')[1])
    expect(query.get('q')).toBe(null)
    expect(query.get('seg')).toBe('aes')
    expect(query.get('feature')).toBe('enc')
    expect(query.get('handoff')).toBe(handoff.id)
    expect(adopted.query.q).toBeUndefined()
    expect(parsePopoutState(handoff.state).seed).toEqual({ inputText: longText })

    // 3. 状态整份超限（等于没有可带的状态）且 q 很长：同样走同窗口放大
    const oversized = await requestPopoutWindow({
      pluginId: 'json-format',
      query: { q: longText },
      collected: { entries: [{ key: 'jsonText', value: 'x'.repeat(300 * 1024) }] },
      call
    })
    expect(oversized.outcome).toBe('fallback')
    expect(calls).toHaveLength(1)
    const local = await takePopoutHandoff({ handoffId: oversized.handoffId, pluginId: 'json-format', call: async () => ({ status: 'none' }) })
    expect(local.notice).toBe('内容过大，独立窗口将重新开始')

    // 4. 刚好在上限内：不舍弃任何参数
    const base = 'ztools://web/index.html#/popout/timestamp?'
    const fits = 'a'.repeat(2048 - base.length - 'q=&handoff='.length - 24)
    const exact = await requestPopoutWindow({ pluginId: 'timestamp', query: { q: fits }, collected: null, call })
    expect(exact.outcome).toBe('opened')
    expect(calls[1].params.url.length).toBe(2048)
    expect(new URLSearchParams(new URL(calls[1].params.url).hash.split('?')[1]).get('q')).toBe(fits)
  })
})

describe('DeclarativeView：交接初值只给根页面用一次', () => {
  it('根页面用 seed 渲染；getPopoutState 取最新值；推入的二级页面不参与；换根不再套用 seed', async () => {
    const wrapper = mountWith(DeclarativeView, { rootComponent: ProbeRoot, initialPopoutState: { text: '带过来的', dir: '/Users/a', child: '不该用' } })
    await settle()
    expect(wrapper.text()).toContain('text:带过来的|dir:/Users/a')
    expect(probe.renders[0]).toBe('带过来的')

    probe.setText('改过的')
    await settle()
    const collected = wrapper.vm.getPopoutState()
    expect(collected.entries).toEqual([
      { key: 'text', value: '改过的', paths: [] },
      { key: 'dir', value: '/Users/a', paths: ['/Users/a'] }
    ])

    wrapper.vm.push(ChildPage)
    await settle()
    expect(wrapper.text()).toContain('child:child-init')
    expect(wrapper.vm.getPopoutState().entries.map((e) => e.key)).toEqual(['text', 'dir'])

    // 换根组件（同一实例）：seed 已用掉
    await wrapper.setProps({ rootComponent: () => ProbeRoot() })
    await settle()
    expect(wrapper.text()).toContain('text:init|dir:')
    wrapper.unmount()
  })

  it('没有 seed / seed 畸形时与普通 useState 一致', async () => {
    for (const seed of [null, ['x'], 'text']) {
      const wrapper = mountWith(DeclarativeView, { rootComponent: ProbeRoot, initialPopoutState: seed })
      await settle()
      expect(wrapper.text()).toContain('text:init|dir:')
      wrapper.unmount()
    }
  })
})

describe('DeclarativePage：弹出与独立窗口加载', () => {
  it('主窗口：window_open 成功（主进程已加载完新窗口）之后才离开插件页；交接内容与路径正确；连按只发起一次', async () => {
    let resolveOpen
    const calls = installFakeHost({
      window_open: () => new Promise((resolve) => { resolveOpen = () => resolve({ success: true, windowInstanceStatus: 'created' }) })
    })
    setRoute({ query: {} })
    const wrapper = mountWith(DeclarativePage, { pluginId: 'popout-probe' })
    await settle()
    probe.setText('主窗口里的输入')
    probe.setDir('/Users/test/Rename')
    await settle()

    await wrapper.find('.declarative-popout-btn').trigger('click')
    await wrapper.find('.declarative-popout-btn').trigger('click')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', metaKey: true, shiftKey: true }))
    await settle()
    expect(calls.filter((c) => c.method === 'window_open')).toHaveLength(1)
    expect(mockPush).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('text:主窗口里的输入')

    const { params } = calls[0]
    const query = new URLSearchParams(new URL(params.url).hash.split('?')[1])
    expect(query.get('handoff')).toBe(params.handoff.id)
    expect(params.handoff.pluginId).toBe('popout-probe')
    expect(params.handoff.paths).toEqual(['/Users/test/Rename'])
    expect(parsePopoutState(params.handoff.state).seed).toEqual({ text: '主窗口里的输入', dir: '/Users/test/Rename' })

    resolveOpen()
    await settle()
    expect(mockPush).toHaveBeenCalledWith({ name: 'my' })
    wrapper.unmount()
  })

  it('主窗口：主进程拒绝（窗口数上限）→ 保持原样并提示；之后可以再次弹出', async () => {
    let attempt = 0
    installFakeHost({
      window_open: () => {
        attempt += 1
        if (attempt === 1) throw hostError('PLUGIN_BUSY', '独立窗口数量已达上限 (8)')
        return { success: true }
      }
    })
    setRoute({ query: {} })
    const wrapper = mountWith(DeclarativePage, { pluginId: 'popout-probe' })
    await settle()
    probe.setText('保留')
    await settle()
    await wrapper.find('.declarative-popout-btn').trigger('click')
    await settle()
    expect(mockPush).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('text:保留')
    expect(wrapper.text()).toContain('独立窗口数量已达上限')
    await wrapper.find('.declarative-popout-btn').trigger('click')
    await settle()
    expect(mockPush).toHaveBeenCalledWith({ name: 'my' })
    wrapper.unmount()
  })

  it('同窗口兜底：宿主不支持多窗口 → 路由到 popout 页，新页面从内存取回状态', async () => {
    setRoute({ query: {} })
    const main = mountWith(DeclarativePage, { pluginId: 'popout-probe' })
    await settle()
    probe.setText('兜底也不丢')
    await settle()
    await main.find('.declarative-popout-btn').trigger('click')
    await settle()
    expect(mockPush).toHaveBeenCalledTimes(1)
    const target = mockPush.mock.calls[0][0]
    expect(target).toMatchObject({ name: 'popout', params: { pluginId: 'popout-probe' } })
    expect(isHandoffId(target.query.handoff)).toBe(true)
    main.unmount()

    setRoute({ name: 'popout', query: target.query })
    const popout = mountWith(DeclarativePage, { pluginId: 'popout-probe', isPopout: true })
    await settle()
    expect(popout.text()).toContain('text:兜底也不丢')
    popout.unmount()
  })

  it('独立窗口：取到状态后才挂载（不先用初始值渲染）；插件不符丢弃；复用窗口换编号后用新状态重新挂载', async () => {
    const pending = new Map()
    installFakeHost({
      window_popout_handoff_take: ({ handoffId }) => new Promise((resolve) => pending.set(handoffId, resolve))
    })
    const first = createHandoffId()
    const route = setRoute({ name: 'popout', query: { handoff: first } })
    const wrapper = mountWith(DeclarativePage, { pluginId: 'popout-probe', isPopout: true })
    await settle()
    expect(wrapper.find('[data-test="declarative-loading-placeholder"]').exists()).toBe(true)
    expect(probe.renders).toEqual([])
    pending.get(first)({ success: true, status: 'ok', pluginId: 'popout-probe', featureCode: '', state: JSON.stringify({ v: 1, entries: { text: '第一份' } }) })
    await settle()
    expect(wrapper.text()).toContain('text:第一份')
    expect(probe.renders).toEqual(['第一份'])

    // 复用窗口：同文档导航，只有 handoff 编号变化
    const second = createHandoffId()
    route.query = { handoff: second }
    await settle()
    pending.get(second)({ success: true, status: 'ok', pluginId: 'popout-probe', featureCode: '', state: JSON.stringify({ v: 1, entries: { text: '第二份' } }) })
    await settle()
    expect(wrapper.text()).toContain('text:第二份')

    // 编号对应的状态属于别的插件：丢弃，用初始值
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const third = createHandoffId()
    route.query = { handoff: third }
    await settle()
    pending.get(third)({ success: true, status: 'ok', pluginId: 'other-plugin', featureCode: '', state: JSON.stringify({ v: 1, entries: { text: '别人的' } }) })
    await settle()
    expect(wrapper.text()).toContain('text:init')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    wrapper.unmount()
  })

  it('独立窗口：取状态超时（2 秒）不阻塞渲染，提示未能恢复；乱序回来的旧结果被忽略', async () => {
    vi.useFakeTimers()
    const pending = new Map()
    installFakeHost({
      window_popout_handoff_take: ({ handoffId }) => new Promise((resolve) => pending.set(handoffId, resolve))
    })
    const stale = createHandoffId()
    const route = setRoute({ name: 'popout', query: { handoff: stale } })
    const wrapper = mountWith(DeclarativePage, { pluginId: 'popout-probe', isPopout: true })
    await vi.advanceTimersByTimeAsync(10)
    // 第一份还没回来就换了编号
    const fresh = createHandoffId()
    route.query = { handoff: fresh }
    await vi.advanceTimersByTimeAsync(10)
    pending.get(stale)({ success: true, status: 'ok', pluginId: 'popout-probe', featureCode: '', state: JSON.stringify({ v: 1, entries: { text: '过期的' } }) })
    await vi.advanceTimersByTimeAsync(10)
    expect(wrapper.text()).not.toContain('过期的')
    expect(wrapper.find('[data-test="declarative-loading-placeholder"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(2100)
    await nextTick()
    expect(wrapper.text()).toContain('text:init')
    expect(wrapper.text()).toContain('未能恢复弹出前的内容')
    wrapper.unmount()
  })

  it('独立窗口：插件代码晚于交接结果加载完成 → 仍用交接状态渲染，提示在视图挂载后显示', async () => {
    installFakeHost({
      window_popout_handoff_take: () => ({ success: true, status: 'ok', pluginId: 'late-probe', featureCode: '', state: JSON.stringify({ v: 1, entries: { text: '慢也带上' }, rejected: ['fn'], oversized: false }) })
    })
    setRoute({ name: 'popout', pluginId: 'late-probe', query: { handoff: createHandoffId() } })
    const wrapper = mountWith(DeclarativePage, { pluginId: 'late-probe', isPopout: true })
    await settle()
    expect(probe.renders).toEqual([])
    lateLoad.resolve()
    await settle()
    expect(wrapper.text()).toContain('text:慢也带上')
    expect(wrapper.text()).toContain('部分内容无法带到独立窗口')
    wrapper.unmount()
  })

  it('独立窗口：内容过大 / 部分不能带 → 新窗口提示；没有编号时不取', async () => {
    const calls = installFakeHost({
      window_popout_handoff_take: () => ({ success: true, status: 'ok', pluginId: 'popout-probe', featureCode: '', state: JSON.stringify({ v: 1, entries: {}, rejected: [], oversized: true }) })
    })
    setRoute({ name: 'popout', query: { handoff: createHandoffId() } })
    const wrapper = mountWith(DeclarativePage, { pluginId: 'popout-probe', isPopout: true })
    await settle()
    expect(wrapper.text()).toContain('text:init')
    expect(wrapper.text()).toContain('内容过大，独立窗口将重新开始')
    wrapper.unmount()

    setRoute({ name: 'popout', query: { q: 'x' } })
    const plain = mountWith(DeclarativePage, { pluginId: 'popout-probe', isPopout: true })
    await settle()
    expect(plain.text()).toContain('text:init')
    expect(calls.filter((c) => c.method === 'window_popout_handoff_take')).toHaveLength(1)
    plain.unmount()
  })
})
