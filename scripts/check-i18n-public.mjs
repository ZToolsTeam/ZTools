#!/usr/bin/env node

/**
 * check-i18n-public.mjs
 * 公开仓与插件仓库共用的多语言基础校验库（不含任何内部路径或私有模块引用）：
 *   1. JSON 词典文件校验（UTF-8 无 BOM、Key 一致性、占位符一致、无空译文）
 *   2. 声明式插件单插件/批量多语言校验（plugin.json、src/i18n.ts、en-US 禁中文、复数宏、截图存在性）
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectDeclaredScreenshots } from '../packages/ztools-plugins-spec/src/screenshots.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PUBLIC_ROOT_DIR = path.resolve(__dirname, '..')
export const DEFAULT_BASE_LOCALE = 'zh-CN'
export const DEFAULT_REQUIRED_PLUGIN_LOCALES = Object.freeze(['zh-CN', 'en-US'])

const PLACEHOLDER_REGEX = /\{([a-zA-Z0-9_.-]+)\}/g
const CJK_REGEX = /[\u4e00-\u9fa5]/

/** 判断 Buffer 是否包含 UTF-8 BOM (EF BB BF) */
export function hasUtf8Bom(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
}

/** 提取译文中的插值占位符名称集合（升序去重，忽略 {{ / }} 转义） */
export function extractPlaceholders(text) {
  if (typeof text !== 'string') return []
  const stripped = text.replace(/\{\{|\}\}/g, '')
  const found = new Set()
  for (const match of stripped.matchAll(PLACEHOLDER_REGEX)) {
    found.add(match[1])
  }
  return [...found].sort()
}

/** 递归扁平化嵌套语言字典对象 */
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

/** 读取并校验单个 locale JSON 文件 */
export function loadLocaleFile(filePath) {
  const errors = []
  let buf
  try {
    buf = fs.readFileSync(filePath)
  } catch (err) {
    return {
      ok: false,
      entries: new Map(),
      errors: [{ code: 'READ_ERROR', file: filePath, message: `Unable to read file: ${err.message}` }]
    }
  }

  if (hasUtf8Bom(buf)) {
    errors.push({ code: 'UTF8_BOM', file: filePath, message: 'File contains UTF-8 BOM; save as UTF-8 without BOM' })
  }

  const rawText = hasUtf8Bom(buf) ? buf.subarray(3).toString('utf8') : buf.toString('utf8')
  let parsed
  try {
    parsed = JSON.parse(rawText)
  } catch (err) {
    errors.push({ code: 'INVALID_JSON', file: filePath, message: `JSON parse failed: ${err.message}` })
    return { ok: false, entries: new Map(), errors }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push({ code: 'INVALID_ROOT', file: filePath, message: 'Root must be a JSON object' })
    return { ok: false, entries: new Map(), errors }
  }

  const { entries, invalidNodes } = flattenMessages(parsed)
  for (const nodePath of invalidNodes) {
    errors.push({
      code: 'INVALID_VALUE_TYPE',
      file: filePath,
      key: nodePath,
      message: `Key "${nodePath}" must be a string or non-empty nested object`
    })
  }

  for (const [key, value] of entries) {
    if (value.trim().length === 0) {
      errors.push({
        code: 'EMPTY_VALUE',
        file: filePath,
        key,
        message: `Key "${key}" must not be empty or whitespace-only`
      })
    }
  }

  return { ok: errors.length === 0, entries, errors }
}

