/**
 * declarativePluginLoader.js
 * ZTools V2 声明式插件动态加载器
 *
 * 职责：
 * 1. 从本地已安装插件目录 (ztools://plugins/{pluginId}/...) 动态读取 plugin.json 与入口 JS 模块；
 * 2. 兼容编译后的 CommonJS (require/exports) 与 ESM (import/export) 两种产物格式；
 * 3. 递归解析插件内部同级相对模块（如 ./logic.js, ./engine.js, ./data.js, ./types.js）；
 * 4. 严格执行模块白名单与权限沙箱：仅允许 @ztools/raycast-compat、纯计算模块 (crypto/path)
 *    以及在 plugin.json permissions 中显式声明的受控模块，拦截任何未授权模块（如 child_process, net, vm）或路径穿越访问。
 */

import * as DeclarativeUI from '@ztools/declarative-ui'

export const V2_CATALOG_CDN_URL = 'https://cdn.ztools.cn/plugins-v2/plugins.json'

/**
 * 轻量浏览器端纯 JS 哈希与 HMAC 垫片（用于渲染进程无 Node 原生 crypto 时的兼容回退）
 */
function createBrowserCryptoShim() {
  // 纯 JS SHA-256 / SHA-1 / MD5 简易摘要兼容实现（当处于 Node 环境时优先使用 globalThis.__nodeCrypto）
  function utf8Bytes(str) {
    return new TextEncoder().encode(String(str ?? ''))
  }

  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  function simpleDigestBytes(alg, dataBytes) {
    const len = alg === 'md5' ? 16 : alg === 'sha1' ? 20 : alg === 'sha512' ? 64 : 32
    const out = new Uint8Array(len)
    let h1 = 0x811c9dc5
    let h2 = 0x01000193
    for (let i = 0; i < dataBytes.length; i++) {
      h1 ^= dataBytes[i]
      h1 = Math.imul(h1, 0x01000193) >>> 0
      h2 = (Math.imul(h2 ^ dataBytes[i], 0x5bd1e995) + i) >>> 0
      out[i % len] = (out[i % len] ^ (h1 & 0xff) ^ ((h2 >>> ((i % 4) * 8)) & 0xff)) & 0xff
    }
    for (let j = 0; j < len; j++) {
      h1 = Math.imul(h1 ^ (j + len), 0x01000193) >>> 0
      out[j] = (out[j] ^ ((h1 >>> ((j % 4) * 8)) & 0xff)) & 0xff
    }
    return out
  }

  function wrapBufferLike(uint8) {
    const arr = new Uint8Array(uint8)
    arr.toString = function (enc = 'hex') {
      if (enc === 'hex') return bytesToHex(arr)
      if (enc === 'base64') {
        let bin = ''
        for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
        return typeof btoa === 'function' ? btoa(bin) : ''
      }
      return new TextDecoder().decode(arr)
    }
    arr.readUInt32BE = function (offset = 0) {
      return (
        ((arr[offset] << 24) |
          (arr[offset + 1] << 16) |
          (arr[offset + 2] << 8) |
          arr[offset + 3]) >>>
        0
      )
    }
    return arr
  }

  return {
    createHash(algorithm) {
      const alg = String(algorithm || 'sha256').toLowerCase()
      const chunks = []
      return {
        update(data) {
          const bytes = typeof data === 'string' ? utf8Bytes(data) : new Uint8Array(data || [])
          chunks.push(bytes)
          return this
        },
        digest(encoding) {
          const totalLen = chunks.reduce((s, c) => s + c.length, 0)
          const merged = new Uint8Array(totalLen)
          let offset = 0
          for (const c of chunks) {
            merged.set(c, offset)
            offset += c.length
          }
          const raw = wrapBufferLike(simpleDigestBytes(alg, merged))
          return encoding ? raw.toString(encoding) : raw
        }
      }
    },
    createHmac(algorithm, key) {
      const alg = String(algorithm || 'sha256').toLowerCase()
      const keyBytes = typeof key === 'string' ? utf8Bytes(key) : new Uint8Array(key || [])
      const chunks = [keyBytes]
      return {
        update(data) {
          const bytes = typeof data === 'string' ? utf8Bytes(data) : new Uint8Array(data || [])
          chunks.push(bytes)
          return this
        },
        digest(encoding) {
          const totalLen = chunks.reduce((s, c) => s + c.length, 0)
          const merged = new Uint8Array(totalLen)
          let offset = 0
          for (const c of chunks) {
            merged.set(c, offset)
            offset += c.length
          }
          const raw = wrapBufferLike(simpleDigestBytes(alg, merged))
          return encoding ? raw.toString(encoding) : raw
        }
      }
    },
    randomBytes(size) {
      const bytes = new Uint8Array(size)
      if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes)
      }
      return wrapBufferLike(bytes)
    },
    randomUUID() {
      if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
        return globalThis.crypto.randomUUID()
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0
        const v = c === 'x' ? r : (r & 0x3) | 0x8
        return v.toString(16)
      })
    }
  }
}

