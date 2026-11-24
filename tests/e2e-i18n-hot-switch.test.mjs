/**
 * 常驻多语言热切换 E2E 验收套件（3 组永久防回归实测用例）
 *
 * Suite 1：官网真实 Express HTTP 双语与切语保参 E2E（在包含 official-website/ 的仓库中运行）
 * Suite 2：声明式引擎 + 真实内置插件 json-format 热切换零中文残留 E2E
 * Suite 3：Electron CDP 9222 实机热切 E2E（由 ZTOOLS_E2E_CDP_URL 或 --cdp 开关触发）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  getComponentFactory,
  getLocale,
  renderDeclarativeRoot,
  setDeclarativeBridge,
  setRuntimeLocale
} from '../packages/declarative-ui/dist/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.resolve(__dirname, '..')
const WEBSITE_DIR = path.resolve(ROOT_DIR, 'official-website')

const CJK_REGEX = /[\u4e00-\u9fa5]/
const BARE_PLACEHOLDER_REGEX = /\{[a-zA-Z][a-zA-Z0-9_.-]*\}/

const flushTicks = async (count = 3) => {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

/**
 * 递归提取声明式虚拟视图树中的用户可见 UI 文案（跳过用户输入的 JSON 代码块本身，聚焦组件标签/标题/报错/按钮）
 */
function collectVisibleTexts(node, bucket = [], options = {}) {
  if (node == null || typeof node === 'boolean') return bucket
  if (typeof node === 'string' || typeof node === 'number') {
    const str = String(node).trim()
    if (str) bucket.push({ path: 'text', value: str })
    return bucket
  }
  if (Array.isArray(node)) {
    for (const child of node) collectVisibleTexts(child, bucket, options)
    return bucket
  }
  if (typeof node !== 'object') return bucket

  const props = node.props && typeof node.props === 'object' ? node.props : {}
  const skipValueOnIds = options.skipValueOnIds ?? new Set()
  const isUserInputField = typeof props.id === 'string' && skipValueOnIds.has(props.id)

  const VISIBLE_STRING_PROPS = [
    'navigationTitle',
    'searchBarPlaceholder',
    'title',
    'subtitle',
    'placeholder',
    'info',
    'text',
    'label',
    'error',
    'tooltip',
    'description'
  ]
  for (const key of VISIBLE_STRING_PROPS) {
    if (typeof props[key] === 'string' && props[key].trim()) {
      bucket.push({ path: `${node.type || 'Node'}.${key}`, value: props[key] })
    }
  }
  if (!isUserInputField && typeof props.markdown === 'string' && props.markdown.trim()) {
    // 剔除围栏代码块内的示例 JSON / 生成代码内容，仅检查 Markdown 说明标题与段落
    const proseOnly = props.markdown.replace(/```[\s\S]*?```/g, '')
    if (proseOnly.trim()) {
      bucket.push({ path: `${node.type || 'Node'}.markdown`, value: proseOnly })
    }
  }
  if (props.emptyView && typeof props.emptyView === 'object') {
    collectVisibleTexts(props.emptyView, bucket, options)
  }
  if (props.actions) {
    collectVisibleTexts(props.actions, bucket, options)
  }
  if (props.metadata) {
    collectVisibleTexts(props.metadata, bucket, options)
  }
  if (props.detail) {
    collectVisibleTexts(props.detail, bucket, options)
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectVisibleTexts(child, bucket, options)
  }
  return bucket
}

/** 递归查找声明式节点 */
function findNodes(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) findNodes(item, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  const props = node.props && typeof node.props === 'object' ? node.props : {}
  if (props.actions) findNodes(props.actions, predicate, out)
  if (props.metadata) findNodes(props.metadata, predicate, out)
  if (props.detail) findNodes(props.detail, predicate, out)
  if (Array.isArray(node.children)) {
    for (const child of node.children) findNodes(child, predicate, out)
  }
  return out
}

