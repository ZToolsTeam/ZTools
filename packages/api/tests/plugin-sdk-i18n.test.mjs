import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SDK_PATH = path.resolve(__dirname, '../runtime/plugin-sdk.js')
const SDK_SOURCE = fs.readFileSync(SDK_PATH, 'utf8')
const ZTOOLS_API_PATH = path.resolve(__dirname, '../runtime/ztools-api.js')
const ZTOOLS_API_SOURCE = fs.readFileSync(ZTOOLS_API_PATH, 'utf8')

/**
 * 轻量 DOM 节点模拟（用于无头验证 plugin-sdk.js 的拖拽遮罩与关闭确认弹窗文案）
 */
class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.id = ''
    this.className = ''
    this.textContent = ''
    this.innerHTML = ''
    this.style = { cssText: '', display: '' }
    this.children = []
    this.parentNode = null
    this.listeners = new Map()
    this.focused = false
    const classes = new Set()
    this.classList = {
      add: (name) => {
        classes.add(name)
        this.className = Array.from(classes).join(' ')
      },
      remove: (name) => {
        classes.delete(name)
        this.className = Array.from(classes).join(' ')
      },
      toggle: (name, force) => {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name)
          else classes.add(name)
        } else if (force) {
          classes.add(name)
        } else {
          classes.delete(name)
        }
        this.className = Array.from(classes).join(' ')
      },
      contains: (name) => classes.has(name)
    }
  }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child) {
    const idx = this.children.indexOf(child)
    if (idx !== -1) {
      this.children.splice(idx, 1)
      child.parentNode = null
    }
    return child
  }

  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name).add(fn)
  }

  removeEventListener(name, fn) {
    this.listeners.get(name)?.delete(fn)
  }

  focus() {
    this.focused = true
  }

  querySelector(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : null
    const visit = (node) => {
      for (const child of node.children) {
        if (className && child.className.split(/\s+/).includes(className)) {
          return child
        }
        const nested = visit(child)
        if (nested) return nested
      }
      return null
    }
    return visit(this)
  }

  findAll(predicate, acc = []) {
    for (const child of this.children) {
      if (predicate(child)) acc.push(child)
      child.findAll(predicate, acc)
    }
    return acc
  }
}

function createSdkHarness(options = {}) {
  const head = new FakeElement('head')
  const body = new FakeElement('body')
  const documentElement = new FakeElement('html')
  documentElement.lang = options.docLang ?? ''

  const docListeners = new Map()
  const eventHandlers = new Map()
  const windowMessages = []
  const errors = []

  const document = {
    readyState: 'complete',
    head,
    body,
    documentElement,
    createElement: (tag) => new FakeElement(tag),
    getElementById: (id) => {
      const search = (root) => {
        for (const child of root.children) {
          if (child.id === id) return child
          const found = search(child)
          if (found) return found
        }
        return null
      }
      return search(head) || search(body)
    },
    addEventListener: (name, fn) => {
      if (!docListeners.has(name)) docListeners.set(name, new Set())
      docListeners.get(name).add(fn)
    },
    removeEventListener: (name, fn) => {
      docListeners.get(name)?.delete(fn)
    }
  }

  const windowObj = {
    location: {
      href: 'ztools://plugins/demo/index.html',
      protocol: 'ztools:',
      hostname: 'plugins'
    },
    // 与 electron-client/src/preload/main.ts 保持一致：真实 bridge 对象被 Object.freeze 冻结
    __ztoolsElectron: Object.freeze({
      contractVersion: options.contractVersion ?? 2,
      ...(options.initialLocale !== undefined ? { initialLocale: options.initialLocale } : {})
    }),
    ztools: {
      events: {
        on: (name, fn) => eventHandlers.set(name, fn)
      },
      window: {
        close: async () => {
          windowMessages.push('close')
        }
      }
    }
  }

  if (options.globalLocale !== undefined) {
    windowObj.__ztoolsLocale = options.globalLocale
  }

  const navigatorObj = options.navigatorLanguage !== undefined
    ? { language: options.navigatorLanguage }
    : { language: '' }

  const context = {
    window: windowObj,
    document,
    navigator: navigatorObj,
    TextEncoder,
    console: {
      log() {},
      warn() {},
      error: (...args) => errors.push(args)
    },
    setTimeout,
    clearTimeout
  }
  if (options.globalLocale !== undefined) {
    context.__ztoolsLocale = options.globalLocale
  }

  vm.runInNewContext(SDK_SOURCE, context)

  return {
    window: windowObj,
    document,
    body,
    sdk: windowObj.ztoolsPlugin,
    eventHandlers,
    windowMessages,
    errors,
    context
  }
}

