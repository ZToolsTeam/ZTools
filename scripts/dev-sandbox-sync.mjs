#!/usr/bin/env node

/**
 * dev-sandbox-sync.mjs
 * ZTools 开发测试沙盒（.ztools-dev/）增量预置同步与重置工具
 *
 * 设计目标：
 * 1. .ztools-dev/DataV2/ 与线上安装包数据目录（%APPDATA%\ZTools\DataV2）保持 100% 物理同构；
 * 2. 将仓库 plugins/ 中的非下架插件（默认含草稿插件）按文件 size + mtime 增量复制到
 *    .ztools-dev/DataV2/Plugins/<pluginId>/，不修改源码目录，完全走线上加载/卸载/更新逻辑；
 * 3. 若本地存在 CommonLibs 工具池发布源目录（DLLPlugins/CommonLibs/catalog-source.json），
 *    将当前平台工具归档安全解压并按 ECDSA P-256 离线验签契约落盘到
 *    .ztools-dev/DataV2/CommonLibs/<toolId>/，同时生成本地临时公钥文件供非打包开发版合并信任；
 *    既可离线直接就绪，也可删除后测试线上 CDN 下载；
 * 4. 提供安全重置能力（校验无存活 runtime.lock 进程后清空 .ztools-dev/）。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import {
  extractP256RawPublicKeyHex,
  inspectPeFile,
  isSafeCommonLibId,
  isSafeIdentifier,
  MAX_COMMON_LIBS_PER_MANIFEST,
  NATIVE_TRUST_MANIFEST_FILE,
  NATIVE_TRUST_SIGNATURE_FILE,
  resolvePrivateKeyMaterial,
  signPluginDirectory
} from './sign-native-trust.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..')
export const DEV_SANDBOX_DIR_NAME = '.ztools-dev'
export const DEV_DATA_DIR_NAME = 'DataV2'
export const DEV_TRUST_DIR_NAME = 'DevTrust'
export const DEV_COMMONLIBS_KEY_ID = 'ztools-commonlibs-dev-local'
export const DEV_COMMONLIBS_PUBLIC_KEYS_FILE = 'commonlibs-dev-public-keys.json'
const DEV_COMMONLIBS_KEYPAIR_FILE = 'dev-commonlibs-key.json'
const DEV_COMMONLIBS_CACHE_FILE = 'dev-commonlibs-sync-cache.json'
const DEV_NATIVE_PLUGINS_CACHE_FILE = 'dev-native-plugins-sync-cache.json'
const COMMONLIBS_CATALOG_DOMAIN_PREFIX = Buffer.from('ztools-commonlibs-catalog-v1\0', 'ascii')
const COMMONLIBS_TRUST_JSON_FILE = '.ztools-commonlib-trust.json'
const COMMONLIBS_TRUST_SIG_FILE = '.ztools-commonlib-trust.sig'
const COMMONLIBS_STATE_FILE = '.commonlibs-state.json'
const SOURCE_MANIFEST_FILE = 'catalog-source.json'
const NATIVE_RELEASE_CONFIG_FILE = 'native-release.json'
const NATIVE_HOST32_DLL_ABI = 'ztools-native-host/v1'
const WINDOWS_NATIVE_HOST_TARGET = Object.freeze({
  id: 'windows-electron-x64',
  platform: 'windows',
  runtime: 'electron',
  arch: 'x64'
})
const IGNORED_DLL_PLUGINS_DIRS = new Set(['Common', 'CommonLibs', 'commonlibs', 'outputs', 'node_modules'])
const ALLOWED_NATIVE_ROLE_OVERRIDES = new Set(['dependency', 'helper'])

const PLUGIN_RUNTIME_TOP_FILES = new Set([
  'plugin.json',
  'README.md',
  'README.en.md',
  NATIVE_TRUST_MANIFEST_FILE,
  NATIVE_TRUST_SIGNATURE_FILE
])
const PLUGIN_RUNTIME_TOP_DIRS = new Set(['dist', 'screenshots', 'lib', 'assets', 'locales'])
const PLUGIN_ICON_FILE_RE = /^icon\.[a-z0-9]+$/i
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TARGET_ID_PATTERN = /^[a-z][a-z0-9-]*$/
const RESERVED_WIN_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

let cachedYauzl = null

function getYauzl() {
  if (!cachedYauzl) {
    const req = createRequire(new URL('../electron-client/package.json', import.meta.url))
    cachedYauzl = req('yauzl')
  }
  return cachedYauzl
}

/** 计算开发隔离沙盒的全部标准路径 */
export function resolveDevSandboxPaths(rootDir = DEFAULT_ROOT_DIR) {
  const absRoot = path.resolve(rootDir)
  const sandboxRoot = path.join(absRoot, DEV_SANDBOX_DIR_NAME)
  const dataRoot = path.join(sandboxRoot, DEV_DATA_DIR_NAME)
  const pluginsRoot = path.join(dataRoot, 'Plugins')
  const commonLibsRoot = path.join(dataRoot, 'CommonLibs')
  const devTrustRoot = path.join(sandboxRoot, DEV_TRUST_DIR_NAME)
  const devPublicKeysPath = path.join(devTrustRoot, DEV_COMMONLIBS_PUBLIC_KEYS_FILE)
  const devKeyPairPath = path.join(devTrustRoot, DEV_COMMONLIBS_KEYPAIR_FILE)
  const devCommonLibsCachePath = path.join(devTrustRoot, DEV_COMMONLIBS_CACHE_FILE)
  const devNativePluginsCachePath = path.join(devTrustRoot, DEV_NATIVE_PLUGINS_CACHE_FILE)
  const runtimeLockPath = path.join(sandboxRoot, 'Migration', 'Transactions', 'runtime.lock')

  return {
    rootDir: absRoot,
    sandboxRoot,
    dataRoot,
    pluginsRoot,
    commonLibsRoot,
    devTrustRoot,
    devPublicKeysPath,
    devKeyPairPath,
    devCommonLibsCachePath,
    devNativePluginsCachePath,
    runtimeLockPath
  }
}

/** 解析本地 CommonLibs 发布源目录（不存在时返回 null，确保开源仓无强依赖） */
export function findLocalCommonLibsSourceDir(rootDir = DEFAULT_ROOT_DIR) {
  const candidates = [
    path.join(rootDir, 'DLLPlugins', 'CommonLibs'),
    path.join(rootDir, 'DLLPlugins', 'commonlibs')
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, SOURCE_MANIFEST_FILE))) {
      return candidate
    }
  }
  return null
}

/** 解析当前主机对应的 CommonLibs 平台架构键 */
export function resolveHostCommonLibsPlatformArch(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'win32-x64'
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return null
}

function isSafeRelativeZipPath(rawName) {
  if (typeof rawName !== 'string' || rawName.length === 0 || rawName.includes('\0') || rawName.includes('\\')) {
    return null
  }
  const isDir = rawName.endsWith('/')
  const normalized = isDir ? rawName.slice(0, -1) : rawName
  if (!normalized || normalized.startsWith('/') || normalized.includes(':')) return null
  const segments = normalized.split('/')
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || seg.endsWith('.') || seg.endsWith(' ') || RESERVED_WIN_DEVICE_RE.test(seg)) {
      return null
    }
  }
  return { normalized, isDir }
}

