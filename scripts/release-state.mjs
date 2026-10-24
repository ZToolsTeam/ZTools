#!/usr/bin/env node

/**
 * release-state.mjs
 * GitHub Release 状态检查与自动转正（Windows 与 macOS 安装包各自上传后共用）
 *
 * 发版约定：
 *   1. Release 一律先建成「预发布」，用户检查更新与官网 releases/latest 都看不到；
 *   2. Windows（EXE、ZIP）与 macOS（DMG）各自上传完都调用一次 promote：6 个文件齐了才转成正式版，
 *      谁后传完谁负责转正；只有版本号不低于当前正式版时才标成 Latest；
 *   3. 已转正的 Release 不允许再覆盖上传安装包（会和已提交给 winget 的校验值、用户已下载的文件对不上），
 *      真要重发就把版本号第 4 位加 1；确需替换时显式传 --replace-published。
 *
 * 用法（只依赖 Node 内置模块）：
 *   node scripts/release-state.mjs guard   [--tag v<版本>] [--repo owner/repo] [--replace-published]
 *   node scripts/release-state.mjs promote [--tag v<版本>] [--repo owner/repo]
 *   不传 --tag 时取 electron-client/package.json 的版本号。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(__dirname, '..')
export const DEFAULT_GITHUB_REPO = 'ZToolsTeam/ZTools'

const FOUR_PART_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** 发版 tag 只接受 v + 四段式数字版本号，返回去掉 v 的版本号 */
export function versionFromReleaseTag(tag) {
  const str = String(tag ?? '').trim()
  const version = str.startsWith('v') ? str.slice(1) : ''
  if (!FOUR_PART_VERSION.test(version)) {
    throw new Error(`INVALID_RELEASE_TAG: 发版 tag 必须是 v + 四段式数字版本号（例如 v1.1.8.2），当前值: "${str}"`)
  }
  return version
}

/** 一个版本完整发布必须具备的 6 个文件 */
export function expectedReleaseAssetNames(version) {
  return [
    `ZTools-${version}-win32-x64.exe`,
    `ZTools-${version}-win32-x64.exe.sha256`,
    `ZTools-${version}-win32-x64-portable.zip`,
    `ZTools-${version}-win32-x64-portable.zip.sha256`,
    `ZTools-${version}-darwin-universal.dmg`,
    `ZTools-${version}-darwin-universal.dmg.sha256`
  ]
}

/** 按数字逐段比较版本号（容忍 v 前缀与段数不同），a > b 返回正数 */
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? '').replace(/^v/i, '').split('.').map((s) => Number.parseInt(s, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** gh 路径：GH_PATH > Windows 默认安装位置 > PATH 上的 gh（与其它发版脚本一致） */
export function resolveGhExecutable(env = process.env) {
  if (env.GH_PATH && fs.existsSync(env.GH_PATH)) return env.GH_PATH
  const candidate = path.join(env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'bin', 'gh.exe')
  if (env.LOCALAPPDATA && fs.existsSync(candidate)) return candidate
  return 'gh'
}

function runGh(gh, args, runner) {
  const res = runner(gh, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false })
  if (res?.error) throw res.error
  return { status: res?.status ?? 1, stdout: String(res?.stdout ?? ''), stderr: String(res?.stderr ?? '') }
}

function isNotFound(stderr) {
  return /release not found/i.test(stderr)
}

function parseReleaseJson(stdout, label) {
  let data
  try {
    data = JSON.parse(stdout)
  } catch {
    throw new Error(`RELEASE_QUERY_FAILED: ${label} 返回的不是合法 JSON`)
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.assets ?? [])) {
    throw new Error(`RELEASE_QUERY_FAILED: ${label} 返回内容缺少必要字段`)
  }
  return data
}

/**
 * 查询 Release 当前状态。Release 不存在返回 { exists: false }；
 * 网络、鉴权等其它错误直接抛出，绝不当成「不存在」处理（否则会误建或误判）。
 */
