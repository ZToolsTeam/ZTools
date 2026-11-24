#!/usr/bin/env node
/**
 * 把 src/config/bundledPlugins.json 中列出的官方插件构建产物同步到 public/bundled-plugins/，
 * 并生成构建期索引文件 public/bundled-plugins/index.json 与 src/config/bundledPlugins.generated.js（两者已加入 .gitignore，不纳入 Git 跟踪）。
 *
 *   node scripts/sync-bundled-plugins.mjs          从 ../plugins/<id>/ 复制 plugin.json、icon.svg、dist/*.js 及声明过的 screenshots，
 *                                                  并生成 index.json 与 bundledPlugins.generated.js
 *   node scripts/sync-bundled-plugins.mjs --ensure 构建/测试前置就绪：存在 ../plugins 时同步并生成；不存在 ../plugins 时（如开源客户端仓库）
 *                                                  直接从已提交的 public/bundled-plugins/<id>/ 与 bundledPlugins.json 本地生成两个索引文件
 *   node scripts/sync-bundled-plugins.mjs --check  只读校验已提交进 Git 的内置插件副本、bundledPlugins.json 与计算器引擎是否同 ../plugins 一致；
 *                                                  不要求工作区预先存在未跟踪的 index.json / bundledPlugins.generated.js，也不写或删任何文件
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const defaultFrontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OFFICIAL_AUTHORS = new Set(['ztools', 'ztools team', 'ztools-team', 'ztools official', 'official'])
const TEXT_FILE_RE = /\.(?:js|json|svg|txt|md)$/i
const FALLBACK_SCREENSHOT_PATH_RE = /^screenshots\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.png$/
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function fallbackCollectDeclaredScreenshots(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return []
  const results = []
  const seen = new Set()
  const pushEntry = (locale, rawRel, rawTitle) => {
    if (typeof rawRel !== 'string') return
    const rel = rawRel.trim()
    if (!FALLBACK_SCREENSHOT_PATH_RE.test(rel)) return
    const key = `${locale}::${rel}`
    if (seen.has(key)) return
    seen.add(key)
    const entry = { locale, rel }
    if (typeof rawTitle === 'string' && rawTitle.trim().length > 0) entry.title = rawTitle
    results.push(entry)
  }
  if (Array.isArray(manifest.screenshots)) {
    for (const shot of manifest.screenshots) {
      if (!shot || typeof shot !== 'object' || Array.isArray(shot)) continue
      pushEntry('default', shot.path, shot.title)
    }
  }
  if (manifest.i18n && typeof manifest.i18n === 'object' && !Array.isArray(manifest.i18n)) {
    for (const [locale, entry] of Object.entries(manifest.i18n)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.screenshots)) continue
      for (const shot of entry.screenshots) {
        if (!shot || typeof shot !== 'object' || Array.isArray(shot)) continue
        pushEntry(locale, shot.file, shot.title)
      }
    }
  }
  return results
}

function fallbackCollectDeclaredScreenshotPaths(manifest) {
  const seen = new Set()
  const paths = []
  for (const item of fallbackCollectDeclaredScreenshots(manifest)) {
    if (seen.has(item.rel)) continue
    seen.add(item.rel)
    paths.push(item.rel)
  }
  return paths
}

/**
 * plugins 仓库里除内置插件外的其余官方插件，按 plugin.json 的 draft / revoked 字段分成两类：
 *   - 草稿（draft: true，功能没做完，不会发布到插件目录）与已下架（revoked: true，例如已合并进其他插件）：客户端一律隐藏；
 *   - 其余：通过插件市场（CDN 插件目录）分发，用户安装后正常显示。
 * 插件目录在 plugins/<id>，作者分组的官方插件在 plugins/official/<id>。
 */
