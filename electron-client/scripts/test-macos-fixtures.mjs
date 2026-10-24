import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createMacFixtures, verifyMacFixtures } from './macos-fixtures.mjs'

test('synthetic fixtures contain readable browser SQL, Unicode paths, and owned checksums', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-mac-fixtures-'))
  try {
    const root = path.join(parent, 'run')
    const manifest = await createMacFixtures(root)
    assert.equal(verifyMacFixtures(root).files, manifest.files.length)
    const { DatabaseSync } = await import('node:sqlite')
    for (const [file, sql, title] of [
      ['browser/chromium/Default/History', 'SELECT u.title FROM urls u JOIN visits v ON u.id = v.url', 'Synthetic 历史'],
      ['browser/firefox/test.default/places.sqlite', 'SELECT p.title FROM moz_places p JOIN moz_historyvisits h ON p.id = h.place_id', 'Synthetic Firefox']
    ]) {
      const db = new DatabaseSync(path.join(root, file), { readOnly: true })
      try { assert.equal(db.prepare(sql).get().title, title) } finally { db.close() }
    }
    const original = fs.readFileSync(path.join(root, 'fixture-manifest.json'))
    await assert.rejects(createMacFixtures(root), /EEXIST/)
    assert.deepEqual(fs.readFileSync(path.join(root, 'fixture-manifest.json')), original)
    assert.ok(manifest.pending.includes('encrypted legacy vault'))
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})

test('fixture verification rejects tampered files, foreign owner and escaped paths', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-mac-fixtures-'))
  try {
    const root = path.join(parent, 'run')
    const manifest = await createMacFixtures(root)
    fs.writeFileSync(path.join(root, 'files/source.txt'), 'changed')
    assert.throws(() => verifyMacFixtures(root), /FIXTURE_CHANGED/)
    const changed = { ...manifest, files: [{ path: '../outside.txt', sha256: 'x' }] }
    fs.writeFileSync(path.join(root, 'fixture-manifest.json'), JSON.stringify(changed))
    assert.throws(() => verifyMacFixtures(root), /INVALID_FIXTURE_PATH/)
    fs.writeFileSync(path.join(root, 'fixture-manifest.json'), JSON.stringify({ ...manifest, runId: 'foreign' }))
    assert.throws(() => verifyMacFixtures(root), /FIXTURE_OWNER_MISMATCH/)
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})

test('relative fixture roots rejected before creating anything', async () => {
  await assert.rejects(createMacFixtures('../user-profile'), /ABSOLUTE_FIXTURE_ROOT_REQUIRED/)
})
