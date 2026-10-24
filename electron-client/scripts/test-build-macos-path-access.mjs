import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { buildMacPathAccess, main } from './build-macos-path-access.mjs'

test('path broker Mac build refuses Windows and missing deployment policy before creating output', () => {
  assert.throws(() => buildMacPathAccess({ platform: 'win32', exec: () => assert.fail('must not execute') }), /DARWIN_REQUIRED/)
  assert.throws(() => buildMacPathAccess({ platform: 'darwin', outputRoot: path.join(os.tmpdir(), 'unused-path-build') }), /macOS|OS|version|版本/)
  assert.equal(main(['--help']), 0)
})

test('Mac path broker builds maintained core and broker for both slices with strict compilation and minimum OS checks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-path-build-')), calls = [], audits = []
  // Retain owned fixture output for diagnostics; no cleanup of caller-provided paths.
  const outputRoot = path.join(root, 'build')
  const result = buildMacPathAccess({ platform: 'darwin', outputRoot, minimumOs: '13.0',
    exec(tool, argv, options) {
      calls.push([tool, argv, options])
      const index = argv.indexOf('-o') >= 0 ? argv.indexOf('-o') : argv.indexOf('-output')
      if (index >= 0) fs.writeFileSync(argv[index + 1], 'synthetic helper', { flag: 'wx' })
      return argv.includes('-archs') ? 'x86_64 arm64\n' : ''
    }, inspectDeployment(file, arch) { audits.push([file, arch]); return '13.0' }
  })
  assert.equal(path.basename(result.executable), 'ZToolsPathAccessBroker')
  assert.deepEqual(result.architectures, ['arm64', 'x86_64']); assert.equal(calls.length, 4)
  for (const [tool, argv, options] of calls.slice(0, 2)) {
    assert.equal(tool, '/usr/bin/xcrun'); assert.equal(options.shell, false)
    assert.equal(options.timeout, 120000); assert.ok(argv.includes('-Werror')); assert.ok(argv.includes('-mmacosx-version-min=13.0'))
    assert.ok(argv.some(arg => arg.endsWith('ZToolsPathAccess/path_access.cpp') || arg.endsWith('ZToolsPathAccess\\path_access.cpp')))
    assert.ok(argv.some(arg => arg.endsWith('ZToolsPathAccess/broker.cpp') || arg.endsWith('ZToolsPathAccess\\broker.cpp')))
  }
  assert.deepEqual(audits.map(item => item[1]), ['arm64', 'x86_64'])
  assert.throws(() => buildMacPathAccess({ platform: 'darwin', outputRoot, minimumOs: '13.0' }), /EEXIST/)
})

test('Mac path broker fails closed on thin binaries and an excessive actual deployment version', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-path-build-reject-'))
  for (const mode of ['thin', 'os']) {
    assert.throws(() => buildMacPathAccess({ platform: 'darwin', outputRoot: path.join(root, mode), minimumOs: '13.0',
      exec: (_tool, argv) => argv.includes('-archs') ? mode === 'thin' ? 'arm64' : 'arm64 x86_64' : '',
      inspectDeployment: () => '14.0'
    }), mode === 'thin' ? /UNIVERSAL_REQUIRED/ : /NATIVE_MINIMUM_OS_MISMATCH/)
  }
})
