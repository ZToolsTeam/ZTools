import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildMacNetwork } from './build-macos-network.mjs'
import { createNetworkBundle } from './macos-network-bundle.mjs'

test('原生路由解析使用真实 SDK 结构，地址/长度/脱敏边界通过 ASan 与 UBSan', { skip: process.platform !== 'darwin' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-network-parser-'))
  try {
    const binary = path.join(root, 'parser-test')
    execFileSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fsanitize=address,undefined',
      fileURLToPath(new URL('../native/ZToolsMacNetwork/tests.cpp', import.meta.url)), '-o', binary], { timeout: 30000 })
    assert.match(execFileSync(binary, [], { encoding: 'utf8', timeout: 10000 }), /测试通过/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('真实 Universal 助手在 macOS 27 无授权时明确拒绝，不借启动上下文读取隐私', { skip: process.platform !== 'darwin' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-network-capability-'))
  try {
    const built = buildMacNetwork({ outputRoot: path.join(root, 'build'), minimumOs: '13.0' })
    const app = createNetworkBundle({ executable: built.executable, bundlePath: path.join(root, 'Network.app'), bundleId: 'org.example.network-test', minimumOs: '13.0' })
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app.bundlePath], { stdio: 'pipe', timeout: 10000 })
    const run = args => JSON.parse(execFileSync(app.executable, args, { encoding: 'utf8', timeout: 5000 }))
    assert.equal(run(['bad/interface']).code, 'INVALID_INTERFACE')
    assert.equal(run([]).code, 'INVALID_INTERFACE')
    const result = run(['lo0'])
    if (Number(os.release().split('.')[0]) >= 26) {
      assert.deepEqual(result, { version: 1, success: false, code: 'TOPOLOGY_PERMISSION_REQUIRED' })
    } else {
      assert.equal(result.success, true)
      assert.deepEqual(result.entries, [])
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
