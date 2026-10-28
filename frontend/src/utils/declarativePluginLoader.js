/**
 * declarativePluginLoader.js
 * ZTools V2 声明式插件动态加载器
 *
 * 职责：
 * 1. 从本地已安装插件目录 (ztools://plugins/{pluginId}/...) 动态读取 plugin.json 与入口 JS 模块；
 * 2. 兼容编译后的 CommonJS (require/exports) 与 ESM (import/export) 两种产物格式；
 * 3. 递归解析插件内部同级相对模块（如 ./logic.js, ./engine.js, ./data.js, ./types.js）；
 * 4. 严格执行模块白名单：仅允许 @ztools/declarative-ui（及其兼容别名）与纯计算模块 (crypto/path)，
 *    拦截其他任何模块（如 fs, child_process, net, vm）与路径穿越访问；文件读写走宿主 window.ztools.fs。
 */

import * as DeclarativeUI from '@ztools/declarative-ui'
import { createCacheScope } from '@ztools/declarative-ui/host'
import { isBundledPlugin, readBundledPluginFile, getBundledPluginIconUrl } from './bundledPlugins.js'
import { createScopedLocalStorage } from './pluginStorage.js'
import { createScopedHostBridge, createScopedWindow, getPluginSessionHolder } from '../declarative/pluginSession.js'
import { createPluginHostApis } from '../declarative/pluginSecureStorage.js'

export const V2_CATALOG_CDN_URL = 'https://cdn.ztools.cn/plugins-v2/catalog.json'

/**
 * 渲染进程里提供给插件的 `crypto` 模块：只提供有真实实现的接口。
 *
 * - createHash / createHmac：仅支持 MD5、SHA-1、SHA-256（标准算法实现），其他算法抛 UNSUPPORTED_NODE_API；
 * - createCipheriv / createDecipheriv：不提供，抛 UNSUPPORTED_NODE_API，请改用 WebCrypto（globalThis.crypto.subtle）；
 * - randomBytes / randomUUID：使用 WebCrypto 安全随机数。
 */
