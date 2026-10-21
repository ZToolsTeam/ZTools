#!/usr/bin/env node

/**
 * prepare-extensions-repo.mjs
 * 生成公开插件仓库 (ZTools-extensions) 的工作树
 *
 * 规范：
 * 1. 独立 MIT License，彻底消除外部贡献者的法律担忧；
 * 2. 导出全部插件到 extensions/（含 official/<id> 作者分组目录与 shared/ 公共源码），不含编译产物 dist/；
 * 3. 附带从源码构建所需的一切：构建脚本、SDK 类型声明、锁定版本的编译器依赖，CI 与本地结果一致；
 * 4. 附带合并前检查与发布流水线（.github/workflows），合并即由 CI 从源码构建并发布到阿里云 OSS + CDN；
 * 5. 导出前扫描密钥，发现疑似真实密钥立即中止。
 *
 * 公开仓库是插件源码的标准（社区 PR 合并在那里）。本脚本会清空目标目录（保留 .git）后重新生成，
 * 目标已是 git 仓库时必须显式加 --overwrite-public，避免冲掉公开仓库里已合并的社区改动。
 *
 * 用法：node scripts/prepare-extensions-repo.mjs [--out <目录>] [--overwrite-public] [--skip-lockfile]
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(__dirname, '..')
const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const targetRoot = outIdx !== -1 && args[outIdx + 1] ? path.resolve(args[outIdx + 1]) : path.resolve(srcRoot, '..', 'ZTools-extensions')
const pluginsSrc = path.join(srcRoot, 'plugins')

// 编译器与扫描器依赖锁定为内部仓库实际使用的版本，保证公开仓库 CI 编译出的产物一致
const DEV_DEPENDENCIES = {
  typescript: '7.0.2',
  '@types/node': '24.3.0',
  acorn: '8.15.0',
  '@babel/parser': '7.28.5'
}
const COPY_SKIP = new Set(['node_modules', 'dist', '.rebuilt', '.build-runs', '.test-runs', '.DS_Store', 'Thumbs.db'])
const copyFilter = (src) => !COPY_SKIP.has(path.basename(src)) && !src.endsWith('.log')

console.log('========================================================')
console.log('     ZTools 插件生态大仓 (ZTools-extensions) 构建工具')
console.log('========================================================')
console.log(`源工程目录:   ${srcRoot}`)
console.log(`插件大仓目录: ${targetRoot}\n`)

if (fs.existsSync(path.join(targetRoot, '.git')) && !args.includes('--overwrite-public')) {
  console.error('❌ 目标目录已是公开插件仓库的 git 仓库。')
  console.error('   公开仓库是插件源码的标准，重新生成会冲掉其中已合并的社区改动。')
  console.error('   确认要用内部仓库覆盖时，加 --overwrite-public 重新运行。')
  process.exit(1)
}

// ---------- 0. 导出前检查 ----------
const sdkDist = path.join(srcRoot, 'packages', 'declarative-ui', 'dist')
if (!fs.existsSync(path.join(sdkDist, 'index.d.ts'))) {
  console.error('❌ 缺少 SDK 类型声明 packages/declarative-ui/dist/index.d.ts，请先在 packages/declarative-ui 运行 npm run build')
  process.exit(1)
}

/** 收集要导出的插件目录（相对 plugins/）：plugins/<id> 与 plugins/<作者>/<id> */
function listExportPlugins() {
  const out = []
  for (const d of fs.readdirSync(pluginsSrc, { withFileTypes: true })) {
    if (!d.isDirectory() || ['node_modules', '.git', 'dist', 'create-plugin', 'shared', 'scripts'].includes(d.name)) continue
    if (fs.existsSync(path.join(pluginsSrc, d.name, 'plugin.json'))) {
      out.push(d.name)
      continue
    }
    for (const e of fs.readdirSync(path.join(pluginsSrc, d.name), { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(pluginsSrc, d.name, e.name, 'plugin.json'))) out.push(`${d.name}/${e.name}`)
    }
  }
  return out.sort()
}

// 疑似真实密钥：命中即中止导出（测试里的占位值如 ghp_1234567890... 不会命中长度要求以外的模式）
const SECRET_PATTERNS = [
  [/LTAI[0-9A-Za-z]{12,30}/, '阿里云 AccessKey ID'],
  [/AKIA[0-9A-Z]{16}/, 'AWS AccessKey ID'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub Token'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/, 'OpenAI 类 API Key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack Token']
]
const PLACEHOLDER = /(1234567890|abcdef|xxxx|example|placeholder|your[_-])/i

function findSecrets(rootDir) {
  const hits = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (COPY_SKIP.has(e.name) || e.name === '.git') continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile() && fs.statSync(p).size < 2 * 1024 * 1024 && !/\.(png|jpe?g|gif|ico|webp|zip|woff2?|ttf)$/i.test(e.name)) {
        const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/)
        lines.forEach((line, i) => {
          for (const [re, label] of SECRET_PATTERNS) {
            const m = line.match(re)
            if (m && !PLACEHOLDER.test(m[0])) hits.push(`${path.relative(rootDir, p)}:${i + 1} ${label}`)
          }
        })
      }
    }
  }
  walk(rootDir)
  return hits
}

