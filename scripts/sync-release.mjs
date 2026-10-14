#!/usr/bin/env node

/**
 * sync-release.mjs
 * ZTools 开源双仓自动化同步与发布执行器 (Zero-Command AI Release Pipeline)
 *
 * 用法：
 *   node scripts/sync-release.mjs [oss|extensions|all] [--msg "自定义提交信息"]
 */

import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
let target = 'all'
let customMsg = ''

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (['oss', 'extensions', 'all'].includes(arg.toLowerCase())) {
    target = arg.toLowerCase()
  } else if (arg === '--msg' && args[i + 1]) {
    customMsg = args[++i]
  }
}

function run(cmd, cwd = rootDir) {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
}

function syncRepo({ name, repoDir, prepareScript, commitPrefix, githubUrl }) {
  console.log(`\n========================================================`)
  console.log(`🚀 开始同步: ${name}`)
  console.log(`   目标目录: ${repoDir}`)
  console.log(`   开源仓库: ${githubUrl}`)
  console.log(`========================================================`)

  // 1. 执行脱敏抽取
  console.log(`[步骤 1/3] 正在抽取最新纯净源码...`)
  try {
    execSync(`node "${prepareScript}"`, { cwd: rootDir, stdio: 'inherit' })
  } catch (err) {
    console.error(`❌ [失败] 源码抽取中断: ${err.message}`)
    process.exit(1)
  }

  // 2. 检查 Git 仓库状态
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    console.error(`❌ [错误] 目标目录 ${repoDir} 不是一个有效的 Git 仓库！`)
    process.exit(1)
  }

  console.log(`\n[步骤 2/3] 检查变更状态...`)
  run('git add -A .', repoDir)
  const status = run('git status --porcelain', repoDir)

  if (!status) {
    console.log(`✔ [无需提交] ${name} 代码已与当前工程保持 100% 深度同步，无未提交变更。`)
    return
  }

  const changedLines = status.split('\n').filter(Boolean)
  console.log(`✔ 发现 ${changedLines.length} 处变更:`)
  changedLines.slice(0, 5).forEach((line) => console.log(`   ${line}`))
  if (changedLines.length > 5) {
    console.log(`   ... 及其余 ${changedLines.length - 5} 个文件`)
  }

  // 3. 提交与推送
  console.log(`\n[步骤 3/3] 提交并推送到 GitHub...`)
  const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19)
  const defaultMsg = `${commitPrefix}: 同步最新开源版本变更 (${dateStr})`
  const commitMsg = customMsg ? `${commitPrefix}: ${customMsg}` : defaultMsg

  try {
    run(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, repoDir)
    console.log(`✔ Commit 成功: "${commitMsg}"`)

    console.log(`⏳ 正在推送至 ${githubUrl} main 分支...`)
    run('git push origin main', repoDir)
    const latestSha = run('git rev-parse --short HEAD', repoDir)
    console.log(`🎉 [同步成功] ${name} 已推送至 GitHub！最新版本: ${latestSha}`)
  } catch (err) {
    console.error(`❌ [推送失败] ${err.message}`)
    process.exit(1)
  }
}

const TASKS = {
  oss: {
    name: 'ZTools 核心宿主 (GPL-3.0)',
    repoDir: path.resolve(rootDir, '..', 'ZTools-opensource'),
    prepareScript: path.join(rootDir, 'scripts', 'prepare-opensource-release.mjs'),
    commitPrefix: 'chore(release)',
    githubUrl: 'https://github.com/codingmuse/ZTools'
  },
  extensions: {
    name: 'ZTools 插件生态大仓 (MIT)',
    repoDir: path.resolve(rootDir, '..', 'ZTools-extensions'),
    prepareScript: path.join(rootDir, 'scripts', 'prepare-extensions-repo.mjs'),
    commitPrefix: 'feat(ecosystem)',
    githubUrl: 'https://github.com/codingmuse/ZTools-extensions'
  }
}

if (target === 'oss' || target === 'all') {
  syncRepo(TASKS.oss)
}

if (target === 'extensions' || target === 'all') {
  syncRepo(TASKS.extensions)
}

console.log(`\n========================================================`)
console.log(`✨ 全部发布任务执行完毕！`)
console.log(`========================================================\n`)