export function readReleaseState({ repo = DEFAULT_GITHUB_REPO, tag, gh = 'gh', runner = spawnSync }) {
  versionFromReleaseTag(tag)
  if (!REPO_PATTERN.test(repo)) throw new Error(`INVALID_REPO: 非法 GitHub 仓库标识: ${repo}`)
  const res = runGh(gh, ['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,isPrerelease,assets'], runner)
  if (res.status !== 0) {
    if (isNotFound(res.stderr)) return { exists: false, tag }
    throw new Error(`RELEASE_QUERY_FAILED: 查询 Release ${tag} 失败（退出码 ${res.status}）${res.stderr.trim() ? `：${res.stderr.trim()}` : ''}`)
  }
  const data = parseReleaseJson(res.stdout, `Release ${tag}`)
  if (data.tagName && data.tagName !== tag) {
    throw new Error(`RELEASE_QUERY_FAILED: 查询 ${tag} 却返回了 ${data.tagName}`)
  }
  return {
    exists: true,
    tag,
    isDraft: data.isDraft === true,
    isPrerelease: data.isPrerelease === true,
    assets: (data.assets ?? []).map((a) => ({
      name: String(a?.name ?? ''),
      state: String(a?.state ?? ''),
      size: Number(a?.size ?? 0),
      digest: typeof a?.digest === 'string' ? a.digest : ''
    }))
  }
}

export function isPublishedRelease(state) {
  return Boolean(state?.exists && !state.isDraft && !state.isPrerelease)
}

/** 已转正的 Release 不允许覆盖上传安装包，除非显式确认替换 */
export function assertReleaseWritable(state, { replacePublished = false } = {}) {
  if (isPublishedRelease(state) && !replacePublished) {
    throw new Error(
      `RELEASE_ALREADY_PUBLISHED: Release ${state.tag} 已经是正式版，不能再覆盖上传安装包` +
        '（已下载的用户和 winget 记录的校验值会对不上）。请把版本号第 4 位加 1 重新发版；确需替换时加 --replace-published。'
    )
  }
  return true
}

/** 还没上传完成的文件（上传中断的半成品 state 不是 uploaded，或大小为 0，都算缺失） */
export function missingReleaseAssets(state, version) {
  const ready = new Set((state?.assets ?? []).filter((a) => a.state === 'uploaded' && a.size > 0).map((a) => a.name))
  return expectedReleaseAssetNames(version).filter((name) => !ready.has(name))
}

/** 当前正式版（Latest）的 tag；仓库还没有正式版时返回 null */
export function readLatestReleaseTag({ repo = DEFAULT_GITHUB_REPO, gh = 'gh', runner = spawnSync }) {
  const res = runGh(gh, ['release', 'view', '--repo', repo, '--json', 'tagName'], runner)
  if (res.status !== 0) {
    if (isNotFound(res.stderr)) return null
    throw new Error(`RELEASE_QUERY_FAILED: 查询当前正式版失败（退出码 ${res.status}）${res.stderr.trim() ? `：${res.stderr.trim()}` : ''}`)
  }
  let data
  try {
    data = JSON.parse(res.stdout)
  } catch {
    throw new Error('RELEASE_QUERY_FAILED: 当前正式版查询返回的不是合法 JSON')
  }
  return typeof data?.tagName === 'string' && data.tagName ? data.tagName : null
}

/**
 * 6 个文件都到齐时把预发布转成正式版。可重复调用：已是正式版、草稿、文件未齐时什么都不改。
 * 只有版本号不低于当前正式版时才标 Latest，补发旧版本不会抢走 Latest。
 */
