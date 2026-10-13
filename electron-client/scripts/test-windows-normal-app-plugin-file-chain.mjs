import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'
import { WindowsNormalAppHarness, startLoopbackZipServer as startHarnessLoopbackZipServer } from './lib/windows-normal-app-harness.mjs'
import { publicPluginUpdateFailureExpression } from './lib/normal-app-plugin-install.mjs'
import {
  NORMAL_APP_CDP_PORT,
  NORMAL_APP_INSPECT_PORT,
  buildDialogOverrideExpression,
  buildDialogRestoreExpression,
  buildDialogStateExpression,
  digest,
  isWithin,
  makeSyntheticTextFixture,
  normalizeWindowsPath,
  validateFreshPluginZip,
} from './windows-normal-app-plugin-file-chain-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(root, '..')
const pluginRoot = path.join(repositoryRoot, 'plugins', 'create-plugin')
const runnerPath = fileURLToPath(import.meta.url)
const expectedOutputName = makeSyntheticTextFixture().outputFileName
const currentOwnedSessions = new Set()

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function safeErrorCode(error) {
  const value = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : ''
  return /^[A-Z0-9_]{1,96}$/.test(value) ? value : 'NORMAL_APP_FILE_CHAIN_UNCLASSIFIED_FAILURE'
}

function readVersionMetadata() {
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const protocolSource = fs.readFileSync(path.join(root, 'src', 'contracts', 'protocol-versions.ts'), 'utf8')
  const sdkMatch = protocolSource.match(/SDK_CONTRACT\s*=\s*(\d+)/)
  const electronPackage = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'))
  const appName = typeof packageInfo.productName === 'string' ? packageInfo.productName : packageInfo.name
  if (typeof appName !== 'string' || !/^[0-9A-Za-z ._-]{1,128}$/.test(appName) ||
      typeof packageInfo.version !== 'string' || !/^[0-9A-Za-z.-]{1,128}$/.test(packageInfo.version) ||
      !sdkMatch || typeof electronPackage.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(electronPackage.version) ||
      electronPackage.version !== '43.4.1') throw new Error('RUNTIME_VERSION_METADATA_INVALID')
  return { appName, appVersion: packageInfo.version, electronVersion: electronPackage.version, sdkContractVersion: Number(sdkMatch[1]) }
}

function assertRegularFile(file, code) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code)
  return stat
}

async function requirePortsAvailable(ports) {
  for (const port of ports) {
    const server = net.createServer()
    await new Promise((resolve, reject) => {
      const fail = error => reject(error.code === 'EADDRINUSE' ? new Error(`CDP_PORT_CONFLICT_${port}`) : error)
      server.once('error', fail)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', fail)
        server.close(error => error ? reject(error) : resolve())
      })
    })
  }
}

async function waitForCondition(read, accept, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (accept(last)) return last
    await delay(150)
  }
  throw new Error(code)
}

async function startLoopbackZipServer(zipInfo, runId, routeName = 'batch-text-convert.zip') {
  return await startHarnessLoopbackZipServer(zipInfo, routeName, runId)
}

function readJsonRegular(file, code) {
  assertRegularFile(file, code)
  const real = fs.realpathSync.native(file)
  if (normalizeWindowsPath(real) !== normalizeWindowsPath(file)) throw new Error(`${code}_REALPATH_MISMATCH`)
  return JSON.parse(fs.readFileSync(real, 'utf8'))
}

export function validateSdk2UpdateFixture(zipInfo, baseZipInfo, expectedBaseVersion) {
  const buildRunRoot = path.dirname(path.dirname(zipInfo.path))
  const reportPath = path.join(buildRunRoot, 'build-report.json')
  const report = readJsonRegular(reportPath, 'SDK2_UPDATE_BUILD_REPORT_INVALID')
  const sourceManifestPath = path.join(pluginRoot, 'src', 'plugins', 'batch-text-convert', 'plugin.json')
  const output = report?.output
  const manifest = output?.manifest
  if (report.status !== 'BUILT_ISOLATED' || report.scope !== 'f06-negative-sdk2-upgrade-test-fixture-not-product-release' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(report.runId ?? '') ||
      report.runId !== zipInfo.buildRun || output.buildRun !== zipInfo.buildRun ||
      normalizeWindowsPath(output.zipPath ?? '') !== normalizeWindowsPath(zipInfo.path) ||
      output.sha256 !== zipInfo.checksum || output.fileSize !== zipInfo.fileSize ||
      report.base?.sha256 !== baseZipInfo.checksum || report.base?.fileSize !== baseZipInfo.fileSize ||
      normalizeWindowsPath(report.base?.zipPath ?? '') !== normalizeWindowsPath(baseZipInfo.path) ||
      report.base?.version !== expectedBaseVersion || report.sourceManifest?.version !== expectedBaseVersion ||
      normalizeWindowsPath(report.sourceManifest?.path ?? '') !== normalizeWindowsPath(sourceManifestPath) ||
      report.sourceManifest?.sha256Before !== report.sourceManifest?.sha256After ||
      digest(fs.readFileSync(sourceManifestPath)) !== report.sourceManifest?.sha256Before ||
      !manifest || manifest.id !== 'batch-text-convert' || manifest.version !== output.version ||
      manifest.targetId !== 'windows-electron-x64' || manifest.minSdkContractVersion !== 2 ||
      output.version === expectedBaseVersion ||
      JSON.stringify([...(output.changedManifestFields ?? [])].sort()) !==
        JSON.stringify(['targets[0].minSdkContractVersion', 'version']) ||
      JSON.stringify([...(output.changedFiles ?? [])].sort()) !== JSON.stringify(['plugin.json']) ||
      !Array.isArray(output.unchangedFiles) || output.unchangedFileCount !== output.unchangedFiles.length ||
      !output.fileHashes || typeof output.fileHashes !== 'object' || !output.hashDiff || typeof output.hashDiff !== 'object') {
    throw new Error('SDK2_UPDATE_BUILD_PROVENANCE_MISMATCH')
  }
  const expectedFiles = [...output.changedFiles, ...output.unchangedFiles].sort()
  if (JSON.stringify(Object.keys(output.fileHashes).sort()) !== JSON.stringify(expectedFiles) ||
      JSON.stringify(Object.keys(output.hashDiff).sort()) !== JSON.stringify(expectedFiles)) {
    throw new Error('SDK2_UPDATE_FILE_HASH_INVENTORY_MISMATCH')
  }
  for (const name of output.unchangedFiles) {
    const diff = output.hashDiff[name]
    if (!/^[a-f0-9]{64}$/i.test(output.fileHashes[name] ?? '') || diff?.changed !== false ||
        diff.base !== diff.fixture || diff.fixture !== output.fileHashes[name]) throw new Error('SDK2_UPDATE_UNCHANGED_FILE_HASH_MISMATCH')
  }
  const manifestDiff = output.hashDiff['plugin.json']
  if (!/^[a-f0-9]{64}$/i.test(output.fileHashes['plugin.json'] ?? '') || manifestDiff?.changed !== true ||
      manifestDiff.base !== report.base.manifestSha256 || manifestDiff.fixture !== output.fileHashes['plugin.json']) {
    throw new Error('SDK2_UPDATE_MANIFEST_HASH_MISMATCH')
  }
  const baseBuildReport = readJsonRegular(report.base.buildReportPath, 'SDK2_UPDATE_BASE_BUILD_REPORT_INVALID')
  if (digest(fs.readFileSync(report.base.buildReportPath)) !== report.base.buildReportSha256 ||
      digest(fs.readFileSync(report.builder?.path ?? '')) !== report.builder?.sha256Before ||
      report.builder?.sha256Before !== report.builder?.sha256After ||
      baseBuildReport.status !== 'PASS' || report.base.buildRun !== baseZipInfo.buildRun) {
    throw new Error('SDK2_UPDATE_BUILD_REPORT_CHAIN_MISMATCH')
  }
  return { path: reportPath, sha256: digest(fs.readFileSync(reportPath)), buildRun: report.runId,
    status: report.status, scope: report.scope, base: report.base, sourceManifest: report.sourceManifest,
    output: { ...output, buildReportSha256: digest(fs.readFileSync(reportPath)) } }
}