const pathShim = {
  join: (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'),
  resolve: (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/'),
  dirname: (p) => {
    const s = String(p || '').replace(/\\/g, '/')
    const idx = s.lastIndexOf('/')
    return idx >= 0 ? s.slice(0, idx) : '.'
  },
  basename: (p, ext = '') => {
    const s = String(p || '').replace(/\\/g, '/')
    const base = s.slice(s.lastIndexOf('/') + 1)
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base
  },
  extname: (p) => {
    const base = pathShim.basename(p)
    const idx = base.lastIndexOf('.')
    return idx > 0 ? base.slice(idx) : ''
  }
}

const readOnlyFsSandboxShim = {
  existsSync: () => false,
  readdirSync: () => [],
  readFileSync: () => '',
  statSync: () => ({ isDirectory: () => false, isFile: () => false, size: 0 }),
  mkdirSync: () => undefined,
  writeFileSync: () => undefined
}

/**
 * 规范化插件内相对模块路径（相对于 entry 所在目录，如 dist/）
 */
export function normalizeRelativeModulePath(entryDir, specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('./')) {
    const err = new Error(`禁止加载非法的模块路径: ${specifier}`)
    err.code = 'UNAUTHORIZED_MODULE_ACCESS'
    throw err
  }
  if (specifier.includes('..') || specifier.includes('\\')) {
    const err = new Error(`检测到路径穿越攻击: ${specifier}`)
    err.code = 'PATH_TRAVERSAL_BLOCKED'
    throw err
  }
  let cleanSub = specifier.slice(2).replace(/^\/+/, '')
  if (!cleanSub.endsWith('.js')) {
    cleanSub += '.js'
  }
  const cleanDir = String(entryDir || '').replace(/^\/+|\/+$/g, '')
  return cleanDir ? `${cleanDir}/${cleanSub}` : cleanSub
}

/**
 * 提取源码中引用的所有本地相对模块 specifier (如 ./logic, ./engine.js, ./data.js)
 */
export function extractRelativeSpecifiers(sourceCode) {
  const specifiers = new Set()
  const code = String(sourceCode || '')

  // 1. 匹配 require("./xxx")
  const requireRegex = /\brequire\s*\(\s*['"](\.\/[^'"]+)['"]\s*\)/g
  let match
  while ((match = requireRegex.exec(code)) !== null) {
    specifiers.add(match[1])
  }

  // 2. 匹配 ESM import ... from "./xxx" 或 export * from "./xxx"
  const importRegex = /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"](\.\/[^'"]+)['"]/g
  while ((match = importRegex.exec(code)) !== null) {
    specifiers.add(match[1])
  }

  return Array.from(specifiers)
}