export function promoteReleaseIfComplete({ repo = DEFAULT_GITHUB_REPO, tag, gh = 'gh', runner = spawnSync, log = console.log }) {
  const version = versionFromReleaseTag(tag)
  const state = readReleaseState({ repo, tag, gh, runner })
  if (!state.exists) {
    log(`ℹ Release ${tag} 还不存在，暂不转正。`)
    return { promoted: false, reason: 'missing-release', missing: expectedReleaseAssetNames(version) }
  }
  if (isPublishedRelease(state)) {
    log(`ℹ Release ${tag} 已经是正式版。`)
    return { promoted: false, reason: 'already-published', missing: [] }
  }
  if (state.isDraft) {
    log(`ℹ Release ${tag} 是草稿，自动转正只处理预发布。重跑 npm run release:binaries 会把草稿发布为预发布（同时建 tag）；在网页上手动发布时必须保持勾选预发布。`)
    return { promoted: false, reason: 'draft', missing: missingReleaseAssets(state, version) }
  }
  const missing = missingReleaseAssets(state, version)
  if (missing.length > 0) {
    log(`⏳ Release ${tag} 仍是预发布，还差 ${missing.length} 个文件：${missing.join('、')}。另一端上传完会自动转正。`)
    return { promoted: false, reason: 'incomplete', missing }
  }

  const latestTag = readLatestReleaseTag({ repo, gh, runner })
  const makeLatest = !latestTag || compareVersions(tag, latestTag) >= 0
  const edit = runGh(gh, ['release', 'edit', tag, '--repo', repo, '--prerelease=false', `--latest=${makeLatest}`], runner)
  if (edit.status !== 0) {
    throw new Error(`RELEASE_PROMOTE_FAILED: Release ${tag} 转正失败（退出码 ${edit.status}）${edit.stderr.trim() ? `：${edit.stderr.trim()}` : ''}。可稍后运行 npm run release:promote 重试。`)
  }
  log(
    makeLatest
      ? `✅ 6 个文件已齐，Release ${tag} 已转为正式版并标记为 Latest。`
      : `✅ 6 个文件已齐，Release ${tag} 已转为正式版（低于当前 Latest ${latestTag}，不抢 Latest）。`
  )
  return { promoted: true, latest: makeLatest, missing: [] }
}

export function parseReleaseStateCliArgs(argv = []) {
  const [command, ...rest] = argv
  if (command !== 'guard' && command !== 'promote') {
    throw new Error('UNKNOWN_COMMAND: 用法 node scripts/release-state.mjs <guard|promote> [--tag v<版本>] [--repo owner/repo] [--replace-published]')
  }
  const options = { command, tag: '', repo: DEFAULT_GITHUB_REPO, replacePublished: false }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--tag') {
      options.tag = String(rest[++i] ?? '').trim()
      versionFromReleaseTag(options.tag)
    } else if (arg === '--repo') {
      const val = String(rest[++i] ?? '').trim()
      if (!REPO_PATTERN.test(val)) throw new Error(`INVALID_REPO: --repo 参数格式无效（需为 owner/repo 格式）: ${val}`)
      options.repo = val
    } else if (arg === '--replace-published') {
      options.replacePublished = true
    } else {
      throw new Error(`UNKNOWN_ARGUMENT: 不支持的参数 ${arg}`)
    }
  }
  return options
}

export function runReleaseStateCli(argv = process.argv.slice(2), { rootDir = ROOT_DIR, gh = resolveGhExecutable(), runner = spawnSync, log = console.log } = {}) {
  const options = parseReleaseStateCliArgs(argv)
  if (!options.tag) {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'electron-client', 'package.json'), 'utf8'))
    options.tag = `v${pkg.version}`
    versionFromReleaseTag(options.tag)
  }
  if (options.command === 'guard') {
    const state = readReleaseState({ repo: options.repo, tag: options.tag, gh, runner })
    assertReleaseWritable(state, { replacePublished: options.replacePublished })
    if (isPublishedRelease(state)) log(`⚠ Release ${options.tag} 已是正式版，按 --replace-published 继续覆盖上传。`)
    else log(`✔ Release ${options.tag} ${state.exists ? (state.isDraft ? '是草稿' : '是预发布') : '还不存在'}，可以上传。`)
    return { command: 'guard', state }
  }
  return { command: 'promote', ...promoteReleaseIfComplete({ repo: options.repo, tag: options.tag, gh, runner, log }) }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()

if (isMainModule) {
  try {
    runReleaseStateCli()
  } catch (err) {
    console.error(`❌ [Release 状态] ${err.message}`)
    process.exit(1)
  }
}
