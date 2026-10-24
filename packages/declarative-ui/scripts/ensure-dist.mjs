#!/usr/bin/env node
/**
 * 确保 @ztools/declarative-ui 的 dist 产物存在且不旧于源码。
 *
 * frontend（vite / vitest）通过别名直接引用 dist/index.js，新克隆的仓库或改了 src 后
 * 如果没人手动编译，就会出现「Could not load .../dist/index.js」或加载旧代码。
 * frontend 的 predev / prebuild / pretest 都会调用本脚本；只有需要时才编译。
 *
 * 编译器沿用仓库约定：优先使用 electron-client 自带的 TypeScript（ai-mcp、sync-crypto 同样如此），
 * 其次是根目录 / 本包的 node_modules；都没有时给出明确的中文提示。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(packageRoot, '..', '..')

/** 目录下（递归）最新的修改时间；不存在返回 0 */
export function newestMtime(target) {
  let stats
  try {
    stats = fs.statSync(target)
  } catch {
    return 0
  }
  if (!stats.isDirectory()) return stats.mtimeMs
  let newest = stats.mtimeMs
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    newest = Math.max(newest, newestMtime(path.join(target, entry.name)))
  }
  return newest
}

/** dist 缺失，或 src / tsconfig 比 dist 入口新，则需要编译 */
export function needsBuild(root = packageRoot) {
  const entry = path.join(root, 'dist', 'index.js')
  if (!fs.existsSync(entry)) return { build: true, reason: 'dist 不存在' }
  const distTime = fs.statSync(entry).mtimeMs
  const sourceTime = Math.max(newestMtime(path.join(root, 'src')), newestMtime(path.join(root, 'tsconfig.json')))
  if (sourceTime > distTime) return { build: true, reason: '源码比 dist 新' }
  return { build: false, reason: 'dist 已是最新' }
}

/** 按仓库约定查找 TypeScript 编译器 */
export function findTsc(root = packageRoot, repo = repoRoot) {
  const candidates = [
    path.join(repo, 'electron-client', 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc'),
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || ''
}

export function ensureDist({ root = packageRoot, repo = repoRoot, run = spawnSync, log = console.log } = {}) {
  const decision = needsBuild(root)
  if (!decision.build) return { built: false, reason: decision.reason }
  const tsc = findTsc(root, repo)
  if (!tsc) {
    throw new Error(
      '@ztools/declarative-ui 需要编译，但找不到 TypeScript。\n' +
      '请先在 electron-client 目录执行 npm install（仓库统一使用它自带的 TypeScript）。'
    )
  }
  log(`[declarative-ui] ${decision.reason}，正在编译 dist ...`)
  const result = run(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json')], { cwd: root, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`@ztools/declarative-ui 编译失败（退出码 ${result.status ?? 'unknown'}），请查看上方 TypeScript 报错`)
  }
  if (!fs.existsSync(path.join(root, 'dist', 'index.js'))) {
    throw new Error('@ztools/declarative-ui 编译完成但缺少 dist/index.js')
  }
  // tsc 不会改写内容未变的文件；显式刷新入口时间，避免下次误判为过期。
  // Date 只精确到毫秒，而文件时间有亚毫秒精度：同一毫秒内写过的源码会显得比入口新，所以至少比最新源码晚 1ms
  const sourceTime = Math.max(newestMtime(path.join(root, 'src')), newestMtime(path.join(root, 'tsconfig.json')))
  const stamp = new Date(Math.max(Date.now(), Math.ceil(sourceTime) + 1))
  fs.utimesSync(path.join(root, 'dist', 'index.js'), stamp, stamp)
  return { built: true, reason: decision.reason }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    ensureDist()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
