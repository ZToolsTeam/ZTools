import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { auditMacRelease } from './macos-release.mjs'
import { MAC_RELEASE_PLUGIN_IDS, MAC_COMPLETE_CASE_CHECKS, auditMacReleaseEvidence, loadMacPluginCatalog, macReleaseEvidenceTemplate } from './macos-release-evidence.mjs'

const options = { 'team-id': 'ABC1234567', 'minimum-os': '13.0' }
const bundle = { bundleId: 'test.ztools.fixture', appVersion: '1.1.7.1', codeDirectoryHashes: { arm64: 'a'.repeat(40), x64: 'b'.repeat(40) } }
const pluginBaselineSha256 = loadMacPluginCatalog().baselineSha256
function dependencies({ badMetadata = false, toolFailure = false } = {}) {
  const calls = []
  return { calls, value: { platform: 'darwin',
    preflight: () => ({ status: 'PASS', appRoot: '/Test.app', ...bundle }),
    verify: ({ minimumOs }) => { assert.equal(minimumOs, '13.0'); return { machoFiles: ['Contents/MacOS/ZTools'] } },
    exec: (tool, args, settings) => { calls.push({ tool, args, settings }); if (toolFailure) throw new Error('private credential/tool diagnostic'); if (tool === '/usr/bin/plutil') return JSON.stringify({ 'com.apple.security.cs.allow-jit': true }) },
    metadata: (tool, args, settings) => {
      calls.push({ tool, args, settings })
      if (args.includes('--entitlements')) return { status: 0, stdout: '<plist fixture/>' }
      const hash = args.includes('arm64') ? bundle.codeDirectoryHashes.arm64 : bundle.codeDirectoryHashes.x64
      return { status: 0, stderr: `CodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=2\nTeamIdentifier=${badMetadata ? 'OTHERTEAM1' : options['team-id']}\nCDHash=${hash}\nAuthority=Developer ID Application: Synthetic (${options['team-id']})\n` }
    }
  } }
}

