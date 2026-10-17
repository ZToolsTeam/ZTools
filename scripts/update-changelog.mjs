#!/usr/bin/env node

/**
 * update-changelog.mjs
 * ZTools 标准更新日志 (CHANGELOG.md) 自动追加与归档工具
 *
 * 采用业界标准方案：Keep a Changelog (https://keepachangelog.com/zh-CN/1.1.0/) + Conventional Commits
 *
 * 核心能力：
 * 1. 自动扫描自上次同步锚点 (<!-- last-synced-commit: <sha> -->) 以来的新增 Git 提交（含开源子模块）；
 * 2. 严格执行商业安全过滤：自动剔除涉及 DLLPlugins / backend / installer / official-website 等私有模块的提交记录，以及纯子模块指针同步噪音；
 * 3. 按 Conventional Commits 规范自动归类为：
 *    - ✨ 新增特性 (Features)
 *    - 🐛 问题修复 (Bug Fixes)
 *    - ⚡ 体验优化与重构 (Improvements)
 *    - 📝 文档与工程基建 (Chores & Docs)
 * 4. 幂等追加：同日期（或同版本）自动归并去重，跨日期自动在顶部插入新日期章节，更新锚点防止重复写入。
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..')
export const DEFAULT_CHANGELOG_PATH = path.join(DEFAULT_ROOT_DIR, 'CHANGELOG.md')

const PRIVATE_SCOPE_OR_KEYWORD_PATTERNS = [
  /^(?:feat|fix|chore|refactor|docs|test|perf)\((?:website|backend|dll|installer|bin|admin|changelog)\):/i,
  /\b(?:DLLPlugins|ZToolsSetup|ZToolsUninstall|suno-copyright|official-website)\b/i,
  /^chore(?:\([^)]+\))?:\s*同步\s*(?:frontend|electron-client|官方网站|docs|bin|子模块)/i,
  /^chore(?:\([^)]+\))?:\s*更新官方网站子模块/i,
  /^chore\(release\):\s*同步最新开源版本变更/i
]

const CATEGORY_MAP = {
  feat: '### ✨ 新增特性 (Features)',
  fix: '### 🐛 问题修复 (Bug Fixes)',
  perf: '### ⚡ 体验优化与重构 (Improvements)',
  refactor: '### ⚡ 体验优化与重构 (Improvements)',
  docs: '### 📝 文档与工程基建 (Chores & Docs)',
  test: '### 📝 文档与工程基建 (Chores & Docs)',
  chore: '### 📝 文档与工程基建 (Chores & Docs)'
}

const CATEGORY_ORDER = [
  '### ✨ 新增特性 (Features)',
  '### 🐛 问题修复 (Bug Fixes)',
  '### ⚡ 体验优化与重构 (Improvements)',
  '### 📝 文档与工程基建 (Chores & Docs)'
]

/**
 * 判断某条提交说明是否属于商业私有资产或纯指针同步噪音，需要在公开 CHANGELOG 中剔除
 */
export function shouldExcludeCommitFromPublicChangelog(subject) {
  if (!subject || typeof subject !== 'string') return true
  const trimmed = subject.trim()
  if (!trimmed) return true
  if (/^Merge\s+(?:branch|pull request|remote-tracking)/i.test(trimmed)) return true
  return PRIVATE_SCOPE_OR_KEYWORD_PATTERNS.some((pattern) => pattern.test(trimmed))
}

/**
 * 解析 Conventional Commit 提交标题
 */
