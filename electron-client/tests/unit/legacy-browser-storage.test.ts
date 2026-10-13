import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { ClassicLevel } from 'classic-level'
import type { Session } from 'electron'
import {
  buildLegacyStorageImportScript,
  decodeLegacyStorageValue,
  LegacyBrowserStorageMigrator,
  type LegacyBrowserStorageWriter,
  type LegacyLocalStorageRecord
} from '../../src/main/runtime/legacy-browser-storage.js'

const LEGACY_ORIGIN = 'ztools://plugins'

test('legacy browser storage imports owned localStorage from a closed copy only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-legacy-browser-'))
  const sourceRoot = path.join(root, 'CEF Libraries', 'cache')
  const levelDbPath = path.join(sourceRoot, 'Local Storage', 'leveldb')
  const transactionRoot = path.join(root, 'Migration', 'Transactions')
  const writes: Array<{ pluginId: string; entries: LegacyLocalStorageRecord[] }> = []
  const writer: LegacyBrowserStorageWriter = {
    async write(_targetSession, pluginId, entries) {
      writes.push({ pluginId, entries: [...entries] })
      return { imported: entries.length, existingPreserved: 0 }
    }
  }

  try {
    await writeLegacyLevelDb(levelDbPath)
    await fs.mkdir(path.join(sourceRoot, 'IndexedDB', 'https_example.test_0.indexeddb.leveldb'), {
      recursive: true
    })
    await fs.mkdir(path.join(sourceRoot, 'Network'), { recursive: true })
    await fs.writeFile(path.join(sourceRoot, 'Network', 'Cookies'), 'cookie fixture', 'utf8')
    const before = await treeDigest(sourceRoot)
    const migrator = new LegacyBrowserStorageMigrator({
      sourceRoot,
      transactionRoot,
      writer
    })

    const audioResult = await migrator.migratePlugin('batch-audio', {} as Session)
    const translatorResult = await migrator.migratePlugin('translator', {} as Session)

    assert.equal(audioResult.status, 'imported')
    assert.equal(audioResult.imported, 1)
    assert.deepEqual(writes[0], {
      pluginId: 'batch-audio',
      entries: [{
        origin: LEGACY_ORIGIN,
        key: 'batch_audio_output_dir',
        value: 'C:\\legacy\\audio',
        encoding: 'utf16le'
      }]
    })
    assert.equal(translatorResult.status, 'imported')
    assert.deepEqual(writes[1]?.entries.map(({ key, value }) => ({ key, value })), [{
      key: 'translator:history',
      value: '["legacy"]'
    }])
    assert.ok(audioResult.unsupported.includes('indexeddb-not-imported'))
    assert.ok(audioResult.unsupported.includes('cookies-not-imported'))
    assert.ok(audioResult.unsupported.includes('local-storage-decode-failures'))
    assert.equal(await treeDigest(sourceRoot), before)
    assert.deepEqual(await fs.readdir(transactionRoot), [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('legacy storage decoding and target merge preserve new values', () => {
  assert.deepEqual(
    decodeLegacyStorageValue(Buffer.concat([Buffer.from([0]), Buffer.from('旧值', 'utf16le')])),
    { value: '旧值', encoding: 'utf16le' }
  )
  assert.deepEqual(
    decodeLegacyStorageValue(Buffer.concat([Buffer.from([1]), Buffer.from('café', 'latin1')])),
    { value: 'café', encoding: 'latin1' }
  )
  assert.deepEqual(
    decodeLegacyStorageValue(Buffer.from('{"ok":true}', 'utf8')),
    { value: '{"ok":true}', encoding: 'utf8' }
  )
  assert.equal(decodeLegacyStorageValue(Buffer.from([0xff, 0xfe])), undefined)

  const script = buildLegacyStorageImportScript([
    {
      origin: LEGACY_ORIGIN,
      key: 'existing',
      value: 'legacy',
      encoding: 'utf8'
    },
    {
      origin: LEGACY_ORIGIN,
      key: 'missing',
      value: 'imported',
      encoding: 'utf8'
    }
  ])
  const values = new Map([['existing', 'new']])
  const result = vm.runInNewContext(script, {
    localStorage: {
      getItem(key: string) {
        return values.has(key) ? values.get(key) : null
      },
      setItem(key: string, value: string) {
        values.set(key, value)
      }
    }
  }) as { imported: number; existingPreserved: number }
  assert.equal(result.imported, 1)
  assert.equal(result.existingPreserved, 1)
  assert.equal(values.get('existing'), 'new')
  assert.equal(values.get('missing'), 'imported')
})

test('legacy storage inspection and repeated migration expose unsupported assets without overwriting new values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-legacy-browser-repeat-'))
  const sourceRoot = path.join(root, 'CEF Libraries', 'cache')
  const levelDbPath = path.join(sourceRoot, 'Local Storage', 'leveldb')
  const transactionRoot = path.join(root, 'Migration', 'Transactions')
  const values = new Map<string, string>()
  const writer: LegacyBrowserStorageWriter = {
    async write(_targetSession, _pluginId, entries) {
      let imported = 0
      let existingPreserved = 0
      for (const entry of entries) {
        if (values.has(entry.key)) existingPreserved += 1
        else {
          values.set(entry.key, entry.value)
          imported += 1
        }
      }
      return { imported, existingPreserved }
    }
  }

  try {
    await writeLegacyLevelDb(levelDbPath)
    const migrator = new LegacyBrowserStorageMigrator({ sourceRoot, transactionRoot, writer })
    const snapshot = await migrator.inspect()
    assert.equal(snapshot.sourceFound, true)
    assert.equal(snapshot.localStorage.length, 3)
    assert.equal(snapshot.decodeFailures, 1)

    const first = await migrator.migratePlugin('batch-audio', {} as Session)
    assert.equal(first.imported, 1)
    values.set('batch_audio_output_dir', 'new-value')
    const second = await migrator.migratePlugin('batch-audio', {} as Session)
    assert.equal(second.imported, 0)
    assert.equal(second.existingPreserved, 1)
    assert.equal(values.get('batch_audio_output_dir'), 'new-value')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

async function writeLegacyLevelDb(levelDbPath: string): Promise<void> {
  await fs.mkdir(levelDbPath, { recursive: true })
  const store = new ClassicLevel<Buffer, Buffer>(levelDbPath, {
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
    compression: false
  })
  try {
    await store.open()
    await store.put(
      Buffer.from('_' + LEGACY_ORIGIN + '\0batch_audio_output_dir', 'utf8'),
      Buffer.concat([Buffer.from([0]), Buffer.from('C:\\legacy\\audio', 'utf16le')])
    )
    await store.put(
      Buffer.from('_' + LEGACY_ORIGIN + '\0translator:history', 'utf8'),
      Buffer.from('["legacy"]', 'utf8')
    )
    await store.put(
      Buffer.from('_' + LEGACY_ORIGIN + '\0not-owned', 'utf8'),
      Buffer.from('ignored', 'utf8')
    )
    await store.put(
      Buffer.from('_' + LEGACY_ORIGIN + '\0not-owned-corrupt', 'utf8'),
      Buffer.from([0xff])
    )
    await store.put(
      Buffer.from('_https://example.test\0batch_audio_output_dir', 'utf8'),
      Buffer.from('wrong-origin', 'utf8')
    )
  } finally {
    await store.close()
  }
}

async function treeDigest(root: string): Promise<string> {
  const entries: string[] = []
  await collectTree(root, '', entries)
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex')
}

async function collectTree(root: string, relative: string, entries: string[]): Promise<void> {
  const current = path.join(root, relative)
  const children = await fs.readdir(current, { withFileTypes: true })
  children.sort((left, right) => left.name.localeCompare(right.name))
  for (const child of children) {
    const childRelative = path.join(relative, child.name)
    const target = path.join(root, childRelative)
    const stats = await fs.lstat(target)
    if (stats.isDirectory()) {
      entries.push('directory:' + childRelative)
      await collectTree(root, childRelative, entries)
    } else {
      entries.push('file:' + childRelative + ':' + (await fs.readFile(target)).toString('base64'))
    }
  }
}
