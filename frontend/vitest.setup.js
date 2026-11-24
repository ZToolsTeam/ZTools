import { beforeEach } from 'vitest'
import { setI18nLocale } from '@/i18n'

// 默认锁定 jsdom 的 navigator.language 与全局 i18n 为 zh-CN，
// 避免 jsdom 默认 navigator.language='en-US' 在 vi.resetModules() 重载 @/i18n 后影响既有中文文案单测；
// 国际化单测可显式调用 setI18nLocale('en-US') 切换英文态验证。
if (typeof navigator !== 'undefined') {
  try {
    Object.defineProperty(navigator, 'language', {
      value: 'zh-CN',
      configurable: true
    })
  } catch (defineError) {
    // 不可重定义 navigator.language 的非 jsdom 环境保持默认
    void defineError
  }
}

beforeEach(() => {
  setI18nLocale('zh-CN')
})
