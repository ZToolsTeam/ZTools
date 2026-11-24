import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_VERSION_REGEX } from './host-requirements.js'

/** 客户端内置功能占用的插件 ID（见 ../reserved-ids.json）；社区插件用了会被客户端隐藏 */
export const RESERVED_PLUGIN_IDS = new Set(
  JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'reserved-ids.json'), 'utf8')).ids
)

/** 官方插件名单（见 ../official-ids.json，维护者维护）：只有名单里的插件显示官方标记、可以用官方作者名 */
export const OFFICIAL_PLUGIN_IDS = new Set(
  JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'official-ids.json'), 'utf8')).ids
)

/**
 * 作者名是否冒充官方：ZTools、ZTools Team、ZTools 官方、Official 一类（忽略大小写、空格、- 与 _）。
 * 「ZTools Community」等不含官方字样的名称不算。
 */
export function isOfficialAuthorName(author) {
  const raw = typeof author === 'string' ? author : author?.name
  if (typeof raw !== 'string') return false
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!key) return false
  // i18n-allow: official author name impersonation keywords
  return ['ztools', 'ztoolsteam', 'ztools团队'].includes(key) || key.includes('official') || key.includes('官方')
}

export const PERMISSIONS = [
  'network',
  'clipboard',
  'dialog',
  'notification',
  'shell',
  'fs',
  'child_process',
  'database',
  'sqlite',
  'system',
  'screen',
  'tray',
  'crypto',
  'audio',
  'video',
  // 结束本机任意进程（宿主 process_terminate_pid 按此权限把关）
  'process'
]

export const PERMISSION_SET = new Set(PERMISSIONS)

/**
 * 插件市场 7 大标准分类 slug ↔ 中文映射（客户端与官网统一按此白名单归类）
 */
export const PLUGIN_CATEGORY_ID_MAP = Object.freeze({
  productivity: '办公效率', // i18n-allow: canonical Chinese category label whitelist
  system: '系统工具', // i18n-allow: canonical Chinese category label whitelist
  files: '文件管理', // i18n-allow: canonical Chinese category label whitelist
  media: '图像媒体', // i18n-allow: canonical Chinese category label whitelist
  developer: '开发工具', // i18n-allow: canonical Chinese category label whitelist
  network: '网络工具', // i18n-allow: canonical Chinese category label whitelist
  security: '安全隐私' // i18n-allow: canonical Chinese category label whitelist
})

export const PLUGIN_CATEGORY_IDS = Object.freeze(Object.keys(PLUGIN_CATEGORY_ID_MAP))
const PLUGIN_CATEGORY_ID_SET = new Set(PLUGIN_CATEGORY_IDS)
const PLUGIN_CATEGORY_LABEL_TO_ID = Object.freeze(
  Object.fromEntries(Object.entries(PLUGIN_CATEGORY_ID_MAP).map(([id, label]) => [label, id]))
)

/**
 * 插件市场 7 大标准分类（客户端与官网统一按此白名单归类，禁止填「其他工具」或非标英文别名）
 */
export const PLUGIN_CATEGORIES = Object.freeze(Object.values(PLUGIN_CATEGORY_ID_MAP))

export const PLUGIN_CATEGORY_SET = new Set(PLUGIN_CATEGORIES)

/**
 * 将中文分类名或标准英文 slug 归一化为 7 个标准分类 slug 之一；非法值返回 null。
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeCategoryId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (PLUGIN_CATEGORY_ID_SET.has(lower)) return lower
  return PLUGIN_CATEGORY_LABEL_TO_ID[trimmed] ?? null
}

/**
 * 将标准分类 slug 或中文分类名解析为对应的标准中文分类标签；非法值返回 null。
 * @param {unknown} value
 * @returns {string | null}
 */
export function resolveCategoryLabel(value) {
  const id = normalizeCategoryId(value)
  return id ? PLUGIN_CATEGORY_ID_MAP[id] : null
}

/**
 * 高危敏感权限集合（需官方人工审核）
 */
export const HIGH_RISK_PERMISSIONS = new Set([
  'network',
  'child_process',
  'fs',
  'system',
  'shell',
  'process'
])

/**
 * Node 原生内置模块与对应所需的权限映射
 */
export const PERMISSION_NODE_MODULE_MAP = {
  fs: 'fs',
  'fs/promises': 'fs',
  child_process: 'child_process',
  cluster: 'child_process',
  worker_threads: 'child_process',
  net: 'network',
  http: 'network',
  https: 'network',
  http2: 'network',
  dgram: 'network',
  dns: 'network',
  tls: 'network',
  crypto: 'crypto',
  os: 'system',
  process: 'system',
  v8: 'system',
  vm: 'child_process'
}

/**
 * 声明式插件运行时实际提供的 Node 模块（客户端加载器只给这两个精简实现，见 frontend/src/utils/declarativePluginLoader.js）。
 * 其余 Node 内置模块即使声明了对应权限，运行时也会拒绝加载；读写文件、执行命令请用宿主 API。
 */
export const DECLARATIVE_RUNTIME_NODE_MODULES = new Set(['crypto', 'path'])

export const NODE_BUILTIN_MODULES = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'fs/promises', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'path/posix', 'path/win32', 'perf_hooks',
  'process', 'punycode', 'querystring', 'readline', 'repl', 'stream',
  'stream/promises', 'stream/web', 'string_decoder', 'timers', 'timers/promises',
  'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
  'zlib'
])

