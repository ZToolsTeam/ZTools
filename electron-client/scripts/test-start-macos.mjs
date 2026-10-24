import assert from 'node:assert/strict'
import test from 'node:test'
import { startMacos } from './start-macos.mjs'

function harness(extra = {}) {
  const calls = []
  return { calls, options: {
    platform: 'darwin', npmCli: '/npm/cli.js', exists: () => true,
    resolveElectron: () => '/Applications/Electron.app/Contents/MacOS/Electron',
    run: (...args) => { calls.push(args); return { status: 0 } },
    stdout() {}, stderr() {}, ...extra
  } }
}

test('Mac 启动只构建公共源码，argv与退出码原样传递', () => {
  const h = harness()
  assert.equal(startMacos(['--remote-debugging-port=9222'], h.options), 0)
  assert.deepEqual(h.calls[0][1], ['/npm/cli.js', 'run', 'build'])
  assert.deepEqual(h.calls[1][1], ['.', '--remote-debugging-port=9222'])
  assert.equal(h.calls[0][2].shell, false)
  assert.equal(h.calls[0][2].timeout, 600_000)
  assert.equal(h.calls[1][2].shell, false)
  const exited = harness({ run: () => ({ status: 7 }) })
  assert.equal(startMacos([], exited.options), 1)
})

test('非Darwin早期拒绝，help在Windows可用', () => {
  const h = harness({ platform: 'win32' })
  assert.equal(startMacos([], h.options), 1)
  assert.equal(startMacos(['--help'], h.options), 0)
  assert.equal(h.calls.length, 0)
})

test('拒绝额外开关、缺失工具、非法端口，构建失败不启动', () => {
  for (const args of [['--no-sandbox'], ['--remote-debugging-port=0'], ['--remote-debugging-port=65536'], ['--help', '--foo']]) {
    const h = harness()
    assert.equal(startMacos(args, h.options), 1)
    assert.equal(h.calls.length, 0)
  }
  const missing = harness({ exists: () => false })
  assert.equal(startMacos([], missing.options), 1)
  assert.equal(missing.calls.length, 0)
  const failure = harness({ run: () => ({ status: null, error: new Error('spawn failed') }) })
  assert.equal(startMacos([], failure.options), 1)
})
