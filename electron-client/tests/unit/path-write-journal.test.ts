import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { PathWriteJournal, type SealedJournalStore } from '../../src/main/platform/path-write-journal.js'
import { createJournalSealer } from '../../src/main/platform/path-write-journal-crypto.js'

const proof = Buffer.from('ZPW1\x01\x01synthetic proof', 'binary')
const hash = createHash('sha256').update('sdk').digest('hex')
test('closing drains accepted journal changes, preserves unresolved records and rejects new work', async () => {
  const f = fixture(), reserving = f.journal.reserve('win32', 'E:\\synthetic\\out', 3)
  const closing = f.journal.close(); assert.equal(f.journal.close(), closing)
  await assert.rejects(f.journal.pending(), /PATH_WRITE_JOURNAL_UNAVAILABLE/)
  const id = await reserving; await closing
  assert.equal((await new PathWriteJournal(f.store, f.sealer).pending())[0]!.id, id)
  await assert.rejects(f.journal.interrupted(id), /PATH_WRITE_JOURNAL_UNAVAILABLE/)
})

test('closing is bounded when the journal store stalls and an unconfirmed store cannot report clean shutdown', async () => {
  let release!: () => void
  const stalled = new PathWriteJournal({ read: () => new Promise(resolve => { release = () => resolve(undefined) }), replace: async () => {} },
    { seal: async text => Buffer.from(text), open: async bytes => bytes.toString() })
  const pending = stalled.pending(); await Promise.resolve()
  await assert.rejects(stalled.close(10), /PATH_WRITE_JOURNAL_UNAVAILABLE/)
  release(); await assert.rejects(pending, /PATH_WRITE_JOURNAL_UNAVAILABLE/)
  await assert.rejects(stalled.pending(), /PATH_WRITE_JOURNAL_UNAVAILABLE/)
  const f = fixture(); f.fail(); await assert.rejects(f.journal.reserve('win32', 'E:\\synthetic\\out', 1))
  await assert.rejects(f.journal.close(), /PATH_WRITE_JOURNAL_UNAVAILABLE/)
})

test('journal rejects excess queued operations before allocating further work', async () => {
  let release!: () => void
  const journal = new PathWriteJournal({ read: () => new Promise(resolve => { release = () => resolve(undefined) }), replace: async () => {} },
    { seal: async text => Buffer.from(text), open: async bytes => bytes.toString() })
  const accepted = Array.from({ length: 256 }, () => journal.pending())
  await assert.rejects(journal.pending(), /PATH_WRITE_JOURNAL_QUOTA/)
  release(); assert.equal((await Promise.all(accepted)).length, 256); await journal.close()
})
function fixture() {
  let encrypted: Buffer | undefined, replacements = 0, failWrite = false
  const store: SealedJournalStore = {
    read: async () => encrypted && Buffer.from(encrypted),
    replace: async bytes => { if (failWrite) throw new Error('unconfirmed'); encrypted = Buffer.from(bytes); replacements++ }
  }
  // Deliberately synthetic key wrapping, never an OS Keychain/credential test.
  const sealer = createJournalSealer({ isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => Buffer.from(value), decryptStringAsync: async bytes => ({ result: bytes.toString() }) })
  return { store, sealer, journal: new PathWriteJournal(store, sealer), replacements: () => replacements,
    bytes: () => encrypted!, setBytes: (value: Buffer) => { encrypted = value }, fail: () => { failWrite = true } }
}

test('durable intent, object proof, hash receipt and confirmed completion survive reconstructed journals', async () => {
  const f = fixture(), id = await f.journal.reserve('win32', 'E:\\synthetic\\output.txt', 3)
  assert.equal((await new PathWriteJournal(f.store, f.sealer).pending())[0]!.phase, 'intent')
  await f.journal.staged(id, proof); await f.journal.committing(id, 3, hash)
  const recovered = await new PathWriteJournal(f.store, f.sealer).pending()
  assert.deepEqual(recovered.map(item => [item.phase, item.receivedBytes, item.sha256]), [['committing', 3, hash]])
  assert.ok(!f.bytes().includes(Buffer.from('output.txt')))
  assert.ok(!f.bytes().includes(Buffer.from('synthetic proof')))
  await f.journal.committed(id)
  assert.deepEqual(await new PathWriteJournal(f.store, f.sealer).pending(), [])
  assert.equal(f.replacements(), 4)
})

test('failed or unknown writes retain last authenticated evidence, with no automatic replay or deletion', async () => {
  const f = fixture(), id = await f.journal.reserve('win32', 'E:\\synthetic\\output.txt', undefined)
  await f.journal.staged(id, proof); await f.journal.interrupted(id)
  const pending = await new PathWriteJournal(f.store, f.sealer).pending()
  assert.equal(pending[0]!.phase, 'unknown'); assert.equal(pending[0]!.expectedBytes, null)
  assert.equal(pending[0]!.proof, proof.toString('base64'))
  await assert.rejects(f.journal.committed(id))
  assert.equal((await f.journal.pending()).length, 1)
})

