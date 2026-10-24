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

  const categoryNames = (wrapper) => wrapper.findAll('.sidebar-item').map((i) => i.text().trim())

  it('当前系统上没有插件的分类不显示；统计结果出来前全部显示', async () => {
    const wrapper = mount(Sidebar, { global: { plugins: [pinia] } })
    expect(pluginsStore.refreshCategoryCounts).toHaveBeenCalled()
    expect(categoryNames(wrapper)).toEqual(expect.arrayContaining(['系统工具', '办公效率']))

    pluginsStore.categoryCounts = { 办公效率: 6 }
    await wrapper.vm.$nextTick()
    expect(categoryNames(wrapper)).toContain('办公效率')
    expect(categoryNames(wrapper)).not.toContain('系统工具')
  })

  it('[边界] 正在查看的分类即使为空也保留，避免侧栏没有选中项', async () => {
    mockRoute.name = 'list'
    mockRoute.path = '/list/系统工具'
    mockRoute.params = { category: '系统工具' }
    pluginsStore.categoryCounts = { 办公效率: 6 }
    const wrapper = mount(Sidebar, { global: { plugins: [pinia] } })
    expect(categoryNames(wrapper)).toContain('系统工具')
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

  it('选中分类时，页面级别高亮互斥失效，分类项处于 active', async () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [pinia] }
    })
    const nav = useNavStore()

    const items = wrapper.findAll('.sidebar-item')
    const sysCat = items.find((i) => i.text().includes('系统工具'))
    expect(sysCat).toBeDefined()

    await sysCat.trigger('click')

    expect(nav.isInCategoryMode).toBe(true)
    expect(nav.currentCategory).toBe('系统工具')
    expect(sysCat.classes()).toContain('active')

    // 其他项均不处于 active
    const myItem = items.find((i) => i.text().includes('主页'))
    const settingsItem = items.find((i) => i.text().includes('设置'))
    expect(myItem.classes()).not.toContain('active')
    expect(settingsItem.classes()).not.toContain('active')
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

  it('「插件市场」对应无分类的列表页，分类区不再重复列出「全部」', async () => {
    const categoriesStore = useCategoriesStore()
    categoriesStore.items = [{ name: '全部' }, { name: '系统工具' }]
    const wrapper = mount(Sidebar, { global: { plugins: [pinia] } })
    const items = wrapper.findAll('.sidebar-item')
    expect(items.filter((i) => i.text().trim() === '全部')).toHaveLength(0)

    const market = items.find((i) => i.text().includes('插件市场'))
    await market.trigger('click')
    expect(mockPush).toHaveBeenCalledWith({ ...ROUTES.LIST, params: { category: '' } })
    expect(market.classes()).toContain('active')

    // 进入具体分类后「插件市场」不再高亮，二者互斥
    await items.find((i) => i.text().includes('系统工具')).trigger('click')
    expect(market.classes()).not.toContain('active')
  })

  it('「设置」项显示快捷键键帽', () => {
    const wrapper = mount(Sidebar, { global: { plugins: [pinia] } })
    const settingsItem = wrapper.findAll('.sidebar-item').find((i) => i.text().includes('设置'))
    expect(settingsItem.find('.sidebar-kbd').exists()).toBe(true)
  })
})