test('plugin-sdk.js: renders English UI texts by default and when initialLocale overrides navigator.language', async () => {
  const h = createSdkHarness({
    initialLocale: 'en-US',
    navigatorLanguage: 'zh-CN'
  })

  // 1. 拖拽遮罩默认英文文案
  h.sdk.enableFileDrop()
  const overlay = h.document.getElementById('ztools-file-drop-overlay')
  assert.ok(overlay)
  assert.equal(overlay.querySelector('.zt-drop-text').textContent, 'Drop files here')

  // 2. 关闭确认弹窗英文文案与交互
  const closePromise = h.window.__ztools_close_handler()
  const dialogOverlay = h.body.children[h.body.children.length - 1]
  const dialog = dialogOverlay.children[0]
  assert.equal(dialog.children[0].textContent, 'Confirm Close')
  assert.equal(dialog.children[1].textContent, 'Are you sure you want to close this window?')
  const buttons = dialog.findAll((el) => el.tagName === 'BUTTON')
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0].textContent, 'Cancel')
  assert.equal(buttons[1].textContent, 'Close')

  // 点击确认关闭按钮
  buttons[1].onclick()
  await closePromise
  assert.deepEqual(h.windowMessages, ['close'])

  // 3. SDK2 拖放监听超限错误文案（英文 + 保持 FILE_TOO_LARGE 错误码）
  const cleanups = []
  for (let i = 0; i < 256; i += 1) {
    cleanups.push(h.sdk.onFileDrop(() => {}))
  }
  assert.throws(
    () => h.sdk.onFileDrop(() => {}),
    (err) => err.code === 'FILE_TOO_LARGE' && /File drop listener limit/.test(err.message)
  )
  for (const cleanup of cleanups) cleanup()
})

test('plugin-sdk.js: renders Chinese UI texts from globalThis.__ztoolsLocale, html lang, or navigator.language', async () => {
  // 通过 globalThis.__ztoolsLocale 触发中文
  const h1 = createSdkHarness({
    globalLocale: 'zh-TW',
    navigatorLanguage: 'en-US'
  })
  h1.sdk.enableFileDrop()
  const overlay1 = h1.document.getElementById('ztools-file-drop-overlay')
  assert.equal(overlay1.querySelector('.zt-drop-text').textContent, '拖放文件到此处')

  const closePromise = h1.window.__ztools_close_handler()
  const dialogOverlay = h1.body.children[h1.body.children.length - 1]
  const dialog = dialogOverlay.children[0]
  assert.equal(dialog.children[0].textContent, '确认关闭')
  assert.equal(dialog.children[1].textContent, '确定要关闭此窗口吗？')
  const buttons = dialog.findAll((el) => el.tagName === 'BUTTON')
  assert.equal(buttons[0].textContent, '取消')
  assert.equal(buttons[1].textContent, '关闭')
  buttons[0].onclick()
  await closePromise
  assert.deepEqual(h1.windowMessages, [])

  // 通过 document.documentElement.lang 触发中文
  const h2 = createSdkHarness({ docLang: 'zh-CN', navigatorLanguage: 'en-US' })
  h2.sdk.enableFileDrop()
  assert.equal(
    h2.document.getElementById('ztools-file-drop-overlay').querySelector('.zt-drop-text').textContent,
    '拖放文件到此处'
  )

  // 通过 navigator.language 兜底触发中文
  const h3 = createSdkHarness({ navigatorLanguage: 'zh-CN' })
  h3.sdk.enableFileDrop()
  assert.equal(
    h3.document.getElementById('ztools-file-drop-overlay').querySelector('.zt-drop-text').textContent,
    '拖放文件到此处'
  )
})