function isZipEntrySymlink(entry) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000
  return unixMode === 0o120000
}

function copyFileIncremental(srcPath, dstPath) {
  const srcStat = fs.lstatSync(srcPath)
  if (srcStat.isSymbolicLink() || !srcStat.isFile()) return false
  if (fs.existsSync(dstPath)) {
    const dstStat = fs.lstatSync(dstPath)
    if (
      !dstStat.isSymbolicLink() &&
      dstStat.isFile() &&
      dstStat.size === srcStat.size &&
      Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 2
    ) {
      return false
    }
    if (dstStat.isDirectory() && !dstStat.isSymbolicLink()) {
      fs.rmSync(dstPath, { recursive: true, force: true })
    }
  }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true })
  fs.copyFileSync(srcPath, dstPath)
  try {
    fs.utimesSync(dstPath, srcStat.atime, srcStat.mtime)
  } catch {
    // 忽略部分文件系统时间戳写入限制
  }
  return true
}

function collectRuntimePluginFiles(pluginSrcDir) {
  const files = []
  const topEntries = fs.readdirSync(pluginSrcDir, { withFileTypes: true })

  const walkDir = (absDir, relPrefix) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const absPath = path.join(absDir, entry.name)
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walkDir(absPath, relPath)
      } else if (entry.isFile()) {
        files.push({ srcPath: absPath, relPath })
      }
    }
  }

  for (const entry of topEntries) {
    if (entry.isSymbolicLink()) continue
    const absPath = path.join(pluginSrcDir, entry.name)
    if (entry.isFile()) {
      if (PLUGIN_RUNTIME_TOP_FILES.has(entry.name) || PLUGIN_ICON_FILE_RE.test(entry.name)) {
        files.push({ srcPath: absPath, relPath: entry.name })
      }
    } else if (entry.isDirectory() && PLUGIN_RUNTIME_TOP_DIRS.has(entry.name)) {
      walkDir(absPath, entry.name)
    }
  }
  return files
}

function pruneStalePluginFiles(pluginDstDir, expectedRelSet) {
  if (!fs.existsSync(pluginDstDir)) return
  const walk = (absDir, relPrefix) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const absPath = path.join(absDir, entry.name)
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        fs.rmSync(absPath, { force: true })
        continue
      }
      if (entry.isDirectory()) {
        // 仅清理受同步管理的子目录，保留用户/客户端在运行期生成的额外状态文件
        const topDir = relPath.split('/')[0]
        if (!PLUGIN_RUNTIME_TOP_DIRS.has(topDir)) continue
        walk(absPath, relPath)
        if (fs.readdirSync(absPath).length === 0) {
          fs.rmdirSync(absPath)
        }
      } else if (entry.isFile()) {
        const topSeg = relPath.split('/')[0]
        const managed =
          PLUGIN_RUNTIME_TOP_DIRS.has(topSeg) ||
          PLUGIN_RUNTIME_TOP_FILES.has(relPath)
        if (managed && !expectedRelSet.has(relPath)) {
          fs.rmSync(absPath, { force: true })
        }
      }
    }
  }
  walk(pluginDstDir, '')
}

function isSafeLibRelativePath(entry) {
  if (typeof entry !== 'string' || !entry.startsWith('lib/') || entry.includes('\\') || entry.includes(':')) {
    return false
  }
  if (/[\u0000-\u001f\u007f*?"<>|]/.test(entry)) return false
  const segments = entry.split('/')
  if (segments.length < 2) return false
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..' || seg.endsWith('.') || seg.endsWith(' ') || RESERVED_WIN_DEVICE_RE.test(seg)) {
      return false
    }
  }
  return true
}

function isPathInsideDir(baseDir, targetPath) {
  const rel = path.relative(path.resolve(baseDir), path.resolve(targetPath))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function computeFileSha256Sync(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function computeStringSha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function compareAppVersion(left, right) {
  const parse = (raw) =>
    String(raw || '')
      .trim()
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((num) => (Number.isFinite(num) && num >= 0 ? num : 0))
  const a = parse(left)
  const b = parse(right)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av !== bv) return av < bv ? -1 : 1
  }
  return 0
}

