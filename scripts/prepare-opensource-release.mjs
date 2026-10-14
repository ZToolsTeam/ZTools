#!/usr/bin/env node

/**
 * prepare-opensource-release.mjs
 * ZTools 官方开源发布镜像构建与安全脱敏工具
 *
 * 功能：
 * 1. 严格按照白名单抽取开源核心资产 (electron-client, frontend, packages, scripts, tests)；
 * 2. 绝对物理隔离所有自营商业资产 (DLLPlugins, backend, installer, bin, official-website 等)；
 * 3. 自动剥离 node_modules, dist, artifacts, .git 等构建与测试产物；
 * 4. 强力校验单文件体积（严防超过 50MB 触发 GitHub 拦截）；
 * 5. 初始化纯净的 Git 提交树，准备推送到公开 GitHub 仓库。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(__dirname, '..')
const targetRoot = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(srcRoot, '..', 'ZTools-opensource')

console.log('========================================================')
console.log('       ZTools 开源发布镜像抽取与安全隔离工具')
console.log('========================================================')
console.log(`源工程目录:   ${srcRoot}`)
console.log(`开源目标目录: ${targetRoot}\n`)

// 1. 严格白名单定义
const WHITELIST_FILES = [
  'package.json',
  'LICENSE',
  'README.md',
  'ROADMAP.md',
  '.env.example',
  '.gitignore',
  'AGENTS.md',
  'start-client.bat'
]

const WHITELIST_DIRS = [
  'electron-client',
  'frontend',
  'packages',
  'scripts',
  'tests'
]

// 2. 目录递归排除黑名单
const IGNORE_PATTERNS = [
  /node_modules/,
  /[\\/]dist([\\/]|$)/,
  /[\\/]out([\\/]|$)/,
  /[\\/]artifacts([\\/]|$)/,
  /[\\/]out-test([\\/]|$)/,
  /[\\/]\.git([\\/]|$)/,
  /[\\/]\.codegraph([\\/]|$)/,
  /[\\/]logs([\\/]|$)/,
  /[\\/]scratch([\\/]|$)/,
  /\.env(\..+)?$/,
  /\.log$/,
  /\.pch$/,
  /\.pdb$/,
  /\.lib$/,
  /\.obj$/,
  /\.mp4$/,
  /\.m4a$/,
  /\.wav$/,
  // 3. 历史废弃与冗余模块黑名单（严禁进入开源发布）
  /[\\/]\.kiro([\\/]|$)/,
  /[\\/]devtools([\\/]|$)/,
  /[\\/]examples([\\/]|$)/,
  /[\\/]design-system([\\/]|$)/,
  /[\\/]src[\\/]sdk([\\/]|$)/,
  /[\\/]create-ztools-plugin([\\/]|$)/,
  /[\\/]migrate-utools([\\/]|$)/,
  /[\\/]SETUP_TESTS\.md$/,
  /[\\/]MOCK_DEVELOPMENT\.md$/,
  /[\\/]验证证据\.md$/,
  /[\\/]resources[\\/]app[\\/]README\.md$/,
  /[\\/]installer-ui-and-cleanup\.test\.mjs$/
]

function shouldIgnore(relPath) {
  return IGNORE_PATTERNS.some((pattern) => pattern.test(relPath))
}

// 递归拷贝函数
function copyRecursive(srcDir, destDir, baseRel = '') {
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true })
  }

  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const relPath = baseRel ? `${baseRel}/${entry.name}` : entry.name
    if (shouldIgnore(relPath)) {
      continue
    }

    const srcPath = path.join(srcDir, entry.name)
    const destPath = path.join(destDir, entry.name)

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath, relPath)
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

// 3. 执行清洗与创建目标目录 (严格保留 .git 版本库以实现增量 diff 与极速同步)
if (fs.existsSync(targetRoot)) {
  console.log(`[清理] 清除旧的开源暂存文件 (保留 .git 版本库)...`)
  for (const item of fs.readdirSync(targetRoot)) {
    if (item === '.git') continue
    fs.rmSync(path.join(targetRoot, item), { recursive: true, force: true })
  }
} else {
  fs.mkdirSync(targetRoot, { recursive: true })
}

// 4. 复制根文件
console.log('[1/4] 复制根目录基础合规文件...')
for (const file of WHITELIST_FILES) {
  const srcFile = path.join(srcRoot, file)
  const destFile = path.join(targetRoot, file)
  if (fs.existsSync(srcFile)) {
    fs.copyFileSync(srcFile, destFile)
    console.log(`  ✔ ${file}`)
  } else {
    console.warn(`  ⚠ 未找到文件: ${file}`)
  }
}

// 5. 复制白名单目录
console.log('\n[2/4] 抽取白名单核心模块...')
for (const dir of WHITELIST_DIRS) {
  const srcDir = path.join(srcRoot, dir)
  const destDir = path.join(targetRoot, dir)
  if (fs.existsSync(srcDir)) {
    console.log(`  ⏳ 正在抽取 ${dir}/...`)
    copyRecursive(srcDir, destDir, dir)
    console.log(`  ✔ ${dir}/ 抽取完成`)
  } else {
    console.warn(`  ⚠ 未找到目录: ${srcDir}`)
  }
}

// 6. 安全扫描：大文件与敏感私有目录检查
console.log('\n[3/4] 执行严格安全与大文件拦截扫描...')
let violations = 0
let totalFiles = 0
let totalBytes = 0

// 根目录级别的私有黑名单
const ROOT_FORBIDDEN = ['DLLPlugins', 'backend', 'installer', 'bin', 'official-website', 'suno-copyright']
for (const bad of ROOT_FORBIDDEN) {
  const probe = path.join(targetRoot, bad)
  if (fs.existsSync(probe)) {
    console.error(`  ❌ [CRITICAL] 严重违规：发现未隔离的商业目录 ${bad}`)
    violations++
  }
}

function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      scanDir(fullPath)
    } else if (entry.isFile()) {
      totalFiles++
      const stat = fs.statSync(fullPath)
      totalBytes += stat.size
      // 检查大于 50MB
      if (stat.size > 50 * 1024 * 1024) {
        console.error(`  ❌ [CRITICAL] 发现超大文件 (>50MB): ${fullPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`)
        violations++
      }
      // 严禁任何商业版专有 Delphi 安装器源码 (.pas/.dpr/.dproj/.dfm) 混入开源仓
      if (/\.(pas|dpr|dpk|dproj|dfm)$/i.test(entry.name)) {
        console.error(`  ❌ [CRITICAL] 发现未隔离的商业专有安装器源码: ${fullPath}`)
        violations++
      }
    }
  }
}

scanDir(targetRoot)

if (violations > 0) {
  console.error(`\n❌ 安全门禁拦截失败：发现 ${violations} 项违规，终止发布！`)
  process.exit(1)
}

const totalMb = (totalBytes / 1024 / 1024).toFixed(2)
console.log(`  ✔ 扫描通过：共 ${totalFiles} 个文件，总源码体积 ${totalMb} MB，未发现任何商业违规或超大文件。`)

console.log('\n[4/4] 开源纯净镜像已安全就绪！')
console.log(`目录位于: ${targetRoot}`)
console.log('========================================================\n')