function parsePort(value, fallback, name) {
  if (value === undefined) return fallback
  if (!/^\d{1,5}$/.test(value)) throw new Error(`${name}_INVALID`)
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error(`${name}_INVALID`)
  return port
}

function mainRequireExpression(body) {
  return `(() => { const mainModule = process.mainModule; if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE'); const requireMain = mainModule.require.bind(mainModule); ${body} })()`
}

async function clickVisible(page, selector) {
  const box = await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled || element.getAttribute('aria-disabled') === 'true') return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
      width: rect.width, height: rect.height, selector: ${JSON.stringify(selector)} };
  })()`)
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) throw new Error('VISIBLE_UI_TARGET_NOT_FOUND')
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  return box
}

function createProfileDirectories(profileRoot, { corruptJournal = false } = {}) {
  const profile = {
    root: profileRoot,
    appDataPath: path.join(profileRoot, 'appData'),
    userDataPath: path.join(profileRoot, 'userData'),
    sessionDataPath: path.join(profileRoot, 'sessionData'),
    tempPath: path.join(profileRoot, 'tmp')
  }
  for (const key of ['root', 'appDataPath', 'userDataPath', 'sessionDataPath', 'tempPath']) fs.mkdirSync(profile[key], { recursive: false })
  if (corruptJournal) {
    const journalPath = path.join(profile.appDataPath, 'ZTools', 'Data', 'FileWriteJournal', 'file-write-journal.bin')
    fs.mkdirSync(path.dirname(journalPath), { recursive: true })
    fs.writeFileSync(journalPath, Buffer.from('ZPJ1.synthetic-corrupt-ledger\0F04', 'utf8'), { flag: 'wx' })
    profile.corruptJournalPath = journalPath
  }
  return profile
}

function runPowerShellJson(command, timeoutMs = 10_000) {
  const windowsDirectory = process.env.WINDIR ?? 'C:\\Windows'
  const executable = path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    shell: false, windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024
  })
  if (result.error || result.status !== 0) throw new Error('OWNED_PROCESS_QUERY_FAILED')
  const value = result.stdout.trim()
  if (!value) return []
  const parsed = JSON.parse(value)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function getDirectChildProcesses(parentPid) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error('OWNED_PARENT_PID_INVALID')
  const command = `$parent = ${parentPid}; $rows = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" | Select-Object @{Name='pid';Expression={[int]$_.ProcessId}}, @{Name='parentPid';Expression={[int]$_.ParentProcessId}}, @{Name='name';Expression={$_.Name}}, @{Name='executablePath';Expression={$_.ExecutablePath}}); ConvertTo-Json -InputObject $rows -Compress`
  return runPowerShellJson(command)
}

function isProcessAlive(pid) {
  const command = `$target = ${pid}; $row = Get-CimInstance Win32_Process -Filter "ProcessId=$target" | Select-Object -First 1; if ($null -eq $row) { '[]' } else { ConvertTo-Json -InputObject @(@{ pid=[int]$row.ProcessId }) -Compress }`
  try { return runPowerShellJson(command).length > 0 }
  catch {
    const result = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      shell: false, windowsHide: true, timeout: 5000, encoding: 'utf8', maxBuffer: 64 * 1024
    })
    if (result.error || result.status !== 0) throw new Error('OWNED_PROCESS_LIVENESS_QUERY_FAILED')
    return result.stdout.split(/\r?\n/).some(line => {
      const fields = line.match(/^"([^"]*)","(\d+)"/)
      return fields?.[2] === String(pid)
    })
  }
}