function officialPluginGroups(pluginsRoot, ids) {
  const draft = []
  const store = []
  const storePlugins = []
  const dirs = []
  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    dirs.push(path.join(pluginsRoot, entry.name))
    if (entry.name === 'official') {
      for (const sub of fs.readdirSync(path.join(pluginsRoot, entry.name), { withFileTypes: true })) {
        if (sub.isDirectory()) dirs.push(path.join(pluginsRoot, entry.name, sub.name))
      }
    }
  }
  for (const dir of dirs) {
    const manifestPath = path.join(dir, 'plugin.json')
    if (!fs.existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    const author = String(typeof manifest.author === 'string' ? manifest.author : manifest.author?.name || '').trim().toLowerCase()
    if (!manifest.id || ids.includes(manifest.id)) continue
    // 草稿与已下架不论作者都隐藏：plugins 仓库里归为社区作者的插件同样由官方维护与下架
    if (manifest.draft === true || manifest.revoked === true) {
      draft.push(manifest.id)
    } else if (OFFICIAL_AUTHORS.has(author)) {
      store.push(manifest.id)
      // 仅同步展示字段；安装版本、校验值、地址和发布状态仍以在线目录为准。
      storePlugins.push({
        id: manifest.id,
        name: manifest.name || manifest.id,
        description: manifest.description || '',
        category: manifest.category || [],
        ...(manifest.categoryId ? { categoryId: manifest.categoryId } : {}),
        ...(typeof manifest.defaultLocale === 'string' && manifest.defaultLocale ? { defaultLocale: manifest.defaultLocale } : {}),
        ...(manifest.i18n && typeof manifest.i18n === 'object' ? { i18n: manifest.i18n } : {})
      })
    }
  }
  return {
    unreleasedOfficialIds: draft.sort(),
    storeOfficialIds: store.sort(),
    storePlugins: storePlugins.sort((a, b) => a.id.localeCompare(b.id, 'en'))
  }
}

function normalizeEol(text) {
  return String(text).replace(/\r\n/g, '\n')
}

/** 文本文件统一按 LF 换行符归一化后计算 UTF-8 字节数，消除 Windows CRLF 与 macOS/Linux LF 的统计差异 */
function normalizedByteLength(filePath) {
  const buf = fs.readFileSync(filePath)
  if (TEXT_FILE_RE.test(filePath)) {
    return Buffer.byteLength(normalizeEol(buf.toString('utf8')), 'utf8')
  }
  return buf.length
}

function isSameFileContent(srcPath, dstPath) {
  if (!fs.existsSync(dstPath)) return false
  const srcBuf = fs.readFileSync(srcPath)
  const dstBuf = fs.readFileSync(dstPath)
  if (srcBuf.equals(dstBuf)) return true
  if (TEXT_FILE_RE.test(srcPath)) {
    return normalizeEol(srcBuf.toString('utf8')) === normalizeEol(dstBuf.toString('utf8'))
  }
  return false
}

function writeTextIfChanged(filePath, content) {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8')
    if (normalizeEol(existing) === normalizeEol(content)) return
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

/**
 * 同步时会被删除的多余条目：递归扫描整个 public/bundled-plugins/，凡不在本次同步清单里的都算多余，
 * 包括更深层目录里的文件、已从名单里移除的插件目录、顶层的杂项文件。
 * 期望清单 = index.json（允许存在的构建生成物）+ 每个内置插件的文件列表（<id>/<rel>）。
 * 符号链接一律按文件处理（不跟随链接进入目录），与删除时 fs.rmSync 只删链接本身一致。
 */
function staleBundledEntries(rootDir, expectedFiles) {
  const files = []
  const emptyDirs = []
  if (!fs.existsSync(rootDir)) return { files, emptyDirs }
  function walk(absDir, relDir) {
    let hasFile = false
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const abs = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        if (walk(abs, rel)) {
          hasFile = true
        } else {
          for (let i = emptyDirs.length - 1; i >= 0; i--) if (emptyDirs[i].startsWith(`${rel}/`)) emptyDirs.splice(i, 1)
          emptyDirs.push(rel)
        }
        continue
      }
      hasFile = true
      if (!expectedFiles.has(rel)) files.push(rel)
    }
    return hasFile
  }
  walk(rootDir, '')
  return { files: files.sort(), emptyDirs: emptyDirs.sort() }
}