test('Windows release mode refuses before app/tools/evidence access', () => {
  assert.deepEqual(auditMacRelease({}, { platform: 'win32', preflight() { assert.fail() }, verify() { assert.fail() } }),
    { status: 'NOT_RUN', code: 'DARWIN_REQUIRED', phase: 2 })
})
test('final package audit checks exact Team, hardened runtime, both hashes, staple and Gatekeeper; missing execution stays pending', () => {
  const d = dependencies(), result = auditMacRelease(options, d.value)
  assert.equal(result.status, 'MANUAL_PENDING'); assert.deepEqual(result.codeDirectoryHashes, bundle.codeDirectoryHashes)
  assert.deepEqual(d.calls.map(c => c.tool), ['/usr/bin/codesign', '/usr/bin/codesign', '/usr/bin/codesign', '/usr/bin/codesign', '/usr/bin/plutil', '/usr/bin/xcrun', '/usr/sbin/spctl'])
  assert.ok(d.calls.every(c => c.settings.shell === false && c.settings.timeout === 15000))
  assert.ok(d.calls[0].args.includes(`anchor apple generic and certificate leaf[subject.OU] = "ABC1234567"`))
})
test('signature/source mismatch, tool failure and wrong product inputs fail without diagnostic leaks', () => {
  for (const d of [dependencies({ badMetadata: true }), dependencies({ toolFailure: true })]) {
    const result = auditMacRelease(options, d.value)
    assert.equal(result.status, 'FAIL'); assert.ok(!JSON.stringify(result).includes('private'))
  }
  assert.equal(auditMacRelease({ ...options, 'team-id': 'injection"' }, dependencies().value).status, 'FAIL')
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-release-evidence-')), index = macReleaseEvidenceTemplate()
  const indexPath = path.join(root, 'index.json')
  const save = () => fs.writeFileSync(indexPath, JSON.stringify(index))
  return { root, index, indexPath, save }
}
function addReport(f, arch, caseId, pluginId, scenario) {
  const runId = randomUUID(), report = { schemaVersion: 1, phase: 2, scope: 'complete-case', runId, caseId,
    ...(pluginId ? { pluginId, scenario, ...(pluginId === 'calculator' ? { feature: 'default' } : {}) } : {}), bundleId: bundle.bundleId, appVersion: bundle.appVersion,
    pluginBaselineSha256,
    codeDirectoryHash: bundle.codeDirectoryHashes[arch], runner: { platform: 'darwin', arch }, testedProcess: { arch, translationMode: 'native' },
    startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', status: 'PASS', cleanup: { status: 'PASS' },
    checks: MAC_COMPLETE_CASE_CHECKS[caseId].map(id => ({ id, expected: 'synthetic expected observation', actual: 'synthetic observed observation', status: 'PASS' })) }
  const name = `${runId}.json`; f.index.reports.push(name); fs.writeFileSync(path.join(f.root, name), JSON.stringify(report))
  return { name, report }
}
test('template binds all 59 formal plugins and one excluded sample; missing complete cases cannot pass', () => {
  const f = fixture()
  try {
    f.save(); const result = auditMacReleaseEvidence(f.indexPath, bundle)
    assert.equal(new Set(MAC_RELEASE_PLUGIN_IDS).size, 59)
    assert.deepEqual(f.index.pluginBaseline.formalPluginIds, MAC_RELEASE_PLUGIN_IDS)
    assert.deepEqual(f.index.pluginBaseline.samplePluginIds, ['batch-pilot-sample'])
    assert.ok(f.index.plugins.some(item => item.pluginId === 'batch-media-report'))
    assert.ok(f.index.plugins.some(item => item.pluginId === 'batch-text-convert'))
    assert.equal(result.status, 'MANUAL_PENDING'); assert.equal(result.pending.length, 146)
    const removed = f.index.plugins.pop(); f.save(); assert.throws(() => auditMacReleaseEvidence(f.indexPath, bundle), /INVALID_RELEASE_EVIDENCE_INDEX/)
    f.index.plugins.push(removed)
    f.index.pluginBaseline.sha256 = 'f'.repeat(64); f.save()
    assert.throws(() => auditMacReleaseEvidence(f.indexPath, bundle), /INVALID_RELEASE_EVIDENCE_INDEX/)
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})
test('both physical architectures and every plugin scenario are required; phase1, baseline and partial evidence are rejected', () => {
  const f = fixture()
  try {
    for (const plugin of f.index.plugins) { plugin.policy = plugin.pluginId === 'calculator' ? 'supported' : 'windows-only'; plugin.features = plugin.policy === 'supported' ? ['default'] : [] }
    for (const arch of ['arm64', 'x64']) {
      for (let id = 1; id <= 15; id++) if (id !== 13) addReport(f, arch, `M${String(id).padStart(2, '0')}`)
      for (const plugin of f.index.plugins) for (const scenario of plugin.policy === 'supported' ? ['success', 'error', 'cancel', 'restart'] : ['reject']) addReport(f, arch, 'M13', plugin.pluginId, scenario)
    }
    f.save(); assert.equal(auditMacReleaseEvidence(f.indexPath, bundle).status, 'PASS')
    const file = path.join(f.root, f.index.reports[0]), original = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const change of [r => { r.phase = 1 }, r => { r.scope = 'readonly-sdk-contract-subset' },
      r => { r.testedProcess.translationMode = 'translated' }, r => { r.codeDirectoryHash = 'c'.repeat(40) },
      r => { r.checks.pop() }, r => { delete r.pluginBaselineSha256 }]) {
      const r = structuredClone(original); change(r); fs.writeFileSync(file, JSON.stringify(r))
      assert.throws(() => auditMacReleaseEvidence(f.indexPath, bundle))
    }
    fs.writeFileSync(file, JSON.stringify({ ...original, status: 'MANUAL_PENDING' })); assert.equal(auditMacReleaseEvidence(f.indexPath, bundle).status, 'MANUAL_PENDING')
    fs.writeFileSync(file, JSON.stringify({ ...original, status: 'FAIL' })); assert.equal(auditMacReleaseEvidence(f.indexPath, bundle).status, 'FAIL')
    f.index.reports.push('../escape.json'); f.save(); assert.throws(() => auditMacReleaseEvidence(f.indexPath, bundle))
  } finally { fs.rmSync(f.root, { recursive: true, force: true }) }
})