export function parseConventionalCommit(rawCommit) {
  if (!rawCommit || typeof rawCommit !== 'object') {
    throw new TypeError('提交记录对象不能为空')
  }
  const sha = String(rawCommit.sha ?? '').trim()
  const date = String(rawCommit.date ?? '').trim()
  const subject = String(rawCommit.subject ?? '').trim()

  if (!sha || !/^[0-9a-f]{6,40}$/i.test(sha)) {
    throw new Error(`非法提交 SHA: "${sha}"`)
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`非法提交日期格式 (需为 YYYY-MM-DD): "${date}"`)
  }
  if (!subject) {
    throw new Error('提交标题不能为空')
  }

  const match = /^([a-zA-Z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/.exec(subject)
  let type = 'chore'
  let scope = ''
  let description = subject

  if (match) {
    type = match[1].toLowerCase()
    scope = match[2] ? match[2].trim() : ''
    description = match[3].trim()
  }

  const categoryHeader = CATEGORY_MAP[type] || CATEGORY_MAP.chore
  const shortSha = sha.slice(0, 7)
  const formattedLine = scope && !['core', 'electron', 'frontend', 'client'].includes(scope.toLowerCase())
    ? `- **${scope}**：${description} (\`${shortSha}\`)`
    : `- ${description} (\`${shortSha}\`)`

  return {
    sha,
    shortSha,
    date,
    type,
    scope,
    description,
    subject,
    categoryHeader,
    formattedLine
  }
}

/**
 * 将一批新的提交记录幂等追加进 CHANGELOG.md 文本内容中
 */
export function appendCommitsToChangelogContent(
  existingContent,
  commits,
  { newHeadSha = '', versionLabel = 'Unreleased' } = {}
) {
  if (typeof existingContent !== 'string' || !existingContent.trim()) {
    throw new Error('CHANGELOG.md 原始内容不能为空')
  }
  if (!Array.isArray(commits)) {
    throw new TypeError('commits 必须为数组')
  }

  const validCommits = []
  const seenDescriptions = new Set()

  for (const item of commits) {
    if (!item || shouldExcludeCommitFromPublicChangelog(item.subject)) {
      continue
    }
    const parsed = parseConventionalCommit(item)
    // 如果 CHANGELOG 中已经包含该短 SHA 或完全一致的描述，则跳过（幂等去重）
    if (
      existingContent.includes(`\`${parsed.shortSha}\``) ||
      existingContent.includes(parsed.description) ||
      seenDescriptions.has(parsed.description)
    ) {
      continue
    }
    seenDescriptions.add(parsed.description)
    validCommits.push(parsed)
  }

  let updatedContent = existingContent

  if (validCommits.length > 0) {
    // 按日期降序分组
    const byDate = new Map()
    for (const c of validCommits) {
      if (!byDate.has(c.date)) {
        byDate.set(c.date, new Map())
      }
      const catMap = byDate.get(c.date)
      if (!catMap.has(c.categoryHeader)) {
        catMap.set(c.categoryHeader, [])
      }
      catMap.get(c.categoryHeader).push(c.formattedLine)
    }

    const sortedDates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a))

    for (const date of sortedDates) {
      const catMap = byDate.get(date)
      // 检查是否已有当天的章节标题 (如 ## [Unreleased / 2026-10-17] 或 ## [v...] - 2026-10-17)
      const existingSectionRegex = new RegExp(
        `(^## \\[[^\\]]*${date}[^\\]]*\\][^\\r\\n]*|^## \\[[^\\]]+\\]\\s*-\\s*${date}[^\\r\\n]*)`,
        'm'
      )
      const sectionMatch = existingSectionRegex.exec(updatedContent)

      if (sectionMatch) {
        // 已有当天章节：寻找对应分类或在该章节顶部插入
        const sectionStartIdx = sectionMatch.index
        const afterHeadingIdx = sectionStartIdx + sectionMatch[0].length
        const restAfterHeading = updatedContent.slice(afterHeadingIdx)
        const nextSectionMatch = /\n---\r?\n|\n## \[/.exec(restAfterHeading)
        const sectionBodyEndOffset = nextSectionMatch
          ? afterHeadingIdx + nextSectionMatch.index
          : updatedContent.length
        let sectionBody = updatedContent.slice(afterHeadingIdx, sectionBodyEndOffset)

        for (const categoryHeader of CATEGORY_ORDER) {
          const lines = catMap.get(categoryHeader)
          if (!lines || lines.length === 0) continue

          const catIdx = sectionBody.indexOf(categoryHeader)
          if (catIdx !== -1) {
            const catHeadingEnd = catIdx + categoryHeader.length
            sectionBody =
              sectionBody.slice(0, catHeadingEnd) +
              '\n' +
              lines.join('\n') +
              sectionBody.slice(catHeadingEnd)
          } else {
            sectionBody = `\n\n${categoryHeader}\n${lines.join('\n')}` + sectionBody
          }
        }

        updatedContent =
          updatedContent.slice(0, afterHeadingIdx) +
          sectionBody +
          updatedContent.slice(sectionBodyEndOffset)
      } else {
        // 没有当天章节：构造全新章节并插入到 <!-- last-synced-commit: ... --> 之后或第一个 ## [ 之前
        const blockLines = [`## [${versionLabel} / ${date}] - 持续迭代更新`, '']
        for (const categoryHeader of CATEGORY_ORDER) {
          const lines = catMap.get(categoryHeader)
          if (!lines || lines.length === 0) continue
          blockLines.push(categoryHeader)
          blockLines.push(...lines)
          blockLines.push('')
        }
        blockLines.push('---', '')
        const newSectionText = blockLines.join('\n')

        const firstH2Idx = updatedContent.indexOf('\n## [')
        if (firstH2Idx !== -1) {
          updatedContent =
            updatedContent.slice(0, firstH2Idx + 1) +
            newSectionText +
            '\n' +
            updatedContent.slice(firstH2Idx + 1)
        } else {
          updatedContent = updatedContent.trimEnd() + '\n\n' + newSectionText + '\n'
        }
      }
    }
  }

  // 更新 <!-- last-synced-commit: <sha> --> 锚点
  if (newHeadSha && /^[0-9a-f]{6,40}$/i.test(newHeadSha)) {
    const shortHead = newHeadSha.slice(0, 7)
    if (/<!--\s*last-synced-commit:\s*[0-9a-f]+\s*-->/i.test(updatedContent)) {
      updatedContent = updatedContent.replace(
        /<!--\s*last-synced-commit:\s*[0-9a-f]+\s*-->/i,
        `<!-- last-synced-commit: ${shortHead} -->`
      )
    }
  }

  return {
    content: updatedContent,
    addedCount: validCommits.length,
    addedCommits: validCommits
  }
}

