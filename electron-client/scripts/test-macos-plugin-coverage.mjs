import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { MAC_EXPECTED_FORMAL_PLUGIN_COUNT, MAC_PLUGIN_SAMPLE_ID, MAC_RELEASE_PLUGIN_IDS, loadMacPluginCatalog } from './macos-release-evidence.mjs'
import { parsePluginCoverageGroups, collectPluginCoverage, main } from './macos-plugin-coverage.mjs'

const actualCatalog = loadMacPluginCatalog()

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-plugin-coverage-'))
  const sourceRoot = path.join(root, 'plugins'), reactSourceRoot = path.join(root, 'plugins-react')
  fs.mkdirSync(sourceRoot); fs.mkdirSync(reactSourceRoot)
  for (const entry of [...actualCatalog.plugins, ...actualCatalog.samples]) {
    const targetRoot = entry.layout === 'plugins-react' ? reactSourceRoot : sourceRoot
    const directory = path.join(targetRoot, entry.pluginId)
    fs.mkdirSync(directory, { recursive: true })
    fs.copyFileSync(entry.manifestPath, path.join(directory, 'plugin.json'))
  }
  const architectureDocument = path.join(root, 'architecture.md')
  fs.copyFileSync(actualCatalog.architectureDocument, architectureDocument)
  const pluginId = 'calculator', directory = path.join(sourceRoot, pluginId)
  fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ id: pluginId, version: '1',
    name: 'Fixture calculator', description: 'Synthetic feature summary',
    targets: [{ id: 'mac', platform: 'macos', runtime: 'electron', arch: 'any' }] }))
  fs.mkdirSync(path.join(directory, '__tests__'))
  fs.writeFileSync(path.join(directory, '__tests__', 'synthetic.unit.test.ts'), '// available source, not execution evidence\n')
  return { root, directory, sourceRoot, reactSourceRoot, architectureDocument, pluginId }
}

const cleanup = f => fs.rmSync(f.root, { recursive: true, force: true })
const options = f => ({ sourceRoot: f.sourceRoot, reactSourceRoot: f.reactSourceRoot, architectureDocument: f.architectureDocument })

test('real manifests and G01-G12 groups reconcile to 59 formal plugins plus one excluded sample', () => {
  const report = collectPluginCoverage()
  assert.equal(report.plugins.length, MAC_EXPECTED_FORMAL_PLUGIN_COUNT)
  assert.equal(report.sourceCount, MAC_EXPECTED_FORMAL_PLUGIN_COUNT)
  assert.equal(report.sampleCount, 1); assert.deepEqual(report.sampleIds, [MAC_PLUGIN_SAMPLE_ID])
  assert.equal(report.plugins.length, MAC_RELEASE_PLUGIN_IDS.length)
  assert.equal(new Set(report.plugins.map(item => item.pluginId)).size, 59)
  assert.ok(report.plugins.some(item => item.pluginId === 'batch-media-report'))
  assert.ok(report.plugins.some(item => item.pluginId === 'batch-text-convert'))
  assert.equal(report.plugins.find(item => item.pluginId === 'batch-media-report').group, 'G03')
  assert.equal(report.plugins.find(item => item.pluginId === 'batch-text-convert').group, 'G01')
  assert.equal(report.plugins.find(item => item.pluginId === 'password').source.layout, 'plugins-react')
  assert.equal(report.plugins.some(item => item.pluginId === MAC_PLUGIN_SAMPLE_ID), false)
  const item = report.plugins.find(item => item.pluginId === 'calculator')
  assert.equal(item.implementation.state, 'missing-implementation')
  assert.equal(item.formalWiring.state, 'manifest-present-install-unverified')
  assert.equal(item.windowsExecution.state, 'NOT_RUN_BY_THIS_COLLECTOR')
  assert.equal(item.macExecution.state, 'NOT_RUN')
  assert.equal(item.publicSupport.status, 'pending')
  assert.equal(item.targetDeclaration.state, 'implemented-unverified')
  assert.equal(item.availableUnitTests[0].execution, 'NOT_RUN_BY_THIS_COLLECTOR')
  assert.equal(report.phase1Complete, false); assert.equal(report.releaseAcceptance, false)
  assert.equal(report.plugins.reduce((sum, plugin) => sum + plugin.businessCases.length, 0), 236)
  assert.equal(report.samples[0].classification, 'sample-excluded-from-formal-plugin-count-and-public-support')
})

