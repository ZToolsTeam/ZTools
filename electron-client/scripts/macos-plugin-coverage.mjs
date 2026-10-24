import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  MAC_COMPLETE_CASE_CHECKS, MAC_EXPECTED_FORMAL_PLUGIN_COUNT, MAC_PLUGIN_SAMPLE_ID, MAC_RELEASE_PLUGIN_IDS,
  loadMacPluginCatalog, parseMacPluginGroups
} from './macos-release-evidence.mjs'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const failure = () => new Error('INVALID_PLUGIN_COVERAGE_INPUT')
const ordinary = (file, limit = 512 * 1024) => {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw failure()
  const bytes = fs.readFileSync(file)
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

export function parsePluginCoverageGroups(document, pluginIds = MAC_RELEASE_PLUGIN_IDS) {
  try { return parseMacPluginGroups(document, pluginIds) } catch { throw failure() }
}

function availableTests(directory, base, records = [], depth = 0) {
  if (depth > 8) throw failure()
  if (!fs.existsSync(directory)) return records
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure()
  for (const name of fs.readdirSync(directory).sort()) {
    if (!name || name === '.' || name === '..' || /[\/\\\0]/.test(name)) throw failure()
    const file = path.join(directory, name), item = fs.lstatSync(file)
    if (item.isSymbolicLink()) throw failure()
    if (item.isDirectory()) availableTests(file, base, records, depth + 1)
    else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) {
      if (records.length >= 256) throw failure()
      records.push({ file: path.relative(base, file).split(path.sep).join('/'), sha256: ordinary(file).sha256,
        execution: 'NOT_RUN_BY_THIS_COLLECTOR' })
    }
  }
  return records
}

function sourcePath(file) {
  return path.relative(workspace, file).split(path.sep).join('/')
}

/** Inventory only: source, manifest and target declarations never imply execution, implementation or public support. */
export function collectPluginCoverage({ sourceRoot, reactSourceRoot, architectureDocument } = {}) {
  let catalog
  try { catalog = loadMacPluginCatalog({ sourceRoot, reactSourceRoot, architectureDocument }) } catch { throw failure() }
  const plugins = catalog.plugins.map(entry => {
    const { pluginId, group, prerequisites, manifest, targets } = entry
    const macTargets = targets.filter(target => target.platform === 'macos' && target.runtime === 'electron')
    const requiredCases = ['M13', 'M03', 'M11']
    if (prerequisites.includes('T07')) requiredCases.push('M04')
    if (prerequisites.some(id => ['T09', 'T10', 'T15'].includes(id))) requiredCases.push('M07')
    if (prerequisites.includes('T12')) requiredCases.push('M09')
    if (prerequisites.includes('T21')) requiredCases.push('M10')
    if (prerequisites.includes('T26')) requiredCases.push('M12')
    if (['G04', 'G07', 'G09', 'G10', 'G11', 'G12'].includes(group)) requiredCases.push('M15')
    const description = typeof manifest.description === 'string' ? manifest.description.trim() : ''
    const name = typeof manifest.name === 'string' ? manifest.name.trim() : pluginId
    return {
      pluginId, group, prerequisites,
      feature: { name: name || pluginId, description },
      source: { state: 'present', layout: entry.layout, manifest: sourcePath(entry.manifestPath), sha256: entry.manifestSha256 },
      formalWiring: { state: 'manifest-present-install-unverified', evidence: 'plugin.json matches the source directory; install/package path was not executed by this collector' },
      targetDeclaration: { state: macTargets.length ? 'implemented-unverified' : 'missing-implementation',
        targets: targets.map(target => ({ id: target.id, platform: target.platform, runtime: target.runtime, arch: target.arch })) },
      implementation: { state: 'missing-implementation', reason: 'Complete Mac business/provider/consumer closure is pending; manifest presence alone is insufficient' },
      availableUnitTests: availableTests(path.join(entry.directory, '__tests__'), entry.directory),
      windowsExecution: { state: 'NOT_RUN_BY_THIS_COLLECTOR', note: 'Historical Windows evidence is not refreshed by this inventory' },
      macExecution: { state: 'NOT_RUN', note: 'F01 is a static inventory; Mac execution remains independently unverified' },
      requiredCases: requiredCases.map(caseId => ({ caseId, checks: MAC_COMPLETE_CASE_CHECKS[caseId] })),
      businessCases: ['success', 'error', 'cancel', 'restart'].map(scenario => ({ caseId: `M13:${pluginId}:${scenario}`,
        scenario, implementation: 'PENDING', phase1Execution: 'NOT_RUN_BY_THIS_COLLECTOR', phase2Execution: 'NOT_RUN' })),
      publicSupport: { status: 'pending', reason: '首发范围尚未批准；目标声明、测试文件及静态源码不构成公开支持证据' }
    }
  })
  const samples = catalog.samples.map(entry => ({ pluginId: entry.pluginId, layout: entry.layout,
    manifest: sourcePath(entry.manifestPath), manifestSha256: entry.manifestSha256,
    classification: 'sample-excluded-from-formal-plugin-count-and-public-support' }))
  return { schemaVersion: 2, runId: randomUUID(), phase: 1, scope: 'plugin-source-and-case-coverage-inventory', status: 'PASS',
    pluginBaselineSha256: catalog.baselineSha256, groupSourceSha256: catalog.groupSourceSha256,
    formalPluginCount: plugins.length, sampleCount: samples.length, sampleIds: catalog.sampleIds,
    sourceCount: plugins.filter(item => item.source.state === 'present').length,
    macTargetDeclarationCount: plugins.filter(item => item.targetDeclaration.state === 'implemented-unverified').length,
    phase1Complete: false, releaseAcceptance: false,
    note: 'PASS validates the 59-plugin manifest/group inventory only. Unit-test files and target declarations are not execution evidence; Mac implementation and public support remain pending.',
    plugins, samples }
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('npm run test:mac:coverage -- --output <fresh absolute JSON path> (59-plugin manifest/group inventory only; does not run plugin business tests)')
    return 0
  }
  if (argv.length !== 2 || argv[0] !== '--output' || !path.isAbsolute(argv[1])) { console.error('ABSOLUTE_FRESH_COVERAGE_OUTPUT_REQUIRED'); return 1 }
  try {
    const report = (dependencies.collect ?? collectPluginCoverage)()
    if (report.plugins.length !== MAC_EXPECTED_FORMAL_PLUGIN_COUNT || report.plugins.length !== MAC_RELEASE_PLUGIN_IDS.length ||
        report.samples.length !== 1 || report.samples[0].pluginId !== MAC_PLUGIN_SAMPLE_ID ||
        report.phase1Complete !== false || report.releaseAcceptance !== false) throw failure()
    fs.writeFileSync(argv[1], JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    console.log(JSON.stringify({ status: report.status, scope: report.scope, runId: report.runId, reportPath: argv[1],
      pluginCount: report.formalPluginCount, sampleCount: report.sampleCount, sourceCount: report.sourceCount,
      macTargetDeclarationCount: report.macTargetDeclarationCount, pluginBaselineSha256: report.pluginBaselineSha256,
      phase1Complete: false, releaseAcceptance: false }))
    return 0
  } catch { console.error('PLUGIN_COVERAGE_COLLECTION_FAILED'); return 1 }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main()
