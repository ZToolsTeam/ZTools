import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

import MainLayout from '../MainLayout.vue'
import { useNavStore } from '@/stores/nav'
import { useCategoriesStore } from '@/stores/categories'
import { usePluginsStore } from '@/stores/plugins'
import { dispatchKeyEvent } from '@/utils/keymap'

// Mock 外部非布局核心模块
vi.mock('@/api/apiserver', () => ({
  isNative: false,
  getCategories: vi.fn().mockResolvedValue({
    code: 200,
    data: ['系统工具', '办公效率', '媒体处理']
  }),
  sys: {
    getInfo: vi.fn().mockResolvedValue({ debug: false })
  }
}))

// 布局测试按开源版（无登录弹窗、无用户头像）进行，两种仓库里结果一致
vi.mock('@edition', () => import('@/edition-oss/index.js'))

vi.mock('@/api/categories', () => ({
  getCategories: vi.fn().mockResolvedValue({
    code: 200,
    data: ['系统工具', '办公效率', '媒体处理']
  })
}))

function createTestRouter(initialRoute = '/') {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        name: 'my',
        component: { template: '<div class="test-my-page">My Page</div>' }
      },
      {
        path: '/list/:category?',
        name: 'list',
        component: { template: '<div class="test-list-page">List Page</div>' }
      },
      {
        path: '/advanced-settings',
        name: 'advanced-settings',
        component: { template: '<div class="test-settings-page">Settings</div>' }
      },
      {
        path: '/declarative/:pluginId?',
        name: 'declarative',
        component: { template: '<div class="test-declarative-page">Declarative Page</div>' }
      }
    ]
  })
}