/**
 * 插件支持的平台。plugin.json 通过 targets 声明（与客户端主进程安装校验同一套格式）：
 * 跨平台插件同时声明 windows 与 macos 两个目标，单平台插件只声明一个。
 */
export const SUPPORTED_PLATFORMS = Object.freeze(['windows', 'macos'])
export const PLATFORM_LABELS = Object.freeze({ windows: 'Windows', macos: 'macOS' })
const TARGET_KEYS = new Set(['id', 'platform', 'runtime', 'arch', 'abi', 'minSdkContractVersion'])
const TARGET_RUNTIMES = new Set(['electron', 'legacy-delphi'])
const TARGET_ARCHES = new Set(['any', 'ia32', 'x64', 'arm64', 'universal'])
const TARGET_ID_REGEX = /^[a-z][a-z0-9-]*$/

/**
 * 按平台列表生成标准 targets 声明（纯 JS 插件，不绑定原生组件）
 * @param {string[]} platforms - 'windows' / 'macos' 的子集
 */
export function buildPlatformTargets(platforms) {
  const list = [...new Set(Array.isArray(platforms) ? platforms : [])]
  const unknown = list.filter((p) => !SUPPORTED_PLATFORMS.includes(p))
  if (list.length === 0 || unknown.length > 0) {
    throw new Error(`platforms must be a non-empty subset of ${SUPPORTED_PLATFORMS.join(' / ')}, received: ${JSON.stringify(platforms)}`)
  }
  return SUPPORTED_PLATFORMS.filter((p) => list.includes(p))
    .map((platform) => ({ id: `${platform}-electron-any`, platform, runtime: 'electron', arch: 'any' }))
}

/**
 * 从 plugin.json 读出插件可在哪些平台的 ZTools 客户端运行（只看 electron 运行时目标）
 * @returns {string[]} 'windows' / 'macos' 的子集；未声明或格式错误时返回空数组
 */
export function getManifestPlatforms(manifest) {
  const targets = manifest && Array.isArray(manifest.targets) ? manifest.targets : []
  const found = new Set()
  for (const target of targets) {
    if (target && typeof target === 'object' && target.runtime === 'electron' && SUPPORTED_PLATFORMS.includes(target.platform)) {
      found.add(target.platform)
    }
  }
  return SUPPORTED_PLATFORMS.filter((p) => found.has(p))
}

/** 平台说明文字：Cross-platform / Windows only / macOS only */
export function describePlatforms(platforms) {
  const list = SUPPORTED_PLATFORMS.filter((p) => Array.isArray(platforms) && platforms.includes(p))
  if (list.length === SUPPORTED_PLATFORMS.length) return 'Cross-platform'
  if (list.length === 1) return `${PLATFORM_LABELS[list[0]]} only`
  return 'Undeclared platform'
}

function validateTargets(manifest, errors) {
  if (manifest.targets === undefined) {
    errors.push('Missing required field: targets (declare supported platforms: both windows and macos for cross-platform, or a single platform)')
    return
  }
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    errors.push('targets must be a non-empty array')
    return
  }
  const ids = new Set()
  for (const [idx, target] of manifest.targets.entries()) {
    const label = `targets[${idx}]`
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      errors.push(`${label} must be an object, e.g. { "id": "windows-electron-any", "platform": "windows", "runtime": "electron", "arch": "any" }`)
      continue
    }
    const unknownKeys = Object.keys(target).filter((key) => !TARGET_KEYS.has(key))
    if (unknownKeys.length > 0) errors.push(`${label} contains unknown fields: ${unknownKeys.join(', ')}`)
    if (typeof target.id !== 'string' || !TARGET_ID_REGEX.test(target.id)) errors.push(`${label}.id is invalid`)
    else if (ids.has(target.id)) errors.push(`${label}.id is duplicated: ${target.id}`)
    else ids.add(target.id)
    if (!SUPPORTED_PLATFORMS.includes(target.platform)) errors.push(`${label}.platform must be one of ${SUPPORTED_PLATFORMS.join(' / ')}`)
    if (!TARGET_RUNTIMES.has(target.runtime)) errors.push(`${label}.runtime must be one of ${[...TARGET_RUNTIMES].join(' / ')}`)
    if (!TARGET_ARCHES.has(target.arch)) errors.push(`${label}.arch must be one of ${[...TARGET_ARCHES].join(' / ')}`)
    if (target.runtime === 'legacy-delphi' && target.platform !== 'windows') errors.push(`${label} legacy-delphi runtime is only allowed on Windows`)
    if (target.platform === 'macos' && target.arch === 'ia32') errors.push(`${label} macOS does not support ia32 architecture`)
  }
  if (getManifestPlatforms(manifest).length === 0) {
    errors.push('targets must include at least one target with runtime "electron", otherwise no ZTools client can install this plugin')
  }
  if (!Array.isArray(manifest.nativeComponents)) {
    errors.push('nativeComponents must be an array when targets is declared; use [] for pure JS plugins')
  }
}

