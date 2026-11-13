import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useNavStore } from '../nav'

describe('useNavStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('初始状态正确', () => {
    const store = useNavStore()
    expect(store.currentCategory).toBe('')
    expect(store.currentPage).toBe('')
    expect(store.isInCategoryMode).toBe(false)
    expect(store.lastWorkbenchRoute).toBeNull()
    expect(store.canBackFromDeclarative).toBe(false)
    expect(store.headerSearchKeyword).toBe('')
  })

  it('setCategory 设置分类并清空 page', () => {
    const store = useNavStore()
    store.setPage('settings')
    store.setCategory('tools')
    expect(store.currentCategory).toBe('tools')
    expect(store.currentPage).toBe('')
    expect(store.isInCategoryMode).toBe(true)
  })

  it('setCategory 传空值时 currentCategory 为空字符串', () => {
    const store = useNavStore()
    store.setCategory(null)
    expect(store.currentCategory).toBe('')
    expect(store.isInCategoryMode).toBe(true)
  })

  it('setPage 设置页面并清空 category', () => {
    const store = useNavStore()
    store.setCategory('tools')
    store.setPage('settings')
    expect(store.currentPage).toBe('settings')
    expect(store.currentCategory).toBe('')
    expect(store.isInCategoryMode).toBe(false)
  })

  it('setCategory 和 setPage 互斥切换', () => {
    const store = useNavStore()
    store.setCategory('design')
    expect(store.isInCategoryMode).toBe(true)
    store.setPage('my')
    expect(store.isInCategoryMode).toBe(false)
    store.setCategory('dev')
    expect(store.isInCategoryMode).toBe(true)
  })

  it('recordWorkbenchRoute 仅记录工作台路由并忽略 declarative/popout/launcher，exitDeclarativeToWorkbench 按优先级精准恢复', () => {
    const store = useNavStore()
    const router = {
      back: vi.fn(),
      push: vi.fn()
    }

    // 1. 无历史记录与工作台快照时，兜底返回首页
    store.exitDeclarativeToWorkbench(router)
    expect(router.push).toHaveBeenCalledWith({ name: 'my' })
    router.push.mockClear()

    // 2. 记录工作台路由（忽略非工作台路由）
    store.recordWorkbenchRoute({
      name: 'list',
      path: '/list/系统工具',
      fullPath: '/list/系统工具?q=清理',
      params: { category: '系统工具' },
      query: { q: '清理' }
    })
    store.recordWorkbenchRoute({
      name: 'declarative',
      path: '/declarative/kill-process',
      fullPath: '/declarative/kill-process'
    })
    expect(store.lastWorkbenchRoute.name).toBe('list')
    expect(store.lastWorkbenchRoute.fullPath).toBe('/list/系统工具?q=清理')

    // 3. 从工作台正向推入 declarative 时，优先走 router.back()
    store.markEnteredDeclarative(true)
    store.exitDeclarativeToWorkbench(router)
    expect(router.back).toHaveBeenCalledTimes(1)
    expect(store.canBackFromDeclarative).toBe(false)

    // 4. 非直接 back 场景（如从独立窗口收回后退出），回退到 lastWorkbenchRoute.fullPath
    store.exitDeclarativeToWorkbench(router)
    expect(router.push).toHaveBeenCalledWith('/list/系统工具?q=清理')
  })
})