/** 校验单个 locales 目录（默认不存在或为空即报错，不再静默跳过） */
export function checkLocaleDirectory(
  dirPath,
  { baseLocale = DEFAULT_BASE_LOCALE, allowMissing = false } = {}
) {
  const resolvedDir = path.resolve(dirPath)
  const errors = []

  if (!fs.existsSync(resolvedDir)) {
    if (allowMissing) {
      return { dir: resolvedDir, skipped: true, ok: true, locales: [], keyCount: 0, errors }
    }
    errors.push({
      code: 'LOCALE_DIR_MISSING',
      file: resolvedDir,
      message: `Locale directory does not exist: ${resolvedDir}`
    })
    return { dir: resolvedDir, skipped: false, ok: false, locales: [], keyCount: 0, errors }
  }

  const jsonFiles = fs
    .readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()

  if (jsonFiles.length === 0) {
    if (allowMissing) {
      return { dir: resolvedDir, skipped: true, ok: true, locales: [], keyCount: 0, errors }
    }
    errors.push({
      code: 'LOCALE_DIR_EMPTY',
      file: resolvedDir,
      message: `Locale directory contains no *.json files: ${resolvedDir}`
    })
    return { dir: resolvedDir, skipped: false, ok: false, locales: [], keyCount: 0, errors }
  }

  const baseFileName = `${baseLocale}.json`
  const baseFilePath = path.join(resolvedDir, baseFileName)
  if (!jsonFiles.includes(baseFileName)) {
    errors.push({
      code: 'MISSING_BASE_LOCALE',
      file: baseFilePath,
      message: `Directory ${resolvedDir} is missing base locale file ${baseFileName}`
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
          message: `Missing key "${key}" (present in ${baseFileName})`
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
          message: `Placeholder mismatch for "${key}": base [${baseVars.join(', ')}], target [${targetVars.join(', ')}]`
        })
      }
    }

    for (const key of targetEntries.keys()) {
      if (!baseEntries.has(key)) {
        errors.push({
          code: 'EXTRA_KEY',
          file: targetPath,
          key,
          message: `Extra key "${key}" (not present in ${baseFileName})`
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

function decodeJsEscape(src, escIndex) {
  const next = src[escIndex + 1]
  if (next === undefined) return { char: '\\', nextIndex: escIndex + 1 }
  switch (next) {
    case 'n': return { char: '\n', nextIndex: escIndex + 2 }
    case 'r': return { char: '\r', nextIndex: escIndex + 2 }
    case 't': return { char: '\t', nextIndex: escIndex + 2 }
    case 'b': return { char: '\b', nextIndex: escIndex + 2 }
    case 'f': return { char: '\f', nextIndex: escIndex + 2 }
    case 'v': return { char: '\v', nextIndex: escIndex + 2 }
    case '0': return { char: '\0', nextIndex: escIndex + 2 }
    case '\\': return { char: '\\', nextIndex: escIndex + 2 }
    case "'": return { char: "'", nextIndex: escIndex + 2 }
    case '"': return { char: '"', nextIndex: escIndex + 2 }
    case '`': return { char: '`', nextIndex: escIndex + 2 }
    case '\n': return { char: '', nextIndex: escIndex + 2 }
    case '\r': return { char: '', nextIndex: src[escIndex + 2] === '\n' ? escIndex + 3 : escIndex + 2 }
    case 'x': {
      const hex = src.slice(escIndex + 2, escIndex + 4)
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        return { char: String.fromCharCode(Number.parseInt(hex, 16)), nextIndex: escIndex + 4 }
      }
      return { char: 'x', nextIndex: escIndex + 2 }
    }
    case 'u': {
      if (src[escIndex + 2] === '{') {
        const endBrace = src.indexOf('}', escIndex + 3)
        if (endBrace > escIndex + 3) {
          const hex = src.slice(escIndex + 3, endBrace)
          if (/^[0-9a-fA-F]+$/.test(hex)) {
            return { char: String.fromCodePoint(Number.parseInt(hex, 16)), nextIndex: endBrace + 1 }
          }
        }
      } else {
        const hex = src.slice(escIndex + 2, escIndex + 6)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { char: String.fromCharCode(Number.parseInt(hex, 16)), nextIndex: escIndex + 6 }
        }
      }
      return { char: 'u', nextIndex: escIndex + 2 }
    }
    default:
      return { char: next, nextIndex: escIndex + 2 }
  }
}

function tokenizePluginI18nSource(source) {
  const tokens = []
  let i = 0
  const len = source.length

  while (i < len) {
    const ch = source[i]
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\uFEFF') {
      i += 1
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      i += 2
      while (i < len && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) return { ok: false, tokens, error: 'Unterminated block comment' }
      i = end + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      i += 1
      let val = ''
      let closed = false
      while (i < len) {
        const c = source[i]
        if (c === '\\') {
          const decoded = decodeJsEscape(source, i)
          val += decoded.char
          i = decoded.nextIndex
          continue
        }
        if (c === quote) {
          closed = true
          i += 1
          break
        }
        val += c
        i += 1
      }
      if (!closed) return { ok: false, tokens, error: 'Unterminated string literal' }
      tokens.push({ type: 'string', value: val })
      continue
    }
    if (ch === '`') {
      i += 1
      let val = ''
      let closed = false
      let dynamic = false
      while (i < len) {
        const c = source[i]
        if (c === '\\') {
          const decoded = decodeJsEscape(source, i)
          val += decoded.char
          i = decoded.nextIndex
          continue
        }
        if (c === '$' && source[i + 1] === '{') dynamic = true
        if (c === '`') {
          closed = true
          i += 1
          break
        }
        val += c
        i += 1
      }
      if (!closed) return { ok: false, tokens, error: 'Unterminated template literal' }
      tokens.push({ type: dynamic ? 'dynamic-template' : 'string', value: val })
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1
      while (end < len && /[A-Za-z0-9_$]/.test(source[end])) end += 1
      tokens.push({ type: 'ident', value: source.slice(i, end) })
      i = end
      continue
    }
    if (/[0-9]/.test(ch)) {
      let end = i + 1
      while (end < len && /[0-9a-zA-Z._]/.test(source[end])) end += 1
      tokens.push({ type: 'number', value: source.slice(i, end) })
      i = end
      continue
    }
    if ('{}:,[]()=+;<>|&?.-'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch })
      i += 1
      continue
    }
    tokens.push({ type: 'other', value: ch })
    i += 1
  }

  return { ok: true, tokens }
}

