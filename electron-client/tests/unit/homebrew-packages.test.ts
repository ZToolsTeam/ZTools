import assert from 'node:assert/strict'
import test from 'node:test'
import { parseInstalledBrewPackages } from '../../src/main/services/system-service.js'

test('Homebrew JSON 同时保留 formula/cask、安装版本和可升级状态', () => {
  assert.deepEqual(parseInstalledBrewPackages(JSON.stringify({
    formulae: [{ name: 'node', installed: [{ version: '22.1.0' }, { version: '22.2.0' }], versions: { stable: '24.0.0' }, outdated: true }],
    casks: [{ token: 'example-app', installed: '1.2,3', version: '1.2,3', outdated: false }]
  })), [
    { name: 'node', version: '22.1.0, 22.2.0', latestVersion: '24.0.0', isCask: false, outdated: true },
    { name: 'example-app', version: '1.2,3', latestVersion: '1.2,3', isCask: true, outdated: false }
  ])
})

test('Homebrew 空安装保持空；畸形或截断 JSON 明确失败', () => {
  assert.deepEqual(parseInstalledBrewPackages('{"formulae":[],"casks":[]}'), [])
  assert.throws(() => parseInstalledBrewPackages('{'))
  assert.throws(() => parseInstalledBrewPackages('{}'), /缺少/)
  assert.throws(() => parseInstalledBrewPackages('{"formulae":[null],"casks":[]}'), /条目格式无效/)
})