function validateCategoryIdField(manifest, errors) {
  if (manifest.categoryId === undefined) return
  if (typeof manifest.categoryId === 'string') {
    if (!PLUGIN_CATEGORY_ID_SET.has(manifest.categoryId)) {
      errors.push(`Unknown or non-standard categoryId: "${manifest.categoryId}". Allowed standard category slugs: ${PLUGIN_CATEGORY_IDS.join(' / ')}`)
    }
    return
  }
  if (!Array.isArray(manifest.categoryId) || manifest.categoryId.length === 0 || manifest.categoryId.length > 2) {
    errors.push(`categoryId must be a standard category slug or an array of 1-2 standard category slugs (allowed: ${PLUGIN_CATEGORY_IDS.join(' / ')})`)
    return
  }
  const seen = new Set()
  for (const id of manifest.categoryId) {
    if (typeof id !== 'string' || !PLUGIN_CATEGORY_ID_SET.has(id)) {
      errors.push(`Unknown or non-standard categoryId: "${id}". Allowed standard category slugs: ${PLUGIN_CATEGORY_IDS.join(' / ')}`)
      continue
    }
    if (seen.has(id)) errors.push(`Duplicate category in categoryId: "${id}"`)
    seen.add(id)
  }
}

function validateCategories(manifest, errors) {
  validateCategoryIdField(manifest, errors)
  if (manifest.revoked === true) return
  if (manifest.category === undefined || manifest.category === null || manifest.category === '') {
    errors.push(`Missing required field: category (choose 1-2 standard categories: ${PLUGIN_CATEGORY_IDS.join(' / ')} or ${PLUGIN_CATEGORIES.join(' / ')})`)
    return
  }
  if (!Array.isArray(manifest.category) || manifest.category.length === 0 || manifest.category.length > 2) {
    errors.push(`category must be an array of 1-2 standard categories (allowed: ${PLUGIN_CATEGORY_IDS.join(' / ')} or ${PLUGIN_CATEGORIES.join(' / ')})`)
    return
  }
  const seenIds = new Set()
  for (const cat of manifest.category) {
    if (typeof cat !== 'string' || (!PLUGIN_CATEGORY_SET.has(cat) && !PLUGIN_CATEGORY_ID_SET.has(cat))) {
      errors.push(`Unknown or non-standard category: "${cat}". Allowed standard categories: ${PLUGIN_CATEGORIES.join(' / ')} (or English slugs: ${PLUGIN_CATEGORY_IDS.join(' / ')})`)
      continue
    }
    const normalizedId = normalizeCategoryId(cat)
    if (seenIds.has(normalizedId)) errors.push(`Duplicate category in category: "${cat}"`)
    seenIds.add(normalizedId)
  }
}

