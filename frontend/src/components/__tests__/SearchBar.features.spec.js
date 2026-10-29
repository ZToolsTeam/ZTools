import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

const candidates = ref([])
const filteredCandidates = ref(null)
const mocks = vi.hoisted(() => ({ load: vi.fn(), noView: vi.fn(), error: vi.fn(), success: vi.fn(), keys: {} }))
vi.mock('@/composables/useCommandSearch', () => ({
  useCommandSearch: () => ({ query: ref(''), matchedPlugins: candidates, filteredItems: filteredCandidates, search: vi.fn(), clearSearch: vi.fn(), recordUsage: vi.fn(), highlightParts: item => [{ text: item?.name || '', hit: false }] })
}))
vi.mock('@/utils/keymap', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, useKeymap: (scope, handlers) => {
    mocks.keys[scope] = handlers
    return actual.useKeymap(scope, handlers)
  } }
})
vi.mock('@/composables/useToast', () => ({ useToast: () => ({ error: mocks.error, success: mocks.success }) }))
vi.mock('@/utils/declarativePluginLoader', () => ({ clearDeclarativePluginCache: vi.fn(), loadInstalledDeclarativePlugin: mocks.load, executeDeclarativeNoViewCommand: mocks.noView }))
vi.mock('@/utils/officialPlugins', () => ({
  OFFICIAL_PLUGIN_ALIASES: {},
  OFFICIAL_PLUGINS_MAP: {},
  getOfficialPluginsList: () => [],
  isOfficialPlugin: id => id === 'builtin-test',
  getOfficialPlugin: id => id === 'builtin-test' ? { pluginId: id } : null
}))
vi.mock('@/router', async () => {
  const { createRouter, createMemoryHistory } = await import('vue-router')
  return { default: createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', name: 'my', component: { template: '<div />' } },
    { path: '/declarative/:pluginId', name: 'declarative', component: { template: '<div />' } }
  ] }) }
})

import router from '@/router'
import { usePluginsStore } from '@/stores/plugins'
import SearchBar from '../SearchBar.vue'
import { registerKeyHandler, dispatchKeyEvent, KEYMAP_SCOPES, _resetKeymapForTesting } from '@/utils/keymap'