/** 断言英文态渲染树：零 CJK 残留、无裸 {var} 占位符、无幽灵键 */
function assertCleanEnglishTree(tree, ghostKeys, contextLabel) {
  const entries = collectVisibleTexts(tree, [], { skipValueOnIds: new Set(['jsonInput']) })
  assert.ok(entries.length > 0, `${contextLabel}：应提取到非空可见文本`)

  for (const { path: fieldPath, value } of entries) {
    assert.equal(
      CJK_REGEX.test(value),
      false,
      `${contextLabel} [${fieldPath}] 英文态残留中文：${JSON.stringify(value)}`
    )
    assert.equal(
      BARE_PLACEHOLDER_REGEX.test(value),
      false,
      `${contextLabel} [${fieldPath}] 存在未替换的裸占位符：${JSON.stringify(value)}`
    )
    for (const key of ghostKeys) {
      assert.notEqual(
        value.trim(),
        key,
        `${contextLabel} [${fieldPath}] 出现幽灵键未翻译回退：${key}`
      )
    }
  }
}

/** 从环境变量或命令行参数解析 CDP 地址 */
function resolveCdpEndpoint() {
  const fromEnv = typeof process.env.ZTOOLS_E2E_CDP_URL === 'string' ? process.env.ZTOOLS_E2E_CDP_URL.trim() : ''
  if (fromEnv) return fromEnv
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--cdp' && typeof argv[i + 1] === 'string' && argv[i + 1].trim()) {
      return argv[i + 1].trim()
    }
    if (arg.startsWith('--cdp=')) {
      const val = arg.slice('--cdp='.length).trim()
      if (val) return val
    }
  }
  return ''
}

// ============================================================================
// Suite 1：官网真实 Express HTTP 双语与切语保参 E2E
// ============================================================================

