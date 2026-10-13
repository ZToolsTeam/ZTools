import test from 'node:test'
import assert from 'node:assert/strict'
import { macAppLaunchCommand, runMacLifecycleBaseline } from './macos-lifecycle-baseline.mjs'

test('launch selects the requested real slice with separate argv and loopback CDP', () => {
  for (const [arch, flag] of [['arm64', '-arm64'], ['x64', '-x86_64']]) {
    assert.deepEqual(macAppLaunchCommand('/Applications/Space Name.app/Contents/MacOS/ZTools', arch, 12345), {
      executable: '/usr/bin/arch', args: [flag, '/Applications/Space Name.app/Contents/MacOS/ZTools', '--remote-debugging-port=12345', '--remote-debugging-address=127.0.0.1']
    })
  }
  for (const [exe, arch, port] of [['relative', 'arm64', 123], ['/app', 'universal', 123], ['/app', 'x64', 0], ['/app\0', 'x64', 123]]) assert.throws(() => macAppLaunchCommand(exe, arch, port))
})
function cycle(pid = 123) {
  return { preflight: { status: 'PASS' }, ownedPid: pid, cleanup: 'OWNED_PROCESS_EXITED',
    cases: [{ caseId: 'M01', status: 'PASS', identity: { appVersion: '1.1.7.1', process: { arch: 'arm64' }, target: { platform: 'macos', arch: 'universal', runtime: 'electron' } } }] }
}
test('restart starts only after owned cleanup and remains pending for lifecycle OS scenarios', async () => {
  const calls = []
  const result = await runMacLifecycleBaseline({ case: 'M02', plugin: 'todo' }, async options => { calls.push(options); return cycle(100 + calls.length) })
  assert.equal(result.cases[0].status, 'MANUAL_PENDING'); assert.equal(result.cycles.length, 2)
  assert.deepEqual(calls.map(c => c.case), ['M01', 'M01']); assert.ok(calls.every(c => c.plugin === undefined))
})
test('cleanup failure or NOT_RUN prevents restart; changed identity fails', async () => {
  for (const change of [c => { c.cleanup = 'OWNED_PROCESS_EXIT_TIMEOUT' }, c => { c.cleanup = 'SIGNALLED_LEADER_EXITED_DESCENDANTS_UNVERIFIED' }, c => { c.preflight.status = 'NOT_RUN' }, c => { c.cases[0].status = 'FAIL' }]) {
    let count = 0
    const result = await runMacLifecycleBaseline({}, async () => { count++; const c = cycle(); change(c); return c })
    assert.equal(count, 1); assert.notEqual(result.cases[0].status, 'PASS')
  }
  let count = 0
  const result = await runMacLifecycleBaseline({}, async () => { const c = cycle(++count); if (count === 2) c.cases[0].identity.process.arch = 'x64'; return c })
  assert.equal(result.cases[0].code, 'RESTART_RUNTIME_IDENTITY_CHANGED')
})
