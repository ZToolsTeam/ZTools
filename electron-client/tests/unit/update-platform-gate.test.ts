import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { runtimePathsForBusinessDataRoot } from '../../src/main/runtime/runtime-paths.js'
import { UpdateService } from '../../src/main/services/update-service.js'

test('Mac 允许离线检查，非 Windows 仍拒绝自动下载安装且不产生副作用', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const isolatedRoot = path.join(os.tmpdir(), `ztools-update-platform-${randomUUID()}`)
    let fetches = 0
    let handoffs = 0
    const updates = new UpdateService({
      platform,
      runtimePaths: runtimePathsForBusinessDataRoot(path.join(isolatedRoot, 'Data')),
      appVersion: '1.1.7.1',
      webVersion: '1.1.7.1',
      fetchImpl: (async () => { fetches += 1; throw new Error('network must not run') }) as typeof fetch,
      runUpdaterImpl: async () => { handoffs += 1; return 0 }
    })
    const request = {
      type: 'app' as const,
      version: '2.0.0',
      downloadUrl: 'https://example.com/fixture.exe',
      checksum: 'a'.repeat(64),
      fileSize: 1
    }
    const unsupported = (error: unknown) => error instanceof ZToolsError && error.code === errorCodes.notSupported
    assert.equal(fs.existsSync(isolatedRoot), false)
    if (platform === 'linux') await assert.rejects(updates.check({ source: 'manual' }), unsupported)
    else assert.deepEqual(await updates.check({ source: 'manual' }), { success: true, source: 'manual', app: null, web: null })
    await assert.rejects(updates.download(request), unsupported)
    await assert.rejects(updates.install(request), unsupported)
    assert.equal(fetches, 0)
    assert.equal(handoffs, 0)
    assert.equal(fs.existsSync(isolatedRoot), false)
    await updates.stop()
  }
})
