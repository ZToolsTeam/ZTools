import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runtimePathsForBusinessDataRoot } from '../../src/main/runtime/runtime-paths.js'
import { UpdateService } from '../../src/main/services/update-service.js'
import { compareWebVersions, shouldRefreshFromBundled, WebResourceService } from '../../src/main/services/web-resource-service.js'

// 这些用例依赖 Windows 路径语义（C:\\ / E:\\）或 Windows 宿主能力（DLL、进程启动、更新安装链、本地 .exe 软件），
// 在其他平台上功能代码按设计会拒绝执行，因此只在 Windows 宿主运行；Windows CI 上照常覆盖。
const windowsOnly = { skip: process.platform === 'win32' ? false : '依赖 Windows 路径或宿主能力，仅在 Windows 上运行' }


interface ZipEntry {
  name: string
  data: string | Buffer
  mode?: number
}

function crc32(buffer: Buffer): number {
  let crc = 0xffff_ffff
  for (const value of buffer) {
    crc ^= value
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0)
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0
}

function createZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x0403_4b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x0201_4b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE((((entry.mode ?? 0o100644) & 0xffff) * 0x1_0000) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x0605_4b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function response(body: Buffer): Response {
  const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  return new Response(bytes, { status: 200, headers: { 'content-length': String(body.length) } })
}

function webArchive(version: string): Buffer {
  return createZip([
    { name: 'index.html', data: `<html>${version}</html>` },
    { name: 'version.json', data: JSON.stringify({ version }) },
    { name: 'sdk/index.js', data: `export const version = '${version}'` }
  ])
}

async function createBundledRoot(root: string, version: string): Promise<void> {
  await fs.mkdir(path.join(root, 'sdk'), { recursive: true })
  await fs.writeFile(path.join(root, 'index.html'), `<html>${version}</html>`)
  await fs.writeFile(path.join(root, 'version.json'), JSON.stringify({ version }))
  await fs.writeFile(path.join(root, 'sdk', 'index.js'), `export const version = '${version}'`)
}

async function createService(name: string): Promise<{
  root: string
  runtimePaths: ReturnType<typeof runtimePathsForBusinessDataRoot>
  resources: WebResourceService
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `ztools-web-resource-${name}-`))
  const runtimePaths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'))
  const bundledRoot = path.join(root, 'bundled')
  await createBundledRoot(bundledRoot, '1.0.0')
  const resources = new WebResourceService({ bundledRoot, runtimePaths })
  await resources.initialize()
  return { root, runtimePaths, resources }
}

