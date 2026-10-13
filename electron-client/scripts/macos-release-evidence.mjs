import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_SOURCE_ROOT = path.join(workspace, 'plugins/create-plugin/src/plugins')
const DEFAULT_REACT_SOURCE_ROOT = path.join(workspace, 'plugins/create-plugin/src/plugins-react')
const LEGACY_ARCHITECTURE_DOCUMENT = path.join(workspace, 'docs/archive/legacy_mac_docs/Windows与macOS跨平台架构及开发清单.md')
const PRIMARY_ARCHITECTURE_DOCUMENT = path.join(workspace, 'docs/Windows与macOS跨平台架构及开发清单.md')
const DEFAULT_ARCHITECTURE_DOCUMENT = fs.existsSync(PRIMARY_ARCHITECTURE_DOCUMENT)
  ? PRIMARY_ARCHITECTURE_DOCUMENT
  : (fs.existsSync(LEGACY_ARCHITECTURE_DOCUMENT) ? LEGACY_ARCHITECTURE_DOCUMENT : path.join(workspace, 'docs/macOS跨平台架构重构与落地清单.md'))
export const MAC_PLUGIN_SAMPLE_ID = 'batch-pilot-sample'
export const MAC_EXPECTED_FORMAL_PLUGIN_COUNT = 59
const pluginIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const groupIds = Object.freeze(Array.from({ length: 12 }, (_, index) => `G${String(index + 1).padStart(2, '0')}`))
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const failure = () => new Error('INVALID_MAC_PLUGIN_CATALOG')

export const MAC_COMPLETE_CASE_CHECKS = Object.freeze({
  M01: ['runtime-target', 'process-slice', 'os-policy', 'sdk-error-contract'],
  M02: ['normal-restart', 'open-events', 'dock-menu-login', 'active-task-exit', 'descendant-cleanup', 'crash-recovery', 'state-persistence'],
  M03: ['caller-identity', 'cross-plugin-denial', 'parameter-validation', 'timeout-cancel', 'renderer-isolation', 'destroyed-caller'],
  M04: ['unicode-case', 'link-race', 'exdev', 'readonly-write', 'grant-revoke', 'save-read-denial', 'no-outside-change'],
  M05: ['permission-initial', 'permission-denied', 'permission-revoke-restore', 'revision-events', 'request-coalescing', 'restart-permission'],
  M06: ['mixed-scale-coordinates', 'negative-coordinates', 'hotplug-space-fullscreen', 'capture-calibration', 'ax-failure-cancel'],
  M07: ['command-physical-control', 'ime-layout', 'shortcut-conflict', 'finder-drop-formats', 'owned-focus-paste', 'input-release'],
  M08: ['app-tool-launch', 'argv-env', 'crash-cancel', 'pid-owner-reuse', 'tcp-udp-v4-v6', 'port-denied', 'lan-share-stop-revoke'],
  M09: ['native-abi-allocation', 'callback-generation', 'signature-source-rejection', 'host-crash-restart', 'native-cancel-unload', 'privilege-no-fallback'],
  M10: ['packaged-classic-level', 'legacy-content-count', 'single-writer-lock', 'migration-interruption', 'keychain-loss-denial', 'no-real-secret'],
  M11: ['normal-install', 'wrong-target-abi-sdk', 'dependency-cycle-missing', 'bad-signature-zip-link', 'execution-mode', 'interrupted-keep-old', 'universal-checksum'],
  M12: ['codec-backend-license', 'device-permission-change', 'audio-video-sync', 'task-cancel-exit', 'ocr-privacy-tls'],
  M13: ['business-result', 'caller-isolation', 'cleanup'],
  M14: ['final-signed-universal', 'download-quarantine-gatekeeper', 'install-upgrade', 'update-validation-failure', 'interrupted-rollback', 'data-compatibility'],
  M15: ['synthetic-only', 'owned-resource-proof', 'fault-recovery', 'no-outside-change']
})

