import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { setI18nLocale, getCurrentLocale } from '@/i18n'
import { useUserStore as useOssUserStore } from '@/edition-oss/userStore'
import { useThemeStore } from '@/stores/theme'
import { useCategoriesStore } from '@/stores/categories'
import { downloadPluginUpdate } from '@/api/update'
import environment, { resolveSdkText } from '../../../public/js/cef-ipc/src/core/environment.js'
import MockProvider from '../../../public/js/cef-ipc/src/core/mock-provider.js'
import UpdateAPI from '../../../public/js/cef-ipc/src/api/update.js'
import CredentialsAPI from '../../../public/js/cef-ipc/src/api/credentials.js'
import SystemAPI from '../../../public/js/cef-ipc/src/api/sys.js'
import { ensureRuntimeCapability } from '../../../public/js/cef-ipc/src/api/runtime-capability.js'

const sdkSrcRoot = path.resolve(process.cwd(), 'public/js/cef-ipc/src')

describe('SDK 核心运行时双语报错与独立 eval 兼容', () => {
  const originalLocale = getCurrentLocale()

  beforeEach(() => {
    setActivePinia(createPinia())
    setI18nLocale('zh-CN')
    localStorage.clear()
  })

  afterEach(() => {
    setI18nLocale(originalLocale)
    delete window.__ztoolsElectron
    delete window.ztools
    vi.restoreAllMocks()
  })

  it('resolveSdkText 按 __ztoolsLocale > document.documentElement.lang > localStorage > navigator.language 解析', () => {
    setI18nLocale('zh-CN')
    expect(resolveSdkText('中文', 'English')).toBe('中文')

    setI18nLocale('en-US')
    expect(resolveSdkText('中文', 'English')).toBe('English')

    // 验证显式 __ztoolsLocale 覆盖 document.lang
    globalThis.__ztoolsLocale = 'zh-CN'
    document.documentElement.lang = 'en-US'
    expect(resolveSdkText('中文', 'English')).toBe('中文')

    // 清除 __ztoolsLocale 后读取 document.documentElement.lang
    delete globalThis.__ztoolsLocale
    expect(resolveSdkText('中文', 'English')).toBe('English')

    // 清除 document.lang 后读取 localStorage.ztools_locale
    document.documentElement.lang = ''
    localStorage.setItem('ztools_locale', 'en-US')
    expect(resolveSdkText('中文', 'English')).toBe('English')
  })

  it('核心 SDK 模块在中文/英文环境下返回对应语言报错', async () => {
    const fakeTransport = {
      isElectronEnvironment: () => false,
      call: vi.fn(async () => ({}))
    }
    const updateApi = new UpdateAPI(fakeTransport)
    const credentialsApi = new CredentialsAPI(fakeTransport)
    const sysApi = new SystemAPI(fakeTransport)
    const mockProvider = new MockProvider()

    // 简体中文态
    setI18nLocale('zh-CN')
    expect(environment.createEnvironmentError('fs.readFile').message).toContain('环境错误')
    expect(mockProvider.generate('dllplugin_call', {}).error).toContain('Mock 环境下不可用')
    await expect(updateApi.check()).rejects.toThrow('更新检查响应无效')
    await expect(credentialsApi.v1.set('bad key!', 'val')).rejects.toThrow('凭据 key 格式无效')
    await expect(sysApi.getCapability('screen.capture')).rejects.toThrow('运行时能力查询仅支持 Electron 宿主')
    await expect(
      ensureRuntimeCapability(
        {
          transport: { isElectronEnvironment: () => true },
          getCapability: async () => ({ authorization: 'denied' })
        },
        'screen.capture'
      )
    ).rejects.toThrow('屏幕访问未获授权')

    // 英文态
    setI18nLocale('en-US')
    expect(environment.createEnvironmentError('fs.readFile').message).toContain('Environment error')
    expect(mockProvider.generate('dllplugin_call', {}).error).toContain('unavailable in browser/mock mode')
    await expect(updateApi.check()).rejects.toThrow('Invalid update_check response')
    await expect(credentialsApi.v1.set('bad key!', 'val')).rejects.toThrow('Invalid credential key format')
    await expect(sysApi.getCapability('screen.capture')).rejects.toThrow('only supported in the Electron host')
    await expect(
      ensureRuntimeCapability(
        {
          transport: { isElectronEnvironment: () => true },
          getCapability: async () => ({ authorization: 'denied' })
        },
        'screen.capture'
      )
    ).rejects.toThrow('Screen access is not authorized')
  })

  it('兼容单文件 new Function 独立加载（不加载 environment.js 且不剥离 import）并支持中英文切换', async () => {
    const loadStandalone = (relPath, className) => {
      const code = readFileSync(path.join(sdkSrcRoot, relPath), 'utf8').replace(/^export .+$/mg, '')
      return new Function(`${code}\nreturn ${className}`)()
    }

    // 即使删除全局缓存也必须安全工作、绝不抛 ReferenceError
    const savedHelper = globalThis.__ztoolsResolveSdkText
    delete globalThis.__ztoolsResolveSdkText
    try {
      const StandaloneDll = loadStandalone('api/dllplugin.js', 'DLLPluginAPI')
      const StandaloneZip = loadStandalone('api/zip.js', 'ZipAPI')
      const StandaloneClipboard = loadStandalone('api/clipboard.js', 'ClipboardAPI')
      const StandaloneFsRef = loadStandalone('api/fs-reference.js', 'ReferenceFileSystemAPI')

      const fakeTransport = { call: async () => ({ success: false }) }
      const dll = new StandaloneDll(fakeTransport, { on() {}, off() {} })
      const zip = new StandaloneZip(dll, fakeTransport)
      const clip = new StandaloneClipboard(fakeTransport, { on() {}, off() {} })
      const fsRef = new StandaloneFsRef(fakeTransport)

      setI18nLocale('en-US')
      await expect(dll.call('', 'fn')).rejects.toThrow('Invalid plugin name')
      await expect(zip.list('')).rejects.toThrow('archive parameter is required')
      await expect(clip.readText({ signal: new AbortController().signal })).rejects.toThrow('does not support cancellation options')
      expect(() => fsRef._relative('../bad')).toThrow('outside the authorized scope')

      setI18nLocale('zh-CN')
      await expect(dll.call('', 'fn')).rejects.toThrow('插件名称无效')
      await expect(zip.list('')).rejects.toThrow('archive 参数必填')
      await expect(clip.readText({ signal: new AbortController().signal })).rejects.toThrow('当前剪贴板合约不支持取消选项')
      expect(() => fsRef._relative('../bad')).toThrow('相对文件名超出授权范围')
    } finally {
      globalThis.__ztoolsResolveSdkText = savedHelper
    }
  })

  it('公共层 OSS userStore、themeStore、categoriesStore 与 api/update 在英文态输出英文词条', async () => {
    const ossUserStore = useOssUserStore()
    const themeStore = useThemeStore()
    const categoriesStore = useCategoriesStore()

    setI18nLocale('zh-CN')
    expect(ossUserStore.displayName).toBe('本地用户')
    await expect(themeStore.setTheme('invalid')).rejects.toThrow('不支持的主题模式')
    await expect(themeStore.setAccent('invalid')).rejects.toThrow('不支持的主题色')
    await expect(downloadPluginUpdate('calculator')).rejects.toThrow('内置插件随客户端更新')

    setI18nLocale('en-US')
    expect(ossUserStore.displayName).toBe('Local User')
    await expect(themeStore.setTheme('invalid')).rejects.toThrow('Unsupported theme mode')
    await expect(themeStore.setAccent('invalid')).rejects.toThrow('Unsupported accent theme')
    await expect(downloadPluginUpdate('calculator')).rejects.toThrow('Built-in plugins update with the client')

    // 验证 categoriesStore 英文错误（目录请求失败与空 message 兜底）
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await categoriesStore.fetchCategories(true)
    expect(categoriesStore.error).toContain('Plugin catalog is temporarily unavailable')
    vi.unstubAllGlobals()

    // 验证空 message 异常时 categoriesStore 使用 categoriesStore.loadFailed 英文兜底
    vi.resetModules()
    vi.doMock('@/api/apiserver', () => ({
      getCategories: vi.fn().mockRejectedValue(new Error(''))
    }))
    try {
      const { createPinia: createFreshPinia, setActivePinia: setFreshPinia } = await import('pinia')
      const { setI18nLocale: setFreshLocale } = await import('@/i18n')
      const { useCategoriesStore: useFreshCategoriesStore } = await import('@/stores/categories')
      setFreshPinia(createFreshPinia())
      setFreshLocale('en-US')
      const freshCategoriesStore = useFreshCategoriesStore()
      await freshCategoriesStore.fetchCategories(true)
      expect(freshCategoriesStore.error).toBe('Failed to load categories')
    } finally {
      vi.doUnmock('@/api/apiserver')
    }
  })
})
