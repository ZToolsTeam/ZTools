import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { FileSystemService } from '../../src/main/services/file-system-service.js'
import { resolvePathAccessBroker } from '../../src/main/platform/path-access-broker.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'

const appPath = process.cwd()
const context = { platform: process.platform, isPackaged: false, appPath, resourcesPath: appPath }

function ensureBrokerAvailable(): boolean {
  if (resolvePathAccessBroker(context).available) return true
  try {
    if (process.platform === 'darwin') {
      const outputRoot = path.join(appPath, 'out', 'native', 'darwin-universal', 'path-access')
      fsSync.rmSync(outputRoot, { recursive: true, force: true })
      const res = spawnSync(
        process.execPath,
        [path.join(appPath, 'scripts', 'build-macos-path-access.mjs'), '--output', outputRoot, '--minimum-os', '13.0'],
        { cwd: appPath, stdio: 'pipe', timeout: 120_000 }
      )
      if (res.status !== 0) return false
    } else if (process.platform === 'win32') {
      const res = spawnSync(
        process.execPath,
        [path.join(appPath, 'scripts', 'build-sidecars.mjs'), '--path-access-broker'],
        { cwd: appPath, stdio: 'pipe', timeout: 180_000 }
      )
      if (res.status !== 0) return false
    }
  } catch {
    return false
  }
  return resolvePathAccessBroker(context).available
}

const available = ensureBrokerAvailable()
const caller: CallerIdentity = { type: 'main', webContentsId: 44 }
const registry = { onRemoved: () => () => {}, get: () => caller } as unknown as WindowRegistry

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-no-replace-')))
  const service = new FileSystemService(registry, path.join(root, 'cache'), Date.now, undefined, { pathAccessBroker: context })
  return { root, service, async close() { await service.stop(); await fs.rm(root, { recursive: true, force: true }) } }
}

test('安全改名：两个源竞争一个目标，只提交一次，失败源与目标内容均保留', { skip: !available }, async () => {
  const f = await fixture()
  try {
    await f.service.grantFolder(f.root, caller)
    const sources = ['a.txt', 'b.txt'].map(name => path.join(f.root, name))
    await Promise.all(sources.map((name, i) => fs.writeFile(name, `source-${i}`)))
    const target = path.join(f.root, 'target.txt')
    const results = await Promise.allSettled(sources.map(sourcePath => f.service.moveFileNoReplace({ sourcePath, destPath: target }, caller, new AbortController().signal)))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    const winner = results.findIndex(r => r.status === 'fulfilled')
    assert.equal(await fs.readFile(target, 'utf8'), `source-${winner}`)
    assert.equal(await fs.readFile(sources[1 - winner]!, 'utf8'), `source-${1 - winner}`)
    await assert.rejects(fs.stat(sources[winner]!))
  } finally { await f.close() }
})

test('安全改名：已有目标拒绝覆盖，取消不移动文件', { skip: !available }, async () => {
  const f = await fixture()
  try {
    await f.service.grantFolder(f.root, caller)
    const sourcePath = path.join(f.root, 'source.txt'), destPath = path.join(f.root, 'target.txt')
    await fs.writeFile(sourcePath, 'source'); await fs.writeFile(destPath, 'target')
    await assert.rejects(f.service.moveFileNoReplace({ sourcePath, destPath }, caller, new AbortController().signal))
    assert.equal(await fs.readFile(destPath, 'utf8'), 'target')
    await assert.rejects(f.service.moveFileNoReplace({ sourcePath, destPath: path.join(f.root, 'cancelled.txt') }, caller, AbortSignal.abort()))
    assert.equal(await fs.readFile(sourcePath, 'utf8'), 'source')
    assert.deepEqual((await fs.readdir(f.root)).filter(name => name !== 'cache').sort(), ['source.txt', 'target.txt'])
  } finally { await f.close() }
})

test('目录查询区分可读与可写授权，未授权移动不改变文件', async () => {
  const f = await fixture()
  try {
    const sourcePath = path.join(f.root, 'source.txt')
    await fs.writeFile(sourcePath, 'source')
    await f.service.grantResultPaths(caller, [{ path: f.root, isDir: true }], 'system-path')
    assert.equal((await f.service.getDirectoryContents({ path: f.root }, caller)).writeAuthorized, false)
    await assert.rejects(f.service.moveFileNoReplace({ sourcePath, destPath: path.join(f.root, 'other.txt') }, caller, new AbortController().signal))
    await f.service.grantFolder(f.root, caller)
    assert.equal((await f.service.getDirectoryContents({ path: f.root }, caller)).writeAuthorized, true)
    assert.equal(await fs.readFile(sourcePath, 'utf8'), 'source')
  } finally { await f.close() }
})

test('安全改名绑定已授权目标，授权后入口链接改指向不能写入新目录', { skip: !available || process.platform !== 'darwin' }, async () => {
  const f = await fixture()
  try {
    const allowed = path.join(f.root, 'allowed'), outside = path.join(f.root, 'outside'), link = path.join(f.root, 'entry')
    await fs.mkdir(allowed); await fs.mkdir(outside); await fs.symlink(allowed, link)
    const sourcePath = path.join(allowed, 'source.txt'), destPath = path.join(link, 'target.txt')
    await fs.writeFile(sourcePath, 'source')
    await f.service.grantFolder(allowed, caller)
    const resolvePath = f.service.resolveAuthorizedPath.bind(f.service)
    f.service.resolveAuthorizedPath = async (...args: Parameters<FileSystemService['resolveAuthorizedPath']>) => {
      const result = await resolvePath(...args)
      if (args[0] === destPath) { await fs.unlink(link); await fs.symlink(outside, link) }
      return result
    }
    await f.service.moveFileNoReplace({ sourcePath, destPath }, caller, new AbortController().signal)
    assert.equal(await fs.readFile(path.join(allowed, 'target.txt'), 'utf8'), 'source')
    assert.deepEqual(await fs.readdir(outside), [])
  } finally { await f.close() }
})

test('安全改名：同一文件仅修改大小写（IMG_01.JPG -> img_01.jpg）成功且保留内容', { skip: !available }, async () => {
  const f = await fixture()
  try {
    await f.service.grantFolder(f.root, caller)
    const upperPath = path.join(f.root, 'IMG_01.JPG')
    const lowerPath = path.join(f.root, 'img_01.jpg')
    await fs.writeFile(upperPath, 'photo-bytes')
    await f.service.moveFileNoReplace({ sourcePath: upperPath, destPath: lowerPath }, caller, new AbortController().signal)
    const names = (await fs.readdir(f.root)).filter(name => name !== 'cache')
    assert.deepEqual(names, ['img_01.jpg'])
    assert.equal(await fs.readFile(lowerPath, 'utf8'), 'photo-bytes')
  } finally { await f.close() }
})
