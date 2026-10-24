import test from 'node:test'
import assert from 'node:assert/strict'
import { enableRendererAfterCommit, verifyOwnedElectronProcess, WindowsNormalAppHarness } from './lib/windows-normal-app-harness.mjs'
import { validateFreshPluginZip } from './windows-normal-app-plugin-file-chain-lib.mjs'

const executable = 'E:\\ZTools\\electron.exe'

test('owned app fallback termination requires same PID, actual creation UTC, executable and exact normal app entry switches', () => {
  const commandLine = '"E:\\ZTools\\electron.exe" . --inspect-brk=127.0.0.1:9337 --remote-debugging-port=9336 --remote-debugging-address=127.0.0.1'
  const creationUtc = '2026-10-10T03:00:00.0000000Z'
  const expected = { pid: 42, executablePath: executable, creationUtc, launchArguments: ['.', '--inspect-brk=127.0.0.1:9337',
    '--remote-debugging-port=9336', '--remote-debugging-address=127.0.0.1'] }
  assert.deepEqual(verifyOwnedElectronProcess({ pid: 42, executablePath: executable, commandLine, creationUtc }, expected), {
    status: 'PASS', pid: 42, executablePath: executable, creationUtc, appEntryConfirmed: true, requiredArgumentsConfirmed: true
  })
  for (const snapshot of [
    { pid: 43, executablePath: executable, commandLine },
    { pid: 42, executablePath: 'E:\\Other\\electron.exe', commandLine },
    { pid: 42, executablePath: executable, commandLine: '"E:\\ZTools\\electron.exe" . --inspect-brk=127.0.0.1:9337 --remote-debugging-port=9336' },
    { pid: 42, executablePath: executable, commandLine: '"E:\\ZTools\\electron.exe" --inspect-brk=127.0.0.1:9337 --remote-debugging-port=9336 --remote-debugging-address=127.0.0.1' },
    { pid: 42, executablePath: executable, commandLine: `${commandLine} --disable-gpu` }
  ]) {
    assert.equal(verifyOwnedElectronProcess({ ...snapshot, creationUtc }, expected).status, 'FAIL')
  }
  for (const invalidCreation of [undefined, null, '', 'invalid', '2026-10-10T03:01:00.0000000Z']) {
    assert.equal(verifyOwnedElectronProcess({ pid: 42, executablePath: executable, commandLine, creationUtc: invalidCreation }, expected).status, 'FAIL')
    assert.equal(verifyOwnedElectronProcess({ pid: 42, executablePath: executable, commandLine, creationUtc }, { ...expected, creationUtc: invalidCreation }).status, 'FAIL')
  }
})

test('shared harness configuration accepts distinct ports and rejects conflicts or invalid ports before starting Electron', () => {
  const options = { appRoot: 'E:\\ZTools', executable, outputRoot: 'E:\\run', versions: { electronVersion: '43.4.1' } }
  assert.doesNotThrow(() => new WindowsNormalAppHarness({ ...options, ports: { cdp: 9336, inspect: 9222 } }))
  for (const ports of [{ cdp: 9336, inspect: 9336 }, { cdp: 0, inspect: 9222 }, { cdp: 9336, inspect: 65536 }]) {
    assert.throws(() => new WindowsNormalAppHarness({ ...options, ports }), /NORMAL_APP_HARNESS_CONFIGURATION_INVALID/)
  }
})

test('fresh ZIP validation accepts todo identity patterns while rejecting a different plugin identity', () => {
  const path = 'E:\\plugins\\.build-runs\\run-1\\zips\\todo-1.2.0-windows-electron-x64.zip'
  assert.throws(() => validateFreshPluginZip(path, 'E:\\plugins', 'todo'), error => error?.code === 'ENOENT')
  assert.throws(() => validateFreshPluginZip(path, 'E:\\plugins', 'todo-other'), /ZIP_OUTSIDE_FRESH_SINGLE_PLUGIN_RUN/)
})

test('Renderer Runtime is enabled only after the expected normal document has committed', async () => {
  const calls = []
  let snapshots = 0
  const page = { async call(method) {
    calls.push(method)
    if (method === 'Page.getFrameTree') return { frameTree: { frame: snapshots++ === 0
      ? { url: 'about:blank', loaderId: '' }
      : { url: 'ztools://web/index.html#/list', loaderId: 'committed-loader' } } }
    return {}
  } }
  assert.deepEqual(await enableRendererAfterCommit(page, /^ztools:\/\/web\//),
    { url: 'ztools://web/index.html#/list', loaderId: 'committed-loader' })
  assert.deepEqual(calls, ['Page.enable', 'Page.getFrameTree', 'Page.getFrameTree', 'Runtime.enable'])
})

test('an unrelated committed page is never granted Renderer Runtime attachment', async () => {
  const calls = []
  const page = { async call(method) {
    calls.push(method)
    return { frameTree: { frame: { url: 'https://example.test/', loaderId: 'other-loader' } } }
  } }
  await assert.rejects(enableRendererAfterCommit(page, /^ztools:\/\/web\//, 1), /NORMAL_RENDERER_NAVIGATION_NOT_COMMITTED/)
  assert.equal(calls.includes('Runtime.enable'), false)
})