function readOrdinaryFile(file, limit = 2 * 1024 * 1024) {
  const stats = fs.lstatSync(file)
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > limit) throw failure()
  const bytes = fs.readFileSync(file)
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function inspectTargets(manifest) {
  const targets = manifest.targets ?? []
  if (!Array.isArray(targets) || targets.length > 64 || targets.some(target => !target || typeof target !== 'object' || Array.isArray(target) ||
      typeof target.id !== 'string' || typeof target.platform !== 'string' || typeof target.runtime !== 'string' || typeof target.arch !== 'string')) throw failure()
  return targets
}

function discoverPluginManifests(sourceRoot, reactSourceRoot) {
  const roots = [
    { root: sourceRoot, layout: 'plugins', allowedDirectories: new Set(['shared']) },
    { root: reactSourceRoot, layout: 'plugins-react', allowedDirectories: new Set() }
  ]
  const manifests = []
  for (const entry of roots) {
    const root = fs.lstatSync(entry.root)
    if (!root.isDirectory() || root.isSymbolicLink()) throw failure()
    for (const name of fs.readdirSync(entry.root).sort()) {
      const directory = path.join(entry.root, name), stat = fs.lstatSync(directory)
      if (stat.isSymbolicLink()) throw failure()
      if (!stat.isDirectory()) continue
      if (entry.allowedDirectories.has(name)) continue
      if (!pluginIdPattern.test(name)) throw failure()
      const manifestPath = path.join(directory, 'plugin.json')
      const content = readOrdinaryFile(manifestPath, 512 * 1024)
      let manifest
      try { manifest = JSON.parse(content.bytes.toString('utf8')) } catch { throw failure() }
      if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.id !== name || typeof manifest.version !== 'string' || !manifest.version.trim()) throw failure()
      const targets = inspectTargets(manifest)
      manifests.push({ pluginId: name, layout: entry.layout, directory, manifestPath, manifest, targets, manifestSha256: content.sha256 })
    }
  }
  const ids = new Set()
  for (const item of manifests) {
    if (ids.has(item.pluginId)) throw failure()
    ids.add(item.pluginId)
  }
  return manifests.sort((left, right) => left.pluginId < right.pluginId ? -1 : left.pluginId > right.pluginId ? 1 : 0)
}

function extractPluginGroupSource(document) {
  const sectionStart = document.indexOf('## 8. 插件工作包')
  if (sectionStart < 0) return document
  const nextSection = document.indexOf('\n## ', sectionStart + 1)
  return document.slice(sectionStart, nextSection < 0 ? document.length : nextSection)
}

export function parseMacPluginGroups(document, pluginIds) {
  if (typeof document !== 'string' || !Array.isArray(pluginIds) || pluginIds.length > 512 ||
      pluginIds.some(id => typeof id !== 'string' || !pluginIdPattern.test(id)) || new Set(pluginIds).size !== pluginIds.length) throw failure()
  const expected = new Set(pluginIds), assignments = new Map(), seenGroups = new Set()
  for (const line of extractPluginGroupSource(document).split(/\r?\n/)) {
    const cells = line.split('|').map(cell => cell.trim())
    const label = cells[1] ?? ''
    if (!label.startsWith('G')) continue
    if (!/^G(?:0[1-9]|1[0-2])$/.test(label) || cells.length !== 7 || seenGroups.has(label)) throw failure()
    seenGroups.add(label)
    const ids = cells[2].split(',').map(id => id.trim())
    if (!ids.length || ids.some(id => !id || !expected.has(id))) throw failure()
    for (const pluginId of ids) {
      if (assignments.has(pluginId)) throw failure()
      assignments.set(pluginId, { group: label, prerequisites: [...new Set(cells[4].match(/T\d{2}/g) ?? [])] })
    }
  }
  if (seenGroups.size !== groupIds.length || groupIds.some(id => !seenGroups.has(id)) || assignments.size !== expected.size ||
      pluginIds.some(id => !assignments.has(id))) throw failure()
  return assignments
}

