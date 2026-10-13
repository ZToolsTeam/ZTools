import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildFixtureArguments,
  parseChooserSelection,
  parseProcessChainArgs,
  summarizeProcessList,
  validateFixtureCimRow,
  validateProcessFixtureManifest
} from './test-windows-normal-app-process-chain.mjs'

const scriptRoot = path.dirname(fileURLToPath(import.meta.url))
const fixtureRoot = path.resolve(scriptRoot, '..', 'tests', 'fixtures', 'windows-normal-app-process-chain')

test('runner is explicit opt-in and rejects unknown or missing execution arguments', () => {
  assert.deepEqual(parseProcessChainArgs(['--help']), { help: true, execute: false, preflightOnly: false })
  assert.deepEqual(parseProcessChainArgs(['--execute-normal-app']), { help: false, execute: true, preflightOnly: false })
  assert.deepEqual(parseProcessChainArgs(['--preflight-only']), { help: false, execute: false, preflightOnly: true })
  assert.throws(() => parseProcessChainArgs([]), /F11_EXPLICIT_EXECUTION_FLAG_REQUIRED/)
  assert.throws(() => parseProcessChainArgs(['--execute-normal-app', '--unknown']), /Unknown option/)
  assert.throws(() => parseProcessChainArgs(['--preflight-only', '--execute-normal-app']), /F11_EXECUTION_MODE_CONFLICT/)
})

test('test-only plugin fixture manifest is SDK1 and Windows-only with no native components', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'plugin.json'), 'utf8'))
  assert.deepEqual(validateProcessFixtureManifest(manifest), { status: 'PASS', errors: [], testOnly: true, declaredSdkLane: 1 })
  const changed = { ...manifest, targets: [...manifest.targets, { id: 'macos-electron-any', platform: 'macos', runtime: 'electron', arch: 'any' }] }
  assert.equal(validateProcessFixtureManifest(changed).status, 'FAIL')
  assert.equal(validateProcessFixtureManifest({ ...manifest, nativeComponents: [{ id: 'host' }] }).status, 'FAIL')
})

test('fixture loads shared SDK through the real ztools web origin and its JS through the scoped plugin origin', () => {
  const html = fs.readFileSync(path.join(fixtureRoot, 'index.html'), 'utf8')
  assert.match(html, /src="ztools:\/\/web\/sdk\/ztools-api\.js"/)
  assert.match(html, /src="ztools:\/\/web\/sdk\/plugin-sdk\.js"/)
  assert.match(html, /src="ztools:\/\/plugins\/f11-process-chain-test\/app\.js"/)
  assert.doesNotMatch(html, /src="\/sdk\//)
})

test('fixture has only bounded hold and delayed exit argument forms', () => {
  assert.deepEqual(buildFixtureArguments('hold', 60_000, 0), ['hold', '60000'])
  assert.deepEqual(buildFixtureArguments('hold', 120_000, 0), ['hold', '120000'])
  assert.deepEqual(buildFixtureArguments('exit', 15_000, 23), ['exit', '15000', '23'])
  for (const duration of [0, 59_999, 120_001, NaN, Infinity]) assert.throws(() => buildFixtureArguments('hold', duration, 0))
  for (const [duration, exitCode] of [[99, 1], [120_001, 1], [15_000, -1], [15_000, 256]]) assert.throws(() => buildFixtureArguments('exit', duration, exitCode))
  assert.throws(() => buildFixtureArguments('exec', 1, 0), /F11_FIXTURE_MODE_INVALID/)
})

test('chooser parser accepts observed single-selection public result shapes and rejects ambiguity', () => {
  const expected = 'C:\\F11\\ProcessFixture.exe'
  assert.equal(parseChooserSelection({ canceled: false, filePath: expected, fileUrl: 'ztools://reference/test' }, expected).shape, 'filePath')
  assert.equal(parseChooserSelection({ canceled: false, filePaths: [{ path: expected, fileUrl: 'ztools://reference/test' }] }, expected).shape, 'filePaths:object')
  assert.equal(parseChooserSelection({ canceled: false, filePaths: [expected] }, expected).shape, 'filePaths:string')
  assert.throws(() => parseChooserSelection({ canceled: true }, expected), /F11_CHOOSER_NOT_ACCEPTED/)
  assert.throws(() => parseChooserSelection({ canceled: false, filePaths: [expected, expected] }, expected), /F11_CHOOSER_PATH_MISMATCH/)
  assert.throws(() => parseChooserSelection({ canceled: false, filePath: 'C:\\F11\\other.exe' }, expected), /F11_CHOOSER_PATH_MISMATCH/)
})

test('process-list evidence keeps only total count and locked Main/fixture rows', () => {
  const summary = summarizeProcessList([
    { pid: 101, name: 'ZTools.exe', fieldAvailability: { path: true, cpuUsage: true, memoryUsage: true }, commandLine: 'private' },
    { pid: 202, name: 'ProcessFixture.exe', fieldAvailability: { path: false, cpuUsage: true, memoryUsage: true }, commandLine: 'private' },
    { pid: 303, name: 'user-app.exe', path: 'private', fieldAvailability: { path: false } }
  ], { mainPid: 101, fixturePid: 202 })
  assert.deepEqual(summary, { totalCount: 3, matchingRows: [
    { pid: 101, role: 'isolated-main', fieldAvailability: { path: true, cpuUsage: true, memoryUsage: true } },
    { pid: 202, role: 'owned-fixture', fieldAvailability: { path: false, cpuUsage: true, memoryUsage: true } }
  ] })
  assert.equal(JSON.stringify(summary).includes('user-app'), false)
  assert.throws(() => summarizeProcessList([], { mainPid: 0 }), /F11_PROCESS_LIST_INVALID/)
})

test('targeted CIM identity requires exact pid, parent, image path, and creation time', () => {
  const expected = { pid: 22, parentPid: 11, imagePath: 'C:\\F11\\ProcessFixture.exe', creationDate: '2026-10-08T01:02:03.0000000Z' }
  assert.equal(validateFixtureCimRow({ ...expected, imagePath: 'c:\\f11\\PROCESSFIXTURE.EXE' }, expected).status, 'PASS')
  for (const patch of [{ pid: 23 }, { parentPid: 9 }, { imagePath: 'C:\\F11\\other.exe' }, { creationDate: '2026-10-08T01:02:04.0000000Z' }]) {
    assert.equal(validateFixtureCimRow({ ...expected, ...patch }, expected).status, 'FAIL')
  }
})
