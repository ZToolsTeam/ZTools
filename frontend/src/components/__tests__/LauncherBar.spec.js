import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, computed } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'

const items = ref([])
const pinned = ref([])
const pinnedEntriesRef = ref([])
const searching = ref(false)
const searchError = ref('')
const searchQuery = ref('')
const toggleItemPinMock = vi.fn().mockResolvedValue({ success: true, pinned: true })
const setItemPinnedMock = vi.fn().mockImplementation(async (_item, next) => ({ success: true, pinned: next }))
const reorderPinnedMock = vi.fn().mockResolvedValue({ success: true })
const prepareItemForLaunchMock = vi.fn(async (item) => item)

function resolveMockPinKey(item) {
  if (item?.pinKey) return item.pinKey
  if (item?.type === 'system-tool') return `system-tool:${item.id}`
  if (item?.type === 'plugin-feature') return `plugin-feature:${item.pluginId}:${item.featureCode}`
  if (item?.type === 'file') return `file:${item.path}`
  if (item?.pluginId) return `plugin:${item.pluginId}`
  return item?.key ? `builtin:${item.key}` : ''
}

function swapPinnedKeysImpl(keyA, keyB) {
  const entries = [...pinnedEntriesRef.value]
  const idxA = entries.findIndex((r) => r.pinKey === keyA)
  const idxB = entries.findIndex((r) => r.pinKey === keyB)
  if (idxA < 0 || idxB < 0) return null
  ;[entries[idxA], entries[idxB]] = [entries[idxB], entries[idxA]]
  pinnedEntriesRef.value = entries

  const visible = [...pinned.value]
  const vIdxA = visible.findIndex((x) => resolveMockPinKey(x) === keyA)
  const vIdxB = visible.findIndex((x) => resolveMockPinKey(x) === keyB)
  if (vIdxA >= 0 && vIdxB >= 0) {
    ;[visible[vIdxA], visible[vIdxB]] = [visible[vIdxB], visible[vIdxA]]
    pinned.value = visible
  }
  return entries.map((r) => r.pinKey)
}

function restorePinnedEntriesImpl(snapshot) {
  if (!Array.isArray(snapshot)) return
  pinnedEntriesRef.value = [...snapshot]
  const byKey = new Map(pinned.value.map((x) => [resolveMockPinKey(x), x]))
  pinned.value = snapshot.map((r) => byKey.get(r.pinKey)).filter(Boolean)
}

vi.mock('@/composables/useCommandSearch', async importOriginal => ({
  ...await importOriginal(),
  normalizePluginFeatures: () => [],
  useCommandSearch: () => ({
    query: searchQuery,
    isSearching: searching,
    fileSearchError: searchError,
    fileSearchDegraded: ref(false),
    fileResults: ref([]),
    filteredItems: computed(() => items.value),
    pinnedEntries: pinnedEntriesRef,
    pinnedItems: computed(() => pinned.value),
    setItemPinned: (...args) => setItemPinnedMock(...args),
    toggleItemPin: (...args) => toggleItemPinMock(...args),
    reorderPinned: (...args) => reorderPinnedMock(...args),
    swapPinnedKeys: (...args) => swapPinnedKeysImpl(...args),
    restorePinnedEntries: (...args) => restorePinnedEntriesImpl(...args),
    refreshPanelData: vi.fn().mockResolvedValue(),
    prepareItemForLaunch: (...args) => prepareItemForLaunchMock(...args),
    search: vi.fn(),
    clearSearch: () => { searchQuery.value = '' },
    recordUsage: vi.fn(),
    highlightParts: item => [{ text: item?.name || item?.title || '', hit: false }]
  })
}))
const openPlugin = vi.fn().mockResolvedValue({ success: true })
vi.mock('@/stores/plugins', () => ({
  usePluginsStore: () => ({ init: vi.fn().mockResolvedValue(), openPlugin, isBundledHidden: () => false })
}))
const switchWindowMode = vi.fn()
vi.mock('@/utils/windowMode', () => ({
  switchWindowMode: (...args) => switchWindowMode(...args),
  WINDOW_MODES: { DASHBOARD: 'dashboard', LAUNCHER: 'launcher' },
  windowModeState: { launcherInitialQuery: '' }
}))

import LauncherBar from '../LauncherBar.vue'
import ActionPanelModal from '@/declarative/components/ActionPanelModal.vue'
import ShellAPI from '../../../public/js/cef-ipc/src/api/shell.js'
import * as declarativeLoader from '@/utils/declarativePluginLoader'
import { createPluginSessionHolder } from '@/declarative/pluginSession'

const Empty = { template: '<div />' }

async function mountLauncher() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Empty },
      { path: '/launcher', component: Empty },
      { path: '/details/:id', component: Empty },
      { path: '/list', name: 'list', component: Empty },
      { path: '/advanced-settings', name: 'advanced-settings', component: Empty },
      { path: '/popout/:pluginId', name: 'popout', component: Empty }
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