function publicPluginBaseline(catalog) {
  return {
    schemaVersion: 1,
    sha256: catalog.baselineSha256,
    formalPluginCount: catalog.plugins.length,
    formalPluginIds: catalog.pluginIds,
    samplePluginIds: catalog.sampleIds,
    groupSourceSha256: catalog.groupSourceSha256
  }
}

export function loadMacPluginCatalog({ sourceRoot = DEFAULT_SOURCE_ROOT, reactSourceRoot = DEFAULT_REACT_SOURCE_ROOT,
  architectureDocument = DEFAULT_ARCHITECTURE_DOCUMENT } = {}) {
  if (![sourceRoot, reactSourceRoot, architectureDocument].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
      path.resolve(sourceRoot) === path.resolve(reactSourceRoot)) throw failure()
  const manifests = discoverPluginManifests(path.resolve(sourceRoot), path.resolve(reactSourceRoot))
  const formalPlugins = manifests.filter(item => item.pluginId !== MAC_PLUGIN_SAMPLE_ID)
  const samplePlugins = manifests.filter(item => item.pluginId === MAC_PLUGIN_SAMPLE_ID)
  if (formalPlugins.length !== MAC_EXPECTED_FORMAL_PLUGIN_COUNT || samplePlugins.length !== 1 || samplePlugins[0]?.layout !== 'plugins') throw failure()
  const document = readOrdinaryFile(path.resolve(architectureDocument))
  const documentText = document.bytes.toString('utf8')
  const pluginIds = formalPlugins.map(item => item.pluginId)
  const assignments = parseMacPluginGroups(documentText, pluginIds)
  const plugins = formalPlugins.map(item => ({ ...item, ...assignments.get(item.pluginId) }))
  const groupSourceSha256 = createHash('sha256').update(JSON.stringify(plugins.map(item => ({ pluginId: item.pluginId,
    group: item.group, prerequisites: item.prerequisites })))).digest('hex')
  const sampleIds = samplePlugins.map(item => item.pluginId)
  const baseline = {
    schemaVersion: 1,
    groupSourceSha256,
    plugins: plugins.map(item => ({ pluginId: item.pluginId, layout: item.layout, manifestSha256: item.manifestSha256,
      group: item.group, prerequisites: item.prerequisites })),
    samples: samplePlugins.map(item => ({ pluginId: item.pluginId, layout: item.layout, manifestSha256: item.manifestSha256 }))
  }
  return {
    plugins,
    samples: samplePlugins,
    pluginIds,
    sampleIds,
    architectureDocument: path.resolve(architectureDocument),
    groupSourceSha256,
    baselineSha256: createHash('sha256').update(JSON.stringify(baseline)).digest('hex')
  }
}

const initialCatalog = loadMacPluginCatalog()
export const MAC_RELEASE_PLUGIN_IDS = Object.freeze([...initialCatalog.pluginIds])

export function macReleaseEvidenceTemplate({ catalog = loadMacPluginCatalog() } = {}) {
  return { schemaVersion: 1, phase: 2, scope: 'release-acceptance-index', pluginBaseline: publicPluginBaseline(catalog), reports: [],
    plugins: catalog.pluginIds.map(pluginId => ({ pluginId, policy: 'pending', features: [], reason: 'Await approved scope and complete-case evidence' })),
    reportContract: { schemaVersion: 1, phase: 2, scope: 'complete-case', runId: '<UUID>',
      pluginBaselineSha256: catalog.baselineSha256,
      caseId: '<M01..M15>', feature: '<M13 approved feature only; omit for non-plugin/reject cases>', scenario: '<plugin success|error|cancel|restart|reject, otherwise baseline>',
      bundleId: '<actual Bundle ID>', appVersion: '<logical app version>', codeDirectoryHash: '<actual tested slice CDHash>',
      runner: { platform: 'darwin', arch: '<physical OS x64|arm64>' }, testedProcess: { arch: '<x64|arm64>', translationMode: 'native' },
      startedAt: '<ISO8601>', finishedAt: '<ISO8601>', status: 'MANUAL_PENDING', cleanup: { status: 'MANUAL_PENDING' },
      checks: [{ id: '<required step ID>', expected: '<expected outcome>', actual: '<observed outcome>', status: 'MANUAL_PENDING' }] },
    requiredChecks: MAC_COMPLETE_CASE_CHECKS,
    note: 'Template is not execution evidence. Baseline/phase1/translated-only reports cannot pass this gate.' }
}