async function stopOwnedApp(session) {
  if (!session) return { stopped: true, ownedPid: null, exit: null, cleanupConfirmed: true }
  if (!session.harness) throw new Error('NORMAL_APP_HARNESS_SESSION_REQUIRED')
  try { await session.inspector?.evaluate(buildDialogRestoreExpression(), { timeoutMs: 3000 }) }
  catch { /* F06 only installs a bounded one-shot Main dialog substitute. */ }
  return await session.harness.stop(session)
}
async function collectOwnedBrokerEvidence(parentPid, expectedBrokerPath) {
  let children
  try { children = getDirectChildProcesses(parentPid) }
  catch (error) {
    return { queryStatus: 'NOT_RUN', queryFailureCode: safeErrorCode(error), directChildCount: null,
      brokerCount: null, expectedBrokerPath, processes: [] }
  }
  const brokers = children.filter(child => String(child.name ?? '').toLocaleLowerCase('en-US') === 'ztoolspathaccessbroker.exe')
  return {
    queryStatus: 'PASS',
    directChildCount: children.length,
    brokerCount: brokers.length,
    expectedBrokerPath,
    processes: brokers.map(item => ({
      pid: item.pid,
      parentPid: item.parentPid,
      name: item.name,
      executablePath: item.executablePath ?? null,
      exactExpectedPath: typeof item.executablePath === 'string' && normalizeWindowsPath(item.executablePath) === normalizeWindowsPath(expectedBrokerPath)
    }))
  }
}

async function startNormalApp({ executable, appRoot, profile, output, phase, versions, report, ports }) {
  const harness = new WindowsNormalAppHarness({ appRoot, executable, outputRoot: output, versions, ports })
  const session = await harness.start({ profile, phase, report, requireReferenceRuntime: true })
  session.harness = harness
  const runtimeBrokerPath = path.join(appRoot, 'out', 'native', 'win32-x64', 'bin', 'ZToolsPathAccessBroker.exe')
  session.runtimeBrokerPath = runtimeBrokerPath
  session.brokerEvidence = await collectOwnedBrokerEvidence(session.child.pid, runtimeBrokerPath)
  return { ...session, runtimeLogPath: session.runtimeLogPath, runtimeLog: session.runtimeLog,
    referenceRuntime: session.referenceRuntime, brokerEvidence: session.brokerEvidence, runtimeBrokerPath }
}

async function openAndConnectPlugin(session, versions, { inspectFresh = false } = {}) {
  if (!session?.harness) throw new Error('NORMAL_APP_HARNESS_SESSION_REQUIRED')
  const opened = await session.harness.open(session, 'batch-text-convert')
  const inputFiles = await opened.page.evaluate('document.querySelector("[aria-label=\\"输入文件\\"]")?.innerText ?? ""')
  opened.identity.inputFiles = inputFiles
  if (inspectFresh && inputFiles.includes('已添加') && !inputFiles.includes('已添加 0 个')) throw new Error('PLUGIN_CLOSE_REOPEN_STATE_NOT_RESET')
  return { opened: opened.opened, targetState: { targets: [opened.target] }, target: { id: opened.target.id, url: opened.target.url },
    page: opened.page, identity: opened.identity }
}
async function closePluginViaPublicSdk(session) {
  if (!session?.harness) throw new Error('NORMAL_APP_HARNESS_SESSION_REQUIRED')
  return await session.harness.close(session, 'batch-text-convert')
}
async function installPlugin(session, zipServer, zipInfo, appDataPath, version) {
  if (!session?.harness) throw new Error('NORMAL_APP_HARNESS_SESSION_REQUIRED')
  return await session.harness.install(session, { pluginId: 'batch-text-convert', zipInfo, zipUrl: zipServer.url, version })
}

function snapshotPluginTree(directory) {
  const entries = []
  const visit = relative => {
    const current = relative ? path.join(directory, relative) : directory
    const children = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name
      const absolute = path.join(directory, childRelative)
      if (child.isSymbolicLink()) throw new Error('PLUGIN_TREE_SYMLINK_UNSUPPORTED')
      if (child.isDirectory()) {
        entries.push({ path: childRelative, type: 'directory' })
        visit(childRelative)
      } else if (child.isFile()) {
        const bytes = fs.readFileSync(absolute)
        entries.push({ path: childRelative, type: 'file', byteSize: bytes.length, sha256: digest(bytes) })
      } else throw new Error('PLUGIN_TREE_ENTRY_NOT_REGULAR')
    }
  }
  visit('')
  return { entries, entryCount: entries.length, sha256: digest(Buffer.from(JSON.stringify(entries), 'utf8')) }
}

async function runSdk2UpdateRejection({ session, pluginDirectory, baseVersion, updateZipInfo,
  updateZipServer, report }) {
  const phase = report.phases.sdk2UpdateRejection = { status: 'IN_PROGRESS', expectedErrorCode: 'NOT_SUPPORTED',
    expectedIsUpdate: true, acceptedOperationIdAvailableFromPublicApi: false }
  try {
    const closeBeforeUpdate = await closePluginViaPublicSdk(session)
    phase.pluginCloseBeforeUpdate = closeBeforeUpdate
    const before = snapshotPluginTree(pluginDirectory)
    phase.treeBefore = before
    const requestCountBefore = updateZipServer.requests.length
    const update = await session.browserPage.page.evaluate(publicPluginUpdateFailureExpression({
      pluginId: 'batch-text-convert', downloadUrl: updateZipServer.url, version: updateZipInfo.version,
      checksum: updateZipInfo.checksum, fileSize: updateZipInfo.fileSize,
      expectedErrorCode: 'NOT_SUPPORTED', timeoutMs: 90_000
    }), { timeoutMs: 95_000 })
    phase.publicApiAccepted = update.publicApiAccepted
    phase.terminalOperationId = update.operationId
    phase.operationIdSource = update.operationIdSource
    phase.terminalEvent = update.completion
    if (update.publicApiAccepted !== true || typeof update.operationId !== 'string' || !update.operationId ||
        update.completion?.pluginId !== 'batch-text-convert' || update.completion?.success !== false ||
        update.completion?.isUpdate !== true || update.completion?.errorCode !== 'NOT_SUPPORTED' ||
        'version' in update.completion) throw new Error('SDK2_UPDATE_TERMINAL_EVENT_MISMATCH')
    const requests = updateZipServer.requests.slice(requestCountBefore)
    phase.downloadRequests = requests
    if (requests.length !== 1 || requests[0].method !== 'GET' || requests[0].status !== 200) {
      throw new Error('SDK2_UPDATE_DOWNLOAD_REQUEST_MISMATCH')
    }
    const refreshed = await session.browserPage.page.evaluate('window.ztools.plugin.refresh()')
    phase.pluginRefresh = refreshed
    if (refreshed?.success !== true || !Array.isArray(refreshed.data)) throw new Error('PLUGIN_LIST_REFRESH_FAILED')
    const listed = refreshed.data.find(item => item?.pluginId === 'batch-text-convert' || item?.id === 'batch-text-convert')
    phase.refreshedPlugin = listed ?? null
    if (!listed || listed.version !== baseVersion || listed.available === false) throw new Error('OLD_PLUGIN_REFRESH_NOT_CONFIRMED')
    const after = snapshotPluginTree(pluginDirectory)
    phase.treeAfter = after
    phase.treeUnchanged = before.sha256 === after.sha256 && JSON.stringify(before.entries) === JSON.stringify(after.entries)
    phase.installedManifestVersion = JSON.parse(fs.readFileSync(path.join(pluginDirectory, 'plugin.json'), 'utf8')).version
    if (!phase.treeUnchanged || phase.installedManifestVersion !== baseVersion) throw new Error('OLD_PLUGIN_TREE_NOT_PRESERVED')
    phase.status = 'PASS'
    return { closeBeforeUpdate, update, refreshedPlugin: listed, before, after }
  } catch (error) {
    phase.status = 'FAIL'
    phase.failureCode = safeErrorCode(error)
    if (error?.updateCompletion) phase.terminalEvent = error.updateCompletion
    throw error
  }
}