test('Suite 1（官网真实 Express HTTP 双语与切语保参 E2E）：/en/plugins.html、?id=42 保参、/EN 301 重定向、英文复数与日期格式', async (t) => {
  const websitePkgPath = path.join(WEBSITE_DIR, 'package.json')
  const localeMiddlewarePath = path.join(WEBSITE_DIR, 'server', 'middleware', 'locale.middleware.js')
  if (!fs.existsSync(websitePkgPath) || !fs.existsSync(localeMiddlewarePath)) {
    t.skip('当前仓库不含 official-website 子模块，跳过官网 HTTP E2E 阶段')
    return
  }

  const websiteRequire = createRequire(websitePkgPath)
  const express = websiteRequire('express')
  const expressLayouts = websiteRequire('express-ejs-layouts')
  const { localeMiddleware } = websiteRequire('./server/middleware/locale.middleware')
  const i18nService = websiteRequire('./server/services/i18n.service')
  const helpers = websiteRequire('./server/utils/helpers')
  const pagesRouter = websiteRequire('./server/routes/pages')
  const icons = websiteRequire('./server/services/icons')
  const { loadAssetUrl, loadReleaseVersion } = websiteRequire('./server/utils/assets')

  const app = express()
  app.use(express.json())
  app.use(localeMiddleware)
  app.set('view engine', 'ejs')
  app.set('views', path.join(WEBSITE_DIR, 'views'))
  app.use(expressLayouts)
  app.set('layout', 'layouts/main')

  const publicPath = path.join(WEBSITE_DIR, 'dist')
  app.locals.pluginIcons = icons
  app.locals.assetUrl = loadAssetUrl(publicPath)
  app.locals.releaseVersion = loadReleaseVersion(publicPath)

  // 挂载轻量 API 探测路由，验证中间件注入的 t() 复数与 helpers 日期格式化
  app.get(['/api/i18n-e2e-probe', '/en/api/i18n-e2e-probe'], (req, res) => {
    const count = Number(req.query.count ?? 1)
    const sampleTs = Date.UTC(2026, 4, 15, 8, 30, 0)
    res.json({
      locale: res.locals.locale,
      htmlLang: res.locals.htmlLang,
      ratingText: res.locals.t('client.ratingCount', { count }),
      repliesText: res.locals.t('client.repliesCount', { count }),
      formattedDate: helpers.formatTimestamp(sampleTs, res.locals.locale)
    })
  })

  for (const localeCfg of i18nService.PREFIXED_LOCALES) {
    app.use(localeCfg.prefix, pagesRouter)
  }
  app.use('/', pagesRouter)

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
    instance.on('error', reject)
  })

  t.after(async () => {
    await new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    })
  })

  const address = server.address()
  assert.ok(address && typeof address === 'object', 'Express 测试服务应成功监听随机端口')
  const baseUrl = `http://127.0.0.1:${address.port}`

  // 1. /en/plugins.html 英文 SSR 页面
  const enPluginsRes = await fetch(`${baseUrl}/en/plugins.html`)
  assert.equal(enPluginsRes.status, 200)
  const enPluginsHtml = await enPluginsRes.text()
  assert.match(enPluginsHtml, /<html[^>]*\blang="en"/, '/en/plugins.html 应渲染 <html lang="en">')
  assert.match(enPluginsHtml, /<link rel="alternate" hreflang="zh-CN" href="https:\/\/www\.ztools\.cn\/plugins\.html"/)
  assert.match(enPluginsHtml, /<link rel="alternate" hreflang="en" href="https:\/\/www\.ztools\.cn\/en\/plugins\.html"/)
  assert.match(enPluginsHtml, /<link rel="alternate" hreflang="x-default" href="https:\/\/www\.ztools\.cn\/plugins\.html"/)
  const titleMatch = enPluginsHtml.match(/<title>([^<]+)<\/title>/i)
  assert.ok(titleMatch && titleMatch[1].trim().length > 0, '/en/plugins.html 应包含非空标题')
  assert.equal(CJK_REGEX.test(titleMatch[1]), false, `/en/plugins.html 标题不应含中文: ${titleMatch[1]}`)

  // 2. /feature-request-detail.html?id=42 切英文保参（及反向切中文保参）
  const zhDetailRes = await fetch(`${baseUrl}/feature-request-detail.html?id=42`)
  assert.equal(zhDetailRes.status, 200)
  const zhDetailHtml = await zhDetailRes.text()
  assert.match(zhDetailHtml, /<html[^>]*\blang="zh-CN"/)
  assert.ok(
    zhDetailHtml.includes('href="/en/feature-request-detail.html?id=42"'),
    '中文反馈详情页切英文链接必须保留 ?id=42 参数'
  )

  const enDetailRes = await fetch(`${baseUrl}/en/feature-request-detail.html?id=42`)
  assert.equal(enDetailRes.status, 200)
  const enDetailHtml = await enDetailRes.text()
  assert.match(enDetailHtml, /<html[^>]*\blang="en"/)
  assert.ok(
    enDetailHtml.includes('href="/feature-request-detail.html?id=42"'),
    '英文反馈详情页切中文链接必须保留 ?id=42 参数'
  )

  // 3. /EN/plugins.html 与 /en 规范化 301 重定向（并保留 query）
  const upperRedirectRes = await fetch(`${baseUrl}/EN/plugins.html?category=developer`, { redirect: 'manual' })
  assert.equal(upperRedirectRes.status, 301, '/EN/plugins.html 应返回 301 永久重定向')
  assert.equal(
    upperRedirectRes.headers.get('location'),
    '/en/plugins.html?category=developer',
    '301 重定向目标应归一化为小写 /en 并保留查询参数'
  )

  const trailingSlashRes = await fetch(`${baseUrl}/en?ref=nav`, { redirect: 'manual' })
  assert.equal(trailingSlashRes.status, 301, '/en 缺少尾斜杠应 301 重定向至 /en/')
  assert.equal(trailingSlashRes.headers.get('location'), '/en/?ref=nav')

  // 4. 英文单复数与日期格式化（经真实 HTTP 路由 + i18n.service + helpers 端到端断言）
  const enSingular = await (await fetch(`${baseUrl}/en/api/i18n-e2e-probe?count=1`)).json()
  const enPlural = await (await fetch(`${baseUrl}/en/api/i18n-e2e-probe?count=5`)).json()
  const enZero = await (await fetch(`${baseUrl}/en/api/i18n-e2e-probe?count=0`)).json()
  const zhProbe = await (await fetch(`${baseUrl}/api/i18n-e2e-probe?count=5`)).json()

  assert.equal(enSingular.locale, 'en')
  assert.equal(enSingular.ratingText, '1 rating')
  assert.equal(enSingular.repliesText, '1 reply')
  assert.equal(enPlural.ratingText, '5 ratings')
  assert.equal(enPlural.repliesText, '5 replies')
  assert.equal(enZero.ratingText, '0 ratings')
  assert.equal(enZero.repliesText, '0 replies')

  // 英文日期使用 en-US（MM/DD/YYYY），中文日期使用 zh-CN（YYYY/MM/DD）
  assert.match(enSingular.formattedDate, /^05\/15\/2026/, `英文日期应为 en-US 格式，实际: ${enSingular.formattedDate}`)
  assert.match(zhProbe.formattedDate, /^2026\/05\/15/, `中文日期应为 zh-CN 格式，实际: ${zhProbe.formattedDate}`)
  assert.notEqual(enSingular.formattedDate, zhProbe.formattedDate, '中英文日期格式应随 locale 动态区分')
  assert.equal(helpers.formatTimestamp('invalid-date', 'en-US'), '')
})