test('plugin-sdk.js: updates default drop overlay text live via system.LocaleChange even when __ztoolsElectron is frozen, while preserving custom overlayText', async () => {
  const h = createSdkHarness({ initialLocale: 'en-US' })
  assert.equal(Object.isFrozen(h.window.__ztoolsElectron), true)
  h.sdk.enableFileDrop()
  const overlay = h.document.getElementById('ztools-file-drop-overlay')
  assert.equal(overlay.querySelector('.zt-drop-text').textContent, 'Drop files here')

  // 运行期收到宿主广播的 system.LocaleChange 事件时，即使 initialLocale 冻结为 en-US 也必须即时切为中文
  const onLocaleChange = h.eventHandlers.get('system.LocaleChange')
  assert.equal(typeof onLocaleChange, 'function', 'plugin-sdk 必须订阅 system.LocaleChange 事件')
  onLocaleChange({ payload: { locale: 'zh-CN', setting: 'zh-CN', previousLocale: 'en-US' } })
  assert.equal(h.window.__ztoolsLocale, 'zh-CN')
  assert.equal(h.document.documentElement.lang, 'zh-CN')
  assert.equal(overlay.querySelector('.zt-drop-text').textContent, '拖放文件到此处')

  // 关闭确认弹窗同步切为中文
  const closeZhPromise = h.window.__ztools_close_handler()
  const zhDialog = h.body.children[h.body.children.length - 1].children[0]
  assert.equal(zhDialog.children[0].textContent, '确认关闭')
  zhDialog.findAll((el) => el.tagName === 'BUTTON')[0].onclick()
  await closeZhPromise

  // 再次热切回 en-US，__ztoolsLocale 优先级高于冻结的 initialLocale
  onLocaleChange({ payload: { locale: 'en-US', setting: 'en-US', previousLocale: 'zh-CN' } })
  h.eventHandlers.get('plugin_drag_enter')()
  assert.equal(overlay.querySelector('.zt-drop-text').textContent, 'Drop files here')

  // 显式传入 custom overlayText 时不应被覆盖
  h.sdk.enableFileDrop({ overlayText: 'Custom Drop Label' })
  const customOverlay = h.document.getElementById('ztools-file-drop-overlay')
  onLocaleChange({ payload: { locale: 'zh-CN' } })
  h.eventHandlers.get('plugin_drag_enter')()
  assert.equal(customOverlay.querySelector('.zt-drop-text').textContent, 'Custom Drop Label')
})

test('ztools-api.js: resolveSdkText falls back to en-US for non-Chinese/empty locales and prioritizes __ztoolsLocale over initialLocale', () => {
  const runApiResolver = ({ globalLocale, initialLocale, docLang, storageLocale, navLang } = {}) => {
    const windowObj = {
      __ztoolsElectron: initialLocale !== undefined ? Object.freeze({ initialLocale }) : undefined,
      addEventListener() {},
      removeEventListener() {},
      MutationObserver: class { observe() {} disconnect() {} }
    }
    const documentObj = {
      readyState: 'complete',
      documentElement: { lang: docLang ?? '' },
      body: { querySelectorAll: () => [] },
      addEventListener() {},
      removeEventListener() {}
    }
    const context = {
      window: windowObj,
      document: documentObj,
      navigator: { language: navLang ?? '', userAgent: 'test', platform: 'win32' },
      localStorage: { getItem: (k) => (k === 'ztools_locale' ? (storageLocale ?? null) : null) },
      console: { log() {}, warn() {}, error() {} },
      setTimeout,
      clearTimeout
    }
    context.globalThis = context
    if (globalLocale !== undefined) context.__ztoolsLocale = globalLocale
    vm.runInNewContext(ZTOOLS_API_SOURCE, context)
    return context.__ztoolsResolveSdkText('中文文案', 'English text')
  }

  // 空值、英文、日文、法文均严格遵循 DEFAULT_LOCALE = 'en-US'
  assert.equal(runApiResolver({}), 'English text')
  assert.equal(runApiResolver({ navLang: 'en-US' }), 'English text')
  assert.equal(runApiResolver({ navLang: 'ja-JP' }), 'English text')
  assert.equal(runApiResolver({ navLang: 'fr-FR' }), 'English text')

  // 中文系变体正确命中中文
  assert.equal(runApiResolver({ navLang: 'zh-CN' }), '中文文案')
  assert.equal(runApiResolver({ navLang: 'zh_TW' }), '中文文案')
  assert.equal(runApiResolver({ initialLocale: 'zh-CN', navLang: 'en-US' }), '中文文案')

  // 运行期 __ztoolsLocale 优先级高于冻结的 initialLocale
  assert.equal(runApiResolver({ globalLocale: 'en-US', initialLocale: 'zh-CN' }), 'English text')
  assert.equal(runApiResolver({ globalLocale: 'zh-CN', initialLocale: 'en-US' }), '中文文案')
})

