import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash, webcrypto } from 'node:crypto'
import { ClassicLevel } from 'classic-level'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fixtureKeyIV = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const fields = { title: 'synthetic vault 中文', username: 'fixture@example.invalid', password: 'fixture-only-never-a-real-secret' }

async function legacyVaultEncrypt(value) {
  const key = await webcrypto.subtle.importKey('raw', Buffer.from(fixtureKeyIV.slice(0, 32)), 'AES-GCM', false, ['encrypt'])
  return Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: Buffer.from(fixtureKeyIV.slice(32, 44)) }, key, Buffer.from(value))).toString('base64')
}

function regularInventory(root) {
  const files = []; let totalBytes = 0
  const visit = (directory, prefix = '') => {
    if (prefix.split('/').length > 16) throw new Error('DATA_FIXTURE_DEPTH_LIMIT')
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, item.name), relative = prefix + item.name
      const stats = fs.lstatSync(target)
      if (stats.isSymbolicLink()) throw new Error('DATA_FIXTURE_SYMLINK')
      if (stats.isDirectory()) visit(target, relative + '/')
      else if (stats.isFile()) {
        totalBytes += stats.size
        if (stats.size > 16 * 1024 * 1024 || totalBytes > 128 * 1024 * 1024 || files.length >= 1024) throw new Error('DATA_FIXTURE_SIZE_LIMIT')
        files.push({ path: relative, sha256: hash(fs.readFileSync(target)) })
      }
      else throw new Error('DATA_FIXTURE_NONREGULAR')
    }
  }
  visit(root)
  return files
}

async function legacyCrypto() {
  // The CLI compiles the maintained implementation first, avoiding a copied cipher.
  return import('../out-test/src/main/services/database-service.js')
}

export async function createMacDataFixtures(outputRoot) {
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) throw new Error('ABSOLUTE_DATA_FIXTURE_ROOT_REQUIRED')
  const { encryptLegacySecure } = await legacyCrypto()
  fs.mkdirSync(path.dirname(outputRoot), { recursive: true })
  fs.mkdirSync(outputRoot)
  const root = fs.realpathSync(outputRoot), runId = randomUUID()
  const write = (relative, value) => {
    const target = path.join(root, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  }
  write('.ztools-data-fixture-owner.json', { version: 1, runId, root, scope: 'synthetic-only' })
  const account = { _id: 'account/1704067200000', groupId: 'group/1704067200000', createdAt: 1704067200000, sort: 0 }
  for (const [name, value] of Object.entries(fields)) account[name] = await legacyVaultEncrypt(value)
  const datasets = {
    time: [['fixture-counter', '3'], ['unicode', '中文-é-😀']],
    password: [['bcryptpass', JSON.stringify({ _id: 'bcryptpass', set: true })],
      ['secure:encryption_key', encryptLegacySecure('password', 'encryption_key', fixtureKeyIV)],
      [account._id, JSON.stringify(account)]],
    'fixture-other': [['sentinel', 'cross-plugin access must fail']]
  }
  for (const [namespace, entries] of Object.entries(datasets)) {
    const store = new ClassicLevel(path.join(root, 'LevelDB', namespace), { keyEncoding: 'utf8', valueEncoding: 'buffer', compression: false })
    try {
      await store.open()
      await store.batch(entries.map(([key, value]) => ({ type: 'put', key, value: Buffer.from(value) })), { sync: true })
    } finally { await store.close() }
  }
  write('vault/synthetic-key-material.json', { synthetic: true, keyIV: fixtureKeyIV })
  write('vault/legacy-account.json', account)
  const damaged = Buffer.from(account.password, 'base64'); damaged[damaged.length - 1] ^= 1
  write('vault/corrupt-account.json', { ...account, password: damaged.toString('base64') })
  write('vault/expected.json', { synthetic: true, fields })
  const manifest = { version: 1, runId, root, scope: 'synthetic-only', producer: 'classic-level-3.0.0-uncompressed-legacy-key-layout',
    namespaces: Object.entries(datasets).map(([namespace, entries]) => ({ namespace, count: entries.length,
      entries: entries.map(([key, value]) => ({ key, sha256: hash(Buffer.from(value)) })) })),
    files: regularInventory(root),
    pending: ['Delphi-produced compressed SST compatibility', 'new encrypted vault migration', 'Keychain authorization and loss', 'final packaged App persistence'] }
  write('data-fixture-manifest.json', manifest)
  return { status: 'PASS', runId, root, files: manifest.files.length, records: 6, scope: 'synthetic-data-preparation', pending: manifest.pending }
}

