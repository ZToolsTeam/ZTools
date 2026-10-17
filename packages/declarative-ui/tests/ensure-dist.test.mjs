import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDist, needsBuild, findTsc } from '../scripts/ensure-dist.mjs'

function fixture({ withDist = false, withTsc = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-ensure-dist-'))
  const root = path.join(repo, 'packages', 'declarative-ui')
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}')
  if (withTsc) {
    const tsc = path.join(repo, 'electron-client', 'node_modules', 'typescript', 'bin', 'tsc')
    fs.mkdirSync(path.dirname(tsc), { recursive: true })
    fs.writeFileSync(tsc, '')
  }
  if (withDist) {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'export const a = 1\n')
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(path.join(root, 'dist', 'index.js'), future, future)
  }
  return { repo, root, cleanup: () => fs.rmSync(repo, { recursive: true, force: true }) }
}

// 模拟 tsc：成功时写出 dist/index.js
const fakeTsc = (root, { status = 0, writeDist = true } = {}) => {
  const calls = []
  const run = (cmd, args) => {
    calls.push(args)
    if (status === 0 && writeDist) {
      fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
      fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'built')
    }
    return { status }
  }
  return { run, calls }
}

test('dist 缺失时用 electron-client 的 TypeScript 编译', () => {
  const f = fixture()
  try {
    const tsc = fakeTsc(f.root)
    const result = ensureDist({ root: f.root, repo: f.repo, run: tsc.run, log: () => {} })
    assert.equal(result.built, true)
    assert.equal(tsc.calls.length, 1)
    assert.ok(tsc.calls[0][0].includes(path.join('electron-client', 'node_modules', 'typescript')))
    assert.equal(needsBuild(f.root).build, false, '编译后入口时间已刷新，不会被误判为过期')
  } finally { f.cleanup() }
})

test('dist 已是最新时不调用编译器', () => {
  const f = fixture({ withDist: true })
  try {
    const tsc = fakeTsc(f.root)
    assert.equal(ensureDist({ root: f.root, repo: f.repo, run: tsc.run, log: () => {} }).built, false)
    assert.equal(tsc.calls.length, 0)
  } finally { f.cleanup() }
})

test('源码比 dist 新时重新编译', () => {
  const f = fixture({ withDist: true })
  try {
    const later = new Date(Date.now() + 120_000)
    fs.utimesSync(path.join(f.root, 'src', 'index.ts'), later, later)
    assert.deepEqual(needsBuild(f.root), { build: true, reason: '源码比 dist 新' })
    const tsc = fakeTsc(f.root)
    assert.equal(ensureDist({ root: f.root, repo: f.repo, run: tsc.run, log: () => {} }).built, true)
  } finally { f.cleanup() }
})

test('[破坏性] 找不到 TypeScript 时给出可操作的中文提示', () => {
  const f = fixture({ withTsc: false })
  try {
    assert.equal(findTsc(f.root, f.repo), '')
    assert.throws(() => ensureDist({ root: f.root, repo: f.repo, log: () => {} }), /electron-client 目录执行 npm install/)
  } finally { f.cleanup() }
})

test('[破坏性] 编译失败与「成功但无产物」都明确报错', () => {
  const f = fixture()
  try {
    const failing = fakeTsc(f.root, { status: 2 })
    assert.throws(() => ensureDist({ root: f.root, repo: f.repo, run: failing.run, log: () => {} }), /编译失败（退出码 2）/)
    const empty = fakeTsc(f.root, { writeDist: false })
    assert.throws(() => ensureDist({ root: f.root, repo: f.repo, run: empty.run, log: () => {} }), /缺少 dist\/index\.js/)
  } finally { f.cleanup() }
})

test('[破坏性] 编译器进程无法启动时抛出原始错误', () => {
  const f = fixture()
  try {
    const run = () => ({ error: new Error('spawn EACCES') })
    assert.throws(() => ensureDist({ root: f.root, repo: f.repo, run, log: () => {} }), /spawn EACCES/)
  } finally { f.cleanup() }
})
