import assert from 'node:assert/strict'
import test from 'node:test'
import { createReferenceProducerHandlers } from '../../src/main/ipc/reference-producer-handlers.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'

const caller: CallerIdentity = { type: 'main', webContentsId: 42 }
const reference = { grantId: 'a'.repeat(43), displayName: 'synthetic.png', kind: 'file' as const, operations: ['read'] as const }
function fixture() {
  const calls: string[] = [], revoked: unknown[] = []
  const handlers = createReferenceProducerHandlers({
    dialogs: { show: async mode => { calls.push(mode); return { canceled: false, references: [reference] } } },
    clipboardFiles: { read: async () => { calls.push('files'); return { success: true, files: [reference], errors: [] } } },
    clipboard: { copyTextReference: async () => { calls.push('text'); return { success: true } },
      readImageReference: async () => { calls.push('image'); return { success: true, useReference: false, image: '' } } },
    screen: { captureReference: async () => { calls.push('screen'); return { success: true, reference, fileUrl: '', size: 1, width: 1, height: 1 } } },
    grants: { revoke: async (owner, id) => { revoked.push({ owner, id }) } }
  })
  return { handlers, calls, revoked }
}

test('reference producers compose existing services and release only undelivered owner references', async () => {
  const f = fixture(), signal = new AbortController().signal
  for (const method of ['window_show_open_dialog', 'window_show_save_dialog', 'window_show_select_folder_dialog', 'clipboard_read_files', 'screen_capture'] as const) {
    const handler = f.handlers[method]!, result = await handler.execute({}, caller, signal)
    await handler.disposeUndelivered!(result, caller)
  }
  assert.deepEqual(f.calls, ['open', 'save', 'folder', 'files', 'screen'])
  assert.deepEqual(f.revoked, Array.from({ length: 5 }, () => ({ owner: 42, id: reference.grantId })))
  const image = await f.handlers.clipboard_read_image!.execute({}, caller, signal)
  await f.handlers.clipboard_read_image!.disposeUndelivered!(image, caller)
  assert.equal(f.revoked.length, 5)
  assert.equal(f.handlers.clipboard_copy_files, undefined)
})

test('reference producer read requests reject raw input and malformed capture before invoking providers', async () => {
  const f = fixture(), signal = new AbortController().signal
  for (const method of ['clipboard_read_files', 'clipboard_read_image'] as const) {
    await assert.rejects(f.handlers[method]!.execute({ path: '/raw' }, caller, signal), { code: 'INVALID_REQUEST' })
  }
  await assert.rejects(f.handlers.screen_capture!.execute({ rect: { x: 0, y: 0, width: -1, height: 1 } }, caller, signal), { code: 'INVALID_REQUEST' })
  assert.equal(f.calls.length, 0)
  await assert.rejects(f.handlers.clipboard_read_files!.disposeUndelivered!({ files: [{ path: '/raw' }] }, caller), { code: 'INVALID_REQUEST' })
  assert.equal(f.revoked.length, 0)
})
