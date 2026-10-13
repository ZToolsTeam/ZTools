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
})
