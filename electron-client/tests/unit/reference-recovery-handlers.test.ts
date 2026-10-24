import assert from 'node:assert/strict'
import test from 'node:test'
import { createReferenceRecoveryHandlers } from '../../src/main/ipc/reference-recovery-handlers.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import type { PathWriteRecoveryService } from '../../src/main/services/path-write-recovery-service.js'

const main = { type: 'main' as const, webContentsId: 42 }
const plugin = { type: 'plugin' as const, webContentsId: 43, pluginId: 'example', pluginInstanceId: 'one' }
test('recovery handlers reject plugins and renderer paths before invoking the trusted service', async () => {
  let calls = 0
  const service = { list: async () => { calls++; return [] }, inspect: async () => { calls++; return {} } } as unknown as PathWriteRecoveryService
  const handlers = createReferenceRecoveryHandlers(service), signal = new AbortController().signal
  for (const method of ['filesystem_list_write_recovery', 'filesystem_inspect_write_recovery'] as const) {
    await assert.rejects(handlers[method]!.execute({}, plugin, signal), { code: 'PERMISSION_DENIED' })
    await assert.rejects(handlers[method]!.execute({ selectedPath: '/private' }, main, signal), { code: 'INVALID_REQUEST' })
  }
  assert.equal(calls, 0)
})
test('recovery handlers forward the authenticated main identity and actual cancellation signal', async () => {
  const signal = new AbortController().signal, id = '12345678-1234-4123-8123-123456789abc'
  const handlers = createReferenceRecoveryHandlers({
    list: async (caller: CallerIdentity, received?: AbortSignal) => { assert.equal(caller, main); assert.equal(received, signal); return [] },
    inspect: async (recoveryId: unknown, caller: CallerIdentity, received?: AbortSignal) => { assert.equal(recoveryId, id); assert.equal(caller, main); assert.equal(received, signal); return { recoveryId: id } }
  } as unknown as PathWriteRecoveryService)
  assert.deepEqual(await handlers.filesystem_list_write_recovery!.execute({}, main, signal), { success: true, entries: [] })
  assert.deepEqual(await handlers.filesystem_inspect_write_recovery!.execute({ recoveryId: id }, main, signal), { success: true, entry: { recoveryId: id } })
})