async function installDialogRecorder(page) {
  await page.evaluate(`(() => {
    if (!window.ztools || window.__normalAppFileChainEvents) throw new Error('PAGE_TEST_RECORDER_STATE_INVALID');
    const events = [];
    document.addEventListener('click', event => {
      const control = event.target instanceof Element ? event.target.closest('[data-batch-action]') : null;
      if (control) events.push({ action: control.getAttribute('data-batch-action'), isTrusted: event.isTrusted, at: Date.now() });
    }, true);
    window.__normalAppFileChainEvents = events;
    return true;
  })()`)
}

async function collectBatchPageState(page) {
  return await page.evaluate(`(() => {
    const text = selector => document.querySelector(selector)?.innerText?.replace(/\\s+/g, ' ').trim() ?? '';
    const suffix = document.querySelector('#batch-parameter-outputSuffix');
    const lineEnding = document.querySelector('#batch-parameter-lineEnding');
    const bomMode = document.querySelector('#batch-parameter-bomMode');
    const formValue = element => {
      if (!element) return null;
      const item = element.closest('.ant-form-item');
      return { value: element.value ?? null, item: item?.innerText?.replace(/\\s+/g, ' ').trim() ?? '' };
    };
    return {
      url: location.href,
      inputSection: text('[aria-label="输入文件"]'),
      outputSection: text('[aria-label="输出设置"]'),
      resultSection: text('[aria-label="结果汇总"]'),
      status: text('[aria-label="任务操作"] [role="status"]'),
      suffix: formValue(suffix), lineEnding: formValue(lineEnding), bomMode: formValue(bomMode),
      events: [...(window.__normalAppFileChainEvents ?? [])]
    };
  })()`)
}

async function runConversion(session, profile, inputName, expectedOutputName, outputExpectedBytes) {
  const inputPath = path.join(profile.root, 'fixtures', inputName)
  const outputPath = path.join(profile.root, 'fixtures', 'output')
  const pluginTarget = session.pluginPages.at(-1)
  if (!pluginTarget || !/^ztools:\/\/plugins\/batch-text-convert\//.test(pluginTarget.url ?? '')) {
    throw new Error('DIALOG_PLUGIN_TARGET_MISSING')
  }
  const ownerWindows = await session.inspector.evaluate(mainRequireExpression(`
    const { BrowserWindow } = requireMain('electron');
    const expectedUrl = ${JSON.stringify(pluginTarget.url)};
    return BrowserWindow.getAllWindows().filter(window => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return false;
      const url = window.webContents.getURL();
      return url === expectedUrl && url.startsWith('ztools://plugins/batch-text-convert/');
    }).map(window => ({ webContentsId: window.webContents.id, url: window.webContents.getURL(),
      windowDestroyed: window.isDestroyed(), webContentsDestroyed: window.webContents.isDestroyed() }));
  `))
  if (!Array.isArray(ownerWindows) || ownerWindows.length !== 1 ||
      !Number.isSafeInteger(ownerWindows[0]?.webContentsId) || ownerWindows[0].windowDestroyed ||
      ownerWindows[0].webContentsDestroyed || ownerWindows[0].url !== pluginTarget.url) {
    throw new Error('DIALOG_PLUGIN_OWNER_NOT_UNIQUE')
  }
  const dialogOwner = ownerWindows[0]
  const dialogInstall = await session.inspector.evaluate(buildDialogOverrideExpression(
    inputPath, outputPath, dialogOwner.webContentsId, dialogOwner.url))
  if (dialogInstall?.installed !== true || dialogInstall.maxCalls !== 2) throw new Error('DIALOG_SUBSTITUTE_NOT_INSTALLED')
  const page = session.pluginPages.at(-1).page
  await installDialogRecorder(page)

  const defaults = await collectBatchPageState(page)
  if (defaults.suffix?.value !== '.converted' || !defaults.lineEnding?.item.includes('LF') || !defaults.bomMode?.item.includes('保留')) {
    throw new Error('CONVERSION_DEFAULTS_NOT_CONFIRMED')
  }

  const clickEvidence = []
  clickEvidence.push(await clickVisible(page, 'button[data-batch-action="select-files"]'))
  const inputState = await waitForCondition(() => collectBatchPageState(page), value => value.inputSection.includes('已添加 1 个'),
    15_000, 'SYNTHETIC_INPUT_SELECTION_NOT_REFLECTED')
  clickEvidence.push(await clickVisible(page, 'button[data-batch-action="select-output"]'))
  const outputState = await waitForCondition(() => collectBatchPageState(page), value => value.outputSection.includes(outputPath),
    15_000, 'SYNTHETIC_OUTPUT_SELECTION_NOT_REFLECTED')
  clickEvidence.push(await clickVisible(page, 'button[data-batch-action="start"]'))
  const finalState = await waitForCondition(() => collectBatchPageState(page), value =>
    value.resultSection.includes('成功 1') && value.resultSection.includes('失败 0') && value.status.includes('处理完成'),
  90_000, 'BATCH_CONVERSION_NOT_CONFIRMED')

  const outputFile = path.join(outputPath, expectedOutputName)
  await waitForCondition(async () => fs.existsSync(outputFile) ? fs.readFileSync(outputFile) : null,
    bytes => Buffer.isBuffer(bytes) && bytes.equals(outputExpectedBytes), 20_000, 'CONVERSION_OUTPUT_BYTES_MISMATCH')
  const dialogState = await session.inspector.evaluate(buildDialogStateExpression())
  if (!dialogState?.present || dialogState.restored !== true || dialogState.exactOriginalRestored !== true ||
      JSON.stringify(dialogState.calls) !== JSON.stringify(['file', 'directory'])) throw new Error('DIALOG_SUBSTITUTE_RESTORE_UNCONFIRMED')
  await session.inspector.evaluate(buildDialogRestoreExpression())
  const finalDialogState = await session.inspector.evaluate(buildDialogStateExpression())
  if (finalDialogState?.present) throw new Error('DIALOG_SUBSTITUTE_STATE_REMAINS')
  const fileBytes = fs.readFileSync(outputFile)
  const sourceBytes = fs.readFileSync(inputPath)
  if (!Buffer.from(sourceBytes).equals(makeSyntheticTextFixture().input)) throw new Error('SYNTHETIC_SOURCE_CHANGED')
  const trustedActions = finalState.events.filter(event => ['select-files', 'select-output', 'start'].includes(event.action))
  if (trustedActions.length !== 3 || trustedActions.some(event => event.isTrusted !== true)) throw new Error('REAL_UI_EVENTS_NOT_CONFIRMED')
  return {
    inputPath, outputPath, outputFile, outputName: expectedOutputName,
    sourceSize: sourceBytes.length, sourceSha256: digest(sourceBytes),
    outputSize: fileBytes.length, outputSha256: digest(fileBytes), outputBytesMatchExpected: fileBytes.equals(outputExpectedBytes),
    expectedOutputSha256: digest(outputExpectedBytes), outputActualBase64: fileBytes.toString('base64'),
    dialogOwner, dialogInstall, dialogState, clicks: clickEvidence, trustedActions,
    initialPageState: defaults, inputSelectedPageState: inputState, outputSelectedPageState: outputState,
    completedPageState: finalState, dialogUi: 'NOT_RUN_MAIN_ONE_SHOT_DIALOG_SUBSTITUTE'
  }
}

