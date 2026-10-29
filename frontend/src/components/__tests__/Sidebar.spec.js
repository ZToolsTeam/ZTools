import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

import Sidebar from '../Sidebar.vue'
import { useNavStore } from '@/stores/nav'
import { useCategoriesStore } from '@/stores/categories'
import { usePluginsStore } from '@/stores/plugins'
import { ROUTES } from '@/router/routes'
import { feedbackEntry } from '@edition'

// 模拟路由响应式状态
const mockRoute = reactive({ name: 'my', path: '/', params: {} })
const mockPush = vi.fn()

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRoute: () => mockRoute,
  useRouter: () => ({ push: mockPush })
}))

describe('Sidebar.vue 侧边栏高亮与导航测试', () => {
  let pinia

  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    mockPush.mockReset()
    mockRoute.name = 'my'
    mockRoute.path = '/'
    mockRoute.params = {}

    const categoriesStore = useCategoriesStore()
    categoriesStore.fetchCategories = vi.fn()
    categoriesStore.items = [
      { name: '系统工具' },
      { name: '办公效率' }
    ]
    categoriesStore.loaded = true
    categoriesStore.loading = false
    categoriesStore.error = null

    pluginsStore = usePluginsStore()
    pluginsStore.refreshCategoryCounts = vi.fn()
  })

  let pluginsStore

  const itemTexts = (wrapper) => wrapper.findAll('.sidebar-item').map((i) => i.text().trim())

  it('侧栏只保留主导航与系统入口，不再重复列出分类（分类只在插件市场页顶部切换）', () => {
    const wrapper = mount(Sidebar, { global: { plugins: [pinia] } })
    const texts = itemTexts(wrapper)
    expect(texts).not.toContain('系统工具')
    expect(texts).not.toContain('办公效率')
    expect(texts.some((t) => t.includes('重试分类'))).toBe(false)
    expect(wrapper.text()).not.toContain('分类')
    // 预取分类与目录已移到主布局，侧栏自己不再请求
    expect(useCategoriesStore().fetchCategories).not.toHaveBeenCalled()
    expect(pluginsStore.refreshCategoryCounts).not.toHaveBeenCalled()
  })

  it('初始状态下“主页”为激活高亮状态', () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [pinia] }
    })

    const items = wrapper.findAll('.sidebar-item')
    const myItem = items.find((i) => i.text().includes('主页'))
    expect(myItem.classes()).toContain('active')
  })

  it('点击设置时立即获得 active 高亮，并推入 ADVANCED_SETTINGS 路由', async () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [pinia] }
    })
    const nav = useNavStore()

    const items = wrapper.findAll('.sidebar-item')
    const settingsItem = items.find((i) => i.text().includes('设置'))
    expect(settingsItem).toBeDefined()

    await settingsItem.trigger('click')

    expect(nav.currentPage).toBe('advanced-settings')
    expect(settingsItem.classes()).toContain('active')
    expect(mockPush).toHaveBeenCalledWith(ROUTES.ADVANCED_SETTINGS)
  })

  it('点击关于时立即获得 active 高亮，并推入 ABOUT 路由', async () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [pinia] }
    })
    const nav = useNavStore()

    const items = wrapper.findAll('.sidebar-item')
    const aboutItem = items.find((i) => i.text().includes('关于'))
    expect(aboutItem).toBeDefined()

    await aboutItem.trigger('click')

    expect(nav.currentPage).toBe('about')
    expect(aboutItem.classes()).toContain('active')
    expect(mockPush).toHaveBeenCalledWith(ROUTES.ABOUT)
  })

  // 反馈入口随版本变化：官方版进入端内反馈页，开源版打开 GitHub Issues（两种版本的细节用例见各自的测试）
  it('点击反馈建议按当前版本的入口配置跳转', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    window.ztools = { shell: { openExternal } }
    const wrapper = mount(Sidebar, {
      global: { plugins: [pinia] }
    })
    const nav = useNavStore()

    const items = wrapper.findAll('.sidebar-item')
    const feedbackItem = items.find((i) => i.text().includes(feedbackEntry.title))
    expect(Boolean(feedbackItem)).toBe(feedbackEntry.visible)
    if (!feedbackItem) return

    await feedbackItem.trigger('click')

    if (feedbackEntry.routeName) {
      expect(nav.currentPage).toBe(feedbackEntry.routeName)
      expect(feedbackItem.classes()).toContain('active')
      expect(mockPush).toHaveBeenCalledWith({ name: feedbackEntry.routeName })
      expect(openExternal).not.toHaveBeenCalled()
    } else {
      expect(openExternal).toHaveBeenCalledWith(feedbackEntry.externalUrl)
      expect(mockPush).not.toHaveBeenCalled()
    }
    delete window.ztools
  })

  it('[边界] 在插件市场的任意分类下，侧栏都高亮「插件市场」，页面项互斥不高亮', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [pinia] } })
    const nav = useNavStore()
    nav.setCategory('系统工具')
    await wrapper.vm.$nextTick()
    const items = wrapper.findAll('.sidebar-item')
    const active = items.filter((i) => i.classes().includes('active')).map((i) => i.text().trim())
    expect(active).toEqual(['插件市场'])
  })

  it('外部路由切换同步到 nav 与高亮', async () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [pinia] }
    })
    const nav = useNavStore()

    mockRoute.name = 'about'
    mockRoute.path = '/about'
    await wrapper.vm.$nextTick()

    expect(nav.currentPage).toBe('about')
    const aboutItem = wrapper.findAll('.sidebar-item').find((i) => i.text().includes('关于'))
    expect(aboutItem.classes()).toContain('active')
  })

  it('点「插件市场」进入无分类的列表页并高亮', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [pinia] } })
    const market = wrapper.findAll('.sidebar-item').find((i) => i.text().includes('插件市场'))
    await market.trigger('click')
    expect(mockPush).toHaveBeenCalledWith({ ...ROUTES.LIST, params: { category: '' } })
    expect(market.classes()).toContain('active')
  })

  it('「设置」项显示快捷键键帽', () => {
    const wrapper = mount(Sidebar, { global: { plugins: [pinia] } })
    const settingsItem = wrapper.findAll('.sidebar-item').find((i) => i.text().includes('设置'))
    expect(settingsItem.find('.sidebar-kbd').exists()).toBe(true)
  })
})