const ID_REGEX = /^[a-z][a-z0-9-]{1,63}$/
const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SAFE_ENTRY_REGEX = /^(?!\/)(?!\\)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[a-zA-Z0-9_./-]+\.(?:html|js|mjs)$/
const SAFE_ICON_REGEX = /^(?!\/)(?!\\)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[a-zA-Z0-9_./-]+\.(?:png|svg|jpg|jpeg|webp|ico)$/
function isPathInsideBaseDir(baseDir, targetPath) {
  if (!baseDir || typeof targetPath !== 'string' || targetPath.includes('\0')) return false
  const resolvedBase = path.resolve(baseDir)
  const resolvedTarget = path.resolve(baseDir, targetPath)
  const rel = path.relative(resolvedBase, resolvedTarget)
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 校验插件清单 (plugin.json) 的完整性与规范性
 * @param {object} manifest - 解析后的 plugin.json 对象
 * @param {object} [options] - 附加校验选项
 * @param {string} [options.baseDir] - 插件源码所在根目录（用于校验 entry/icon 文件存在性）
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
export function validatePluginManifest(manifest, options = {}) {
  const errors = []
  const warnings = []

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      valid: false,
      errors: ['plugin.json must be a valid JSON object'],
      warnings: []
    }
  }

  // 1. 必填字段检查
  const requiredFields = [
    'id',
    'name',
    'version',
    'description',
    'author',
    'entry',
    'icon',
    'permissions'
  ]

  for (const field of requiredFields) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
      errors.push(`Missing required field: ${field}`)
    }
  }

  // 最低客户端版本（可选；发布脚本还会按插件用到的宿主接口自动提高）
  if (manifest.minAppVersion !== undefined && (typeof manifest.minAppVersion !== 'string' || !APP_VERSION_REGEX.test(manifest.minAppVersion))) {
    errors.push(`Invalid minAppVersion format: "${manifest.minAppVersion}" (expected client version such as 1.1.8.3)`)
  }

  // 2. id 校验
  if (manifest.id !== undefined) {
    if (typeof manifest.id !== 'string') {
      errors.push('id must be a string')
    } else if (!ID_REGEX.test(manifest.id)) {
      errors.push(`Invalid id format: "${manifest.id}" (must start with a lowercase letter and contain only lowercase letters, digits, and hyphens; length 2-64)`)
    } else if (RESERVED_PLUGIN_IDS.has(manifest.id) && manifest.revoked !== true) {
      // 已下架的历史条目只保留下架记录，不受影响
      errors.push(`id "${manifest.id}" conflicts with a built-in client feature and will be hidden by the client; choose another ID (see reserved-ids.json)`)
    }
  }

  // 3. name 校验
  if (manifest.name !== undefined) {
    if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
      errors.push('name must be a non-empty string')
    } else if (manifest.name.length > 50) {
      errors.push('name must not exceed 50 characters')
    }
  }

  // 4. version 校验
  if (manifest.version !== undefined) {
    if (typeof manifest.version !== 'string') {
      errors.push('version must be a string')
    } else if (!SEMVER_REGEX.test(manifest.version)) {
      errors.push(`version must follow SemVer format, received: "${manifest.version}"`)
    }
  }

  // 5. description 校验
  if (manifest.description !== undefined) {
    if (typeof manifest.description !== 'string' || manifest.description.trim().length === 0) {
      errors.push('description must be a non-empty string')
    }
  }

  // 6. author 校验
  if (manifest.author !== undefined) {
    if (typeof manifest.author === 'string') {
      if (manifest.author.trim().length === 0) {
        errors.push('author string must not be empty')
      }
    } else if (typeof manifest.author === 'object' && !Array.isArray(manifest.author)) {
      if (!manifest.author.name || typeof manifest.author.name !== 'string') {
        errors.push('author object must contain a valid name field')
      }
    } else {
      errors.push('author must be a string or an object')
    }
    // 官方名称只给官方名单里的插件用（已下架的历史条目不受影响），防止社区插件冒充官方
    if (isOfficialAuthorName(manifest.author) && manifest.revoked !== true && !OFFICIAL_PLUGIN_IDS.has(manifest.id)) {
      errors.push(`author cannot use an official name ("${typeof manifest.author === 'string' ? manifest.author : manifest.author?.name}"): reserved for plugins listed in official-ids.json; use your own name or GitHub username`)
    }
  }

  // 7. permissions 校验
  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions)) {
      errors.push('permissions must be an array')
    } else {
      const seen = new Set()
      for (const perm of manifest.permissions) {
        if (typeof perm !== 'string') {
          errors.push(`permissions items must be strings: ${perm}`)
          continue
        }
        if (seen.has(perm)) {
          errors.push(`Duplicate permission in permissions: "${perm}"`)
        }
        seen.add(perm)
        if (!PERMISSION_SET.has(perm)) {
          errors.push(`Unknown permission: "${perm}". Valid permissions: ${PERMISSIONS.join(', ')}`)
        }
      }
    }
  }

  // 8. entry 校验
  if (manifest.entry !== undefined) {
    if (typeof manifest.entry !== 'string') {
      errors.push('entry must be a string')
    } else if (!SAFE_ENTRY_REGEX.test(manifest.entry)) {
      errors.push(`Invalid entry path: "${manifest.entry}" (must be a safe relative path ending in .html, .js, or .mjs; path traversal is disallowed)`)
    } else if (options.baseDir) {
      const resolvedEntry = path.resolve(options.baseDir, manifest.entry)
      if (!fs.existsSync(resolvedEntry)) {
        errors.push(`entry file does not exist: ${manifest.entry}`)
      }
    }
  }

  // 9. icon 校验
  if (manifest.icon !== undefined) {
    if (typeof manifest.icon !== 'string') {
      errors.push('icon must be a string')
    } else if (!SAFE_ICON_REGEX.test(manifest.icon)) {
      errors.push(`Invalid icon path: "${manifest.icon}" (must be a relative path ending in .png, .svg, .jpg, .jpeg, .webp, or .ico)`)
    } else if (options.baseDir) {
      const resolvedIcon = path.resolve(options.baseDir, manifest.icon)
      if (!fs.existsSync(resolvedIcon)) {
        errors.push(`icon file does not exist: ${manifest.icon}`)
      }
    }
  }

  // 10. window 校验 (如存在)
  for (const optionalPathField of ['main', 'preload', 'logo']) {
    const val = manifest[optionalPathField]
    if (val !== undefined) {
      if (typeof val !== 'string' || val.includes('\0') || /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(val) || path.isAbsolute(val)) {
        errors.push(`Invalid ${optionalPathField} path: "${val}" (absolute paths and path traversal are disallowed)`)
      } else if (options.baseDir && !isPathInsideBaseDir(options.baseDir, val)) {
        errors.push(`${optionalPathField} path escapes plugin root: "${val}"`)
      }
    }
  }
  if (manifest.window !== undefined) {
    if (typeof manifest.window !== 'object' || Array.isArray(manifest.window)) {
      errors.push('window must be an object')
    } else {
      if (manifest.window.width !== undefined && (!Number.isInteger(manifest.window.width) || manifest.window.width <= 0)) {
        errors.push('window.width must be a positive integer')
      }
      if (manifest.window.height !== undefined && (!Number.isInteger(manifest.window.height) || manifest.window.height <= 0)) {
        errors.push('window.height must be a positive integer')
      }
    }
  }

  // 11. mode、alias 与 shortcut 校验 (如存在)
  // 客户端只实现了 view 与 no-view 两种模式
  const VALID_MODES = new Set(['view', 'no-view'])
  if (manifest.mode !== undefined) {
    if (typeof manifest.mode !== 'string' || !VALID_MODES.has(manifest.mode)) {
      errors.push(`mode must be one of: ${[...VALID_MODES].join(', ')}`)
    }
  }
  if (manifest.alias !== undefined) {
    if (typeof manifest.alias !== 'string' || manifest.alias.length > 32) {
      errors.push('alias must be a string of at most 32 characters')
    }
  }
  if (manifest.shortcut !== undefined) {
    if (typeof manifest.shortcut !== 'string' || !manifest.shortcut.trim()) {
      errors.push('shortcut must be a non-empty string')
    }
  }

  // 12. 平台声明（targets）与市场标准分类（category）
  validateTargets(manifest, errors)
  validateCategories(manifest, errors)

  // 13. 发布状态：草稿（功能未完成，不发布）与下架（已发布后撤下）
  for (const [flag, reasonKey] of [['draft', 'draftReason'], ['revoked', 'revokedReason']]) {
    if (manifest[flag] !== undefined && typeof manifest[flag] !== 'boolean') {
      errors.push(`${flag} must be a boolean`)
    }
    if (manifest[flag] === true && (typeof manifest[reasonKey] !== 'string' || !manifest[reasonKey].trim())) {
      errors.push(`${reasonKey} is required when ${flag} is true`)
    }
    if (manifest[reasonKey] !== undefined && typeof manifest[reasonKey] !== 'string') {
      errors.push(`${reasonKey} must be a string`)
    }
  }

  // 13. features 列表校验 (如存在)
  if (manifest.features !== undefined) {
    if (!Array.isArray(manifest.features)) {
      errors.push('features must be an array')
    } else {
      for (const [idx, feat] of manifest.features.entries()) {
        if (!feat || typeof feat !== 'object' || Array.isArray(feat)) {
          errors.push(`features[${idx}] must be an object`)
          continue
        }
        if (!feat.code || typeof feat.code !== 'string') {
          errors.push(`features[${idx}] is missing a valid code field`)
        }
        if (!feat.explain || typeof feat.explain !== 'string') {
          errors.push(`features[${idx}] is missing a valid explain field`)
        }
        if (feat.mode !== undefined && (!VALID_MODES.has(feat.mode) || typeof feat.mode !== 'string')) {
          errors.push(`features[${idx}].mode must be one of: ${[...VALID_MODES].join(', ')}`)
        }
        if (feat.alias !== undefined && (typeof feat.alias !== 'string' || feat.alias.length > 32)) {
          errors.push(`features[${idx}].alias must be a string of at most 32 characters`)
        }
        if (feat.shortcut !== undefined && (typeof feat.shortcut !== 'string' || !feat.shortcut.trim())) {
          errors.push(`features[${idx}].shortcut must be a non-empty string`)
        }
      }
    }
  }

  // 14. 截图（可选）
  validateManifestScreenshots(manifest, options, errors)

  // 15. 多语言元数据（defaultLocale / i18n，可选）
  validateManifestI18n(manifest, options, errors)

  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

