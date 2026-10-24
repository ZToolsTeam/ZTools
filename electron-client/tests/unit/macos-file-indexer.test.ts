import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  scanDirectoryForSearch,
  scanLocalRecentFiles
} from '../../src/main/platform/macos/file-indexer.js'

const posixOnly = { skip: process.platform === 'win32' }

async function makeTempDir(prefix: string): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))
}

test('recent files never include the process working directory', posixOnly, async () => {
  const home = await makeTempDir('ztools-recent-home-')
  const cwd = await makeTempDir('ztools-recent-cwd-')
  const previousHome = process.env.HOME
  const previousCwd = process.cwd()
  try {
    await fs.mkdir(path.join(home, 'Downloads'))
    await fs.writeFile(path.join(home, 'Downloads', 'report.txt'), 'r')
    await fs.writeFile(path.join(cwd, 'package.json'), '{}')
    await fs.mkdir(path.join(cwd, 'src'))
    process.env.HOME = home
    process.chdir(cwd)
    const recent = await scanLocalRecentFiles('', 50)
    assert.deepEqual(recent.files.map((file) => file.path), [path.join(home, 'Downloads', 'report.txt')])
  } finally {
    process.chdir(previousCwd)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await fs.rm(home, { recursive: true, force: true })
    await fs.rm(cwd, { recursive: true, force: true })
  }
})

async function makeTruncationFixture(): Promise<string> {
  const root = await makeTempDir('ztools-dirscan-')
  await fs.mkdir(path.join(root, 'aa'))
  await Promise.all(Array.from({ length: 2500 }, (_, index) => fs.writeFile(path.join(root, 'aa', `f${index}.txt`), 'x')))
  await fs.mkdir(path.join(root, 'zz'))
  await fs.writeFile(path.join(root, 'zz', 'big.bin'), Buffer.alloc(2 * 1024 * 1024, 1))
  await fs.writeFile(path.join(root, 'top.txt'), 'top-level')
  return root
}

test('dir: scan past the entry cap reports truncation and measures unfinished subdirectories independently', posixOnly, async () => {
  const root = await makeTruncationFixture()
  try {
    const result = await scanDirectoryForSearch(root, 100)
    assert.equal(result.truncated, true)
    assert.equal(result.visited_entries, 2000)
    assert.equal(result.max_entries, 2000)
    const zz = result.subdirs?.find((sub) => sub.name === 'zz')
    const aa = result.subdirs?.find((sub) => sub.name === 'aa')
    assert.ok(zz && aa)
    // zz 在截断时还没遍历到：旧实现体积为 0，现在由 du 独立统计
    assert.ok((zz.total_bytes ?? 0) >= 2 * 1024 * 1024, `zz size ${zz.total_bytes}`)
    assert.ok((aa.total_bytes ?? 0) >= 2500, `aa size ${aa.total_bytes}`)
    assert.equal(zz.approximate, undefined)
    assert.equal(result.approximate, false)
    assert.ok((result.total_bytes ?? 0) >= (zz.total_bytes ?? 0) + (aa.total_bytes ?? 0))
    // 放宽上限后完整遍历，不再截断
    const full = await scanDirectoryForSearch(root, 100, [], 20000)
    assert.equal(full.truncated, false)
    assert.equal(full.approximate, false)
    assert.equal(full.total_matches, 2502)
    assert.ok(full.files.some((file) => file.name === 'big.bin'))
    // 上限越界被钳制
    assert.equal((await scanDirectoryForSearch(root, 10, [], 10_000_000, { measureDirectory: null })).max_entries, 20000)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('dir: size measurement timeout or failure marks subdirectories approximate instead of presenting samples as exact', posixOnly, async () => {
  const root = await makeTruncationFixture()
  try {
    const calls: string[] = []
    const timedOut = await scanDirectoryForSearch(root, 50, [], 2000, {
      measureDirectory: async (dir) => { calls.push(path.basename(dir)); return null }
    })
    assert.deepEqual(calls.sort(), ['aa', 'zz'])
    assert.equal(timedOut.truncated, true)
    assert.equal(timedOut.approximate, true)
    assert.equal(timedOut.subdirs?.find((sub) => sub.name === 'zz')?.approximate, true)
    const thrown = await scanDirectoryForSearch(root, 50, [], 2000, {
      measureDirectory: async () => { throw new Error('du crashed') }
    })
    assert.equal(thrown.approximate, true)
    const partialPermission = await scanDirectoryForSearch(root, 50, [], 2000, {
      measureDirectory: async () => ({ bytes: 4096, complete: false })
    })
    assert.equal(partialPermission.subdirs?.find((sub) => sub.name === 'zz')?.total_bytes, 4096)
    assert.equal(partialPermission.approximate, true)
    // 总时间预算耗尽后不再启动新的统计
    let started = 0
    const budget = await scanDirectoryForSearch(root, 50, [], 2000, {
      sizeBudgetMs: 50,
      sizeConcurrency: 1,
      measureDirectory: async () => { started++; await new Promise((resolve) => setTimeout(resolve, 120)); return null }
    })
    assert.equal(started, 1)
    assert.equal(budget.approximate, true)
    const small = await scanDirectoryForSearch(path.join(root, 'zz'), 50, [], 2000, {
      measureDirectory: async () => { throw new Error('must not run for complete scans') }
    })
    assert.equal(small.truncated, false)
    assert.equal(small.approximate, false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('dir:/ scan never descends into devfs or system volume mount points', { skip: process.platform !== 'darwin' }, async () => {
  const result = await scanDirectoryForSearch('/', 20, [], 200, { measureDirectory: null })
  const names = (result.subdirs ?? []).map((sub) => sub.path)
  assert.ok(!names.includes('/dev'))
  assert.ok(!names.includes('/home'))
  assert.ok(!names.includes('/net'))
  assert.ok(result.files.every((file) => !file.path.startsWith('/dev/') && !file.path.startsWith('/System/Volumes/')))
})