let wrapper
let store
let previousZtools
const candidate = (featureCode = 'cron-explainer') => ({ key: 'regex-cron:' + featureCode, pluginId: 'regex-cron', name: 'Cron 计算器', featureCode, isDeclarative: true, type: 'plugin-feature' })
async function prepare(item = candidate(), filesOnly = false) {
  candidates.value = filesOnly ? [] : [item]
  filteredCandidates.value = filesOnly ? [item] : null
  wrapper = mount(SearchBar, { global: { plugins: [router], stubs: {
    RcSquircle: true, ShortcutKeys: true,
    'a-input': { props: ['value'], emits: ['update:value', 'focus'], template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" @focus="$emit(\'focus\')" />' }
  } } })
  await wrapper.find('input').trigger('focus')
  await wrapper.find('input').setValue('cron')
}

describe('工作台搜索子命令到宿主加载链路', () => {
  beforeEach(async () => {
    previousZtools = window.ztools
    window.ztools = {}
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    setActivePinia(createPinia())
    mocks.load.mockReset().mockResolvedValue({})
    mocks.noView.mockReset()
    mocks.error.mockReset(); mocks.success.mockReset()
    store = usePluginsStore()
    store.installedPlugins = [{ pluginId: 'regex-cron', entry: 'dist/index.js', isDeclarative: true }]
    store.markRecent = vi.fn().mockResolvedValue()
    await router.push('/')
    await router.isReady()
  })
  afterEach(() => {
    wrapper?.unmount(); wrapper = null
    _resetKeymapForTesting()
    delete window.__ztoolsOpenLauncherDeclarative
    delete window.__ztoolsLauncher
    window.ztools = previousZtools
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks()
  })

  it('Enter保留功能码到预热与路由，随后不再发出迟到的市场搜索', async () => {
    await prepare()
    expect(mocks.keys.search.Enter()).toBe(true)
    await flushPromises()
    expect(mocks.load).toHaveBeenCalledWith('regex-cron', { featureCode: 'cron-explainer' })
    expect(router.currentRoute.value.query).toEqual({ feature: 'cron-explainer' })
    await vi.advanceTimersByTimeAsync(500)
    expect(wrapper.emitted('search')).toBeUndefined()
  })

  it('无界面命令直接执行并提示插件返回的结果，不跳到空白的插件页面；执行失败如实提示', async () => {
    const item = { key: 'audio-device:audio-mute-toggle', pluginId: 'audio-device', name: '静音', featureCode: 'audio-mute-toggle', mode: 'no-view', isDeclarative: true, type: 'plugin-feature' }
    store.installedPlugins = [{ pluginId: 'audio-device', entry: 'dist/index.js', isDeclarative: true }]
    mocks.noView.mockResolvedValueOnce({ success: true, message: '默认输出设备已静音' })
    await prepare(item)
    expect(mocks.keys.search.Enter()).toBe(true)
    await flushPromises()
    expect(mocks.noView).toHaveBeenCalledWith('audio-device', { featureCode: 'audio-mute-toggle', query: expect.any(String) })
    expect(mocks.success).toHaveBeenCalledWith('默认输出设备已静音')
    expect(router.currentRoute.value.name).toBe('my')
    expect(mocks.load).not.toHaveBeenCalled()

    mocks.noView.mockRejectedValueOnce(new Error('此设备不支持软件静音'))
    await wrapper.find('input').trigger('focus')
    await wrapper.find('input').setValue('mute')
    expect(mocks.keys.search.Enter()).toBe(true)
    await flushPromises()
    expect(mocks.error).toHaveBeenCalledWith('此设备不支持软件静音')
    expect(router.currentRoute.value.name).toBe('my')
  })

  it('搜索候选打开时，后挂载的市场页面不能抢走 Enter', async () => {
    await prepare()
    const openGridCard = vi.fn(() => true)
    registerKeyHandler(KEYMAP_SCOPES.PAGE, { Enter: openGridCard })
    dispatchKeyEvent({ key: 'Enter', target: wrapper.find('input').element })
    await flushPromises()
    expect(openGridCard).not.toHaveBeenCalled()
    expect(router.currentRoute.value.query).toEqual({ feature: 'cron-explainer' })
  })

  it('搜索失焦后把 Enter 交还页面，不受下拉关闭延迟影响', async () => {
    await prepare()
    await wrapper.find('input').trigger('blur')
    const openGridCard = vi.fn(() => true)
    registerKeyHandler(KEYMAP_SCOPES.PAGE, { Enter: openGridCard })
    dispatchKeyEvent({ key: 'Enter', target: document.body })
    expect(openGridCard).toHaveBeenCalledOnce()
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('鼠标启动正则测试保留不同功能码，插件普通入口仍使用默认模式', async () => {
    await prepare(candidate('regex-tester'))
    await wrapper.find('.is-active').trigger('mousedown')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ feature: 'regex-tester' })
    await store.openPlugin('regex-cron')
    expect(router.currentRoute.value.query).toEqual({})
  })

  it('悬浮条桥接同样接收功能码，旧插件别名保留对应默认子功能', async () => {
    window.__ztoolsOpenLauncherDeclarative = vi.fn().mockResolvedValue({ success: true })
    await store.openPlugin('regex-cron', { featureCode: 'regex-tester' })
    expect(window.__ztoolsOpenLauncherDeclarative).toHaveBeenCalledWith('regex-cron', { featureCode: 'regex-tester' })
    // 旧的单位换算插件已合并进内置计算器：打开旧 id 直接进入计算器的单位换算子功能
    await store.openPlugin('unit-converter')
    expect(window.__ztoolsOpenLauncherDeclarative).toHaveBeenCalledWith('calculator', { featureCode: 'calc-unit' })
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('官方内置命令也经过下架拦截，拒绝时展示错误而不跳转', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    store.revokedMap = { 'builtin-test': { revoked: true, reason: '测试下架' } }
    await prepare({ ...candidate(), pluginId: 'builtin-test' })
    await wrapper.find('.is-active').trigger('mousedown')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/')
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('测试下架'))
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('预热失败仍把正确功能码交给页面重试，不退到默认入口', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    mocks.load.mockRejectedValueOnce(new Error('暂时读取失败'))
    await prepare()
    await wrapper.find('.is-active').trigger('mousedown')
    await flushPromises()
    expect(router.currentRoute.value.query).toEqual({ feature: 'cron-explainer' })
  })

  it('宿主返回失败和桥接异步拒绝均展示错误，不作成功处理', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await prepare()
    vi.spyOn(store, 'openPlugin').mockResolvedValueOnce({ success: false, error: { message: '启动失败' } })
    await wrapper.find('.is-active').trigger('mousedown')
    await flushPromises()
    expect(mocks.error).toHaveBeenCalledWith('启动失败')
    expect(router.currentRoute.value.path).toBe('/')
    window.__ztoolsOpenLauncherDeclarative = vi.fn().mockRejectedValue(new Error('桥接断开'))
    await expect(store.openPlugin('regex-cron', { featureCode: 'regex-tester' })).rejects.toThrow('桥接断开')
    expect(mocks.success).not.toHaveBeenCalled()
  })

  const fileCandidate = { key: 'file:/test/report.txt', type: 'file', name: '测试文件', path: '/test/report.txt' }

  it.each([true, { success: true }])('文件候选来自混排结果，宿主返回 %j 时正确打开', async result => {
    const openPath = vi.fn().mockResolvedValue(result)
    window.ztools = { shell: { openPath } }
    await prepare(fileCandidate, true)
    expect(wrapper.find('.is-active').text()).toContain('测试文件')
    mocks.keys.search.Enter()
    await flushPromises()
    expect(openPath).toHaveBeenCalledWith(fileCandidate.path)
    expect(mocks.error).not.toHaveBeenCalled()
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it.each([
    [false, '打开文件失败'],
    [{ success: false, error: { message: '没有访问权限' } }, '没有访问权限'],
    [new Error('桥接断开'), '桥接断开']
  ])('文件打开失败 %j 时显示实际错误', async (result, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const openPath = result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result)
    window.__ztoolsLauncher = { openPath }
    await prepare(fileCandidate, true)
    mocks.keys.search.Enter()
    await flushPromises()
    expect(mocks.error).toHaveBeenCalledWith(message)
    expect(mocks.success).not.toHaveBeenCalled()
    expect(router.currentRoute.value.path).toBe('/')
  })

  it('缺少文件打开桥接时报告不可用，不跳到插件页面', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await prepare(fileCandidate, true)
    mocks.keys.search.Enter()
    await flushPromises()
    expect(mocks.error).toHaveBeenCalledWith('文件打开接口不可用')
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('输入只更新下拉候选，不会自己跳到插件市场；最后一条固定是「在插件市场搜索」，选它才跳', async () => {
    await prepare()
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.emitted('search')).toBeUndefined()
    expect(wrapper.text()).toContain('在插件市场搜索「cron」')
    expect(wrapper.find('.is-active').text()).toContain('Cron 计算器')

    expect(mocks.keys.search.ArrowUp()).toBe(true)
    await flushPromises()
    expect(wrapper.find('.is-active').text()).toContain('在插件市场搜索')
    expect(mocks.keys.search.Enter()).toBe(true)
    await flushPromises()
    expect(wrapper.emitted('search')).toEqual([['cron']])
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('本地没有任何匹配时下拉只剩「在插件市场搜索」，按 Enter 就去插件市场', async () => {
    candidates.value = []
    filteredCandidates.value = []
    wrapper = mount(SearchBar, { global: { plugins: [router], stubs: {
      RcSquircle: true, ShortcutKeys: true,
      'a-input': { props: ['value'], emits: ['update:value', 'focus'], template: '<input :value="value" @input="$emit(\'update:value\', $event.target.value)" @focus="$emit(\'focus\')" />' }
    } } })
    await wrapper.find('input').trigger('focus')
    await wrapper.find('input').setValue('没有这个插件')
    expect(wrapper.find('.is-active').text()).toContain('在插件市场搜索「没有这个插件」')
    expect(mocks.keys.search.Enter()).toBe(true)
    expect(wrapper.emitted('search')).toEqual([['没有这个插件']])
  })
})