function appRuntimeLogContains(profile, text) {
  const logPath = path.join(profile.appDataPath, 'ZTools', 'Logs', `electron-main-${new Date().toISOString().slice(0, 10)}.log`)
  if (!fs.existsSync(logPath)) return false
  return fs.readFileSync(logPath, 'utf8').includes(text)
}

async function runAppPhase({ appRoot, executable, profile, output, phase, versions, report, ports }) {
  const session = await startNormalApp({ appRoot, executable, profile, output, phase, versions, report, ports })
  currentOwnedSessions.add(session)
  const normalAppIdentity = { main: session.mainIdentity, renderer: session.rendererIdentity,
    inspectorTargetId: session.inspectorTargetId, targetId: session.targetId }
  const sessionRecord = { session, normalAppIdentity, referenceRuntime: session.referenceRuntime,
    runtimeLogPath: session.runtimeLogPath, brokerEvidence: session.brokerEvidence }
  return sessionRecord
}

async function runNormalProfile(context) {
  const { runRoot, executable, appRoot, versions, zipInfo, zipServer, updateZipInfo, updateZipServer, ports, report } = context
  const profile = createProfileDirectories(path.join(runRoot, 'profiles', 'normal'))
  fs.mkdirSync(path.join(profile.root, 'fixtures'), { recursive: false })
  fs.mkdirSync(path.join(profile.root, 'fixtures', 'input'), { recursive: false })
  fs.mkdirSync(path.join(profile.root, 'fixtures', 'output'), { recursive: false })
  const fixture = makeSyntheticTextFixture()
  const inputPath = path.join(profile.root, 'fixtures', 'input', 'notes.txt')
  fs.writeFileSync(inputPath, fixture.input, { flag: 'wx' })

  let phase = await runAppPhase({ appRoot, executable, profile, output: runRoot, phase: 'normal-start', versions, report, ports })
  let session = phase.session
  report.phases.normalStartup = {
    status: 'PASS', identity: phase.normalAppIdentity,
    referenceRuntime: phase.referenceRuntime,
    referenceRuntimeAvailableLog: appRuntimeLogContains(profile, 'Reference runtime available'),
    runtimeLogPath: phase.runtimeLogPath,
    ownedPathBrokerEvidence: phase.brokerEvidence
  }
  const zipInfoForInstall = { ...zipInfo, version: context.pluginVersion }
  const installed = await installPlugin(session, zipServer, zipInfoForInstall, profile.appDataPath, context.pluginVersion)
  report.phases.normalInstall = { status: 'PASS', ...installed, installUrl: zipServer.url, loopbackRequests: zipServer.requests }

  const opened = await openAndConnectPlugin(session, versions)
  let updateReopen
  if (updateZipInfo && updateZipServer) {
    const updateAttempt = await runSdk2UpdateRejection({ session, pluginDirectory: installed.pluginDirectory,
      baseVersion: context.pluginVersion, updateZipInfo, updateZipServer, report })
    updateReopen = await openAndConnectPlugin(session, versions, { inspectFresh: true })
    report.phases.sdk2UpdateRejection.reopenedPluginTarget = updateReopen.target
    report.phases.sdk2UpdateRejection.reopenedPluginIdentity = updateReopen.identity
    report.phases.sdk2UpdateRejection.oldPluginReopenedAfterRefresh = true
    report.phases.sdk2UpdateRejection.closeBeforeUpdate = updateAttempt.closeBeforeUpdate
  } else {
    report.phases.sdk2UpdateRejection = { status: 'NOT_RUN', reason: 'UPDATE_ZIP_NOT_PROVIDED' }
  }
  const conversion = await runConversion(session, profile, 'input/notes.txt', fixture.outputFileName, fixture.expected)
  report.phases.normalConversion = { status: 'PASS', ...conversion }

  const closeFirst = await closePluginViaPublicSdk(session)
  const reopened = await openAndConnectPlugin(session, versions, { inspectFresh: true })
  const closeSecond = await closePluginViaPublicSdk(session)
  report.phases.normalPluginWindowLifecycle = {
    status: 'PASS', firstOpen: opened.target, firstClose: closeFirst,
    reopenAfterUpdateRejection: updateReopen?.target ?? null,
    reopenAfterUpdateInitialState: updateReopen?.identity.inputFiles ?? null,
    secondOpen: reopened.target, secondOpenInitialState: reopened.identity.inputFiles,
    secondClose: closeSecond
  }

  const firstStop = await stopOwnedApp(session)
  currentOwnedSessions.delete(session)
  session = undefined
  report.phases.normalAppExit = { status: firstStop.cleanupConfirmed ? 'PASS' : 'FAIL', ...firstStop }
  if (!firstStop.cleanupConfirmed) throw new Error('NORMAL_APP_OWNED_EXIT_UNCONFIRMED')
  const lingering = phase.brokerEvidence.processes.filter(item => isProcessAlive(item.pid))
  report.phases.normalOwnedBrokerCleanup = { status: lingering.length === 0 ? 'PASS' : 'FAIL', stoppedPids: phase.brokerEvidence.processes.map(item => item.pid), lingering }
  if (lingering.length) throw new Error('OWNED_PATH_BROKER_CLEANUP_UNCONFIRMED')

  phase = await runAppPhase({ appRoot, executable, profile, output: runRoot, phase: 'normal-restart', versions, report, ports })
  session = phase.session
  const reloadedPlugin = await openAndConnectPlugin(session, versions)
  const reopenedOutput = fs.readFileSync(conversion.outputFile)
  if (!reopenedOutput.equals(fixture.expected)) throw new Error('OUTPUT_DID_NOT_SURVIVE_APP_RESTART')
  const closeAfterRestart = await closePluginViaPublicSdk(session)
  report.phases.normalRestart = {
    status: 'PASS', identity: phase.normalAppIdentity,
    referenceRuntime: phase.referenceRuntime,
    ownedPathBrokerEvidence: phase.brokerEvidence,
    pluginTarget: reloadedPlugin.target,
    installedManifestVersion: JSON.parse(fs.readFileSync(path.join(installed.pluginDirectory, 'plugin.json'), 'utf8')).version,
    outputStillMatches: reopenedOutput.equals(fixture.expected), close: closeAfterRestart
  }
  const restartedStop = await stopOwnedApp(session)
  currentOwnedSessions.delete(session)
  session = undefined
  report.phases.normalRestartExit = { status: restartedStop.cleanupConfirmed ? 'PASS' : 'FAIL', ...restartedStop }
  if (!restartedStop.cleanupConfirmed) throw new Error('RESTARTED_APP_OWNED_EXIT_UNCONFIRMED')
  const restartedLingering = phase.brokerEvidence.processes.filter(item => isProcessAlive(item.pid))
  report.phases.normalRestartOwnedBrokerCleanup = { status: restartedLingering.length === 0 ? 'PASS' : 'FAIL', stoppedPids: phase.brokerEvidence.processes.map(item => item.pid), lingering: restartedLingering }
  if (restartedLingering.length) throw new Error('RESTARTED_BROKER_CLEANUP_UNCONFIRMED')

  return { profile, fixture, installed, conversion, normalReferenceAvailable: report.phases.normalStartup.referenceRuntimeAvailableLog }
}