/** 删除多余文件后，自底向上清理已不含期望文件的目录（不删 public/bundled-plugins/ 本身） */
function pruneDirsWithoutExpected(rootDir, expectedFiles) {
  const expectedDirs = new Set()
  for (const rel of expectedFiles) {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) expectedDirs.add(parts.slice(0, i).join('/'))
  }
  function walk(absDir, relDir) {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const abs = path.join(absDir, entry.name)
      walk(abs, rel)
      if (!expectedDirs.has(rel) && fs.readdirSync(abs).length === 0) fs.rmdirSync(abs)
    }
  }
  if (fs.existsSync(rootDir)) walk(rootDir, '')
}

function manifestDeclaresAnyScreenshots(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return false
  if (manifest.screenshots !== undefined) return true
  if (manifest.i18n && typeof manifest.i18n === 'object' && !Array.isArray(manifest.i18n)) {
    for (const entry of Object.values(manifest.i18n)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.screenshots !== undefined) {
        return true
      }
    }
  }
  return false
}

export async function loadScreenshotRules(rootForScan, ids, frontendRoot = defaultFrontendRoot) {
  const declaresScreenshots = ids.some((id) => {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(rootForScan, id, 'plugin.json'), 'utf8'))
      return manifestDeclaresAnyScreenshots(manifest)
    } catch {
      return false
    }
  })
  if (!declaresScreenshots) return null
  const specValidatorPath = path.resolve(frontendRoot, '../packages/ztools-plugins-spec/src/validator.js')
  const specScreenshotsPath = path.resolve(frontendRoot, '../packages/ztools-plugins-spec/src/screenshots.js')
  if (fs.existsSync(specValidatorPath) && fs.existsSync(specScreenshotsPath)) {
    const [validatorMod, screenshotsMod] = await Promise.all([
      import(pathToFileURL(specValidatorPath).href),
      import(pathToFileURL(specScreenshotsPath).href)
    ])
    return {
      ...validatorMod,
      collectDeclaredScreenshots: screenshotsMod.collectDeclaredScreenshots,
      collectDeclaredScreenshotPaths: screenshotsMod.collectDeclaredScreenshotPaths
    }
  }
  // 单独检出 frontend 子模块且不含上级 packages/ 时的最小 PNG 尺寸读取与收集兜底
  return {
    SCREENSHOT_PATH_REGEX: FALLBACK_SCREENSHOT_PATH_RE,
    SCREENSHOT_LIMITS: { maxCount: 5 },
    collectDeclaredScreenshots: fallbackCollectDeclaredScreenshots,
    collectDeclaredScreenshotPaths: fallbackCollectDeclaredScreenshotPaths,
    inspectScreenshotFile(baseDir, relPath) {
      const abs = path.join(baseDir, relPath)
      if (!fs.existsSync(abs)) return { ok: false, error: `截图文件不存在: ${relPath}` }
      const buf = fs.readFileSync(abs)
      if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') {
        return { ok: false, error: `截图 ${relPath} 不是有效的 PNG 文件` }
      }
      return { ok: true, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length }
    }
  }
}

/**
 * 校验并收集 plugin.json 声明的全部截图（顶层 screenshots[].path + i18n[locale].screenshots[].file），
 * 统一基于 collectDeclaredScreenshots / collectDeclaredScreenshotPaths 单一信源；
 * 与插件市场发布同一套校验（screenshots/ 下的 PNG、≤ 1 MB、尺寸范围），不合格直接报错。
 */
