import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { parseReferenceDialog } from '../../src/contracts/path-dialog.js'
import { PathReferenceDialogs, type ReferenceDialogProvider } from '../../src/main/services/path-reference-dialogs.js'
import type { PathGrantRef } from '../../src/contracts/path-reference.js'
import type { PathGrantService } from '../../src/main/services/path-grant-service.js'

const caller = { type: 'main', webContentsId: 42 } as const
function fixture(selections: { absolutePath: string; kind: 'file' | 'save' | 'directory' }[], canceled = false) {
  let calls = 0, failAt = 0, cleanupFails = false
  const revoked: string[] = [], requests: { owner: number; path: string; kind: string; operations: readonly string[] }[] = []
  const provider: ReferenceDialogProvider = { select: async () => { calls++; return { canceled, selections } } }
  const grants: Pick<PathGrantService, 'create' | 'revoke' | 'resourceUrl'> = {
    create: async (owner, selectedPath, kind, operations) => {
      requests.push({ owner, path: selectedPath, kind, operations })
      if (requests.length === failAt) throw new Error('synthetic acquire failed')
      return { grantId: String(requests.length).padEnd(43, 'x'), displayName: path.basename(selectedPath), kind, operations,
        absolutePath: selectedPath } as PathGrantRef
    },
    revoke: async (_, id) => { revoked.push(id); if (cleanupFails) throw new Error('synthetic cleanup failed') },
    resourceUrl: (_, id) => `ztools://file/${id}/name`
  }
  return { dialogs: new PathReferenceDialogs(provider, grants), calls: () => calls, requests, revoked,
    fail: (number: number) => { failAt = number }, failCleanup: () => { cleanupFails = true } }
}
const filePath = path.resolve('out-test', 'synthetic-dialog', 'input.txt')
const directoryPath = path.resolve('out-test', 'synthetic-dialog', 'folder')

test('cancelled request never starts a picker or grants late native selections', async () => {
  const early = fixture([{ absolutePath: filePath, kind: 'file' }]), aborted = new AbortController()
  aborted.abort(); assert.deepEqual(await early.dialogs.show('open', {}, caller, aborted.signal), { canceled: true, references: [] })
  assert.equal(early.calls(), 0)
  const late = new AbortController(); let grants = 0
  const dialogs = new PathReferenceDialogs({ select: async () => { late.abort(); return { canceled: false, selections: [{ absolutePath: filePath, kind: 'file' }] } } },
    { create: async () => { grants++; throw new Error('UNEXPECTED_GRANT') }, revoke: async () => {}, resourceUrl: () => 'unused' })
  assert.deepEqual(await dialogs.show('open', {}, caller, late.signal), { canceled: true, references: [] }); assert.equal(grants, 0)
})

test('cancellation during pin rolls back late granted references before rejecting', async () => {
  const cancelled = new AbortController(), revoked: string[] = [], id = 'a'.repeat(43)
  const dialogs = new PathReferenceDialogs({ select: async () => ({ canceled: false, selections: [{ absolutePath: filePath, kind: 'file' }] }) }, {
    create: async (_, __, kind, operations, signal) => {
      assert.equal(signal, cancelled.signal); cancelled.abort()
      return { grantId: id, displayName: 'late.txt', kind, operations }
    }, revoke: async (_, grantId) => { revoked.push(grantId) }, resourceUrl: () => 'unused'
  })
  await assert.rejects(dialogs.show('open', {}, caller, cancelled.signal), { code: 'FILE_ERROR' }); assert.deepEqual(revoked, [id])
})