function skipExpressionUntilDelimiter(tokens, startIndex) {
  let i = startIndex
  let depthParen = 0
  let depthBracket = 0
  let depthBrace = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (t.type === 'punct') {
      if (t.value === '(') depthParen += 1
      else if (t.value === ')' && depthParen > 0) depthParen -= 1
      else if (t.value === '[') depthBracket += 1
      else if (t.value === ']' && depthBracket > 0) depthBracket -= 1
      else if (t.value === '{') depthBrace += 1
      else if (t.value === '}') {
        if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) break
        if (depthBrace > 0) depthBrace -= 1
      } else if (t.value === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
        break
      }
    }
    i += 1
  }
  return i
}

function parseStaticObjectLiteral(tokens, startIndex, prefix = '') {
  if (!tokens[startIndex] || tokens[startIndex].type !== 'punct' || tokens[startIndex].value !== '{') {
    return { ok: false, duplicateKeys: [], error: 'Expected "{"' }
  }

  const obj = Object.create(null)
  const duplicateKeys = []
  let i = startIndex + 1

  while (i < tokens.length) {
    const cur = tokens[i]
    if (cur.type === 'punct' && cur.value === '}') {
      return { ok: true, value: obj, endIndex: i, duplicateKeys }
    }

    let key
    if (cur.type === 'string' || cur.type === 'ident' || cur.type === 'number') {
      key = cur.value
      i += 1
    } else {
      return { ok: false, duplicateKeys, error: `Unexpected token "${cur.value}" at key position` }
    }

    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return { ok: false, duplicateKeys, error: `Forbidden prototype key "${key}"` }
    }

    if (!tokens[i] || tokens[i].type !== 'punct' || tokens[i].value !== ':') {
      return { ok: false, duplicateKeys, error: `Missing ":" after key "${key}"` }
    }
    i += 1

    const fullPath = prefix ? `${prefix}.${key}` : key
    if (Object.hasOwn(obj, key)) {
      duplicateKeys.push(fullPath)
    }

    const valToken = tokens[i]
    if (!valToken) {
      return { ok: false, duplicateKeys, error: `Missing value for key "${fullPath}"` }
    }

    if (valToken.type === 'punct' && valToken.value === '{') {
      const nested = parseStaticObjectLiteral(tokens, i, fullPath)
      if (!nested.ok) return nested
      duplicateKeys.push(...nested.duplicateKeys)
      obj[key] = nested.value
      i = nested.endIndex + 1
    } else if (valToken.type === 'string') {
      let combined = valToken.value
      i += 1
      while (
        tokens[i]?.type === 'punct' &&
        tokens[i].value === '+' &&
        tokens[i + 1]?.type === 'string'
      ) {
        combined += tokens[i + 1].value
        i += 2
      }
      if (tokens[i]?.type === 'punct' && tokens[i].value === '+') {
        obj[key] = null
        i = skipExpressionUntilDelimiter(tokens, i)
      } else {
        obj[key] = combined
      }
    } else {
      obj[key] = null
      i = skipExpressionUntilDelimiter(tokens, i)
    }

    if (tokens[i]?.type === 'ident' && tokens[i].value === 'as') {
      i = skipExpressionUntilDelimiter(tokens, i)
    }

    if (tokens[i]?.type === 'punct' && tokens[i].value === ',') {
      i += 1
      continue
    }
    if (tokens[i]?.type === 'punct' && tokens[i].value === '}') {
      return { ok: true, value: obj, endIndex: i, duplicateKeys }
    }
    return {
      ok: false,
      duplicateKeys,
      error: `Expected "," or "}" after key "${fullPath}"`
    }
  }

  return { ok: false, duplicateKeys, error: 'Unterminated object literal' }
}

