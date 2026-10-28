/** 主题偏好与当前显示颜色分开保存，跟随系统时不固定深浅色。 */
import { defineStore } from 'pinia'

const THEME_MODES = ['system', 'light', 'dark']

function systemPrefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export const useThemeStore = defineStore('theme', {
  state: () => ({
    mode: 'system',
    isDark: false,
    _initialized: false,
    _revision: 0,
    _colorRevision: 0
  }),

  actions: {
    async init() {
      if (this._initialized) return
      this._initialized = true
      const revision = this._revision

      // 浏览器预览也支持跟随系统；Electron 窗口还会收到宿主的主题变化事件。
      const media = window.matchMedia?.('(prefers-color-scheme: dark)')
      media?.addEventListener?.('change', (event) => {
        if (this.mode === 'system') {
          this._colorRevision++
          this._applyTheme(event.matches)
        }
      })

      try {
        let localTheme = null
        try {
          localTheme = localStorage.getItem('ztools_theme')
        } catch (error) {
          console.warn('[ThemeStore] 读取本地主题缓存失败:', error)
        }
        const savedTheme = window.ztools?.config?.get
          ? await window.ztools.config.get('ui.theme', null, 'user_settings.json')
          : null
        if (revision !== this._revision) return
        const preference = savedTheme || localTheme
        this.mode = THEME_MODES.includes(preference) ? preference : 'system'
        // 旧版本可能只保存了本地缓存，需要同步给宿主，避免界面和原生窗口颜色不一致。
        if (!savedTheme && THEME_MODES.includes(localTheme) && window.ztools?.config?.set) {
          const migrated = await window.ztools.config.set('ui.theme', localTheme, true, 'user_settings.json')
          if (!migrated) console.warn('[ThemeStore] 旧主题偏好同步失败')
          if (revision !== this._revision) return
        }
        if (this.mode !== 'system') {
          this._applyTheme(this.mode === 'dark')
          return
        }
        const colorRevision = this._colorRevision
        const info = await window.ztools?.sys?.getInfo?.()
        if (revision !== this._revision || colorRevision !== this._colorRevision) return
        this._applyTheme(typeof info?.darkMode === 'boolean' ? info.darkMode : systemPrefersDark())
      } catch (error) {
        console.warn('[ThemeStore] 初始化主题失败:', error)
        if (revision === this._revision) {
          this._applyTheme(this.mode === 'system' ? systemPrefersDark() : this.mode === 'dark')
        }
      }
    },

    async toggle() {
      await this.setTheme(this.isDark ? 'light' : 'dark')
    },

    /** @param {'system' | 'light' | 'dark'} mode */
    async setTheme(mode) {
      if (!THEME_MODES.includes(mode)) throw new Error('不支持的主题模式')
      const revision = ++this._revision
      if (window.ztools?.config?.set) {
        const saved = await window.ztools.config.set('ui.theme', mode, true, 'user_settings.json')
        if (!saved) throw new Error('主题设置未保存')
      } else if (mode !== 'system' && window.ztools?.sys?.setDarkMode) {
        const saved = await window.ztools.sys.setDarkMode(mode === 'dark')
        if (!saved) throw new Error('主题设置未保存')
      }
      if (revision !== this._revision) return
      this.mode = mode
      try {
        localStorage.setItem('ztools_theme', mode)
      } catch (error) {
        console.warn('[ThemeStore] 写入本地主题缓存失败:', error)
      }
      if (mode === 'system') {
        let info
        const colorRevision = this._colorRevision
        try {
          info = await window.ztools?.sys?.getInfo?.()
        } catch (error) {
          console.warn('[ThemeStore] 读取系统主题失败:', error)
        }
        if (revision !== this._revision || colorRevision !== this._colorRevision) return
        this._applyTheme(typeof info?.darkMode === 'boolean' ? info.darkMode : systemPrefersDark())
      } else {
        this._applyTheme(mode === 'dark')
      }
    },

    handleSystemThemeChange(isDark, mode) {
      this._colorRevision++
      if (THEME_MODES.includes(mode)) this.mode = mode
      this._applyTheme(isDark)
    },

    _applyTheme(isDark) {
      this.isDark = isDark
      document.documentElement.classList.toggle('dark', isDark)
    }
  }
})

useThemeStore.prototype.load = useThemeStore.prototype.init