function resolveNativeComponentId(spec) {
  if (typeof spec.componentId === 'string' && TARGET_ID_PATTERN.test(spec.componentId.trim())) {
    return spec.componentId.trim()
  }
  const kebab = String(spec.dllId || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return TARGET_ID_PATTERN.test(kebab) ? kebab : 'native-plugin'
}

/**
 * 扫描本地 DLLPlugins/<id>/native-release.json（开源仓无该目录时静默返回空 Map）
 */
export function loadLocalNativePluginSpecs({
  rootDir = DEFAULT_ROOT_DIR,
  dllPluginsDir,
  warn = console.warn
} = {}) {
  const baseDir = dllPluginsDir ? path.resolve(dllPluginsDir) : path.join(path.resolve(rootDir), 'DLLPlugins')
  const specs = new Map()
  if (!fs.existsSync(baseDir)) {
    return specs
  }

  let entries = []
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true })
  } catch {
    return specs
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || IGNORED_DLL_PLUGINS_DIRS.has(entry.name)) {
      continue
    }
    const configPath = path.join(baseDir, entry.name, NATIVE_RELEASE_CONFIG_FILE)
    if (!fs.existsSync(configPath)) continue

    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('配置必须为 JSON 对象')
      }
      const id = typeof raw.id === 'string' ? raw.id.trim() : ''
      if (!TARGET_ID_PATTERN.test(id) || id !== entry.name) {
        throw new Error(`id（${id}）无效或与目录名（${entry.name}）不一致`)
      }
      const dllId = typeof raw.dllId === 'string' ? raw.dllId.trim() : ''
      if (!isSafeIdentifier(dllId, false)) {
        throw new Error(`dllId 无效: ${dllId}`)
      }
      const dllEntry = typeof raw.dllEntry === 'string' ? raw.dllEntry.trim() : ''
      if (!isSafeLibRelativePath(dllEntry) || !dllEntry.toLowerCase().endsWith('.dll')) {
        throw new Error(`dllEntry 必须为 lib/ 下的 .dll 路径: ${dllEntry}`)
      }
      if (typeof raw.requireAdmin !== 'boolean') {
        throw new Error('requireAdmin 必须为布尔值')
      }
      if (!Array.isArray(raw.functions) || raw.functions.length === 0) {
        throw new Error('functions 必须为非空字符串数组')
      }
      const functions = []
      const seenFns = new Set()
      for (const fn of raw.functions) {
        if (typeof fn !== 'string' || !isSafeIdentifier(fn, true) || seenFns.has(fn)) {
          throw new Error(`functions 包含非法或重复函数名: ${String(fn)}`)
        }
        seenFns.add(fn)
        functions.push(fn)
      }

      const normalizeList = (value, field) => {
        if (value === undefined) return []
        if (!Array.isArray(value)) throw new Error(`${field} 必须为数组`)
        return value.map((item) => {
          if (typeof item !== 'string' || !item.trim()) throw new Error(`${field} 包含空项或非字符串`)
          return item.trim()
        })
      }

      const commonLibs = normalizeList(raw.commonLibs, 'commonLibs')
      const signedCommonLibs = normalizeList(raw.signedCommonLibs, 'signedCommonLibs')
      if (signedCommonLibs.length > MAX_COMMON_LIBS_PER_MANIFEST) {
        throw new Error(`signedCommonLibs 超出上限 ${MAX_COMMON_LIBS_PER_MANIFEST}`)
      }
      if (raw.requireAdmin && signedCommonLibs.length > 0) {
        throw new Error('特权原生插件（requireAdmin=true）严禁声明 signedCommonLibs')
      }
      const seenSigned = new Set()
      for (const libId of signedCommonLibs) {
        if (!isSafeCommonLibId(libId) || seenSigned.has(libId)) {
          throw new Error(`signedCommonLibs 包含非法或重复工具 ID: ${libId}`)
        }
        seenSigned.add(libId)
      }

      const payloadEntries = normalizeList(raw.payloadEntries, 'payloadEntries')
      for (const rel of payloadEntries) {
        if (!isSafeLibRelativePath(rel) || !/\.(?:dll|exe)$/i.test(rel)) {
          throw new Error(`payloadEntries 路径不合法: ${rel}`)
        }
      }

      const assetEntries = normalizeList(raw.assetEntries, 'assetEntries')
      for (const rel of assetEntries) {
        if (!isSafeLibRelativePath(rel)) {
          throw new Error(`assetEntries 路径不合法: ${rel}`)
        }
      }

      const roleOverrides = {}
      if (raw.roleOverrides !== undefined) {
        if (!raw.roleOverrides || typeof raw.roleOverrides !== 'object' || Array.isArray(raw.roleOverrides)) {
          throw new Error('roleOverrides 必须为对象')
        }
        for (const [rel, role] of Object.entries(raw.roleOverrides)) {
          if (!isSafeLibRelativePath(rel) || !ALLOWED_NATIVE_ROLE_OVERRIDES.has(role)) {
            throw new Error(`roleOverrides 无效项: ${rel}=${String(role)}`)
          }
          roleOverrides[rel] = role
        }
      }

      const spec = Object.freeze({
        id,
        dllId,
        componentId: resolveNativeComponentId({ componentId: raw.componentId, dllId }),
        dllEntry,
        requireAdmin: raw.requireAdmin,
        functions: Object.freeze(functions),
        commonLibs: Object.freeze(commonLibs),
        signedCommonLibs: Object.freeze(signedCommonLibs),
        payloadEntries: Object.freeze(payloadEntries),
        assetEntries: Object.freeze(assetEntries),
        roleOverrides: Object.freeze(roleOverrides)
      })
      specs.set(id, spec)
    } catch (err) {
      warn(`⚠️ [dev-sync] 跳过无效原生插件配置 ${configPath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return specs
}

function collectNativeSourceEntries(dllOutputDir, spec) {
  const absOutputDir = path.resolve(dllOutputDir)
  if (!fs.existsSync(absOutputDir)) {
    return { ok: false, reason: `缺少编译产物目录: ${absOutputDir}` }
  }
  const realOutputDir = fs.realpathSync(absOutputDir)
  const seenLower = new Set()
  const entries = []

  const addEntry = (relPath, kind) => {
    const lower = relPath.toLowerCase()
    if (seenLower.has(lower)) {
      return { ok: false, reason: `原生文件存在重复或大小写冲突: ${relPath}` }
    }
    seenLower.add(lower)
    const srcPath = path.resolve(absOutputDir, ...relPath.split('/'))
    const stat = fs.lstatSync(srcPath, { throwIfNoEntry: false })
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      return { ok: false, reason: `缺少或非法原生文件（${kind}）: ${relPath}` }
    }
    const realFile = fs.realpathSync(srcPath)
    if (!isPathInsideDir(realOutputDir, realFile)) {
      return { ok: false, reason: `原生文件路径越界: ${relPath}` }
    }
    entries.push({ relPath, srcPath, kind, size: stat.size, mtimeMs: stat.mtimeMs })
    return { ok: true }
  }

  const mainCheck = addEntry(spec.dllEntry, 'main')
  if (!mainCheck.ok) return mainCheck
  for (const rel of spec.payloadEntries) {
    const check = addEntry(rel, 'payload')
    if (!check.ok) return check
  }
  for (const rel of spec.assetEntries) {
    const check = addEntry(rel, 'asset')
    if (!check.ok) return check
  }

  let builtAt
  const buildInfoPath = path.join(absOutputDir, 'build-info.json')
  if (fs.existsSync(buildInfoPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'))
      if (typeof parsed?.builtAt === 'string' && parsed.builtAt.trim()) {
        builtAt = parsed.builtAt.trim()
      }
    } catch {
      // 忽略畸形 build-info.json，签发时回落当前时间
    }
  }

  return { ok: true, entries, builtAt }
}

function inspectNativeEntriesForManifest(entries) {
  let dllSha256 = ''
  const payloadFiles = []

  for (const item of entries) {
    if (item.kind === 'main') {
      const pe = inspectPeFile(item.srcPath, { computeHash: true })
      if (!pe || pe.unsupportedPe || pe.arch !== 'x86' || !pe.isDll || pe.isClrManaged) {
        throw new Error(`主 DLL 必须为 Win32 x86 原生非托管 DLL: ${item.relPath}`)
      }
      dllSha256 = pe.sha256
    } else if (item.kind === 'payload') {
      const pe = inspectPeFile(item.srcPath, { computeHash: true })
      if (!pe || pe.unsupportedPe) {
        throw new Error(`伴生 payload 文件不是有效 PE: ${item.relPath}`)
      }
      const manifestArch = pe.arch === 'x86' ? 'ia32' : pe.arch === 'x64' ? 'x64' : null
      if (!manifestArch) {
        throw new Error(`伴生 payload PE 架构不受支持（${pe.arch}）: ${item.relPath}`)
      }
      payloadFiles.push({
        entry: item.relPath,
        format: 'pe',
        arch: manifestArch,
        sha256: pe.sha256
      })
    } else {
      const pe = inspectPeFile(item.srcPath, { computeHash: false })
      if (pe) {
        throw new Error(`非 PE 伴生资源 assetEntries 不可包含 PE 二进制: ${item.relPath}`)
      }
      payloadFiles.push({
        entry: item.relPath,
        format: 'data',
        sha256: computeFileSha256Sync(item.srcPath)
      })
    }
  }

  return { dllSha256, payloadFiles }
}

/**
 * 构造开发沙盒版原生插件 plugin.json（纯内存构造，绝不修改源码目录 plugins/<id>/plugin.json）：
 * - 完整保留原 sourceManifest 字段（含 draft / draftReason / i18n 等）；
 * - 覆写与正式原生包同构的 requireAdmin / dllloader / targets / nativeComponents / commonLibs / minAppVersion。
 */
export function buildDevNativePluginManifest(sourceManifest, spec, { dllSha256, payloadFiles }) {
  const packaged = structuredClone(sourceManifest)
  packaged.requireAdmin = Boolean(spec.requireAdmin)

  if (Array.isArray(spec.signedCommonLibs) && spec.signedCommonLibs.length > 0) {
    if (!packaged.minAppVersion || compareAppVersion('1.3.0.0', packaged.minAppVersion) > 0) {
      packaged.minAppVersion = '1.3.0.0'
    }
  }

  const mergedCommonLibs = []
  const seenCommonLibs = new Set()
  for (const rawLib of [
    ...(Array.isArray(packaged.commonLibs) ? packaged.commonLibs : []),
    ...(Array.isArray(spec.commonLibs) ? spec.commonLibs : [])
  ]) {
    if (typeof rawLib !== 'string' || !rawLib.trim()) continue
    const libId = rawLib.trim()
    const key = libId.toLowerCase()
    if (!seenCommonLibs.has(key)) {
      seenCommonLibs.add(key)
      mergedCommonLibs.push(libId)
    }
  }
  packaged.commonLibs = mergedCommonLibs

  packaged.targets = [{ ...WINDOWS_NATIVE_HOST_TARGET }]
  packaged.dllloader = spec.dllEntry
  packaged.nativeComponents = [
    {
      id: spec.componentId,
      kind: 'dll',
      targetId: WINDOWS_NATIVE_HOST_TARGET.id,
      arch: 'ia32',
      abi: NATIVE_HOST32_DLL_ABI,
      protocolVersion: 1,
      entry: spec.dllEntry,
      sha256: dllSha256,
      payloadFiles: payloadFiles.map((item) => ({ ...item }))
    }
  ]

  return packaged
}

function writeFileIfDifferent(filePath, content) {
  const nextBuf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath)
    if (!stat.isSymbolicLink() && stat.isFile() && stat.size === nextBuf.length) {
      const prevBuf = fs.readFileSync(filePath)
      if (prevBuf.equals(nextBuf)) return false
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, nextBuf)
  return true
}

/**
 * 将仓库 plugins/ 中的有效插件增量同步至 .ztools-dev/DataV2/Plugins/。
 * - 默认包含草稿插件，自动跳过无 plugin.json 目录（scripts/shared）与 revoked 下架占位插件；
 * - Windows 本地存在 DLLPlugins/<id>/native-release.json、已编译产物与可用私钥时，
 *   按正式发布包同构合入 lib/ 二进制与沙盒版 plugin.json，并签发真实 ECDSA P-256 native-trust.json/.sig；
 * - 开源仓无 DLLPlugins/ 或未配置私钥时优雅跳过原生合包，不影响纯声明式插件运行。
 */
export function syncDevPlugins({
  rootDir = DEFAULT_ROOT_DIR,
  sourcePluginsDir,
  destPluginsDir,
  dllPluginsDir,
  dllOutputsDir,
  devTrustRoot,
  includeDrafts = true,
  syncNativePlugins = true,
  pluginFilter = null,
  platform = process.platform,
  nativePrivateKeyPem,
  nativePrivilegedPrivateKeyPem,
  nativeKeyFilePath,
  env = process.env,
  log = console.log,
  warn = console.warn
} = {}) {
  const paths = resolveDevSandboxPaths(rootDir)
  const srcRoot = sourcePluginsDir ? path.resolve(sourcePluginsDir) : path.join(paths.rootDir, 'plugins')
  const dstRoot = destPluginsDir ? path.resolve(destPluginsDir) : paths.pluginsRoot
  const nativeBaseDir = dllPluginsDir ? path.resolve(dllPluginsDir) : path.join(paths.rootDir, 'DLLPlugins')
  const nativeOutputsRoot = dllOutputsDir ? path.resolve(dllOutputsDir) : path.join(nativeBaseDir, 'outputs')
  const trustRoot = devTrustRoot ? path.resolve(devTrustRoot) : paths.devTrustRoot

  if (!fs.existsSync(srcRoot)) {
    return {
      skipped: true,
      reason: 'plugins-dir-missing',
      totalPlugins: 0,
      copiedFiles: 0,
      unchangedPlugins: 0,
      updatedPlugins: 0,
      draftCount: 0,
      nativePlugins: [],
      updatedNativePlugins: [],
      cachedNativePlugins: [],
      skippedNativePlugins: [],
      skippedRevoked: [],
      skippedMissingEntry: []
    }
  }

  fs.mkdirSync(dstRoot, { recursive: true })
  const filterSet =
    Array.isArray(pluginFilter) && pluginFilter.length > 0
      ? new Set(pluginFilter.map((item) => String(item).trim().toLowerCase()).filter(Boolean))
      : null

  const nativeSpecs =
    syncNativePlugins && platform === 'win32'
      ? loadLocalNativePluginSpecs({ rootDir: paths.rootDir, dllPluginsDir: nativeBaseDir, warn })
      : new Map()

  const nativeCachePath = path.join(trustRoot, DEV_NATIVE_PLUGINS_CACHE_FILE)
  const prevNativeCache = readJsonOrNull(nativeCachePath) || {}
  const nextNativeCache = { ...prevNativeCache }
  let nativeCacheDirty = false

  // 按 requireAdmin 缓存私钥解析结果，避免每个插件重复读盘与重复输出同一条缺私钥提示
  const keyResolutionCache = new Map()
  const missingKeyWarned = new Set()
  const resolveNativeKeyForAdminMode = (requireAdmin) => {
    const modeKey = requireAdmin ? 'privileged' : 'normal'
    if (keyResolutionCache.has(modeKey)) {
      return keyResolutionCache.get(modeKey)
    }
    try {
      const material = resolvePrivateKeyMaterial({
        privateKeyPem: requireAdmin ? nativePrivilegedPrivateKeyPem : nativePrivateKeyPem,
        keyFilePath: nativeKeyFilePath,
        requireAdmin,
        env,
        rootDir: paths.rootDir
      })
      const resolved = {
        ok: true,
        ...material,
        publicKeyHex: extractP256RawPublicKeyHex(material.privateKeyPem)
      }
      keyResolutionCache.set(modeKey, resolved)
      return resolved
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      const failed = { ok: false, reason }
      keyResolutionCache.set(modeKey, failed)
      if (!missingKeyWarned.has(modeKey)) {
        missingKeyWarned.add(modeKey)
        warn(`⚠️ [dev-sync] 未检测到本地原生插件签名私钥（${modeKey}），已跳过原生 DLL 合包并保留纯声明式同步`)
      }
      return failed
    }
  }

  let totalPlugins = 0
  let copiedFiles = 0
  let updatedPlugins = 0
  let unchangedPlugins = 0
  let draftCount = 0
  const nativePlugins = []
  const updatedNativePlugins = []
  const cachedNativePlugins = []
  const skippedNativePlugins = []
  const skippedRevoked = []
  const skippedMissingEntry = []

  const entries = fs.readdirSync(srcRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue
    const pluginSrcDir = path.join(srcRoot, entry.name)
    const manifestPath = path.join(pluginSrcDir, 'plugin.json')
    if (!fs.existsSync(manifestPath)) continue

    let rawManifestText
    let manifest
    try {
      rawManifestText = fs.readFileSync(manifestPath, 'utf8')
      manifest = JSON.parse(rawManifestText)
    } catch {
      warn(`⚠️ [dev-sync] 跳过无法解析 plugin.json 的插件目录: ${entry.name}`)
      continue
    }

    const pluginId = typeof manifest?.id === 'string' && manifest.id.trim() ? manifest.id.trim() : entry.name
    if (!SAFE_SEGMENT_RE.test(pluginId)) continue
    if (manifest.revoked === true) {
      skippedRevoked.push(pluginId)
      continue
    }
    if (!includeDrafts && manifest.draft === true) {
      continue
    }
    if (filterSet && !filterSet.has(pluginId.toLowerCase())) {
      continue
    }

    const entryRel = typeof manifest.entry === 'string' && manifest.entry.trim()
      ? manifest.entry.trim().replace(/\\/g, '/')
      : 'dist/index.js'
    const entryAbs = path.join(pluginSrcDir, ...entryRel.split('/'))
    if (!fs.existsSync(entryAbs)) {
      skippedMissingEntry.push(pluginId)
      continue
    }

    totalPlugins += 1
    if (manifest.draft === true) draftCount += 1

    const pluginDstDir = path.join(dstRoot, pluginId)
    const files = collectRuntimePluginFiles(pluginSrcDir)
    const expectedRelSet = new Set(files.map((item) => item.relPath))

    const nativeSpec = nativeSpecs.get(pluginId) || null
    let nativePlan = null
    if (nativeSpec) {
      const keyResult = resolveNativeKeyForAdminMode(Boolean(nativeSpec.requireAdmin))
      if (!keyResult.ok) {
        skippedNativePlugins.push({ pluginId, reason: 'missing-private-key' })
      } else {
        const collected = collectNativeSourceEntries(path.join(nativeOutputsRoot, pluginId), nativeSpec)
        if (!collected.ok) {
          warn(`⚠️ [dev-sync] 跳过原生插件 ${pluginId} DLL 合包（${collected.reason}）`)
          skippedNativePlugins.push({ pluginId, reason: collected.reason })
        } else {
          nativePlan = { spec: nativeSpec, keyResult, collected }
        }
      }
    }

    let pluginChanged = false
    for (const file of files) {
      // 原生合包模式由沙盒清单构造器生成 plugin.json，避免先写源码版再覆盖引起无意义磁盘抖动
      if (nativePlan && file.relPath === 'plugin.json') continue
      const targetAbs = path.join(pluginDstDir, ...file.relPath.split('/'))
      if (copyFileIncremental(file.srcPath, targetAbs)) {
        copiedFiles += 1
        pluginChanged = true
      }
    }

    if (nativePlan) {
      const { spec, keyResult, collected } = nativePlan
      let nativeBinaryCopied = false
      for (const nativeFile of collected.entries) {
        expectedRelSet.add(nativeFile.relPath)
        const targetAbs = path.join(pluginDstDir, ...nativeFile.relPath.split('/'))
        if (copyFileIncremental(nativeFile.srcPath, targetAbs)) {
          copiedFiles += 1
          pluginChanged = true
          nativeBinaryCopied = true
        }
      }
      expectedRelSet.add(NATIVE_TRUST_MANIFEST_FILE)
      expectedRelSet.add(NATIVE_TRUST_SIGNATURE_FILE)
      pruneStalePluginFiles(pluginDstDir, expectedRelSet)

      const dstPluginJsonPath = path.join(pluginDstDir, 'plugin.json')
      const trustManifestPath = path.join(pluginDstDir, NATIVE_TRUST_MANIFEST_FILE)
      const trustSigPath = path.join(pluginDstDir, NATIVE_TRUST_SIGNATURE_FILE)

      const fingerprint = {
        sourceManifestSha256: computeStringSha256(rawManifestText),
        specSha256: computeStringSha256(JSON.stringify(spec)),
        keyId: keyResult.keyId,
        publicKeyHex: keyResult.publicKeyHex,
        builtAt: collected.builtAt || '',
        files: collected.entries
          .map((item) => ({ relPath: item.relPath, size: item.size, mtimeMs: Math.round(item.mtimeMs) }))
          .sort((a, b) => a.relPath.localeCompare(b.relPath))
      }
      const fingerprintSha256 = computeStringSha256(JSON.stringify(fingerprint))
      const prevEntry = prevNativeCache[pluginId]

      const trustFilesExist = fs.existsSync(trustManifestPath) && fs.existsSync(trustSigPath)
      const currentDstPluginJsonSha256 = fs.existsSync(dstPluginJsonPath)
        ? computeFileSha256Sync(dstPluginJsonPath)
        : ''
      const currentTrustManifestSha256 = trustFilesExist ? computeFileSha256Sync(trustManifestPath) : ''
      const currentTrustSigSha256 = trustFilesExist ? computeFileSha256Sync(trustSigPath) : ''
      const nativeCacheHit =
        !nativeBinaryCopied &&
        trustFilesExist &&
        prevEntry &&
        prevEntry.fingerprintSha256 === fingerprintSha256 &&
        prevEntry.dstPluginJsonSha256 === currentDstPluginJsonSha256 &&
        prevEntry.trustManifestSha256 === currentTrustManifestSha256 &&
        prevEntry.trustSigSha256 === currentTrustSigSha256

      if (nativeCacheHit) {
        nativePlugins.push(pluginId)
        cachedNativePlugins.push(pluginId)
      } else {
        try {
          const inspected = inspectNativeEntriesForManifest(collected.entries)
          const packagedManifest = buildDevNativePluginManifest(manifest, spec, inspected)
          const packagedText = `${JSON.stringify(packagedManifest, null, 2)}\n`
          if (writeFileIfDifferent(dstPluginJsonPath, packagedText)) {
            copiedFiles += 1
            pluginChanged = true
          }

          const signed = signPluginDirectory({
            pluginDir: pluginDstDir,
            pluginId,
            pluginVersion: packagedManifest.version,
            requireAdmin: Boolean(spec.requireAdmin),
            keyId: keyResult.keyId,
            mainEntries: [
              {
                path: spec.dllEntry,
                dllId: spec.dllId,
                functions: [...spec.functions]
              }
            ],
            commonLibs: [...spec.signedCommonLibs],
            roleOverrides: { ...spec.roleOverrides },
            privateKeyPem: keyResult.privateKeyPem,
            keyUsages: keyResult.keyUsages,
            issuedAt: collected.builtAt
          })
          pluginChanged = true
          nativePlugins.push(pluginId)
          updatedNativePlugins.push(pluginId)

          nextNativeCache[pluginId] = {
            fingerprintSha256,
            dstPluginJsonSha256: computeStringSha256(packagedText),
            trustManifestSha256: computeStringSha256(signed.manifestText),
            trustSigSha256: computeStringSha256(signed.signatureText),
            keyId: keyResult.keyId,
            signedAt: new Date().toISOString()
          }
          nativeCacheDirty = true
        } catch (err) {
          warn(
            `⚠️ [dev-sync] 原生插件 ${pluginId} 签名失败，已回退纯声明式同步: ${err instanceof Error ? err.message : String(err)}`
          )
          skippedNativePlugins.push({
            pluginId,
            reason: err instanceof Error ? err.message : String(err)
          })
          // 回退为源码 plugin.json 并清理半成品原生文件与签名
          const fallbackExpected = new Set(files.map((item) => item.relPath))
          if (copyFileIncremental(manifestPath, dstPluginJsonPath)) {
            copiedFiles += 1
            pluginChanged = true
          }
          pruneStalePluginFiles(pluginDstDir, fallbackExpected)
        }
      }
    } else {
      pruneStalePluginFiles(pluginDstDir, expectedRelSet)
    }

    if (pluginChanged) updatedPlugins += 1
    else unchangedPlugins += 1
  }

  if (nativeCacheDirty) {
    fs.mkdirSync(trustRoot, { recursive: true, mode: 0o700 })
    fs.writeFileSync(nativeCachePath, `${JSON.stringify(nextNativeCache, null, 2)}\n`, 'utf8')
  }

  const nativeSummary =
    nativePlugins.length > 0
      ? `，原生 DLL 签发 ${nativePlugins.length} 款（更新 ${updatedNativePlugins.length}，缓存 ${cachedNativePlugins.length}）`
      : ''
  log(
    `🔌 [dev-sync] 插件同步完成: 共 ${totalPlugins} 款（含草稿 ${draftCount} 款，更新 ${updatedPlugins} 款，跳过无变更 ${unchangedPlugins} 款，复制 ${copiedFiles} 个文件${nativeSummary}）`
  )

  return {
    skipped: false,
    totalPlugins,
    copiedFiles,
    updatedPlugins,
    unchangedPlugins,
    draftCount,
    nativePlugins,
    updatedNativePlugins,
    cachedNativePlugins,
    skippedNativePlugins,
    skippedRevoked,
    skippedMissingEntry
  }
}

/** 读取或生成仅限本地开发沙盒使用的 ECDSA P-256 临时密钥对（JWK 格式，绝不提交 Git） */
export function ensureDevCommonLibsKeyPair(devTrustRoot) {
  fs.mkdirSync(devTrustRoot, { recursive: true, mode: 0o700 })
  const keyPairPath = path.join(devTrustRoot, DEV_COMMONLIBS_KEYPAIR_FILE)
  const publicKeysPath = path.join(devTrustRoot, DEV_COMMONLIBS_PUBLIC_KEYS_FILE)

  let keyRecord = null
  if (fs.existsSync(keyPairPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(keyPairPath, 'utf8'))
      if (
        parsed?.keyId === DEV_COMMONLIBS_KEY_ID &&
        typeof parsed.publicKeyHex === 'string' &&
        /^[a-f0-9]{128}$/.test(parsed.publicKeyHex) &&
        parsed.privateJwk &&
        typeof parsed.privateJwk === 'object'
      ) {
        keyRecord = parsed
      }
    } catch {
      keyRecord = null
    }
  }

  if (!keyRecord) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const privateJwk = privateKey.export({ format: 'jwk' })
    const publicJwk = publicKey.export({ format: 'jwk' })
    const xBuf = Buffer.from(publicJwk.x, 'base64url')
    const yBuf = Buffer.from(publicJwk.y, 'base64url')
    const publicKeyHex = Buffer.concat([xBuf, yBuf]).toString('hex')
    keyRecord = {
      keyId: DEV_COMMONLIBS_KEY_ID,
      publicKeyHex,
      privateJwk
    }
    fs.writeFileSync(keyPairPath, `${JSON.stringify(keyRecord, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  const publicKeysDocument = [
    {
      keyId: keyRecord.keyId,
      publicKeyHex: keyRecord.publicKeyHex,
      usages: ['commonlibs']
    }
  ]
  const serializedPublicKeys = `${JSON.stringify(publicKeysDocument, null, 2)}\n`
  if (!fs.existsSync(publicKeysPath) || fs.readFileSync(publicKeysPath, 'utf8') !== serializedPublicKeys) {
    fs.writeFileSync(publicKeysPath, serializedPublicKeys, { encoding: 'utf8', mode: 0o600 })
  }

  const privateKeyObj = crypto.createPrivateKey({ key: keyRecord.privateJwk, format: 'jwk' })
  return {
    keyId: keyRecord.keyId,
    publicKeyHex: keyRecord.publicKeyHex,
    privateKey: privateKeyObj,
    publicKeysPath
  }
}

async function computeFileDigest(filePath) {
  const hash = crypto.createHash('sha256')
  let size = 0
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => {
      size += chunk.length
      hash.update(chunk)
    })
    stream.once('end', resolve)
    stream.once('error', reject)
  })
  return { size, sha256: hash.digest('hex') }
}

