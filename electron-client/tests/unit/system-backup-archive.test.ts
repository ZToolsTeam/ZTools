import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import test from 'node:test'
import yazl from 'yazl'
import { StorageHostPluginHandler } from '../../src/main/services/host-plugins/storage-host.js'
import { SNAPSHOT_MANIFEST_NAME } from '../../src/main/services/host-plugins/snapshot-archive.js'
import type { HostPluginContext } from '../../src/main/services/host-plugins/shared-utils.js'

type Reply = {
  ok: boolean; success: boolean; partial?: boolean; archivePath?: string; targetDir?: string;
  backedUpCount?: number; fileCount?: number; error?: string;
  failedSources?: Array<{ path: string; error: string }>;
}

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-snapshot-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const host = new StorageHostPluginHandler({
    authorizeExistingPath: async (source: string) => {
      assert.ok(source.startsWith(root + path.sep), '测试不能读取样本外的文件')
      if (source.endsWith('denied.json')) throw new Error('PERMISSION_DENIED: 无法读取该配置')
      return source
    },
    authorizeOutputPath: async (output: string) => {
      assert.ok(output === root || output.startsWith(root + path.sep), '测试不能写入样本外的文件')
      return output
    }
  } as unknown as HostPluginContext)
  const write = async (name: string, content: string) => {
    const output = path.join(root, name)
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.writeFile(output, content)
    return output
  }
  const create = (sourcePaths: string[], extra = {}) => host.handleSystemBackup('createSnapshotArchive', {
    sourcePaths, backupDir: path.join(root, 'vault'), ...extra
  }) as Promise<Reply>
  const extract = (archivePath: string) => host.handleSystemBackup('extractSnapshotArchive', { archivePath }) as Promise<Reply>
  return { root, host, write, create, extract }
}

test('同名配置经真实 ZIP 往返后均保留，来源清单准确，原配置不被修改', async t => {
  const f = await fixture(t)
  const terminal = await f.write('Terminal/settings.json', '{"application":"terminal"}')
  const editor = await f.write('Code/settings.json', '{"application":"editor"}')
  const created = await f.create([terminal, editor])
  assert.equal(created.ok, true)
  assert.equal(created.backedUpCount, 2)
  assert.equal(created.fileCount, 2)
  assert.deepEqual(created.failedSources, [])
  assert.ok(created.archivePath)
  await fs.writeFile(terminal, 'later-terminal')
  await fs.writeFile(editor, 'later-editor')
  const extracted = await f.extract(created.archivePath)
  assert.equal(extracted.success, true)
  assert.ok(extracted.targetDir)
  const manifest = JSON.parse(await fs.readFile(path.join(extracted.targetDir, SNAPSHOT_MANIFEST_NAME), 'utf8')) as {
    sources: Array<{ sourcePath: string; archivePath: string }>
  }
  assert.equal(manifest.sources.length, 2)
  assert.equal(new Set(manifest.sources.map(entry => entry.archivePath)).size, 2)
  for (const entry of manifest.sources) {
    assert.equal(await fs.readFile(path.join(extracted.targetDir, entry.archivePath), 'utf8'),
      entry.sourcePath === terminal ? '{"application":"terminal"}' : '{"application":"editor"}')
  }
  assert.equal(await fs.readFile(terminal, 'utf8'), 'later-terminal')
  assert.equal(await fs.readFile(editor, 'utf8'), 'later-editor')
  const second = await f.extract(created.archivePath)
  assert.equal(second.success, true)
  assert.notEqual(second.targetDir, extracted.targetDir)
})

test('部分拒绝与源消失逐项返回，不伪装完整备份；全部失败不创建归档', async t => {
  const f = await fixture(t)
  const good = await f.write('good.json', 'good')
  const denied = path.join(f.root, 'denied.json')
  const missing = path.join(f.root, 'missing.json')
  const partial = await f.create([good, denied, missing])
  assert.equal(partial.success, true)
  assert.equal(partial.partial, true)
  assert.equal(partial.backedUpCount, 1)
  assert.equal(partial.fileCount, 1)
  assert.deepEqual(partial.failedSources?.map(item => item.path), [denied, missing])
  assert.match(partial.failedSources![0]!.error, /PERMISSION_DENIED/)
  assert.match(partial.failedSources![1]!.error, /ENOENT/)
  const before = await fs.readdir(path.join(f.root, 'vault'))
  const failed = await f.create([denied, missing])
  assert.equal(failed.ok, false)
  assert.equal(failed.success, false)
  assert.equal(failed.backedUpCount, 0)
  assert.equal(failed.failedSources?.length, 2)
  assert.deepEqual(await fs.readdir(path.join(f.root, 'vault')), before)
})

