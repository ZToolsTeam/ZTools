import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import Events from '../../../public/js/cef-ipc/src/core/events.js'
import { useEventsStore } from '../events'
import { usePluginsStore } from '../plugins'
import {
  clearDeclarativePluginCache, getCachedDeclarativePlugin, loadInstalledDeclarativePlugin
} from '@/utils/declarativePluginLoader'
import {
  createPluginSessionHolder, createScopedHostBridge, getPluginSessionHolder,
  invalidatePluginSession, resetPluginSessionHoldersForTest
} from '@/declarative/pluginSession'
import { useDeclarativePluginSession } from '@/declarative/composables/useDeclarativePluginSession'
import DeclarativePage from '@/pages/DeclarativePage.vue'

vi.mock('@/router', () => ({ default: {
  push: vi.fn(), replace: vi.fn(), currentRoute: { value: { name: 'my', path: '/' } }
} }))
vi.mock('vue-router', async importOriginal => ({
  ...await importOriginal(),
  useRoute: () => ({ params: { pluginId: 'runtime-probe' }, query: {} }),
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), resolve: () => ({ fullPath: '/' }) })
}))

function deferred() {
  let resolve
  const promise = new Promise(finish => { resolve = finish })
  return { promise, resolve }
}

let events, eventStore, methods, source, views, sessionSequence
const manifest = JSON.stringify({ id: 'runtime-probe', name: '生命周期探针', entry: 'dist/index.js', permissions: [] })
const pluginSource = `const sdk = require('@ztools/declarative-ui'); exports.default = () => sdk.Detail({ markdown: '当前插件内容' })`
function stopped(source = { kind: 'host' }, payload = { pluginId: 'runtime-probe' }) {
  events.dispatchEnvelope({ type: 'plugin_runtime_stopped', scope: 'system', source, target: { main: true }, payload })
}
async function settle() {
  await vi.dynamicImportSettled()
  await flushPromises()
  await nextTick()
}
function mountHolder(holder, invalidated = vi.fn()) {
  const plugin = shallowRef({ session: holder })
  const view = createApp(defineComponent({ setup() {
    useDeclarativePluginSession(plugin, { onInvalidated() { plugin.value = null; invalidated() } })
    return () => h('div', plugin.value ? '运行中' : '已退出')
  } }))
  const element = document.createElement('div')
  view.mount(element)
  views.push(view)
  return { element, invalidated }
}

beforeEach(async () => {
  setActivePinia(createPinia())
  clearDeclarativePluginCache()
  resetPluginSessionHoldersForTest()
  views = []
  sessionSequence = 0
  source = pluginSource
  methods = {
    declarative_session_open: vi.fn(async () => {
      sessionSequence += 1
      return { success: true, data: { success: true, data: {
        sessionId: `session-${sessionSequence}`, token: String(sessionSequence).padStart(43, 't')
      } } }
    }),
    declarative_session_close: vi.fn(async () => ({ success: true, data: { success: true } })),
    credential_v1_status: vi.fn(async () => ({ success: true, data: { success: true } }))
  }
  Object.defineProperty(window, '__ztoolsElectron', { configurable: true, value: { transport: { methods } } })
  events = new Events({ call: vi.fn(async () => ({ success: true })) })
  window.ztools = { events }
  vi.stubGlobal('fetch', vi.fn(async url => {
    const name = String(url)
    const text = name.endsWith('/plugin.json') ? manifest : source
    return { ok: true, status: 200, text: async () => text }
  }))
  eventStore = useEventsStore()
  await eventStore.init()
})
afterEach(async () => {
  eventStore.destroy()
  for (const view of views) view.unmount()
  invalidatePluginSession('runtime-probe')
  await events.destroy()
  clearDeclarativePluginCache()
  resetPluginSessionHoldersForTest()
  delete window.__ztoolsElectron
  delete window.ztools
  vi.unstubAllGlobals()
})