async function extractAndDigestZipArchive(zipPath, extractDir, executables, rootDir) {
  const archiveDigest = await computeFileDigest(zipPath)
  const yauzl = getYauzl(rootDir)
  const files = []
  const seenLower = new Set()

  fs.mkdirSync(extractDir, { recursive: true })

  await new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true }, (openErr, zipFile) => {
      if (openErr) {
        reject(new Error(`打开 CommonLibs 归档失败 ${zipPath}: ${openErr.message}`))
        return
      }
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        try {
          zipFile.close()
        } catch {
          // 忽略关闭异常
        }
        reject(err)
      }
      zipFile.on('error', fail)
      zipFile.on('end', () => {
        if (settled) return
        settled = true
        resolve()
      })
      zipFile.on('entry', (entry) => {
        if (settled) return
        try {
          if (isZipEntrySymlink(entry)) {
            fail(new Error(`CommonLibs 归档禁止包含符号链接: ${entry.fileName}`))
            return
          }
          const safe = isSafeRelativeZipPath(entry.fileName)
          if (!safe) {
            fail(new Error(`CommonLibs 归档包含非法路径: ${entry.fileName}`))
            return
          }
          if (safe.isDir) {
            zipFile.readEntry()
            return
          }
          const lower = safe.normalized.toLowerCase()
          if (seenLower.has(lower)) {
            fail(new Error(`CommonLibs 归档存在重复路径: ${safe.normalized}`))
            return
          }
          seenLower.add(lower)

          const targetAbs = path.resolve(extractDir, ...safe.normalized.split('/'))
          const relCheck = path.relative(extractDir, targetAbs)
          if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
            fail(new Error(`CommonLibs 解压目标越界: ${safe.normalized}`))
            return
          }
          fs.mkdirSync(path.dirname(targetAbs), { recursive: true })

          zipFile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr) {
              fail(new Error(`读取归档条目失败 ${safe.normalized}: ${streamErr.message}`))
              return
            }
            const hash = crypto.createHash('sha256')
            let fileSize = 0
            const writeStream = fs.createWriteStream(targetAbs, { flags: 'wx' })
            writeStream.on('error', (wErr) => {
              readStream.destroy()
              fail(wErr)
            })
            readStream.on('data', (chunk) => {
              fileSize += chunk.length
              hash.update(chunk)
              writeStream.write(chunk)
            })
            readStream.on('error', (rErr) => {
              writeStream.destroy()
              fail(rErr)
            })
            readStream.on('end', () => {
              writeStream.end(() => {
                files.push({
                  path: safe.normalized,
                  size: fileSize,
                  sha256: hash.digest('hex')
                })
                zipFile.readEntry()
              })
            })
          })
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)))
        }
      })
      zipFile.readEntry()
    })
  })

  files.sort((a, b) => a.path.localeCompare(b.path))
  const fileSet = new Set(files.map((item) => item.path))
  for (const execRel of executables) {
    if (!fileSet.has(execRel)) {
      throw new Error(`CommonLibs 归档缺少声明的可执行入口: ${execRel} (${zipPath})`)
    }
  }

  return {
    size: archiveDigest.size,
    archiveSha256: archiveDigest.sha256,
    files
  }
}

