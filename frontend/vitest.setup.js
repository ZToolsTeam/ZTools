import { beforeEach } from 'vitest'
import { setI18nLocale } from '@/i18n'

// 默认锁定 zh-CN，避免 jsdom 默认 navigator.language='en-US' 影响既有中文文案单测；
// 国际化单测可显式调用 setI18nLocale('en-US') 切换英文态验证。
beforeEach(() => {
  setI18nLocale('zh-CN')
})