export function bundledScreenshots(id, dir, manifest, rules) {
  if (!manifestDeclaresAnyScreenshots(manifest)) {
    return { screenshots: [], i18nScreenshots: {}, allPaths: [] }
  }
  const {
    inspectScreenshotFile,
    SCREENSHOT_PATH_REGEX,
    SCREENSHOT_LIMITS,
    collectDeclaredScreenshots = fallbackCollectDeclaredScreenshots,
    collectDeclaredScreenshotPaths = fallbackCollectDeclaredScreenshotPaths
  } = rules

  const validateList = (list, label, pathKey) => {
    if (!Array.isArray(list) || list.length > SCREENSHOT_LIMITS.maxCount) {
      throw new Error(`[${id}] ${label} 必须为不超过 ${SCREENSHOT_LIMITS.maxCount} 项的数组`)
    }
    const seen = new Set()
    for (const [idx, shot] of list.entries()) {
      const rel = shot?.[pathKey]
      if (typeof rel !== 'string' || !SCREENSHOT_PATH_REGEX.test(rel) || seen.has(rel)) {
        throw new Error(`[${id}] ${label}[${idx}].${pathKey} 不合法或重复: ${JSON.stringify(rel)}`)
      }
      seen.add(rel)
    }
  }

  if (manifest.screenshots !== undefined) {
    validateList(manifest.screenshots, 'screenshots', 'path')
  }
  if (manifest.i18n && typeof manifest.i18n === 'object' && !Array.isArray(manifest.i18n)) {
    for (const [locale, entry] of Object.entries(manifest.i18n)) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry) && entry.screenshots !== undefined) {
        validateList(entry.screenshots, `i18n["${locale}"].screenshots`, 'file')
      }
    }
  }

  const declared = collectDeclaredScreenshots(manifest)
  const inspectedCache = new Map()
  const screenshots = []
  const i18nScreenshots = {}

  for (const item of declared) {
    let info = inspectedCache.get(item.rel)
    if (!info) {
      info = inspectScreenshotFile(dir, item.rel)
      if (!info.ok) throw new Error(`[${id}] ${info.error}`)
      inspectedCache.set(item.rel, info)
    }
    if (item.locale === 'default') {
      screenshots.push({
        path: item.rel,
        title: typeof item.title === 'string' ? item.title : '',
        width: info.width,
        height: info.height
      })
    } else {
      if (!i18nScreenshots[item.locale]) i18nScreenshots[item.locale] = []
      i18nScreenshots[item.locale].push({
        file: item.rel,
        ...(typeof item.title === 'string' && item.title.trim() ? { title: item.title } : {}),
        width: info.width,
        height: info.height
      })
    }
  }

  const allPaths = collectDeclaredScreenshotPaths(manifest)
  return { screenshots, i18nScreenshots, allPaths }
}