// ============================================================================
// Suite 2：声明式引擎 + 真实内置插件 json-format 热切换零中文残留 E2E
// ============================================================================

test('Suite 2（声明式引擎 + 真实内置插件 json-format 热切换 E2E）：zh-CN → en-US 零 CJK/裸占位符/幽灵键 → zh-CN 恢复', async (t) => {
  const candidateDirs = [
    path.join(ROOT_DIR, 'plugins', 'json-format', 'dist'),
    path.join(ROOT_DIR, 'frontend', 'public', 'bundled-plugins', 'json-format', 'dist')
  ]
  const pluginDistDir = candidateDirs.find((dir) => fs.existsSync(path.join(dir, 'index.js')))
  assert.ok(pluginDistDir, '应能定位到真实内置插件 json-format 的 dist/index.js 构建产物')

  const pluginMod = await import(pathToFileURL(path.join(pluginDistDir, 'index.js')).href)
  const i18nMod = await import(pathToFileURL(path.join(pluginDistDir, 'i18n.js')).href)
  const JsonFormatCommand = pluginMod.default
  assert.equal(typeof JsonFormatCommand, 'function', 'json-format 默认导出应为声明式组件函数')

  // 收集插件词典所有 key 用于幽灵键（未翻译原样回退）防回归断言
  const ghostKeys = new Set()
  if (i18nMod.messages && typeof i18nMod.messages === 'object') {
    for (const dict of Object.values(i18nMod.messages)) {
      if (dict && typeof dict === 'object') {
        for (const key of Object.keys(dict)) ghostKeys.add(key)
      }
    }
  }
  for (const knownKey of ['navTitleMain', 'detailNavTitle', 'metaKeys', 'actionFormat', 'inputTitle']) {
    ghostKeys.add(knownKey)
  }

  const pushedTargets = []
  const storage = new Map()
  const mountedRoots = []

  setDeclarativeBridge({
    showToast: () => ({ id: '1', update() {}, hide() {} }),
    copyToClipboard: async () => {},
    readClipboardText: async () => '',
    readClipboardFiles: async () => [],
    readClipboardImage: async () => null,
    pasteToActive: async () => {},
    storageGetItem: async (k) => (storage.has(k) ? JSON.parse(storage.get(k)) : undefined),
    storageSetItem: async (k, v) => {
      storage.set(k, JSON.stringify(v))
    },
    storageRemoveItem: async (k) => {
      storage.delete(k)
    },
    storageCompareAndSet: async (k, expected, value) => {
      if (storage.get(k) !== JSON.stringify(expected)) return false
      storage.set(k, JSON.stringify(value))
      return true
    },
    confirmAlert: async () => true,
    navigation: {
      push(target) {
        pushedTargets.push(target)
      },
      pop() {
        pushedTargets.pop()
      }
    }
  })

  t.after(() => {
    for (const root of mountedRoots.reverse()) {
      try {
        root.unmount()
      } catch {
        // 清理阶段容错
      }
    }
    setDeclarativeBridge(null)
    setRuntimeLocale('en-US')
  })

  // 1. 以 zh-CN 挂载真实内置插件 json-format
  setRuntimeLocale('zh-CN')
  assert.equal(getLocale(), 'zh-CN')

  const mainRoot = renderDeclarativeRoot(JsonFormatCommand)
  mountedRoots.push(mainRoot)
  await flushTicks()

  const initialZhTree = mainRoot.getLatest()
  assert.equal(initialZhTree?.props?.navigationTitle, 'JSON 格式化与类型转换')
  assert.ok(
    collectVisibleTexts(initialZhTree).some((item) => CJK_REGEX.test(item.value)),
    'zh-CN 初始挂载应包含中文界面文案'
  )

  // 2. 注入非法 JSON 触发校验提示，再热切换至 en-US，验证表单与校验错误均零中文残留
  const getJsonField = () =>
    findNodes(mainRoot.getLatest(), (n) => n.props?.id === 'jsonInput')[0]

  const zhField = getJsonField()
  assert.ok(zhField && typeof zhField.props?.onChange === 'function', '应找到 jsonInput 表单字段')
  zhField.props.onChange('{broken json')
  await flushTicks()
  assert.ok(
    CJK_REGEX.test(String(getJsonField()?.props?.error || '')),
    `zh-CN 非法 JSON 校验报错应为中文，实际: ${getJsonField()?.props?.error}`
  )

  setRuntimeLocale('en-US')
  await flushTicks()
  assert.equal(getLocale(), 'en-US')

  const enFormTree = mainRoot.getLatest()
  assert.equal(enFormTree?.props?.navigationTitle, 'JSON Formatter & Type Generator')
  assertCleanEnglishTree(enFormTree, ghostKeys, 'json-format 表单视图（非法输入态）')
  const enErrorText = String(getJsonField()?.props?.error || '')
  assert.ok(enErrorText.length > 0 && !CJK_REGEX.test(enErrorText), `en-US 错误文案应实时切换英文: ${enErrorText}`)

  // 3. 填入合法 JSON 并执行主提交动作进入二级详情页，挂载并断言详情页零 CJK / 无裸占位符 / 无幽灵键
  getJsonField().props.onChange('{"name":"ztools","count":2,"nested":{"enabled":true}}')
  await flushTicks()

  const submitAction = findNodes(
    mainRoot.getLatest(),
    (n) => typeof n.props?.onSubmit === 'function' || typeof n.props?.onAction === 'function'
  ).find((n) => n.props?.title === 'Format & Inspect Details')
  assert.ok(submitAction, 'en-US 下应存在 "Format & Inspect Details" 提交动作')

  const trigger = submitAction.props.onSubmit || submitAction.props.onAction
  await trigger({ jsonInput: '{"name":"ztools","count":2,"nested":{"enabled":true}}', indent: '2' })
  await flushTicks()

  assert.ok(pushedTargets.length >= 1, '提交合法 JSON 后应通过 navigation.push 推入详情页')
  const pushedTarget = pushedTargets[pushedTargets.length - 1]
  const DetailComponent =
    typeof pushedTarget === 'function'
      ? pushedTarget
      : typeof pushedTarget?.type === 'function'
        ? () => pushedTarget
        : getComponentFactory(pushedTarget)
  assert.equal(typeof DetailComponent, 'function', '详情页推入目标应可被声明式运行时挂载')

  const detailRoot = renderDeclarativeRoot(DetailComponent)
  mountedRoots.push(detailRoot)
  await flushTicks()

  const enDetailTree = detailRoot.getLatest()
  assert.equal(enDetailTree?.props?.navigationTitle, 'JSON Details')
  assertCleanEnglishTree(enDetailTree, ghostKeys, 'json-format 详情视图（en-US）')

  // 4. 热切回 zh-CN，验证表单与详情页同时实时恢复中文
  setRuntimeLocale('zh-CN')
  await flushTicks()
  assert.equal(getLocale(), 'zh-CN')
  assert.equal(mainRoot.getLatest()?.props?.navigationTitle, 'JSON 格式化与类型转换')
  assert.equal(detailRoot.getLatest()?.props?.navigationTitle, 'JSON 格式化详情')
})

