/**
 * 随客户端内置的官方插件（plugins/ 仓库构建产物，见 public/bundled-plugins/）
 *
 * - 官方插件只展示这里列出的（规则见 pluginVisibility.js）；
 * - 内置插件从 ztools://web/bundled-plugins/<id>/ 读取代码，不依赖插件市场与 CDN；
 * - 与旧的内置声明式实现（officialPlugins.js）同 ID 时，以这里的原版为准。
 */
// 清单在构建时打包进代码，读取插件列表不依赖网络请求，不会因为读取失败导致主页或插件市场为空
import bundledConfig from '../config/bundledPlugins.generated.js'
import { DEFAULT_CATEGORY_ID, getPluginCategoryIds, normalizeCategoryNames } from './pluginCategories'
import { stripI18nScreenshots } from './pluginScreenshots'

/** 官方插件徽章语义标识（UI 展示统一经 i18n 渲染，避免硬编码中文「官方」） */
export const OFFICIAL_BADGE_CODE = 'official'

export const BUNDLED_PLUGIN_IDS = Object.freeze([...bundledConfig.ids])
const BUNDLED_ID_SET = new Set(BUNDLED_PLUGIN_IDS)

function baseUrl() {
  // 页面位于 ztools://web/index.html（或开发服务器根路径），相对路径解析到同级的 bundled-plugins/
  return typeof document !== 'undefined' && document.baseURI
    ? new URL('bundled-plugins/', document.baseURI).href
    : '/bundled-plugins/'
}

function normalizeId(value) {
  if (!value) return ''
  if (typeof value === 'object') return String(value.pluginId || value.id || '').trim().toLowerCase()
  return String(value).trim().toLowerCase()
}

/**
 * 功能已合并的旧插件 → 保留的插件（可能内置，也可能需要从市场安装）。
 * 旧快捷方式、历史记录、搜索结果打开旧插件时直接打开保留的那个，不再提示「暂未开放」。
 * （同 id 的重复插件，如 json-format、calculator，本来就只保留内置版本，不需要在这里登记）
 */
export const BUNDLED_PLUGIN_REPLACEMENTS = Object.freeze({
  notes: 'memo',
  'google-translate': 'translator',
  dictionary: 'translator',
  'batch-text-convert': 'crypto-tool',
  'currency-exchange': 'calculator',
  'unit-converter': 'calculator',
  'chinese-number-converter': 'calculator',
  'uuid-generator': 'crypto-tool',
  'world-clock': 'timestamp'
})

/**
 * 旧插件重定向到保留插件时的默认子功能 featureCode（用户未显式传入 featureCode 时自动补齐）
 */
export const BUNDLED_REPLACEMENT_FEATURES = Object.freeze({
  dictionary: 'translate-dict',
  'batch-text-convert': 'codec-base64',
  'currency-exchange': 'calc-currency',
  'unit-converter': 'calc-unit',
  'chinese-number-converter': 'calc-rmb',
  'uuid-generator': 'gen-uuid',
  'world-clock': 'tz-world'
})

/** 旧插件 id 解析到保留的插件 id；不在映射里时原样返回 */
export function resolveBundledReplacement(pluginId) {
  const raw = typeof pluginId === 'string' ? pluginId.trim() : ''
  const id = raw.toLowerCase()
  return Object.hasOwn(BUNDLED_PLUGIN_REPLACEMENTS, id) ? BUNDLED_PLUGIN_REPLACEMENTS[id] : raw
}

/** 解析旧插件对应的默认子命令 featureCode（若调用方已传入显式 featureCode 则优先使用显式值） */
export function resolveBundledReplacementFeature(pluginId, explicitFeatureCode = '') {
  const explicit = typeof explicitFeatureCode === 'string' ? explicitFeatureCode.trim() : ''
  if (explicit) return explicit
  const id = typeof pluginId === 'string' ? pluginId.trim().toLowerCase() : ''
  return Object.hasOwn(BUNDLED_REPLACEMENT_FEATURES, id) ? BUNDLED_REPLACEMENT_FEATURES[id] : ''
}

export function isBundledPlugin(value) {
  return BUNDLED_ID_SET.has(normalizeId(value))
}

/** 通过插件市场分发的官方插件（plugins 仓库里非草稿、不随客户端内置的那批），安装后从安装目录加载 */
const STORE_OFFICIAL_ID_SET = new Set((bundledConfig.storeOfficialIds || []).map((id) => String(id).toLowerCase()))

export function isStoreOfficialPlugin(value) {
  return STORE_OFFICIAL_ID_SET.has(normalizeId(value))
}

/** 展示层保留可读字符串；市场筛选用 normalizeCategoryNames 拆分，不能把整串作为分类名。 */
export function normalizePluginCategory(rawCategory, fallback = '') {
  const names = normalizeCategoryNames(rawCategory)
  return (names.length ? names : normalizeCategoryNames(fallback)).join(' / ')
}

