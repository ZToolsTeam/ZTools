import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildMacNativeHost } from './build-macos-native-host.mjs'

test('Mac native Host builder rejects Windows before filesystem or tool access', () => {
  assert.throws(() => buildMacNativeHost({
    platform: 'win32',
    exec: () => assert.fail('tool must not run'),
    inspectDeployment: () => assert.fail('deployment inspector must not run')
  }), /DARWIN_REQUIRED/)
})

test('Mac native Host builder requires approved minimum OS and an explicit test slice', () => {
  assert.throws(() => buildMacNativeHost({ platform: 'darwin', processArchitecture: 'arm64' }), /非法OS版本/)
  assert.throws(() => buildMacNativeHost({ platform: 'darwin', minimumOs: '13.0', processArchitecture: 'ia32' }), /MAC_PROCESS_ARCH_REQUIRED/)
})

test('Mac native Host builder requires universal outputs and audits every binary slice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-mac-native-host-build-'))
  const cmake = path.join(root, 'cmake')
  const outputRoot = path.join(root, 'native-build')
  fs.writeFileSync(cmake, 'fixture cmake')
  const calls = []
  const audits = []
  try {
    const result = buildMacNativeHost({
      platform: 'darwin', cmake, outputRoot, minimumOs: '13.0', processArchitecture: 'arm64',
      exec(tool, args, options) {
        calls.push({ tool, args, options })
        if (args[0] === '--build') {
          const bin = path.join(outputRoot, 'build', 'bin')
          fs.mkdirSync(bin, { recursive: true })
          for (const name of ['ZToolsMacNativeHost', 'ZToolsMacNativeWorker', 'ZToolsMacNativeTrustGateTest']) {
            fs.writeFileSync(path.join(bin, name), 'synthetic binary')
          }
          return ''
        }
        if (tool === '/usr/bin/lipo' && args[0] === '-archs') return 'arm64 x86_64\n'
        return ''
      },
      inspectDeployment(filePath, architecture) {
        audits.push([path.basename(filePath), architecture])
        return '12.0'
      }
    })
    assert.equal(calls.length, 5)
    assert.equal(calls[0].tool, cmake)
    assert.ok(calls[0].args.includes('-DCMAKE_OSX_ARCHITECTURES=arm64;x86_64'))
    assert.ok(calls[0].args.includes('-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0'))
    assert.equal(calls[0].options.shell, false)
    assert.equal(calls[1].args[0], '--build')
    assert.equal(result.signed, false)
    assert.deepEqual(result.architectures, ['arm64', 'x86_64'])
    assert.equal(audits.length, 6)
    assert.equal(fs.readFileSync(result.hostPath, 'utf8'), 'synthetic binary')
    assert.throws(() => buildMacNativeHost({
      platform: 'darwin', cmake, outputRoot, minimumOs: '13.0', processArchitecture: 'arm64',
      exec: () => assert.fail('existing output must fail before tools')
    }), /EEXIST/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Mac native Host builder rejects thin output and a component compiled above approved minimum OS', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-mac-native-host-audit-'))
  const cmake = path.join(root, 'cmake')
  fs.writeFileSync(cmake, 'fixture cmake')
  try {
    const thinRoot = path.join(root, 'thin')
    assert.throws(() => buildMacNativeHost({
      platform: 'darwin', cmake, outputRoot: thinRoot, minimumOs: '13.0', processArchitecture: 'x64',
      exec(tool, args) {
        if (args[0] === '--build') {
          const bin = path.join(thinRoot, 'build', 'bin')
          fs.mkdirSync(bin, { recursive: true })
          for (const name of ['ZToolsMacNativeHost', 'ZToolsMacNativeWorker', 'ZToolsMacNativeTrustGateTest']) fs.writeFileSync(path.join(bin, name), 'fixture')
        }
        return tool === '/usr/bin/lipo' ? 'arm64\n' : ''
      },
      inspectDeployment: () => '13.0'
    }), /UNIVERSAL_REQUIRED/)

    const tooNewRoot = path.join(root, 'too-new')
    assert.throws(() => buildMacNativeHost({
      platform: 'darwin', cmake, outputRoot: tooNewRoot, minimumOs: '13.0', processArchitecture: 'x64',
      exec(tool, args) {
        if (args[0] === '--build') {
          const bin = path.join(tooNewRoot, 'build', 'bin')
          fs.mkdirSync(bin, { recursive: true })
          for (const name of ['ZToolsMacNativeHost', 'ZToolsMacNativeWorker', 'ZToolsMacNativeTrustGateTest']) fs.writeFileSync(path.join(bin, name), 'fixture')
        }
        return tool === '/usr/bin/lipo' ? 'arm64 x86_64\n' : ''
      },
      inspectDeployment: () => '14.0'
    }), /NATIVE_MINIMUM_OS_MISMATCH/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