describe('宿主运行时停止贯穿真实事件、store、加载器与挂载点', () => {
  it('只接受host来源；清缓存、退出全部挂载点并永久阻止旧通道，新实例可重新授权', async () => {
    const loaded = await loadInstalledDeclarativePlugin('runtime-probe')
    const first = mountHolder(loaded.session)
    const second = mountHolder(loaded.session)
    await settle()
    const oldBridge = createScopedHostBridge(loaded.session, window.__ztoolsElectron)
    expect(loaded.session.refs).toBe(2)
    expect(getCachedDeclarativePlugin('runtime-probe')).toBe(loaded)
    for (const invalidSource of [undefined, { kind: 'plugin', pluginId: 'runtime-probe' }, { kind: 'renderer' }]) {
      stopped(invalidSource || {})
      expect(first.element.textContent).toBe('运行中')
      expect(getCachedDeclarativePlugin('runtime-probe')).toBe(loaded)
    }
    stopped({ kind: 'host' }, { pluginId: '../runtime-probe' })
    expect(loaded.session.invalidated).toBe(false)
    stopped()
    stopped()
    await settle()
    expect(first.element.textContent).toBe('已退出')
    expect(second.element.textContent).toBe('已退出')
    expect(first.invalidated).toHaveBeenCalledOnce()
    expect(getCachedDeclarativePlugin('runtime-probe')).toBeNull()
    await expect(oldBridge.transport.methods.credential_v1_status({})).rejects.toMatchObject({ code: 'PLUGIN_SESSION_EXPIRED' })
    await expect(loaded.session.acquire()).rejects.toMatchObject({ code: 'PLUGIN_SESSION_EXPIRED' })
    const fresh = await loadInstalledDeclarativePlugin('runtime-probe')
    expect(fresh.session).not.toBe(loaded.session)
    const release = await fresh.session.acquire()
    expect(fresh.session.token).not.toBeNull()
    release()
  })

  it('真实DeclarativePage收到停止事件后销毁插件视图', async () => {
    const wrapper = mount(DeclarativePage, { props: { pluginId: 'runtime-probe' } })
    views.push(wrapper)
    await settle()
    expect(wrapper.text()).toContain('当前插件内容')
    stopped()
    await settle()
    expect(wrapper.text()).not.toContain('当前插件内容')
    expect(wrapper.text()).toContain('未找到指定的声明式应用')
  })

  it.each(['plugin', 'global'])('%s清理后，在途旧源码不得求值或回填缓存', async kind => {
    const pendingSource = deferred()
    let reading
    const started = new Promise(resolve => { reading = resolve })
    fetch.mockImplementation(async url => {
      if (String(url).endsWith('/plugin.json')) return { ok: true, text: async () => manifest }
      reading()
      return { ok: true, text: () => pendingSource.promise }
    })
    const pending = loadInstalledDeclarativePlugin('runtime-probe')
    await started
    if (kind === 'plugin') stopped()
    else clearDeclarativePluginCache()
    const rejected = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_CHANGED' })
    pendingSource.resolve('throw new Error("旧代码不应被执行")')
    await rejected
    expect(getCachedDeclarativePlugin('runtime-probe')).toBeNull()
    expect(methods.declarative_session_open).not.toHaveBeenCalled()
  })

  it('会话申请与宿主调用在途失效后，迟到结果不能重获权限或传回旧代码', async () => {
    const opening = deferred()
    const close = vi.fn(async () => ({ success: true }))
    const holder = createPluginSessionHolder('runtime-probe', { call: method => method.endsWith('_open') ? opening.promise : close(method) })
    const pending = expect(holder.acquire()).rejects.toMatchObject({ code: 'PLUGIN_SESSION_EXPIRED' })
    holder.invalidate()
    opening.resolve({ data: { sessionId: 'old', token: 't'.repeat(43) } })
    await pending
    expect(holder.refs).toBe(0)
    expect(close).toHaveBeenCalledOnce()
    const late = mountHolder(holder)
    expect(late.element.textContent).toBe('已退出')
    expect(late.invalidated).toHaveBeenCalledOnce()

    const active = getPluginSessionHolder('runtime-probe')
    const release = await active.acquire()
    const response = deferred()
    methods.credential_v1_status.mockReturnValueOnce(response.promise)
    const bridge = createScopedHostBridge(active, window.__ztoolsElectron)
    const call = bridge.transport.methods.credential_v1_status({})
    const rejected = expect(call).rejects.toMatchObject({ code: 'PLUGIN_SESSION_EXPIRED' })
    stopped()
    response.resolve({ success: true })
    await rejected
    release()
  })

  it('事件订阅销毁后不会继续消费停止通知', async () => {
    const holder = getPluginSessionHolder('runtime-probe')
    eventStore.destroy()
    stopped()
    expect(holder.invalidated).toBe(false)
    expect(events.handlers.has('plugin_runtime_stopped')).toBe(false)
  })
})
