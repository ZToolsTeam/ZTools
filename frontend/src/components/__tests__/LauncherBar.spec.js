import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, computed } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'

const items = ref([])
vi.mock('@/composables/useCommandSearch', () => ({
  normalizePluginFeatures: () => [],
  useCommandSearch: () => ({
    query: ref(''),
    fileResults: ref([]),
    filteredItems: computed(() => items.value),
    search: vi.fn(),
    clearSearch: vi.fn(),
    recordUsage: vi.fn()
  })
}))
vi.mock('@/stores/plugins', () => ({
  usePluginsStore: () => ({ init: vi.fn().mockResolvedValue(), openPlugin: vi.fn() })
}))
const switchWindowMode = vi.fn()
vi.mock('@/utils/windowMode', () => ({
  switchWindowMode: (...args) => switchWindowMode(...args),
  WINDOW_MODES: { DASHBOARD: 'dashboard', LAUNCHER: 'launcher' },
  windowModeState: { launcherInitialQuery: '' }
}))

import LauncherBar from '../LauncherBar.vue'
import ActionPanelModal from '@/declarative/components/ActionPanelModal.vue'

const Empty = { template: '<div />' }

async function mountLauncher() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Empty },
      { path: '/launcher', component: Empty },
      { path: '/details/:id', component: Empty },
      { path: '/list', name: 'list', component: Empty }
    ]
  })
  router.push('/launcher')
  await router.isReady()
  const wrapper = mount(LauncherBar, {
    global: { plugins: [router], stubs: { DeclarativeView: true } },
    attachTo: document.body
  })
  await flushPromises()
  return { wrapper, router }
}

async function openPanel(wrapper) {
  wrapper.vm.$.setupState.actionPanelVisible = true
  await flushPromises()
  return wrapper.findComponent(ActionPanelModal)
}

const pick = (panel, title) => panel.props('actions').find((a) => a.props.title === title)

describe('LauncherBar 悬浮条动作面板', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    items.value = [{ key: 'json', pluginId: 'json-format', name: 'JSON 格式化', actionLabel: '启动' }]
    switchWindowMode.mockReset()
  })
  afterEach(() => {
    delete window.__ztoolsLauncher
    document.body.innerHTML = ''
  })

  it('「查看详情」把目标页面交给主窗口跳转，悬浮条自身路由不动', async () => {
    const expandToDashboard = vi.fn().mockResolvedValue({ success: true })
    window.__ztoolsLauncher = { expandToDashboard, hide: vi.fn().mockResolvedValue() }
    const { wrapper, router } = await mountLauncher()
    const panel = await openPanel(wrapper)
    panel.vm.$emit('trigger', pick(panel, '在完整工作台查看详情'))
    await flushPromises()
    expect(expandToDashboard).toHaveBeenCalledWith('/details/json-format')
    expect(router.currentRoute.value.path).toBe('/launcher')
    expect(wrapper.findComponent(ActionPanelModal).exists()).toBe(false)
    wrapper.unmount()
  })

  it('「展开为完整应用中心」不带目标页面', async () => {
    const expandToDashboard = vi.fn().mockResolvedValue({ success: true })
    window.__ztoolsLauncher = { expandToDashboard }
    const { wrapper } = await mountLauncher()
    const panel = await openPanel(wrapper)
    panel.vm.$emit('trigger', pick(panel, '展开为完整应用中心大窗口'))
    await flushPromises()
    expect(expandToDashboard).toHaveBeenCalledTimes(1)
    expect(expandToDashboard.mock.calls[0]).toEqual([])
    wrapper.unmount()
  })

  it('[破坏性] 主进程拒绝或桥接抛错时悬浮条不崩溃', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.__ztoolsLauncher = { expandToDashboard: vi.fn().mockRejectedValue(new Error('IPC 断开')) }
    const { wrapper } = await mountLauncher()
    let panel = await openPanel(wrapper)
    panel.vm.$emit('trigger', pick(panel, '在完整工作台查看详情'))
    await flushPromises()

    window.__ztoolsLauncher.expandToDashboard = () => { throw new Error('同步异常') }
    panel = await openPanel(wrapper)
    expect(() => panel.vm.$emit('trigger', pick(panel, '在完整工作台查看详情'))).not.toThrow()
    expect(warn).toHaveBeenCalled()
    // 畸形动作（无 onAction / null）被忽略
    expect(() => panel.vm.$emit('trigger', null)).not.toThrow()
    expect(() => panel.vm.$emit('trigger', { props: {} })).not.toThrow()
    warn.mockRestore()
    wrapper.unmount()
  })

  it('没有悬浮条桥接（单窗口降级）时在本窗口切换形态并跳转', async () => {
    const { wrapper, router } = await mountLauncher()
    const panel = await openPanel(wrapper)
    panel.vm.$emit('trigger', pick(panel, '在完整工作台查看详情'))
    await flushPromises()
    expect(switchWindowMode).toHaveBeenCalledWith('dashboard')
    expect(router.currentRoute.value.path).toBe('/details/json-format')
    wrapper.unmount()
  })
})
