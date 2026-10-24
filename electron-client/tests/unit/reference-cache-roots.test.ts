import assert from 'node:assert/strict'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import type { PathGrantRef } from '../../src/contracts/path-reference.js'
import { ReferenceCacheRoots } from '../../src/main/platform/reference-cache-roots.js'

const caller: CallerIdentity = { type: 'plugin', webContentsId: 42, pluginId: 'example', pluginInstanceId: 'one' }
function fixture() {
  const listeners = new Set<(owner: number) => void>(), identities = new Map<number, CallerIdentity>([[42, caller]])
  const created: unknown[] = [], directories: string[] = [], revoked: string[] = [], refs = new Map<string, PathGrantRef>()
  let next = 0, pinWait: Promise<void> = Promise.resolve(), releaseWait: Promise<void> = Promise.resolve(), failDirectory = false
  const ref = (): PathGrantRef => { const reference = { grantId: String(++next).padStart(43, 'a'), displayName: 'private', kind: 'directory' as const, operations: ['read', 'write', 'list'] as const }; refs.set(reference.grantId, reference); return reference }
  const roots = new ReferenceCacheRoots('E:/synthetic/data', 'win32', {
    create: async (owner, selected) => { created.push({ owner, selected }); await pinWait; return ref() },
    createDirectory: async (_owner, _id, name) => { if (failDirectory) throw new Error('native directory failure'); directories.push(name); return { status: 'created' } },
    deriveDirectory: async () => ref(),
    reference: (_owner, id) => { const reference = refs.get(id); if (!reference) throw new Error('missing'); return reference },
    revoke: async (_owner, id) => { revoked.push(id); await releaseWait }
  }, { isActive: owner => identities.has(owner), get: owner => identities.get(owner),
    onRemoved: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }, 20)
  return { roots, created, directories, revoked, identities, listeners,
    waitPin: (value: Promise<void>) => { pinWait = value }, waitRelease: (value: Promise<void>) => { releaseWait = value },
    failDirectory: () => { failDirectory = true }, remove: (owner: number) => { identities.delete(owner); for (const listener of listeners) listener(owner) } }
}
function gate() { let finish!: () => void; const promise = new Promise<void>(resolve => { finish = resolve }); return { promise, finish } }

test('cache roots come only from trusted Main data root and identity; concurrent same-owner callers share one private chain', async () => {
  const f = fixture(), g = gate(); f.waitPin(g.promise)
  const a = f.roots.rootForCaller(caller), b = f.roots.rootForCaller(caller)
  assert.equal(f.created.length, 1); g.finish()
  assert.equal((await a).grantId, (await b).grantId)
  assert.deepEqual(f.directories, ['ReferenceCache', 'plugins', 'example'])
  await assert.rejects(f.roots.rootForCaller({ ...caller, pluginId: 'other' }), { code: 'PERMISSION_DENIED' })
  await assert.rejects(f.roots.rootForCaller({ ...caller, pluginInstanceId: 'other' }), { code: 'PERMISSION_DENIED' })
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(f.roots.rootForCaller(caller, cancelled.signal), { code: 'PERMISSION_DENIED' })
  const stopped = f.roots.stop(); assert.equal(f.roots.stop(), stopped); await stopped
  assert.equal(f.revoked.length, 1); assert.equal(f.listeners.size, 0)
})

test('different plugin owners use different private namespaces and forged plugin IDs never reach native', async () => {
  const f = fixture(), other = { ...caller, webContentsId: 43, pluginId: 'second' }
  f.identities.set(43, other)
  const a = await f.roots.rootForCaller(caller), b = await f.roots.rootForCaller(other)
  assert.notEqual(a.grantId, b.grantId)
  assert.deepEqual(f.directories, ['ReferenceCache', 'plugins', 'example', 'ReferenceCache', 'plugins', 'second'])
  const malformed = { ...caller, webContentsId: 99, pluginId: '../escape' }; f.identities.set(99, malformed)
  await assert.rejects(f.roots.rootForCaller(malformed), { code: 'PERMISSION_DENIED' })
  assert.equal(f.created.length, 2); await f.roots.stop()
})

test('native directory failure revokes the private parent; removed owner never receives a late root', async () => {
  const f = fixture(); f.failDirectory()
  await assert.rejects(f.roots.rootForCaller(caller), /native directory failure/)
  assert.equal(f.revoked.length, 1); await f.roots.stop()
  const late = fixture(), g = gate(); late.waitPin(g.promise)
  const pending = late.roots.rootForCaller(caller); late.remove(42); g.finish()
  await assert.rejects(pending, { code: 'PERMISSION_DENIED' })
  // The grant service owner lifecycle owns object closure after owner removal.
  assert.equal(late.revoked.length, 0); await late.roots.stop()
})

test('cache owner admission is bounded and shutdown never claims success for an unconfirmed native release', async () => {
  const f = fixture()
  for (let owner = 1; owner <= 32; owner++) {
    const main: CallerIdentity = { type: 'main', webContentsId: owner }; f.identities.set(owner, main)
    await f.roots.rootForCaller(main)
  }
  await assert.rejects(f.roots.rootForCaller(caller), { code: 'PERMISSION_DENIED' })
  const g = gate(); f.waitRelease(g.promise)
  const stopped = f.roots.stop(); await assert.rejects(stopped, { code: 'FILE_ERROR' })
  assert.equal(f.roots.stop(), stopped); g.finish()
})
