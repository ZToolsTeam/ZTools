import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useUserStore } from '../user'

const authMocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn(),
  getCurrentUser: vi.fn(),
  logout: vi.fn()
}))

vi.mock('@/api/apiserver', () => ({
  isAuthenticated: authMocks.isAuthenticated,
  getCurrentUser: authMocks.getCurrentUser,
  logout: authMocks.logout
}))

vi.mock('@/config/api', () => ({
  currentApiUrl: ''
}))

describe('useUserStore event listeners', () => {
  let userStore
  let onMock
  let offMock

  beforeEach(() => {
    setActivePinia(createPinia())
    userStore = useUserStore()
    onMock = vi.fn()
    offMock = vi.fn()
    window.ztools = {
      events: {
        on: onMock,
        off: offMock
      }
    }
  })

  afterEach(() => {
    delete window.ztools
    vi.clearAllMocks()
  })

  it('registers handlers once and removes them only after the last cleanup', () => {
    userStore.initEventListeners()
    userStore.initEventListeners()

    expect(onMock).toHaveBeenCalledTimes(2)
    expect(onMock).toHaveBeenNthCalledWith(
      1,
      'user.login',
      userStore._loginEventHandler
    )
    expect(onMock).toHaveBeenNthCalledWith(
      2,
      'user.logout',
      userStore._logoutEventHandler
    )

    userStore.cleanupEventListeners()
    expect(offMock).not.toHaveBeenCalled()

    userStore.cleanupEventListeners()
    expect(offMock).toHaveBeenCalledTimes(2)
    expect(offMock).toHaveBeenNthCalledWith(
      1,
      'user.login',
      userStore._loginEventHandler
    )
    expect(offMock).toHaveBeenNthCalledWith(
      2,
      'user.logout',
      userStore._logoutEventHandler
    )
  })

  it('keeps login state cleanup scoped to the store handler', () => {
    userStore.initEventListeners()
    userStore.isLoggedIn = true
    userStore.userInfo = { id: 1 }

    userStore._logoutEventHandler()

    expect(userStore.isLoggedIn).toBe(false)
    expect(userStore.userInfo).toBeNull()
  })
})