export function collectPluginFiles(baseRoot, id, rules, missingHint) {
  const dir = path.join(baseRoot, id)
  const manifestPath = path.join(dir, 'plugin.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`[${id}] 缺少 plugin.json（${missingHint}）`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.id !== id) throw new Error(`[${id}] plugin.json 中的 id 为 ${manifest.id}`)
  const files = ['plugin.json']
  const icon = String(manifest.icon || 'icon.svg').replace(/^\/+/, '')
  if (fs.existsSync(path.join(dir, icon))) files.push(icon)
  const distDir = path.join(dir, 'dist')
  if (!fs.existsSync(distDir)) throw new Error(`[${id}] 缺少 dist/（${missingHint}）`)
  for (const name of fs.readdirSync(distDir).sort()) {
    if (name.endsWith('.js')) files.push(`dist/${name}`)
  }
  const entry = String(manifest.entry || 'dist/index.js')
  if (!files.includes(entry)) throw new Error(`[${id}] 缺少入口文件 ${entry}（${missingHint}）`)
  const { screenshots, i18nScreenshots, allPaths } = bundledScreenshots(id, dir, manifest, rules)
  return { dir, files: [...files, ...allPaths], screenshots, i18nScreenshots, allScreenshotPaths: allPaths, manifest }
}

function buildBundledI18nRecord(manifestI18n, i18nScreenshots = {}) {
  if (!manifestI18n || typeof manifestI18n !== 'object' || Array.isArray(manifestI18n)) {
    return undefined
  }
  const result = {}
  for (const [locale, entry] of Object.entries(manifestI18n)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const nextEntry = { ...entry }
    if (Array.isArray(i18nScreenshots[locale]) && i18nScreenshots[locale].length > 0) {
      nextEntry.screenshots = i18nScreenshots[locale]
    }
    result[locale] = nextEntry
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function toIndexRecord(id, dir, files, screenshots, manifest, i18nScreenshots = {}, allScreenshotPaths = null) {
  const screenshotPathSet = new Set(
    Array.isArray(allScreenshotPaths) ? allScreenshotPaths : screenshots.map((shot) => shot.path)
  )
  const normalizedI18n = buildBundledI18nRecord(manifest.i18n, i18nScreenshots)
  return {
    id,
    name: manifest.name,
    description: manifest.description || '',
    version: manifest.version || '1.0.0',
    author: manifest.author || 'ZTools Team',
    icon: String(manifest.icon || 'icon.svg').replace(/^\/+/, ''),
    category: manifest.category || [],
    ...(manifest.categoryId ? { categoryId: manifest.categoryId } : {}),
    ...(typeof manifest.defaultLocale === 'string' && manifest.defaultLocale ? { defaultLocale: manifest.defaultLocale } : {}),
    ...(normalizedI18n ? { i18n: normalizedI18n } : {}),
    keywords: manifest.keywords || [],
    alias: typeof manifest.alias === 'string' ? manifest.alias : '',
    features: Array.isArray(manifest.features) ? manifest.features : [],
    targets: Array.isArray(manifest.targets) ? manifest.targets : [],
    // 随客户端分发的文件总字节数（plugin.json、图标与 dist 脚本，不含顶层及多语言截图，文本按 LF 归一化），详情页据此显示插件大小
    size: files.filter((rel) => !screenshotPathSet.has(rel)).reduce((sum, rel) => sum + normalizedByteLength(path.join(dir, rel)), 0),
    // 没有顶层截图时不写这个字段，生成结果与以前一致
    ...(screenshots.length ? { screenshots } : {}),
    files
  }
}

export function buildGeneratedModuleText({ ids, index, groups, storePlugins }) {
  const indexText = JSON.stringify({ plugins: index }, null, 2) + '\n'
  const generatedText =
    '// 由 scripts/sync-bundled-plugins.mjs 自动生成（已加入 .gitignore），请勿手改；修改内置插件名单请编辑 bundledPlugins.json\n' +
    `export default ${JSON.stringify({ ids, ...groups, storePlugins, plugins: index.map(({ files, ...rest }) => rest) }, null, 2)}\n`
  return { indexText, generatedText }
}

/**
 * 执行内置插件同步 / 校验主流程（支持注入目录以便单元测试完全隔离运行）
 */
export async function syncBundledPlugins({
  frontendRoot = defaultFrontendRoot,
  pluginsRoot = path.resolve(frontendRoot, '../plugins'),
  outRoot = path.join(frontendRoot, 'public/bundled-plugins'),
  configPath = path.join(frontendRoot, 'src/config/bundledPlugins.json'),
  generatedPath = path.join(frontendRoot, 'src/config/bundledPlugins.generated.js'),
  indexOutPath = path.join(outRoot, 'index.json'),
  syncCalculatorEngine = true,
  checkOnly = false,
  ensureMode = false,
  log = console.log,
  errorLog = console.error
} = {}) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const { ids } = config

  // 无 ../plugins 仓库时（如公开客户端仓库 ZToolsTeam/ZTools 或单独构建 frontend）：直接从已跟踪的本地副本组装生成
  if (!fs.existsSync(pluginsRoot)) {
    if (!checkOnly && !ensureMode) {
      errorLog(`未找到插件源仓库：${pluginsRoot}`)
      return { ok: false, exitCode: 1 }
    }
    const rules = await loadScreenshotRules(outRoot, ids, frontendRoot)
    const index = []
    const expectedOutFiles = new Set(['index.json'])
    try {
      for (const id of ids) {
        const { dir, files, screenshots, i18nScreenshots, allScreenshotPaths, manifest } = collectPluginFiles(outRoot, id, rules, '内置插件本地副本不完整')
        for (const rel of files) expectedOutFiles.add(`${id}/${rel.split(path.sep).join('/')}`)
        index.push(toIndexRecord(id, dir, files, screenshots, manifest, i18nScreenshots, allScreenshotPaths))
      }
    } catch (err) {
      errorLog(`内置插件本地副本不完整：${err.message}`)
      return { ok: false, exitCode: 1 }
    }
    if (checkOnly) {
      const stale = staleBundledEntries(outRoot, expectedOutFiles)
      let mismatches = 0
      for (const rel of stale.files) {
        errorLog(`多余：${rel}（同步时会被删除）`)
        mismatches++
      }
      for (const rel of stale.emptyDirs) {
        errorLog(`多余：${rel}/（空目录，同步时会被删除）`)
        mismatches++
      }
      if (mismatches > 0) {
        errorLog(`内置插件本地副本存在 ${mismatches} 处多余条目`)
        return { ok: false, exitCode: 1, mismatches }
      }
      log('未找到 ../plugins，已校验本地 public/bundled-plugins 产物完整')
      return { ok: true, exitCode: 0, index }
    }
    const groups = {
      unreleasedOfficialIds: Array.isArray(config.unreleasedOfficialIds) ? [...config.unreleasedOfficialIds].sort() : [],
      storeOfficialIds: Array.isArray(config.storeOfficialIds) ? [...config.storeOfficialIds].sort() : []
    }
    const { indexText, generatedText } = buildGeneratedModuleText({ ids, index, groups, storePlugins: [] })
    writeTextIfChanged(indexOutPath, indexText)
    writeTextIfChanged(generatedPath, generatedText)
    log('未找到 ../plugins，已从本地 public/bundled-plugins 生成索引配置')
    return { ok: true, exitCode: 0, index }
  }

  const screenshotRules = await loadScreenshotRules(pluginsRoot, ids, frontendRoot)

  const index = []
  let mismatches = 0
  // 整个 public/bundled-plugins/ 下应当存在的文件（相对路径，/ 分隔；index.json 允许存在但不参与 --check 缺失校验）
  const expectedOutFiles = new Set(['index.json'])
  for (const id of ids) {
    const { dir, files, screenshots, i18nScreenshots, allScreenshotPaths, manifest } = collectPluginFiles(pluginsRoot, id, screenshotRules, '请先在 plugins 仓库构建')
    for (const rel of files) expectedOutFiles.add(`${id}/${rel.split(path.sep).join('/')}`)
    for (const rel of files) {
      const src = path.join(dir, rel)
      const dst = path.join(outRoot, id, rel)
      if (checkOnly) {
        if (!isSameFileContent(src, dst)) {
          errorLog(`不一致：${id}/${rel}`)
          mismatches++
        }
      } else if (!isSameFileContent(src, dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.copyFileSync(src, dst)
      }
    }
    index.push(toIndexRecord(id, dir, files, screenshots, manifest, i18nScreenshots, allScreenshotPaths))
  }
  const stale = staleBundledEntries(outRoot, expectedOutFiles)
  for (const rel of stale.files) {
    if (checkOnly) {
      errorLog(`多余：${rel}（同步时会被删除）`)
      mismatches++
    } else {
      fs.rmSync(path.join(outRoot, ...rel.split('/')), { force: true })
    }
  }
  if (checkOnly) {
    for (const rel of stale.emptyDirs) {
      errorLog(`多余：${rel}/（空目录，同步时会被删除）`)
      mismatches++
    }
  } else {
    pruneDirsWithoutExpected(outRoot, expectedOutFiles)
  }
  const { storePlugins, ...groups } = officialPluginGroups(pluginsRoot, ids)
  const configText = JSON.stringify({ ...config, ...groups }, null, 2) + '\n'
  const { indexText, generatedText } = buildGeneratedModuleText({ ids, index, groups, storePlugins })

  // 主搜索框「直接输入算式出结果」复用内置计算器插件的计算引擎（与插件同一份实现，避免两套算法结果不一致）。
  // 计算历史写入计算器插件自己的存储，在计算器插件里也能看到主搜索框算过的式子。
  let calculatorEngineOut = null
  let calculatorEngineText = null
  if (syncCalculatorEngine) {
    const calculatorEngineSource = path.join(pluginsRoot, 'calculator/dist/calculator-engine.js')
    calculatorEngineOut = path.join(frontendRoot, 'src/vendor/calculator-engine.js')
    const ENGINE_STORAGE_IMPORT_RE = /^import\s*\{([^}]+)\}\s*from\s*["']@ztools\/declarative-ui["'];?/m
    const engineSourceText = fs.readFileSync(calculatorEngineSource, 'utf8')
    const engineImportMatch = engineSourceText.match(ENGINE_STORAGE_IMPORT_RE)
    if (!engineImportMatch) throw new Error('计算器引擎的存储导入写法已变化，请同步更新 sync-bundled-plugins.mjs')
    const importedNames = engineImportMatch[1].split(',').map((s) => s.trim()).filter(Boolean)
    if (!importedNames.includes('LocalStorage')) throw new Error('计算器引擎缺少 LocalStorage 导入，请同步更新 sync-bundled-plugins.mjs')
    const remainingImports = importedNames.filter((name) => name !== 'LocalStorage')
    const replacementImportLines = [
      "import { calculatorPluginStorage as LocalStorage } from '../utils/calculatorPluginStorage.js';",
      ...(remainingImports.length ? [`import { ${remainingImports.join(', ')} } from "@ztools/declarative-ui";`] : [])
    ].join('\n')
    calculatorEngineText =
      '// 由 scripts/sync-bundled-plugins.mjs 从 plugins/calculator/dist/calculator-engine.js 生成，请勿手改\n' +
      engineSourceText.replace(ENGINE_STORAGE_IMPORT_RE, replacementImportLines)
  }

  if (checkOnly) {
    if (calculatorEngineOut && (!fs.existsSync(calculatorEngineOut) || normalizeEol(fs.readFileSync(calculatorEngineOut, 'utf8')) !== normalizeEol(calculatorEngineText))) {
      errorLog('不一致：src/vendor/calculator-engine.js')
      mismatches++
    }
    if (normalizeEol(fs.readFileSync(configPath, 'utf8')) !== normalizeEol(configText)) {
      errorLog('不一致：src/config/bundledPlugins.json 的 unreleasedOfficialIds / storeOfficialIds')
      mismatches++
    }
    if (mismatches) {
      errorLog(`内置插件副本与 plugins 仓库不一致（${mismatches} 处），请运行 node scripts/sync-bundled-plugins.mjs`)
      return { ok: false, exitCode: 1, mismatches }
    }
    log(`内置插件副本一致（${ids.length} 个）`)
    return { ok: true, exitCode: 0, index }
  } else {
    writeTextIfChanged(indexOutPath, indexText)
    writeTextIfChanged(configPath, configText)
    writeTextIfChanged(generatedPath, generatedText)
    if (calculatorEngineOut && calculatorEngineText !== null) {
      writeTextIfChanged(calculatorEngineOut, calculatorEngineText)
    }
    log(`已同步 ${ids.length} 个内置插件到 public/bundled-plugins/`)
    return { ok: true, exitCode: 0, index }
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()

if (isMainModule) {
  const result = await syncBundledPlugins({
    checkOnly: process.argv.includes('--check'),
    ensureMode: process.argv.includes('--ensure')
  })
  process.exit(result.exitCode)
}