export const LOCALE_TAG_REGEX = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/
const I18N_ENTRY_KEYS = new Set(['name', 'description', 'keywords', 'revokedReason', 'features', 'screenshots'])
const I18N_FEATURE_KEYS = new Set(['explain', 'cmds'])
const I18N_SCREENSHOT_KEYS = new Set(['file', 'title'])

function validateI18nFeatures(features, label, errors, topFeatureCodes = null) {
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    errors.push(`${label}.features must be an object keyed by feature code`)
    return
  }
  if (topFeatureCodes !== null && topFeatureCodes.size === 0) {
    errors.push(`${label}.features is declared, but top-level features is not defined`)
  }
  for (const [code, feat] of Object.entries(features)) {
    const featLabel = `${label}.features["${code}"]`
    if (!code.trim()) {
      errors.push(`${label}.features contains an empty feature code`)
      continue
    }
    if (topFeatureCodes !== null && topFeatureCodes.size > 0 && !topFeatureCodes.has(code)) {
      errors.push(`${featLabel} references unknown feature code "${code}" not present in top-level manifest.features`)
    }
    if (!feat || typeof feat !== 'object' || Array.isArray(feat)) {
      errors.push(`${featLabel} must be an object`)
      continue
    }
    const unknownFeatKeys = Object.keys(feat).filter((k) => !I18N_FEATURE_KEYS.has(k))
    if (unknownFeatKeys.length > 0) {
      errors.push(`${featLabel} contains unknown fields: ${unknownFeatKeys.join(', ')}`)
    }
    if (feat.explain !== undefined) {
      if (typeof feat.explain !== 'string' || feat.explain.trim().length === 0) {
        errors.push(`${featLabel}.explain must be a non-empty string`)
      }
    }
    if (feat.cmds !== undefined) {
      if (!Array.isArray(feat.cmds)) {
        errors.push(`${featLabel}.cmds must be an array`)
      } else {
        for (const [idx, cmd] of feat.cmds.entries()) {
          const validString = typeof cmd === 'string' && cmd.trim().length > 0
          const validObject = Boolean(cmd) && typeof cmd === 'object' && !Array.isArray(cmd)
          if (!validString && !validObject) {
            errors.push(`${featLabel}.cmds[${idx}] must be a non-empty string or an object`)
          }
        }
      }
    }
  }
}

