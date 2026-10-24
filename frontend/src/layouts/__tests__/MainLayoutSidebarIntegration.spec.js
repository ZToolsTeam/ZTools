import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'

import MainLayout from '../MainLayout.vue'
import { useUIStore } from '@/stores/ui'
import { useNavStore } from '@/stores/nav'
import { useCategoriesStore } from '@/stores/categories'
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

  it('1. [小白用户基线] 默认状态下侧边栏展开，结构完整且对新手零门槛', async () => {
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

    const uiStore = useUIStore()
    expect(uiStore.sidebarCollapsed).toBe(false)
    expect(uiStore.isSidebarCollapsed).toBe(false)

    // 侧栏存在且未包含 is-collapsed 类
    const sidebar = wrapper.find('aside.sidebar-root')
    expect(sidebar.exists()).toBe(true)
    expect(sidebar.classes()).not.toContain('is-collapsed')
    expect(sidebar.attributes('aria-hidden')).toBe('false')

    // 头部折叠按钮呈现激活态
    const toggleBtn = wrapper.find('.sidebar-toggle-btn')
    expect(toggleBtn.exists()).toBe(true)
    expect(toggleBtn.classes()).toContain('is-active')

    // 底部 Action Bar 提供收起说明
    const footerToggle = wrapper.findAll('footer button').find(b => b.text().includes('收起侧栏'))
    expect(footerToggle).toBeDefined()
  })

  it('2. [交互闭环与减重] 点击 Header 折叠按钮后，侧栏折叠，浮现分类面包屑胶囊', async () => {
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

    const uiStore = useUIStore()
    const toggleBtn = wrapper.find('.sidebar-toggle-btn')

    // 用户点击顶部折叠按钮
    await toggleBtn.trigger('click')
    await flushPromises()

    expect(uiStore.sidebarCollapsed).toBe(true)
    expect(localStorage.getItem('ztools_sidebar_collapsed')).toBe('true')

    // 侧栏处于 is-collapsed 状态
    const sidebar = wrapper.find('aside.sidebar-root')
    expect(sidebar.classes()).toContain('is-collapsed')
    expect(sidebar.attributes('aria-hidden')).toBe('true')

    // 顶部面包屑胶囊出现，提示当前上下文（我的插件）
    const breadcrumb = wrapper.find('.category-breadcrumb-pill')
    expect(breadcrumb.exists()).toBe(true)
    expect(breadcrumb.text()).toContain('我的插件')

    // 底部按钮文字变为“展开侧栏”
    const footerToggle = wrapper.findAll('footer button').find(b => b.text().includes('展开侧栏'))
    expect(footerToggle).toBeDefined()

    // 点击面包屑胶囊可直接重新展开侧栏（小白防迷路保护）
    await breadcrumb.trigger('click')
    await flushPromises()

    expect(uiStore.sidebarCollapsed).toBe(false)
    expect(sidebar.classes()).not.toContain('is-collapsed')
  })

  it('3. [快捷键集成] 支持 Ctrl+B / Cmd+B 全局快捷键顺畅翻转侧栏状态', async () => {
    mount(MainLayout, {
      global: {
        plugins: [pinia, router],
        stubs: {
          SearchBar: true,
          HeaderGeekModeTrigger: true
        }
      }
    })
    await flushPromises()

    const uiStore = useUIStore()
    expect(uiStore.sidebarCollapsed).toBe(false)

    // 触发 Ctrl+B
    dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }))
    expect(uiStore.sidebarCollapsed).toBe(true)

    // 再次触发 Ctrl+B 恢复
    dispatchKeyEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true }))
    expect(uiStore.sidebarCollapsed).toBe(false)
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

    const uiStore = useUIStore()
    uiStore.setSidebarCollapsed(true)
    await flushPromises()

    const breadcrumb = wrapper.find('.category-breadcrumb-pill')
    expect(breadcrumb.exists()).toBe(true)
    expect(breadcrumb.text()).not.toBe('')

    // 进入声明式视图，Header 和 Sidebar 均平滑隐藏
    await router.push('/declarative/test-plugin')
    await flushPromises()

    expect(wrapper.find('header').exists()).toBe(false)
    expect(wrapper.find('aside.sidebar-root').exists()).toBe(false)
    expect(wrapper.find('.test-declarative-page').exists()).toBe(true)
  })

  it('5. [Beyond Happy Path 存储异常容错] 模拟 localStorage 损坏抛错时布局平滑自愈', async () => {
    const originalGetItem = localStorage.getItem
    const originalSetItem = localStorage.setItem
    try {
      localStorage.getItem = () => {
        throw new Error('Access denied by browser security policy')
      }
      localStorage.setItem = () => {
        throw new Error('QuotaExceededError')
      }

      // 再次创建并挂载，验证安全降级
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

      const uiStore = useUIStore()
      expect(() => {
        uiStore.toggleSidebar()
      }).not.toThrow()
      expect(uiStore.sidebarCollapsed).toBe(true)
    } finally {
      localStorage.getItem = originalGetItem
      localStorage.setItem = originalSetItem
    }
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
})
