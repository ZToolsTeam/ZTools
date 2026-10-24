import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyCredentialPortability,
  classifyExternalPath,
  findPluginIdConflicts,
  getPlatformCapabilities,
  resolvePortableRuntimePaths,
} from '../../src/main/runtime/portable-platform.js'
import {
  createPortableDataExport,
  mergePortableDataExports,
  parsePortableDataExport,
  stablePortableStringify,
} from '../../src/main/runtime/portable-data.js'

test('portable runtime paths preserve platform-specific path semantics', () => {
  const windows = resolvePortableRuntimePaths({
    platform: 'win32',
    mode: 'production',
    appDataRoot: 'C:\\Users\\tester\\AppData\\Roaming',
    installRoot: 'D:\\Apps\\ZTools',
    ownerId: 'tester',
  })
  assert.equal(windows.businessDataRoot, 'C:\\Users\\tester\\AppData\\Roaming\\ZTools\\DataV2')

  const linux = resolvePortableRuntimePaths({
    platform: 'linux',
    mode: 'test',
    appDataRoot: '/home/tester/.config',
    installRoot: '/opt/ztools',
    userDataRoot: '/tmp/ztools-test',
    ownerId: 'tester',
  })
  assert.equal(linux.businessDataRoot, '/tmp/ztools-test/test/Data')
  assert.equal(linux.transactionRoot, '/tmp/ztools-test/test/Migration/Transactions')
})

test('portable paths preserve Unicode and UNC roots and reject relative roots', () => {
  const paths = resolvePortableRuntimePaths({
    platform: 'win32',
    mode: 'test',
    appDataRoot: 'C:\\用户\\数据',
    installRoot: '\\\\server\\共享\\ZTools',
    userDataRoot: 'D:\\测试\\运行时',
    ownerId: '用户'
  })
  assert.equal(paths.installRoot, '\\\\server\\共享\\ZTools')
  assert.equal(paths.businessDataRoot, 'D:\\测试\\运行时\\test\\Data')
  assert.equal(paths.ownerId, '用户')
  assert.throws(() => resolvePortableRuntimePaths({
    platform: 'linux',
    mode: 'test',
    appDataRoot: 'relative-app-data',
    installRoot: '/opt/ztools'
  }), /appDataRoot must be an absolute path/)
})

test('Windows plugin IDs use case-insensitive collision detection without renaming', () => {
  assert.deepEqual(findPluginIdConflicts('win32', ['Alpha', 'alpha', 'Beta']), [
    { comparisonKey: 'alpha', pluginIds: ['Alpha', 'alpha'] },
  ])
  assert.deepEqual(findPluginIdConflicts('linux', ['Alpha', 'alpha']), [])
})

test('external paths are classified instead of silently rewritten', () => {
  assert.deepEqual(classifyExternalPath('win32', 'C:\\Users\\tester\\Data', 'C:\\Users\\tester\\Data\\plugin\\cache'), {
    originalPath: 'C:\\Users\\tester\\Data\\plugin\\cache',
    relativePath: 'plugin\\cache',
    state: 'portable-relative',
  })
  assert.equal(classifyExternalPath('win32', 'C:\\Users\\tester\\Data', 'D:\\Cache').state, 'requires-relink')
})

test('capability and credential contracts make unsupported features explicit', () => {
  assert.equal(getPlatformCapabilities('darwin', 'arm64').nativeHost.state, 'unsupported')
  assert.equal(getPlatformCapabilities('win32', 'x64').privilegedService.state, 'requires-user-action')
  assert.equal(classifyCredentialPortability({ encrypted: true, sourcePlatform: 'win32', targetPlatform: 'linux' }).state, 'unsupported')
  assert.equal(classifyCredentialPortability({ encrypted: false, sourcePlatform: 'win32', targetPlatform: 'linux' }).state, 'supported')
})