function verifiedManifest(root) {
  const canonical = fs.realpathSync(root)
  const manifest = JSON.parse(fs.readFileSync(path.join(canonical, 'data-fixture-manifest.json'), 'utf8'))
  const owner = JSON.parse(fs.readFileSync(path.join(canonical, '.ztools-data-fixture-owner.json'), 'utf8'))
  if (manifest.version !== 1 || owner.version !== 1 || manifest.root !== canonical || owner.root !== canonical ||
      manifest.scope !== 'synthetic-only' || owner.scope !== 'synthetic-only' || manifest.runId !== owner.runId ||
      !/^[a-f0-9-]{36}$/.test(manifest.runId) || !Array.isArray(manifest.files)) throw new Error('DATA_FIXTURE_OWNER_MISMATCH')
  const actual = regularInventory(canonical).filter(item => item.path !== 'data-fixture-manifest.json' && !item.path.startsWith('verification-runs/'))
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('DATA_FIXTURE_CHANGED')
  return manifest
}

export async function verifyMacDataFixtures(root) {
  const manifest = verifiedManifest(root), { decryptLegacySecure } = await legacyCrypto()
  // Opening LevelDB can update logs/SSTs. Inspect a new owned copy, retaining the source fixture.
  const verificationId = randomUUID(), copyRoot = path.join(manifest.root, 'verification-runs', verificationId)
  fs.mkdirSync(path.dirname(copyRoot), { recursive: true }); fs.mkdirSync(copyRoot)
  for (const item of manifest.files) {
    if (!item.path.startsWith('LevelDB/')) continue
    const destination = path.join(copyRoot, item.path)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.copyFileSync(path.join(manifest.root, item.path), destination, fs.constants.COPYFILE_EXCL)
  }
  let records = 0
  for (const expected of manifest.namespaces) {
    if (!['time', 'password', 'fixture-other'].includes(expected.namespace)) throw new Error('INVALID_DATA_FIXTURE_NAMESPACE')
    const store = new ClassicLevel(path.join(copyRoot, 'LevelDB', expected.namespace), { keyEncoding: 'utf8', valueEncoding: 'buffer', compression: false, createIfMissing: false })
    try {
      await store.open()
      const entries = []
      for await (const [key, value] of store.iterator()) entries.push({ key, sha256: hash(value) })
      if (entries.length !== expected.count || JSON.stringify(entries) !== JSON.stringify([...expected.entries].sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key))))) throw new Error('DATA_FIXTURE_CONTENT_MISMATCH')
      records += entries.length
      if (expected.namespace === 'password') {
        const keyIV = decryptLegacySecure('password', 'encryption_key', (await store.get('secure:encryption_key')).toString('utf8'))
        if (keyIV !== fixtureKeyIV) throw new Error('DATA_FIXTURE_KEY_MISMATCH')
      }
    } finally { await store.close() }
  }
  const decrypt = async account => {
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(fixtureKeyIV.slice(0, 32)), 'AES-GCM', false, ['decrypt'])
    const result = {}
    for (const name of Object.keys(fields)) result[name] = Buffer.from(await webcrypto.subtle.decrypt(
      { name: 'AES-GCM', iv: Buffer.from(fixtureKeyIV.slice(32, 44)) }, key, Buffer.from(account[name], 'base64'))).toString('utf8')
    return result
  }
  const account = JSON.parse(fs.readFileSync(path.join(manifest.root, 'vault/legacy-account.json'), 'utf8'))
  if (JSON.stringify(await decrypt(account)) !== JSON.stringify(fields)) throw new Error('DATA_FIXTURE_VAULT_MISMATCH')
  let corruptRejected = false
  try { await decrypt(JSON.parse(fs.readFileSync(path.join(manifest.root, 'vault/corrupt-account.json'), 'utf8'))) }
  catch { corruptRejected = true }
  if (!corruptRejected) throw new Error('DATA_FIXTURE_CORRUPTION_NOT_REJECTED')
  verifiedManifest(manifest.root)
  return { status: 'PASS', runId: manifest.runId, verificationId, records, corruptRejected, scope: 'synthetic-data-readback', pending: manifest.pending }
}