const STORE_OFFICIAL_META_MAP = new Map(
  (Array.isArray(bundledConfig.storePlugins) ? bundledConfig.storePlugins : [])
    .filter((p) => p && p.id)
    .map((p) => {
      const id = normalizeId(p.id)
      return [
        id,
        Object.freeze({
          id: p.id,
          pluginId: p.id,
          name: p.name || p.id,
          title: p.name || p.id,
          description: p.description || '',
          category: normalizePluginCategory(p.category),
          ...(p.categoryId ? { categoryId: p.categoryId } : {}),
          ...(p.defaultLocale ? { defaultLocale: p.defaultLocale } : {}),
          ...(p.i18n && typeof p.i18n === 'object' ? (() => {
            const sanitized = stripI18nScreenshots(p.i18n)
            return sanitized ? { i18n: sanitized } : {}
          })() : {})
        })
      ]
    })
)

/**
 * 获取通过插件市场分发的官方插件最新展示元数据（来自 plugins 仓库 plugin.json），
 * 确保在 CDN 静态目录尚未重新发布或本地存在旧快照缓存时，插件市场与已装列表仍展示精简短名称与标准分类。
 * @param {string|object} value
 * @returns {{ id: string, pluginId: string, name: string, title: string, description: string, category: string } | null}
 */
export function getStoreOfficialPluginMeta(value) {
  const id = normalizeId(value)
  if (!id || !STORE_OFFICIAL_META_MAP.has(id)) return null
  return { ...STORE_OFFICIAL_META_MAP.get(id) }
}

/**
 * 兼容纯 Node ESM 环境（无 Vite 别名与 vue-i18n）的内置插件报错翻译器：
 * 在前端渲染进程与 Vitest 环境中优先走公开 locales 词典，无宿主翻译器时回退英文模板（DEFAULT_LOCALE = 'en-US'）。
 */
function translateBundledError(key, params, fallbackEn) {
  if (typeof globalThis !== 'undefined' && typeof globalThis.__ztoolsTranslate === 'function') {
    const resolved = globalThis.__ztoolsTranslate(key, params)
    if (typeof resolved === 'string' && resolved && resolved !== key) {
      return resolved
    }
  }
  return fallbackEn.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => String(params?.[k] ?? ''))
}

/**
 * 读取内置插件的文件，供 loadInstalledDeclarativePlugin 的 options.readFile 使用
 */
export async function readBundledPluginFile(pluginId, relPath) {
  const id = normalizeId(pluginId)
  if (!BUNDLED_ID_SET.has(id)) {
    const safePluginId = String(pluginId ?? '')
    const err = new Error(
      translateBundledError(
        'bundledPlugins.errors.notBundled',
        { pluginId: safePluginId },
        'Not a bundled plugin: {pluginId}'
      )
    )
    err.code = 'PLUGIN_RESOURCE_NOT_FOUND'
    throw err
  }
  const raw = String(relPath || '')
  // 只接受插件目录内的相对路径：拒绝绝对路径、反斜杠、盘符/协议、空段与 ..
  const clean = raw
  if (!clean || /^[\/\\]/.test(clean) || /[\\:]/.test(clean) || clean.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    const safePath = String(relPath ?? '')
    const err = new Error(
      translateBundledError(
        'bundledPlugins.errors.invalidResourcePath',
        { path: safePath },
        'Invalid plugin resource path: {path}'
      )
    )
    err.code = 'PATH_TRAVERSAL_BLOCKED'
    throw err
  }
  const url = `${baseUrl()}${encodeURIComponent(id)}/${clean.split('/').map(encodeURIComponent).join('/')}`
  const response = await fetch(url)
  if (!response.ok) {
    const err = new Error(
      translateBundledError(
        'bundledPlugins.errors.loadResourceFailed',
        { pluginId: id, path: clean, status: response.status },
        'Failed to load bundled plugin resource [{pluginId}/{path}]: HTTP {status}'
      )
    )
    err.status = response.status
    err.code = 'PLUGIN_RESOURCE_NOT_FOUND'
    throw err
  }
  return await response.text()
}

export function getBundledPluginIconUrl(pluginId, iconRel = 'icon.svg') {
  const id = normalizeId(pluginId)
  return `${baseUrl()}${encodeURIComponent(id)}/${String(iconRel).replace(/^\/+/, '')}`
}