test('portable data encodes big integers as decimal strings and has stable ordering', () => {
  const exportData = createPortableDataExport({
    source: { platform: 'win32', arch: 'ia32' },
    pluginId: 'demo',
    config: { z: 2, a: 1n, unsafeAsString: '9007199254740992' },
    pluginState: { enabled: true },
    triggers: [{ event: 'startup', command: 'demo' }],
    leveldb: [{ key: 'counter', value: '9007199254740993', encoding: 'utf8' }],
  })
  assert.equal((exportData.config as { a: string }).a, '1')
  const serialized = stablePortableStringify(exportData)
  assert.ok(serialized.indexOf('"a":"1"') < serialized.indexOf('"z":2'))
  assert.deepEqual(parsePortableDataExport(serialized), exportData)
})

test('portable data keeps Unicode and UTC strings while rejecting unsafe numeric integers', () => {
  const exportData = createPortableDataExport({
    source: { platform: 'linux', arch: 'x64' },
    pluginId: '中文插件',
    config: { label: '你好', updatedAt: '2025-01-02T03:04:05.000Z', count: 9007199254740993n },
    pluginState: {},
    triggers: []
  })
  const serialized = stablePortableStringify(exportData)
  const parsed = parsePortableDataExport(serialized)
  assert.equal((parsed.config as { label: string }).label, '你好')
  assert.equal((parsed.config as { updatedAt: string }).updatedAt, '2025-01-02T03:04:05.000Z')
  assert.equal((parsed.config as { count: string }).count, '9007199254740993')
  assert.throws(() => createPortableDataExport({
    source: { platform: 'linux', arch: 'x64' },
    pluginId: 'unsafe',
    config: { count: Number.MAX_SAFE_INTEGER + 1 },
    pluginState: {},
    triggers: []
  }), /unsafe integer/)
})

test('portable merge preserves target values and reports conflicts', () => {
  const existing = createPortableDataExport({
    source: { platform: 'win32', arch: 'ia32' },
    pluginId: 'demo',
    config: { keep: 'target', onlyTarget: true },
    pluginState: {},
    triggers: [],
    leveldb: [{ key: 'k', value: 'target', encoding: 'utf8' }],
    extra: { unknownTargetField: 'preserved' },
  })
  const incoming = createPortableDataExport({
    source: { platform: 'linux', arch: 'x64' },
    pluginId: 'demo',
    config: { keep: 'source', onlySource: true },
    pluginState: {},
    triggers: [],
    leveldb: [{ key: 'k', value: 'source', encoding: 'utf8' }, { key: 'new', value: 'value' }],
    extra: { unknownSourceField: 'preserved' },
  })
  const merged = mergePortableDataExports(existing, incoming)
  assert.equal((merged.data.config as { keep: string }).keep, 'target')
  assert.equal((merged.data.config as { onlySource: boolean }).onlySource, true)
  assert.equal(merged.data.leveldb.length, 2)
  assert.equal(merged.conflicts.length, 2)
  assert.equal((merged.data.extra as { unknownTargetField: string }).unknownTargetField, 'preserved')
})

test('portable merge is idempotent and never rewrites the target with an old export', () => {
  const existing = createPortableDataExport({
    source: { platform: 'win32', arch: 'ia32' },
    pluginId: 'demo',
    config: { value: 'new' },
    pluginState: { enabled: true },
    triggers: [],
    leveldb: [{ key: 'value', value: 'new', encoding: 'utf8' }]
  })
  const incoming = createPortableDataExport({
    source: { platform: 'win32', arch: 'ia32' },
    pluginId: 'demo',
    config: { value: 'old' },
    pluginState: { enabled: false },
    triggers: [],
    leveldb: [{ key: 'value', value: 'old', encoding: 'utf8' }]
  })
  const first = mergePortableDataExports(existing, incoming)
  const second = mergePortableDataExports(first.data, incoming)
  assert.deepEqual(second.data, first.data)
  assert.equal(second.conflicts.length, first.conflicts.length)
})
