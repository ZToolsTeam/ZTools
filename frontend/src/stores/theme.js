/** 主题偏好（跟随系统/浅色/深色）与 6 款固定主题色分开保存，跟随系统时不固定深浅色。 */
import { defineStore } from 'pinia'
import { ACCENT_THEMES, DEFAULT_ACCENT, THEME_MODES, normalizeAccent } from '@/constants/themes'
import { t } from '@/i18n'

function systemPrefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

export const useThemeStore = defineStore('theme', {
  state: () => ({
    mode: 'system',
    isDark: false,
    accent: DEFAULT_ACCENT,
    _initialized: false,
    _revision: 0,
    _colorRevision: 0,
    _accentRevision: 0
  }),

  actions: {
    async init() {
      if (this._initialized) return
      this._initialized = true
      const revision = this._revision
      const accentRevision = this._accentRevision

      // 浏览器预览也支持跟随系统；Electron 窗口还会收到宿主的主题变化事件。
      const media = window.matchMedia?.('(prefers-color-scheme: dark)')
      media?.addEventListener?.('change', (event) => {
        if (this.mode === 'system') {
          this._colorRevision++
          this._applyTheme(event.matches)
        }
      })

      // 同源多窗口本地缓存变更同步兜底（悬浮条与工作台双实例）
      window.addEventListener?.('storage', (event) => {
        if (event?.key === 'ztools_accent' && ACCENT_THEMES.includes(event.newValue)) {
          this.handleExternalAccentChange(event.newValue)
        }
      })

      let localTheme = null
      let localAccent = null
      try {
        localTheme = localStorage.getItem('ztools_theme')
        localAccent = localStorage.getItem('ztools_accent')
      } catch (error) {
        console.warn('[ThemeStore] 读取本地主题缓存失败:', error)
      }

      // 先以本地缓存应用主题色，消除冷启动异步读取期间的色差
      if (accentRevision === this._accentRevision) {
        this._applyAccent(normalizeAccent(localAccent))
      }

      try {
        const hasConfigGet = typeof window.ztools?.config?.get === 'function'
        const [savedTheme, savedAccent] = hasConfigGet
          ? await Promise.all([
              window.ztools.config.get('ui.theme', null, 'user_settings.json'),
              window.ztools.config.get('ui.accent', null, 'user_settings.json')
            ])
          : [null, null]

        // 同步并迁移固定主题色
        if (accentRevision === this._accentRevision) {
          const nextAccent = ACCENT_THEMES.includes(savedAccent)
            ? savedAccent
            : normalizeAccent(localAccent)
          this._applyAccent(nextAccent)
          if (!ACCENT_THEMES.includes(savedAccent) && ACCENT_THEMES.includes(localAccent) && window.ztools?.config?.set) {
            const migratedAccent = await window.ztools.config.set('ui.accent', localAccent, true, 'user_settings.json')
            if (!migratedAccent) console.warn('[ThemeStore] 旧主题色偏好同步失败')
          }
        }

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
        if (accentRevision === this._accentRevision) {
          this._applyAccent(normalizeAccent(localAccent))
        }
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
      if (!THEME_MODES.includes(mode)) throw new Error(t('themeStore.unsupportedMode'))
      const revision = ++this._revision
      if (window.ztools?.config?.set) {
        const saved = await window.ztools.config.set('ui.theme', mode, true, 'user_settings.json')
        if (!saved) throw new Error(t('themeStore.themeNotSaved'))
      } else if (mode !== 'system' && window.ztools?.sys?.setDarkMode) {
        const saved = await window.ztools.sys.setDarkMode(mode === 'dark')
        if (!saved) throw new Error(t('themeStore.themeNotSaved'))
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

    /** @param {'ember' | 'glacier' | 'jade' | 'iris' | 'crimson' | 'mono'} accent */
    async setAccent(accent) {
      if (!ACCENT_THEMES.includes(accent)) throw new Error(t('themeStore.unsupportedAccent'))
      const accentRevision = ++this._accentRevision
      if (window.ztools?.config?.set) {
        const saved = await window.ztools.config.set('ui.accent', accent, true, 'user_settings.json')
        if (!saved) throw new Error(t('themeStore.accentNotSaved'))
      }
      if (accentRevision !== this._accentRevision) return
      try {
        localStorage.setItem('ztools_accent', accent)
      } catch (error) {
        console.warn('[ThemeStore] 写入本地主题色缓存失败:', error)
      }
      this._applyAccent(accent)
    },

    handleSystemThemeChange(isDark, mode) {
      this._colorRevision++
      if (THEME_MODES.includes(mode)) this.mode = mode
      this._applyTheme(isDark)
    },

    handleExternalAccentChange(accent) {
      if (!ACCENT_THEMES.includes(accent)) return
      this._accentRevision++
      try {
        localStorage.setItem('ztools_accent', accent)
      } catch (error) {
        console.warn('[ThemeStore] 同步本地主题色缓存失败:', error)
      }
      this._applyAccent(accent)
    },

    _applyTheme(isDark) {
      this.isDark = isDark
      document.documentElement.classList.toggle('dark', isDark)
    },

    _applyAccent(accent) {
      const normalized = normalizeAccent(accent)
      this.accent = normalized
      document.documentElement.dataset.accent = normalized
    }
  }
})

useThemeStore.prototype.load = useThemeStore.prototype.init