test('seeds writable resources, switches atomically and preserves the previous version', async () => {
  const fixture = await createService('switch')
  try {
    assert.equal(fixture.resources.version, '1.0.0')
    const archive = webArchive('2.0.0')
    const archivePath = path.join(fixture.root, 'web-2.0.0.zip')
    await fs.writeFile(archivePath, archive)

    const result = await fixture.resources.applyArchive(archivePath, '2.0.0')
    assert.equal(fixture.resources.version, '2.0.0')
    assert.equal(await fs.readFile(path.join(fixture.resources.root, 'index.html'), 'utf8'), '<html>2.0.0</html>')
    assert.equal(await fs.readFile(path.join(fixture.resources.root, 'version.json'), 'utf8'), JSON.stringify({ version: '2.0.0' }))
    await fs.access(path.join(fixture.root, 'Web', 'active.json'))
    const versions = await fs.readdir(path.join(fixture.root, 'Web', 'versions'))
    assert.ok(versions.some((name) => name.startsWith('bundled-')))
    assert.equal(result.previousVersion, '1.0.0')
    await fixture.resources.confirm(result.operationId)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('rejects zip-slip, duplicate paths and missing web entry without changing the active pointer', async () => {
  const fixture = await createService('reject')
  try {
    const before = fixture.resources.root
    const cases = [
      createZip([
        { name: '../outside.txt', data: 'escape' },
        { name: 'index.html', data: 'bad' },
        { name: 'version.json', data: JSON.stringify({ version: '2.0.0' }) }
      ]),
      createZip([
        { name: 'index.html', data: 'one' },
        { name: 'INDEX.HTML', data: 'two' },
        { name: 'version.json', data: JSON.stringify({ version: '2.0.0' }) }
      ]),
      createZip([{ name: 'version.json', data: JSON.stringify({ version: '2.0.0' }) }])
    ]
    for (const [index, archive] of cases.entries()) {
      const archivePath = path.join(fixture.root, `invalid-${index}.zip`)
      await fs.writeFile(archivePath, archive)
      await assert.rejects(fixture.resources.applyArchive(archivePath, '2.0.0'))
      assert.equal(fixture.resources.root, before)
      assert.equal(fixture.resources.version, '1.0.0')
    }
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('recovers an activated transaction after process restart and can roll it back', async () => {
  const fixture = await createService('recovery')
  try {
    const archive = webArchive('2.0.0')
    const archivePath = path.join(fixture.root, 'web-2.0.0.zip')
    await fs.writeFile(archivePath, archive)
    const result = await fixture.resources.applyArchive(archivePath, '2.0.0')

    await fixture.resources.rollback(result.operationId)
    assert.equal(fixture.resources.version, '1.0.0')

    const reapplied = await fixture.resources.applyArchive(archivePath, '2.0.0')

    const restarted = new WebResourceService({
      bundledRoot: path.join(fixture.root, 'bundled'),
      runtimePaths: fixture.runtimePaths
    })
    await restarted.initialize()
    assert.equal(restarted.version, '2.0.0')
    assert.equal(await fs.readFile(path.join(restarted.root, 'index.html'), 'utf8'), '<html>2.0.0</html>')
    assert.notEqual(reapplied.operationId, result.operationId)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('UpdateService downloads, verifies and activates a Web ZIP with a host-version gate', windowsOnly, async () => {
  const fixture = await createService('update-service')
  try {
    const archive = webArchive('2.0.0')
    const service = new UpdateService({
      runtimePaths: fixture.runtimePaths,
      appVersion: '1.5.0',
      webVersion: fixture.resources.version,
      webResources: fixture.resources,
      fetchImpl: async () => response(archive)
    })
    const result = await service.install({
      type: 'web',
      version: '2.0.0',
      downloadUrl: 'https://cdn.example/web-2.0.0.zip',
      checksum: sha256(archive),
      fileSize: archive.length,
      minAppVersion: '1.0.0'
    })
    assert.equal(result.success, true)
    assert.equal(result.reloadRequired, true)
    assert.equal(result.restartRequired, false)
    assert.equal(fixture.resources.version, '2.0.0')
    await fixture.resources.confirm(result.operationId)

    const blocked = new UpdateService({
      runtimePaths: fixture.runtimePaths,
      appVersion: '1.5.0',
      webVersion: fixture.resources.version,
      webResources: fixture.resources,
      fetchImpl: async () => response(archive)
    })
    await assert.rejects(
      blocked.install({
        type: 'web',
        version: '2.0.0',
        downloadUrl: 'https://cdn.example/web-2.0.0.zip',
        checksum: sha256(archive),
        fileSize: archive.length,
        minAppVersion: '2.0.0'
      }),
      /当前 App 版本低于 Web 更新要求/
    )
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('web resource roots are external to the bundled source directory', async () => {
  const fixture = await createService('external')
  try {
    assert.notEqual(path.dirname(fixture.resources.root), path.join(fixture.root, 'bundled'))
    assert.equal(path.basename(path.dirname(path.dirname(fixture.resources.root))), 'Web')
    assert.notEqual(sha256(await fs.readFile(path.join(fixture.resources.root, 'index.html'))), '')
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('ignores a tampered transaction log without deleting paths outside Web', async () => {
  const fixture = await createService('transaction-boundary')
  try {
    const outside = path.join(fixture.root, 'outside')
    await fs.mkdir(outside, { recursive: true })
    const protectedFile = path.join(outside, 'keep.txt')
    await fs.writeFile(protectedFile, 'must remain')
    const transactionPath = path.join(fixture.root, 'Web', 'transactions', 'tampered.json')
    await fs.writeFile(transactionPath, JSON.stringify({
      schemaVersion: 1,
      operationId: 'tampered',
      state: 'prepared',
      staging: outside,
      directory: outside,
      previous: {
        schemaVersion: 1,
        operationId: 'bundled',
        version: '1.0.0',
        directory: path.basename(fixture.resources.root)
      },
      next: {
        schemaVersion: 1,
        operationId: 'tampered',
        version: '2.0.0',
        directory: 'web-2.0.0-tampered'
      }
    }))

    const restarted = new WebResourceService({
      bundledRoot: path.join(fixture.root, 'bundled'),
      runtimePaths: fixture.runtimePaths
    })
    await restarted.initialize()
    assert.equal(await fs.readFile(protectedFile, 'utf8'), 'must remain')
    await assert.rejects(fs.access(transactionPath))
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

// ── 内置资源刷新：同版本号的新构建 / 安装包升级越过热更新 ─────────────────────

async function restart(fixture: { root: string, runtimePaths: ReturnType<typeof runtimePathsForBusinessDataRoot> }): Promise<WebResourceService> {
  const restarted = new WebResourceService({ bundledRoot: path.join(fixture.root, 'bundled'), runtimePaths: fixture.runtimePaths })
  await restarted.initialize()
  return restarted
}

async function listVersionDirs(root: string): Promise<string[]> {
  return (await fs.readdir(path.join(root, 'Web', 'versions'))).sort()
}

test('同版本号的新构建（index.html 变化）在重启时刷新为新内容，并清理被替换的旧拷贝', async () => {
  const fixture = await createService('rebuild')
  try {
    const firstRoot = fixture.resources.root
    await fs.writeFile(path.join(fixture.root, 'bundled', 'index.html'), '<html>1.0.0 rebuilt</html>')
    const restarted = await restart(fixture)
    assert.equal(restarted.version, '1.0.0')
    assert.notEqual(restarted.root, firstRoot)
    assert.equal(await fs.readFile(path.join(restarted.root, 'index.html'), 'utf8'), '<html>1.0.0 rebuilt</html>')
    assert.deepEqual(await listVersionDirs(fixture.root), [path.basename(restarted.root)])
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('内置资源未变化时重启不重复拷贝（保持同一目录）', async () => {
  const fixture = await createService('unchanged')
  try {
    const firstRoot = fixture.resources.root
    const restarted = await restart(fixture)
    assert.equal(restarted.root, firstRoot)
    assert.deepEqual(await listVersionDirs(fixture.root), [path.basename(firstRoot)])
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('旧版指针（没有 bundledFingerprint）升级后刷新一次，之后保持稳定', async () => {
  const fixture = await createService('legacy-pointer')
  try {
    const pointerPath = path.join(fixture.root, 'Web', 'active.json')
    const pointer = JSON.parse(await fs.readFile(pointerPath, 'utf8')) as Record<string, unknown>
    delete pointer.bundledFingerprint
    await fs.writeFile(pointerPath, JSON.stringify(pointer))

    const refreshed = await restart(fixture)
    assert.notEqual(refreshed.root, fixture.resources.root)
    const stable = await restart(fixture)
    assert.equal(stable.root, refreshed.root)
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('热更新版本不被同版本或更低版本的内置构建覆盖；安装包越过热更新版本后切回内置', async () => {
  const fixture = await createService('hot-update')
  try {
    const archivePath = path.join(fixture.root, 'web-2.0.0.zip')
    await fs.writeFile(archivePath, webArchive('2.0.0'))
    const result = await fixture.resources.applyArchive(archivePath, '2.0.0')
    await fixture.resources.confirm(result.operationId)
    const hotRoot = fixture.resources.root

    // 内置 1.0.0 重新构建：热更新 2.0.0 仍然生效
    await fs.writeFile(path.join(fixture.root, 'bundled', 'index.html'), '<html>1.0.0 rebuilt</html>')
    const kept = await restart(fixture)
    assert.equal(kept.version, '2.0.0')
    assert.equal(kept.root, hotRoot)

    // 安装包升级到 3.0.0：切回内置资源，并清理被越过的热更新目录
    await createBundledRoot(path.join(fixture.root, 'bundled'), '3.0.0')
    const upgraded = await restart(fixture)
    assert.equal(upgraded.version, '3.0.0')
    assert.equal(await fs.readFile(path.join(upgraded.root, 'index.html'), 'utf8'), '<html>3.0.0</html>')
    await assert.rejects(fs.access(hotRoot))
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('[破坏性] 内置资源损坏（缺入口或含符号链接）时保留当前激活资源继续启动，不抛错', async () => {
  const fixture = await createService('broken-bundled')
  try {
    const activeRoot = fixture.resources.root
    await fs.rm(path.join(fixture.root, 'bundled', 'index.html'))
    const missingEntry = await restart(fixture)
    assert.equal(missingEntry.root, activeRoot)

    await fs.writeFile(path.join(fixture.root, 'bundled', 'index.html'), '<html>new</html>')
    await fs.symlink(os.tmpdir(), path.join(fixture.root, 'bundled', 'escape'))
    const withSymlink = await restart(fixture)
    assert.equal(withSymlink.root, activeRoot)
    assert.deepEqual(await listVersionDirs(fixture.root), [path.basename(activeRoot)])
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true })
  }
})

test('[破坏性] 首次启动时内置资源损坏仍然直接失败，不写出指针', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-web-resource-first-broken-'))
  try {
    const bundledRoot = path.join(root, 'bundled')
    await createBundledRoot(bundledRoot, '1.0.0')
    await fs.rm(path.join(bundledRoot, 'version.json'))
    const resources = new WebResourceService({ bundledRoot, runtimePaths: runtimePathsForBusinessDataRoot(path.join(root, 'Data')) })
    await assert.rejects(resources.initialize())
    await assert.rejects(fs.access(path.join(root, 'Web', 'active.json')))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('compareWebVersions / shouldRefreshFromBundled 边界', () => {
  assert.equal(compareWebVersions('1.1.8', '1.1.7.1'), 1)
  assert.equal(compareWebVersions('1.1.7', '1.1.7.0'), 0)
  assert.equal(compareWebVersions('1.2.0-beta.1', '1.2.0'), 0)
  assert.equal(compareWebVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareWebVersions('0.9', '1.0'), -1)

  const bundled = { version: '1.0.0', fingerprint: 'new' }
  assert.equal(shouldRefreshFromBundled({ operationId: 'bundled', version: '1.0.0', bundledFingerprint: 'new' }, bundled), false)
  assert.equal(shouldRefreshFromBundled({ operationId: 'bundled', version: '1.0.0', bundledFingerprint: 'old' }, bundled), true)
  assert.equal(shouldRefreshFromBundled({ operationId: 'bundled', version: '1.0.0' }, bundled), true)
  assert.equal(shouldRefreshFromBundled({ operationId: 'hot-1', version: '1.0.0' }, bundled), false)
  assert.equal(shouldRefreshFromBundled({ operationId: 'hot-1', version: '0.9.0' }, bundled), true)
})

