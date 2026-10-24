import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
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

test('[回归] 路径含括号（如「ZTools Helper (GPU)」）时经无括号的符号链接调用 otool，并清理临时目录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-otool-test-'))
  const tmp = path.join(root, 'tmp'); fs.mkdirSync(tmp)
  try {
    const target = path.join(root, 'ZTools Helper (GPU)')
    fs.writeFileSync(target, 'macho')
    const seen = []
    const exec = (tool, argv) => {
      const file = argv[argv.length - 1]
      seen.push(file)
      assert.equal(/[()]/.test(file), false, '传给 otool 的路径不含括号')
      assert.equal(fs.realpathSync(file), fs.realpathSync(target), '链接指向原文件')
      return modern('12.0')
    }
    assert.equal(inspectMacDeployment(target, 'arm64', { exec, tmpdir: () => tmp }), '12.0')
    assert.equal(seen.length, 1)
    assert.deepEqual(fs.readdirSync(tmp), [], '临时目录已清理')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('[破坏性] otool 失败时同样清理临时符号链接目录并抛出原错误', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-otool-fail-'))
  const tmp = path.join(root, 'tmp'); fs.mkdirSync(tmp)
  try {
    const target = path.join(root, 'Helper (Renderer)')
    fs.writeFileSync(target, 'macho')
    const exec = () => { throw new Error('otool crashed') }
    assert.throws(() => inspectMacDeployment(target, 'x86_64', { exec, tmpdir: () => tmp }), /otool crashed/)
    assert.deepEqual(fs.readdirSync(tmp), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('[集成] 真实 otool 能读取路径含括号的 Mach-O', { skip: process.platform === 'darwin' ? false : '需要 macOS otool' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-otool-real-'))
  try {
    const target = path.join(root, 'Node Helper (GPU)')
    fs.copyFileSync(process.execPath, target)
    const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
    assert.match(inspectMacDeployment(target, arch), /^\d+\.\d+/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