// ============================================================================
// Suite 3：Electron CDP 9222 实机热切 E2E（环境开关触发）
// ============================================================================

async function connectElectronCdp(cdpEndpoint, { timeoutMs = 8000 } = {}) {
  let wsUrl = cdpEndpoint
  if (/^https?:\/\//i.test(cdpEndpoint)) {
    const base = cdpEndpoint.replace(/\/+$/, '')
    const listUrl = base.endsWith('/json/list') ? base : `${base}/json/list`
    const res = await fetch(listUrl, { signal: AbortSignal.timeout(timeoutMs) })
    assert.equal(res.ok, true, `拉取 CDP 目标列表失败: HTTP ${res.status}`)
    const targets = await res.json()
    const pages = (Array.isArray(targets) ? targets : []).filter(
      (item) =>
        item?.type === 'page' &&
        /^(ztools:\/\/web\/|https?:\/\/(localhost|127\.0\.0\.1)[:/])/.test(item.url || '') &&
        !/devtools/.test(item.url || '')
    )
    const mainPage = pages.find((item) => /\/index\.html(?:[?#]|$)/.test(item.url || '')) || pages[0]
    assert.ok(mainPage?.webSocketDebuggerUrl, `在 ${listUrl} 中未找到 ZTools 主窗口调试目标`)
    wsUrl = mainPage.webSocketDebuggerUrl
  }

  assert.equal(typeof globalThis.WebSocket, 'function', '需要 Node 22+ 原生 WebSocket 支持')
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    if (!msg.id || !pending.has(msg.id)) return
    const waiter = pending.get(msg.id)
    pending.delete(msg.id)
    clearTimeout(waiter.timer)
    if (msg.error) {
      waiter.reject(new Error(`CDP ${waiter.method} failed: ${msg.error.message}`))
    } else {
      waiter.resolve(msg.result)
    }
  })

  ws.addEventListener('close', () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('CDP WebSocket closed unexpectedly'))
    }
    pending.clear()
  })

  await new Promise((resolve, reject) => {
    const openTimer = setTimeout(() => reject(new Error(`连接 CDP WebSocket 超时 (${timeoutMs}ms)`)), timeoutMs)
    ws.addEventListener('open', () => {
      clearTimeout(openTimer)
      resolve()
    })
    ws.addEventListener('error', () => {
      clearTimeout(openTimer)
      reject(new Error(`无法连接 CDP WebSocket: ${wsUrl}`))
    })
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP ${method} timed out (${timeoutMs}ms)`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, method, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (res?.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown error'
      throw new Error(`CDP evaluate error: ${detail}`)
    }
    return res?.result?.value
  }

  const close = () => {
    try {
      ws.close()
    } catch {
      // ignore close errors
    }
  }

  return { send, evaluate, close }
}

async function waitForDocumentLang(cdp, targetLocale, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  let lastLang = ''
  while (Date.now() < deadline) {
    lastLang = await cdp.evaluate('document.documentElement.lang || ""')
    if (lastLang === targetLocale) return lastLang
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`等待 <html lang> 切换为 ${targetLocale} 超时（当前值: ${JSON.stringify(lastLang)}）`)
}

test('Suite 3（Electron CDP 9222 实机热切 E2E）：zh-CN → en-US → zh-CN 校验 html.lang、窗口标题、多语言截图与零 CJK 标题', async (t) => {
  const cdpUrl = resolveCdpEndpoint()
  if (!cdpUrl) {
    t.skip('未提供 ZTOOLS_E2E_CDP_URL，跳过实机 CDP 阶段')
    return
  }

  const cdp = await connectElectronCdp(cdpUrl)
  let previousLocale = null
  let previousHash = '#/'

  try {
    previousLocale = await cdp.evaluate(`(async () => {
      if (!window.ztools?.config?.get || !window.ztools?.config?.set) {
        throw new Error('Electron 渲染页缺少 window.ztools.config 接口')
      }
      return await window.ztools.config.get('ui.locale', null, 'user_settings.json')
    })()`)
    previousHash = (await cdp.evaluate('window.location.hash || "#/"')) || '#/'

    const switchLocale = async (targetLocale) => {
      const saved = await cdp.evaluate(
        `window.ztools.config.set('ui.locale', ${JSON.stringify(targetLocale)}, true, 'user_settings.json')`
      )
      assert.equal(saved, true, `写入 ui.locale=${targetLocale} 应返回 true`)
      await waitForDocumentLang(cdp, targetLocale)
    }

    // 1. 切到 zh-CN 并断言 <html lang> 与窗口标题
    await switchLocale('zh-CN')
    const zhState = await cdp.evaluate(`(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      runtimeLocale: globalThis.__ztoolsLocale || ''
    }))()`)
    assert.equal(zhState.lang, 'zh-CN')
    assert.equal(zhState.runtimeLocale, 'zh-CN')
    assert.ok(zhState.title && CJK_REGEX.test(zhState.title), `zh-CN 窗口标题应含中文: ${zhState.title}`)

    // 2. 热切到 en-US，断言 <html lang>、窗口标题零 CJK、内置插件多语言截图切换与零 CJK 标题
    await switchLocale('en-US')
    await cdp.evaluate('window.location.hash = "#/declarative/json-format"')
    await new Promise((resolve) => setTimeout(resolve, 600))

    const enState = await cdp.evaluate(`(async () => {
      const lang = document.documentElement.lang
      const title = document.title
      const runtimeLocale = globalThis.__ztoolsLocale || ''
      const navHeading =
        document.querySelector('.declarative-mica-shell [data-nav-title], .declarative-mica-shell h1, .declarative-mica-shell .decl-nav-title')?.textContent?.trim() || ''
      let manifestCheck = null
      try {
        const res = await fetch('/bundled-plugins/json-format/plugin.json')
        if (res.ok) {
          const manifest = await res.json()
          const zhShot = manifest?.screenshots?.[0]?.path || ''
          const enShot = manifest?.i18n?.['en-US']?.screenshots?.[0]?.file || ''
          manifestCheck = { zhShot, enShot, enName: manifest?.i18n?.['en-US']?.name || '' }
        }
      } catch {
        manifestCheck = null
      }
      return { lang, title, runtimeLocale, navHeading, manifestCheck }
    })()`)

    assert.equal(enState.lang, 'en-US')
    assert.equal(enState.runtimeLocale, 'en-US')
    assert.ok(enState.title.trim().length > 0, 'en-US 窗口标题不应为空')
    assert.equal(CJK_REGEX.test(enState.title), false, `en-US 窗口标题不应残留中文: ${enState.title}`)
    if (enState.navHeading) {
      assert.equal(CJK_REGEX.test(enState.navHeading), false, `en-US 内置插件标题不应残留中文: ${enState.navHeading}`)
    }
    if (enState.manifestCheck) {
      assert.ok(
        enState.manifestCheck.enName && !CJK_REGEX.test(enState.manifestCheck.enName),
        `内置插件 en-US 名称不应含中文: ${enState.manifestCheck.enName}`
      )
      if (enState.manifestCheck.enShot) {
        assert.match(enState.manifestCheck.enShot, /screenshots\/en-US\//, 'en-US 截图应切换至 screenshots/en-US/ 目录')
        assert.notEqual(enState.manifestCheck.enShot, enState.manifestCheck.zhShot, '中英文截图路径应区分')
      }
    }

    // 3. 热切回 zh-CN 并验证恢复
    await switchLocale('zh-CN')
    const backZhState = await cdp.evaluate(`(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      runtimeLocale: globalThis.__ztoolsLocale || ''
    }))()`)
    assert.equal(backZhState.lang, 'zh-CN')
    assert.equal(backZhState.runtimeLocale, 'zh-CN')
    assert.ok(CJK_REGEX.test(backZhState.title), `切回 zh-CN 后窗口标题应恢复中文: ${backZhState.title}`)
  } finally {
    try {
      const restoreMode = typeof previousLocale === 'string' && previousLocale.trim() ? previousLocale : 'system'
      await cdp.evaluate(
        `window.ztools?.config?.set?.('ui.locale', ${JSON.stringify(restoreMode)}, true, 'user_settings.json')`
      )
      await cdp.evaluate(`window.location.hash = ${JSON.stringify(previousHash)}`)
    } catch {
      // 恢复环境阶段容错，避免覆盖主断言异常
    }
    cdp.close()
  }
})
