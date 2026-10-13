import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildWindowsPathAccess } from './build-windows-path-access.mjs'

function fixture(machine = 0x8664) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-win-path-build-')), outputRoot = path.join(root, 'run')
  const calls = [], options = { outputRoot, cmake: process.execPath, platform: 'win32', run: (exe, args, execution) => {
    calls.push({ exe, args, execution })
    if (args[0] === '--build') {
      const binary = Buffer.alloc(128); binary.write('MZ'); binary.writeUInt32LE(64, 0x3c); binary.write('PE\0\0', 64); binary.writeUInt16LE(machine, 68)
      fs.mkdirSync(path.join(outputRoot, 'bin')); fs.writeFileSync(path.join(outputRoot, 'bin', 'ZToolsPathAccessBroker.exe'), binary)
    }
    return { status: 0, stdout: 'injected tools', stderr: '' }
  } }
  return { options, calls }
}
test('Windows helper build fixes x64 and maintained source and audits the real output machine', () => {
  const f = fixture(), result = buildWindowsPathAccess(f.options)
  assert.equal(result.arch, 'x64'); assert.match(result.sha256, /^[a-f0-9]{64}$/)
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].args[f.calls[0].args.indexOf('-A') + 1], 'x64')
  assert.equal(f.calls[1].args.at(-1), 'ZToolsPathAccessBroker')
  assert.equal(f.calls[0].execution.shell, false); assert.ok(f.calls[0].execution.env.TEMP.startsWith(f.options.outputRoot))
  assert.throws(() => buildWindowsPathAccess(f.options), /FRESH_OUTPUT_REQUIRED/)
})
test('wrong host and missing CMake fail before invoking tools or creating output', () => {
  const f = fixture()
  assert.throws(() => buildWindowsPathAccess({ ...f.options, platform: 'darwin' }), /WINDOWS_REQUIRED/)
  assert.throws(() => buildWindowsPathAccess({ ...f.options, cmake: 'relative' }), /CMAKE_REQUIRED/)
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.options.outputRoot), false)
})
test('x86 output and failed compiler cannot produce a success result marker', () => {
  const f = fixture(0x14c)
  assert.throws(() => buildWindowsPathAccess(f.options)); assert.equal(fs.existsSync(path.join(f.options.outputRoot, 'build-result.json')), false)
  const failed = fixture(); assert.throws(() => buildWindowsPathAccess({ ...failed.options, run: () => ({ status: 1, stdout: '', stderr: 'injected error' }) }), /WINDOWS_PATH_ACCESS_BUILD_FAILED/)
  assert.equal(fs.existsSync(path.join(failed.options.outputRoot, 'build-result.json')), false)
})
