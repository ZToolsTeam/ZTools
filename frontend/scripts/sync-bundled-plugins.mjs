#!/usr/bin/env node
/**
 * 把 src/config/bundledPlugins.json 中列出的官方插件构建产物同步到 public/bundled-plugins/
 *
 *   node scripts/sync-bundled-plugins.mjs          从 ../plugins/<id>/ 复制 plugin.json、icon.svg、dist/*.js
 *   node scripts/sync-bundled-plugins.mjs --check  只校验已同步的副本与源仓库一致，不一致时退出码为 1
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
 * plugins 仓库里除内置插件外的其余官方插件，按 plugin.json 的 draft 字段分成两类：
 *   - 草稿（draft: true，功能没做完，不会发布到插件目录）：客户端一律隐藏；
 *   - 其余：通过插件市场（CDN 插件目录）分发，用户安装后正常显示。
 * 插件目录在 plugins/<id>，作者分组的官方插件在 plugins/official/<id>。
 */
function officialPluginGroups() {
  const draft = []
  const store = []
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
    if (!manifest.id || !OFFICIAL_AUTHORS.has(author) || ids.includes(manifest.id)) continue
    ;(manifest.draft === true ? draft : store).push(manifest.id)
  }
  return { unreleasedOfficialIds: draft.sort(), storeOfficialIds: store.sort() }
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
for (const id of ids) {
  const { dir, files, manifest } = sourceFiles(id)
  const expectedSet = new Set(files.map((f) => path.normalize(f)))
  const pluginOutDir = path.join(outRoot, id)
  if (!checkOnly && fs.existsSync(pluginOutDir)) {
    for (const sub of ['', 'dist']) {
      const targetSub = path.join(pluginOutDir, sub)
      if (!fs.existsSync(targetSub)) continue
      for (const entry of fs.readdirSync(targetSub, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        const relPath = path.normalize(sub ? `${sub}/${entry.name}` : entry.name)
        if (!expectedSet.has(relPath)) {
          fs.rmSync(path.join(pluginOutDir, relPath), { force: true })
        }
      }
    }
  }
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
    targets: Array.isArray(manifest.targets) ? manifest.targets : [],
    files
  })
}
const indexText = JSON.stringify({ plugins: index }, null, 2) + '\n'
const groups = officialPluginGroups()
const configText = JSON.stringify({ ...config, ...groups }, null, 2) + '\n'
// 运行时代码读取这个生成的 JS 模块（Vite 与 Node 都能直接 import，不依赖 JSON 导入语法）
const generatedPath = path.join(frontendRoot, 'src/config/bundledPlugins.generated.js')
const generatedText =
  '// 由 scripts/sync-bundled-plugins.mjs 生成，请勿手改；修改内置插件名单请编辑 bundledPlugins.json 后重新运行脚本\n' +
  `export default ${JSON.stringify({ ids, ...groups, plugins: index.map(({ files, ...rest }) => rest) }, null, 2)}\n`
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

