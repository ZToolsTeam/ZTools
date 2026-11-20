#!/usr/bin/env node

/**
 * check-i18n.mjs
 * 校验各模块 locales/ 目录下的多语言字典文件（默认以 zh-CN.json 为基准）：
 *   1. UTF-8 无 BOM 且为合法 JSON 对象
 *   2. 递归扁平化后的 Key 集合 100% 一致（无缺失、无多余）
 *   3. 插值占位符（如 {name}、{count}）100% 一致
 *   4. 不允许空字符串或纯空白译文
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(__dirname, '..')

export const DEFAULT_LOCALE_DIRS = Object.freeze([
  'frontend/src/locales',
  'frontend/src/commercial/locales',
  'electron-client/src/main/i18n/locales',
  'official-website/locales'
])

export const DEFAULT_BASE_LOCALE = 'zh-CN'

const PLACEHOLDER_REGEX = /\{([a-zA-Z0-9_.-]+)\}/g

/**
 * 判断 Buffer 是否包含 UTF-8 BOM (EF BB BF)
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function hasUtf8Bom(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
}

/**
 * 提取译文中的插值占位符名称集合（升序排列，去重；忽略 {{ / }} 转义）
 * @param {string} text
 * @returns {string[]}
 */
export function extractPlaceholders(text) {
  if (typeof text !== 'string') return []
  const stripped = text.replace(/\{\{|\}\}/g, '')
  const found = new Set()
  for (const match of stripped.matchAll(PLACEHOLDER_REGEX)) {
    found.add(match[1])
  }
  return [...found].sort()
}

/**
 * 递归扁平化嵌套的语言字典对象；非字符串/非普通对象的叶子节点会记录到 invalidNodes 中。
 * @param {unknown} obj
 * @param {string} [prefix]
 * @returns {{ entries: Map<string, string>, invalidNodes: string[] }}
 */
export function flattenMessages(obj, prefix = '') {
  const entries = new Map()
  const invalidNodes = []

  function walk(node, currentPrefix) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      invalidNodes.push(currentPrefix || '<root>')
      return
    }
    for (const [key, value] of Object.entries(node)) {
      const fullKey = currentPrefix ? `${currentPrefix}.${key}` : key
      if (typeof value === 'string') {
        entries.set(fullKey, value)
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        const subKeys = Object.keys(value)
        if (subKeys.length === 0) {
          invalidNodes.push(fullKey)
        } else {
          walk(value, fullKey)
        }
      } else {
        invalidNodes.push(fullKey)
      }
    }
  }

  walk(obj, prefix)
  return { entries, invalidNodes }
}

/**
 * 读取并校验单个 locale JSON 文件（UTF-8 无 BOM + 合法 JSON 对象 + 扁平化）
 * @param {string} filePath
 * @returns {{ ok: boolean, entries: Map<string, string>, errors: Array<{ code: string, file: string, key?: string, message: string }> }}
 */
export function loadLocaleFile(filePath) {
  const errors = []
  let buf
  try {
    buf = fs.readFileSync(filePath)
  } catch (err) {
    return {
      ok: false,
      entries: new Map(),
      errors: [{ code: 'READ_ERROR', file: filePath, message: `无法读取文件: ${err.message}` }]
    }
  }

  if (hasUtf8Bom(buf)) {
    errors.push({ code: 'UTF8_BOM', file: filePath, message: '文件包含 UTF-8 BOM，必须保存为 UTF-8 无 BOM' })
  }

  const rawText = hasUtf8Bom(buf) ? buf.subarray(3).toString('utf8') : buf.toString('utf8')
  let parsed
  try {
    parsed = JSON.parse(rawText)
  } catch (err) {
    errors.push({ code: 'INVALID_JSON', file: filePath, message: `JSON 解析失败: ${err.message}` })
    return { ok: false, entries: new Map(), errors }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push({ code: 'INVALID_ROOT', file: filePath, message: '根节点必须为 JSON 对象' })
    return { ok: false, entries: new Map(), errors }
  }

  const { entries, invalidNodes } = flattenMessages(parsed)
  for (const nodePath of invalidNodes) {
    errors.push({
      code: 'INVALID_VALUE_TYPE',
      file: filePath,
      key: nodePath,
      message: `键 "${nodePath}" 的值必须为字符串或非空嵌套对象`
    })
  }

  for (const [key, value] of entries) {
    if (value.trim().length === 0) {
      errors.push({
        code: 'EMPTY_VALUE',
        file: filePath,
        key,
        message: `键 "${key}" 不允许为空字符串或纯空白译文`
      })
    }
  }

  return { ok: errors.length === 0, entries, errors }
}

/**
 * 校验单个 locales 目录：对比 baseLocale（默认 zh-CN）与目录内其他 *.json 语言文件
 * @param {string} dirPath
 * @param {{ baseLocale?: string }} [options]
 */