test('phase ordering, lengths, hashes and platform path/proof must match before persistence', async () => {
  const f = fixture(), id = await f.journal.reserve('win32', 'E:\\synthetic\\out', 3)
  await assert.rejects(f.journal.committing(id, 3, hash))
  await assert.rejects(f.journal.staged(id, Buffer.from('ZPW1\x02\x01wrong platform', 'binary')))
  await assert.rejects(f.journal.staged(id, Buffer.alloc(0)))
  await f.journal.staged(id, proof)
  await assert.rejects(f.journal.committing(id, 2, hash))
  await assert.rejects(f.journal.committing(id, 3, 'invalid'))
  await assert.rejects(f.journal.reserve('darwin', 'relative/file', 0))
  await assert.rejects(f.journal.reserve('win32', 'E:\\synthetic\\out', -1))
  assert.equal(f.replacements(), 2)
})

test('concurrent reservations serialize; unresolved records exhaust bounded quota without dropping evidence', async () => {
  const f = fixture()
  const ids = await Promise.all(Array.from({ length: 256 }, (_, i) => f.journal.reserve('darwin', `/synthetic/${i}`, 0)))
  assert.equal(new Set(ids).size, 256)
  await assert.rejects(f.journal.reserve('darwin', '/synthetic/overflow', 0), /QUOTA/)
  assert.equal((await new PathWriteJournal(f.store, f.sealer).pending()).length, 256)
  assert.equal(f.replacements(), 256)
})

test('unconfirmed atomic ledger replacement poisons the writer and preserves the previous durable snapshot', async () => {
  const f = fixture(), id = await f.journal.reserve('win32', 'E:\\synthetic\\out', 0)
  f.fail(); await assert.rejects(f.journal.staged(id, proof))
  await assert.rejects(f.journal.reserve('win32', 'E:\\synthetic\\next', 0))
  assert.equal((await new PathWriteJournal(f.store, f.sealer).pending())[0]!.phase, 'intent')
  assert.equal(f.replacements(), 1)
})

test('unknown-length intent reserves worst-case bytes; interrupted writers cannot exhaust unbounded disk', async () => {
  const f = fixture(), first = await f.journal.reserve('win32', 'E:\\synthetic\\first', undefined)
  await f.journal.reserve('win32', 'E:\\synthetic\\second', undefined)
  await assert.rejects(f.journal.reserve('win32', 'E:\\synthetic\\third', 1), /QUOTA/)
  assert.equal((await new PathWriteJournal(f.store, f.sealer).pending()).length, 2)
  await f.journal.staged(first, proof); await f.journal.committing(first, 0, createHash('sha256').update('').digest('hex'))
  await f.journal.committed(first)
  await f.journal.reserve('win32', 'E:\\synthetic\\third', 1024)
  assert.equal((await f.journal.pending()).length, 2)
  const records = await f.journal.pending()
  const unknown = { ...records[0]!, phase: 'unknown' as const }
  f.setBytes(await f.sealer.seal(JSON.stringify({ schemaVersion: 1, records: [unknown,
    { ...unknown, id: '11111111-1111-4111-8111-111111111111' },
    { ...unknown, id: '22222222-2222-4222-8222-222222222222' }] })))
  await assert.rejects(new PathWriteJournal(f.store, f.sealer).pending(), /UNAVAILABLE/)
})

test('authenticated snapshots reject ciphertext, wrapped key, nonce, tag and header tampering', async () => {
  const f = fixture(); await f.journal.reserve('darwin', '/synthetic/out', 1)
  const original = f.bytes(), wrappedLength = original.readUInt32LE(4)
  for (const offset of [0, 4, 8, 8 + wrappedLength, 20 + wrappedLength, original.length - 1]) {
    const damaged = Buffer.from(original); damaged[offset] = damaged[offset]! ^ 1; f.setBytes(damaged)
    const journal = new PathWriteJournal(f.store, f.sealer)
    await assert.rejects(journal.pending(), /UNAVAILABLE/)
    await assert.rejects(journal.reserve('darwin', '/synthetic/new', 0), /UNAVAILABLE/)
  }
  f.setBytes(original)
  assert.equal((await new PathWriteJournal(f.store, f.sealer).pending()).length, 1)
})

test('unavailable OS key protection fails closed with no plaintext persistence', async () => {
  const f = fixture(), unavailable = createJournalSealer({ isAsyncEncryptionAvailable: async () => false,
    encryptStringAsync: async () => { throw new Error('must not call') }, decryptStringAsync: async () => { throw new Error('must not call') } })
  const journal = new PathWriteJournal(f.store, unavailable)
  await assert.rejects(journal.reserve('darwin', '/synthetic/out', 0))
  assert.equal(f.replacements(), 0)
})

