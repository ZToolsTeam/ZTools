import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createScenarioPlan,
  createScopeBoundary,
  resolveFixtureRoute,
  validateArtifactEntries,
  validateSdk1PluginManifest,
  validateSuccessfulDownload
} from './test-windows-normal-app-network-chain.mjs'

const runId = 'abcde123-4567-4890-a123-0123456789ab'
const profileRoot = 'E:\\run\\profiles\\normal'
const downloads = profileRoot + '\\downloads'
const manifest = {
  id: 'batch-text-convert',
  version: '1.0.0',
  targets: [{ id: 'windows-electron-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }],
  nativeComponents: []
}
const expectedBytes = Buffer.from([0, 255, 3, 9])

test('SDK1 plugin contract accepts only the installed pure JavaScript Windows x64 target', () => {
  assert.equal(validateSdk1PluginManifest(manifest).status, 'PASS')
  assert.equal(validateSdk1PluginManifest({ ...manifest, nativeComponents: ['helper.exe'] }).status, 'FAIL')
  assert.equal(validateSdk1PluginManifest({ ...manifest, sdkContractVersion: 2 }).status, 'FAIL')
  assert.equal(validateSdk1PluginManifest({ ...manifest,
    targets: [{ id: 'macos-electron-any', platform: 'macos', runtime: 'electron', arch: 'any' }]
  }).status, 'FAIL')
  assert.equal(validateSdk1PluginManifest({ ...manifest, targets: [manifest.targets[0], manifest.targets[0]] }).status, 'FAIL')
})

test('fixture route plan is loopback-only, UUID-bound, and contained in the isolated profile', () => {
  const plan = createScenarioPlan(runId, 49152, profileRoot, downloads)
  assert.equal(plan.baseUrl, 'http://127.0.0.1:49152')
  assert.equal(resolveFixtureRoute(plan, '/' + runId + '/success.bin'), 'success')
  assert.equal(resolveFixtureRoute(plan, '/' + runId + '/success.bin?redirect=https://example.com'), null)
  assert.equal(resolveFixtureRoute(plan, '/' + runId + '/../../secret'), null)
  assert.equal(resolveFixtureRoute(plan, '/other-run/success.bin'), null)
  assert.throws(() => createScenarioPlan('../escape', 49152, profileRoot, downloads), /RUN_ID_INVALID/)
  assert.throws(() => createScenarioPlan(runId, 49152, profileRoot, 'E:\\outside'), /DOWNLOAD_DIRECTORY_OUTSIDE_PROFILE/)
  assert.throws(() => createScenarioPlan(runId, 0, profileRoot, downloads), /LOOPBACK_PORT_INVALID/)
})

test('artifact contract allows only expected persisted files and one active UUID temp file', () => {
  const plan = createScenarioPlan(runId, 49152, profileRoot, downloads)
  const successName = plan.scenarios.success.fileName
  const timeoutTemp = '.' + plan.scenarios.timeout.fileName + '.bb3a19ae-c139-43d1-b7f9-ef7a35c5224d.download'
  const active = validateArtifactEntries([successName, timeoutTemp], plan,
    { presentTargets: ['success'], activeTempTargetId: 'timeout' })
  assert.equal(active.status, 'PASS')
  assert.equal(validateArtifactEntries([successName, timeoutTemp], plan,
    { presentTargets: ['success'] }).status, 'FAIL')
  assert.equal(validateArtifactEntries([successName, 'unowned.tmp'], plan,
    { presentTargets: ['success'] }).status, 'FAIL')
  assert.equal(validateArtifactEntries([plan.scenarios.httpFailure.fileName], plan,
    { presentTargets: ['success'] }).status, 'FAIL')
})

test('successful transfer requires the exact target, status, byte count, and bytes', () => {
  const target = 'E:\\run\\profiles\\normal\\downloads\\payload.bin'
  assert.equal(validateSuccessfulDownload({
    success: true, path: target.toUpperCase(), size: expectedBytes.length, statusCode: 200
  }, expectedBytes, target, expectedBytes).status, 'PASS')
  assert.equal(validateSuccessfulDownload({
    success: true, path: 'E:\\other\\payload.bin', size: expectedBytes.length, statusCode: 200
  }, expectedBytes, target, expectedBytes).status, 'FAIL')
  assert.equal(validateSuccessfulDownload({
    success: true, path: target, size: expectedBytes.length + 1, statusCode: 200
  }, expectedBytes, target, expectedBytes).status, 'FAIL')
  assert.equal(validateSuccessfulDownload({
    success: true, path: target, size: expectedBytes.length, statusCode: 200
  }, Buffer.from([1, 2, 3, 4]), target, expectedBytes).status, 'FAIL')
})

test('evidence boundary never upgrades SDK1 into F14, T07, or Mac acceptance', () => {
  assert.deepEqual(createScopeBoundary(), {
    scope: 'windows-normal-electron-sdk1-public-network-download-chain',
    sdkLane: 1,
    explicitPerRequestCancelApi: false,
    legacyPathToctouResolved: false,
    f14Complete: false,
    t07Complete: false,
    productionZToolsAcceptance: false,
    macAcceptance: 'NOT_RUN',
    rendererNodeExposed: false,
    rendererArbitraryIpcExposed: false
  })
})