test('ztools-api.js: unified bilingual SDK_ERROR_MESSAGES dictionary stays aligned and preserves error.code across locales', async () => {
  const createApiContext = ({ globalLocale, initialLocale, navLang, transportOverrides = {} } = {}) => {
    const windowObj = {
      __ztoolsElectron: initialLocale !== undefined ? Object.freeze({ initialLocale, contractVersion: 1 }) : undefined,
      addEventListener() {},
      removeEventListener() {},
      MutationObserver: class { observe() {} disconnect() {} }
    }
    const documentObj = {
      readyState: 'complete',
      documentElement: { lang: '' },
      body: { querySelectorAll: () => [] },
      addEventListener() {},
      removeEventListener() {}
    }
    const context = {
      window: windowObj,
      document: documentObj,
      navigator: { language: navLang ?? '', userAgent: 'test', platform: 'win32' },
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      console: { log() {}, warn() {}, error() {} },
      btoa: (str) => Buffer.from(str, 'binary').toString('base64'),
      unescape,
      encodeURIComponent,
      TextEncoder,
      URL,
      setTimeout,
      clearTimeout,
      ...transportOverrides
    }
    context.globalThis = context
    if (globalLocale !== undefined) context.__ztoolsLocale = globalLocale
    vm.runInNewContext(ZTOOLS_API_SOURCE, context)
    return context
  }

  const ctx = createApiContext()
  const messages = ctx.__ztoolsSdkErrorMessages
  assert.ok(messages && messages['zh-CN'] && messages['en-US'])

  // 1. 中英键集 100% 对齐、无空译文、占位符一致、en-US 无中文字符
  const zhKeys = Object.keys(messages['zh-CN']).sort()
  const enKeys = Object.keys(messages['en-US']).sort()
  assert.ok(zhKeys.length >= 100, `Expected >= 100 unified SDK error keys, got ${zhKeys.length}`)
  assert.deepEqual(zhKeys, enKeys)

  const extractVars = (str) => [...str.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
  for (const key of zhKeys) {
    const zh = messages['zh-CN'][key]
    const en = messages['en-US'][key]
    assert.equal(typeof zh, 'string')
    assert.equal(typeof en, 'string')
    assert.ok(zh.trim().length > 0, `Empty zh-CN message for ${key}`)
    assert.ok(en.trim().length > 0, `Empty en-US message for ${key}`)
    assert.equal(/[\u4e00-\u9fa5]/.test(en), false, `en-US message for ${key} should not contain CJK: ${en}`)
    assert.deepEqual(extractVars(zh), extractVars(en), `Placeholder mismatch for ${key}`)
  }

  // 2. 默认回退 en-US，运行期切换 __ztoolsLocale 即时双语查表 + 插值
  assert.equal(
    ctx.__ztoolsResolveSdkErrorText('invalidCancelCleanupLimit'),
    'Invalid cancellation cleanup timeout'
  )
  assert.equal(
    ctx.__ztoolsResolveSdkErrorText('imageEmptyResult', { operation: 'Image resize' }),
    'Image resize returned an empty result'
  )
  const enErr = ctx.__ztoolsCreateSdkError('NOT_SUPPORTED', 'hostNoAtomicNoOverwriteWrite')
  assert.equal(enErr.code, 'NOT_SUPPORTED')
  assert.equal(enErr.message, 'Current host does not support atomic no-overwrite file writes')

  ctx.__ztoolsLocale = 'zh-CN'
  assert.equal(
    ctx.__ztoolsResolveSdkErrorText('invalidCancelCleanupLimit'),
    '取消等待上限无效'
  )
  assert.equal(
    ctx.__ztoolsResolveSdkErrorText('imageEmptyResult', { operation: '图片缩放' }),
    '图片缩放返回空结果'
  )
  const zhErr = ctx.__ztoolsCreateSdkError('NOT_SUPPORTED', 'hostNoAtomicNoOverwriteWrite')
  assert.equal(zhErr.code, 'NOT_SUPPORTED')
  assert.equal(zhErr.message, '当前宿主不支持原子禁止覆盖写入')

  // 3. 真实 API 调用链验证：.code 100% 不变且消息随运行期语言切换
  const api = ctx.window.ztools
  assert.ok(api, 'window.ztools should be initialized')

  ctx.__ztoolsLocale = 'en-US'
  await assert.rejects(
    () => api.process.runFFmpeg([]),
    (err) => err.code === 'NOT_SUPPORTED' && /FFmpeg task progress/.test(err.message)
  )
  await assert.rejects(
    () => api.image.preview({}, 'resize'),
    (err) => err.code === 'NOT_SUPPORTED' && /reference image preview/.test(err.message)
  )
  await assert.rejects(
    () => api.image.convert('a.png', 'b.jpg', 'jpg', 85, { replace: false }),
    (err) => err.code === 'NOT_SUPPORTED' && /Legacy image processor/.test(err.message)
  )

  ctx.__ztoolsLocale = 'zh-CN'
  await assert.rejects(
    () => api.process.runFFmpeg([]),
    (err) => err.code === 'NOT_SUPPORTED' && /FFmpeg任务的进度、完成与取消能力尚未接入/.test(err.message)
  )
  await assert.rejects(
    () => api.image.preview({}, 'resize'),
    (err) => err.code === 'NOT_SUPPORTED' && /当前宿主尚未开放引用预览/.test(err.message)
  )
  await assert.rejects(
    () => api.image.convert('a.png', 'b.jpg', 'jpg', 85, { replace: false }),
    (err) => err.code === 'NOT_SUPPORTED' && /旧图片处理器不支持请求选项/.test(err.message)
  )
})

test('plugin-sdk.js & ztools-api.js: system/third-party locale fallback continuation and POSIX .UTF-8/@euro stripping', () => {
  // 1. plugin-sdk.js: initialLocale='system' 与第三语种不提前截断，顺延命中 navigator.language 的 zh_CN.UTF-8
  const h1 = createSdkHarness({
    initialLocale: 'system',
    docLang: 'fr-FR',
    navigatorLanguage: 'zh_CN.UTF-8'
  })
  h1.sdk.enableFileDrop()
  assert.equal(
    h1.document.getElementById('ztools-file-drop-overlay').querySelector('.zt-drop-text').textContent,
    '拖放文件到此处'
  )

  // 2. plugin-sdk.js: POSIX @euro 后缀与 system 事件不覆盖现有有效语言
  const h2 = createSdkHarness({
    initialLocale: 'en_US@euro',
    navigatorLanguage: 'zh-CN'
  })
  h2.sdk.enableFileDrop()
  assert.equal(
    h2.document.getElementById('ztools-file-drop-overlay').querySelector('.zt-drop-text').textContent,
    'Drop files here'
  )
  const onLocaleChange = h2.eventHandlers.get('system.LocaleChange')
  onLocaleChange({ payload: { locale: 'zh_TW.UTF-8@traditional' } })
  assert.equal(h2.window.__ztoolsLocale, 'zh-CN')
  assert.equal(
    h2.document.getElementById('ztools-file-drop-overlay').querySelector('.zt-drop-text').textContent,
    '拖放文件到此处'
  )
  // 传入 system 或第三语种不应覆盖当前生效语言
  onLocaleChange({ payload: { locale: 'system' } })
  onLocaleChange({ payload: { locale: 'ja-JP' } })
  assert.equal(h2.window.__ztoolsLocale, 'zh-CN')

  // 3. ztools-api.js: system 不截断候选链、POSIX 剥离及 system.LocaleChange 幂等热更新
  const runApiContext = ({ globalLocale, initialLocale, docLang, storageLocale, navLang } = {}) => {
    const windowObj = {
      __ztoolsElectron: initialLocale !== undefined ? Object.freeze({ initialLocale }) : undefined,
      addEventListener() {},
      removeEventListener() {},
      MutationObserver: class { observe() {} disconnect() {} }
    }
    const documentObj = {
      readyState: 'complete',
      documentElement: { lang: docLang ?? '' },
      body: { querySelectorAll: () => [] },
      addEventListener() {},
      removeEventListener() {}
    }
    const context = {
      window: windowObj,
      document: documentObj,
      navigator: { language: navLang ?? '', userAgent: 'test', platform: 'win32' },
      localStorage: { getItem: (k) => (k === 'ztools_locale' ? (storageLocale ?? null) : null) },
      console: { log() {}, warn() {}, error() {} },
      setTimeout,
      clearTimeout
    }
    context.globalThis = context
    if (globalLocale !== undefined) context.__ztoolsLocale = globalLocale
    vm.runInNewContext(ZTOOLS_API_SOURCE, context)
    return context
  }

  // system 与第三语种均顺延至后续有效 zh_CN.UTF-8
  const ctx1 = runApiContext({
    globalLocale: 'system',
    initialLocale: 'fr-FR',
    docLang: 'ja_JP.UTF-8',
    storageLocale: 'system',
    navLang: 'zh_CN.UTF-8'
  })
  assert.equal(ctx1.__ztoolsResolveSdkLocale(), 'zh-CN')
  assert.equal(ctx1.__ztoolsResolveSdkText('中文', 'English'), '中文')

  // POSIX @euro 剥离与 strict matchSdkLocale
  assert.equal(ctx1.__ztoolsMatchSdkLocale('zh_CN.UTF-8'), 'zh-CN')
  assert.equal(ctx1.__ztoolsMatchSdkLocale('en_US@euro'), 'en-US')
  assert.equal(ctx1.__ztoolsMatchSdkLocale('system'), null)
  assert.equal(ctx1.__ztoolsMatchSdkLocale('ja-JP'), null)

  // ztools-api.js 独立订阅 system.LocaleChange（不依赖 plugin-sdk.js）实现运行时热切换
  const ctx2 = runApiContext({ initialLocale: 'en-US' })
  assert.equal(ctx2.__ztoolsResolveSdkLocale(), 'en-US')
  assert.equal(ctx2.window.__ztools_api_locale_hooked, true)
  const localeHandlersBefore = ctx2.window.ztools._client.events.handlers.get('system.LocaleChange')
  assert.equal(localeHandlersBefore?.size, 1, 'system.LocaleChange 应仅绑定 1 次（幂等）')

  // 派发 system.LocaleChange 切到中文
  ctx2.window.ztools._client.events.dispatchEnvelope({
    type: 'system.LocaleChange',
    payload: { locale: 'zh_CN.UTF-8', setting: 'zh-CN' }
  })
  assert.equal(ctx2.__ztoolsLocale, 'zh-CN')
  assert.equal(ctx2.document.documentElement.lang, 'zh-CN')
  assert.equal(ctx2.__ztoolsResolveSdkText('中文', 'English'), '中文')

  // 派发 system / 非法语种不会破坏当前 locale
  ctx2.window.ztools._client.events.dispatchEnvelope({
    type: 'system.LocaleChange',
    payload: { locale: 'system' }
  })
  assert.equal(ctx2.__ztoolsLocale, 'zh-CN')

  // 再切回英文
  ctx2.window.ztools._client.events.dispatchEnvelope({
    type: 'system.LocaleChange',
    payload: { locale: 'en_GB@euro' }
  })
  assert.equal(ctx2.__ztoolsLocale, 'en-US')
  assert.equal(ctx2.document.documentElement.lang, 'en-US')
  assert.equal(ctx2.__ztoolsResolveSdkText('中文', 'English'), 'English')

  // 重复执行脚本不应重复绑定（幂等保护）
  vm.runInNewContext(ZTOOLS_API_SOURCE, ctx2)
  assert.equal(ctx2.window.ztools._client.events.handlers.get('system.LocaleChange')?.size, 1)
})
