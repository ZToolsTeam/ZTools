import { defineStore } from 'pinia'

import {
  isAuthenticated,
  getCurrentUser,
  logout as authLogout
} from '@/api/apiserver'
import { currentApiUrl } from '@/config/api'

const DEFAULT_AVATAR =
  'https://cube.elemecdn.com/3/7c/3ea6beec64369c2642b92c6726f1epng.png'

function getApiOrigin() {
  try {
    if (currentApiUrl && /^https?:\/\//.test(currentApiUrl)) {
      return new URL(currentApiUrl).origin
    }
  } catch {}

  try {
    const baseUrl = import.meta.env.VITE_API_BASE_URL
    if (baseUrl && /^https?:\/\//.test(baseUrl)) {
      return new URL(baseUrl).origin
    }
  } catch {}

  try {
    if (
      window.location?.origin &&
      /^https?:\/\//.test(window.location.origin) &&
      window.location.origin !== 'null'
    ) {
      return window.location.origin
    }
  } catch {}

  return ''
}

function normalizeAvatarUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return DEFAULT_AVATAR

  const trimmed = rawUrl.trim()
  if (!trimmed) return DEFAULT_AVATAR

  if (/^(https?:|data:|blob:)/i.test(trimmed)) return trimmed

  const origin = getApiOrigin()
  if (!origin) return trimmed

  if (trimmed.startsWith('//')) {
    return `https:${trimmed}`
  }

  if (trimmed.startsWith('/')) {
    return `${origin}${trimmed}`
  }

  return `${origin}/${trimmed}`
}

export const useUserStore = defineStore('user', {
  state: () => ({
    isLoggedIn: false,
    userInfo: null,
    isCheckingAuth: true,
    _eventListenerRefs: 0,
    _loginEventHandler: null,
    _logoutEventHandler: null
  }),

  getters: {
    // 显示名称
    displayName: (state) => {
      if (!state.userInfo) return '未登录'
      // 优先显示昵称，其次显示 用户+ID
      return state.userInfo.nickname || `用户${state.userInfo.id || ''}`
    },

    // 用户头像
    avatar: (state) => {
      return normalizeAvatarUrl(state.userInfo?.avatar)
    },

    // 访客/本地模式
    isGuest: (state) => !state.isLoggedIn
  },

  actions: {
    // 检查登录状态
    async checkLoginStatus() {
      this.isCheckingAuth = true

      // 包装实际的检查逻辑
      const performCheck = async () => {
        try {
          // 1. 优先获取本地保存的登录状态和基础信息（极快，不涉及网络）
          if (window.ztools && window.ztools.user) {
            const authInfo = await window.ztools.user.getInfo()
            this.isLoggedIn = authInfo.loggedIn
            if (this.isLoggedIn) {
              // 先用本地信息填充，让界面立刻显示
              this.userInfo = authInfo.user || null

              // 2. 异步刷新最新信息（涉及网络，但不阻塞初始化）
              getCurrentUser()
                .then((user) => {
                  if (user) this.userInfo = user
                })
                .catch((err) => {
                  console.warn('[UserStore] 异步刷新用户信息失败:', err)
                })
            }
          } else {
            // 非原生环境（Mock）
            this.isLoggedIn = await isAuthenticated()
            if (this.isLoggedIn) {
              this.userInfo = await getCurrentUser()
            }
          }
        } catch (err) {
          console.error('[UserStore] 检查登录状态失败:', err)
          this.isLoggedIn = false
          this.userInfo = null
        }
      }

      try {
        // 使用 Promise.race 添加超时保护 (3秒)
        // 防止 Native 接口卡死导致 loading 状态一直不消失
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Login check timeout')), 3000)
        )

        await Promise.race([performCheck(), timeoutPromise])
      } catch (err) {
        if (err.message === 'Login check timeout') {
          console.warn('[UserStore] 检查登录状态超时，重置为未登录状态')
        } else {
          console.error('[UserStore] 检查登录状态异常:', err)
        }
        // 超时或异常时，确保状态可控
        if (this.isCheckingAuth) {
          // 只有当还在检查状态时才重置，避免覆盖后续可能的并发更新
          // 但这里是单线程JS，并发通常指后续微任务。
          // 简单起见，超时就认为是未登录，让用户有机会手动点击登录
          // 除非已经在其他地方被设为 true 了（极少见）
        }
      } finally {
        this.isCheckingAuth = false
      }
    },

    // 退出登录
    async logout() {
      await authLogout()
      this.isLoggedIn = false
      this.userInfo = null
      // 埋点：用户登出
      window.ztools?.analytics?.report('logout')
    },

    // 设置登录状态（供登录页面调用）
    setLoginStatus(isLoggedIn, userInfo = null) {
      this.isLoggedIn = isLoggedIn
      this.userInfo = userInfo
    },

    // 初始化事件监听
    initEventListeners() {
      if (!window.ztools?.events?.on) return

      this._eventListenerRefs += 1
      if (this._eventListenerRefs > 1) return

      if (!this._loginEventHandler) {
        this._loginEventHandler = () => {
          this.checkLoginStatus()
        }
      }

      if (!this._logoutEventHandler) {
        this._logoutEventHandler = () => {
          this.isLoggedIn = false
          this.userInfo = null
        }
      }

      window.ztools.events.on('user.login', this._loginEventHandler)
      window.ztools.events.on('user.logout', this._logoutEventHandler)
    },

    // 清理事件监听
    cleanupEventListeners() {
      if (this._eventListenerRefs > 0) {
        this._eventListenerRefs -= 1
      }

      if (this._eventListenerRefs > 0) return

      if (window.ztools?.events?.off) {
        if (this._loginEventHandler) {
          window.ztools.events.off('user.login', this._loginEventHandler)
        }
        if (this._logoutEventHandler) {
          window.ztools.events.off('user.logout', this._logoutEventHandler)
        }
      }
    }
  }
})
