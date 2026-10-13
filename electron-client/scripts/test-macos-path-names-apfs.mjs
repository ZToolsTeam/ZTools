import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { main, runMacPathNamesApfs, validateNativeNameResult } from './macos-path-names-apfs.mjs'

const nativeResult = caseSensitive => ({ status: 'PASS', scope: 'native-pinned-name-contract', tests: caseSensitive ? 28 : 30,
  caseSensitive, unicodeNormalizationAlias: true })
const options = { output: path.resolve('out-test/synthetic-apfs-name-run'), 'native-test': path.resolve('out-test/synthetic/NamesTest'),
  'minimum-os': '14.0', 'expect-process-arch': 'arm64' }
function dependencies({ failSecond = false, wrongCase = false, cleanupFailed = false } = {}) {
  const calls = [], checks = []
  const volumes = [false, true].map(caseSensitive => ({ caseSensitive,
    fixtures: path.resolve('out-test/synthetic-apfs-' + caseSensitive), device: '/dev/disk10s1', uuid: 'synthetic' }))
  return { calls, checks, platform: 'darwin', inspectNative: async (file, minimumOs) => {
    assert.equal(file, options['native-test']); assert.equal(minimumOs, options['minimum-os'])
    return { sha256: 'a'.repeat(64), architectures: ['arm64', 'x86_64'], deployment: [] }
  }, verifyVolume: async volume => { checks.push(volume.caseSensitive) },
  executeNative: async command => {
    calls.push(command)
    if (failSecond && calls.length === 2) throw new Error('SYNTHETIC_NATIVE_FAILURE')
    return nativeResult(wrongCase ? true : calls.length === 2)
  }, withFixtures: async (output, execute) => {
    assert.equal(output, options.output)
    let status = 'PASS', results
    try { results = await execute(volumes, new AbortController().signal) } catch { status = 'FAIL' }
    if (cleanupFailed) status = 'FAIL'
    return { status, results, cleanup: [{ status: cleanupFailed ? 'FAIL' : 'OWNED_VOLUME_DETACHED' }] }
  } }
}

test('Windows APFS native entry is NOT_RUN before inspection, mounting or process execution', async () => {
  const result = await runMacPathNamesApfs(undefined, { platform: 'win32', inspectNative: () => assert.fail(), withFixtures: () => assert.fail() })
  assert.deepEqual(result, { status: 'NOT_RUN', code: 'DARWIN_REQUIRED', phase: 2, scope: 'native-pinned-name-apfs-matrix' })
  assert.equal(await main(['--help']), 0)
})

test('owned APFS native name matrix binds both volume types, approved OS, binary hash and exact process slice', async () => {
  const fake = dependencies(), result = await runMacPathNamesApfs(options, fake)
  assert.equal(result.status, 'PASS'); assert.equal(result.phase, 2); assert.equal(result.releaseAcceptance, false)
  assert.deepEqual(fake.checks, [false, true]); assert.equal(fake.calls.length, 2)
  assert.ok(fake.calls.every(call => call.processArch === 'arm64' && call.sha256 === 'a'.repeat(64) && call.executable === options['native-test']))
  assert.equal(fake.calls[0].fixtureRoot, path.resolve('out-test/synthetic-apfs-false/native-names'))
  assert.equal(fake.calls[1].fixtureRoot, path.resolve('out-test/synthetic-apfs-true/native-names'))
})

test('native failure, wrong volume observation and owned detach failure cannot pass the APFS matrix', async () => {
  for (const failure of [{ failSecond: true }, { wrongCase: true }, { cleanupFailed: true }]) {
    assert.equal((await runMacPathNamesApfs(options, dependencies(failure))).status, 'FAIL')
  }
  for (const value of [{ ...nativeResult(false), tests: 21 }, { ...nativeResult(false), caseSensitive: true },
    { ...nativeResult(false), unicodeNormalizationAlias: 'unknown' }, { ...nativeResult(false), path: '/private' }]) {
    assert.throws(() => validateNativeNameResult(value, false), /NATIVE_NAMES_RESULT_MISMATCH/)
  }
})

test('missing parameters, invalid OS, thin executable and early cancellation do not execute native cases', async () => {
  for (const changed of [{ ...options, output: 'relative' }, { ...options, 'native-test': 'relative' },
    { ...options, 'minimum-os': 'latest' }, { ...options, 'expect-process-arch': 'ia32' }]) {
    const fake = dependencies(); assert.equal((await runMacPathNamesApfs(changed, fake)).status, 'FAIL'); assert.equal(fake.calls.length, 0)
  }
  const thin = dependencies(); thin.inspectNative = async () => ({ sha256: 'a'.repeat(64), architectures: ['arm64'] })
  assert.equal((await runMacPathNamesApfs(options, thin)).status, 'FAIL'); assert.equal(thin.calls.length, 0)
  const cancelled = dependencies(), controller = new AbortController(); controller.abort()
  cancelled.withFixtures = async (_, execute) => {
    try { await execute([{ caseSensitive: false }, { caseSensitive: true }], controller.signal) }
    catch { return { status: 'FAIL' } }
    return { status: 'PASS' }
  }
  assert.equal((await runMacPathNamesApfs({ ...options, signal: controller.signal }, cancelled)).status, 'FAIL'); assert.equal(cancelled.calls.length, 0)
})
