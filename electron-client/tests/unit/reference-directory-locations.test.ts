import assert from 'node:assert/strict'
import test from 'node:test'
import type { PathGrantService } from '../../src/main/services/path-grant-service.js'
import { ReferenceDirectoryLocations } from '../../src/main/services/reference-directory-locations.js'
import { ZToolsError, errorCodes } from '../../src/contracts/errors.js'

const caller = { type: 'main', webContentsId: 42 } as const, id = 'a'.repeat(43)
function fixture() {
  let active = true, live = true, kind: 'file' | 'directory' = 'directory'
  const listeners = new Set<(owner: number) => void>()
  const grants: Pick<PathGrantService, 'reference' | 'describe'> = {
    reference: owner => {
      if (!live || owner !== 42) throw new ZToolsError(errorCodes.permissionDenied, 'denied')
      return { grantId: id, displayName: 'folder', kind, operations: ['read', 'list'] }
    }, describe: async () => ({ isDirectory: true, size: 0, lastModifiedMs: 0 })
  }
  const service = new ReferenceDirectoryLocations(grants, { isActive: () => active,
    onRemoved: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } })
  return { service, grants, listeners, live: (value: boolean) => { live = value }, kind: (value: typeof kind) => { kind = value },
    remove: () => { active = false; for (const listener of listeners) listener(42) } }
}

test('cwd is an owner reference without path fallback and refuses non-directories and revoked references', async () => {
  const f = fixture()
  assert.equal(f.service.getCurrentDirectory(caller).reference, null)
  await f.service.setCurrentDirectory(id, caller)
  assert.equal(f.service.getCurrentDirectory(caller).reference!.grantId, id)
  await assert.rejects(f.service.setCurrentDirectory('C:/raw/path', caller), { code: 'INVALID_REQUEST' })
  await assert.rejects(f.service.setCurrentDirectory(id, { ...caller, webContentsId: 99 }), { code: 'PERMISSION_DENIED' })
  f.kind('file'); await assert.rejects(f.service.setCurrentDirectory(id, caller), { code: 'PERMISSION_DENIED' })
  f.live(false); assert.throws(() => f.service.getCurrentDirectory(caller), { code: 'PERMISSION_DENIED' })
  assert.equal(f.service.getCurrentDirectory(caller).reference, null)
  f.service.stop(); assert.equal(f.listeners.size, 0)
})

test('owner removal and cancellation invalidate pending set; overlapping sets cannot overwrite newer state', async () => {
  for (const mode of ['remove', 'cancel', 'stop'] as const) {
    const f = fixture(), controller = new AbortController()
    let finish!: () => void
    f.grants.describe = async () => { await new Promise<void>(resolve => { finish = resolve }); return { isDirectory: true, size: 0, lastModifiedMs: 0 } }
    const pending = f.service.setCurrentDirectory(id, caller, controller.signal)
    await assert.rejects(f.service.setCurrentDirectory(id, caller), { code: 'PERMISSION_DENIED' })
    if (mode === 'remove') f.remove()
    else if (mode === 'cancel') controller.abort()
    else f.service.stop()
    finish(); await assert.rejects(pending, { code: 'PERMISSION_DENIED' })
    if (mode === 'cancel') assert.equal(f.service.getCurrentDirectory(caller).reference, null)
    else assert.throws(() => f.service.getCurrentDirectory(caller), { code: 'PERMISSION_DENIED' })
    f.service.stop()
  }
})

test('directory state requires read/list authority and respects pre-cancelled requests', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort()
  let calls = 0; f.grants.describe = async () => { calls++; return { isDirectory: true, size: 0, lastModifiedMs: 0 } }
  await assert.rejects(f.service.setCurrentDirectory(id, caller, controller.signal)); assert.equal(calls, 0)
  f.grants.reference = () => ({ grantId: id, displayName: 'folder', kind: 'directory', operations: ['write'] })
  await assert.rejects(f.service.setCurrentDirectory(id, caller)); assert.equal(calls, 0)
  f.service.stop()
})
