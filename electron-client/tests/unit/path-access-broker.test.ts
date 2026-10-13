import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { resolvePathAccessBroker } from '../../src/main/platform/path-access-broker.js'

type FakeEntry = { kind: 'directory' } | { kind: 'file'; bytes: Buffer } | { kind: 'symlink' }

function fakeFileSystem(platform: 'win32' | 'darwin', entries: Map<string, FakeEntry>) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const key = (value: string) => {
    const normalized = paths.normalize(value)
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  const lookup = (value: string) => {
    const entry = entries.get(key(value))
    if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    return entry
  }
  return {
    lstatSync(value: string) {
      const entry = lookup(value)
      return {
        size: entry.kind === 'file' ? entry.bytes.length : 0,
        isDirectory: () => entry.kind === 'directory',
        isFile: () => entry.kind === 'file',
        isSymbolicLink: () => entry.kind === 'symlink'
      }
    },
    realpathSync(value: string) { lookup(value); return paths.normalize(value) },
    openSync(value: string) { lookup(value); return key(value) },
    readSync(descriptor: string, buffer: Buffer, offset: number, length: number, position: number) {
      const entry = lookup(descriptor)
      if (entry.kind !== 'file') throw new Error('not-file')
      const available = Math.max(0, Math.min(length, entry.bytes.length - position))
      entry.bytes.copy(buffer, offset, position, position + available)
      return available
    },
    closeSync() {}
  } as never
}

