import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

test('reserved FFmpeg SDK rejects promptly before any task or subscription can start', async () => {
  const source = fs.readFileSync('../frontend/public/js/cef-ipc/src/api/process.js', 'utf8').replace(/^export .+$/mg, '')
  const Api = vm.runInNewContext(source + '\nProcessAPI', { window: {}, console }) as new (transport: unknown) => {
    runFFmpeg(args: string[], onProgress?: () => void): Promise<void>
  }
  let transportCalls = 0, progressCalls = 0
  const api = new Api({ call: async () => { transportCalls++; return 'unknown-live-task' } })
  const result = api.runFFmpeg(['-i', 'synthetic.wav'], () => { progressCalls++ })
  assert.equal(typeof result.then, 'function')
  await assert.rejects(result, { code: 'NOT_SUPPORTED' })
  assert.equal(transportCalls, 0)
  assert.equal(progressCalls, 0)
})

test('repeated unsupported FFmpeg calls settle independently and do not invent kill/quit handles', async () => {
  const source = fs.readFileSync('../frontend/public/js/cef-ipc/src/api/process.js', 'utf8').replace(/^export .+$/mg, '')
  const Api = vm.runInNewContext(source + '\nProcessAPI', { window: {}, console }) as new (transport: unknown) => {
    runFFmpeg(args: string[]): Promise<void> & { kill?: unknown; quit?: unknown }
  }
  const api = new Api({ call: () => { throw new Error('must not start an unmanageable task') } })
  const calls = [api.runFFmpeg([]), api.runFFmpeg(['-version'])]
  for (const result of calls) {
    assert.equal(result.kill, undefined)
    assert.equal(result.quit, undefined)
    await assert.rejects(result, { code: 'NOT_SUPPORTED' })
  }
})