test('unknown group IDs, duplicate assignments, incomplete groups and deleted manifests fail closed', () => {
  const f = fixture()
  try {
    const document = fs.readFileSync(f.architectureDocument, 'utf8')
    for (const changed of [
      document.replace('calculator, calendar', 'unknown-plugin, calendar'),
      document.replace(/^\| G01 \|.*$/m, row => `${row}\n| G01 | calculator | n | T07 | d |`),
      document.replace('batch-media-report, batch-video', 'batch-media-report, batch-pilot-sample, batch-video'),
      document.replace(/^\| G12 \|.*\r?\n/m, '')
    ]) assert.throws(() => parsePluginCoverageGroups(changed), /INVALID_PLUGIN_COVERAGE_INPUT/)
    fs.rmSync(path.join(f.reactSourceRoot, 'password'), { recursive: true, force: true })
    assert.throws(() => collectPluginCoverage(options(f)))
  } finally { cleanup(f) }
})

test('new and unknown plugin directories require an explicit reviewed baseline/group update', () => {
  const f = fixture()
  try {
    const newDirectory = path.join(f.sourceRoot, 'new-plugin')
    fs.mkdirSync(newDirectory); fs.writeFileSync(path.join(newDirectory, 'plugin.json'), JSON.stringify({ id: 'new-plugin', version: '1' }))
    assert.throws(() => collectPluginCoverage(options(f)))
    fs.rmSync(newDirectory, { recursive: true, force: true })
    fs.mkdirSync(path.join(f.sourceRoot, 'unknown-directory'))
    assert.throws(() => collectPluginCoverage(options(f)))
  } finally { cleanup(f) }
})

test('duplicate manifest IDs across layouts, malformed manifests, and sample miscount fail closed', () => {
  const f = fixture()
  try {
    const duplicate = path.join(f.reactSourceRoot, 'calculator')
    fs.mkdirSync(duplicate); fs.writeFileSync(path.join(duplicate, 'plugin.json'), JSON.stringify({ id: 'calculator', version: '1' }))
    assert.throws(() => collectPluginCoverage(options(f)))
    fs.rmSync(duplicate, { recursive: true, force: true })
    const calculatorManifest = path.join(f.directory, 'plugin.json')
    for (const value of [{ id: 'forged', version: '1' }, { id: 'calculator', version: '1', targets: 'mac' },
      { id: 'calculator', version: '1', targets: [{ id: 'mac', platform: 'macos' }] }]) {
      fs.writeFileSync(calculatorManifest, JSON.stringify(value)); assert.throws(() => collectPluginCoverage(options(f)))
    }
    fs.rmSync(path.join(f.sourceRoot, MAC_PLUGIN_SAMPLE_ID), { recursive: true, force: true })
    assert.throws(() => collectPluginCoverage(options(f)))
  } finally { cleanup(f) }
})

test('React manifests and tests are included, and shadowed identities are refused', () => {
  const f = fixture()
  try {
    const directory = path.join(f.reactSourceRoot, 'password')
    fs.mkdirSync(path.join(directory, '__tests__'))
    fs.writeFileSync(path.join(directory, '__tests__', 'react-vault.unit.test.ts'), '// synthetic fixture only\n')
    const report = collectPluginCoverage(options(f)), item = report.plugins.find(item => item.pluginId === 'password')
    assert.equal(report.sourceCount, 59); assert.equal(item.source.layout, 'plugins-react')
    assert.ok(item.availableUnitTests.some(entry => entry.file === '__tests__/react-vault.unit.test.ts'))
    fs.mkdirSync(path.join(f.sourceRoot, 'password'))
    fs.copyFileSync(path.join(directory, 'plugin.json'), path.join(f.sourceRoot, 'password', 'plugin.json'))
    assert.throws(() => collectPluginCoverage(options(f)))
  } finally { cleanup(f) }
})

test('inventory CLI requires a fresh absolute path and cannot convert inventory into completion or overwrite evidence', () => {
  const f = fixture(), output = path.join(f.root, 'coverage.json'), collect = () => collectPluginCoverage(options(f))
  try {
    assert.equal(main(['--output', output], { collect }), 0)
    const original = fs.readFileSync(output, 'utf8')
    assert.equal(main(['--output', output], { collect }), 1); assert.equal(fs.readFileSync(output, 'utf8'), original)
    assert.equal(main(['--output', path.join(f.root, 'fake-complete.json')], { collect: () => ({ ...collect(), phase1Complete: true }) }), 1)
    assert.equal(main(['--output', '../relative.json'], { collect }), 1)
  } finally { cleanup(f) }
})
