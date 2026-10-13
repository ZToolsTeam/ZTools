import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { ReferenceClipboardFilesService } from '../../src/main/services/reference-clipboard-files-service.js'
import type { PathGrantService } from '../../src/main/services/path-grant-service.js'
import { EventService } from '../../src/main/services/event-service.js'

const caller = { type: 'main', webContentsId: 42 } as const, signal = () => new AbortController().signal
const selection = path.resolve('out-test', 'synthetic-native-clipboard', 'file.txt')

test('reference clipboard publishing selects only the eligible lane owner', async () => {
  const f = fixture(), sent: number[] = []
  const second = { type: 'plugin', webContentsId: 43, pluginId: 'p', pluginInstanceId: 'one' } as const
  const events = new EventService({ send: id => { sent.push(id); return true }, onRemoved: () => () => {} })
  try {
    events.subscribe({ key: 'clipboard_change' }, caller); events.subscribe({ key: 'clipboard_change' }, second)
    const result = await Reflect.apply(f.service.publishChange, f.service, [events, signal(), () => true,
      (owner: { webContentsId: number }) => owner.webContentsId === 43])
    assert.deepEqual(result, { delivered: 1 }); assert.deepEqual(sent, [43])
  } finally { events.stop() }
})

test('lane invalidation during native acquisition revokes the undelivered reference', async () => {
  const f = fixture(), sent: number[] = []; let eligible = true
  const original = f.grants.createSelected
  f.grants.createSelected = async (...args) => { const acquired = await original(...args); eligible = false; return acquired }
  const events = new EventService({ send: id => { sent.push(id); return true }, onRemoved: () => () => {} })
  try {
    events.subscribe({ key: 'clipboard_change' }, caller)
    assert.deepEqual(await Reflect.apply(f.service.publishChange, f.service, [events, signal(), () => true, () => eligible]), { delivered: 0 })
    assert.deepEqual(sent, []); assert.equal(f.revoked.length, 1)
  } finally { events.stop() }
})
function fixture() {
  const revoked: string[] = []; let calls = 0, count = 0, selected = [selection], kind: 'file' | 'directory' | 'save' = 'file'
  const grants: Pick<PathGrantService, 'createSelected' | 'revoke' | 'resourceUrl'> = {
    createSelected: async () => ({ grantId: String(++count).padStart(43, 'a'), displayName: 'name.txt', kind, operations: ['read'], ...{ selectedPath: selection, handle: 'private' } }),
    revoke: async (_, id) => { revoked.push(id) }, resourceUrl: (_, id) => `ztools://file/${id}/name.txt`
  }
  const clipboard = { readFiles: async () => { calls++; return selected } }
  return { service: new ReferenceClipboardFilesService(clipboard, grants), grants, clipboard, revoked, calls: () => calls,
    selected: (value: string[]) => { selected = value }, kind: (value: typeof kind) => { kind = value } }
}

test('clipboard returns only native-pinned read-only file/directory refs and deduplicates exact selections', async () => {
  const f = fixture(); f.selected([selection, selection])
  const files = (await f.service.read(caller, signal())).files
  assert.equal(files.length, 1); assert.deepEqual(files[0]!.operations, ['read']); assert.ok(files[0]!.fileUrl?.startsWith('ztools://file/'))
  assert.ok(!JSON.stringify(files).includes('synthetic-native-clipboard')); assert.ok(!JSON.stringify(files).includes('"handle"'))
  f.kind('directory'); const directory = (await f.service.read(caller, signal())).files[0]!
  assert.deepEqual(directory.operations, ['read', 'list']); assert.equal(directory.fileUrl, undefined)
})

test('malformed OS selection arrays and oversized snapshots reject before native acquisition', async () => {
  const f = fixture(); let pins = 0
  f.grants.createSelected = async () => { pins++; throw new Error('unexpected') }
  for (const selected of [['relative'], [selection + '\0'], Array(257).fill(selection), [selection + '字'.repeat(1400)]]) {
    f.selected(selected); await assert.rejects(f.service.read(caller, signal()), { code: 'CLIPBOARD_ERROR' })
  }
  assert.equal(pins, 0)
})