function skipTypeArguments(tokens, startIndex) {
  if (tokens[startIndex]?.type !== 'punct' || tokens[startIndex].value !== '<') return startIndex
  let depth = 0
  let i = startIndex
  while (i < tokens.length) {
    if (tokens[i].type === 'punct' && tokens[i].value === '<') depth += 1
    else if (tokens[i].type === 'punct' && tokens[i].value === '>') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return startIndex
}

function findVariableObjectInitializer(tokens, varName, beforeIndex) {
  for (let i = 0; i < beforeIndex; i += 1) {
    const t = tokens[i]
    if (t.type !== 'ident' || !['const', 'let', 'var'].includes(t.value)) continue
    if (tokens[i + 1]?.type !== 'ident' || tokens[i + 1].value !== varName) continue

    let j = i + 2
    let depthAngle = 0
    let depthBrace = 0
    let depthParen = 0
    let depthBracket = 0
    while (j < beforeIndex) {
      const cur = tokens[j]
      if (cur.type === 'punct') {
        if (cur.value === '<') depthAngle += 1
        else if (cur.value === '>' && depthAngle > 0) depthAngle -= 1
        else if (cur.value === '{') depthBrace += 1
        else if (cur.value === '}' && depthBrace > 0) depthBrace -= 1
        else if (cur.value === '(') depthParen += 1
        else if (cur.value === ')' && depthParen > 0) depthParen -= 1
        else if (cur.value === '[') depthBracket += 1
        else if (cur.value === ']' && depthBracket > 0) depthBracket -= 1
        else if (
          cur.value === '=' &&
          depthAngle === 0 &&
          depthBrace === 0 &&
          depthParen === 0 &&
          depthBracket === 0
        ) {
          if (tokens[j + 1]?.type === 'punct' && tokens[j + 1].value === '>') {
            j += 2
            continue
          }
          if (tokens[j + 1]?.type === 'punct' && tokens[j + 1].value === '{') {
            return j + 1
          }
          break
        } else if (cur.value === ';' && depthBrace === 0 && depthParen === 0) {
          break
        }
      }
      j += 1
    }
  }
  return -1
}

/** 从插件的 src/i18n.ts 源码中安全提取 createTranslator(...) 的多语言词典对象 */
export function extractPluginI18nCatalog(sourceText) {
  const tokenized = tokenizePluginI18nSource(sourceText)
  if (!tokenized.ok) {
    return { ok: false, duplicateKeys: [], error: tokenized.error }
  }
  const { tokens } = tokenized

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].type !== 'ident' || tokens[i].value !== 'createTranslator') continue
    const afterGeneric = skipTypeArguments(tokens, i + 1)
    if (tokens[afterGeneric]?.type !== 'punct' || tokens[afterGeneric].value !== '(') continue

    const firstArgIdx = afterGeneric + 1
    const firstArg = tokens[firstArgIdx]
    if (!firstArg) continue

    let objectStartIdx = -1
    if (firstArg.type === 'punct' && firstArg.value === '{') {
      objectStartIdx = firstArgIdx
    } else if (firstArg.type === 'ident') {
      objectStartIdx = findVariableObjectInitializer(tokens, firstArg.value, i)
    }

    if (objectStartIdx === -1) {
      return {
        ok: false,
        duplicateKeys: [],
        error: 'Unable to statically resolve createTranslator(...) catalog object'
      }
    }

    const parsed = parseStaticObjectLiteral(tokens, objectStartIdx)
    if (!parsed.ok) {
      return { ok: false, duplicateKeys: parsed.duplicateKeys, error: parsed.error }
    }
    return { ok: true, catalog: parsed.value, duplicateKeys: parsed.duplicateKeys }
  }

  return { ok: false, duplicateKeys: [], error: 'createTranslator(...) definition not found' }
}

