/**
 * 开源版用户状态：开源版没有账号体系，始终是未登录的本地用户。
 * 与官方版 useUserStore 保持同样的字段与方法，公共页面可以无差别调用。
 */
import { defineStore } from 'pinia'

export const useUserStore = defineStore('user', {
  state: () => ({
    isLoggedIn: false,
    userInfo: null,
    isCheckingAuth: false
  }),

  getters: {
    displayName: () => '本地用户',
    avatar: () => '',
    isGuest: () => true
  },

  actions: {
    async checkLoginStatus() {
      this.isLoggedIn = false
      this.userInfo = null
      this.isCheckingAuth = false
    },
    async logout() {
      this.isLoggedIn = false
      this.userInfo = null
    },
    // 开源版不接受外部写入登录态，避免页面误以为已登录而走云端逻辑
    setLoginStatus() {
      this.isLoggedIn = false
      this.userInfo = null
    },
    initEventListeners() {},
    cleanupEventListeners() {}
  }
})
