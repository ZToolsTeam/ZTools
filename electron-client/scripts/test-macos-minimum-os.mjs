import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { parseMacDeploymentVersion, inspectMacDeployment, inspectMacBundleMinimumOs } from './macos-minimum-os.mjs'

const modern = version => `Binary:\nLoad command 0\n cmd LC_BUILD_VERSION\n cmdsize 32\n platform 1\n minos ${version}\n sdk 15.0\n ntools 1\n`
const legacy = version => `Binary:\nLoad command 0\n cmd LC_VERSION_MIN_MACOSX\n cmdsize 16\n version ${version}\n sdk 12.0\n`

test('解析现代和legacy macOS部署下限', () => {
  assert.equal(parseMacDeploymentVersion(modern('12.0')), '12.0')
  assert.equal(parseMacDeploymentVersion(legacy('10.15.0')), '10.15.0')
})
test('缺失、重复、非法和其他Apple平台load command拒绝', () => {
  for (const value of ['', modern('bad'), modern('12.0') + modern('13.0'),
    modern('12.0').replace('platform 1', 'platform 2'),
    legacy('12.0').replace('LC_VERSION_MIN_MACOSX', 'LC_VERSION_MIN_IPHONEOS')]) {
    assert.throws(() => parseMacDeploymentVersion(value))
  }
})
test('otool精确选择每个切片；plutil核App元数据；参数和工具边界固定', () => {
  const calls = []
  const exec = (tool, argv, config) => {
    calls.push({ tool, argv, config })
    return tool.endsWith('otool') ? modern('12.0') : JSON.stringify({ LSMinimumSystemVersion: '12.0' })
  }
  assert.equal(inspectMacDeployment('/fixture/a file', 'arm64', { exec }), '12.0')
  assert.deepEqual(calls[0].argv, ['-arch', 'arm64', '-l', '/fixture/a file'])
  assert.equal(inspectMacBundleMinimumOs('/fixture/App.app', { exec }), '12.0')
  assert.deepEqual(calls[1].argv, ['-convert', 'json', '-o', '-', path.join('/fixture/App.app', 'Contents', 'Info.plist')])
  for (const call of calls) assert.deepEqual(call.config, { encoding: 'utf8', shell: false, timeout: 15_000, maxBuffer: 1024 * 1024 })
  assert.throws(() => inspectMacDeployment('/fixture/a file', 'ia32', { exec }))
  assert.equal(calls.length, 2)
})