describe('方案 A 架构：MainLayout 与通透侧边栏端到端集成测试', () => {
  let router
  let pinia

  beforeEach(async () => {
    localStorage.clear()
    pinia = createPinia()
    setActivePinia(pinia)
    router = createTestRouter('/')
    router.push('/')
    await router.isReady()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('1. [基线] 侧栏始终展开：顶栏没有折叠按钮，底栏没有「收起侧栏」，Logo 右侧不出现页面名称', async () => {
    const wrapper = mount(MainLayout, {
      global: {
        plugins: [pinia, router],
        stubs: {
          SearchBar: true,
          HeaderGeekModeTrigger: true
        }
      }
    })
    await flushPromises()

    const sidebar = wrapper.find('aside.sidebar-root')
    expect(sidebar.exists()).toBe(true)
    expect(sidebar.classes()).not.toContain('is-collapsed')
    expect(wrapper.find('.sidebar-toggle-btn').exists()).toBe(false)
    expect(wrapper.findAll('footer button').some(b => b.text().includes('侧栏'))).toBe(false)
    expect(wrapper.find('header').text()).not.toContain('我的插件')
  })

  it('[回归] 旧版本存下的折叠状态不再生效，升级后侧栏照常显示', async () => {
    localStorage.setItem('ztools_sidebar_collapsed', 'true')
    const wrapper = mount(MainLayout, {
      global: {
        plugins: [pinia, router],
        stubs: {
          SearchBar: true,
          HeaderGeekModeTrigger: true
        }
      }
    })
    await flushPromises()

    expect(wrapper.find('aside.sidebar-root').exists()).toBe(true)
    expect(wrapper.find('aside.sidebar-root').classes()).not.toContain('is-collapsed')
  })

  it('启动时由主布局预取分类与插件目录（同步下架状态），只执行一次；目录失败不影响布局', async () => {
    const categoriesStore = useCategoriesStore()
    const pluginsStore = usePluginsStore()
    const fetchCategories = vi.spyOn(categoriesStore, 'fetchCategories').mockResolvedValue([])
    const refreshCounts = vi.spyOn(pluginsStore, 'refreshCategoryCounts').mockRejectedValue(new Error('离线'))
    const wrapper = mount(MainLayout, {
      global: { plugins: [pinia, router], stubs: { SearchBar: true, HeaderGeekModeTrigger: true } }
    })
    await flushPromises().catch(() => {})
    expect(fetchCategories).toHaveBeenCalledTimes(1)
    expect(refreshCounts).toHaveBeenCalledTimes(1)
    expect(wrapper.find('aside.sidebar-root').exists()).toBe(true)
    wrapper.unmount()
  })

  it('2. [快捷键] Ctrl+B / Cmd+B 不再切换侧栏，侧栏保持显示', async () => {
    const wrapper = mount(MainLayout, {
      global: {
        plugins: [pinia, router],
        stubs: {
          SearchBar: true,
          HeaderGeekModeTrigger: true
        }
      }
    })
    await flushPromises()

    dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }))
    dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }))
    await flushPromises()
    expect(wrapper.find('aside.sidebar-root').exists()).toBe(true)
    expect(wrapper.find('aside.sidebar-root').classes()).not.toContain('is-collapsed')
  })

  it('4. [Beyond Happy Path 异常容错] 非法路由参数与异常路由下无报错无污染', async () => {
    // 切换到带非法参数的分类路由
    await router.push('/list/undefined')
    await flushPromises()

    const wrapper = mount(MainLayout, {
      global: {
        plugins: [pinia, router],
        stubs: {
          SearchBar: true,
          HeaderGeekModeTrigger: true
        }
      }
    })
    await flushPromises()

    // 非法分类参数下顶栏也不渲染任何分类名
    expect(wrapper.find('header').text()).not.toContain('undefined')

    // 进入声明式视图，Header 和 Sidebar 均平滑隐藏
    await router.push('/declarative/test-plugin')
    await flushPromises()

    expect(wrapper.find('header').exists()).toBe(false)
    expect(wrapper.find('aside.sidebar-root').exists()).toBe(false)
    expect(wrapper.find('.test-declarative-page').exists()).toBe(true)
  })

  it('[快捷键] ⌘, / Ctrl+, 打开设置；已在设置页时重复按不会重复入栈', async () => {
    const wrapper = mount(MainLayout, {
      global: {
        plugins: [pinia, router],
        stubs: { SearchBar: true, HeaderGeekModeTrigger: true }
      }
    })
    await flushPromises()
    const nav = useNavStore()

    // macOS：metaKey 归一化为 Ctrl
    const handled = dispatchKeyEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true }))
    await flushPromises()
    expect(handled).toBe(true)
    expect(router.currentRoute.value.name).toBe('advanced-settings')
    expect(nav.currentPage).toBe('advanced-settings')

    const pushSpy = vi.spyOn(router, 'push')
    dispatchKeyEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true }))
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('advanced-settings')
    expect(pushSpy).not.toHaveBeenCalled()
    pushSpy.mockRestore()

    // 不带修饰键的逗号不触发
    await router.push('/')
    expect(dispatchKeyEvent(new KeyboardEvent('keydown', { key: ',' }))).toBe(false)
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('my')
    wrapper.unmount()
  })

  it('[搜索] 在插件市场页输入即时筛选：替换地址里的搜索词、不新增历史、不整页重建；在别的页面输入不跳转，按 Enter 才去插件市场', async () => {
    let listMounts = 0
    const searchRouter = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'my', component: { template: '<div class="test-my-page">My</div>' } },
        {
          path: '/list/:category?',
          name: 'list',
          component: { template: '<div class="test-list-page">{{ $route.query.q }}</div>', mounted() { listMounts += 1 } }
        }
      ]
    })
    await searchRouter.push('/')
    await searchRouter.isReady()
    const SearchBarStub = {
      name: 'SearchBar',
      props: ['modelValue', 'placeholder'],
      emits: ['update:modelValue', 'search'],
      template: '<input class="stub-search" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" @keyup.enter="$emit(\'search\', modelValue)" />'
    }
    const wrapper = mount(MainLayout, {
      global: { plugins: [pinia, searchRouter], stubs: { SearchBar: SearchBarStub, HeaderGeekModeTrigger: true } }
    })
    await flushPromises()
    const input = wrapper.find('input.stub-search')
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    // 首页输入：只给下拉候选用，不跳转
    await input.setValue('截图')
    await wait(320)
    await flushPromises()
    expect(searchRouter.currentRoute.value.name).toBe('my')

    // 按 Enter：进入插件市场
    await input.trigger('keyup.enter')
    await flushPromises()
    expect(searchRouter.currentRoute.value).toMatchObject({ name: 'list', query: { q: '截图' } })
    expect(listMounts).toBe(1)

    // 在插件市场页继续输入：防抖后替换搜索词，页面不重建
    await input.setValue('截图标注')
    await input.setValue('截图历史')
    await wait(320)
    await flushPromises()
    expect(searchRouter.currentRoute.value.query).toEqual({ q: '截图历史' })
    expect(wrapper.find('.test-list-page').text()).toBe('截图历史')
    expect(listMounts).toBe(1)
    searchRouter.back()
    await wait(20)
    await flushPromises()
    expect(searchRouter.currentRoute.value.name).toBe('my', '筛选只替换地址，返回直接回到进入插件市场之前的页面')

    // 清空搜索词时去掉 q；换分类等其它参数照常重建页面
    await searchRouter.push({ name: 'list', query: { q: 'a' } })
    await flushPromises()
    const before = listMounts
    await input.setValue('')
    await wait(320)
    await flushPromises()
    expect(searchRouter.currentRoute.value.query).toEqual({})
    expect(listMounts).toBe(before)
    await searchRouter.push({ name: 'list', params: { category: '工具' } })
    await flushPromises()
    expect(listMounts).toBe(before + 1)
    wrapper.unmount()
  })
})