/**
 * 校验单个插件目录的多语言完整性（供插件 PR 门禁、quality-gate 与全量巡检复用）：
 *   1. plugin.json 的 i18n["en-US"].name/description 及 i18n[loc].features 与顶层对齐
 *   2. 声明的全部截图（含多语言）文件存在
 *   3. 若存在 src/i18n.ts（或 requireI18nTs=true），校验双语键一致、占位符一致、无空译文、en-US 无中文残留
 */
export function checkSinglePluginI18n(
  pluginDir,
  {
    baseLocale = DEFAULT_BASE_LOCALE,
    requiredLocales = DEFAULT_REQUIRED_PLUGIN_LOCALES,
    requireI18nTs = true,
    checkEnUsNoChinese = true,
    checkScreenshots = true
  } = {}
) {
  const resolvedPluginDir = path.resolve(pluginDir)
  const dirName = path.basename(resolvedPluginDir)
  const manifestPath = path.join(resolvedPluginDir, 'plugin.json')
  const errors = []

  if (!fs.existsSync(manifestPath)) {
    return { dir: resolvedPluginDir, skipped: true, revoked: false, ok: true, errors }
  }

  let manifestBuf
  try {
    manifestBuf = fs.readFileSync(manifestPath)
  } catch (err) {
    errors.push({ code: 'READ_ERROR', file: manifestPath, message: `Unable to read plugin.json: ${err.message}` })
    return { dir: resolvedPluginDir, skipped: false, revoked: false, ok: false, errors }
  }

  if (hasUtf8Bom(manifestBuf)) {
    errors.push({ code: 'UTF8_BOM', file: manifestPath, message: 'plugin.json contains UTF-8 BOM' })
  }

  const rawManifest = hasUtf8Bom(manifestBuf) ? manifestBuf.subarray(3).toString('utf8') : manifestBuf.toString('utf8')
  let manifest
  try {
    manifest = JSON.parse(rawManifest)
  } catch (err) {
    errors.push({ code: 'INVALID_MANIFEST', file: manifestPath, message: `Invalid plugin.json: ${err.message}` })
    return { dir: resolvedPluginDir, skipped: false, revoked: false, ok: false, errors }
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push({ code: 'INVALID_MANIFEST', file: manifestPath, message: 'plugin.json root must be an object' })
    return { dir: resolvedPluginDir, skipped: false, revoked: false, ok: false, errors }
  }

  if (manifest.revoked === true) {
    return { dir: resolvedPluginDir, skipped: false, revoked: true, ok: true, errors }
  }

  const enMeta = manifest.i18n && typeof manifest.i18n === 'object' && !Array.isArray(manifest.i18n)
    ? manifest.i18n['en-US']
    : undefined

  if (!enMeta || typeof enMeta !== 'object' || Array.isArray(enMeta)) {
    errors.push({
      code: 'MISSING_PLUGIN_I18N_META',
      file: manifestPath,
      message: `Plugin "${dirName}" plugin.json is missing i18n["en-US"] metadata`
    })
  } else {
    if (typeof enMeta.name !== 'string' || enMeta.name.trim().length === 0) {
      errors.push({
        code: 'MISSING_PLUGIN_I18N_NAME',
        file: manifestPath,
        key: 'i18n.en-US.name',
        message: `Plugin "${dirName}" plugin.json is missing non-empty i18n["en-US"].name`
      })
    }
    if (typeof enMeta.description !== 'string' || enMeta.description.trim().length === 0) {
      errors.push({
        code: 'MISSING_PLUGIN_I18N_DESC',
        file: manifestPath,
        key: 'i18n.en-US.description',
        message: `Plugin "${dirName}" plugin.json is missing non-empty i18n["en-US"].description`
      })
    }
    if (checkEnUsNoChinese) {
      const scanEn = (val, kp) => {
        if (typeof val === 'string' && CJK_REGEX.test(val)) {
          errors.push({
            code: 'EN_US_CHINESE_LEAK',
            file: manifestPath,
            key: kp,
            message: `Plugin "${dirName}" ${kp} contains Chinese characters: "${val.slice(0, 60)}"`
          })
        } else if (Array.isArray(val)) {
          val.forEach((x, idx) => scanEn(x, `${kp}[${idx}]`))
        } else if (val && typeof val === 'object') {
          for (const [k, v] of Object.entries(val)) scanEn(v, `${kp}.${k}`)
        }
      }
      scanEn(enMeta, 'i18n.en-US')
    }
  }

  const topFeatureCodes = new Set(
    Array.isArray(manifest.features)
      ? manifest.features
          .filter((f) => f && typeof f === 'object' && typeof f.code === 'string' && f.code.trim())
          .map((f) => f.code)
      : []
  )
  if (manifest.i18n && typeof manifest.i18n === 'object' && !Array.isArray(manifest.i18n)) {
    for (const [locale, entry] of Object.entries(manifest.i18n)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.features === undefined) continue
      if (!entry.features || typeof entry.features !== 'object' || Array.isArray(entry.features)) {
        errors.push({
          code: 'INVALID_PLUGIN_I18N_FEATURES',
          file: manifestPath,
          key: `i18n.${locale}.features`,
          message: `i18n["${locale}"].features must be an object keyed by feature code`
        })
        continue
      }
      for (const code of Object.keys(entry.features)) {
        if (!topFeatureCodes.has(code)) {
          errors.push({
            code: 'UNKNOWN_I18N_FEATURE_CODE',
            file: manifestPath,
            key: `i18n.${locale}.features.${code}`,
            message: `i18n["${locale}"].features["${code}"] does not exist in top-level manifest.features`
          })
        }
      }
    }
  }

  if (checkScreenshots) {
    for (const shot of collectDeclaredScreenshots(manifest)) {
      const target = path.join(resolvedPluginDir, ...shot.rel.split('/'))
      if (!fs.existsSync(target)) {
        errors.push({
          code: 'SCREENSHOT_MISSING_IN_PLUGIN',
          file: manifestPath,
          key: `${shot.locale}:${shot.rel}`,
          message: `Declared screenshot (${shot.locale}) does not exist: ${shot.rel}`
        })
      }
    }
  }

  const i18nTsPath = path.join(resolvedPluginDir, 'src', 'i18n.ts')
  if (!fs.existsSync(i18nTsPath)) {
    if (requireI18nTs) {
      errors.push({
        code: 'MISSING_PLUGIN_I18N_FILE',
        file: i18nTsPath,
        message: `Active plugin "${dirName}" is missing src/i18n.ts`
      })
    }
    return { dir: resolvedPluginDir, skipped: false, revoked: false, ok: errors.length === 0, errors }
  }

  let tsBuf
  try {
    tsBuf = fs.readFileSync(i18nTsPath)
  } catch (err) {
    errors.push({ code: 'READ_ERROR', file: i18nTsPath, message: `Unable to read src/i18n.ts: ${err.message}` })
    return { dir: resolvedPluginDir, skipped: false, revoked: false, ok: false, errors }
  }

  if (hasUtf8Bom(tsBuf)) {
    errors.push({ code: 'UTF8_BOM', file: i18nTsPath, message: 'src/i18n.ts contains UTF-8 BOM' })
  }

  const tsText = hasUtf8Bom(tsBuf) ? tsBuf.subarray(3).toString('utf8') : tsBuf.toString('utf8')
  const extracted = extractPluginI18nCatalog(tsText)
  if (!extracted.ok || !extracted.catalog) {
    errors.push({
      code: 'INVALID_PLUGIN_I18N_TS',
      file: i18nTsPath,
      message: `Failed to parse src/i18n.ts catalog: ${extracted.error}`
    })
    return { dir: resolvedPluginDir, skipped: false, revoked: false, ok: false, errors }
  }

  for (const dupKey of extracted.duplicateKeys) {
    errors.push({
      code: 'DUPLICATE_KEY',
      file: i18nTsPath,
      key: dupKey,
      message: `Duplicate key "${dupKey}" in src/i18n.ts`
    })
  }

  const catalog = extracted.catalog
  const requiredSet = new Set([baseLocale, ...requiredLocales])
  let missingBase = false
  for (const reqLocale of requiredSet) {
    const dict = catalog[reqLocale]
    if (!dict || typeof dict !== 'object' || Array.isArray(dict)) {
      errors.push({
        code: 'MISSING_PLUGIN_LOCALE',
        file: i18nTsPath,
        key: reqLocale,
        message: `src/i18n.ts is missing locale "${reqLocale}"`
      })
      if (reqLocale === baseLocale) missingBase = true
    }
  }
  if (missingBase) {
    return { dir: resolvedPluginDir, skipped: false, revoked: false, ok: false, errors }
  }

  const flattenedByLocale = new Map()
  for (const [locale, dict] of Object.entries(catalog)) {
    const { entries, invalidNodes } = flattenMessages(dict)
    for (const nodePath of invalidNodes) {
      errors.push({
        code: 'INVALID_VALUE_TYPE',
        file: i18nTsPath,
        key: `${locale}.${nodePath}`,
        message: `Key "${locale}.${nodePath}" must be a static string or non-empty nested object`
      })
    }
    for (const [key, value] of entries) {
      if (value.trim().length === 0) {
        errors.push({
          code: 'EMPTY_VALUE',
          file: i18nTsPath,
          key: `${locale}.${key}`,
          message: `Key "${locale}.${key}" must not be empty`
        })
      }
      if (checkEnUsNoChinese && locale === 'en-US' && CJK_REGEX.test(value)) {
        errors.push({
          code: 'EN_US_CHINESE_LEAK',
          file: i18nTsPath,
          key: `${locale}.${key}`,
          message: `English key "${key}" contains Chinese characters: "${value.slice(0, 60)}"`
        })
      }
      for (const m of value.matchAll(/\[\[([^\]]*)\]\]/g)) {
        const inner = m[1]
        const colonIdx = inner.indexOf(':')
        if (colonIdx <= 0) continue
        const forms = inner.slice(colonIdx + 1).split('|')
        if (forms.length < 2 || forms.some((f) => f.trim().length === 0)) {
          errors.push({
            code: 'EMPTY_PLURAL_SEGMENT',
            file: i18nTsPath,
            key: `${locale}.${key}`,
            message: `Plural macro [[${inner}]] in "${locale}.${key}" has empty or missing segments`
          })
        }
      }
    }
    flattenedByLocale.set(locale, entries)
  }

  const baseEntries = flattenedByLocale.get(baseLocale)
  for (const [locale, targetEntries] of flattenedByLocale.entries()) {
    if (locale === baseLocale) continue
    for (const [key, baseValue] of baseEntries) {
      if (!targetEntries.has(key)) {
        errors.push({
          code: 'MISSING_KEY',
          file: i18nTsPath,
          key: `${locale}.${key}`,
          message: `Locale "${locale}" is missing key "${key}"`
        })
        continue
      }
      const targetValue = targetEntries.get(key)
      const baseVars = extractPlaceholders(baseValue)
      const targetVars = extractPlaceholders(targetValue)
      if (baseVars.length !== targetVars.length || baseVars.some((v, idx) => v !== targetVars[idx])) {
        errors.push({
          code: 'PLACEHOLDER_MISMATCH',
          file: i18nTsPath,
          key: `${locale}.${key}`,
          message: `Placeholder mismatch in "${locale}.${key}": base [${baseVars.join(', ')}], target [${targetVars.join(', ')}]`
        })
      }
    }
    for (const key of targetEntries.keys()) {
      if (!baseEntries.has(key)) {
        errors.push({
          code: 'EXTRA_KEY',
          file: i18nTsPath,
          key: `${locale}.${key}`,
          message: `Locale "${locale}" has extra key "${key}"`
        })
      }
    }
  }

  return { dir: resolvedPluginDir, skipped: false, revoked: false, ok: errors.length === 0, errors }
}