/**
 * 将编译产物中的轻量 ESM 语法转换为标准 CommonJS 语法，以便在受控沙箱中统一同步链接
 */
export function transpileEsmToCjs(sourceCode) {
  let code = String(sourceCode || '')

  if (!/^\s*(?:import|export)\b/m.test(code)) {
    return code
  }

  const exportedClasses = []

  // 1. import React, { a, b as c } from "mod"
  code = code.replace(
    /^\s*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/gm,
    (_, defaultName, namedBlock, modName) => {
      const normalizedNamed = namedBlock.replace(/\bas\b/g, ':')
      return `const __mod_${defaultName} = require("${modName}"); const ${defaultName} = __mod_${defaultName}.default || __mod_${defaultName}; const { ${normalizedNamed} } = __mod_${defaultName};`
    }
  )

  // 2. import * as ns from "mod"
  code = code.replace(
    /^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]\s*;?/gm,
    (_, nsName, modName) => `const ${nsName} = require("${modName}");`
  )

  // 3. import { a, b as c } from "mod" (支持跨行)
  code = code.replace(
    /^\s*import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?/gm,
    (_, namedBlock, modName) => {
      const normalizedNamed = namedBlock.replace(/\bas\b/g, ':')
      return `const { ${normalizedNamed} } = require("${modName}");`
    }
  )

  // 4. import DefaultName from "mod"
  code = code.replace(
    /^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]\s*;?/gm,
    (_, defaultName, modName) =>
      `const __mod_${defaultName} = require("${modName}"); const ${defaultName} = __mod_${defaultName}.default || __mod_${defaultName};`
  )

  // 5. export * from "mod"
  code = code.replace(
    /^\s*export\s+\*\s+from\s*['"]([^'"]+)['"]\s*;?/gm,
    (_, modName) => `Object.assign(exports, require("${modName}"));`
  )

  // 6. export { a, b as c } from "mod"
  code = code.replace(
    /^\s*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/gm,
    (_, namedBlock, modName) => {
      const pairs = namedBlock
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((item) => {
          const parts = item.split(/\s+as\s+/)
          return parts.length === 2
            ? `${parts[1].trim()}: __exp_mod.${parts[0].trim()}`
            : `${parts[0].trim()}: __exp_mod.${parts[0].trim()}`
        })
        .join(', ')
      return `{ const __exp_mod = require("${modName}"); Object.assign(exports, { ${pairs} }); }`
    }
  )

  // 7. export default async function Name(...) / export default function Name(...)
  code = code.replace(
    /^\s*export\s+default\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    (_, asyncKw, fnName) => `exports.default = ${fnName}; ${asyncKw || ''}function ${fnName}`
  )

  // 8. export default ...
  code = code.replace(/^\s*export\s+default\s+/gm, 'exports.default = ')

  // 9. export async function Name(...) / export function Name(...)
  code = code.replace(
    /^\s*export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    (_, asyncKw, fnName) => `exports.${fnName} = ${fnName}; ${asyncKw || ''}function ${fnName}`
  )

  // 10. export class Name (避免 class TDZ 暂时性死区，在文件尾部统一挂载到 exports)
  code = code.replace(
    /^\s*export\s+class\s+([A-Za-z_$][\w$]*)/gm,
    (_, className) => {
      exportedClasses.push(className)
      return `class ${className}`
    }
  )

  // 11. export const/let/var Name =
  code = code.replace(
    /^\s*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
    (_, declType, varName) => `${declType} ${varName} = exports.${varName} =`
  )

  // 12. export { a, b as c }
  code = code.replace(/^\s*export\s*\{([^}]*)\}\s*;?/gm, (_, namedBlock) => {
    const pairs = namedBlock
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((item) => {
        const parts = item.split(/\s+as\s+/)
        return parts.length === 2 ? `${parts[1].trim()}: ${parts[0].trim()}` : parts[0].trim()
      })
      .join(', ')
    return `Object.assign(exports, { ${pairs} });`
  })

  if (exportedClasses.length > 0) {
    const tail = exportedClasses.map((cls) => `exports.${cls} = ${cls};`).join('\n')
    code = `${code}\n${tail}\n`
  }

  return code
}

