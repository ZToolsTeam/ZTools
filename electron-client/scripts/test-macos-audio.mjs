import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildMacAudio } from './build-macos-audio.mjs'

const source = fileURLToPath(new URL('../native/ZToolsMacAudio/control_test.mm', import.meta.url))
test('Mac 音频组件拒绝在其他平台构建', () => {
  assert.throws(() => buildMacAudio({ platform: 'win32' }), /DARWIN_REQUIRED/)
})
test('[macOS] 原生逐声道失败与回滚测试，不接触真实设备', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-control-test-'))
  try {
    const binary = path.join(dir, 'control-test')
    execFileSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-framework', 'Foundation', '-framework', 'CoreAudio', source, '-o', binary])
    assert.match(execFileSync(binary, [], { timeout: 10000, encoding: 'utf8' }), /10 项验证通过/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
test('[macOS] Universal 组件真实枚举及非法请求拒绝，不修改音频设置', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-native-test-'))
  try {
    const built = buildMacAudio({ outputRoot: path.join(dir, 'build'), minimumOs: '13.0' })
    assert.deepEqual(built.architectures, ['arm64', 'x86_64'])
    const call = payload => spawnSync(built.executable, [], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 5000 })
    const result = call({ version: 1, operation: 'list' })
    assert.equal(result.status, 0)
    const data = JSON.parse(result.stdout)
    assert.equal(data.success, true); assert.ok(Array.isArray(data.devices))
    for (const device of data.devices) {
      assert.equal(device.id, `${device.type}:${device.uid}`)
      assert.equal(typeof device.canSetVolume, 'boolean'); assert.equal(typeof device.canMute, 'boolean')
      if (device.canSetVolume) assert.ok(device.volume >= 0 && device.volume <= 100)
      if (device.canMute) assert.equal(typeof device.muted, 'boolean')
    }
    for (const payload of [
      { version: 1.9, operation: 'list' }, { version: true, operation: 'list' },
      { version: 1, operation: 'list', extra: 1 }, { version: 1, operation: 'other' },
      { version: 1, operation: 'volume', volume: -1, type: 'output' },
      { version: 1, operation: 'volume', volume: 101, type: 'input' },
      { version: 1, operation: 'volume', volume: true, type: 'output' },
      { version: 1, operation: 'mute', muted: 'false', type: 'input' },
      { version: 1, operation: 'default', type: 'output' },
      { version: 1, operation: 'default', id: 'ZToolsTest-不存在设备-5f29', type: 'output' }
    ]) {
      const response = call(payload)
      assert.equal(response.status, 1)
      assert.equal(JSON.parse(response.stdout).success, false)
    }
    const after = JSON.parse(call({ version: 1, operation: 'list' }).stdout)
    assert.deepEqual(after.devices, data.devices, '只读与非法请求不能改变真实设置')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
