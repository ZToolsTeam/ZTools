import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PluginDataRecoveryService } from '../../src/main/services/plugin-data-recovery-service.js'

test('lists preserved plugin trees and restores only explicitly selected assets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-plugin-data-recovery-'))
  const snapshot = path.join(root, 'PluginData', 'plugin.test', 'legacy', 'snapshot-1')
  try {
    await fs.mkdir(path.join(snapshot, 'nested'), { recursive: true })
    await fs.writeFile(path.join(snapshot, 'plugin.json'), '{"id":"plugin.test"}')
    await fs.writeFile(path.join(snapshot, 'user-data.json'), '{"keep":true}')
    await fs.writeFile(path.join(snapshot, 'nested', 'attachment.bin'), Buffer.from([1, 2, 3]))

    const service = new PluginDataRecoveryService(root)
    const listed = await service.list('plugin.test')
    assert.deepEqual(listed.data.map(({ preservationId, state }) => ({ preservationId, state })), [
      { preservationId: 'snapshot-1', state: 'available' }
    ])
    assert.equal(listed.data[0]?.files, 3)

    const result = await service.restore('plugin.test', 'snapshot-1', ['user-data.json', 'nested'])
    const restoredRoot = path.join(root, result.relativeRoot)
    assert.equal(await fs.readFile(path.join(restoredRoot, 'user-data.json'), 'utf8'), '{"keep":true}')
    assert.deepEqual(await fs.readFile(path.join(restoredRoot, 'nested', 'attachment.bin')), Buffer.from([1, 2, 3]))
    await assert.rejects(fs.access(path.join(restoredRoot, 'plugin.json')))

    const repeated = await service.restore('plugin.test', 'snapshot-1', ['user-data.json', 'nested'])
    assert.deepEqual(repeated, result)
    await assert.rejects(
      service.restore('plugin.test', 'snapshot-1', ['../plugin.json']),
      (error: unknown) => error instanceof Error && error.message.includes('越界')
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