function validateI18nScreenshots(list, label, options, errors) {
  if (!Array.isArray(list)) {
    errors.push(`${label}.screenshots must be an array, e.g. [{ "file": "screenshots/en-US/01.png", "title": "Main" }]`)
    return
  }
  if (list.length > SCREENSHOT_LIMITS.maxCount) {
    errors.push(`${label}.screenshots allows at most ${SCREENSHOT_LIMITS.maxCount} items, received ${list.length}`)
  }
  const seen = new Set()
  for (const [idx, shot] of list.entries()) {
    const shotLabel = `${label}.screenshots[${idx}]`
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
      errors.push(`${shotLabel} must be an object, e.g. { "file": "screenshots/en-US/01.png", "title": "Main" }`)
      continue
    }
    const unknownKeys = Object.keys(shot).filter((k) => !I18N_SCREENSHOT_KEYS.has(k))
    if (unknownKeys.length > 0) {
      errors.push(`${shotLabel} contains unknown fields: ${unknownKeys.join(', ')}`)
    }
    if (shot.title !== undefined && (typeof shot.title !== 'string' || shot.title.trim().length === 0 || shot.title.length > SCREENSHOT_LIMITS.maxTitleLength)) {
      errors.push(`${shotLabel}.title must be a non-empty string of 1-${SCREENSHOT_LIMITS.maxTitleLength} characters`)
    }
    if (typeof shot.file !== 'string' || !SCREENSHOT_PATH_REGEX.test(shot.file)) {
      errors.push(`${shotLabel}.file is invalid: "${shot.file}" (must be a relative .png path under screenshots/; absolute paths and .. are disallowed)`)
      continue
    }
    if (seen.has(shot.file)) {
      errors.push(`${shotLabel}.file is duplicated: ${shot.file}`)
      continue
    }
    seen.add(shot.file)
    if (options.baseDir) {
      const result = inspectScreenshotFile(options.baseDir, shot.file)
      if (!result.ok) errors.push(`${shotLabel}: ${result.error}`)
    }
  }
}

function validateI18nEntryFields(entry, label, errors, { topFeatureCodes = null, screenshotValidator = null } = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`${label} must be an object`)
    return
  }
  const unknownKeys = Object.keys(entry).filter((k) => !I18N_ENTRY_KEYS.has(k))
  if (unknownKeys.length > 0) {
    errors.push(`${label} contains unknown fields: ${unknownKeys.join(', ')}`)
  }
  if (entry.name !== undefined) {
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) {
      errors.push(`${label}.name must be a non-empty string`)
    } else if (entry.name.length > 50) {
      errors.push(`${label}.name must not exceed 50 characters`)
    }
  }
  if (entry.description !== undefined) {
    if (typeof entry.description !== 'string' || entry.description.trim().length === 0) {
      errors.push(`${label}.description must be a non-empty string`)
    } else if (entry.description.length > 500) {
      errors.push(`${label}.description must not exceed 500 characters`)
    }
  }
  if (entry.revokedReason !== undefined) {
    if (typeof entry.revokedReason !== 'string' || entry.revokedReason.trim().length === 0) {
      errors.push(`${label}.revokedReason must be a non-empty string`)
    }
  }
  if (entry.keywords !== undefined) {
    if (!Array.isArray(entry.keywords)) {
      errors.push(`${label}.keywords must be an array`)
    } else {
      for (const [idx, kw] of entry.keywords.entries()) {
        if (typeof kw !== 'string' || kw.trim().length === 0) {
          errors.push(`${label}.keywords[${idx}] must be a non-empty string`)
        } else if (kw.length > 30) {
          errors.push(`${label}.keywords[${idx}] must not exceed 30 characters`)
        }
      }
    }
  }
  if (entry.features !== undefined) {
    validateI18nFeatures(entry.features, label, errors, topFeatureCodes)
  }
  if (entry.screenshots !== undefined && screenshotValidator) {
    screenshotValidator(entry.screenshots, label)
  }
}

function validateDefaultLocaleField(target, errors) {
  if (target.defaultLocale !== undefined) {
    if (typeof target.defaultLocale !== 'string' || !LOCALE_TAG_REGEX.test(target.defaultLocale)) {
      errors.push(`Invalid defaultLocale format: "${target.defaultLocale}" (expected a BCP-47 locale tag such as zh-CN or en-US)`)
    }
  }
}

function validateManifestI18n(manifest, options, errors) {
  validateDefaultLocaleField(manifest, errors)

  if (manifest.i18n === undefined) return
  if (!manifest.i18n || typeof manifest.i18n !== 'object' || Array.isArray(manifest.i18n)) {
    errors.push('i18n must be an object keyed by BCP-47 locale tags')
    return
  }

  const topFeatureCodes = new Set(
    Array.isArray(manifest.features)
      ? manifest.features
          .filter((f) => f && typeof f === 'object' && typeof f.code === 'string' && f.code.trim())
          .map((f) => f.code)
      : []
  )

  for (const [locale, entry] of Object.entries(manifest.i18n)) {
    if (!LOCALE_TAG_REGEX.test(locale)) {
      errors.push(`Invalid i18n locale tag: "${locale}" (expected a BCP-47 locale tag such as en-US, zh-CN, or ja)`)
    }
    const label = `i18n["${locale}"]`
    validateI18nEntryFields(entry, label, errors, {
      topFeatureCodes,
      screenshotValidator: (list, entryLabel) => validateI18nScreenshots(list, entryLabel, options, errors)
    })
  }
}

/**
 * 插件截图规则：只在插件详情页展示（客户端与官网），发布时随版本上传 CDN，不进安装包。
 * 只接受 screenshots/ 目录下的 PNG：安装包与公开仓库导出都按这个目录处理截图，放在别处会被打进安装包或被导出拒绝。
 */
export const SCREENSHOT_LIMITS = Object.freeze({
  maxCount: 5,
  maxBytes: 1024 * 1024,
  minWidth: 640,
  maxWidth: 2560,
  minHeight: 400,
  maxHeight: 1600,
  maxTitleLength: 60
})
/** screenshots/ 下的相对路径：每段只用字母、数字、_ - 与段内的点，扩展名必须是小写 .png；不能有 ..、绝对路径、反斜杠 */
export const SCREENSHOT_PATH_REGEX = /^screenshots\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.png$/
const SCREENSHOT_KEYS = new Set(['path', 'title'])
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 读取 PNG 文件头（签名 + IHDR）里的宽高；不是 PNG（只改了扩展名、内容被截断）时返回 null
 * @param {Buffer} buf - 文件开头至少 24 字节
 * @returns {{ width: number, height: number } | null}
 */
