/**
 * 主题状态管理
 * 采用 CSS 变量 + class 切换的方案
 * 主题状态通过 document.documentElement 的 .dark 类来控制
 */
import { defineStore } from 'pinia'

export const useThemeStore = defineStore('theme', {
  state: () => ({
    isDark: false,
    _initialized: false
  }),

  actions: {
    /**
     * 初始化主题
     * 从后端配置或系统信息读取主题设置
     */
    async init() {
      if (this._initialized) return
      this._initialized = true

      try {
        let localTheme = null
        try {
          localTheme = localStorage.getItem('ztools_theme')
        } catch (e) {
          console.warn('[ThemeStore] 读取本地主题缓存失败:', e)
        }

        // 优先从用户配置读取
        let theme = null
        if (window.ztools?.config?.get) {
          theme = await window.ztools.config.get('ui.theme', null, 'user_settings.json')
        }
        if (!theme) {
          theme = localTheme
        }

        if (theme) {
          const isDark = theme === 'dark'
          this._applyTheme(isDark)
          if (window.ztools?.sys?.setDarkMode) {
            await window.ztools.sys.setDarkMode(isDark).catch((err) => console.warn('[ThemeStore] 同步主题配置失败:', err))
          }
          return
        }

        // 其次从系统信息获取
        if (window.ztools?.sys?.getInfo) {
          const info = await window.ztools.sys.getInfo()
          if (info?.darkMode !== undefined) {
            this._applyTheme(info.darkMode)
            if (window.ztools?.sys?.setDarkMode) {
              await window.ztools.sys.setDarkMode(info.darkMode).catch((err) => console.warn('[ThemeStore] 同步主题配置失败:', err))
            }
            return
          }
        }

        // 最后使用系统偏好
        if (window.matchMedia) {
          const prefersDark = window.matchMedia(
            '(prefers-color-scheme: dark)'
          ).matches
          this._applyTheme(prefersDark)
          if (window.ztools?.sys?.setDarkMode) {
            await window.ztools.sys.setDarkMode(prefersDark).catch((err) => console.warn('[ThemeStore] 同步主题配置失败:', err))
          }
        }
      } catch (err) {
        console.error('[ThemeStore] 初始化主题失败:', err)
        this._applyTheme(false)
      }
    },

    /**
     * 切换主题
     */
    async toggle() {
      const newDark = !this.isDark
      this._applyTheme(newDark)
      await this._saveTheme(newDark)
    },

    /**
     * 设置主题
     * @param {'light' | 'dark'} theme
     */
    async setTheme(theme) {
      const isDark = theme === 'dark'
      this._applyTheme(isDark)
      await this._saveTheme(isDark)
    },

    /**
     * 处理系统主题变化事件
     * @param {boolean} isDark
     */
    handleSystemThemeChange(isDark) {
      this._applyTheme(isDark)
    },

    /**
     * 应用主题到 DOM
     * @private
     */
    _applyTheme(isDark) {
      this.isDark = isDark
      document.documentElement.classList.toggle('dark', isDark)
    },

    /**
     * 保存主题设置
     * @private
     */
    async _saveTheme(isDark) {
      const theme = isDark ? 'dark' : 'light'
      try {
        try {
          localStorage.setItem('ztools_theme', theme)
        } catch (e) {
          console.warn('[ThemeStore] 写入本地主题缓存失败:', e)
        }
        if (window.ztools?.sys?.setDarkMode) {
          await window.ztools.sys.setDarkMode(isDark).catch((err) => console.warn('[ThemeStore] 同步主题配置失败:', err))
        }
        if (window.ztools?.config?.set) {
          await window.ztools.config.set('ui.theme', theme, true, 'user_settings.json').catch((err) => console.warn('[ThemeStore] 同步主题配置失败:', err))
        }
      } catch (err) {
        console.warn('[ThemeStore] 保存主题失败:', err)
      }
    }
  }
})

// 兼容旧的 load 方法名
useThemeStore.prototype.load = useThemeStore.prototype.init