function createRendererCryptoModule(pluginId) {
  const unsupported = (name) => () => {
    const err = new Error(`插件 [${pluginId}] 调用了 crypto.${name}：声明式插件运行在渲染进程，不提供 Node 摘要接口，请改用 WebCrypto 或自带实现`)
    err.code = 'UNSUPPORTED_NODE_API'
    throw err
  }

  function utf8Bytes(text) {
    return new TextEncoder().encode(String(text))
  }

  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }

  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ])

  function rotr32(x, n) {
    return (x >>> n) | (x << (32 - n))
  }

  function rotl32(x, n) {
    return (x << n) | (x >>> (32 - n))
  }

  function sha256Bytes(dataBytes) {
    const bitLen = dataBytes.length * 8
    const padLen = (dataBytes.length + 9 + 63) & ~63
    const buf = new Uint8Array(padLen)
    buf.set(dataBytes, 0)
    buf[dataBytes.length] = 0x80
    const view = new DataView(buf.buffer)
    view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false)
    view.setUint32(padLen - 4, bitLen >>> 0, false)

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19
    const w = new Uint32Array(64)

    for (let offset = 0; offset < padLen; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
      for (let i = 16; i < 64; i++) {
        const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)
        const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7
      for (let i = 0; i < 64; i++) {
        const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)
        const ch = (e & f) ^ (~e & g)
        const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0
        const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)
        const maj = (a & b) ^ (a & c) ^ (b & c)
        const t2 = (S0 + maj) >>> 0
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0
      h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0
    }

    const out = new Uint8Array(32)
    const outView = new DataView(out.buffer)
    ;[h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, idx) => outView.setUint32(idx * 4, v >>> 0, false))
    return out
  }

  function sha1Bytes(dataBytes) {
    const bitLen = dataBytes.length * 8
    const padLen = (dataBytes.length + 9 + 63) & ~63
    const buf = new Uint8Array(padLen)
    buf.set(dataBytes, 0)
    buf[dataBytes.length] = 0x80
    const view = new DataView(buf.buffer)
    view.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000), false)
    view.setUint32(padLen - 4, bitLen >>> 0, false)

    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0
    const w = new Uint32Array(80)
    for (let offset = 0; offset < padLen; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
      for (let i = 16; i < 80; i++) w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1) >>> 0
      let a = h0, b = h1, c = h2, d = h3, e = h4
      for (let i = 0; i < 80; i++) {
        let f, k
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999 }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1 }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc }
        else { f = b ^ c ^ d; k = 0xca62c1d6 }
        const temp = (rotl32(a, 5) + f + e + k + w[i]) >>> 0
        e = d; d = c; c = rotl32(b, 30) >>> 0; b = a; a = temp
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0
    }
    const out = new Uint8Array(20)
    const outView = new DataView(out.buffer)
    ;[h0, h1, h2, h3, h4].forEach((v, idx) => outView.setUint32(idx * 4, v >>> 0, false))
    return out
  }

  const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ]
  const MD5_K = new Uint32Array(64)
  for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0

  function md5Bytes(dataBytes) {
    const bitLen = dataBytes.length * 8
    const padLen = (dataBytes.length + 9 + 63) & ~63
    const buf = new Uint8Array(padLen)
    buf.set(dataBytes, 0)
    buf[dataBytes.length] = 0x80
    const view = new DataView(buf.buffer)
    view.setUint32(padLen - 8, bitLen >>> 0, true)
    view.setUint32(padLen - 4, Math.floor(bitLen / 0x100000000), true)

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476
    const M = new Uint32Array(16)
    for (let offset = 0; offset < padLen; offset += 64) {
      for (let j = 0; j < 16; j++) M[j] = view.getUint32(offset + j * 4, true)
      let A = a0, B = b0, C = c0, D = d0
      for (let i = 0; i < 64; i++) {
        let F, g
        if (i < 16) { F = (B & C) | (~B & D); g = i }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16 }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16 }
        else { F = C ^ (B | ~D); g = (7 * i) % 16 }
        F = (F + A + MD5_K[i] + M[g]) >>> 0
        A = D; D = C; C = B; B = (B + rotl32(F, MD5_S[i])) >>> 0
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0
    }
    const out = new Uint8Array(16)
    const outView = new DataView(out.buffer)
    ;[a0, b0, c0, d0].forEach((v, idx) => outView.setUint32(idx * 4, v >>> 0, true))
    return out
  }

  // 只登记有标准实现的算法；SHA-512 等其他算法直接报错，绝不返回看似正常的错误结果
  const DIGESTS = { md5: md5Bytes, sha1: sha1Bytes, 'sha-1': sha1Bytes, sha256: sha256Bytes, 'sha-256': sha256Bytes }

  function resolveDigest(algorithm, api) {
    const alg = String(algorithm ?? '').trim().toLowerCase()
    if (!Object.hasOwn(DIGESTS, alg)) unsupported(`${api}('${String(algorithm)}')`)()
    return DIGESTS[alg]
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
      const digest = resolveDigest(algorithm, 'createHash')
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
          const raw = wrapBufferLike(digest(merged))
          return encoding ? raw.toString(encoding) : raw
        }
      }
    },
    createHmac(algorithm, key) {
      const digest = resolveDigest(algorithm, 'createHmac')
      // MD5 / SHA-1 / SHA-256 的分组长度都是 64 字节
      const blockSize = 64
      let keyBytes = typeof key === 'string' ? utf8Bytes(key) : new Uint8Array(key || [])
      if (keyBytes.length > blockSize) {
        keyBytes = digest(keyBytes)
      }
      const paddedKey = new Uint8Array(blockSize)
      paddedKey.set(keyBytes, 0)
      const oKeyPad = new Uint8Array(blockSize)
      const iKeyPad = new Uint8Array(blockSize)
      for (let i = 0; i < blockSize; i++) {
        oKeyPad[i] = paddedKey[i] ^ 0x5c
        iKeyPad[i] = paddedKey[i] ^ 0x36
      }
      const chunks = [iKeyPad]
      return {
        update(data) {
          const bytes = typeof data === 'string' ? utf8Bytes(data) : new Uint8Array(data || [])
          chunks.push(bytes)
          return this
        },
        digest(encoding) {
          const totalLen = chunks.reduce((s, c) => s + c.length, 0)
          const innerMerged = new Uint8Array(totalLen)
          let offset = 0
          for (const c of chunks) {
            innerMerged.set(c, offset)
            offset += c.length
          }
          const innerHash = digest(innerMerged)
          const outerMerged = new Uint8Array(blockSize + innerHash.length)
          outerMerged.set(oKeyPad, 0)
          outerMerged.set(innerHash, blockSize)
          const raw = wrapBufferLike(digest(outerMerged))
          return encoding ? raw.toString(encoding) : raw
        }
      }
    },
    createCipheriv: unsupported('createCipheriv'),
    createDecipheriv: unsupported('createDecipheriv'),
    randomBytes(size) {
      const n = Number(size)
      if (!Number.isInteger(n) || n < 0 || n > 65536) throw new RangeError('randomBytes 长度必须是 0–65536 的整数')
      const bytes = new Uint8Array(n)
      globalThis.crypto.getRandomValues(bytes)
      return bytes
    },
    randomUUID() {
      return globalThis.crypto.randomUUID()
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
    /^[ \t]*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (_, defaultName, namedBlock, modName) => {
      const normalizedNamed = namedBlock.replace(/\bas\b/g, ':')
      return `const __mod_${defaultName} = require("${modName}"); const ${defaultName} = __mod_${defaultName}.default || __mod_${defaultName}; const { ${normalizedNamed} } = __mod_${defaultName};`
    }
  )

  // 2. import * as ns from "mod"
  code = code.replace(
    /^[ \t]*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (_, nsName, modName) => `const ${nsName} = require("${modName}");`
  )

  // 3. import { a, b as c } from "mod" (支持跨行)
  code = code.replace(
    /^[ \t]*import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (_, namedBlock, modName) => {
      const normalizedNamed = namedBlock.replace(/\bas\b/g, ':')
      return `const { ${normalizedNamed} } = require("${modName}");`
    }
  )

  // 4. import DefaultName from "mod"
  code = code.replace(
    /^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (_, defaultName, modName) =>
      `const __mod_${defaultName} = require("${modName}"); const ${defaultName} = __mod_${defaultName}.default || __mod_${defaultName};`
  )

  // 5. export * from "mod"
  code = code.replace(
    /^[ \t]*export\s+\*\s+from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (_, modName) => `Object.assign(exports, require("${modName}"));`
  )

  // 6. export { a, b as c } from "mod"
  code = code.replace(
    /^[ \t]*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"][ \t]*;?/gm,
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
    /^[ \t]*export\s+default\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    (_, asyncKw, fnName) => `exports.default = ${fnName}; ${asyncKw || ''}function ${fnName}`
  )

  // 8. export default ...
  code = code.replace(/^[ \t]*export\s+default\s+/gm, 'exports.default = ')

  // 9. export async function Name(...) / export function Name(...)
  code = code.replace(
    /^[ \t]*export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    (_, asyncKw, fnName) => `exports.${fnName} = ${fnName}; ${asyncKw || ''}function ${fnName}`
  )

  // 10. export class Name (避免 class TDZ 暂时性死区，在文件尾部统一挂载到 exports)
  code = code.replace(
    /^[ \t]*export\s+class\s+([A-Za-z_$][\w$]*)/gm,
    (_, className) => {
      exportedClasses.push(className)
      return `class ${className}`
    }
  )

  // 11. export const/let/var Name =
  code = code.replace(
    /^[ \t]*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm,
    (_, declType, varName) => `${declType} ${varName} = exports.${varName} =`
  )

  // TypeScript 枚举先声明 export var，再由后续 IIFE 赋值，导出必须读取赋值后的变量。
  code = code.replace(
    /^[ \t]*export\s+(let|var)\s+([A-Za-z_$][\w$]*)[ \t]*;/gm,
    (_, declType, varName) =>
      `${declType} ${varName}; Object.defineProperty(exports, "${varName}", { enumerable: true, get: () => ${varName} });`
  )

  // 12. export { a, b as c }
  code = code.replace(/^[ \t]*export\s*\{([^}]*)\}[ \t]*;?/gm, (_, namedBlock) => {
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

const loadedPluginCache = new Map()
let lastCachedFetchRef = null

/**
 * 每个插件独立的 SDK 缓存作用域（Cache / useCachedPromise / useCachedState），按小写插件 ID 登记。
 * 与模块加载缓存分开：插件重新加载（更新、清缓存）后仍沿用本次运行中的缓存数据，客户端重启后清空。
 */
const pluginCacheScopes = new Map()

function getPluginCacheScope(pluginId) {
  const key = String(pluginId || '').trim().toLowerCase()
  let scope = pluginCacheScopes.get(key)
  if (!scope) {
    scope = createCacheScope()
    pluginCacheScopes.set(key, scope)
  }
  return scope
}

function ensureCacheFreshForCurrentFetch() {
  const currentFetch = typeof globalThis !== 'undefined' ? globalThis.fetch : null
  if (currentFetch !== lastCachedFetchRef) {
    loadedPluginCache.clear()
    lastCachedFetchRef = currentFetch
  }
}

function buildPluginCacheKey(pluginId, featureCode = '') {
  return `${String(pluginId || '').trim().toLowerCase()}::${String(featureCode || '').trim()}`
}

/**
 * 同步读取内存中已缓存的声明式插件实例（用于路由切换零延迟首帧直出）
 */
export function getCachedDeclarativePlugin(pluginId, options = {}) {
  if (options?.readFile || options?.localStorage || options?.forceReload) return null
  ensureCacheFreshForCurrentFetch()
  const pid = String(pluginId || '').trim()
  if (!pid) return null
  const key = buildPluginCacheKey(pid, options?.featureCode)
  return loadedPluginCache.get(key) || null
}

/**
 * 清理指定或全部声明式插件的内存缓存（插件安装/更新/卸载后调用）
 */
export function clearDeclarativePluginCache(pluginId) {
  if (!pluginId) {
    loadedPluginCache.clear()
    return
  }
  const prefix = `${String(pluginId).trim().toLowerCase()}::`
  for (const key of loadedPluginCache.keys()) {
    if (key.startsWith(prefix)) {
      loadedPluginCache.delete(key)
    }
  }
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

  const cached = getCachedDeclarativePlugin(pid, options)
  if (cached) {
    return cached
  }

  // 内置官方插件随客户端分发，从 bundled-plugins/ 读取；其余插件从已安装目录 ztools://plugins/ 读取
  const bundled = !options.readFile && isBundledPlugin(pid)
  const readFile = options.readFile || (bundled ? readBundledPluginFile : defaultReadPluginFile)

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

  // 会话归属：每个插件一个 holder（同一渲染进程里共享、引用计数），插件代码拿到的 window / globalThis / self
  // 是插件专属视图，其中 __ztoolsElectron 自动带会话令牌。原始通道在插件代码运行前取出，插件改写全局影响不到。
  // 注意这不是安全隔离（见 pluginSession.js）。测试注入了 readFile 时也照常构造，便于验证。
  const sessionHolder = options.sessionHolder || getPluginSessionHolder(manifest.id || pid)
  const realWindow = options.hostWindow || (typeof window !== 'undefined' ? window : globalThis)
  const scopedBridge = createScopedHostBridge(sessionHolder, realWindow?.__ztoolsElectron)
  const scopedWindow = createScopedWindow(realWindow, scopedBridge)
  const scopedMethods = scopedBridge?.transport?.methods || null
  const hostApis = createPluginHostApis({ pluginId: manifest.id || pid, methods: scopedMethods })

  // 每个插件拿到自己的 LocalStorage：数据按插件 ID 隔离，写入宿主插件存储（落盘、重启不丢）
  // Cache 与缓存 Hook 同样按插件 ID 隔离（内存），插件之间读不到彼此的缓存
  const cacheScope = getPluginCacheScope(manifest.id || pid)
  const compatExports = {
    ...DeclarativeUI,
    LocalStorage: options.localStorage || createScopedLocalStorage(manifest.id || pid),
    Cache: cacheScope.Cache,
    useCachedPromise: cacheScope.useCachedPromise,
    useCachedState: cacheScope.useCachedState,
    SecureStorage: hostApis.SecureStorage,
    terminateProcess: hostApis.terminateProcess,
    getHostTransport: hostApis.getHostTransport,
    default: DeclarativeUI.default || DeclarativeUI,
    __esModule: true
  }

  const cryptoShim = createRendererCryptoModule(pid)

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
      if (typeof specifier === 'string' && specifier.startsWith('./')) {
        const targetRelPath = normalizeRelativeModulePath(entryDir, specifier)
        return evaluateModule(targetRelPath)
      }
      // fs 模块在渲染进程里没有实现，给出替代方案，方便插件作者定位
      const hint = /^(node:)?fs(\/promises)?$/.test(String(specifier)) ? '；读写文件请改用宿主 API window.ztools.fs' : ''
      const err = new Error(`安全沙箱拦截：禁止插件 [${pid}] 加载未授权模块 "${specifier}"${hint}`)
      err.code = 'UNAUTHORIZED_MODULE_ACCESS'
      throw err
    }

    try {
      const cjsCode = transpileEsmToCjs(rawCode)
      // window / self / globalThis 用 var 绑定到插件专属视图，再包一层函数：插件顶层自己声明 const self 等不会语法冲突
      const factory = new Function(
        'exports', 'require', 'module', '__ztoolsScopedWindow__',
        `var window = __ztoolsScopedWindow__, self = __ztoolsScopedWindow__, globalThis = __ztoolsScopedWindow__;\n` +
          `return (function () {\n${cjsCode}\n}).call(this);`
      )
      factory.call(scopedWindow, moduleObj.exports, customRequire, moduleObj, scopedWindow)
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

  const requestedFeatureCode = typeof options.featureCode === 'string' ? options.featureCode.trim() : ''
  const launchPluginId = manifest.id || pid
  try {
    scopedWindow.__ztoolsLaunchContext = {
      pluginId: launchPluginId,
      featureCode: requestedFeatureCode
    }
  } catch {
    // ignore
  }
  const entryExports = evaluateModule(entryRelPath)

  let rootCommand = null

  if (requestedFeatureCode && entryExports && typeof entryExports === 'object') {
    const camelCode = requestedFeatureCode.replace(/[-_]+([a-zA-Z0-9])/g, (_, ch) => ch.toUpperCase())
    const pascalCode = camelCode ? camelCode[0].toUpperCase() + camelCode.slice(1) : ''
    const candidates = [
      entryExports.commands?.[requestedFeatureCode],
      entryExports.features?.[requestedFeatureCode],
      entryExports[requestedFeatureCode],
      camelCode ? entryExports[camelCode] : null,
      pascalCode ? entryExports[pascalCode] : null,
      entryExports[`${camelCode}Command`],
      pascalCode ? entryExports[`${pascalCode}Command`] : null
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'function') {
        rootCommand = candidate
        break
      }
    }
  }

  if (typeof rootCommand !== 'function') {
    rootCommand =
      entryExports?.default ||
      (typeof entryExports === 'function' ? entryExports : null)
  }

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

  const rawRootCommand = rootCommand
  const wrappedRootCommand = function (...args) {
    try {
      scopedWindow.__ztoolsLaunchContext = {
        pluginId: launchPluginId,
        featureCode: requestedFeatureCode
      }
    } catch {
      // ignore
    }
    return rawRootCommand.apply(this, args)
  }

  const matchedFeature = Array.isArray(manifest.features)
    ? manifest.features.find((f) => f && String(f.code || '').trim() === requestedFeatureCode)
    : null

  const iconRel = (matchedFeature?.icon || manifest.icon)
    ? String(matchedFeature?.icon || manifest.icon).replace(/^\/+/, '')
    : 'icon.svg'

  const effectiveMode = matchedFeature?.mode || manifest.mode || 'view'
  const effectiveTitle = matchedFeature?.explain || manifest.name || pid

  const loadedPlugin = {
    id: manifest.id || pid,
    pluginId: manifest.id || pid,
    featureCode: requestedFeatureCode || '',
    name: effectiveTitle,
    title: effectiveTitle,
    description: manifest.description || '',
    version: manifest.version || '1.0.0',
    author: typeof manifest.author === 'string' ? manifest.author : (manifest.author?.name || 'ZTools Official'),
    icon: bundled ? getBundledPluginIconUrl(pid, iconRel) : `ztools://plugins/${encodeURIComponent(pid)}/${iconRel}`,
    faIcon: 'fa-bolt',
    mode: effectiveMode,
    alias: matchedFeature?.alias || manifest.alias || '',
    features: Array.isArray(manifest.features) ? manifest.features : [],
    isDeclarative: true,
    isInstalledDeclarative: true,
    command: wrappedRootCommand,
    manifest,
    /** 会话归属 holder：挂载点 acquire / release（见 useDeclarativePluginSession） */
    session: sessionHolder
  }

  if (!options?.readFile && !options?.localStorage) {
    ensureCacheFreshForCurrentFetch()
    loadedPluginCache.set(buildPluginCacheKey(pid, requestedFeatureCode), loadedPlugin)
    if (manifest.id && String(manifest.id).trim().toLowerCase() !== pid.toLowerCase()) {
      loadedPluginCache.set(buildPluginCacheKey(manifest.id, requestedFeatureCode), loadedPlugin)
    }
  }

  return loadedPlugin
}