export function readPngSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  // 第一个数据块必须是 IHDR（长度 13）
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * 检查插件目录里的一张截图文件：在插件目录内（不经软链接跳出）、是普通文件、不超过 1 MB、确实是 PNG、尺寸在范围内。
 * @param {string} baseDir - 插件目录
 * @param {string} relPath - 清单里的 path（调用前已通过 SCREENSHOT_PATH_REGEX）
 * @returns {{ ok: true, width: number, height: number, bytes: number } | { ok: false, error: string }}
 */
export function inspectScreenshotFile(baseDir, relPath) {
  const fail = (error) => ({ ok: false, error })
  const abs = path.resolve(baseDir, relPath)
  if (!isPathInsideBaseDir(baseDir, relPath)) return fail(`Screenshot path escapes plugin root: "${relPath}"`)
  const stat = fs.lstatSync(abs, { throwIfNoEntry: false })
  if (!stat) return fail(`Screenshot file does not exist: ${relPath}`)
  if (stat.isSymbolicLink()) return fail(`Screenshot must not be a symbolic link: ${relPath}`)
  if (!stat.isFile()) return fail(`Screenshot must be a regular file: ${relPath}`)
  // 上级目录是软链接时 realpath 会跳出插件目录
  let realBase
  let realFile
  try {
    realBase = fs.realpathSync(baseDir)
    realFile = fs.realpathSync(abs)
  } catch (err) {
    return fail(`Failed to read screenshot ${relPath}: ${err.message}`)
  }
  const rel = path.relative(realBase, realFile)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return fail(`Screenshot path escapes plugin root: "${relPath}"`)
  if (stat.size > SCREENSHOT_LIMITS.maxBytes) {
    return fail(`Screenshot ${relPath} is ${(stat.size / 1024).toFixed(0)} KB, exceeding the ${SCREENSHOT_LIMITS.maxBytes / 1024} KB limit; compress before submitting`)
  }
  const head = Buffer.alloc(24)
  const fd = fs.openSync(abs, 'r')
  let read
  try {
    read = fs.readSync(fd, head, 0, head.length, 0)
  } finally {
    fs.closeSync(fd)
  }
  const size = readPngSize(head.subarray(0, read))
  if (!size) return fail(`Screenshot ${relPath} is not a valid PNG file (invalid PNG header)`)
  const { minWidth, maxWidth, minHeight, maxHeight } = SCREENSHOT_LIMITS
  if (size.width < minWidth || size.width > maxWidth || size.height < minHeight || size.height > maxHeight) {
    return fail(`Screenshot ${relPath} dimensions are ${size.width}x${size.height}; expected width ${minWidth}-${maxWidth} and height ${minHeight}-${maxHeight} pixels`)
  }
  return { ok: true, width: size.width, height: size.height, bytes: stat.size }
}

function validateManifestScreenshots(manifest, options, errors) {
  const list = manifest.screenshots
  if (list === undefined) return
  if (!Array.isArray(list)) {
    errors.push('screenshots must be an array, e.g. [{ "path": "screenshots/01.png", "title": "Main View" }]')
    return
  }
  if (list.length > SCREENSHOT_LIMITS.maxCount) {
    errors.push(`screenshots allows at most ${SCREENSHOT_LIMITS.maxCount} items, received ${list.length}`)
  }
  const seen = new Set()
  for (const [idx, shot] of list.entries()) {
    const label = `screenshots[${idx}]`
    if (!shot || typeof shot !== 'object' || Array.isArray(shot)) {
      errors.push(`${label} must be an object, e.g. { "path": "screenshots/01.png", "title": "Main View" }`)
      continue
    }
    const unknownKeys = Object.keys(shot).filter((key) => !SCREENSHOT_KEYS.has(key))
    if (unknownKeys.length > 0) errors.push(`${label} contains unknown fields: ${unknownKeys.join(', ')}`)
    if (shot.title !== undefined && (typeof shot.title !== 'string' || shot.title.trim().length === 0 || shot.title.length > SCREENSHOT_LIMITS.maxTitleLength)) {
      errors.push(`${label}.title must be a non-empty string of 1-${SCREENSHOT_LIMITS.maxTitleLength} characters`)
    }
    if (typeof shot.path !== 'string' || !SCREENSHOT_PATH_REGEX.test(shot.path)) {
      errors.push(`${label}.path is invalid: "${shot.path}" (must be a relative .png path under screenshots/, e.g. screenshots/01.png; absolute paths and .. are disallowed)`)
      continue
    }
    if (seen.has(shot.path)) {
      errors.push(`${label}.path is duplicated: ${shot.path}`)
      continue
    }
    seen.add(shot.path)
    if (options.baseDir) {
      const result = inspectScreenshotFile(options.baseDir, shot.path)
      if (!result.ok) errors.push(`${label}: ${result.error}`)
    }
  }
}

const SHA256_REGEX = /^[a-fA-F0-9]{64}$/
const URL_REGEX = /^https?:\/\/.+/

