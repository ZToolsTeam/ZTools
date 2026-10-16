import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useUIStore } from '../ui'

describe('useUIStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('初始状态正确', () => {
    const store = useUIStore()
    expect(store.showCloseConfirm).toBe(false)
    expect(store.closeConfirmOrigin).toBe('closeButton')
    expect(store.showLoginModal).toBe(false)
  })

  it('openCloseConfirm 设置 origin 并显示弹窗', () => {
    const store = useUIStore()
    store.openCloseConfirm('trayMenu')
    expect(store.showCloseConfirm).toBe(true)
    expect(store.closeConfirmOrigin).toBe('trayMenu')
  })

  it('openCloseConfirm 不传 origin 时使用默认值', () => {
    const store = useUIStore()
    store.openCloseConfirm()
    expect(store.closeConfirmOrigin).toBe('closeButton')
    expect(store.showCloseConfirm).toBe(true)
  })

  it('closeCloseConfirm 关闭弹窗', () => {
    const store = useUIStore()
    store.openCloseConfirm()
    store.closeCloseConfirm()
    expect(store.showCloseConfirm).toBe(false)
  })

  it('openLoginModal / closeLoginModal 控制登录弹窗', () => {
    const store = useUIStore()
    store.openLoginModal()
    expect(store.showLoginModal).toBe(true)
    store.closeLoginModal()
    expect(store.showLoginModal).toBe(false)
  })

  it('三态焦点状态机流转正确', () => {
    const store = useUIStore()
    expect(store.focusState).toBe('SEARCH')
    expect(store.isSearchFocused).toBe(true)

    store.focusGrid()
    expect(store.focusState).toBe('GRID')
    expect(store.isGridFocused).toBe(true)

    store.focusDeclarative()
    expect(store.focusState).toBe('DECLARATIVE')
    expect(store.isDeclarativeFocused).toBe(true)

    store.focusSearch()
    expect(store.focusState).toBe('SEARCH')

    // 非法状态忽略
    store.setFocusState('INVALID_STATE')
    expect(store.focusState).toBe('SEARCH')
  })

  it('侧边栏折叠状态机流转、布尔转换与本地持久化正常', () => {
    const store = useUIStore()
    // 默认值：展开（false），兼顾小白用户首屏探索
    expect(store.sidebarCollapsed).toBe(false)
    expect(store.isSidebarCollapsed).toBe(false)

    // 切换折叠
    store.toggleSidebar()
    expect(store.sidebarCollapsed).toBe(true)
    expect(store.isSidebarCollapsed).toBe(true)
    expect(localStorage.getItem('ztools_sidebar_collapsed')).toBe('true')

    // 再次切换展开
    store.toggleSidebar()
    expect(store.sidebarCollapsed).toBe(false)
    expect(store.isSidebarCollapsed).toBe(false)
    expect(localStorage.getItem('ztools_sidebar_collapsed')).toBe('false')

    // 显式赋值与布尔强制转换（异常边界）
    store.setSidebarCollapsed(1)
    expect(store.sidebarCollapsed).toBe(true)
    store.setSidebarCollapsed(0)
    expect(store.sidebarCollapsed).toBe(false)
    store.setSidebarCollapsed('truthy-string')
    expect(store.sidebarCollapsed).toBe(true)
    store.setSidebarCollapsed(null)
    expect(store.sidebarCollapsed).toBe(false)
  })

  it('localStorage 抛出异常时 setSidebarCollapsed 具备安全容错能力', () => {
    const store = useUIStore()
    const originalSetItem = localStorage.setItem
    try {
      localStorage.setItem = () => {
        throw new Error('QuotaExceededError or SecurityError')
      }
      expect(() => {
        store.setSidebarCollapsed(true)
      }).not.toThrow()
      expect(store.sidebarCollapsed).toBe(true)
    } finally {
      localStorage.setItem = originalSetItem
    }
  })
})
