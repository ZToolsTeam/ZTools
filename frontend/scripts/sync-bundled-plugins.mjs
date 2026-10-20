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

/** plugins 仓库里除内置插件外的其余官方插件：尚未完成真实实现，客户端一律隐藏 */
function unreleasedOfficialIds() {
  const out = []
  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = path.join(pluginsRoot, entry.name, 'plugin.json')
    if (!fs.existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    const author = String(typeof manifest.author === 'string' ? manifest.author : manifest.author?.name || '').trim().toLowerCase()
    if (manifest.id && OFFICIAL_AUTHORS.has(author) && !ids.includes(manifest.id)) out.push(manifest.id)
  }
  return out.sort()
}
const checkOnly = process.argv.includes('--check')

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
  if (checkOnly) {
    console.log('未找到 ../plugins，跳过一致性校验')
    process.exit(0)
  }
  console.error(`未找到插件源仓库：${pluginsRoot}`)
  process.exit(1)
}

const index = []
let mismatches = 0
if (!checkOnly) fs.rmSync(outRoot, { recursive: true, force: true })
for (const id of ids) {
  const { dir, files, manifest } = sourceFiles(id)
  for (const rel of files) {
    const src = path.join(dir, rel)
    const dst = path.join(outRoot, id, rel)
    if (checkOnly) {
      if (!fs.existsSync(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst))) {
        console.error(`不一致：${id}/${rel}`)
        mismatches++
      }
    } else {
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
    files
  })
}
const indexText = JSON.stringify({ plugins: index }, null, 2) + '\n'
const configText = JSON.stringify({ ...config, unreleasedOfficialIds: unreleasedOfficialIds() }, null, 2) + '\n'
// 运行时代码读取这个生成的 JS 模块（Vite 与 Node 都能直接 import，不依赖 JSON 导入语法）
const generatedPath = path.join(frontendRoot, 'src/config/bundledPlugins.generated.js')
const generatedText =
  '// 由 scripts/sync-bundled-plugins.mjs 生成，请勿手改；修改内置插件名单请编辑 bundledPlugins.json 后重新运行脚本\n' +
  `export default ${JSON.stringify({ ids, unreleasedOfficialIds: unreleasedOfficialIds(), plugins: index.map(({ files, ...rest }) => rest) }, null, 2)}\n`
if (checkOnly) {
  if (fs.readFileSync(configPath, 'utf8') !== configText) {
    console.error('不一致：src/config/bundledPlugins.json 的 unreleasedOfficialIds')
    mismatches++
  }
  if (!fs.existsSync(generatedPath) || fs.readFileSync(generatedPath, 'utf8') !== generatedText) {
    console.error('不一致：src/config/bundledPlugins.generated.js')
    mismatches++
  }
  const current = path.join(outRoot, 'index.json')
  if (!fs.existsSync(current) || fs.readFileSync(current, 'utf8') !== indexText) {
    console.error('不一致：index.json')
    mismatches++
  }
  if (mismatches) {
    console.error(`内置插件副本与 plugins 仓库不一致（${mismatches} 处），请运行 node scripts/sync-bundled-plugins.mjs`)
    process.exit(1)
  }
  console.log(`内置插件副本一致（${ids.length} 个）`)
} else {
  fs.writeFileSync(path.join(outRoot, 'index.json'), indexText)
  fs.writeFileSync(configPath, configText)
  fs.writeFileSync(generatedPath, generatedText)
  console.log(`已同步 ${ids.length} 个内置插件到 public/bundled-plugins/`)
}
