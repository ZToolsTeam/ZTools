import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildMacVision } from './build-macos-vision.mjs'
import { runNativeVisionTests } from './test-native-macos-vision.mjs'

test('native Mac vision gate rejects Windows before touching output/tools', () => {
  assert.throws(() => buildMacVision({ platform: 'win32', exec: () => assert.fail('tool must not run') }), /DARWIN_REQUIRED/)
})

test('native vision builds both slices with explicit deployment policy and audits the fat helper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-vision-build-'))
  const outputRoot = path.join(root, 'build')
  const calls = [], audits = []
  try {
    const result = buildMacVision({ platform: 'darwin', outputRoot, minimumOs: '13.0',
      exec(tool, argv, options) {
        calls.push([tool, argv, options])
        const index = argv.indexOf('-o') >= 0 ? argv.indexOf('-o') : argv.indexOf('-output')
        if (index >= 0) fs.writeFileSync(argv[index + 1], 'fixture binary')
        return argv.includes('-archs') ? 'x86_64 arm64\n' : ''
      },
      inspectDeployment(file, arch) { audits.push([file, arch]); return '13.0' }
    })
    assert.deepEqual(result.architectures, ['arm64', 'x86_64'])
    assert.equal(calls.length, 4)
    for (const [tool, argv, options] of calls.slice(0, 2)) {
      assert.equal(tool, '/usr/bin/xcrun')
      assert.ok(argv.includes('-mmacosx-version-min=13.0'))
      assert.equal(options.shell, false)
      assert.equal(options.timeout, 120000)
    }
    assert.deepEqual(audits.map(a => a[1]), ['arm64', 'x86_64'])
    assert.equal(fs.readFileSync(result.executable, 'utf8'), 'fixture binary')
    assert.throws(() => buildMacVision({ platform: 'darwin', outputRoot, minimumOs: '13.0' }), /EEXIST/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('native vision refuses thin output and compile failures; no success artifact returned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-vision-build-'))
  try {
    assert.throws(() => buildMacVision({ platform: 'darwin', outputRoot: path.join(root, 'thin'), minimumOs: '13.0',
      exec: (_tool, argv) => argv.includes('-archs') ? 'arm64' : '' }), /UNIVERSAL_REQUIRED/)
    let calls = 0
    assert.throws(() => buildMacVision({ platform: 'darwin', outputRoot: path.join(root, 'failed'), minimumOs: '13.0',
      exec() { calls++; throw new Error('compile failed') } }), /compile failed/)
    assert.equal(calls, 1)
    assert.equal(fs.existsSync(path.join(root, 'failed', 'native')), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('native test collector executes the selected real slice and rejects mismatched native evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-vision-self-test-'))
  const executable = path.join(root, 'ZToolsMacVision')
  fs.writeFileSync(executable, 'fixture helper')
  try {
    for (const architecture of ['arm64', 'x64']) {
      const result = runNativeVisionTests({ minimumOs: '13.0', inspectDeployment: () => '13.0', platform: 'darwin', executable, architecture,
        exec(tool, args, options) {
          if (tool === '/usr/bin/sw_vers') return '13.0'
          if (tool === '/usr/bin/lipo') return 'arm64 x86_64'
          assert.equal(tool, '/usr/bin/arch')
          assert.deepEqual(args, [architecture === 'x64' ? '-x86_64' : '-arm64', executable, '--self-test'])
          assert.equal(options.shell, false)
          assert.equal(options.timeout, 60000)
          return JSON.stringify({ version: 1, success: true, architecture, cases: 9, scope: 'vision-local-native' })
        }
      })
      assert.equal(result.status, 'PASS')
    }
    assert.throws(() => runNativeVisionTests({ minimumOs: '13.0', inspectDeployment: () => '13.0', platform: 'darwin', executable, architecture: 'arm64',
      exec: tool => tool === '/usr/bin/sw_vers' ? '13.0' : tool === '/usr/bin/lipo' ? 'arm64 x86_64' : JSON.stringify({ version: 1, success: true, architecture: 'x64', cases: 9, scope: 'vision-local-native' }) }), /NATIVE_TEST_CONTRACT_MISMATCH/)
    assert.deepEqual(runNativeVisionTests({ minimumOs: '13.0', inspectDeployment: () => '13.0', platform: 'win32' }), { status: 'NOT_RUN', code: 'DARWIN_REQUIRED' })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