function gitLogSince(repoDir, sinceSha) {
  if (!fs.existsSync(path.join(repoDir, '.git'))) return []
  try {
    let rangeCmd = 'git log -n 10 --pretty=format:"%h|%ad|%s" --date=short'
    if (sinceSha) {
      // 检查 sinceSha 是否存在于当前仓库
      try {
        execSync(`git cat-file -t ${sinceSha}`, { cwd: repoDir, stdio: 'pipe' })
        rangeCmd = `git log ${sinceSha}..HEAD --pretty=format:"%h|%ad|%s" --date=short`
      } catch {
        rangeCmd = 'git log -n 5 --pretty=format:"%h|%ad|%s" --date=short'
      }
    }
    const raw = execSync(rangeCmd, { cwd: repoDir, stdio: 'pipe', encoding: 'utf8' }).trim()
    if (!raw) return []
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, date, ...rest] = line.split('|')
        return { sha: sha.trim(), date: date.trim(), subject: rest.join('|').trim() }
      })
  } catch {
    return []
  }
}

/**
 * 从当前 Git 仓库（含 electron-client、frontend 开源子模块最近提交）同步最新记录到 CHANGELOG.md
 */
export function syncChangelogFromGit({
  rootDir = DEFAULT_ROOT_DIR,
  changelogPath = path.join(rootDir, 'CHANGELOG.md'),
  extraCommit = null
} = {}) {
  if (!fs.existsSync(changelogPath)) {
    throw new Error(`未找到 CHANGELOG.md 文件: ${changelogPath}`)
  }

  const existingContent = fs.readFileSync(changelogPath, 'utf8')
  const markerMatch = /<!--\s*last-synced-commit:\s*([0-9a-f]+)\s*-->/i.exec(existingContent)
  const lastSha = markerMatch ? markerMatch[1] : ''

  let currentHeadSha = ''
  try {
    currentHeadSha = execSync('git rev-parse --short HEAD', {
      cwd: rootDir,
      stdio: 'pipe',
      encoding: 'utf8'
    }).trim()
  } catch {
    currentHeadSha = lastSha
  }

  const rootCommits = lastSha && lastSha === currentHeadSha ? [] : gitLogSince(rootDir, lastSha)
  const allCandidateCommits = [...rootCommits]

  if (extraCommit && extraCommit.sha && extraCommit.date && extraCommit.subject) {
    allCandidateCommits.unshift(extraCommit)
  }

  const result = appendCommitsToChangelogContent(existingContent, allCandidateCommits, {
    newHeadSha: currentHeadSha || lastSha
  })

  if (result.content !== existingContent) {
    fs.writeFileSync(changelogPath, result.content, 'utf8')
  }

  return result
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase()

if (isMainModule) {
  try {
    const res = syncChangelogFromGit()
    console.log(
      `✔ CHANGELOG.md 同步完成（本次新增 ${res.addedCount} 条公开变更记录）。`
    )
  } catch (err) {
    console.error(`❌ CHANGELOG.md 同步失败: ${err.message}`)
    process.exit(1)
  }
}
