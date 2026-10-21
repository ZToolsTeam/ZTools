#!/usr/bin/env node

/**
 * sync-release.mjs
 * ZTools 开源双仓自动化同步与发布执行器 (Zero-Command AI Release Pipeline)
 *
 * 用法：
 *   node scripts/sync-release.mjs [oss|extensions|all] [--msg "自定义提交信息"] [--overwrite-public]
 *
 * 插件大仓（extensions）以公开仓库为准，社区 PR 在那里合并；从内部仓库重新生成会冲掉这些改动，
 * 所以同步插件大仓必须显式加 --overwrite-public（导出脚本会拒绝无此参数的覆盖）。
 */

import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { syncChangelogFromGit } from './update-changelog.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
let target = 'all'
let customMsg = ''
let pushOnly = false
let overwritePublic = false

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (['oss', 'extensions', 'all'].includes(arg.toLowerCase())) {
    target = arg.toLowerCase()
  } else if (arg === '--msg' && args[i + 1]) {
    customMsg = args[++i]
  } else if (arg === '--push-only') {
    pushOnly = true
  } else if (arg === '--overwrite-public') {
    overwritePublic = true
  }
}

function run(cmd, cwd = rootDir) {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim()
}

function loadEnvLocal() {
  const envPath = path.join(rootDir, '.env.local')
  const env = {}
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx > 0) {
        env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
      }
    }
  }
  return env
}

const localEnv = loadEnvLocal()

function ensureGiteeRemote(repoDir, giteeUrl) {
  if (!giteeUrl) return false
  const remotes = run('git remote', repoDir).split(/\r?\n/).map((s) => s.trim())
  const token = process.env.GITEE_TOKEN || localEnv.GITEE_TOKEN || ''
  const user = process.env.GITEE_USER || localEnv.GITEE_USER || 'hoposky'
  let authUrl = giteeUrl
  if (token && giteeUrl.startsWith('https://gitee.com/')) {
    authUrl = giteeUrl.replace('https://gitee.com/', `https://${user}:${token}@gitee.com/`)
  }
  if (!remotes.includes('gitee')) {
    run(`git remote add gitee "${authUrl}"`, repoDir)
  } else if (token) {
    run(`git remote set-url gitee "${authUrl}"`, repoDir)
  }
  return true
}

function ensureGithubRemoteWithGhToken(repoDir, githubUrl) {
  if (!githubUrl || !githubUrl.startsWith('https://github.com/')) return
  const ghCandidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'bin', 'gh.exe'),
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    'gh'
  ]
  for (const ghBin of ghCandidates) {
    try {
      if (ghBin !== 'gh' && !fs.existsSync(ghBin)) continue
      const token = execSync(`"${ghBin}" auth token`, { cwd: repoDir, stdio: 'pipe', encoding: 'utf8' }).trim()
      if (token) {
        const authUrl = githubUrl.replace('https://github.com/', `https://x-access-token:${token}@github.com/`) +
          (githubUrl.endsWith('.git') ? '' : '.git')
        run(`git remote set-url origin "${authUrl}"`, repoDir)
        return
      }
    } catch {
      // 忽略并尝试下一个候选
    }
  }
}

function pushToRemotes(repoDir, name, githubUrl, giteeUrl) {
  console.log(`⏳ 正在推送至 GitHub (${githubUrl}) main 分支...`)
  ensureGithubRemoteWithGhToken(repoDir, githubUrl)
  run('git push origin main', repoDir)
  const latestSha = run('git rev-parse --short HEAD', repoDir)
  console.log(`🎉 [GitHub 同步成功] ${name} 已推送至 GitHub！最新版本: ${latestSha}`)

  if (giteeUrl && ensureGiteeRemote(repoDir, giteeUrl)) {
    console.log(`⏳ 正在同步推送至 Gitee (${giteeUrl}) main 分支...`)
    run('git push gitee main --force', repoDir)
    console.log(`🎉 [Gitee 同步成功] ${name} 已推送至 Gitee！最新版本: ${latestSha}`)
  }
}

function syncRepo({ name, repoDir, prepareScript, prepareArgs = [], commitPrefix, githubUrl, giteeUrl, isOss = false }) {
  console.log(`\n========================================================`)
  console.log(`🚀 开始同步: ${name}`)
  console.log(`   目标目录: ${repoDir}`)
  console.log(`   GitHub 仓库: ${githubUrl}`)
  if (giteeUrl) {
    console.log(`   Gitee 仓库:  ${giteeUrl}`)
  }
  console.log(`========================================================`)

  if (pushOnly) {
    console.log(`[仅推送模式] 跳过从当前项目抽取代码，直接推送现成 ${repoDir} 仓库至 GitHub & Gitee...`)
    pushToRemotes(repoDir, name, githubUrl, giteeUrl)
    return
  }

  // 0. 自动同步追加 CHANGELOG.md
  if (isOss) {
    try {
      const clResult = syncChangelogFromGit({ rootDir })
      if (clResult.addedCount > 0) {
        console.log(`📋 [更新日志] 已自动追加 ${clResult.addedCount} 条最新提交至 CHANGELOG.md`)
      } else {
        console.log(`📋 [更新日志] CHANGELOG.md 已包含最新公开变更记录`)
      }
    } catch (err) {
      console.warn(`⚠ [更新日志] 自动同步 CHANGELOG.md 跳过: ${err.message}`)
    }
  }

  // 1. 执行脱敏抽取
  console.log(`[步骤 1/3] 正在抽取最新纯净源码...`)
  try {
    execSync(`node "${prepareScript}" ${prepareArgs.join(' ')}`.trim(), { cwd: rootDir, stdio: 'inherit' })
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
    console.log(`✔ [无需新提交] ${name} 本地开源镜像无新增文件变更，正在确保 GitHub / Gitee 双远端对齐...`)
    try {
      pushToRemotes(repoDir, name, githubUrl, giteeUrl)
    } catch (err) {
      console.error(`❌ [推送失败] ${err.message}`)
      process.exit(1)
    }
    return
  }

  const changedLines = status.split('\n').filter(Boolean)
  console.log(`✔ 发现 ${changedLines.length} 处变更:`)
  changedLines.slice(0, 5).forEach((line) => console.log(`   ${line}`))
  if (changedLines.length > 5) {
    console.log(`   ... 及其余 ${changedLines.length - 5} 个文件`)
  }

  // 3. 提交与推送（默认同时推送 GitHub 与 Gitee）
  console.log(`\n[步骤 3/3] 提交并同时推送到 GitHub 与 Gitee...`)
  const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19)
  const defaultMsg = `${commitPrefix}: 同步最新开源版本变更 (${dateStr})`
  const commitMsg = customMsg ? `${commitPrefix}: ${customMsg}` : defaultMsg

  try {
    run(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, repoDir)
    console.log(`✔ Commit 成功: "${commitMsg}"`)

    pushToRemotes(repoDir, name, githubUrl, giteeUrl)
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
    githubUrl: 'https://github.com/ZToolsTeam/ZTools',
    giteeUrl: 'https://gitee.com/hoposky/ZTools.git',
    isOss: true
  },
  extensions: {
    name: 'ZTools 插件生态大仓 (MIT)',
    repoDir: path.resolve(rootDir, '..', 'ZTools-extensions'),
    prepareScript: path.join(rootDir, 'scripts', 'prepare-extensions-repo.mjs'),
    prepareArgs: overwritePublic ? ['--overwrite-public'] : [],
    commitPrefix: 'feat(ecosystem)',
    githubUrl: 'https://github.com/ZToolsTeam/ZTools-extensions'
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