async function runCorruptJournalProfile(context) {
  const { runRoot, executable, appRoot, versions, zipInfo, zipServer, pluginVersion, ports, report } = context
  const profile = createProfileDirectories(path.join(runRoot, 'profiles', 'corrupt-journal'), { corruptJournal: true })
  fs.mkdirSync(path.join(profile.root, 'fixtures'), { recursive: false })
  fs.mkdirSync(path.join(profile.root, 'fixtures', 'input'), { recursive: false })
  fs.mkdirSync(path.join(profile.root, 'fixtures', 'output'), { recursive: false })
  const fixture = makeSyntheticTextFixture()
  const sourceName = 'legacy-sdk-failclosed.txt'
  const expectedOutputName = 'legacy-sdk-failclosed.converted.txt'
  fs.writeFileSync(path.join(profile.root, 'fixtures', 'input', sourceName), fixture.input, { flag: 'wx' })

  const phase = await runAppPhase({ appRoot, executable, profile, output: runRoot, phase: 'corrupt-start', versions, report, ports })
  let session = phase.session
  const referenceRuntimeUnavailable = appRuntimeLogContains(profile, 'Reference runtime unavailable')
  if (!referenceRuntimeUnavailable) throw new Error('CORRUPT_JOURNAL_DID_NOT_FAIL_CLOSED')
  const failedClosedRecord = {
    status: 'PASS', syntheticCorruptionInjection: true,
    corruptJournalPath: profile.corruptJournalPath,
    corruptJournalSha256: digest(fs.readFileSync(profile.corruptJournalPath)),
    referenceRuntime: phase.referenceRuntime,
    referenceUnavailableLog: referenceRuntimeUnavailable,
    mainStillStarted: true,
    mainIdentity: phase.normalAppIdentity
  }
  const installed = await installPlugin(session, zipServer, { ...zipInfo, version: pluginVersion }, profile.appDataPath, pluginVersion)
  const opened = await openAndConnectPlugin(session, versions)
  const conversion = await runConversion(session, profile, `input/${sourceName}`, expectedOutputName, fixture.expected)
  report.phases.corruptJournalFailClosed = failedClosedRecord
  report.phases.legacySdkFileOperationUnderFailClosed = {
    status: 'PASS', installedFiles: installed.fileHashes,
    pluginTarget: opened.target, outputFile: conversion.outputFile,
    outputBytesMatchExpected: conversion.outputBytesMatchExpected,
    outputSha256: conversion.outputSha256, trustedUiActions: conversion.trustedActions
  }
  const close = await closePluginViaPublicSdk(session)
  const stop = await stopOwnedApp(session)
  currentOwnedSessions.delete(session)
  session = undefined
  const lingering = phase.brokerEvidence.processes.filter(item => isProcessAlive(item.pid))
  report.phases.corruptJournalCleanup = { status: stop.cleanupConfirmed && lingering.length === 0 ? 'PASS' : 'FAIL', ...stop,
    brokerPids: phase.brokerEvidence.processes.map(item => item.pid), lingering, pluginClose: close }
  if (!stop.cleanupConfirmed || lingering.length) throw new Error('CORRUPT_PROFILE_OWNED_CLEANUP_UNCONFIRMED')
}

