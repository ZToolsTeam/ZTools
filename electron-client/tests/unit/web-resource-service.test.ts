import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runtimePathsForBusinessDataRoot } from '../../src/main/runtime/runtime-paths.js'
import { UpdateService } from '../../src/main/services/update-service.js'
import { WebResourceService } from '../../src/main/services/web-resource-service.js'

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

test('UpdateService downloads, verifies and activates a Web ZIP with a host-version gate', async () => {
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