test('invalid native kind is revoked and partial errors never expose paths or native diagnostics', async () => {
  const f = fixture(); f.kind('save')
  const rejected = await f.service.read(caller, signal()); assert.equal(rejected.files.length, 0); assert.equal(rejected.errors.length, 1); assert.equal(f.revoked.length, 1)
  f.grants.createSelected = async () => { throw new Error('/private/raw/native/diagnostic') }
  assert.ok(!JSON.stringify(await f.service.read(caller, signal())).includes('/private'))
})

test('cancellation during acquisition releases all undelivered refs and never reports clipboard success', async () => {
  const f = fixture(), cancelled = new AbortController(), original = f.grants.createSelected
  f.grants.createSelected = async (...args) => { const grant = await original(...args); cancelled.abort(); return grant }
  await assert.rejects(f.service.read(caller, cancelled.signal), { code: 'CLIPBOARD_ERROR' }); assert.equal(f.revoked.length, 1)
  const early = fixture(); await assert.rejects(early.service.read(caller, cancelled.signal)); assert.equal(early.calls(), 0)
})

test('clipboard read concurrency is bounded and reservations recover after pending OS reads settle', async () => {
  const f = fixture(); let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.clipboard.readFiles = async () => { await gate; return [] }
  const accepted = Array.from({ length: 8 }, () => f.service.read(caller, signal()))
  await assert.rejects(f.service.read(caller, signal()), { code: 'CLIPBOARD_ERROR' })
  release(); await Promise.all(accepted); assert.equal((await f.service.read(caller, signal())).files.length, 0)
})

test('file change captures once and delivers distinct refs only to their owning subscribed instance', async () => {
  const f = fixture(), sent: { id: number; value: any }[] = []
  const events = new EventService({ send: (id, _, value) => { sent.push({ id, value }); return true }, onRemoved: () => () => {} })
  const second = { type: 'plugin', webContentsId: 43, pluginId: 'p', pluginInstanceId: 'one' } as const
  try {
    events.subscribe({ key: '*' }, caller); events.subscribe({ key: 'clipboard_change' }, second)
    assert.deepEqual(await f.service.publishChange(events, signal(), () => true), { delivered: 2 })
    assert.equal(f.calls(), 1); assert.deepEqual(sent.map(item => item.id), [42, 43])
    const firstId = sent[0]!.value.msgData.envelope.payload.files[0].grantId
    const secondId = sent[1]!.value.msgData.envelope.payload.files[0].grantId
    assert.notEqual(firstId, secondId); assert.equal(f.revoked.length, 0)
    assert.ok(!JSON.stringify(sent).includes('synthetic-native-clipboard'))
  } finally { events.stop() }
})

test('stale snapshot and failed event delivery revoke every undelivered owner reference', async () => {
  const f = fixture()
  const events = { subscribers: () => [caller], publishHostToOwner: () => ({ success: true as const, delivered: 0 }) }
  assert.deepEqual(await f.service.publishChange(events, signal(), () => true), { delivered: 0 })
  assert.equal(f.revoked.length, 1)
  let checks = 0
  await assert.rejects(f.service.publishChange(events, signal(), () => ++checks === 1), { code: 'CLIPBOARD_ERROR' })
  assert.equal(f.revoked.length, 2)
  events.publishHostToOwner = () => { throw new Error('/private/native') }
  await assert.rejects(f.service.publishChange(events, signal(), () => true), { code: 'CLIPBOARD_ERROR' })
  assert.equal(f.revoked.length, 3)
})

test('snapshot publication rejects excessive recipient work before pinning any object', async () => {
  const f = fixture(); f.selected(Array(256).fill(selection))
  let pins = 0; f.grants.createSelected = async () => { pins++; throw new Error('unexpected') }
  await assert.rejects(f.service.publishChange({ subscribers: () => Array(5).fill(caller),
    publishHostToOwner: () => ({ success: true, delivered: 0 }) }, signal(), () => true), { code: 'CLIPBOARD_ERROR' })
  assert.equal(pins, 0)
})
