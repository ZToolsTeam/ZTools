import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

import Sidebar from '../Sidebar.vue'
import { useNavStore } from '@/stores/nav'
import { useCategoriesStore } from '@/stores/categories'
import { ROUTES } from '@/router/routes'

// 模拟路由响应式状态
const mockRoute = reactive({ name: 'my', path: '/', params: {} })
const mockPush = vi.fn()

vi.mock('vue-router', () => ({
  useRoute: () => mockRoute,
  useRouter: () => ({ push: mockPush })
}))

vi.mock('@/config/runtime-mode', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    isOnline: true
  }
})

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
  })

  it('初始状态下“我的插件”为激活高亮状态', () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [pinia] }
    })

    const items = wrapper.findAll('.sidebar-item')
    const myItem = items.find((i) => i.text().includes('我的插件'))
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

  it('点击反馈建议时立即获得 active 高亮，并推入 WISH_WALL 路由', async () => {
    const wrapper = mount(Sidebar, {
      global: { plugins: [pinia] }
    })
    const nav = useNavStore()

    const items = wrapper.findAll('.sidebar-item')
    const wishItem = items.find((i) => i.text().includes('反馈建议'))
    expect(wishItem).toBeDefined()

    await wishItem.trigger('click')

    expect(nav.currentPage).toBe('wish-wall')
    expect(wishItem.classes()).toContain('active')
    expect(mockPush).toHaveBeenCalledWith(ROUTES.WISH_WALL)
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
    const myItem = items.find((i) => i.text().includes('我的插件'))
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
})