const plugins = listExportPlugins()

// ---------- 1. 清空目标目录（保留 .git） ----------
if (fs.existsSync(targetRoot)) {
  console.log('[清理] 清除旧文件（保留 .git 版本库）...')
  for (const item of fs.readdirSync(targetRoot)) {
    if (item === '.git') continue
    fs.rmSync(path.join(targetRoot, item), { recursive: true, force: true })
  }
} else {
  fs.mkdirSync(targetRoot, { recursive: true })
}
for (const d of ['extensions', 'scripts', 'packages', 'assets']) fs.mkdirSync(path.join(targetRoot, d), { recursive: true })

fs.copyFileSync(path.join(srcRoot, 'electron-client/resources/app/app-icon.png'), path.join(targetRoot, 'assets/ztools-logo.png'))

// ---------- 2. LICENSE ----------
const mitLicense = `MIT License

Copyright (c) 2026 ZTools Authors and Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`
fs.writeFileSync(path.join(targetRoot, 'LICENSE'), mitLicense, 'utf8')
console.log('✔ 已生成 MIT LICENSE')

// ---------- 3. package.json ----------
const packageJson = {
  name: '@ztools/extensions',
  version: '1.0.0',
  description: 'ZTools 官方开源插件与生态扩展大仓 | 纯声明式 UI 标准、一键脚手架与 GitOps 自动化分发',
  private: true,
  license: 'MIT',
  workspaces: ['packages/*'],
  scripts: {
    'create-plugin': 'node scripts/create-plugin.mjs',
    build: 'node scripts/build-declarative.mjs --all',
    scan: 'node scripts/scan-plugin-security.mjs extensions',
    verify: 'node scripts/verify-changed-plugins.mjs --base origin/main',
    'verify:all': 'node scripts/verify-changed-plugins.mjs --all',
    test: 'node scripts/verify-changed-plugins.mjs --base origin/main'
  },
  devDependencies: DEV_DEPENDENCIES
}
fs.writeFileSync(path.join(targetRoot, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n', 'utf8')
console.log('✔ 已生成 package.json（锁定编译器版本）')

// ---------- 4. 脚本 ----------
const scripts = [
  ['scripts/create-plugin.mjs', 'scripts/create-plugin.mjs'],
  ['scripts/scan-plugin-security.mjs', 'scripts/scan-plugin-security.mjs'],
  ['scripts/build-plugins-release.mjs', 'scripts/build-plugins-release.mjs'],
  ['scripts/deploy-plugins-storage.mjs', 'scripts/deploy-plugins-storage.mjs'],
  ['scripts/verify-changed-plugins.mjs', 'scripts/verify-changed-plugins.mjs'],
  ['plugins/scripts/build-declarative.mjs', 'scripts/build-declarative.mjs']
]
for (const [from, to] of scripts) fs.copyFileSync(path.join(srcRoot, from), path.join(targetRoot, to))
console.log(`✔ 已植入脚手架、构建、安全扫描、合并前检查与发布脚本（${scripts.length} 个）`)

// ---------- 5. 工作流 ----------
fs.cpSync(path.join(srcRoot, 'scripts', 'extensions-template', '.github'), path.join(targetRoot, '.github'), { recursive: true })
console.log('✔ 已植入合并前检查与发布工作流 (.github/workflows)')

// ---------- 6. 规范包与 SDK 类型声明 ----------
fs.cpSync(path.join(srcRoot, 'packages', 'ztools-plugins-spec'), path.join(targetRoot, 'packages', 'ztools-plugins-spec'), {
  recursive: true,
  filter: copyFilter
})
console.log('✔ 已植入插件规范校验包 (packages/ztools-plugins-spec)')

// SDK：编译用的类型声明 + 跑插件测试用的运行时（MIT，与本仓库同协议；不含内置示例 examples/）。
// 用户安装后插件运行时用的是 ZTools 客户端内置的同一份 SDK，这里的副本只给 CI 编译与测试用。
const sdkSrcPkg = JSON.parse(fs.readFileSync(path.join(srcRoot, 'packages', 'declarative-ui', 'package.json'), 'utf8'))
const sdkDest = path.join(targetRoot, 'packages', 'declarative-ui')
const EXAMPLES_EXPORT = /^export \* from ["']\.\/examples\/index\.js["'];?\r?\n/m
let sdkTypes = 0
let sdkRuntime = 0
for (const rel of fs.readdirSync(sdkDist, { recursive: true })) {
  const relPath = String(rel).replace(/\\/g, '/')
  const isTypes = relPath.endsWith('.d.ts')
  const isRuntime = !isTypes && relPath.endsWith('.js')
  if ((!isTypes && !isRuntime) || relPath.startsWith('examples/')) continue
  let content = fs.readFileSync(path.join(sdkDist, relPath), 'utf8')
  if (relPath === 'index.d.ts' || relPath === 'index.js') content = content.replace(EXAMPLES_EXPORT, '')
  if (/examples\//.test(content.replace(/\/\/.*$/gm, ''))) {
    console.error(`❌ SDK 文件 ${relPath} 仍引用了内置示例 examples/，导出后会找不到模块`)
    process.exit(1)
  }
  fs.mkdirSync(path.dirname(path.join(sdkDest, 'dist', relPath)), { recursive: true })
  fs.writeFileSync(path.join(sdkDest, 'dist', relPath), content, 'utf8')
  if (isTypes) sdkTypes++
  else sdkRuntime++
}
fs.writeFileSync(
  path.join(sdkDest, 'package.json'),
  JSON.stringify(
    {
      name: sdkSrcPkg.name,
      version: sdkSrcPkg.version,
      description: 'ZTools 声明式插件 SDK（类型声明与运行时，供插件编译与测试；用户端运行时由 ZTools 客户端提供）',
      private: true,
      license: sdkSrcPkg.license || 'MIT',
      type: 'module',
      main: sdkSrcPkg.main || './dist/index.js',
      types: './dist/index.d.ts',
      exports: sdkSrcPkg.exports
    },
    null,
    2
  ) + '\n',
  'utf8'
)
fs.writeFileSync(
  path.join(sdkDest, 'README.md'),
  '# @ztools/declarative-ui\n\n插件编译与测试用的 SDK（类型声明与运行时），由内部仓库自动导出，请勿手改。用户安装插件后，运行时由 ZTools 客户端提供。插件统一 `import { List, Action } from "@ztools/declarative-ui"`。\n',
  'utf8'
)
console.log(`✔ 已植入 SDK (packages/declarative-ui，${sdkTypes} 个 .d.ts、${sdkRuntime} 个运行时 .js)`)

// ---------- 7. .gitignore ----------
fs.writeFileSync(
  path.join(targetRoot, '.gitignore'),
  ['node_modules/', '# 编译产物由 CI 从源码构建，不提交', 'extensions/**/dist/', '/dist/', '*.log', '.DS_Store', '*.tmp', '.env*', ''].join('\n'),
  'utf8'
)
console.log('✔ 已生成 .gitignore')

// ---------- 8. 插件源码（不含 dist） ----------
fs.cpSync(path.join(pluginsSrc, 'shared'), path.join(targetRoot, 'extensions', 'shared'), { recursive: true, filter: copyFilter })
for (const rel of plugins) {
  fs.cpSync(path.join(pluginsSrc, rel), path.join(targetRoot, 'extensions', rel), { recursive: true, filter: copyFilter })
}
console.log(`✔ 已导出 ${plugins.length} 款插件源码与 shared/ 公共源码至 extensions/`)

// ---------- 9. README / CONTRIBUTING ----------
// 公开说明直接复用审核过的模板，避免把内部进度或过期插件统计重新写入公开仓库。
for (const name of ['README.md', 'CONTRIBUTING.md']) {
  fs.copyFileSync(path.join(srcRoot, 'scripts', 'extensions-template', name), path.join(targetRoot, name))
}
console.log('✔ 已复制 README.md 与 CONTRIBUTING.md')

// ---------- 10. 密钥扫描 ----------
const secrets = findSecrets(targetRoot)
if (secrets.length > 0) {
  console.error('\n❌ 导出内容里发现疑似真实密钥，已中止（目标目录内容不完整，切勿提交）：')
  for (const s of secrets) console.error(`   - ${s}`)
  process.exit(1)
}
console.log('✔ 密钥扫描通过')

// ---------- 11. 锁定依赖 ----------
if (!args.includes('--skip-lockfile')) {
  try {
    execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: targetRoot, stdio: 'inherit', shell: process.platform === 'win32' })
    console.log('✔ 已生成 package-lock.json（CI 使用 npm ci 安装完全相同的依赖）')
  } catch (err) {
    console.error(`❌ 生成 package-lock.json 失败：${err.message}`)
    process.exit(1)
  }
}

console.log('\n========================================================')
console.log(`插件大仓准备完毕，位于: ${targetRoot}`)
console.log('========================================================\n')