async function closeZipServer(server) {
  if (!server) return
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

async function run() {
  const parsed = parseArgs({ options: { zip: { type: 'string' }, 'update-zip': { type: 'string' },
    'cdp-port': { type: 'string' }, 'inspect-port': { type: 'string' },
    help: { type: 'boolean' }, 'skip-corrupt-journal': { type: 'boolean' } } })
  if (parsed.values.help) {
    console.log('node scripts/test-windows-normal-app-plugin-file-chain.mjs --zip <fresh SDK1 ZIP> [--update-zip <fresh SDK2 rejection ZIP>] [--cdp-port <port> --inspect-port <port>] [--skip-corrupt-journal]')
    console.log('Starts only owned `electron .` instances with isolated paths; exercises the public plugin update API when --update-zip is supplied; Main dialog uses a bounded one-shot test substitute; no user data is read or written.')
    return
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log(JSON.stringify({ status: 'NOT_RUN', platform: process.platform, arch: process.arch,
      reason: 'WINDOWS_X64_NORMAL_ELECTRON_REQUIRED', macAcceptance: 'NOT_RUN' }))
    process.exitCode = 1
    return
  }
  if (!parsed.values.zip || !path.win32.isAbsolute(parsed.values.zip)) throw new Error('ZIP_ABSOLUTE_PATH_REQUIRED')
  if (parsed.values['update-zip'] && !path.win32.isAbsolute(parsed.values['update-zip'])) throw new Error('UPDATE_ZIP_ABSOLUTE_PATH_REQUIRED')
  const ports = { cdp: parsePort(parsed.values['cdp-port'], NORMAL_APP_CDP_PORT, 'CDP_PORT'),
    inspect: parsePort(parsed.values['inspect-port'], NORMAL_APP_INSPECT_PORT, 'INSPECT_PORT') }
  if (ports.cdp === ports.inspect) throw new Error('CDP_PORTS_MUST_DIFFER')
  const runId = randomUUID()
  const runRoot = path.join(root, 'out-test', 'normal-app-plugin-file-chain', runId)
  fs.mkdirSync(path.dirname(runRoot), { recursive: true })
  fs.mkdirSync(runRoot, { recursive: false })
  fs.mkdirSync(path.join(runRoot, 'profiles'), { recursive: false })
  const report = {
    schemaVersion: 1, runId, platform: process.platform, arch: process.arch,
    scope: 'windows-normal-electron-entry-isolated-plugin-install-sdk2-update-rejection-ui-file-write-restart', status: 'FAIL',
    productionZToolsAcceptance: false, normalElectronEntry: true, isolatedAppData: false, isolationConfirmed: false,
    rendererArbitraryIpcExposed: false, rendererNodeExposed: false,
    nativeDialogUi: 'NOT_RUN_MAIN_ONE_SHOT_DIALOG_SUBSTITUTE', macAcceptance: 'NOT_RUN',
    completeCase: false, output: runRoot, phases: {}, inputs: {}
  }
  let zipServer
  let updateZipServer
  try {
    const versions = readVersionMetadata()
    const pluginManifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'src', 'plugins', 'batch-text-convert', 'plugin.json'), 'utf8'))
    if (pluginManifest.id !== 'batch-text-convert' || !pluginManifest.version) throw new Error('PLUGIN_SOURCE_MANIFEST_INVALID')
    const zipInfo = validateFreshPluginZip(parsed.values.zip, pluginRoot)
    const validatedUpdateZipInfo = parsed.values['update-zip'] ? validateFreshPluginZip(parsed.values['update-zip'], pluginRoot) : null
    const updateFixture = validatedUpdateZipInfo ? validateSdk2UpdateFixture(validatedUpdateZipInfo, zipInfo, pluginManifest.version) : null
    const updateZipInfo = validatedUpdateZipInfo ? { ...validatedUpdateZipInfo, version: updateFixture.output.version } : null
    const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    const bootstrap = path.join(root, 'out', 'main', 'bootstrap.js')
    const webIndex = path.join(root, 'out', 'assets', 'web', 'index.html')
    const brokerPath = path.join(root, 'out', 'native', 'win32-x64', 'bin', 'ZToolsPathAccessBroker.exe')
    assertRegularFile(electronExecutable, 'ELECTRON_EXECUTABLE_INVALID')
    assertRegularFile(bootstrap, 'PROJECT_BOOTSTRAP_NOT_BUILT')
    assertRegularFile(webIndex, 'NORMAL_APP_WEB_BUILD_NOT_FOUND')
    assertRegularFile(brokerPath, 'PATH_ACCESS_BROKER_NOT_BUILT')
    assertPeMachine(electronExecutable, PE_MACHINE_X64)
    assertPeMachine(brokerPath, PE_MACHINE_X64)
    await requirePortsAvailable([ports.cdp, ports.inspect])

    const fixture = makeSyntheticTextFixture()
    const zipServerRunId = randomUUID()
    zipServer = await startLoopbackZipServer(zipInfo, zipServerRunId)
    if (updateZipInfo) updateZipServer = await startLoopbackZipServer(updateZipInfo, randomUUID(), 'batch-text-convert-update.zip')
    report.inputs = {
      appRoot: root,
      appVersion: versions.appVersion,
      electronVersion: versions.electronVersion,
      sdkContractVersion: versions.sdkContractVersion,
      cdpPort: ports.cdp, inspectPort: ports.inspect,
      pluginSourceVersion: pluginManifest.version,
      freshZip: { path: zipInfo.path, fileSize: zipInfo.fileSize, sha256: zipInfo.checksum, buildRun: zipInfo.buildRun },
      sdk2UpdateFixture: updateFixture ? { path: updateZipInfo.path, fileSize: updateZipInfo.fileSize,
        sha256: updateZipInfo.checksum, buildRun: updateZipInfo.buildRun, buildReport: updateFixture } : null,
      electronExecutable, electronExecutableSha256: digest(fs.readFileSync(electronExecutable)),
      bootstrap, bootstrapSha256: digest(fs.readFileSync(bootstrap)), webIndex,
      brokerPath, brokerSha256: digest(fs.readFileSync(brokerPath)),
      fixtureInputSha256: digest(fixture.input), fixtureExpectedOutputSha256: digest(fixture.expected)
    }
    const normalResult = await runNormalProfile({ runRoot, executable: electronExecutable, appRoot: root, versions,
      zipInfo, zipServer, updateZipInfo, updateZipServer, ports, pluginVersion: pluginManifest.version, report })
    if (parsed.values['skip-corrupt-journal'] !== true) {
      await runCorruptJournalProfile({ runRoot, executable: electronExecutable, appRoot: root, versions,
        zipInfo, zipServer, ports, pluginVersion: pluginManifest.version, report })
    } else {
      report.phases.corruptJournalFailClosed = { status: 'NOT_RUN', reason: 'SKIPPED_BY_EXPLICIT_ARGUMENT' }
      report.phases.legacySdkFileOperationUnderFailClosed = { status: 'NOT_RUN', reason: 'SKIPPED_BY_EXPLICIT_ARGUMENT' }
    }
    const referenceAvailable = normalResult.normalReferenceAvailable
    const brokerCounts = [report.phases.normalStartup.ownedPathBrokerEvidence, report.phases.normalRestart.ownedPathBrokerEvidence]
      .map(item => item?.brokerCount)
    const brokerMatches = brokerCounts.every(count => count === 1)
    report.phases.expectedOwnedBrokerCardinality = { status: brokerMatches ? 'PASS' : 'OBSERVED_MISMATCH', expected: 1, observed: brokerCounts,
      limitation: 'At normal startup only the journal-store adapter starts. The recovery adapter and per-owner provider are lazy; no internal IPC was used to force another broker.' }
    const updateMatches = !updateZipInfo || report.phases.sdk2UpdateRejection?.status === 'PASS'
    report.status = referenceAvailable && brokerMatches && updateMatches ? 'PASS' : 'FAIL'
    report.completeCase = report.status === 'PASS' && report.phases.corruptJournalFailClosed.status === 'PASS' &&
      report.phases.legacySdkFileOperationUnderFailClosed.status === 'PASS' && updateMatches
    report.failureCode = report.status === 'PASS' ? null : !referenceAvailable ? 'NORMAL_REFERENCE_RUNTIME_UNAVAILABLE' :
      !brokerMatches ? 'OWNED_PATH_BROKER_COUNT_MISMATCH' : 'SDK2_UPDATE_REJECTION_NOT_CONFIRMED'
    if (report.status !== 'PASS') process.exitCode = 1
  } catch (error) {
    report.failureCode = safeErrorCode(error)
    if (typeof error?.stage === 'string' && /^[a-z0-9-]{1,80}$/i.test(error.stage)) report.failureStage = error.stage
    if (error?.cdpException && typeof error.cdpException === 'object') report.failureDiagnostic = { cdpException: error.cdpException }
    if (typeof error?.stack === 'string') report.failureDiagnostic ??= { errorStack: error.stack.slice(0, 4000) }
    if (error?.cleanup && typeof error.cleanup === 'object') report.failureCleanup = error.cleanup
    report.failedAt = new Date().toISOString()
    console.error(report.failureCode)
    process.exitCode = 1
  } finally {
    for (const session of [...currentOwnedSessions]) {
      const stopped = await stopOwnedApp(session)
      currentOwnedSessions.delete(session)
      if (!stopped.cleanupConfirmed) {
        report.status = 'FAIL'
        report.failureCode ??= 'OWNED_ELECTRON_CLEANUP_UNCONFIRMED'
        process.exitCode = 1
      }
    }
    if (zipServer) {
      try { await closeZipServer(zipServer.server); report.loopbackServerStopped = true }
      catch { report.loopbackServerStopped = false; report.status = 'FAIL'; report.failureCode ??= 'LOOPBACK_SERVER_CLOSE_UNCONFIRMED'; process.exitCode = 1 }
    }
    if (updateZipServer) {
      try { await closeZipServer(updateZipServer.server); report.updateLoopbackServerStopped = true }
      catch { report.updateLoopbackServerStopped = false; report.status = 'FAIL'; report.failureCode ??= 'UPDATE_LOOPBACK_SERVER_CLOSE_UNCONFIRMED'; process.exitCode = 1 }
    }
    report.nativeDialogUi = 'NOT_RUN_MAIN_ONE_SHOT_DIALOG_SUBSTITUTE'
    report.scratchPreserved = true
    report.updatedAt = new Date().toISOString()
    const outputReport = path.join(runRoot, 'report.json')
    if (fs.existsSync(runRoot) && !fs.existsSync(outputReport)) fs.writeFileSync(outputReport, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    const evidenceDirectory = path.resolve(repositoryRoot, 'docs', 'mac-compat-evidence', 'F06')
    fs.mkdirSync(evidenceDirectory, { recursive: true })
    const evidencePath = path.join(evidenceDirectory, `normal-app-plugin-file-chain-${runId}.json`)
    fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    if (report.status === 'FAIL') process.exitCode = 1
    console.log(JSON.stringify({ ...report, evidencePath }))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === runnerPath) {
  void run().catch(error => { console.error(safeErrorCode(error)); process.exitCode = 1 })
}
