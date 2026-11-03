import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { scanDirectoryForSearch } from '../../src/main/platform/macos/file-indexer.js'

test('目录扫描保留可读文件，子目录拒绝读取时返回不完整标记与原因，重新扫描可恢复', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-scan-partial-')))
  const denied = path.join(root, 'denied')
  await fs.mkdir(denied)
  await fs.writeFile(path.join(denied, 'nested.txt'), 'nested')
  await fs.writeFile(path.join(root, 'readable.txt'), 'readable')
  const originalReaddir = fs.readdir
  let rejectChild = true
  t.mock.method(fs, 'readdir', async (...args: unknown[]) => {
    if (String(args[0]) === denied && rejectChild) throw new Error('EACCES: 子目录读取被拒绝')
    return Reflect.apply(originalReaddir, fs, args)
  })
  try {
    const partial = await scanDirectoryForSearch(root, 20, [], 2000, { measureDirectory: null })
    assert.deepEqual(partial.files.map(file => file.name), ['readable.txt'])
    assert.equal(partial.total_matches, 1)
    assert.equal(partial.truncated, false)
    assert.equal(partial.approximate, true)
    assert.equal(partial.subdirs?.find(dir => dir.path === denied)?.approximate, true)
    assert.ok(partial.scan_error?.includes(denied))
    assert.match(partial.scan_error!, /EACCES/)

    rejectChild = false
    const complete = await scanDirectoryForSearch(root, 20, [], 2000, { measureDirectory: null })
    assert.equal(complete.total_matches, 2)
    assert.equal(complete.approximate, false)
    assert.equal(complete.scan_error, undefined)
    assert.equal(complete.subdirs?.find(dir => dir.path === denied)?.approximate, undefined)
  } finally {
    t.mock.restoreAll()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('目录条目在读取属性时消失不能冒充完整空目录，下一次真实空目录仍成功', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-scan-race-')))
  const vanished = path.join(root, 'vanished.txt')
  await fs.writeFile(vanished, 'fixture')
  const originalLstat = fs.lstat
  t.mock.method(fs, 'lstat', async (...args: unknown[]) => {
    if (String(args[0]) === vanished) throw new Error('ENOENT: 文件在扫描期间消失')
    return Reflect.apply(originalLstat, fs, args)
  })
  try {
    const partial = await scanDirectoryForSearch(root, 20)
    assert.equal(partial.files.length, 0)
    assert.equal(partial.approximate, true)
    assert.match(partial.scan_error!, /ENOENT/)
    t.mock.restoreAll()
    await fs.unlink(vanished)
    const empty = await scanDirectoryForSearch(root, 20)
    assert.equal(empty.total_matches, 0)
    assert.equal(empty.approximate, false)
    assert.equal(empty.scan_error, undefined)
  } finally {
    t.mock.restoreAll()
    await fs.rm(root, { recursive: true, force: true })
  }
})
