/**
 * 开源版侧栏「反馈建议」：没有端内反馈页，点击在浏览器打开 GitHub Issues
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

import Sidebar from '../Sidebar.vue'
import { useCategoriesStore } from '@/stores/categories'
import { usePluginsStore } from '@/stores/plugins'

vi.mock('@edition', () => import('@/edition-oss/index.js'))

const ISSUES_URL = 'https://github.com/ZToolsTeam/ZTools/issues'
const mockRoute = reactive({ name: 'my', path: '/', params: {} })
const mockPush = vi.fn()

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRoute: () => mockRoute,
  useRouter: () => ({ push: mockPush })
}))

function mountSidebar() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const categoriesStore = useCategoriesStore()
  categoriesStore.fetchCategories = vi.fn()
  usePluginsStore().refreshCategoryCounts = vi.fn()
  const wrapper = mount(Sidebar, { global: { plugins: [pinia] } })
  const item = wrapper.findAll('.sidebar-item').find((i) => i.text().includes('反馈建议'))
  return { wrapper, item }
}

describe('开源版侧栏反馈入口', () => {
  let openSpy

  beforeEach(() => {
    mockPush.mockReset()
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
  })

  afterEach(() => {
    openSpy.mockRestore()
    delete window.ztools
  })

  it('有宿主时通过 shell.openExternal 打开 GitHub Issues，不走站内路由、没有未读红点', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    window.ztools = { shell: { openExternal } }
    const { wrapper, item } = mountSidebar()
    expect(item).toBeDefined()
    expect(wrapper.find('.unread-dot').exists()).toBe(false)

    await item.trigger('click')

    expect(openExternal).toHaveBeenCalledWith(ISSUES_URL)
    expect(openSpy).not.toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()
    expect(item.classes()).not.toContain('active')
  })

  it('没有宿主（浏览器开发模式）时用 window.open 新窗口打开', async () => {
    const { item } = mountSidebar()
    await item.trigger('click')
    expect(openSpy).toHaveBeenCalledWith(ISSUES_URL, '_blank', 'noopener,noreferrer')
  })

  it('openExternal 失败或同步抛错时不影响侧栏，也不改用站内路由', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    window.ztools = { shell: { openExternal: vi.fn().mockRejectedValue(new Error('被系统拒绝')) } }
    const { item } = mountSidebar()
    await item.trigger('click')
    await flushPromises()
    expect(warnSpy).toHaveBeenCalled()
    expect(mockPush).not.toHaveBeenCalled()

    window.ztools = {
      shell: {
        openExternal: vi.fn(() => {
          throw new Error('同步异常')
        })
      }
    }
    const second = mountSidebar()
    await second.item.trigger('click')
    await flushPromises()
    expect(mockPush).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('连续快速点击 10 次各打开一次，不累积状态', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined)
    window.ztools = { shell: { openExternal } }
    const { item } = mountSidebar()
    for (let i = 0; i < 10; i++) await item.trigger('click')
    expect(openExternal).toHaveBeenCalledTimes(10)
    expect(mockPush).not.toHaveBeenCalled()
  })
})