/** 批量校验插件目录下所有活跃插件 */
export function checkPluginI18nDirectory(
  pluginsDir = path.join(PUBLIC_ROOT_DIR, 'plugins'),
  {
    baseLocale = DEFAULT_BASE_LOCALE,
    requiredLocales = DEFAULT_REQUIRED_PLUGIN_LOCALES,
    checkEnUsNoChinese = false,
    checkScreenshots = false
  } = {}
) {
  const resolvedDir = path.resolve(pluginsDir)
  const errors = []

  if (!fs.existsSync(resolvedDir)) {
    return { dir: resolvedDir, skipped: true, ok: true, pluginCount: 0, revokedCount: 0, errors }
  }

  const subdirs = fs
    .readdirSync(resolvedDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  let pluginCount = 0
  let revokedCount = 0

  for (const dirName of subdirs) {
    const res = checkSinglePluginI18n(path.join(resolvedDir, dirName), {
      baseLocale,
      requiredLocales,
      requireI18nTs: true,
      checkEnUsNoChinese,
      checkScreenshots
    })
    if (res.skipped) continue
    if (res.revoked) {
      revokedCount += 1
      continue
    }
    pluginCount += 1
    errors.push(...res.errors)
  }

  return {
    dir: resolvedDir,
    skipped: false,
    ok: errors.length === 0,
    pluginCount,
    revokedCount,
    errors
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()

if (isMainModule) {
  const args = process.argv.slice(2)
  const pluginDirs = []
  const localeDirs = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--plugin' && args[i + 1]) pluginDirs.push(args[++i])
    else if (args[i] === '--dir' && args[i + 1]) localeDirs.push(args[++i])
  }
  const allErrors = []
  for (const dir of localeDirs) {
    allErrors.push(...checkLocaleDirectory(dir).errors)
  }
  for (const pDir of pluginDirs) {
    allErrors.push(...checkSinglePluginI18n(pDir).errors)
  }
  if (allErrors.length > 0) {
    console.error(`[check-i18n-public] Found ${allErrors.length} i18n issue(s):`)
    for (const err of allErrors) {
      console.error(`  - [${err.code}] ${err.file}: ${err.message}`)
    }
    process.exit(1)
  }
  console.log('[check-i18n-public] Passed with 0 errors.')
}
