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
    throw new Error(`平台必须是 ${SUPPORTED_PLATFORMS.join(' / ')} 的非空组合，收到: ${JSON.stringify(platforms)}`)
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

/** 平台说明文字：跨平台 / 仅 Windows / 仅 macOS */
export function describePlatforms(platforms) {
  const list = SUPPORTED_PLATFORMS.filter((p) => Array.isArray(platforms) && platforms.includes(p))
  if (list.length === SUPPORTED_PLATFORMS.length) return '跨平台'
  if (list.length === 1) return `仅 ${PLATFORM_LABELS[list[0]]}`
  return '未声明平台'
}

function validateTargets(manifest, errors) {
  if (manifest.targets === undefined) {
    errors.push('缺少必填字段: targets（声明插件支持的平台：跨平台写 windows 与 macos 两个目标，单平台只写一个）')
    return
  }
  if (!Array.isArray(manifest.targets) || manifest.targets.length === 0) {
    errors.push('targets 必须为非空数组')
    return
  }
  const ids = new Set()
  for (const [idx, target] of manifest.targets.entries()) {
    const label = `targets[${idx}]`
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      errors.push(`${label} 必须为对象，例如 { "id": "windows-electron-any", "platform": "windows", "runtime": "electron", "arch": "any" }`)
      continue
    }
    const unknownKeys = Object.keys(target).filter((key) => !TARGET_KEYS.has(key))
    if (unknownKeys.length > 0) errors.push(`${label} 包含未知字段: ${unknownKeys.join(', ')}`)
    if (typeof target.id !== 'string' || !TARGET_ID_REGEX.test(target.id)) errors.push(`${label}.id 无效`)
    else if (ids.has(target.id)) errors.push(`${label}.id 重复: ${target.id}`)
    else ids.add(target.id)
    if (!SUPPORTED_PLATFORMS.includes(target.platform)) errors.push(`${label}.platform 必须为 ${SUPPORTED_PLATFORMS.join(' / ')}`)
    if (!TARGET_RUNTIMES.has(target.runtime)) errors.push(`${label}.runtime 必须为 ${[...TARGET_RUNTIMES].join(' / ')}`)
    if (!TARGET_ARCHES.has(target.arch)) errors.push(`${label}.arch 必须为 ${[...TARGET_ARCHES].join(' / ')}`)
    if (target.runtime === 'legacy-delphi' && target.platform !== 'windows') errors.push(`${label} 的 legacy-delphi 运行时只允许 Windows`)
    if (target.platform === 'macos' && target.arch === 'ia32') errors.push(`${label} macOS 不支持 ia32 架构`)
  }
  if (getManifestPlatforms(manifest).length === 0) {
    errors.push('targets 中至少要有一个 runtime 为 electron 的目标，否则任何 ZTools 客户端都无法安装')
  }
  if (!Array.isArray(manifest.nativeComponents)) {
    errors.push('声明 targets 时 nativeComponents 必须为数组；纯 JS 插件写 []')
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
      errors: ['plugin.json 内容必须为有效的 JSON 对象'],
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
      errors.push(`缺少必填字段: ${field}`)
    }
  }

  // 最低客户端版本（可选；发布脚本还会按插件用到的宿主接口自动提高）
  if (manifest.minAppVersion !== undefined && (typeof manifest.minAppVersion !== 'string' || !APP_VERSION_REGEX.test(manifest.minAppVersion))) {
    errors.push(`minAppVersion 格式无效: "${manifest.minAppVersion}"（应为 1.1.8.3 这样的客户端版本号）`)
  }

  // 2. id 校验
  if (manifest.id !== undefined) {
    if (typeof manifest.id !== 'string') {
      errors.push('id 字段必须为字符串')
    } else if (!ID_REGEX.test(manifest.id)) {
      errors.push(`id 字段格式不符合规范: "${manifest.id}"（必须以小写字母开头，仅允许小写字母、数字与短横线，长度 2-64）`)
    } else if (RESERVED_PLUGIN_IDS.has(manifest.id) && manifest.revoked !== true) {
      // 已下架的历史条目只保留下架记录，不受影响
      errors.push(`id "${manifest.id}" 与客户端内置功能重名，客户端会隐藏这个插件，请换一个 ID（完整名单见 reserved-ids.json）`)
    }
  }

  // 3. name 校验
  if (manifest.name !== undefined) {
    if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
      errors.push('name 字段必须为非空字符串')
    } else if (manifest.name.length > 50) {
      errors.push('name 字段长度不能超过 50 个字符')
    }
  }

  // 4. version 校验
  if (manifest.version !== undefined) {
    if (typeof manifest.version !== 'string') {
      errors.push('version 字段必须为字符串')
    } else if (!SEMVER_REGEX.test(manifest.version)) {
      errors.push(`version 字段必须遵循语义化版本号格式 (SemVer)，当前为: "${manifest.version}"`)
    }
  }

  // 5. description 校验
  if (manifest.description !== undefined) {
    if (typeof manifest.description !== 'string' || manifest.description.trim().length === 0) {
      errors.push('description 字段必须为非空字符串')
    }
  }

  // 6. author 校验
  if (manifest.author !== undefined) {
    if (typeof manifest.author === 'string') {
      if (manifest.author.trim().length === 0) {
        errors.push('author 字符串不能为空')
      }
    } else if (typeof manifest.author === 'object' && !Array.isArray(manifest.author)) {
      if (!manifest.author.name || typeof manifest.author.name !== 'string') {
        errors.push('author 对象必须包含有效的 name 字段')
      }
    } else {
      errors.push('author 字段类型必须为字符串或对象')
    }
    // 官方名称只给官方名单里的插件用（已下架的历史条目不受影响），防止社区插件冒充官方
    if (isOfficialAuthorName(manifest.author) && manifest.revoked !== true && !OFFICIAL_PLUGIN_IDS.has(manifest.id)) {
      errors.push(`author 不能使用官方名称（"${typeof manifest.author === 'string' ? manifest.author : manifest.author?.name}"）：只有官方名单 official-ids.json 里的插件可以使用，请写你自己的名字或 GitHub 用户名`)
    }
  }

  // 7. permissions 校验
  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions)) {
      errors.push('permissions 字段必须为数组')
    } else {
      const seen = new Set()
      for (const perm of manifest.permissions) {
        if (typeof perm !== 'string') {
          errors.push(`permissions 数组项必须为字符串: ${perm}`)
          continue
        }
        if (seen.has(perm)) {
          errors.push(`permissions 中存在重复声明的权限: "${perm}"`)
        }
        seen.add(perm)
        if (!PERMISSION_SET.has(perm)) {
          errors.push(`未知的权限声明: "${perm}"。有效权限项为: ${PERMISSIONS.join(', ')}`)
        }
      }
    }
  }

  // 8. entry 校验
  if (manifest.entry !== undefined) {
    if (typeof manifest.entry !== 'string') {
      errors.push('entry 字段必须为字符串')
    } else if (!SAFE_ENTRY_REGEX.test(manifest.entry)) {
      errors.push(`entry 路径不合法: "${manifest.entry}"（仅支持安全相对路径，扩展名需为 .html、.js 或 .mjs，禁止路径穿越）`)
    } else if (options.baseDir) {
      const resolvedEntry = path.resolve(options.baseDir, manifest.entry)
      if (!fs.existsSync(resolvedEntry)) {
        errors.push(`entry 指定的文件不存在: ${manifest.entry}`)
      }
    }
  }

  // 9. icon 校验
  if (manifest.icon !== undefined) {
    if (typeof manifest.icon !== 'string') {
      errors.push('icon 字段必须为字符串')
    } else if (!SAFE_ICON_REGEX.test(manifest.icon)) {
      errors.push(`icon 路径不合法: "${manifest.icon}"（仅支持相对路径，扩展名需为 .png、.svg、.jpg、.jpeg、.webp 或 .ico）`)
    } else if (options.baseDir) {
      const resolvedIcon = path.resolve(options.baseDir, manifest.icon)
      if (!fs.existsSync(resolvedIcon)) {
        errors.push(`icon 指定的文件不存在: ${manifest.icon}`)
      }
    }
  }

  // 10. window 校验 (如存在)
  for (const optionalPathField of ['main', 'preload', 'logo']) {
    const val = manifest[optionalPathField]
    if (val !== undefined) {
      if (typeof val !== 'string' || val.includes('\0') || /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(val) || path.isAbsolute(val)) {
        errors.push(`${optionalPathField} 路径不合法: "${val}"（禁止绝对路径或路径穿越）`)
      } else if (options.baseDir && !isPathInsideBaseDir(options.baseDir, val)) {
        errors.push(`${optionalPathField} 路径越界: "${val}" 不允许脱离插件根目录`)
      }
    }
  }
  if (manifest.window !== undefined) {
    if (typeof manifest.window !== 'object' || Array.isArray(manifest.window)) {
      errors.push('window 必须为对象')
    } else {
      if (manifest.window.width !== undefined && (!Number.isInteger(manifest.window.width) || manifest.window.width <= 0)) {
        errors.push('window.width 必须为正整数')
      }
      if (manifest.window.height !== undefined && (!Number.isInteger(manifest.window.height) || manifest.window.height <= 0)) {
        errors.push('window.height 必须为正整数')
      }
    }
  }

  // 11. mode 与 alias 校验 (如存在)
  // 客户端只实现了 view 与 no-view 两种模式
  const VALID_MODES = new Set(['view', 'no-view'])
  if (manifest.mode !== undefined) {
    if (typeof manifest.mode !== 'string' || !VALID_MODES.has(manifest.mode)) {
      errors.push(`mode 必须为以下取值之一: ${[...VALID_MODES].join(', ')}`)
    }
  }
  if (manifest.alias !== undefined) {
    if (typeof manifest.alias !== 'string' || manifest.alias.length > 32) {
      errors.push('alias 必须为不超过 32 个字符的字符串')
    }
  }

  // 12. 平台声明（targets）
  validateTargets(manifest, errors)

  // 13. 发布状态：草稿（功能未完成，不发布）与下架（已发布后撤下）
  for (const [flag, reasonKey] of [['draft', 'draftReason'], ['revoked', 'revokedReason']]) {
    if (manifest[flag] !== undefined && typeof manifest[flag] !== 'boolean') {
      errors.push(`${flag} 字段必须为布尔值`)
    }
    if (manifest[flag] === true && (typeof manifest[reasonKey] !== 'string' || !manifest[reasonKey].trim())) {
      errors.push(`${flag} 为 true 时必须用 ${reasonKey} 写明原因，方便审核与后续跟进`)
    }
    if (manifest[reasonKey] !== undefined && typeof manifest[reasonKey] !== 'string') {
      errors.push(`${reasonKey} 字段必须为字符串`)
    }
  }

  // 13. features 列表校验 (如存在)
  if (manifest.features !== undefined) {
    if (!Array.isArray(manifest.features)) {
      errors.push('features 字段必须为数组')
    } else {
      for (const [idx, feat] of manifest.features.entries()) {
        if (!feat || typeof feat !== 'object' || Array.isArray(feat)) {
          errors.push(`features[${idx}] 必须为对象`)
          continue
        }
        if (!feat.code || typeof feat.code !== 'string') {
          errors.push(`features[${idx}] 缺少有效的 code 字段`)
        }
        if (!feat.explain || typeof feat.explain !== 'string') {
          errors.push(`features[${idx}] 缺少有效的 explain 字段`)
        }
        if (feat.mode !== undefined && (!VALID_MODES.has(feat.mode) || typeof feat.mode !== 'string')) {
          errors.push(`features[${idx}].mode 必须为以下取值之一: ${[...VALID_MODES].join(', ')}`)
        }
        if (feat.alias !== undefined && (typeof feat.alias !== 'string' || feat.alias.length > 32)) {
          errors.push(`features[${idx}].alias 必须为不超过 32 个字符的字符串`)
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

const SHA256_REGEX = /^[a-fA-F0-9]{64}$/
const URL_REGEX = /^https?:\/\/.+/

/**
 * 校验商店目录插件条目 (Catalog Plugin Item)
 * @param {object} item - 插件条目
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateCatalogPluginItem(item) {
  const errors = []
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { valid: false, errors: ['插件条目必须为非空对象'] }
  }

  if (!item.id || typeof item.id !== 'string' || !ID_REGEX.test(item.id)) {
    errors.push(`插件 id 无效: "${item.id}"`)
  }
  if (!item.name || typeof item.name !== 'string') {
    errors.push('插件 name 必填且必须为字符串')
  }
  if (!item.version || typeof item.version !== 'string' || !SEMVER_REGEX.test(item.version)) {
    errors.push(`插件 version 不符合 semver 格式: "${item.version}"`)
  }
  if (item.downloadUrl !== undefined) {
    if (typeof item.downloadUrl !== 'string' || !URL_REGEX.test(item.downloadUrl)) {
      errors.push(`downloadUrl 必须为合法的 http/https URL: "${item.downloadUrl}"`)
    }
  }
  if (item.sha256 !== undefined) {
    if (typeof item.sha256 !== 'string' || !SHA256_REGEX.test(item.sha256)) {
      errors.push(`sha256 必须为 64 位十六进制哈希: "${item.sha256}"`)
    }
  }
  if (item.size !== undefined) {
    if (typeof item.size !== 'number' || item.size <= 0 || !Number.isSafeInteger(item.size)) {
      errors.push(`size 必须为正整数字节大小: "${item.size}"`)
    }
  }
  if (item.minAppVersion !== undefined && (typeof item.minAppVersion !== 'string' || !APP_VERSION_REGEX.test(item.minAppVersion))) {
    errors.push(`minAppVersion 格式无效: "${item.minAppVersion}"`)
  }
  if (item.revoked !== undefined && typeof item.revoked !== 'boolean') {
    errors.push('revoked 字段必须为布尔值')
  }

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
    return { valid: false, errors: ['Catalog 必须为非空对象'], totalValid: 0, revokedCount: 0 }
  }

  if (!Array.isArray(catalog.plugins)) {
    errors.push('catalog.plugins 必须为数组')
    return { valid: false, errors, totalValid: 0, revokedCount: 0 }
  }

  let totalValid = 0
  let revokedCount = 0
  const seenIds = new Set()

  for (const [idx, item] of catalog.plugins.entries()) {
    const itemValidation = validateCatalogPluginItem(item)
    if (!itemValidation.valid) {
      errors.push(`plugins[${idx}] 校验失败: ${itemValidation.errors.join('; ')}`)
    } else {
      totalValid++
      if (item.revoked) {
        revokedCount++
      }
      if (seenIds.has(item.id)) {
        errors.push(`plugins[${idx}] 存在重复的插件 ID: "${item.id}"`)
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
