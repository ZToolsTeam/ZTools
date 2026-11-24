import { defineStore } from 'pinia'
import {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  resolveLocale
} from '@/utils/locale'
import {
  LOCALE_STORAGE_KEY,
  getCurrentLocale,
  setI18nLocale
} from '@/i18n'

const VALID_SETTINGS = Object.freeze(['system', ...SUPPORTED_LOCALES])

function normalizeSetting(raw) {
  if (typeof raw !== 'string') return 'system'
  const trimmed = raw.trim()
  if (!trimmed || trimmed.toLowerCase() === 'system') return 'system'
  return SUPPORTED_LOCALES.includes(trimmed) ? trimmed : 'system'
}

function readStoredSetting() {
  try {
    if (typeof localStorage === 'undefined') return 'system'
    return normalizeSetting(localStorage.getItem(LOCALE_STORAGE_KEY))
  } catch {
    return 'system'
  }
}

function detectSystemLocale() {
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language.trim()) {
    return resolveLocale(navigator.language)
  }
  return DEFAULT_LOCALE
}

export const useLocaleStore = defineStore('locale', {
  state: () => ({
    /** 用户语言偏好：'system' | 'zh-CN' | 'en-US' */
    setting: readStoredSetting(),
    /** 当前探测到的系统规范语言：'zh-CN' | 'en-US' */
    systemLocale: detectSystemLocale(),
    /** 最终生效的规范语言：'zh-CN' | 'en-US' */
    locale: getCurrentLocale(),
    _initialized: false,
    _revision: 0,
    _storageHandler: null
  }),

  actions: {
    async init() {
      if (this._initialized) return
      this._initialized = true
      const revision = this._revision

      if (typeof window !== 'undefined') {
        this._storageHandler = (event) => {
          if (event?.key === LOCALE_STORAGE_KEY) {
            this.handleExternalStorageChange(event.newValue)
          }
        }
        window.addEventListener?.('storage', this._storageHandler)
      }

      const electronInitial = typeof window !== 'undefined' ? window.__ztoolsElectron?.initialLocale : null
      const hasElectronInitial = typeof electronInitial === 'string' && electronInitial.trim().length > 0

      let rawStored = null
      try {
        if (typeof localStorage !== 'undefined') {
          rawStored = localStorage.getItem(LOCALE_STORAGE_KEY)
        }
      } catch {
        rawStored = null
      }
      const hasStoredLocal = typeof rawStored === 'string' && rawStored.trim().length > 0
      const localSetting = normalizeSetting(rawStored)
      this.setting = localSetting

      // 同步阶段与 i18n/index.js 的 detectInitialLocale 保持同一优先级：
      // __ztoolsElectron.initialLocale > localStorage > systemLocale，避免首帧与 init 间二次闪屏；
      // 同时在确认 user_settings.json 前不覆写 systemLocale，防止把显式设置误记为系统语言。
      const initialDisplayLocale = hasElectronInitial
        ? resolveLocale(electronInitial, this.systemLocale)
        : resolveLocale(localSetting, this.systemLocale)
      this._applyLocale(initialDisplayLocale)

      try {
        if (typeof window !== 'undefined' && typeof window.ztools?.config?.get === 'function') {
          const savedSetting = await window.ztools.config.get('ui.locale', null, 'user_settings.json')
          if (revision !== this._revision) return
          if (typeof savedSetting === 'string' && savedSetting.trim()) {
            const normalized = normalizeSetting(savedSetting)
            this.setting = normalized
            if (normalized === 'system' && hasElectronInitial) {
              this.systemLocale = resolveLocale(electronInitial, this.systemLocale)
            }
            try {
              localStorage.setItem(LOCALE_STORAGE_KEY, normalized)
            } catch (err) {
              console.warn('[LocaleStore] 同步本地语言缓存失败:', err)
            }
            this._applyLocale(resolveLocale(normalized, this.systemLocale))
          } else if (!hasStoredLocal && hasElectronInitial) {
            this.systemLocale = resolveLocale(electronInitial, this.systemLocale)
            this._applyLocale(resolveLocale(this.setting, this.systemLocale))
          }
        }
      } catch (err) {
        console.warn('[LocaleStore] 初始化语言设置失败:', err)
      }
    },

    /** @param {'system' | 'zh-CN' | 'en-US'} next */
    async setLocale(next) {
      if (typeof next !== 'string' || !VALID_SETTINGS.includes(next)) {
        throw new Error(`Unsupported locale setting: ${String(next)}`)
      }
      const revision = ++this._revision
      if (typeof window !== 'undefined' && typeof window.ztools?.config?.set === 'function') {
        const saved = await window.ztools.config.set('ui.locale', next, true, 'user_settings.json')
        if (!saved) {
          throw new Error('Failed to save locale setting')
        }
      }
      if (revision !== this._revision) return
      this.setting = next
      try {
        localStorage.setItem(LOCALE_STORAGE_KEY, next)
      } catch (err) {
        console.warn('[LocaleStore] 写入本地语言缓存失败:', err)
      }
      const resolved = resolveLocale(next, this.systemLocale)
      this._applyLocale(resolved)
      return resolved
    },

    handleExternalStorageChange(rawValue) {
      this._revision++
      const nextSetting = normalizeSetting(rawValue)
      this.setting = nextSetting
      this._applyLocale(resolveLocale(nextSetting, this.systemLocale))
    },

    applyHostLocale(envelope) {
      return this.handleSystemLocaleChange(envelope)
    },

    handleSystemLocaleChange(envelope) {
      const payload = envelope && typeof envelope === 'object' && 'payload' in envelope
        ? envelope.payload
        : envelope

      let explicitDisplayLocale = ''

      if (typeof payload === 'string' && payload.trim()) {
        // 裸字符串仅视为宿主推送的当前显示语言，不篡改已探测的真实 systemLocale
        explicitDisplayLocale = payload.trim()
      } else if (payload && typeof payload === 'object') {
        if (typeof payload.systemLocale === 'string' && payload.systemLocale.trim()) {
          this.systemLocale = resolveLocale(payload.systemLocale, this.systemLocale)
        }
        if (typeof payload.setting === 'string' && VALID_SETTINGS.includes(payload.setting)) {
          this._revision++
          this.setting = payload.setting
          try {
            localStorage.setItem(LOCALE_STORAGE_KEY, payload.setting)
          } catch (err) {
            console.warn('[LocaleStore] 同步本地语言缓存失败:', err)
          }
          if (payload.setting === 'system' && !payload.systemLocale && typeof payload.locale === 'string' && payload.locale.trim()) {
            explicitDisplayLocale = payload.locale.trim()
          }
        } else if (typeof payload.locale === 'string' && payload.locale.trim() && !payload.systemLocale) {
          // payload.locale 为当前生效显示语言，绝不覆写 systemLocale
          explicitDisplayLocale = payload.locale.trim()
        }
      }

      const nextLocale = explicitDisplayLocale && this.setting === 'system'
        ? resolveLocale(explicitDisplayLocale, this.systemLocale)
        : resolveLocale(this.setting, this.systemLocale)
      this._applyLocale(nextLocale)
    },

    _applyLocale(resolved) {
      const normalized = setI18nLocale(resolved)
      this.locale = normalized
    },

    destroy() {
      if (!this._initialized) return
      this._initialized = false
      if (typeof window !== 'undefined') {
        if (this._storageHandler) {
          window.removeEventListener?.('storage', this._storageHandler)
          this._storageHandler = null
        }
      }
    }
  }
})
