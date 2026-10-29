import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, computed } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'

const items = ref([])
const searching = ref(false)
const searchError = ref('')
const searchQuery = ref('')
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
    search: vi.fn(),
    clearSearch: () => { searchQuery.value = '' },
    recordUsage: vi.fn(),
    highlightParts: item => [{ text: item?.name || item?.title || '', hit: false }]
  })
}))
const openPlugin = vi.fn().mockResolvedValue({ success: true })
vi.mock('@/stores/plugins', () => ({
  usePluginsStore: () => ({ init: vi.fn().mockResolvedValue(), openPlugin })
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

describe('LauncherBar 子命令桥接结果', () => {
  beforeEach(() => { setActivePinia(createPinia()); searchQuery.value = '原搜索' })
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

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