function readJson(file) {
  const { bytes } = readOrdinaryFile(file)
  return JSON.parse(bytes.toString('utf8'))
}

function matchesCurrentBaseline(value, catalog) {
  const current = publicPluginBaseline(catalog)
  return value && value.schemaVersion === current.schemaVersion && value.sha256 === current.sha256 &&
    value.formalPluginCount === current.formalPluginCount &&
    value.groupSourceSha256 === current.groupSourceSha256 &&
    Array.isArray(value.formalPluginIds) && JSON.stringify(value.formalPluginIds) === JSON.stringify(current.formalPluginIds) &&
    Array.isArray(value.samplePluginIds) && JSON.stringify(value.samplePluginIds) === JSON.stringify(current.samplePluginIds)
}

export function auditMacReleaseEvidence(indexPath, bundle, { catalog = loadMacPluginCatalog() } = {}) {
  if (!indexPath) return { status: 'MANUAL_PENDING', code: 'RELEASE_EVIDENCE_REQUIRED' }
  if (!path.isAbsolute(indexPath)) throw new Error('ABSOLUTE_RELEASE_EVIDENCE_REQUIRED')
  const index = readJson(indexPath), root = fs.realpathSync(path.dirname(indexPath))
  if (index.schemaVersion !== 1 || index.phase !== 2 || index.scope !== 'release-acceptance-index' ||
      !matchesCurrentBaseline(index.pluginBaseline, catalog) || !Array.isArray(index.reports) || index.reports.length > 1024 ||
      !Array.isArray(index.plugins) || index.plugins.length !== catalog.pluginIds.length) {
    throw new Error('INVALID_RELEASE_EVIDENCE_INDEX')
  }
  const expectedPluginIds = new Set(catalog.pluginIds), policies = new Map()
  for (const item of index.plugins) {
    if (!expectedPluginIds.has(item.pluginId) || policies.has(item.pluginId) ||
        !['supported', 'partial', 'windows-only', 'unsupported', 'pending'].includes(item.policy) ||
        typeof item.reason !== 'string' || item.reason.trim().length === 0 || item.reason.length > 2048) throw new Error('INVALID_PLUGIN_RELEASE_POLICY')
    if (!Array.isArray(item.features) || item.features.length > 64 || new Set(item.features).size !== item.features.length ||
        item.features.some(feature => typeof feature !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(feature)) ||
        (['supported', 'partial'].includes(item.policy) && item.features.length === 0) ||
        (!['supported', 'partial'].includes(item.policy) && item.features.length !== 0)) throw new Error('INVALID_PLUGIN_FEATURE_SCOPE')
    policies.set(item.pluginId, item)
  }
  if (policies.size !== expectedPluginIds.size || catalog.pluginIds.some(id => !policies.has(id))) throw new Error('INVALID_RELEASE_EVIDENCE_INDEX')
  const records = new Map(), seenPaths = new Set(), seenRuns = new Set()
  for (const name of index.reports) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+\.json$/.test(name) || seenPaths.has(name)) throw new Error('INVALID_RELEASE_REPORT_PATH')
    seenPaths.add(name)
    const report = readJson(path.join(root, name)), arch = report.testedProcess?.arch
    if (report.schemaVersion !== 1 || report.phase !== 2 || report.scope !== 'complete-case' || !uuid.test(report.runId) || seenRuns.has(report.runId) ||
        report.pluginBaselineSha256 !== catalog.baselineSha256) throw new Error('STALE_RELEASE_REPORT_BASELINE')
    if (!/^M(?:0[1-9]|1[0-5])$/.test(report.caseId) || !['x64', 'arm64'].includes(arch) ||
        report.runner?.platform !== 'darwin' || report.runner?.arch !== arch || report.testedProcess.translationMode !== 'native' ||
        report.bundleId !== bundle.bundleId || report.appVersion !== bundle.appVersion || report.codeDirectoryHash !== bundle.codeDirectoryHashes[arch]) {
      throw new Error('RELEASE_REPORT_BINDING_MISMATCH')
    }
    seenRuns.add(report.runId)
    const start = Date.parse(report.startedAt), end = Date.parse(report.finishedAt)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > Date.now() + 60_000 ||
        !['PASS', 'FAIL', 'MANUAL_PENDING', 'NOT_RUN'].includes(report.status) ||
        !['PASS', 'FAIL', 'MANUAL_PENDING'].includes(report.cleanup?.status) ||
        !Array.isArray(report.checks) || report.checks.length < 1 || report.checks.length > 256) throw new Error('INVALID_RELEASE_REPORT_RESULT')
    const checkIds = new Set()
    for (const check of report.checks) {
      if (typeof check.id !== 'string' || !check.id || checkIds.has(check.id) ||
          typeof check.expected !== 'string' || !check.expected.trim() || typeof check.actual !== 'string' || !check.actual.trim() ||
          !['PASS', 'FAIL', 'MANUAL_PENDING'].includes(check.status)) throw new Error('INVALID_RELEASE_CHECK')
      checkIds.add(check.id)
    }
    if (MAC_COMPLETE_CASE_CHECKS[report.caseId].some(id => !checkIds.has(id))) throw new Error('INCOMPLETE_RELEASE_CASE_CHECKS')
    if (report.caseId === 'M13' && (!catalog.pluginIds.includes(report.pluginId) || !['success', 'error', 'cancel', 'restart', 'reject'].includes(report.scenario))) {
      throw new Error('INVALID_PLUGIN_RELEASE_REPORT')
    }
    if (report.caseId === 'M13') {
      const policy = policies.get(report.pluginId)
      if (['supported', 'partial'].includes(policy.policy) ? !policy.features.includes(report.feature) : report.feature !== undefined || report.scenario !== 'reject') throw new Error('PLUGIN_REPORT_OUTSIDE_APPROVED_SCOPE')
    }
    const key = [arch, report.caseId, report.pluginId ?? '', report.feature ?? '', report.caseId === 'M13' ? report.scenario : ''].join(':')
    if (records.has(key)) throw new Error('DUPLICATE_RELEASE_REPORT')
    records.set(key, report)
  }
  const pending = [], failed = []
  const requireRecord = (arch, caseId, pluginId = '', feature = '', scenario = '') => {
    const key = [arch, caseId, pluginId, feature, scenario].join(':'), report = records.get(key)
    if (report && (report.status === 'FAIL' || report.cleanup.status === 'FAIL' || report.checks.some(check => check.status === 'FAIL'))) failed.push(key)
    else if (!report || report.status !== 'PASS' || report.cleanup.status !== 'PASS' || report.checks.some(check => check.status !== 'PASS')) pending.push(key)
  }
  for (const arch of ['arm64', 'x64']) {
    for (let id = 1; id <= 15; id += 1) if (id !== 13) requireRecord(arch, `M${String(id).padStart(2, '0')}`)
    for (const pluginId of catalog.pluginIds) {
      const policy = policies.get(pluginId)
      if (policy.policy === 'pending') { pending.push(`${arch}:M13:${pluginId}:policy`); continue }
      for (const feature of ['supported', 'partial'].includes(policy.policy) ? policy.features : ['']) {
        for (const scenario of ['supported', 'partial'].includes(policy.policy) ? ['success', 'error', 'cancel', 'restart'] : ['reject']) requireRecord(arch, 'M13', pluginId, feature, scenario)
      }
    }
  }
  return { status: failed.length ? 'FAIL' : pending.length ? 'MANUAL_PENDING' : 'PASS',
    scope: 'complete-case-evidence-audit', acceptedReports: records.size, pending, failed }
}