/**
 * 在受控沙箱中执行 mode="no-view" 的无视图极速命令
 *
 * @param {string} pluginId - 插件 ID
 * @param {object} [options]
 * @param {string} [options.featureCode] - 子命令标识
 * @param {string} [options.query] - 当前搜索框输入文本
 * @param {(pluginId: string, relPath: string) => Promise<string>} [options.readFile] - 测试可注入读取器
 */
export async function executeDeclarativeNoViewCommand(pluginId, options = {}) {
  const loaded = await loadInstalledDeclarativePlugin(pluginId, options)
  // 执行期间持有会话：命令里调用需要归属的能力（加密存储、结束进程）时带令牌
  const releaseSession = loaded.session ? await loaded.session.acquire() : null
  try {
    const context = {
      pluginId: loaded.pluginId,
      featureCode: loaded.featureCode || '',
      query: typeof options.query === 'string' ? options.query : '',
      launchType: 'user-initiated'
    }
    const rawResult = await Promise.resolve(loaded.command(context))
    let message = `${loaded.title} 已执行`
    if (typeof rawResult === 'string' && rawResult.trim()) {
      message = rawResult.trim()
    } else if (rawResult && typeof rawResult === 'object') {
      const customMsg = rawResult.message || rawResult.title || rawResult.toast
      if (typeof customMsg === 'string' && customMsg.trim()) {
        message = customMsg.trim()
      }
    }
    return {
      success: true,
      pluginId: loaded.pluginId,
      featureCode: loaded.featureCode || '',
      title: loaded.title,
      message,
      result: rawResult
    }
  } catch (execErr) {
    const err = new Error(`执行极速命令 [${loaded.title}] 失败: ${execErr?.message || String(execErr)}`)
    err.code = 'NO_VIEW_EXECUTION_ERROR'
    err.cause = execErr
    throw err
  } finally {
    releaseSession?.()
  }
}
