/**
 * 随客户端内置的官方插件（plugins/ 仓库构建产物，见 public/bundled-plugins/）
 *
 * - 官方插件只展示这里列出的（规则见 pluginVisibility.js）；
 * - 内置插件从 ztools://web/bundled-plugins/<id>/ 读取代码，不依赖插件市场与 CDN；
 * - 与旧的内置声明式实现（officialPlugins.js）同 ID 时，以这里的原版为准。
 */
// 清单在构建时打包进代码，读取插件列表不依赖网络请求，不会因为读取失败导致主页或插件市场为空
import bundledConfig from '../config/bundledPlugins.generated.js'

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

export function isBundledPlugin(value) {
  return BUNDLED_ID_SET.has(normalizeId(value))
}

/**
 * 读取内置插件的文件，供 loadInstalledDeclarativePlugin 的 options.readFile 使用
 */
export async function readBundledPluginFile(pluginId, relPath) {
  const id = normalizeId(pluginId)
  if (!BUNDLED_ID_SET.has(id)) {
    const err = new Error(`不是内置插件: ${pluginId}`)
    err.code = 'PLUGIN_RESOURCE_NOT_FOUND'
    throw err
  }
  const raw = String(relPath || '')
  // 只接受插件目录内的相对路径：拒绝绝对路径、反斜杠、盘符/协议、空段与 ..
  const clean = raw
  if (!clean || /^[\/\\]/.test(clean) || /[\\:]/.test(clean) || clean.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    const err = new Error(`非法的插件资源路径: ${relPath}`)
    err.code = 'PATH_TRAVERSAL_BLOCKED'
    throw err
  }
  const url = `${baseUrl()}${encodeURIComponent(id)}/${clean.split('/').map(encodeURIComponent).join('/')}`
  const response = await fetch(url)
  if (!response.ok) {
    const err = new Error(`无法加载内置插件资源 [${id}/${clean}]: HTTP ${response.status}`)
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

function toEntry(p) {
  const icon = getBundledPluginIconUrl(p.id, p.icon || 'icon.svg')
  return {
    id: p.id,
    pluginId: p.id,
    name: p.name || p.id,
    title: p.name || p.id,
    description: p.description || '',
    version: p.version || '1.0.0',
    author: p.author || 'ZTools Team',
    // 页面按字符串展示分类
    category: Array.isArray(p.category) ? p.category.join(' / ') : String(p.category || ''),
    keywords: Array.isArray(p.keywords) ? p.keywords : [],
    icon,
    logo: icon,
    entry: 'dist/index.js',
    mode: 'view',
    isDeclarative: true,
    isInstalledDeclarative: true,
    bundled: true,
    builtin: true,
    enabled: true,
    is_official: true,
    isOfficial: true,
    official_badge: '官方',
    officialBadge: '官方'
  }
}

/**
 * 内置插件条目（每次返回新数组，调用方可以随意修改）
 */
export function getBundledPluginEntries() {
  const list = Array.isArray(bundledConfig.plugins) ? bundledConfig.plugins : []
  return list.filter((p) => p && BUNDLED_ID_SET.has(normalizeId(p.id))).map(toEntry)
}
