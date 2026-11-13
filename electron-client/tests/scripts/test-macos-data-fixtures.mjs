import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMacDataFixtures, verifyMacDataFixtures } from './macos-data-fixtures.mjs'

test('real LevelDB and synthetic legacy encrypted fields reopen with exact contents and corruption rejection', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-data-fixture-test-')), root = path.join(parent, 'data')
  try {
    const created = await createMacDataFixtures(root)
    assert.equal(created.records, 6)
    const before = fs.readFileSync(path.join(root, 'data-fixture-manifest.json'))
    const first = await verifyMacDataFixtures(root), second = await verifyMacDataFixtures(root)
    assert.equal(first.records, 6); assert.equal(first.corruptRejected, true)
    assert.notEqual(first.verificationId, second.verificationId)
    assert.deepEqual(fs.readFileSync(path.join(root, 'data-fixture-manifest.json')), before)
    assert.ok(!JSON.stringify(first).includes('fixture-only-never-a-real-secret'))
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})
test('existing output, foreign owner and changed synthetic data are refused', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-data-fixture-test-')), root = path.join(parent, 'data')
  try {
    await createMacDataFixtures(root)
    await assert.rejects(createMacDataFixtures(root), /EEXIST/)
    fs.appendFileSync(path.join(root, 'vault/expected.json'), 'changed')
    await assert.rejects(verifyMacDataFixtures(root), /DATA_FIXTURE_CHANGED/)
    const owner = path.join(root, '.ztools-data-fixture-owner.json'), content = JSON.parse(fs.readFileSync(owner, 'utf8'))
    fs.writeFileSync(owner, JSON.stringify({ ...content, runId: 'foreign' }))
    await assert.rejects(verifyMacDataFixtures(root), /DATA_FIXTURE_OWNER_MISMATCH/)
    await assert.rejects(createMacDataFixtures('relative-root'), /ABSOLUTE_DATA_FIXTURE_ROOT_REQUIRED/)
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})