test('invalid schema, duplicates, excessive records and injected properties are rejected after decryption', async () => {
  const f = fixture(), id = await f.journal.reserve('darwin', '/synthetic/out', 0)
  const [record] = await f.journal.pending()
  for (const value of [{ schemaVersion: 2, records: [] }, { schemaVersion: 1, records: [record, record] },
    { schemaVersion: 1, records: Array(257).fill(record) }, { schemaVersion: 1, records: [{ ...record, injectedPath: '/foreign' }] },
    { schemaVersion: 1, records: [{ ...record, id, phase: 'committing' }] }]) {
    f.setBytes(await f.sealer.seal(JSON.stringify(value)))
    await assert.rejects(new PathWriteJournal(f.store, f.sealer).pending())
  }
})

test('two live unknown-size reservations exhaust the byte budget before a third is admitted', async () => {
  const f = fixture()
  await f.journal.reserve('darwin', '/synthetic/recovered-unknown-1', undefined)
  await f.journal.reserve('darwin', '/synthetic/recovered-unknown-2', undefined)
  const recovered = new PathWriteJournal(f.store, f.sealer)
  const results = await Promise.allSettled(Array.from({ length: 3 }, (_, index) =>
    recovered.reserve('darwin', `/synthetic/live-${index}`, undefined)))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2)
  const rejected = results.find(result => result.status === 'rejected')
  assert.ok(rejected && rejected.status === 'rejected' && /QUOTA/.test(String(rejected.reason)))
  assert.equal((await recovered.pending()).length, 4)
})

test('reconstructed clean intents do not reserve staged bytes, but remain subject to the record cap', async () => {
  const f = fixture()
  await f.journal.reserve('win32', 'E:\\synthetic\\cold-unknown-1', undefined)
  await f.journal.reserve('win32', 'E:\\synthetic\\cold-unknown-2', undefined)
  const recovered = new PathWriteJournal(f.store, f.sealer)
  const id = await recovered.reserve('win32', 'E:\\synthetic\\after-restart', 1)
  assert.equal((await recovered.pending()).length, 3)
  assert.equal((await recovered.pending()).find(record => record.id === id)?.expectedBytes, 1)

  const full = fixture()
  await Promise.all(Array.from({ length: 256 }, (_, index) =>
    full.journal.reserve('darwin', `/synthetic/cold-record-${index}`, 0)))
  const fullRecovered = new PathWriteJournal(full.store, full.sealer)
  await assert.rejects(fullRecovered.reserve('darwin', '/synthetic/overflow', 0), /QUOTA/)
  assert.equal((await fullRecovered.pending()).length, 256)
})

test('reconstructed unknown rows remain fully charged whether or not they have object proof', async () => {
  const f = fixture()
  const prooflessUnknown = await f.journal.reserve('win32', 'E:\\synthetic\\unknown-no-proof', undefined)
  await f.journal.interrupted(prooflessUnknown)
  const proofBearingUnknown = await f.journal.reserve('win32', 'E:\\synthetic\\unknown-with-proof', undefined)
  await f.journal.staged(proofBearingUnknown, proof)
  await f.journal.interrupted(proofBearingUnknown)

  const recovered = new PathWriteJournal(f.store, f.sealer)
  await assert.rejects(recovered.reserve('win32', 'E:\\synthetic\\over-budget', 1), /QUOTA/)
  const records = await recovered.pending()
  assert.deepEqual(records.map(record => [record.phase, Boolean(record.proof)]), [['unknown', false], ['unknown', true]])
})

test('promoting a recovered intent rechecks budget and preserves the durable snapshot when over quota', async () => {
  const f = fixture()
  const charged = await f.journal.reserve('win32', 'E:\\synthetic\\charged-staging', undefined)
  await f.journal.staged(charged, proof)
  const candidate = await f.journal.reserve('win32', 'E:\\synthetic\\candidate-intent', undefined)
  const recovered = new PathWriteJournal(f.store, f.sealer)
  const active = await recovered.reserve('win32', 'E:\\synthetic\\active-small', 1)
  assert.equal((await recovered.pending()).find(record => record.id === active)?.expectedBytes, 1)
  const durableBeforePromotion = Buffer.from(f.bytes())

  await assert.rejects(recovered.staged(candidate, proof), /QUOTA/)
  assert.deepEqual(f.bytes(), durableBeforePromotion)
  const persisted = await new PathWriteJournal(f.store, f.sealer).pending()
  assert.equal(persisted.find(record => record.id === candidate)?.phase, 'intent')
  assert.equal(persisted.find(record => record.id === candidate)?.proof, undefined)
})