describe('LauncherBar 子命令桥接结果', () => {
  beforeEach(() => { setActivePinia(createPinia()); searchQuery.value = '原搜索' })
  afterEach(() => { vi.restoreAllMocks(); delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__; document.body.innerHTML = '' })

  it('旧插件会话失效时退出悬浮条视图并恢复搜索入口', async () => {
    const holder = createPluginSessionHolder('bridge-probe', { call: async () => ({
      data: { sessionId: 'launcher-session', token: 'l'.repeat(43) }
    }) })
    vi.spyOn(declarativeLoader, 'loadInstalledDeclarativePlugin')
      .mockResolvedValueOnce({ pluginId: 'bridge-probe', session: holder, command: () => null })
    const { wrapper } = await mountLauncher()
    try {
      await window.__ztoolsOpenLauncherDeclarative('bridge-probe')
      await flushPromises()
      expect(wrapper.findComponent({ name: 'DeclarativeView' }).exists()).toBe(true)
      holder.invalidate()
      await flushPromises()
      expect(wrapper.findComponent({ name: 'DeclarativeView' }).exists()).toBe(false)
      expect(wrapper.find('#launcherQuery').exists()).toBe(true)
    } finally {
      holder.invalidate()
      wrapper.unmount()
    }
  })

  it('加载失败返回失败原因；成功才返回成功并保留功能码', async () => {
    const load = vi.spyOn(declarativeLoader, 'loadInstalledDeclarativePlugin').mockRejectedValueOnce(new Error('插件文件损坏'))
    const { wrapper } = await mountLauncher()
    try {
      expect(await window.__ztoolsOpenLauncherDeclarative('bridge-probe', { featureCode: 'second' })).toEqual({ success: false, error: '插件文件损坏' })
      expect(wrapper.text()).toContain('插件文件损坏')
      expect(searchQuery.value).toBe('原搜索')
      load.mockResolvedValueOnce({ pluginId: 'bridge-probe', featureCode: 'second', command: () => null })
      expect(await window.__ztoolsOpenLauncherDeclarative('bridge-probe', { featureCode: 'second' })).toEqual({ success: true })
      expect(load).toHaveBeenLastCalledWith('bridge-probe', { featureCode: 'second' })
      expect(searchQuery.value).toBe('')
    } finally { wrapper.unmount() }
  })

  it('另一个命令先加载完成后，旧请求返回取消且不会覆盖新页面', async () => {
    let finishOld
    const newCommand = () => null
    vi.spyOn(declarativeLoader, 'loadInstalledDeclarativePlugin')
      .mockReturnValueOnce(new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValueOnce({ pluginId: 'bridge-probe', featureCode: 'new', command: newCommand })
    const { wrapper } = await mountLauncher()
    try {
      const old = window.__ztoolsOpenLauncherDeclarative('bridge-probe', { featureCode: 'old' })
      expect(await window.__ztoolsOpenLauncherDeclarative('bridge-probe', { featureCode: 'new' })).toEqual({ success: true })
      finishOld({ pluginId: 'bridge-probe', featureCode: 'old', command: () => null })
      expect(await old).toEqual({ success: false, cancelled: true })
      await flushPromises()
      expect(wrapper.findComponent({ name: 'DeclarativeView' }).props('rootComponent')).toBe(newCommand)
    } finally { wrapper.unmount() }
  })
})

describe('LauncherBar 悬浮条动作面板', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    items.value = [{ key: 'json', pluginId: 'json-format', name: 'JSON 格式化', actionLabel: '启动' }]
    switchWindowMode.mockReset()
    searching.value = false
    searchError.value = ''
    searchQuery.value = ''
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

describe('LauncherBar 文件搜索结果执行', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    searchQuery.value = 'sample'
    items.value = [{ key: 'file:sample', type: 'file', name: 'sample.txt', path: '/search/sample.txt' }]
  })
  afterEach(() => {
    delete window.__ztoolsLauncher
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('文件结果到达让列表变短时，键盘选中项收回到列表内，Enter 仍打开一项', async () => {
    const openPath = vi.fn().mockResolvedValue({ success: true })
    window.__ztoolsLauncher = { openPath, hide: vi.fn().mockResolvedValue() }
    items.value = ['a', 'b', 'c'].map(name => ({ key: `file:${name}`, type: 'file', name: `${name}.txt`, path: `/search/${name}.txt` }))
    const { wrapper } = await mountLauncher()
    const input = wrapper.find('#launcherQuery')
    await input.trigger('keydown', { key: 'ArrowDown' })
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.findAll('.launcher-row')[2].classes()).toContain('is-active')
    items.value = [{ key: 'file:new', type: 'file', name: 'new.txt', path: '/search/new.txt' }]
    await flushPromises()
    expect(wrapper.find('.launcher-row').classes()).toContain('is-active')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(openPath).toHaveBeenCalledWith('/search/new.txt')
    wrapper.unmount()
  })

  it('等待打开成功才隐藏，并阻止重复点击', async () => {
    let complete
    const openPath = vi.fn(() => new Promise(resolve => { complete = resolve }))
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { openPath, hide }
    const { wrapper } = await mountLauncher()
    await wrapper.find('.launcher-row').trigger('click')
    await wrapper.find('.launcher-row').trigger('click')
    expect(openPath).toHaveBeenCalledTimes(1)
    expect(hide).not.toHaveBeenCalled()
    expect(searchQuery.value).toBe('sample')
    complete({ success: true, data: { success: true } })
    await flushPromises()
    expect(hide).toHaveBeenCalledOnce()
    expect(searchQuery.value).toBe('')
    wrapper.unmount()
  })

  it.each(['resolved-error', 'rejected-error'])('打开失败保持窗口并显示错误：%s', async mode => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = { code: 'PERMISSION_DENIED', message: '路径未由当前窗口授权' }
    const openPath = mode === 'resolved-error'
      ? vi.fn().mockResolvedValue({ success: false, error })
      : vi.fn().mockRejectedValue(new Error(error.message))
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { openPath, hide }
    const { wrapper } = await mountLauncher()
    await wrapper.find('.launcher-row').trigger('click')
    await flushPromises()
    expect(hide).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain(error.message)
    expect(searchQuery.value).toBe('sample')
    openPath.mockResolvedValue({ success: true })
    await wrapper.find('.launcher-row').trigger('click')
    await flushPromises()
    expect(hide).toHaveBeenCalledOnce()
    expect(searchQuery.value).toBe('')
    wrapper.unmount()
  })

  it('等待文件打开时开始了新搜索，旧结果返回后不关闭或清空新输入', async () => {
    let complete
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { openPath: () => new Promise(resolve => { complete = resolve }), hide }
    const { wrapper } = await mountLauncher()
    await wrapper.find('.launcher-row').trigger('click')
    await wrapper.find('#launcherQuery').setValue('新搜索')
    complete({ success: true })
    await flushPromises()
    expect(searchQuery.value).toBe('新搜索')
    expect(hide).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('定位失败和接口缺失都显示错误而不隐藏', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = {
      hide,
      showItemInFolder: vi.fn().mockResolvedValue({ success: false, error: { message: '文件已移走' } })
    }
    const { wrapper } = await mountLauncher()
    const panel = await openPanel(wrapper)
    panel.vm.$emit('trigger', panel.props('actions').find(a => /资源管理器|访达/.test(a.props.title)))
    await flushPromises()
    expect(wrapper.text()).toContain('文件已移走')
    expect(hide).not.toHaveBeenCalled()
    await wrapper.find('.launcher-row').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('文件操作接口不可用')
    expect(hide).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('LauncherBar 外部插件打开', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    searchQuery.value = '插件搜索'
    items.value = [{ key: 'external-test-plugin', pluginId: 'external-test-plugin', name: '测试插件' }]
    openPlugin.mockReset()
  })
  afterEach(() => {
    delete window.__ztoolsLauncher
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('成功后清空并收起，等待期间阻止重复打开', async () => {
    let complete
    openPlugin.mockReturnValue(new Promise(resolve => { complete = resolve }))
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { hide }
    const { wrapper } = await mountLauncher()
    await wrapper.find('.launcher-row').trigger('click')
    await wrapper.find('.launcher-row').trigger('click')
    expect(openPlugin).toHaveBeenCalledTimes(1)
    expect(hide).not.toHaveBeenCalled()
    expect(searchQuery.value).toBe('插件搜索')
    complete({ success: true })
    await flushPromises()
    expect(searchQuery.value).toBe('')
    expect(hide).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it.each(['returned', 'thrown'])('打开失败保留搜索和窗口，显示失败原因：%s', async mode => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    if (mode === 'returned') openPlugin.mockResolvedValue({ success: false, error: '插件暂不可用' })
    else openPlugin.mockRejectedValue(new Error('插件暂不可用'))
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { hide }
    const { wrapper } = await mountLauncher()
    await wrapper.find('.launcher-row').trigger('click')
    await flushPromises()
    expect(searchQuery.value).toBe('插件搜索')
    expect(hide).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('插件暂不可用')
    wrapper.unmount()
  })

  it('旧插件打开完成时不关闭用户新开始的搜索', async () => {
    let complete
    openPlugin.mockReturnValue(new Promise(resolve => { complete = resolve }))
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { hide }
    const { wrapper } = await mountLauncher()
    await wrapper.find('.launcher-row').trigger('click')
    await wrapper.find('#launcherQuery').setValue('下一次搜索')
    complete({ success: true })
    await flushPromises()
    expect(searchQuery.value).toBe('下一次搜索')
    expect(hide).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('宿主识别为悬浮条内运行的插件时保留插件界面', async () => {
    searchQuery.value = ''
    const command = () => null
    vi.spyOn(declarativeLoader, 'loadInstalledDeclarativePlugin')
      .mockResolvedValue({ pluginId: 'bridge-probe', command })
    openPlugin.mockImplementation(async () => {
      const result = await window.__ztoolsOpenLauncherDeclarative('bridge-probe')
      return { ...result, isDeclarative: true }
    })
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { hide }
    const { wrapper } = await mountLauncher()
    await wrapper.find('.launcher-row').trigger('click')
    await flushPromises()
    expect(hide).not.toHaveBeenCalled()
    expect(wrapper.findComponent({ name: 'DeclarativeView' }).props('rootComponent')).toBe(command)
    wrapper.unmount()
  })
})

describe('LauncherBar 文件操作返回值契约', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    items.value = [{ key: 'file:sample', type: 'file', name: 'sample.txt', path: '/search/sample.txt' }]
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    delete window.__ztoolsLauncher
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it.each(['shell_open_path', 'shell_show_item_in_folder'])('兼容真实 SDK 的布尔结果并允许失败后重试：%s', async method => {
    const call = vi.fn().mockResolvedValue({ success: false })
    const hide = vi.fn().mockResolvedValue()
    vi.stubGlobal('ztools', { shell: new ShellAPI({ call }), window: { hide } })
    const { wrapper } = await mountLauncher()
    const trigger = async () => {
      if (method === 'shell_open_path') await wrapper.find('.launcher-row').trigger('click')
      else {
        const panel = await openPanel(wrapper)
        panel.vm.$emit('trigger', panel.props('actions').find(a => /资源管理器|访达/.test(a.props.title)))
      }
      await flushPromises()
    }
    await trigger()
    expect(call).toHaveBeenCalledWith(method, { fullPath: '/search/sample.txt' })
    expect(hide).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain(method === 'shell_open_path' ? '打开文件失败' : '定位文件失败')
    call.mockResolvedValue({ success: true })
    await trigger()
    expect(hide).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it.each([undefined, null, {}, false])('不把空或畸形的宿主响应误报为成功：%j', async result => {
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { openPath: vi.fn().mockResolvedValue(result), hide }
    const { wrapper } = await mountLauncher()
    await wrapper.find('.launcher-row').trigger('click')
    await flushPromises()
    expect(hide).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('打开文件失败')
    wrapper.unmount()
  })
})


describe('LauncherBar 搜索结果语义与等待状态', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    items.value = []; searching.value = false; searchError.value = ''; searchQuery.value = ''
  })
  afterEach(() => {
    delete window.__ztoolsLauncher
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('等待文件搜索时按回车不会误跳插件市场', async () => {
    setActivePinia(createPinia())
    items.value = []; searching.value = true; searchQuery.value = '图片'
    const expandToDashboard = vi.fn()
    window.__ztoolsLauncher = { expandToDashboard }
    const { wrapper } = await mountLauncher()
    expect(wrapper.text()).toContain('正在搜索文件与应用')
    await wrapper.find('#launcherQuery').trigger('keydown', { key: 'Enter' })
    expect(expandToDashboard).not.toHaveBeenCalled()
    wrapper.unmount(); searching.value = false; delete window.__ztoolsLauncher
  })

  it('应用显示本地名称和真实图标，动作不再称为打开文件夹', async () => {
    setActivePinia(createPinia())
    items.value = [{ key: 'file:/System/Applications/Notes.app', type: 'file', name: '备忘录',
      path: '/System/Applications/Notes.app', isDir: true, isApplication: true, badge: '应用',
      description: '/System/Applications', icon: 'data:image/png;base64,aWNvbg==' }]
    const { wrapper } = await mountLauncher()
    expect(wrapper.find('.launcher-row-title').text()).toBe('备忘录')
    expect(wrapper.find('.launcher-row-desc').attributes('title')).toBe('/System/Applications/Notes.app')
    expect(wrapper.find('.launcher-row img').attributes('src')).toBe('data:image/png;base64,aWNvbg==')
    const panel = await openPanel(wrapper)
    expect(pick(panel, '打开应用')).toBeTruthy()
    expect(pick(panel, '打开文件夹')).toBeUndefined()
    wrapper.unmount()
  })

  it('搜索失败时不展示无效的市场快捷键，回车也不会跳转', async () => {
    searchError.value = '文件搜索暂不可用，请重试'; searchQuery.value = '备忘录'
    const expandToDashboard = vi.fn()
    window.__ztoolsLauncher = { expandToDashboard }
    const { wrapper } = await mountLauncher()
    expect(wrapper.text()).toContain(searchError.value)
    expect(wrapper.find('.launcher-primary-btn').exists()).toBe(false)
    await wrapper.find('#launcherQuery').trigger('keydown', { key: 'Enter' })
    expect(expandToDashboard).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each([
    ['复制文件名', 'Notes.app', '文件名'],
    ['复制文件绝对路径', '/System/Applications/Notes.app', '文件路径']
  ])('%s 使用真实文件信息并反馈复制失败和重试结果', async (action, value, label) => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard unavailable'))
    vi.stubGlobal('ztools', { clipboard: { writeText } })
    items.value = [{ key: 'file:notes', type: 'file', name: '备忘录', fileName: 'Notes.app',
      path: '/System/Applications/Notes.app', isApplication: true }]
    const { wrapper } = await mountLauncher()
    const trigger = async () => {
      const panel = await openPanel(wrapper)
      panel.vm.$emit('trigger', pick(panel, action))
      await flushPromises()
    }
    await trigger()
    expect(writeText).toHaveBeenCalledWith(value)
    expect(wrapper.text()).toContain(`复制${label}失败`)
    writeText.mockResolvedValue(undefined)
    await trigger()
    expect(wrapper.text()).toContain(`已复制${label}`)
    wrapper.unmount()
  })
})

describe('LauncherBar 拼音确认与快捷键隔离', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    openPlugin.mockClear()
    searching.value = false; searchError.value = ''; searchQuery.value = '备忘录'
  })
  afterEach(() => {
    delete window.__ztoolsLauncher
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it.each(['file', 'application', 'plugin'])('输入法确认不打开 %s，结束输入后的独立 Enter 才打开', async kind => {
    const path = kind === 'application' ? '/System/Applications/Notes.app' : '/search/备忘录.txt'
    items.value = kind === 'plugin'
      ? [{ key: 'ime-test-plugin', pluginId: 'ime-test-plugin', name: '输入法测试插件' }]
      : [{ key: `file:${path}`, type: 'file', name: '备忘录', path, isApplication: kind === 'application' }]
    const openPath = vi.fn().mockResolvedValue({ success: true })
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { openPath, hide }
    const { wrapper } = await mountLauncher()
    try {
      const input = wrapper.find('#launcherQuery')
      await input.trigger('compositionstart')
      input.element.value = 'bei wang lu'
      await input.trigger('input', { isComposing: true })
      for (const key of ['ArrowDown', 'Escape', 'Enter']) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: false })
        input.element.dispatchEvent(event)
        await flushPromises()
        expect(event.defaultPrevented).toBe(false)
        expect(wrapper.find('#launcherQuery').exists()).toBe(true)
        expect(searchQuery.value).toBe('备忘录')
      }
      expect(openPath).not.toHaveBeenCalled()
      expect(openPlugin).not.toHaveBeenCalled()
      expect(hide).not.toHaveBeenCalled()
      input.element.value = '备忘录'
      await input.trigger('compositionend')
      // 部分输入法在 compositionend 后仍用 229 标记本次确认按键。
      await input.trigger('keydown', { key: 'Enter', keyCode: 229 })
      expect(openPath).not.toHaveBeenCalled()
      expect(wrapper.find('#launcherQuery').exists()).toBe(true)
      await input.trigger('keyup', { key: 'Enter', keyCode: 13 })
      await input.trigger('keydown', { key: 'Enter', keyCode: 13 })
      await flushPromises()
      if (kind === 'plugin') {
        expect(openPlugin).toHaveBeenCalledExactlyOnceWith('ime-test-plugin')
      } else {
        expect(openPath).toHaveBeenCalledExactlyOnceWith(path)
        expect(hide).toHaveBeenCalledOnce()
      }
    } finally {
      wrapper.unmount()
    }
  })
})

function seedPinnedItems(list, hiddenSpecs = []) {
  pinned.value = list.map((item) => ({ ...item, pinKey: resolveMockPinKey(item), pinned: true }))
  const entries = pinned.value.map((item) => ({
    pinKey: item.pinKey,
    entry: { kind: item.type || 'plugin' },
    available: item.available !== false
  }))
  for (const { index, pinKey } of hiddenSpecs) {
    entries.splice(index, 0, { pinKey, entry: { kind: 'plugin', pluginId: pinKey.replace('plugin:', '') }, available: true })
  }
  pinnedEntriesRef.value = entries
}

describe('LauncherBar 首屏固定磁贴、全类型固定、1~2排滚动与 Ctrl+Shift+←/→ 排序', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    openPlugin.mockClear()
    toggleItemPinMock.mockClear()
    setItemPinnedMock.mockClear().mockImplementation(async (_item, next) => ({ success: true, pinned: next }))
    reorderPinnedMock.mockClear().mockResolvedValue({ success: true })
    searching.value = false
    searchError.value = ''
    searchQuery.value = ''
    seedPinnedItems([
      { key: 'system-tool:taskmgr', id: 'taskmgr', type: 'system-tool', panelItemType: 'system_tool', name: '任务管理器', pinned: true }
    ])
    items.value = [
      { key: 'plugin_1', pluginId: 'plugin_1', type: 'plugin', name: 'JSON 工具', pinned: false },
      { key: 'sys_1', id: 'sys_1', type: 'system-tool', panelItemType: 'system_tool', name: '系统计算器' }
    ]
  })

  afterEach(() => {
    vi.useRealTimers()
    delete window.__ztoolsLauncher
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('空查询时展示固定磁贴宫格，移除 Alt+1~9 快捷键及文案且按 Alt+1~9 不触发、不阻止默认行为', async () => {
    const openPanelItem = vi.fn().mockResolvedValue({ success: true })
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { openPanelItem, hide }

    seedPinnedItems(Array.from({ length: 9 }, (_, i) => ({
      key: `system-tool:tool_${i + 1}`,
      id: `tool_${i + 1}`,
      type: 'system-tool',
      panelItemType: 'system_tool',
      name: `工具 ${i + 1}`,
      pinned: true
    })))

    const { wrapper } = await mountLauncher()
    try {
      const section = wrapper.find('.launcher-pinned-section')
      expect(section.exists()).toBe(true)
      expect(wrapper.find('.launcher-pinned-title').text()).toBe('固定常用 (9)')
      expect(wrapper.find('.launcher-pinned-hint').text()).toBe('↑ 进入固定区 · Ctrl+P 固定/取消')
      expect(wrapper.find('.launcher-pinned-grid').classes()).not.toContain('is-two-rows')

      const tiles = section.findAll('.launcher-pinned-tile')
      expect(tiles).toHaveLength(9)
      expect(tiles[0].attributes('title')).toBe('工具 1')
      expect(tiles[8].attributes('title')).toBe('工具 9')

      // 按 Alt+1~9 均无响应且不阻止默认行为
      for (const digit of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
        const evt = new KeyboardEvent('keydown', { key: digit, altKey: true, bubbles: true, cancelable: true })
        wrapper.element.dispatchEvent(evt)
        await flushPromises()
        expect(evt.defaultPrevented).toBe(false)
      }
      expect(openPanelItem).not.toHaveBeenCalled()
      expect(hide).not.toHaveBeenCalled()

      // 点击磁贴正常触发，输入搜索词后首屏磁贴自动收起
      await tiles[0].trigger('click')
      await flushPromises()
      expect(openPanelItem).toHaveBeenCalledWith('tool_1', 'system_tool', '')

      searchQuery.value = '系统'
      await flushPromises()
      expect(wrapper.find('.launcher-pinned-section').exists()).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('已移除顶栏「+ 添加软件」按钮与动作面板添加软件项；支持 5 类条目（含绿色 .exe 与开始菜单应用）按 Ctrl+P 及 Ctrl+K 固定；inline-* 不可固定', async () => {
    const openPath = vi.fn().mockResolvedValue({ success: true })
    window.__ztoolsLauncher = { openPath, hide: vi.fn().mockResolvedValue() }
    const { wrapper } = await mountLauncher()
    try {
      // 1. 顶栏不存在「+ 添加软件」按钮，Ctrl+K 动作面板不存在「添加本地软件到悬浮条」
      expect(wrapper.find('button[aria-label="添加本地软件"]').exists()).toBe(false)
      expect(wrapper.find('.launcher-head').text()).not.toContain('添加软件')
      const pluginPanel = await openPanel(wrapper)
      expect(pick(pluginPanel, '添加本地软件到悬浮条')).toBeUndefined()
      wrapper.vm.$.setupState.actionPanelVisible = false
      await flushPromises()

      // 2. 插件固定
      await wrapper.trigger('keydown', { key: 'p', ctrlKey: true })
      await flushPromises()
      expect(setItemPinnedMock).toHaveBeenCalledWith(expect.objectContaining({ pluginId: 'plugin_1' }), true)
      expect(wrapper.text()).toContain('已固定「JSON 工具」到悬浮条首屏')

      // 3. 全 5 类条目（含绿色 .exe 普通文件与开始菜单应用）固定后在 SearchResultRow 展示「已固定」且动作面板提供固定操作
      items.value = [
        { key: 'p1', pluginId: 'p1', type: 'plugin', name: '插件A', pinned: true },
        { key: 'p1:f1', pluginId: 'p1', featureCode: 'f1', type: 'plugin-feature', name: '子命令B', pinned: true },
        { key: 'system-settings', name: '系统设置', pinned: true },
        { key: 'system-tool:taskmgr', id: 'taskmgr', type: 'system-tool', name: '任务管理器', pinned: true },
        { key: 'file:D:\\Tools\\geek.exe', type: 'file', name: 'geek.exe', path: 'D:\\Tools\\geek.exe', isDir: false, isApplication: false, pinned: true },
        { key: 'file:C:\\Apps\\App.lnk', type: 'file', name: '开始菜单应用', path: 'C:\\Apps\\App.lnk', isDir: false, isApplication: true, pinned: true }
      ]
      await flushPromises()
      expect(wrapper.findAll('.launcher-row-pin')).toHaveLength(6)
      expect(wrapper.findAll('.launcher-row-pin').every((el) => el.text() === '已固定')).toBe(true)

      // 切换到绿色 .exe 行（下标 4）：验证动作面板显示「打开文件」与「从悬浮条首屏取消固定」，点击行可直接打开
      wrapper.vm.$.setupState.activeIndex = 4
      await flushPromises()
      const portablePanel = await openPanel(wrapper)
      expect(pick(portablePanel, '打开文件')).toBeTruthy()
      expect(pick(portablePanel, '从悬浮条首屏取消固定')).toBeTruthy()
      expect(pick(portablePanel, '添加本地软件到悬浮条')).toBeUndefined()
      wrapper.vm.$.setupState.actionPanelVisible = false
      await flushPromises()
      await wrapper.findAll('.launcher-row')[4].trigger('click')
      await flushPromises()
      expect(openPath).toHaveBeenCalledWith('D:\\Tools\\geek.exe')

      // 切换到开始菜单应用行（下标 5）：验证动作面板显示「打开应用」与「从悬浮条首屏取消固定」
      wrapper.vm.$.setupState.activeIndex = 5
      await flushPromises()
      const appPanel = await openPanel(wrapper)
      expect(pick(appPanel, '打开应用')).toBeTruthy()
      expect(pick(appPanel, '从悬浮条首屏取消固定')).toBeTruthy()
      wrapper.vm.$.setupState.actionPanelVisible = false
      await flushPromises()

      // 4. inline-calculator / inline-color 不可固定
      setItemPinnedMock.mockClear()
      items.value = [
        { key: 'inline-calc:math:1+1', type: 'inline-calculator', ephemeral: true, name: '1+1 = 2', answer: '2' }
      ]
      await flushPromises()
      expect(wrapper.findAll('.launcher-foot-hint').some((el) => el.text().includes('固定'))).toBe(false)
      await wrapper.trigger('keydown', { key: 'p', ctrlKey: true })
      expect(setItemPinnedMock).not.toHaveBeenCalled()
      const calcPanel = await openPanel(wrapper)
      expect(pick(calcPanel, '固定到悬浮条首屏')).toBeUndefined()
    } finally {
      wrapper.unmount()
    }
  })

  it('1~9 项 1 排，10~25 项切换 2 排滚动；按 ↑ 进入可见最后一排第 1 项并随焦点滚动，Esc 先回搜索框再收起', async () => {
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { hide }

    seedPinnedItems(Array.from({ length: 25 }, (_, i) => ({
      key: `file:/apps/app_${i + 1}.exe`,
      path: `/apps/app_${i + 1}.exe`,
      type: 'file',
      isApplication: false,
      name: `应用 ${i + 1}`,
      pinned: true
    })))
    const { wrapper } = await mountLauncher()
    try {
      const grid = wrapper.find('.launcher-pinned-grid')
      expect(grid.classes()).toContain('is-two-rows')
      expect(wrapper.findAll('.launcher-pinned-tile')).toHaveLength(25)

      // 模拟容器可视区只有 2 排（116px），第 1 排 top=0、第 2 排 top=61、第 3 排 top=122
      Object.defineProperty(grid.element, 'clientHeight', { value: 116, configurable: true })
      grid.element.scrollTop = 0
      const scrollSpy = vi.fn()
      const tileNodes = grid.element.querySelectorAll('[data-nav-index]')
      tileNodes.forEach((node, idx) => {
        const rowIdx = Math.floor(idx / 9)
        Object.defineProperty(node, 'offsetTop', { value: rowIdx * 61, configurable: true })
        Object.defineProperty(node, 'offsetHeight', { value: 55, configurable: true })
        node.scrollIntoView = scrollSpy
      })

      // 搜索框按 ↑：应落入当前可见区域最后一排（第 2 排）第 1 项 index = 9，而非滚到底部 index = 18
      await wrapper.find('#launcherQuery').trigger('keydown', { key: 'ArrowUp' })
      await flushPromises()
      expect(wrapper.vm.$.setupState.pinnedFocusIndex).toBe(9)
      expect(wrapper.find('.launcher-pinned-hint').text()).toBe('方向键选择 · Enter 打开 · Ctrl+Shift+←/→ 调整顺序 · Ctrl+P 取消固定')
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' })

      // 焦点在固定区按第 1 次 Esc 回到搜索框而不隐藏窗口，第 2 次 Esc 才收起悬浮条
      await wrapper.trigger('keydown', { key: 'Escape' })
      await flushPromises()
      expect(wrapper.vm.$.setupState.pinnedFocusIndex).toBe(-1)
      expect(hide).not.toHaveBeenCalled()

      await wrapper.trigger('keydown', { key: 'Escape' })
      await flushPromises()
      expect(hide).toHaveBeenCalledOnce()

      // 项数回退到 <= 9 时移除 .is-two-rows 且 scrollTop 归零
      grid.element.scrollTop = 48
      seedPinnedItems(pinned.value.slice(0, 9))
      await flushPromises()
      expect(grid.classes()).not.toContain('is-two-rows')
      expect(grid.element.scrollTop).toBe(0)

      // 窗口重新聚焦复位 scrollTop；搜索词清空同样复位 scrollTop
      grid.element.scrollTop = 30
      window.dispatchEvent(new Event('focus'))
      await flushPromises()
      expect(grid.element.scrollTop).toBe(0)

      // 重新填入 10 项并滚动后输入再清空搜索词，确认 scrollTop 归零
      seedPinnedItems(Array.from({ length: 12 }, (_, i) => ({
        key: `file:/apps/app_${i + 1}.exe`,
        path: `/apps/app_${i + 1}.exe`,
        type: 'file',
        isApplication: false,
        name: `应用 ${i + 1}`,
        pinned: true
      })))
      await flushPromises()
      const grid2 = wrapper.find('.launcher-pinned-grid')
      grid2.element.scrollTop = 40
      searchQuery.value = 'abc'
      await flushPromises()
      searchQuery.value = ''
      await flushPromises()
      expect(wrapper.find('.launcher-pinned-grid').element.scrollTop).toBe(0)
    } finally {
      wrapper.unmount()
    }
  })

  it('Ctrl+Shift+←/→ 支持跨行连续排序、跳过隐藏项、150ms 防抖合并及失败回滚；在搜索框不拦截', async () => {
    vi.useFakeTimers()
    // 第 10 项索引 9 与第 9 项索引 8 跨行交换，并在底层下标 1 插入隐藏项 plugin:hidden_x
    const list = Array.from({ length: 10 }, (_, i) => ({
      key: `system-tool:app_${i + 1}`,
      id: `app_${i + 1}`,
      type: 'system-tool',
      panelItemType: 'system_tool',
      name: `工具 ${i + 1}`,
      pinned: true
    }))
    seedPinnedItems(list, [{ index: 1, pinKey: 'plugin:hidden_x' }])

    const { wrapper } = await mountLauncher()
    try {
      // 1. 焦点在搜索框（pinnedFocusIndex === -1）时不拦截 Ctrl+Shift+ArrowLeft
      const inputEvt = new KeyboardEvent('keydown', { key: 'ArrowLeft', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
      wrapper.find('#launcherQuery').element.dispatchEvent(inputEvt)
      expect(inputEvt.defaultPrevented).toBe(false)
      expect(reorderPinnedMock).not.toHaveBeenCalled()

      // 2. 进入固定区最后一行第 1 项（JSDOM 无真实几何回退为第 2 排第 1 项 index=9）
      await wrapper.find('#launcherQuery').trigger('keydown', { key: 'ArrowUp' })
      await flushPromises()
      expect(wrapper.vm.$.setupState.pinnedFocusIndex).toBe(9)

      // 边界测试：在末项按 Ctrl+Shift+→ 不动作
      await wrapper.trigger('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true })
      expect(wrapper.vm.$.setupState.pinnedFocusIndex).toBe(9)
      expect(pinned.value[9].id).toBe('app_10')

      // 跨行左移：index 9 (app_10) 连按两次 Ctrl+Shift+←（9 -> 8 -> 7，兼容 Mac Meta+Shift）
      await wrapper.trigger('keydown', { key: 'ArrowLeft', ctrlKey: true, shiftKey: true })
      expect(wrapper.vm.$.setupState.pinnedFocusIndex).toBe(8)
      expect(pinned.value[8].id).toBe('app_10')
      expect(pinned.value[9].id).toBe('app_9')

      globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'darwin'
      try {
        await wrapper.trigger('keydown', { key: 'ArrowLeft', metaKey: true, shiftKey: true })
      } finally {
        delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
      }
      expect(wrapper.vm.$.setupState.pinnedFocusIndex).toBe(7)
      expect(pinned.value[7].id).toBe('app_10')

      // 150ms 防抖期内未提交，期满后仅提交 1 次，且隐藏项 plugin:hidden_x 保持在底层下标 1 不动
      expect(reorderPinnedMock).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(160)
      await flushPromises()
      expect(reorderPinnedMock).toHaveBeenCalledTimes(1)
      const submittedOrder = reorderPinnedMock.mock.calls[0][0]
      expect(submittedOrder[1]).toBe('plugin:hidden_x')
      expect(submittedOrder[8]).toBe('system-tool:app_10')

      // 3. 动作面板对非首非末项提供「前移」与「后移」
      const panel = await openPanel(wrapper)
      expect(pick(panel, '前移')).toBeTruthy()
      expect(pick(panel, '后移')).toBeTruthy()
      wrapper.vm.$.setupState.actionPanelVisible = false
      await flushPromises()

      // 4. 提交失败且服务端未返回列表时回滚到移动前原序并提示错误
      reorderPinnedMock.mockResolvedValueOnce({ success: false, error: '保存排序失败' })
      await wrapper.trigger('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true })
      await vi.advanceTimersByTimeAsync(160)
      await flushPromises()
      expect(pinned.value[7].id).toBe('app_10')
      expect(wrapper.text()).toContain('保存排序失败')
    } finally {
      wrapper.unmount()
    }
  })

  it('失效磁贴灰显并标「已失效」，支持 Ctrl+P/× 取消固定；点击/Enter 提示失效原因且不隐藏', async () => {
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { hide }
    seedPinnedItems([
      {
        key: 'file:C:\\gone.txt',
        pinKey: 'file:c:\\gone.txt',
        type: 'file',
        name: 'gone.txt',
        path: 'C:\\gone.txt',
        available: false,
        unavailableReason: '文件「gone.txt」不存在或已移动',
        isPinnedTile: true
      }
    ])

    const { wrapper } = await mountLauncher()
    try {
      const tile = wrapper.find('.launcher-pinned-tile')
      expect(tile.classes()).toContain('is-unavailable')
      expect(tile.text()).toContain('已失效')

      await tile.trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('文件「gone.txt」不存在或已移动')
      expect(hide).not.toHaveBeenCalled()

      // 聚焦后按 Enter 也只提示失效原因，按 Ctrl+P 可取消固定
      await wrapper.find('#launcherQuery').trigger('keydown', { key: 'ArrowUp' })
      await wrapper.trigger('keydown', { key: 'Enter' })
      await flushPromises()
      expect(wrapper.text()).toContain('文件「gone.txt」不存在或已移动')
      expect(hide).not.toHaveBeenCalled()

      await wrapper.trigger('keydown', { key: 'p', ctrlKey: true })
      await flushPromises()
      expect(setItemPinnedMock).toHaveBeenCalledWith(expect.objectContaining({ pinKey: 'file:c:\\gone.txt' }), false)
    } finally {
      wrapper.unmount()
    }
  })

  it('已固定 file 磁贴打开与定位走 openPanelItem(pinKey, pinned, "", action)，不再走 openPath', async () => {
    const openPanelItem = vi.fn().mockResolvedValue({ success: true })
    const openPath = vi.fn().mockResolvedValue({ success: true })
    const showItemInFolder = vi.fn().mockResolvedValue({ success: true })
    const hide = vi.fn().mockResolvedValue()
    window.__ztoolsLauncher = { openPanelItem, openPath, showItemInFolder, hide }

    seedPinnedItems([
      {
        key: 'file:C:\\Docs\\manual.pdf',
        pinKey: 'file:c:\\docs\\manual.pdf',
        type: 'file',
        name: 'manual.pdf',
        path: 'C:\\Docs\\manual.pdf',
        isPinnedTile: true,
        available: true
      }
    ])
    const { wrapper } = await mountLauncher()
    try {
      // 点击打开走 openPanelItem('file:c:\\docs\\manual.pdf', 'pinned', '', 'open')
      await wrapper.find('.launcher-pinned-tile').trigger('click')
      await flushPromises()
      expect(openPanelItem).toHaveBeenCalledWith('file:c:\\docs\\manual.pdf', 'pinned', '', 'open')
      expect(openPath).not.toHaveBeenCalled()
      expect(hide).toHaveBeenCalledOnce()

      // Ctrl+Enter 定位走 openPanelItem(..., 'reveal')
      openPanelItem.mockClear()
      hide.mockClear()
      await wrapper.find('#launcherQuery').trigger('keydown', { key: 'ArrowUp' })
      await wrapper.trigger('keydown', { key: 'Enter', ctrlKey: true })
      await flushPromises()
      expect(openPanelItem).toHaveBeenCalledWith('file:c:\\docs\\manual.pdf', 'pinned', '', 'reveal')
      expect(showItemInFolder).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it('冷启动占位的程序先等程序列表返回拿到授权再打开；程序已卸载时提示且不打开', async () => {
    const pendingApp = { key: 'file:/Applications/WeChat.app', type: 'file', name: '微信', path: '/Applications/WeChat.app', isApplication: true, pendingGrant: true }
    items.value = [pendingApp]
    const openPath = vi.fn().mockResolvedValue({ success: true })
    window.__ztoolsLauncher = { openPath, hide: vi.fn().mockResolvedValue() }
    let release
    prepareItemForLaunchMock.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    const { wrapper } = await mountLauncher()
    try {
      await wrapper.find('.launcher-row').trigger('click')
      await flushPromises()
      expect(prepareItemForLaunchMock).toHaveBeenCalledWith(pendingApp)
      expect(openPath).not.toHaveBeenCalled()
      release({ ...pendingApp, pendingGrant: false })
      await flushPromises()
      expect(openPath).toHaveBeenCalledExactlyOnceWith('/Applications/WeChat.app')

      openPath.mockClear()
      prepareItemForLaunchMock.mockResolvedValueOnce(null)
      await wrapper.find('.launcher-row').trigger('click')
      await flushPromises()
      expect(openPath).not.toHaveBeenCalled()
      expect(wrapper.text()).toContain('程序列表读取失败或该程序已卸载')
    } finally {
      wrapper.unmount()
    }
  })

  it('悬浮条按下 Ctrl+,（含全角逗号、Cmd+, 与 IME 229/Comma）唤醒主窗口跳转设置页并收起动作面板，组字中不触发', async () => {
    const expandToDashboard = vi.fn().mockResolvedValue({ success: true })
    window.__ztoolsLauncher = { expandToDashboard, hide: vi.fn().mockResolvedValue() }
    const { wrapper, router } = await mountLauncher()
    try {
      await openPanel(wrapper)
      expect(wrapper.findComponent(ActionPanelModal).exists()).toBe(true)

      await wrapper.trigger('keydown', { key: ',', code: 'Comma', ctrlKey: true })
      await flushPromises()
      expect(expandToDashboard).toHaveBeenCalledWith('/advanced-settings')
      expect(router.currentRoute.value.path).toBe('/launcher')
      expect(wrapper.findComponent(ActionPanelModal).exists()).toBe(false)

      expandToDashboard.mockClear()
      await wrapper.trigger('keydown', { key: '，', code: 'Comma', ctrlKey: true })
      await flushPromises()
      expect(expandToDashboard).toHaveBeenCalledWith('/advanced-settings')

      expandToDashboard.mockClear()
      globalThis.__ZTOOLS_PLATFORM_OVERRIDE__ = 'darwin'
      try {
        await wrapper.trigger('keydown', { key: ',', code: 'Comma', metaKey: true })
        await flushPromises()
      } finally {
        delete globalThis.__ZTOOLS_PLATFORM_OVERRIDE__
      }
      expect(expandToDashboard).toHaveBeenCalledWith('/advanced-settings')

      expandToDashboard.mockClear()
      const imeEvt = new KeyboardEvent('keydown', {
        key: 'Process',
        code: 'Comma',
        ctrlKey: true,
        isComposing: false,
        bubbles: true,
        cancelable: true
      })
      Object.defineProperty(imeEvt, 'keyCode', { value: 229 })
      window.dispatchEvent(imeEvt)
      await flushPromises()
      expect(expandToDashboard).toHaveBeenCalledWith('/advanced-settings')

      // 正在组字时不触发跳转
      expandToDashboard.mockClear()
      const composingEvt = new KeyboardEvent('keydown', {
        key: 'Process',
        code: 'Comma',
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true
      })
      Object.defineProperty(composingEvt, 'keyCode', { value: 229 })
      window.dispatchEvent(composingEvt)
      await flushPromises()
      expect(expandToDashboard).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it('无原生悬浮条桥接（单窗口降级）及 IPC 抛错时按 Ctrl+, 安全处理不崩溃', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { wrapper, router } = await mountLauncher()
    try {
      await wrapper.trigger('keydown', { key: ',', code: 'Comma', ctrlKey: true })
      await flushPromises()
      expect(switchWindowMode).toHaveBeenCalledWith('dashboard')
      expect(router.currentRoute.value.path).toBe('/advanced-settings')

      window.__ztoolsLauncher = {
        expandToDashboard: vi.fn().mockRejectedValueOnce(new Error('主窗口未响应'))
      }
      await wrapper.trigger('keydown', { key: ',', code: 'Comma', ctrlKey: true })
      await flushPromises()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      wrapper.unmount()
    }
  })

  it('已移除未实现的“/ 快捷方式”占位文案；工作台切换采用 Ctrl+U；聚焦可用文件时底栏展示定位提示', async () => {
    const expandToDashboard = vi.fn().mockResolvedValue({ success: true })
    window.__ztoolsLauncher = { expandToDashboard, hide: vi.fn().mockResolvedValue() }
    items.value = [
      { key: 'file:/docs/report.pdf', type: 'file', name: 'report.pdf', path: '/docs/report.pdf' }
    ]
    const { wrapper } = await mountLauncher()
    try {
      expect(wrapper.find('#launcherQuery').attributes('placeholder')).not.toContain('快捷方式')
      expect(wrapper.find('.launcher-foot').text()).toContain('定位')

      // 按 Ctrl+U 唤醒完整工作台
      await wrapper.trigger('keydown', { key: 'u', ctrlKey: true })
      await flushPromises()
      expect(expandToDashboard).toHaveBeenCalledWith()

      // 切换为非文件项时底栏不再显示「定位」
      items.value = [{ key: 'calc', type: 'inline-calculator', name: '2', expression: '1+1', answer: '2' }]
      await flushPromises()
      expect(wrapper.find('.launcher-foot').text()).not.toContain('定位')
    } finally {
      wrapper.unmount()
    }
  })

  it('非编辑态与动作面板打开态均能真实触发计算器与文件快捷键，搜索框有选区时不抢占 Ctrl+C', async () => {
    const writeText = vi.fn().mockResolvedValue()
    vi.stubGlobal('ztools', { clipboard: { writeText } })
    const showItemInFolder = vi.fn().mockResolvedValue({ success: true })
    window.__ztoolsLauncher = { showItemInFolder, hide: vi.fn().mockResolvedValue() }
    const loadCalcSpy = vi.spyOn(declarativeLoader, 'loadInstalledDeclarativePlugin')
      .mockResolvedValueOnce({ pluginId: 'calculator', command: () => null })

    items.value = [
      { key: 'calc', type: 'inline-calculator', name: '3', expression: '1+2', answer: '3' }
    ]
    const { wrapper } = await mountLauncher()
    try {
      // 1. 计算器：非编辑态 Ctrl+Shift+C 复制完整等式；Ctrl+O 原位打开计算器声明式视图
      await wrapper.trigger('keydown', { key: 'c', ctrlKey: true, shiftKey: true })
      await flushPromises()
      expect(writeText).toHaveBeenCalledWith('1+2 = 3')

      await wrapper.trigger('keydown', { key: 'o', ctrlKey: true })
      await flushPromises()
      expect(loadCalcSpy).toHaveBeenCalledWith('calculator', { featureCode: '' })
      expect(wrapper.findComponent({ name: 'DeclarativeView' }).exists()).toBe(true)

      // 触发存根 DeclarativeView 的 @exit 返回搜索列表继续验证文件快捷键
      wrapper.findComponent({ name: 'DeclarativeView' }).vm.$emit('exit')
      await flushPromises()
      expect(wrapper.findComponent({ name: 'DeclarativeView' }).exists()).toBe(false)

      // 2. 文件：无选区按 Ctrl+C 复制文件名；有选区按 Ctrl+C 保留给原生复制不触发；Ctrl+Shift+C 复制路径
      writeText.mockClear()
      items.value = [
        { key: 'file:/docs/demo.txt', type: 'file', name: 'demo.txt', fileName: 'demo.txt', path: '/docs/demo.txt' }
      ]
      await flushPromises()
      const input = wrapper.find('#launcherQuery').element
      input.focus()
      input.value = 'demo'
      input.setSelectionRange(0, 4)
      const copyWithSel = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(copyWithSel)
      await flushPromises()
      expect(copyWithSel.defaultPrevented).toBe(false)
      expect(writeText).not.toHaveBeenCalled()

      input.setSelectionRange(4, 4)
      const copyNoSel = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true })
      input.dispatchEvent(copyNoSel)
      await flushPromises()
      expect(copyNoSel.defaultPrevented).toBe(true)
      expect(writeText).toHaveBeenCalledWith('demo.txt')

      // 3. 打开动作面板后按 Ctrl+Shift+C 直接复制文件路径并自动关闭面板
      writeText.mockClear()
      const panel = await openPanel(wrapper)
      expect(panel.exists()).toBe(true)
      await panel.find('.action-panel').trigger('keydown', { key: 'c', ctrlKey: true, shiftKey: true })
      await flushPromises()
      expect(writeText).toHaveBeenCalledWith('/docs/demo.txt')
      expect(wrapper.findComponent(ActionPanelModal).exists()).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      wrapper.unmount()
    }
  })

  it('悬浮条内嵌运行声明式插件时 Ctrl+Shift+P 优先弹出独立窗；动作面板内亦可直接按 Ctrl+Shift+P 触发', async () => {
    const windowOpenCalls = []
    const nativeWinOpen = vi.fn().mockResolvedValue({ success: true })
    vi.stubGlobal('ztools', { win: { open: nativeWinOpen } })
    Object.defineProperty(window, '__ztoolsElectron', {
      value: {
        transport: {
          methods: {
            window_open: async (envelope) => {
              windowOpenCalls.push(envelope.params)
              return { success: true, data: { success: true, windowInstanceStatus: 'created' } }
            }
          }
        }
      },
      configurable: true
    })
    window.__ztoolsLauncher = { hide: vi.fn().mockResolvedValue() }

    // 测试声明式插件条目在动作面板内直接展示并按 Ctrl+Shift+P 触发弹出
    items.value = [
      { key: 'plugin:calculator', type: 'plugin', pluginId: 'calculator', name: '计算器', isDeclarative: true }
    ]
    const { wrapper } = await mountLauncher()
    try {
      const panel = await openPanel(wrapper)
      const popoutAction = pick(panel, '在独立常驻窗口中打开')
      expect(popoutAction).toBeTruthy()
      const popoutItemEl = panel.findAll('.action-panel-item').find((n) => n.text().includes('在独立常驻窗口中打开'))
      // 宿主自身动作面板不屏蔽 Ctrl+Shift+P 键帽
      expect(popoutItemEl.findAll('kbd').map((k) => k.text())).toContain('P')

      await panel.find('.action-panel').trigger('keydown', { key: 'p', ctrlKey: true, shiftKey: true })
      await flushPromises()
      expect(nativeWinOpen).toHaveBeenCalledWith('ztools://web/index.html#/popout/calculator')
      expect(wrapper.findComponent(ActionPanelModal).exists()).toBe(false)

      // 测试内嵌运行声明式插件时，即使插件在 DECLARATIVE 作用域抢注 Ctrl+Shift+P，仍由宿主 HOST_RESERVED 抢先弹出
      windowOpenCalls.length = 0
      const { registerKeyHandler, KEYMAP_SCOPES } = await import('@/utils/keymap')
      const pluginSpy = vi.fn(() => true)
      const unregisterPluginConflict = registerKeyHandler(KEYMAP_SCOPES.DECLARATIVE, (e) => {
        if (e.key.toLowerCase() === 'p' && e.ctrlKey && e.shiftKey) return pluginSpy()
        return false
      })
      try {
        vi.spyOn(declarativeLoader, 'loadInstalledDeclarativePlugin').mockResolvedValueOnce({
          pluginId: 'calculator',
          featureCode: '',
          command: () => null
        })
        await window.__ztoolsOpenLauncherDeclarative('calculator')
        await flushPromises()

        await wrapper.trigger('keydown', { key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true })
        await flushPromises()
        expect(windowOpenCalls.length).toBe(1)
        expect(pluginSpy).not.toHaveBeenCalled()
      } finally {
        unregisterPluginConflict()
      }
    } finally {
      vi.unstubAllGlobals()
      delete window.__ztoolsElectron
      wrapper.unmount()
    }
  })
})