function validateCatalogScreenshots(list, label, errors) {
  if (!Array.isArray(list) || list.length > SCREENSHOT_LIMITS.maxCount) {
    errors.push(`${label} must be an array of at most ${SCREENSHOT_LIMITS.maxCount} items`)
    return
  }
  for (const [idx, shot] of list.entries()) {
    const ok = shot && typeof shot === 'object' &&
      typeof shot.url === 'string' && /^https:\/\/[^\s"'<>]+$/.test(shot.url) &&
      (shot.title === undefined || typeof shot.title === 'string') &&
      Number.isSafeInteger(shot.width) && shot.width > 0 &&
      Number.isSafeInteger(shot.height) && shot.height > 0
    if (!ok) errors.push(`${label}[${idx}] must be { url (https URL), title, width, height }`)
  }
}

function validateCatalogI18n(item, errors) {
  validateDefaultLocaleField(item, errors)
  validateCategoryIdField(item, errors)

  if (item.i18n === undefined) return
  if (!item.i18n || typeof item.i18n !== 'object' || Array.isArray(item.i18n)) {
    errors.push('i18n must be an object keyed by BCP-47 locale tags')
    return
  }

  // 目录条目若同时携带顶层 features 数组，则同步做功能 code 交叉校验；否则仅校验结构
  const topFeatureCodes = Array.isArray(item.features)
    ? new Set(
        item.features
          .filter((f) => f && typeof f === 'object' && typeof f.code === 'string' && f.code.trim())
          .map((f) => f.code)
      )
    : null

  for (const [locale, entry] of Object.entries(item.i18n)) {
    if (!LOCALE_TAG_REGEX.test(locale)) {
      errors.push(`Invalid i18n locale tag: "${locale}" (expected a BCP-47 locale tag such as en-US, zh-CN, or ja)`)
    }
    const label = `i18n["${locale}"]`
    validateI18nEntryFields(entry, label, errors, {
      topFeatureCodes,
      screenshotValidator: (list, entryLabel) => validateCatalogScreenshots(list, `${entryLabel}.screenshots`, errors)
    })
  }
}

/**
 * 校验商店目录插件条目 (Catalog Plugin Item)
 * @param {object} item - 插件条目
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCatalogPluginItem(item) {
  const errors = []
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { valid: false, errors: ['Plugin catalog item must be a non-null object'] }
  }

  if (!item.id || typeof item.id !== 'string' || !ID_REGEX.test(item.id)) {
    errors.push(`Invalid plugin id: "${item.id}"`)
  }
  if (!item.name || typeof item.name !== 'string') {
    errors.push('Plugin name is required and must be a string')
  }
  if (!item.version || typeof item.version !== 'string' || !SEMVER_REGEX.test(item.version)) {
    errors.push(`Plugin version does not follow SemVer format: "${item.version}"`)
  }
  if (item.downloadUrl !== undefined) {
    if (typeof item.downloadUrl !== 'string' || !URL_REGEX.test(item.downloadUrl)) {
      errors.push(`downloadUrl must be a valid http/https URL: "${item.downloadUrl}"`)
    }
  }
  if (item.sha256 !== undefined) {
    if (typeof item.sha256 !== 'string' || !SHA256_REGEX.test(item.sha256)) {
      errors.push(`sha256 must be a 64-character hexadecimal hash: "${item.sha256}"`)
    }
  }
  if (item.size !== undefined) {
    if (typeof item.size !== 'number' || item.size <= 0 || !Number.isSafeInteger(item.size)) {
      errors.push(`size must be a positive integer byte count: "${item.size}"`)
    }
  }
  if (item.minAppVersion !== undefined && (typeof item.minAppVersion !== 'string' || !APP_VERSION_REGEX.test(item.minAppVersion))) {
    errors.push(`Invalid minAppVersion format: "${item.minAppVersion}"`)
  }
  if (item.revoked !== undefined && typeof item.revoked !== 'boolean') {
    errors.push('revoked must be a boolean')
  }
  if (item.screenshots !== undefined) {
    validateCatalogScreenshots(item.screenshots, 'screenshots', errors)
  }
  validateCatalogI18n(item, errors)

  return {
    valid: errors.length === 0,
    errors
  }
}

/**
 * 校验全量商店目录清单 (Store Catalog Index, 即 plugins.json)
 * @param {object} catalog - 目录对象
 * @returns {{ valid: boolean, errors: string[], totalValid: number, revokedCount: number }}
 */
export function validateStoreCatalog(catalog) {
  const errors = []
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    return { valid: false, errors: ['Catalog must be a non-null object'], totalValid: 0, revokedCount: 0 }
  }

  if (!Array.isArray(catalog.plugins)) {
    errors.push('catalog.plugins must be an array')
    return { valid: false, errors, totalValid: 0, revokedCount: 0 }
  }

  let totalValid = 0
  let revokedCount = 0
  const seenIds = new Set()

  for (const [idx, item] of catalog.plugins.entries()) {
    const itemValidation = validateCatalogPluginItem(item)
    if (!itemValidation.valid) {
      errors.push(`plugins[${idx}] validation failed: ${itemValidation.errors.join('; ')}`)
    } else {
      totalValid++
      if (item.revoked) {
        revokedCount++
      }
      if (seenIds.has(item.id)) {
        errors.push(`plugins[${idx}] has a duplicate plugin ID: "${item.id}"`)
      }
      seenIds.add(item.id)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    totalValid,
    revokedCount
  }
}