/** 内置插件截图：同步脚本只复制 plugin.json 声明过的 screenshots/ 下的 PNG，这里再按同一格式过滤一次 */
const BUNDLED_SCREENSHOT_PATH = /^screenshots\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.png$/
const FORBIDDEN_I18N_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function normalizeBundledScreenshotList(pluginId, rawList, pathField) {
  const list = Array.isArray(rawList) ? rawList : []
  return list
    .filter((shot) => shot && typeof shot === 'object' && typeof shot[pathField] === 'string' && BUNDLED_SCREENSHOT_PATH.test(shot[pathField]))
    .slice(0, 5)
    .map((shot) => ({
      url: getBundledPluginIconUrl(pluginId, shot[pathField]),
      title: typeof shot.title === 'string' ? shot.title : '',
      width: Number.isSafeInteger(shot.width) && shot.width > 0 ? shot.width : undefined,
      height: Number.isSafeInteger(shot.height) && shot.height > 0 ? shot.height : undefined
    }))
}

/**
 * 内置插件截图地址（指向随客户端分发的本地副本 bundled-plugins/<id>/screenshots/…）；没有截图时为空数组，不回退到网络
 * @returns {Array<{ url: string, title: string, width?: number, height?: number }>}
 */
export function getBundledPluginScreenshots(p) {
  return normalizeBundledScreenshotList(p?.id, p?.screenshots, 'path')
}

/**
 * 归一化内置插件的 i18n 元数据：将各语种的 `screenshots[].file` 转为与顶层 screenshots 同规范的本地静态资源 URL，
 * 过滤非法路径与空项，防止未解析相对路径泄漏至渲染层。
 * @param {object} p
 * @returns {object | undefined}
 */
export function normalizeBundledPluginI18n(p) {
  if (!p?.i18n || typeof p.i18n !== 'object' || Array.isArray(p.i18n)) return undefined
  const out = {}
  let hasAny = false
  for (const [loc, entry] of Object.entries(p.i18n)) {
    if (FORBIDDEN_I18N_KEYS.has(loc) || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    hasAny = true
    const nextEntry = { ...entry }
    if (Object.hasOwn(entry, 'screenshots')) {
      const normalizedShots = normalizeBundledScreenshotList(p.id, entry.screenshots, 'file')
      if (normalizedShots.length > 0) {
        nextEntry.screenshots = normalizedShots
      } else {
        delete nextEntry.screenshots
      }
    }
    out[loc] = nextEntry
  }
  return hasAny ? out : undefined
}

function toEntry(p) {
  const icon = getBundledPluginIconUrl(p.id, p.icon || 'icon.svg')
  const normalizedI18n = normalizeBundledPluginI18n(p)
  return {
    id: p.id,
    pluginId: p.id,
    name: p.name || p.id,
    title: p.name || p.id,
    description: p.description || '',
    version: p.version || '1.0.0',
    author: p.author || 'ZTools Team',
    // 页面按单一标准分类字符串展示，避免多分类用斜杠拼接成超长分类名
    category: normalizePluginCategory(p.category, DEFAULT_CATEGORY_ID),
    categoryId: p.categoryId || getPluginCategoryIds(p.category),
    ...(p.defaultLocale ? { defaultLocale: p.defaultLocale } : {}),
    ...(normalizedI18n ? { i18n: normalizedI18n } : {}),
    keywords: Array.isArray(p.keywords) ? p.keywords : [],
    alias: typeof p.alias === 'string' ? p.alias : '',
    features: Array.isArray(p.features) ? p.features : [],
    // 平台声明（plugin.json 的 targets），用于展示「跨平台 / 仅 Windows / 仅 macOS」并过滤当前系统不支持的插件
    targets: Array.isArray(p.targets) ? p.targets : [],
    // 字节数，由同步脚本按随客户端分发的文件统计
    size: Number(p.size) || 0,
    icon,
    logo: icon,
    screenshots: getBundledPluginScreenshots(p),
    entry: 'dist/index.js',
    mode: 'view',
    isDeclarative: true,
    isInstalledDeclarative: true,
    bundled: true,
    builtin: true,
    enabled: true,
    is_official: true,
    isOfficial: true,
    official_badge: OFFICIAL_BADGE_CODE,
    officialBadge: OFFICIAL_BADGE_CODE
  }
}

/**
 * 按插件 ID 同步获取单个内置插件条目（不存在时返回 null）
 */
export function getBundledPluginEntry(value) {
  const id = normalizeId(value)
  if (!BUNDLED_ID_SET.has(id)) return null
  const list = Array.isArray(bundledConfig.plugins) ? bundledConfig.plugins : []
  const found = list.find((p) => p && normalizeId(p.id) === id)
  return found ? toEntry(found) : null
}

/**
 * 内置插件条目（每次返回新数组，调用方可以随意修改）
 */
export function getBundledPluginEntries() {
  const list = Array.isArray(bundledConfig.plugins) ? bundledConfig.plugins : []
  return list.filter((p) => p && BUNDLED_ID_SET.has(normalizeId(p.id))).map(toEntry)
}

