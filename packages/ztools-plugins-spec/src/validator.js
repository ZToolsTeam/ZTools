import fs from 'node:fs'
import path from 'node:path'

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
  'video'
]

export const PERMISSION_SET = new Set(PERMISSIONS)

/**
 * 高危敏感权限集合（需触发人工双人审查 Two-Man Rule）
 */
export const HIGH_RISK_PERMISSIONS = new Set([
  'network',
  'child_process',
  'fs',
  'system',
  'shell'
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

const ID_REGEX = /^[a-z][a-z0-9_-]{1,63}$/
const SEMVER_REGEX = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const SAFE_ENTRY_REGEX = /^(?!\/)(?!\\)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[a-zA-Z0-9_./-]+\.(?:html|js|mjs)$/
const SAFE_ICON_REGEX = /^(?!\/)(?!\\)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[a-zA-Z0-9_./-]+\.(?:png|svg|jpg|jpeg|webp|ico)$/

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

  // 2. id 校验
  if (manifest.id !== undefined) {
    if (typeof manifest.id !== 'string') {
      errors.push('id 字段必须为字符串')
    } else if (!ID_REGEX.test(manifest.id)) {
      errors.push(`id 字段格式不符合规范: "${manifest.id}"（必须以小写字母开头，仅允许小写字母、数字、短横线与下划线，长度 2-64）`)
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
  const VALID_MODES = new Set(['view', 'no-view', 'menu-bar'])
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

  // 12. features 列表校验 (如存在)
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
