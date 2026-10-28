#!/usr/bin/env node
/**
 * 把 src/config/bundledPlugins.json 中列出的官方插件构建产物同步到 public/bundled-plugins/
 *
 *   node scripts/sync-bundled-plugins.mjs          从 ../plugins/<id>/ 复制 plugin.json、icon.svg、dist/*.js
 *   node scripts/sync-bundled-plugins.mjs --check  只校验已同步的副本与源仓库一致（内容不同、缺少文件，以及同步时会被删除的
 *                                                  多余文件都算不一致），不一致时退出码为 1；只读，不写也不删任何文件
 *
 * 同步结果提交进 frontend 仓库，前端构建不依赖 plugins 仓库是否存在。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginsRoot = path.resolve(frontendRoot, '../plugins')
const outRoot = path.join(frontendRoot, 'public/bundled-plugins')
const configPath = path.join(frontendRoot, 'src/config/bundledPlugins.json')
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
const { ids } = config
const OFFICIAL_AUTHORS = new Set(['ztools', 'ztools team', 'ztools-team', 'ztools official', 'official'])

/**
 * plugins 仓库里除内置插件外的其余官方插件，按 plugin.json 的 draft / revoked 字段分成两类：
 *   - 草稿（draft: true，功能没做完，不会发布到插件目录）与已下架（revoked: true，例如已合并进其他插件）：客户端一律隐藏；
 *   - 其余：通过插件市场（CDN 插件目录）分发，用户安装后正常显示。
 * 插件目录在 plugins/<id>，作者分组的官方插件在 plugins/official/<id>。
 */
function officialPluginGroups() {
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
        category: manifest.category || []
      })
    }
  }
  return {
    unreleasedOfficialIds: draft.sort(),
    storeOfficialIds: store.sort(),
    storePlugins: storePlugins.sort((a, b) => a.id.localeCompare(b.id, 'en'))
  }
}
const checkOnly = process.argv.includes('--check')
const ensureMode = process.argv.includes('--ensure')

function normalizeEol(text) {
  return String(text).replace(/\r\n/g, '\n')
}