test('dialog refs pin trusted native selections and project metadata without raw paths', async () => {
  const f = fixture([{ absolutePath: filePath, kind: 'file' }])
  const result = await f.dialogs.show('open', {}, caller)
  assert.equal(result.canceled, false); assert.equal(result.references[0]!.kind, 'file')
  assert.deepEqual(result.references[0]!.operations, ['read']); assert.ok(result.references[0]!.fileUrl?.startsWith('ztools://file/'))
  assert.ok(!JSON.stringify(result).includes('absolutePath')); assert.ok(!JSON.stringify(result).includes('synthetic-dialog'))
  assert.equal(f.requests[0]!.owner, 42)
})
test('save refs are write-only; folder mutation rights must be explicitly requested', async () => {
  const save = fixture([{ absolutePath: filePath, kind: 'save' }])
  assert.deepEqual((await save.dialogs.show('save', { defaultName: 'output.txt' }, caller)).references[0]!.operations, ['write'])
  assert.equal((await save.dialogs.show('save', {}, caller)).references[0]!.fileUrl, undefined)
  const folder = fixture([{ absolutePath: directoryPath, kind: 'directory' }])
  assert.deepEqual((await folder.dialogs.show('folder', {}, caller)).references[0]!.operations, ['read', 'list'])
  assert.deepEqual((await folder.dialogs.show('folder', { access: 'read-write' }, caller)).references[0]!.operations, ['read', 'write', 'list'])
})
test('cancelled native chooser grants nothing even if its response includes stale paths', async () => {
  const f = fixture([{ absolutePath: filePath, kind: 'file' }], true)
  assert.deepEqual(await f.dialogs.show('open', {}, caller), { canceled: true, references: [] })
  assert.equal(f.requests.length, 0)
})
test('raw default paths, forged selections/owners and invalid caller are rejected before native UI', async () => {
  const f = fixture([{ absolutePath: filePath, kind: 'file' }])
  for (const params of [{ defaultPath: filePath }, { selections: [filePath] }, { owner: 99 }, { access: 'read-write' }, { properties: ['unsupported'] }]) {
    await assert.rejects(f.dialogs.show('open', params, caller), { code: 'INVALID_REQUEST' })
  }
  await assert.rejects(f.dialogs.show('open', {}, { type: 'main', webContentsId: 0 }))
  assert.equal(f.calls(), 0)
})
test('partial multi-selection pin failure revokes acquired refs and cleanup failure remains visible', async () => {
  const selections = [{ absolutePath: filePath, kind: 'file' as const }, { absolutePath: filePath + '.second', kind: 'file' as const }]
  const f = fixture(selections); f.fail(2)
  await assert.rejects(f.dialogs.show('open', { properties: ['multiSelections'] }, caller), /acquire failed/)
  assert.equal(f.revoked.length, 1)
  const failed = fixture(selections); failed.fail(2); failed.failCleanup()
  await assert.rejects(failed.dialogs.show('open', { properties: ['multiSelections'] }, caller), { code: 'FILE_ERROR', message: '部分文件选择授权释放未确认' })
})
test('chooser kind and count must agree with requested mode before authority is issued', async () => {
  const folder = fixture([{ absolutePath: directoryPath, kind: 'directory' }])
  await assert.rejects(folder.dialogs.show('open', {}, caller))
  assert.equal(folder.requests.length, 0)
  assert.equal((await folder.dialogs.show('open', { properties: ['openDirectory'] }, caller)).references[0]!.kind, 'directory')
  const file = fixture([{ absolutePath: filePath, kind: 'file' }])
  await assert.rejects(file.dialogs.show('folder', {}, caller)); await assert.rejects(file.dialogs.show('save', {}, caller))
  const multi = fixture(Array(65).fill({ absolutePath: filePath, kind: 'file' }))
  await assert.rejects(multi.dialogs.show('open', { properties: ['multiSelections'] }, caller)); assert.equal(multi.requests.length, 0)
  const unexpected = fixture([{ absolutePath: filePath, kind: 'file' }, { absolutePath: filePath + '.second', kind: 'file' }])
  await assert.rejects(unexpected.dialogs.show('open', {}, caller)); assert.equal(unexpected.requests.length, 0)
})
test('dialog filename hints preserve Mac literal names and refuse traversal or reserved staging names', () => {
  assert.equal(parseReferenceDialog({ defaultName: '冒号:反斜线\\换行\n.txt' }, 'save', 'darwin').defaultName, '冒号:反斜线\\换行\n.txt')
  for (const defaultName of ['../file', '/private/file', '.', '..', '.ztools-save-private', '.ZTOOLS-SAVE-private', 'bad\0name']) {
    assert.throws(() => parseReferenceDialog({ defaultName }, 'save', 'darwin'))
  }
  assert.throws(() => parseReferenceDialog({ defaultName: 'drive:name' }, 'save', 'win32'))
  assert.throws(() => parseReferenceDialog({ defaultName: 'folder\\file' }, 'save', 'win32'))
})
