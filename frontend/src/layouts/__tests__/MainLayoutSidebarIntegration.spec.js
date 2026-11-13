import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
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
        path: '/plugin/:pluginId',
        name: 'details',
        component: { template: '<div class="test-details-page">Details Page</div>' }
      },
      {
        path: '/advanced-settings',
        name: 'advanced-settings',
        component: { template: '<div class="test-settings-page">Settings</div>' }
      },
      {
        path: '/declarative/:pluginId?',
        name: 'declarative',
        component: defineComponent({
          name: 'DeclarativePage',
          template: '<div class="test-declarative-page">Declarative Page</div>'
        })
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

  it('1. [基线] 默认侧栏展开显示图标和文字，支持点击按钮收起为仅显示图标模式', async () => {
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
    expect(sidebar.findAll('.sidebar-label').length).toBeGreaterThan(0)

    const toggleBtn = sidebar.find('.sidebar-toggle-btn')
    expect(toggleBtn.exists()).toBe(true)
    await toggleBtn.trigger('click')
    await flushPromises()

    expect(sidebar.classes()).toContain('is-collapsed')
    expect(sidebar.findAll('.sidebar-label')).toHaveLength(0)
    expect(sidebar.findAll('.sidebar-item svg').length).toBeGreaterThan(0)
  })

  it('[回归] 本地保存的侧栏收起状态在启动时恢复为仅显示图标的收起态', async () => {
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
    expect(wrapper.find('aside.sidebar-root').classes()).toContain('is-collapsed')
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

  it('2. [快捷键] Ctrl+B / Cmd+B 切换侧栏收起与展开状态', async () => {
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
    await flushPromises()
    expect(wrapper.find('aside.sidebar-root').classes()).toContain('is-collapsed')

    dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }))
    await flushPromises()
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

  it('[回归] 未分离插件窗口时，从插件市场或详情页打开插件后按 Esc 退出，主窗口保持打开插件前的界面、组件内部状态、顶部搜索词与滚动位置，不重置回首页', async () => {
    let listMounts = 0
    let listUnmounts = 0
    let declMounts = 0
    let declUnmounts = 0

    const StatefulListStub = defineComponent({
      name: 'StatefulListStub',
      setup() {
        const page = ref(1)
        return { page }
      },
      mounted() {
        listMounts += 1
      },
      unmounted() {
        listUnmounts += 1
      },
      template: '<div class="stateful-list"><button class="next-page-btn" @click="page += 1">Page {{ page }}</button></div>'
    })

    const StatefulDetailsStub = defineComponent({
      name: 'StatefulDetailsStub',
      setup() {
        const activeTab = ref('detail')
        return { activeTab }
      },
      template: '<div class="stateful-details"><button class="switch-tab-btn" @click="activeTab = \'comments\'">Tab: {{ activeTab }}</button></div>'
    })

    const DeclarativeStub = defineComponent({
      name: 'DeclarativePage',
      mounted() {
        declMounts += 1
      },
      unmounted() {
        declUnmounts += 1
      },
      template: '<div class="test-declarative-page">Declarative Plugin</div>'
    })

    const SearchBarStub = {
      name: 'SearchBar',
      props: ['modelValue', 'placeholder'],
      emits: ['update:modelValue', 'search'],
      template: '<input class="stub-search" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />'
    }

    const keepAliveRouter = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'my', component: { template: '<div class="test-my-page">My</div>' } },
        { path: '/list/:category?', name: 'list', component: StatefulListStub },
        { path: '/plugin/:pluginId', name: 'details', component: StatefulDetailsStub },
        { path: '/declarative/:pluginId?', name: 'declarative', component: DeclarativeStub }
      ]
    })

    await keepAliveRouter.push('/')
    await keepAliveRouter.isReady()

    const wrapper = mount(MainLayout, {
      global: {
        plugins: [pinia, keepAliveRouter],
        stubs: { SearchBar: SearchBarStub, HeaderGeekModeTrigger: true }
      }
    })
    await flushPromises()

    // 1. 进入插件市场「系统工具」分类，输入搜索词、翻到第 2 页并滚动主视图
    await keepAliveRouter.push({ name: 'list', params: { category: '系统工具' }, query: { q: '进程' } })
    await flushPromises()
    expect(listMounts).toBe(1)

    await wrapper.find('input.stub-search').setValue('进程')
    await wrapper.find('.next-page-btn').trigger('click')
    expect(wrapper.find('.next-page-btn').text()).toBe('Page 2')

    const mainEl = wrapper.find('main').element
    mainEl.scrollTop = 260
    await wrapper.find('main').trigger('scroll')

    // 2. 打开未分离声明式插件：进入 /declarative/kill-process
    await keepAliveRouter.push({ name: 'declarative', params: { pluginId: 'kill-process' } })
    await flushPromises()
    expect(keepAliveRouter.currentRoute.value.name).toBe('declarative')
    expect(declMounts).toBe(1)
    expect(listUnmounts).toBe(0, '工作台页面应被 KeepAlive 缓存而不卸载')

    // 3. 按 Escape 退出插件返回主窗口：验证返回到插件市场原分类与原搜索参数，不重置回首页
    const handledFromList = dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(handledFromList).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    await flushPromises()

    expect(keepAliveRouter.currentRoute.value.name).toBe('list')
    expect(keepAliveRouter.currentRoute.value.params.category).toBe('系统工具')
    expect(keepAliveRouter.currentRoute.value.query.q).toBe('进程')
    expect(listMounts).toBe(1, '返回时复用缓存组件，不重新挂载初始化')
    expect(declUnmounts).toBe(1, 'DeclarativePage 退出后必须正常卸载释放插件会话')
    expect(wrapper.find('.next-page-btn').text()).toBe('Page 2', '保持打开插件前的分页状态')
    expect(wrapper.find('input.stub-search').element.value).toBe('进程', '保持顶栏搜索框输入词')
    expect(wrapper.find('main').element.scrollTop).toBe(260, '恢复打开插件前的主视图滚动位置')

    // 4. 再从插件详情页（切换到 comments 标签）打开未分离插件，按 Esc 退出后应回到详情页且保持标签状态
    await keepAliveRouter.push({ name: 'details', params: { pluginId: 'kill-process' } })
    await flushPromises()
    await wrapper.find('.switch-tab-btn').trigger('click')
    expect(wrapper.find('.switch-tab-btn').text()).toBe('Tab: comments')

    await keepAliveRouter.push({ name: 'declarative', params: { pluginId: 'kill-process' } })
    await flushPromises()
    expect(keepAliveRouter.currentRoute.value.name).toBe('declarative')

    dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await new Promise((r) => setTimeout(r, 20))
    await flushPromises()

    expect(keepAliveRouter.currentRoute.value.name).toBe('details')
    expect(keepAliveRouter.currentRoute.value.params.pluginId).toBe('kill-process')
    expect(wrapper.find('.switch-tab-btn').text()).toBe('Tab: comments')

    wrapper.unmount()
  })
})