export function checkLocaleDirectory(dirPath, { baseLocale = DEFAULT_BASE_LOCALE } = {}) {
  const resolvedDir = path.resolve(dirPath)
  const errors = []

  if (!fs.existsSync(resolvedDir)) {
    return { dir: resolvedDir, skipped: true, ok: true, locales: [], keyCount: 0, errors }
  }

  const jsonFiles = fs
    .readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()

  if (jsonFiles.length === 0) {
    return { dir: resolvedDir, skipped: true, ok: true, locales: [], keyCount: 0, errors }
  }

  const baseFileName = `${baseLocale}.json`
  const baseFilePath = path.join(resolvedDir, baseFileName)
  if (!jsonFiles.includes(baseFileName)) {
    errors.push({
      code: 'MISSING_BASE_LOCALE',
      file: baseFilePath,
      message: `目录 ${resolvedDir} 缺少基准语言文件 ${baseFileName}`
    })
    return { dir: resolvedDir, skipped: false, ok: false, locales: jsonFiles, keyCount: 0, errors }
  }

  const baseResult = loadLocaleFile(baseFilePath)
  errors.push(...baseResult.errors)
  const baseEntries = baseResult.entries

  for (const fileName of jsonFiles) {
    if (fileName === baseFileName) continue
    const targetPath = path.join(resolvedDir, fileName)
    const targetResult = loadLocaleFile(targetPath)
    errors.push(...targetResult.errors)

    // JSON 解析失败时跳过 Key 对比，避免产生噪音
    if (targetResult.errors.some((e) => e.code === 'INVALID_JSON' || e.code === 'INVALID_ROOT' || e.code === 'READ_ERROR')) {
      continue
    }

    const targetEntries = targetResult.entries

    for (const [key, baseValue] of baseEntries) {
      if (!targetEntries.has(key)) {
        errors.push({
          code: 'MISSING_KEY',
          file: targetPath,
          key,
          message: `缺少键 "${key}"（基准文件 ${baseFileName} 中存在）`
        })
        continue
      }
      const targetValue = targetEntries.get(key)
      const baseVars = extractPlaceholders(baseValue)
      const targetVars = extractPlaceholders(targetValue)
      if (baseVars.length !== targetVars.length || baseVars.some((v, idx) => v !== targetVars[idx])) {
        errors.push({
          code: 'PLACEHOLDER_MISMATCH',
          file: targetPath,
          key,
          message: `键 "${key}" 插值占位符不一致：基准 [${baseVars.join(', ')}]，当前 [${targetVars.join(', ')}]`
        })
      }
    }

    for (const key of targetEntries.keys()) {
      if (!baseEntries.has(key)) {
        errors.push({
          code: 'EXTRA_KEY',
          file: targetPath,
          key,
          message: `存在多余键 "${key}"（基准文件 ${baseFileName} 中不存在）`
        })
      }
    }
  }

  return {
    dir: resolvedDir,
    skipped: false,
    ok: errors.length === 0,
    locales: jsonFiles.map((f) => f.replace(/\.json$/, '')),
    keyCount: baseEntries.size,
    errors
  }
}

/**
 * 批量校验多个 locales 目录
 * @param {{ rootDir?: string, dirs?: readonly string[], baseLocale?: string }} [options]
 */
export function checkAllLocaleDirectories({
  rootDir = ROOT_DIR,
  dirs = DEFAULT_LOCALE_DIRS,
  baseLocale = DEFAULT_BASE_LOCALE
} = {}) {
  const results = dirs.map((relOrAbs) => {
    const target = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(rootDir, relOrAbs)
    return checkLocaleDirectory(target, { baseLocale })
  })
  const errors = results.flatMap((r) => r.errors)
  return {
    ok: errors.length === 0,
    results,
    errors
  }
}

function parseCliArgs(argv) {
  const dirs = []
  let baseLocale = DEFAULT_BASE_LOCALE
  let jsonOutput = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dir' && argv[i + 1]) {
      dirs.push(argv[++i])
    } else if (arg === '--base' && argv[i + 1]) {
      baseLocale = argv[++i]
    } else if (arg === '--json') {
      jsonOutput = true
    } else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/check-i18n.mjs [--dir <locales目录>]... [--base zh-CN] [--json]')
      process.exit(0)
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }
  return { dirs: dirs.length > 0 ? dirs : DEFAULT_LOCALE_DIRS, baseLocale, jsonOutput }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()

if (isMainModule) {
  try {
    const { dirs, baseLocale, jsonOutput } = parseCliArgs(process.argv.slice(2))
    const report = checkAllLocaleDirectories({ rootDir: ROOT_DIR, dirs, baseLocale })
    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      const checked = report.results.filter((r) => !r.skipped)
      if (report.ok) {
        console.log(`✅ [check-i18n] 校验通过：已检查 ${checked.length} 个目录（跳过 ${report.results.length - checked.length} 个未创建/空目录），0 个错误。`)
      } else {
        console.error(`❌ [check-i18n] 发现 ${report.errors.length} 个国际化字典错误：`)
        for (const err of report.errors) {
          console.error(`  - [${err.code}] ${path.relative(ROOT_DIR, err.file)}: ${err.message}`)
        }
      }
    }
    process.exit(report.ok ? 0 : 1)
  } catch (err) {
    console.error(`❌ [check-i18n] ${err.message}`)
    process.exit(1)
  }
}