test('空配置与目录结构仍可归档，已有快照文件不可覆盖', async t => {
  const f = await fixture(t)
  const empty = await f.write('config/empty.json', '')
  await f.write('config/nested/settings.json', 'nested')
  const created = await f.create([path.dirname(empty)], { backupName: 'fixed.zip' })
  assert.equal(created.backedUpCount, 1)
  assert.equal(created.fileCount, 2)
  assert.ok(created.archivePath)
  const original = await fs.readFile(created.archivePath)
  await assert.rejects(f.create([empty], { backupName: 'fixed.zip' }), /EEXIST/)
  assert.deepEqual(await fs.readFile(created.archivePath), original)
  const extracted = await f.extract(created.archivePath)
  assert.ok(extracted.targetDir)
  assert.equal(await fs.readFile(path.join(extracted.targetDir, 'files/1/config/empty.json'), 'utf8'), '')
  assert.equal(await fs.readFile(path.join(extracted.targetDir, 'files/1/config/nested/settings.json'), 'utf8'), 'nested')
})

test('旧归档的重复条目明确报错，已解压文件不会被后一个覆盖', async t => {
  const f = await fixture(t)
  const archivePath = path.join(f.root, 'legacy.zip')
  const zip = new yazl.ZipFile()
  zip.addBuffer(Buffer.from('first'), 'settings.json')
  zip.addBuffer(Buffer.from('second'), 'settings.json')
  const output = await fs.open(archivePath, 'wx')
  const written = pipeline(zip.outputStream, output.createWriteStream())
  zip.end()
  await written
  const extracted = await f.extract(archivePath)
  assert.equal(extracted.ok, false)
  assert.match(extracted.error!, /解压失败/)
  assert.ok(extracted.targetDir)
  assert.equal(await fs.readFile(path.join(extracted.targetDir, 'settings.json'), 'utf8'), 'first')
})

test('损坏归档返回实际输出目录与失败，不报告解压成功', async t => {
  const f = await fixture(t)
  const archivePath = await f.write('broken.zip', 'not a zip')
  const extracted = await f.extract(archivePath)
  assert.equal(extracted.success, false)
  assert.ok(extracted.targetDir)
  assert.match(extracted.error!, new RegExp(extracted.targetDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.deepEqual(await fs.readdir(extracted.targetDir), [])
})

test('来源在预检后消失时传播压缩流错误并清理未完成快照', async t => {
  const f = await fixture(t)
  const source = await f.write('moving.json', 'fixture')
  const vault = path.join(f.root, 'vault')
  const host = new StorageHostPluginHandler({
    authorizeExistingPath: async (input: string) => input,
    authorizeOutputPath: async (output: string) => {
      if (output.endsWith('.zip')) await fs.rename(source, `${source}.moved`)
      return output
    }
  } as unknown as HostPluginContext)
  await assert.rejects(host.handleSystemBackup('createSnapshotArchive', {
    sourcePaths: [source], backupDir: vault
  }), /ENOENT/)
  assert.deepEqual(await fs.readdir(vault), [])
  assert.equal(await fs.readFile(`${source}.moved`, 'utf8'), 'fixture')
})

test('POSIX 配置快照和解压文件仅当前用户可读，不扩大敏感配置权限或修改既有目录', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const source = await f.write('config/private.json', '合成敏感配置')
  await fs.chmod(source, 0o600)
  const listedVault = path.join(f.root, 'listed-vault')
  await f.host.handleSystemBackup('listBackups', { backupDir: listedVault })
  assert.equal((await fs.stat(listedVault)).mode & 0o077, 0)
  const created = await f.create([source])
  assert.ok(created.archivePath)
  assert.equal((await fs.stat(path.dirname(created.archivePath))).mode & 0o077, 0)
  assert.equal((await fs.stat(created.archivePath)).mode & 0o077, 0)
  const extracted = await f.extract(created.archivePath)
  assert.ok(extracted.targetDir)
  assert.equal((await fs.stat(extracted.targetDir)).mode & 0o077, 0)
  assert.equal((await fs.stat(path.join(extracted.targetDir, 'files/1/private.json'))).mode & 0o077, 0)

  const existingDir = path.join(f.root, 'existing-vault')
  await fs.mkdir(existingDir)
  await fs.chmod(existingDir, 0o755)
  const inExisting = await f.create([source], { backupDir: existingDir })
  assert.ok(inExisting.archivePath)
  assert.equal((await fs.stat(inExisting.archivePath)).mode & 0o077, 0)
  assert.equal((await fs.stat(existingDir)).mode & 0o777, 0o755)
  assert.equal((await fs.stat(source)).mode & 0o777, 0o600)
})
