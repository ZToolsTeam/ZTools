import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanupOwnedMacApp, validateOwnedMacBrowserProcess } from './macos-owned-cleanup.mjs'

test('CDP browser process must match the retained child before evaluation or normal quit', () => {
  validateOwnedMacBrowserProcess({ processInfo: [{ type: 'browser', id: 42 }, { type: 'renderer', id: 99 }] }, 42)
  for (const info of [null, [], [{ type: 'browser', id: 99 }], [{ type: 'renderer', id: 42 }],
    [{ type: 'browser', id: 42 }, { type: 'browser', id: 42 }]]) {
    assert.throws(() => validateOwnedMacBrowserProcess({ processInfo: info }, 42), /PROCESS_MISMATCH/)
  }
})

test('normal CDP quit and already exited child do not send signals', async () => {
  let exited = false, closes = 0
  const options = { child: { kill: () => assert.fail('unexpected signal') }, hasExited: () => exited,
    closeBrowser: async () => { closes++; exited = true }, waitMs: 0 }
  assert.equal((await cleanupOwnedMacApp(options)).cleanup, 'OWNED_PROCESS_EXITED')
  assert.equal((await cleanupOwnedMacApp(options)).cleanup, 'OWNED_PROCESS_EXITED')
  assert.equal(closes, 1)
})

test('failed CDP close signals only the owned child and cannot prove clean exit', async () => {
  let exited = false
  const signals = []
  const result = await cleanupOwnedMacApp({ child: { kill: signal => { signals.push(signal); if (signal === 'SIGKILL') exited = true } },
    hasExited: () => exited, closeBrowser: async () => { throw new Error('closed') }, waitMs: 0 })
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(result.cleanup, 'SIGNALLED_LEADER_EXITED_DESCENDANTS_UNVERIFIED')
  assert.equal(result.signalled, true)
})

test('kill error or refused exit stays incomplete; timeout and polling are bounded', async () => {
  let clock = 0, polls = 0, kills = 0
  const result = await cleanupOwnedMacApp({ child: { kill: () => { kills++; throw new Error('not exited') } },
    hasExited: () => false, closeBrowser: async () => {}, waitMs: 100, now: () => clock,
    pause: async ms => { polls++; clock += ms } })
  assert.equal(result.cleanup, 'OWNED_PROCESS_EXIT_TIMEOUT'); assert.equal(kills, 2); assert.equal(polls, 6)
  await assert.rejects(cleanupOwnedMacApp({ waitMs: -1 }), /INVALID_CLEANUP_TIMEOUT/)
})