function directories(platform: 'win32' | 'darwin', root: string, segments: string[]) {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const entries = new Map<string, FakeEntry>()
  let current = paths.resolve(root)
  const key = (value: string) => {
    const normalized = paths.normalize(value)
    return platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  entries.set(key(current), { kind: 'directory' })
  for (const segment of segments) {
    current = paths.join(current, segment)
    entries.set(key(current), { kind: 'directory' })
  }
  return { entries, helperPath: paths.join(current, platform === 'win32' ? 'ZToolsPathAccessBroker.exe' : 'ZToolsPathAccessBroker'), key }
}

function peX64(machine = 0x8664) {
  const bytes = Buffer.alloc(128)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(64, 0x3c)
  bytes.write('PE\0\0', 64, 'binary')
  bytes.writeUInt16LE(machine, 68)
  return bytes
}

function fatMachO(cpuTypes: number[]) {
  const bytes = Buffer.alloc(8 + cpuTypes.length * 20)
  bytes.writeUInt32BE(0xcafebabe, 0)
  bytes.writeUInt32BE(cpuTypes.length, 4)
  cpuTypes.forEach((cpuType, index) => bytes.writeUInt32BE(cpuType, 8 + index * 20))
  return bytes
}

test('resolves only the fixed Windows development location and verifies x64 PE identity', () => {
  const root = 'C:\\app'
  const fixture = directories('win32', root, ['out', 'native', 'win32-x64', 'bin'])
  fixture.entries.set(fixture.key(fixture.helperPath), { kind: 'file', bytes: peX64() })

  const result = resolvePathAccessBroker({ platform: 'win32', isPackaged: false, appPath: root, resourcesPath: 'C:\\app\\resources' }, fakeFileSystem('win32', fixture.entries))
  assert.deepEqual(result, { available: true, executable: fixture.helperPath, platform: 'win32', arch: 'x64' })
})

test('resolves a packaged Windows broker only from resources/native', () => {
  const resources = 'C:\\app\\resources'
  const fixture = directories('win32', resources, ['native'])
  fixture.entries.set(fixture.key(fixture.helperPath), { kind: 'file', bytes: peX64() })

  const result = resolvePathAccessBroker({ platform: 'win32', isPackaged: true, appPath: 'C:\\app\\resources\\app.asar', resourcesPath: resources }, fakeFileSystem('win32', fixture.entries))
  assert.deepEqual(result, { available: true, executable: fixture.helperPath, platform: 'win32', arch: 'x64' })
})

test('rejects missing, symlinked, wrong-architecture and wrong-name Windows helpers without fallback', () => {
  const root = 'C:\\app'
  const fixture = directories('win32', root, ['out', 'native', 'win32-x64', 'bin'])
  const emptyFs = fakeFileSystem('win32', fixture.entries)
  assert.deepEqual(resolvePathAccessBroker({ platform: 'win32', isPackaged: false, appPath: root, resourcesPath: 'C:\\app\\resources' }, emptyFs),
    { available: false, reason: 'not-found' })

  fixture.entries.set(fixture.key(fixture.helperPath), { kind: 'symlink' })
  assert.deepEqual(resolvePathAccessBroker({ platform: 'win32', isPackaged: false, appPath: root, resourcesPath: 'C:\\app\\resources' }, fakeFileSystem('win32', fixture.entries)),
    { available: false, reason: 'invalid-helper' })

  fixture.entries.set(fixture.key(fixture.helperPath), { kind: 'file', bytes: peX64(0x014c) })
  assert.deepEqual(resolvePathAccessBroker({ platform: 'win32', isPackaged: false, appPath: root, resourcesPath: 'C:\\app\\resources' }, fakeFileSystem('win32', fixture.entries)),
    { available: false, reason: 'invalid-helper' })

  const parentSymlink = directories('win32', root, ['out', 'native', 'win32-x64', 'bin'])
  parentSymlink.entries.set(parentSymlink.key(path.win32.dirname(parentSymlink.helperPath)), { kind: 'symlink' })
  assert.deepEqual(resolvePathAccessBroker({ platform: 'win32', isPackaged: false, appPath: root, resourcesPath: 'C:\\app\\resources' }, fakeFileSystem('win32', parentSymlink.entries)),
    { available: false, reason: 'invalid-helper' })

  const wrongName = directories('win32', root, ['out', 'native', 'win32-x64', 'bin'])
  wrongName.entries.set(wrongName.key(path.win32.join(path.win32.dirname(wrongName.helperPath), 'ZToolsPathAccessBroker')), { kind: 'file', bytes: peX64() })
  assert.deepEqual(resolvePathAccessBroker({ platform: 'win32', isPackaged: false, appPath: root, resourcesPath: 'C:\\app\\resources' }, fakeFileSystem('win32', wrongName.entries)),
    { available: false, reason: 'not-found' })

  assert.deepEqual(resolvePathAccessBroker({ platform: 'darwin', isPackaged: true, appPath: root, resourcesPath: 'C:\\app\\resources' }, fakeFileSystem('darwin', fixture.entries)),
    { available: false, reason: 'invalid-context' })
})

test('resolves only a packaged Mac Universal helper and requires both architecture slices', () => {
  const resources = '/Applications/ZTools.app/Contents/Resources'
  const fixture = directories('darwin', resources, ['native'])
  fixture.entries.set(fixture.key(fixture.helperPath), { kind: 'file', bytes: fatMachO([0x01000007, 0x0100000c]) })

  const result = resolvePathAccessBroker({ platform: 'darwin', isPackaged: true, appPath: '/Applications/ZTools.app/Contents/Resources/app.asar', resourcesPath: resources }, fakeFileSystem('darwin', fixture.entries))
  assert.deepEqual(result, { available: true, executable: fixture.helperPath, platform: 'darwin', arch: 'universal' })

  fixture.entries.set(fixture.key(fixture.helperPath), { kind: 'file', bytes: fatMachO([0x0100000c]) })
  assert.deepEqual(resolvePathAccessBroker({ platform: 'darwin', isPackaged: true, appPath: '/Applications/ZTools.app/Contents/Resources/app.asar', resourcesPath: resources }, fakeFileSystem('darwin', fixture.entries)),
    { available: false, reason: 'invalid-helper' })
})

test('resolves the Mac development helper only under its universal output root', () => {
  const appPath = '/repo/electron-client'
  const fixture = directories('darwin', appPath, ['out', 'native', 'darwin-universal', 'path-access', 'native'])
  fixture.entries.set(fixture.key(fixture.helperPath), { kind: 'file', bytes: fatMachO([0x01000007, 0x0100000c]) })
  const result = resolvePathAccessBroker({ platform: 'darwin', isPackaged: false, appPath, resourcesPath: '/repo/electron-client/resources' }, fakeFileSystem('darwin', fixture.entries))
  assert.deepEqual(result, { available: true, executable: fixture.helperPath, platform: 'darwin', arch: 'universal' })
})

test('rejects unsupported platforms and non-absolute trusted roots explicitly', () => {
  assert.deepEqual(resolvePathAccessBroker({ platform: 'linux', isPackaged: false, appPath: '/app', resourcesPath: '/resources' }),
    { available: false, reason: 'unsupported-platform' })
  assert.deepEqual(resolvePathAccessBroker({ platform: 'win32', isPackaged: false, appPath: 'relative', resourcesPath: 'C:\\app\\resources' }),
    { available: false, reason: 'invalid-context' })
})