function signCatalogBytes(rawBytes, privateKey, keyId) {
  const payload = Buffer.concat([COMMONLIBS_CATALOG_DOMAIN_PREFIX, rawBytes])
  const sigBuf = crypto.sign('sha256', payload, {
    key: privateKey,
    dsaEncoding: 'ieee-p1363'
  })
  return `v1:${keyId}:${sigBuf.toString('hex')}\n`
}

function readJsonOrNull(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function replaceDirectorySafely(stagingDir, finalDir, parentRoot) {
  if (fs.existsSync(finalDir)) {
    const trashDir = path.join(parentRoot, `.trash-dev-${crypto.randomUUID()}`)
    fs.renameSync(finalDir, trashDir)
    try {
      fs.rmSync(trashDir, { recursive: true, force: true })
    } catch {
      // 忽略正在占用的旧垃圾目录
    }
  }
  fs.renameSync(stagingDir, finalDir)
}

/**
 * 将本地 DLLPlugins/CommonLibs 中的当前平台工具归档增量解压并按真实 ECDSA P-256 契约
 * 落盘到 .ztools-dev/DataV2/CommonLibs/<toolId>/，格式与线上 CommonLibsManager 100% 一致。
 */
export async function syncDevCommonLibs({
  rootDir = DEFAULT_ROOT_DIR,
  sourceCommonLibsDir,
  destCommonLibsDir,
  devTrustRoot,
  platform = process.platform,
  arch = process.arch,
  log = console.log,
  warn = console.warn
} = {}) {
  const paths = resolveDevSandboxPaths(rootDir)
  const srcRoot = sourceCommonLibsDir ? path.resolve(sourceCommonLibsDir) : findLocalCommonLibsSourceDir(paths.rootDir)
  const dstRoot = destCommonLibsDir ? path.resolve(destCommonLibsDir) : paths.commonLibsRoot
  const trustRoot = devTrustRoot ? path.resolve(devTrustRoot) : paths.devTrustRoot

  if (!srcRoot || !fs.existsSync(path.join(srcRoot, SOURCE_MANIFEST_FILE))) {
    return {
      skipped: true,
      reason: 'commonlibs-source-missing',
      publicKeysPath: null,
      syncedTools: [],
      cachedTools: []
    }
  }

  const platformArch = resolveHostCommonLibsPlatformArch(platform, arch)
  if (!platformArch) {
    return {
      skipped: true,
      reason: `unsupported-platform-${platform}`,
      publicKeysPath: null,
      syncedTools: [],
      cachedTools: []
    }
  }

  const sourceManifest = JSON.parse(fs.readFileSync(path.join(srcRoot, SOURCE_MANIFEST_FILE), 'utf8'))
  const rawTools = Array.isArray(sourceManifest?.tools) ? sourceManifest.tools : []
  const cdnBaseUrl = String(sourceManifest?.cdnBaseUrl || 'https://cdn.ztools.cn').replace(/\/+$/, '')
  const ossPrefix = String(sourceManifest?.ossPrefix || 'commonlibs-v2').replace(/^\/+|\/+$/g, '')

  const keyInfo = ensureDevCommonLibsKeyPair(trustRoot)
  fs.mkdirSync(dstRoot, { recursive: true })

  const cachePath = path.join(trustRoot, DEV_COMMONLIBS_CACHE_FILE)
  const prevCache = readJsonOrNull(cachePath) || {}
  const nextCache = { ...prevCache }

  const statePath = path.join(dstRoot, COMMONLIBS_STATE_FILE)
  const state = readJsonOrNull(statePath) || {
    schemaVersion: 1,
    highWaterVersions: {},
    tools: {}
  }
  if (!state.highWaterVersions || typeof state.highWaterVersions !== 'object') state.highWaterVersions = {}
  if (!state.tools || typeof state.tools !== 'object') state.tools = {}

  const syncedTools = []
  const cachedTools = []

  for (const rawTool of rawTools) {
    const pkgSpec = rawTool?.packages?.[platformArch]
    if (!pkgSpec) continue

    const toolName = String(rawTool.toolName || '').trim()
    const version = String(rawTool.version || '').trim()
    const toolId = String(rawTool.toolId || `${toolName}-${version}`).trim()
    const abiMajor = Number(rawTool.abiMajor)
    const executables = Array.isArray(pkgSpec.executables) ? pkgSpec.executables : []
    const archiveRel = String(pkgSpec.archivePath || '').trim()
    const archiveAbs = path.isAbsolute(archiveRel) ? path.resolve(archiveRel) : path.resolve(srcRoot, archiveRel)

    if (!fs.existsSync(archiveAbs)) {
      warn(`⚠️ [dev-sync] 跳过缺失归档的 CommonLibs 工具 ${toolId}: ${archiveAbs}`)
      continue
    }

    const zipStat = fs.statSync(archiveAbs)
    const finalDir = path.join(dstRoot, toolId)
    const trustJsonPath = path.join(finalDir, COMMONLIBS_TRUST_JSON_FILE)
    const trustSigPath = path.join(finalDir, COMMONLIBS_TRUST_SIG_FILE)
    const cacheEntry = prevCache[toolId]

    const allExecutablesExist = executables.every((rel) =>
      fs.existsSync(path.join(finalDir, ...String(rel).split('/')))
    )
    const isUpToDate =
      cacheEntry &&
      cacheEntry.archiveAbs === archiveAbs &&
      cacheEntry.size === zipStat.size &&
      Math.abs(cacheEntry.mtimeMs - zipStat.mtimeMs) < 2 &&
      cacheEntry.keyId === keyInfo.keyId &&
      cacheEntry.publicKeyHex === keyInfo.publicKeyHex &&
      fs.existsSync(trustJsonPath) &&
      fs.existsSync(trustSigPath) &&
      allExecutablesExist

    if (isUpToDate) {
      cachedTools.push(toolId)
      continue
    }

    const stagingParent = path.join(dstRoot, `.staging-dev-${toolId}-${crypto.randomUUID()}`)
    const payloadDir = path.join(stagingParent, 'payload')
    try {
      const inspected = await extractAndDigestZipArchive(archiveAbs, payloadDir, executables, paths.rootDir)
      if (platform !== 'win32') {
        for (const execRel of executables) {
          fs.chmodSync(path.join(payloadDir, ...execRel.split('/')), 0o755)
        }
      }

      const fileName = `${toolName}-${version}-${platformArch}.zip`
      const url = `${cdnBaseUrl}/${ossPrefix}/archives/${toolName}/${fileName}`
      const catalog = {
        schemaVersion: 1,
        catalogType: rawTool.catalogType === 'commercial' ? 'commercial' : 'public',
        keyId: keyInfo.keyId,
        generatedAt: new Date().toISOString(),
        tools: [
          {
            toolId,
            toolName,
            version,
            abiMajor,
            ...(typeof rawTool.minClientVersion === 'string' ? { minClientVersion: rawTool.minClientVersion } : {}),
            packages: {
              [platformArch]: {
                url,
                size: inspected.size,
                archiveSha256: inspected.archiveSha256,
                executables: [...executables],
                files: inspected.files
              }
            }
          }
        ],
        revocations: {
          schemaVersion: 1,
          revokedKeyIds: [],
          revokedToolIds: [],
          revokedArchiveSha256: [],
          revokedFileSha256: [],
          minToolVersions: {}
        }
      }

      const rawBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
      const signatureText = signCatalogBytes(rawBytes, keyInfo.privateKey, keyInfo.keyId)

      fs.writeFileSync(path.join(payloadDir, COMMONLIBS_TRUST_JSON_FILE), rawBytes)
      fs.writeFileSync(path.join(payloadDir, COMMONLIBS_TRUST_SIG_FILE), signatureText, 'utf8')

      replaceDirectorySafely(payloadDir, finalDir, dstRoot)
      fs.rmSync(stagingParent, { recursive: true, force: true })

      const installedBytes = inspected.files.reduce((sum, item) => sum + item.size, 0)
      state.highWaterVersions[toolName] = version
      state.tools[toolId] = {
        toolName,
        version,
        platformArch,
        sizeBytes: installedBytes,
        installedAt: new Date().toISOString()
      }
      nextCache[toolId] = {
        archiveAbs,
        size: zipStat.size,
        mtimeMs: zipStat.mtimeMs,
        keyId: keyInfo.keyId,
        publicKeyHex: keyInfo.publicKeyHex
      }
      syncedTools.push(toolId)
    } catch (err) {
      fs.rmSync(stagingParent, { recursive: true, force: true })
      throw err
    }
  }

  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.writeFileSync(cachePath, `${JSON.stringify(nextCache, null, 2)}\n`, 'utf8')

  log(
    `🧰 [dev-sync] CommonLibs 同步完成: 解压更新 ${syncedTools.length} 个（${syncedTools.join(', ') || '无'}），命中缓存 ${cachedTools.length} 个`
  )

  return {
    skipped: false,
    publicKeysPath: keyInfo.publicKeysPath,
    syncedTools,
    cachedTools
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * 安全重置 .ztools-dev/ 开发测试沙盒：
 * 若检测到 runtime.lock 持有存活进程，立即拒绝删除以防数据损坏或占锁残留。
 */
export function resetDevSandbox({ rootDir = DEFAULT_ROOT_DIR, log = console.log } = {}) {
  const paths = resolveDevSandboxPaths(rootDir)
  if (!fs.existsSync(paths.sandboxRoot)) {
    log('🧹 [dev-reset] .ztools-dev/ 目录不存在，无需清理')
    return { removed: false, sandboxRoot: paths.sandboxRoot }
  }

  const lock = readJsonOrNull(paths.runtimeLockPath)
  if (lock && isProcessAlive(lock.pid)) {
    throw new Error(
      `无法重置 .ztools-dev/：检测到开发测试版 ZTools 进程仍在运行 (PID=${lock.pid})，请先关闭后再执行 npm run dev:reset`
    )
  }

  fs.rmSync(paths.sandboxRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
  log(`🧹 [dev-reset] 已清空开发测试沙盒: ${paths.sandboxRoot}`)
  return { removed: true, sandboxRoot: paths.sandboxRoot }
}

/** 一键同步插件（含可选本地原生 DLL 签发）与 CommonLibs 工具池到 .ztools-dev/DataV2/ */
export async function syncDevSandbox({
  rootDir = DEFAULT_ROOT_DIR,
  includeDrafts = true,
  syncPlugins = true,
  syncNativePlugins = true,
  syncCommonLibs = true,
  pluginFilter = null,
  platform = process.platform,
  arch = process.arch,
  log = console.log,
  warn = console.warn
} = {}) {
  const paths = resolveDevSandboxPaths(rootDir)
  fs.mkdirSync(paths.dataRoot, { recursive: true })

  const pluginsResult = syncPlugins
    ? syncDevPlugins({
        rootDir: paths.rootDir,
        includeDrafts,
        syncNativePlugins,
        pluginFilter,
        platform,
        log,
        warn
      })
    : { skipped: true, reason: 'disabled-by-flag' }

  const commonLibsResult = syncCommonLibs
    ? await syncDevCommonLibs({ rootDir: paths.rootDir, platform, arch, log, warn })
    : { skipped: true, reason: 'disabled-by-flag', publicKeysPath: null }

  return {
    paths,
    plugins: pluginsResult,
    commonLibs: commonLibsResult
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase()

if (isMainModule) {
  const args = process.argv.slice(2)
  const isReset = args.includes('--reset')
  const includeDrafts = !args.includes('--dev-exclude-drafts')
  const syncPlugins = !args.includes('--no-dev-plugins')
  const syncNativePlugins = !args.includes('--no-dev-native-plugins')
  const syncCommonLibs = !args.includes('--no-dev-commonlibs')
  const filterArg = args.find((a) => a.startsWith('--dev-plugin-filter='))
  const pluginFilter = filterArg
    ? filterArg.slice('--dev-plugin-filter='.length).split(',').map((s) => s.trim()).filter(Boolean)
    : null

  try {
    if (isReset) {
      resetDevSandbox()
    } else {
      await syncDevSandbox({ includeDrafts, syncPlugins, syncNativePlugins, syncCommonLibs, pluginFilter })
    }
  } catch (err) {
    console.error(`❌ [dev-sync] ${err.message}`)
    process.exit(1)
  }
}