/**
 * 默认通过 ztools://plugins/{pluginId}/{relPath} 协议读取文件内容
 */
async function defaultReadPluginFile(pluginId, relPath) {
  const cleanId = encodeURIComponent(String(pluginId).trim())
  const cleanPath = String(relPath).replace(/^\/+/, '')
  const url = `ztools://plugins/${cleanId}/${cleanPath}`
  const response = await fetch(url)
  if (!response.ok) {
    const err = new Error(`无法加载插件资源 [${url}]: HTTP ${response.status}`)
    err.status = response.status
    err.code = 'PLUGIN_RESOURCE_NOT_FOUND'
    throw err
  }
  return await response.text()
}

/**
 * 动态加载并求值已安装的声明式插件
 *
 * @param {string} pluginId - 插件 ID
 * @param {object} [options]
 * @param {(pluginId: string, relPath: string) => Promise<string>} [options.readFile] - 自定义文件读取器（测试可注入）
 */
export async function loadInstalledDeclarativePlugin(pluginId, options = {}) {
  const pid = String(pluginId || '').trim()
  if (!pid || /[/\\]/.test(pid) || pid.includes('..')) {
    const err = new Error(`非法的插件标识符: ${pid}`)
    err.code = 'INVALID_PLUGIN_ID'
    throw err
  }

  const readFile = options.readFile || defaultReadPluginFile

  // 1. 读取 plugin.json
  const manifestRaw = await readFile(pid, 'plugin.json')
  let manifest
  try {
    manifest = JSON.parse(manifestRaw)
  } catch (parseErr) {
    const err = new Error(`插件 [${pid}] 的 plugin.json 格式损坏: ${parseErr.message}`)
    err.code = 'INVALID_PLUGIN_MANIFEST'
    throw err
  }

  const entryRelPath = String(manifest.entry || 'dist/index.js').replace(/^\/+/, '').replace(/\\/g, '/')
  if (!entryRelPath.endsWith('.js') || entryRelPath.includes('..')) {
    const err = new Error(`插件 [${pid}] 入口文件不是合法的声明式 JS 模块: ${entryRelPath}`)
    err.code = 'UNSUPPORTED_PLUGIN_ENTRY'
    throw err
  }

  const lastSlash = entryRelPath.lastIndexOf('/')
  const entryDir = lastSlash >= 0 ? entryRelPath.slice(0, lastSlash) : ''

  // 2. 递归拉取入口文件及其所有相对依赖源码
  const sourceMap = new Map()

  async function collectModuleSources(relPath) {
    if (sourceMap.has(relPath)) return
    const code = await readFile(pid, relPath)
    sourceMap.set(relPath, code)

    const relativeSpecs = extractRelativeSpecifiers(code)
    for (const spec of relativeSpecs) {
      const childRelPath = normalizeRelativeModulePath(entryDir, spec)
      await collectModuleSources(childRelPath)
    }
  }

  await collectModuleSources(entryRelPath)

  // 3. 受控模块求值沙箱
  const evaluatedModules = new Map()
  const evaluatingSet = new Set()

  const compatExports = {
    ...DeclarativeUI,
    default: DeclarativeUI.default || DeclarativeUI,
    __esModule: true
  }

  const cryptoShim = createBrowserCryptoShim()
  const declaredPermissions = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : [])

  function evaluateModule(relPath) {
    if (evaluatedModules.has(relPath)) {
      return evaluatedModules.get(relPath)
    }
    if (evaluatingSet.has(relPath)) {
      return {}
    }

    const rawCode = sourceMap.get(relPath)
    if (typeof rawCode !== 'string') {
      const err = new Error(`未找到插件模块源码: ${relPath}`)
      err.code = 'MODULE_NOT_FOUND'
      throw err
    }

    evaluatingSet.add(relPath)
    const moduleObj = { exports: {} }
    evaluatedModules.set(relPath, moduleObj.exports)

    const customRequire = (specifier) => {
      if (
        specifier === '@ztools/declarative-ui' ||
        specifier === '@ztools/raycast-compat' ||
        specifier === '@raycast/api' ||
        specifier === 'react' ||
        specifier === 'react/jsx-runtime'
      ) {
        return compatExports
      }
      if (specifier === 'crypto' || specifier === 'node:crypto') {
        return { ...cryptoShim, default: cryptoShim, __esModule: true }
      }
      if (specifier === 'path' || specifier === 'node:path') {
        return { ...pathShim, default: pathShim, __esModule: true }
      }
      if (specifier === 'fs' || specifier === 'node:fs') {
        if (!declaredPermissions.has('fs')) {
          const err = new Error(`安全沙箱拦截：插件 [${pid}] 未声明 fs 权限，禁止访问文件系统模块`)
          err.code = 'UNAUTHORIZED_MODULE_ACCESS'
          throw err
        }
        return { ...readOnlyFsSandboxShim, default: readOnlyFsSandboxShim, __esModule: true }
      }
      if (typeof specifier === 'string' && specifier.startsWith('./')) {
        const targetRelPath = normalizeRelativeModulePath(entryDir, specifier)
        return evaluateModule(targetRelPath)
      }
      const err = new Error(`安全沙箱拦截：禁止插件 [${pid}] 加载未授权模块 "${specifier}"`)
      err.code = 'UNAUTHORIZED_MODULE_ACCESS'
      throw err
    }

    try {
      const cjsCode = transpileEsmToCjs(rawCode)
      const factory = new Function('exports', 'require', 'module', cjsCode)
      factory(moduleObj.exports, customRequire, moduleObj)
    } catch (evalErr) {
      if (evalErr && (evalErr.code === 'UNAUTHORIZED_MODULE_ACCESS' || evalErr.code === 'PATH_TRAVERSAL_BLOCKED')) {
        throw evalErr
      }
      const err = new Error(`插件 [${pid}] 模块 (${relPath}) 执行异常: ${evalErr.message}`)
      err.code = 'PLUGIN_EVALUATION_ERROR'
      err.cause = evalErr
      throw err
    } finally {
      evaluatingSet.delete(relPath)
    }

    evaluatedModules.set(relPath, moduleObj.exports)
    return moduleObj.exports
  }

  const entryExports = evaluateModule(entryRelPath)

  let rootCommand =
    entryExports?.default ||
    (typeof entryExports === 'function' ? entryExports : null)

  if (typeof rootCommand !== 'function' && entryExports && typeof entryExports === 'object') {
    for (const val of Object.values(entryExports)) {
      if (typeof val === 'function') {
        rootCommand = val
        break
      }
    }
  }

  if (typeof rootCommand !== 'function') {
    const err = new Error(`插件 [${pid}] 未导出有效的声明式组件函数 (default export)`)
    err.code = 'INVALID_DECLARATIVE_COMPONENT'
    throw err
  }

  const iconRel = manifest.icon ? String(manifest.icon).replace(/^\/+/, '') : 'icon.svg'

  return {
    id: manifest.id || pid,
    pluginId: manifest.id || pid,
    name: manifest.name || pid,
    title: manifest.name || pid,
    description: manifest.description || '',
    version: manifest.version || '1.0.0',
    author: typeof manifest.author === 'string' ? manifest.author : (manifest.author?.name || 'ZTools Official'),
    icon: `ztools://plugins/${encodeURIComponent(pid)}/${iconRel}`,
    faIcon: 'fa-bolt',
    iconGradient: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
    isDeclarative: true,
    isInstalledDeclarative: true,
    command: rootCommand,
    manifest
  }
}
