import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { withMacApfsFixtures } from './macos-apfs-fixtures.mjs'

function tools({ foreignOnCleanup = false, failAttach = false } = {}) {
  const mounted = [], calls = []
  let executing = false
  return { calls, mounted, markExecuting() { executing = true },
    parsePlist: value => value,
    probe: () => {},
    createFixtures: async root => fs.mkdirSync(root),
    run(tool, args) {
      calls.push([tool, args])
      if (args[0] === 'create') { fs.writeFileSync(args.at(-1), 'synthetic image'); return '' }
      if (args[0] === 'attach') {
        if (failAttach) throw new Error('ATTACH_FAILED')
        const mount = args[args.indexOf('-mountpoint') + 1]
        const volume = { image: args.at(-1), mount, device: `/dev/disk${mounted.length + 10}s1`, uuid: '11111111-2222-3333-4444-555555555555' }
        mounted.push(volume)
        return { 'system-entities': [{ 'mount-point': mount, 'dev-entry': volume.device }] }
      }
      if (tool.endsWith('diskutil')) {
        const volume = mounted.find(v => v.device === args.at(-1))
        return { VolumeUUID: executing && foreignOnCleanup ? 'different-volume' : volume.uuid,
          DeviceNode: volume.device, MountPoint: volume.mount, FilesystemType: 'apfs' }
      }
      if (args[0] === 'info') return { images: mounted.map(volume => ({ 'image-path': volume.image,
        'system-entities': [{ 'mount-point': volume.mount, 'dev-entry': volume.device }] })) }
      if (args[0] === 'detach') { mounted.splice(mounted.findIndex(v => v.device === args[1]), 1); return '' }
      throw new Error('UNEXPECTED_TOOL')
    }
  }
}

test('Windows APFS gate is NOT_RUN before any filesystem or tool operation', async () => {
  assert.deepEqual(await withMacApfsFixtures(undefined, undefined, { platform: 'win32', run: () => assert.fail() }),
    { status: 'NOT_RUN', code: 'DARWIN_REQUIRED', cleanup: [] })
})

test('APFS lifecycle creates two fresh images, verifies identity and detaches only owned volumes', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-apfs-test-'))
  const fake = tools()
  try {
    const result = await withMacApfsFixtures(path.join(parent, 'run'), async volumes => {
      assert.equal(volumes.length, 2)
      assert.deepEqual(volumes.map(v => v.caseSensitive), [false, true])
      return { status: 'PASS' }
    }, { platform: 'darwin', ...fake })
    assert.equal(result.status, 'PASS')
    assert.equal(result.cleanup.length, 2)
    assert.equal(fake.mounted.length, 0)
    assert.ok(result.volumes.every(v => fs.existsSync(v.image))) // Evidence retained, no removal.
    assert.equal(fake.calls.filter(c => c[1][0] === 'detach').length, 2)
    assert.equal(fake.calls.some(c => c[1].includes('-force')), false)
    assert.equal(fake.calls.some(c => c[1][0] === 'eraseDisk'), false)
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})

test('case failure still cleans owned resources; changed identity refuses all detaches', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-apfs-test-'))
  try {
    const failed = tools()
    const result = await withMacApfsFixtures(path.join(parent, 'failed'), async () => ({ status: 'FAIL' }), { platform: 'darwin', ...failed })
    assert.equal(result.status, 'FAIL')
    assert.equal(result.code, 'APFS_CASE_FAILED')
    assert.equal(failed.mounted.length, 0)
    const foreign = tools({ foreignOnCleanup: true })
    const changed = await withMacApfsFixtures(path.join(parent, 'foreign'), async () => { foreign.markExecuting(); return { status: 'PASS' } }, { platform: 'darwin', ...foreign })
    assert.equal(changed.status, 'FAIL')
    assert.equal(changed.cleanup.every(c => c.status === 'FAIL'), true)
    assert.equal(foreign.calls.some(c => c[1][0] === 'detach'), false)
    const uncertain = tools({ failAttach: true })
    const unknown = await withMacApfsFixtures(path.join(parent, 'unknown'), undefined, { platform: 'darwin', ...uncertain })
    assert.equal(unknown.status, 'FAIL')
    assert.equal(unknown.cleanup[0].code, 'ATTACH_OUTCOME_UNKNOWN')
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})


test('APFS callback cancellation reports failure and still detaches both owned volumes', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-apfs-test-'))
  const fake = tools(), controller = new AbortController()
  try {
    const result = await withMacApfsFixtures(path.join(parent, 'cancelled'), async (_volumes, signal) => {
      assert.equal(signal, controller.signal)
      controller.abort(new Error('APFS_CANCELLED'))
      return { status: 'PASS' }
    }, { platform: 'darwin', ...fake, signal: controller.signal })
    assert.equal(result.status, 'FAIL')
    assert.equal(result.code, 'APFS_CANCELLED')
    assert.equal(fake.mounted.length, 0)
    assert.equal(result.cleanup.length, 2)
  } finally { fs.rmSync(parent, { recursive: true, force: true }) }
})