function isSameFileContent(srcPath, dstPath) {
  if (!fs.existsSync(dstPath)) return false
  const srcBuf = fs.readFileSync(srcPath)
  const dstBuf = fs.readFileSync(dstPath)
  if (srcBuf.equals(dstBuf)) return true
  if (/\.(?:js|json|svg|txt|md)$/i.test(srcPath)) {
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

function verifyExistingBundledFiles() {
  const indexPath = path.join(outRoot, 'index.json')
  if (!fs.existsSync(indexPath)) {
    console.error('缺少 public/bundled-plugins/index.json')
    process.exit(1)
  }
  const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : []
  let missing = 0
  for (const id of ids) {
    const item = plugins.find((p) => p.id === id)
    const files = Array.isArray(item?.files) && item.files.length > 0 ? item.files : ['plugin.json', 'dist/index.js']
    for (const rel of files) {
      const target = path.join(outRoot, id, rel)
      if (!fs.existsSync(target)) {
        console.error(`缺少内置插件资源文件：public/bundled-plugins/${id}/${rel}`)
        missing++
      }
    }
  }
  if (missing > 0) {
    console.error(`内置插件资源不完整（缺失 ${missing} 个文件），请运行 node scripts/sync-bundled-plugins.mjs`)
    process.exit(1)
  }
}

/**
 * 同步时会被删除的多余条目：递归扫描整个 public/bundled-plugins/，凡不在本次同步清单里的都算多余，
 * 包括更深层目录里的文件、已从名单里移除的插件目录、顶层的杂项文件。
 * 期望清单 = index.json + 每个内置插件的文件列表（<id>/<rel>）。
 * 符号链接一律按文件处理（不跟随链接进入目录），与删除时 fs.rmSync 只删链接本身一致。
 * 返回两类相对 public/bundled-plugins/ 的路径（统一用 / 分隔）：
 *   - files：多余的文件（含符号链接）；
 *   - emptyDirs：完全不含任何文件的目录（--ensure 同样会删除）。
 * --check 报告、--ensure 删除的都是这同一份扫描结果。
 */
function staleBundledEntries(rootDir, expectedFiles) {
  const files = []
  const emptyDirs = []
  if (!fs.existsSync(rootDir)) return { files, emptyDirs }
  // 返回该目录子树里是否还有文件（期望或多余都算），用于判定空目录
  function walk(absDir, relDir) {
    let hasFile = false
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const abs = path.join(absDir, entry.name)
      if (entry.isDirectory()) {
        if (walk(abs, rel)) {
          hasFile = true
        } else {
          // 只报最外层的空目录，里面的空子目录随它一起删除
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

function sourceFiles(id) {
  const dir = path.join(pluginsRoot, id)
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'))
  if (manifest.id !== id) throw new Error(`[${id}] plugin.json 中的 id 为 ${manifest.id}`)
  const files = ['plugin.json']
  const icon = String(manifest.icon || 'icon.svg').replace(/^\/+/, '')
  if (fs.existsSync(path.join(dir, icon))) files.push(icon)
  const distDir = path.join(dir, 'dist')
  if (!fs.existsSync(distDir)) throw new Error(`[${id}] 缺少 dist/，请先在 plugins 仓库构建`)
  for (const name of fs.readdirSync(distDir).sort()) {
    if (name.endsWith('.js')) files.push(`dist/${name}`)
  }
  const entry = String(manifest.entry || 'dist/index.js')
  if (!files.includes(entry)) throw new Error(`[${id}] 缺少入口文件 ${entry}`)
  return { dir, files, manifest }
}

if (!fs.existsSync(pluginsRoot)) {
  if (checkOnly || ensureMode) {
    verifyExistingBundledFiles()
    console.log('未找到 ../plugins，已校验本地 public/bundled-plugins 产物完整')
    process.exit(0)
  }
  console.error(`未找到插件源仓库：${pluginsRoot}`)
  process.exit(1)
}

const index = []
let mismatches = 0
// 整个 public/bundled-plugins/ 下应当存在的文件（相对路径，/ 分隔）
const expectedOutFiles = new Set(['index.json'])
for (const id of ids) {
  const { dir, files, manifest } = sourceFiles(id)
  for (const rel of files) expectedOutFiles.add(`${id}/${rel.split(path.sep).join('/')}`)
  for (const rel of files) {
    const src = path.join(dir, rel)
    const dst = path.join(outRoot, id, rel)
    if (checkOnly) {
      if (!isSameFileContent(src, dst)) {
        console.error(`不一致：${id}/${rel}`)
        mismatches++
      }
    } else if (!isSameFileContent(src, dst)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
    }
  }
  index.push({
    id,
    name: manifest.name,
    description: manifest.description || '',
    version: manifest.version || '1.0.0',
    author: manifest.author || 'ZTools Team',
    icon: String(manifest.icon || 'icon.svg').replace(/^\/+/, ''),
    category: manifest.category || [],
    keywords: manifest.keywords || [],
    alias: typeof manifest.alias === 'string' ? manifest.alias : '',
    features: Array.isArray(manifest.features) ? manifest.features : [],
    targets: Array.isArray(manifest.targets) ? manifest.targets : [],
    files
  })
}
const stale = staleBundledEntries(outRoot, expectedOutFiles)
for (const rel of stale.files) {
  if (checkOnly) {
    console.error(`多余：${rel}（同步时会被删除）`)
    mismatches++
  } else {
    fs.rmSync(path.join(outRoot, ...rel.split('/')), { force: true })
  }
}
if (checkOnly) {
  for (const rel of stale.emptyDirs) {
    console.error(`多余：${rel}/（空目录，同步时会被删除）`)
    mismatches++
  }
} else {
  pruneDirsWithoutExpected(outRoot, expectedOutFiles)
}
const indexText = JSON.stringify({ plugins: index }, null, 2) + '\n'
const { storePlugins, ...groups } = officialPluginGroups()
const configText = JSON.stringify({ ...config, ...groups }, null, 2) + '\n'
// 运行时代码读取这个生成的 JS 模块（Vite 与 Node 都能直接 import，不依赖 JSON 导入语法）
const generatedPath = path.join(frontendRoot, 'src/config/bundledPlugins.generated.js')
const generatedText =
  '// 由 scripts/sync-bundled-plugins.mjs 生成，请勿手改；修改内置插件名单请编辑 bundledPlugins.json 后重新运行脚本\n' +
  `export default ${JSON.stringify({ ids, ...groups, storePlugins, plugins: index.map(({ files, ...rest }) => rest) }, null, 2)}\n`
// 主搜索框「直接输入算式出结果」复用内置计算器插件的计算引擎（与插件同一份实现，避免两套算法结果不一致）。
// 计算历史写入计算器插件自己的存储，在计算器插件里也能看到主搜索框算过的式子。
const calculatorEngineSource = path.join(pluginsRoot, 'calculator/dist/calculator-engine.js')
const calculatorEngineOut = path.join(frontendRoot, 'src/vendor/calculator-engine.js')
const ENGINE_STORAGE_IMPORT = 'import { LocalStorage } from "@ztools/declarative-ui";'
const engineSourceText = fs.readFileSync(calculatorEngineSource, 'utf8')
if (!engineSourceText.includes(ENGINE_STORAGE_IMPORT)) throw new Error('计算器引擎的存储导入写法已变化，请同步更新 sync-bundled-plugins.mjs')
const calculatorEngineText =
  '// 由 scripts/sync-bundled-plugins.mjs 从 plugins/calculator/dist/calculator-engine.js 生成，请勿手改\n' +
  engineSourceText.replace(ENGINE_STORAGE_IMPORT, "import { calculatorPluginStorage as LocalStorage } from '../utils/calculatorPluginStorage.js';")

if (checkOnly) {
  if (!fs.existsSync(calculatorEngineOut) || normalizeEol(fs.readFileSync(calculatorEngineOut, 'utf8')) !== normalizeEol(calculatorEngineText)) {
    console.error('不一致：src/vendor/calculator-engine.js')
    mismatches++
  }
  if (normalizeEol(fs.readFileSync(configPath, 'utf8')) !== normalizeEol(configText)) {
    console.error('不一致：src/config/bundledPlugins.json 的 unreleasedOfficialIds / storeOfficialIds')
    mismatches++
  }
  if (!fs.existsSync(generatedPath) || normalizeEol(fs.readFileSync(generatedPath, 'utf8')) !== normalizeEol(generatedText)) {
    console.error('不一致：src/config/bundledPlugins.generated.js')
    mismatches++
  }
  const current = path.join(outRoot, 'index.json')
  if (!fs.existsSync(current) || normalizeEol(fs.readFileSync(current, 'utf8')) !== normalizeEol(indexText)) {
    console.error('不一致：index.json')
    mismatches++
  }
  if (mismatches) {
    console.error(`内置插件副本与 plugins 仓库不一致（${mismatches} 处），请运行 node scripts/sync-bundled-plugins.mjs`)
    process.exit(1)
  }
  console.log(`内置插件副本一致（${ids.length} 个）`)
} else {
  writeTextIfChanged(path.join(outRoot, 'index.json'), indexText)
  writeTextIfChanged(configPath, configText)
  writeTextIfChanged(generatedPath, generatedText)
  writeTextIfChanged(calculatorEngineOut, calculatorEngineText)
  console.log(`已同步 ${ids.length} 个内置插件到 public/bundled-plugins/`)
}

