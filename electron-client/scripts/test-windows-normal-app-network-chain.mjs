import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'
import { WindowsNormalAppHarness } from './lib/windows-normal-app-harness.mjs'
import {
  buildDialogOverrideExpression,
  buildDialogRestoreExpression,
  buildDialogStateExpression,
  digest,
  validateFreshPluginZip
} from './windows-normal-app-plugin-file-chain-lib.mjs'

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(clientRoot, '..')
const pluginRoot = path.join(repositoryRoot, 'plugins', 'create-plugin')
const pluginId = 'batch-text-convert'
const targetId = 'windows-electron-x64'
const successfulBytes = Buffer.from(Array.from({ length: 4096 }, (_value, index) => (index * 37 + 11) & 0xff))
const holdBytes = Buffer.alloc(1024 * 1024, 0x5a)
const holdPrefix = holdBytes.subarray(0, 64 * 1024)
const routeIds = Object.freeze(['pluginZip', 'success', 'httpFailure', 'timeout', 'windowClose'])
const scenarioIds = Object.freeze(['success', 'httpFailure', 'timeout', 'windowClose'])
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normalizeWindowsPath(value) {
  return path.win32.normalize(path.win32.resolve(value)).replaceAll('/', '\\').toLocaleLowerCase('en-US')
}

function isWithinWindowsPath(root, candidate) {
  if (typeof root !== 'string' || typeof candidate !== 'string' ||
      !path.win32.isAbsolute(root) || !path.win32.isAbsolute(candidate)) return false
  const relative = path.win32.relative(path.win32.resolve(root), path.win32.resolve(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative))
}

export function validateSdk1PluginManifest(manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { status: 'FAIL', errors: ['PLUGIN_MANIFEST_INVALID'] }
  }
  if (manifest.id !== pluginId) errors.push('PLUGIN_ID_MISMATCH')
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) errors.push('PLUGIN_VERSION_INVALID')
  if (!Array.isArray(manifest.targets) || manifest.targets.length !== 1) {
    errors.push('PLUGIN_TARGET_SET_INVALID')
  } else {
    const target = manifest.targets[0]
    if (!target || target.id !== targetId || target.platform !== 'windows' ||
        target.runtime !== 'electron' || target.arch !== 'x64') {
      errors.push('WINDOWS_X64_TARGET_REQUIRED')
    }
  }
  if (!Array.isArray(manifest.nativeComponents) || manifest.nativeComponents.length !== 0) {
    errors.push('PURE_JS_PLUGIN_REQUIRED')
  }
  const lane = manifest.minimumSdkContractVersion ?? manifest.minSdkContractVersion ?? manifest.sdkContractVersion ?? 1
  if (lane !== 1) errors.push('SDK1_PLUGIN_REQUIRED')
  return {
    status: errors.length === 0 ? 'PASS' : 'FAIL',
    errors,
    pluginId: manifest.id,
    pluginVersion: manifest.version,
    targetId,
    targetCount: Array.isArray(manifest.targets) ? manifest.targets.length : null,
    nativeComponents: Array.isArray(manifest.nativeComponents) ? manifest.nativeComponents.length : null,
    declaredSdkLane: lane
  }
}

export function createScenarioPlan(runId, port, profileRoot, downloadDirectory) {
  if (typeof runId !== 'string' || !uuidPattern.test(runId)) throw new Error('RUN_ID_INVALID')
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('LOOPBACK_PORT_INVALID')
  if (!path.win32.isAbsolute(profileRoot) || !path.win32.isAbsolute(downloadDirectory) ||
      !isWithinWindowsPath(profileRoot, downloadDirectory)) throw new Error('DOWNLOAD_DIRECTORY_OUTSIDE_PROFILE')
  const fileNames = {
    success: 'sdk1-success-' + runId + '.bin',
    httpFailure: 'sdk1-http-failure-' + runId + '.bin',
    timeout: 'sdk1-timeout-' + runId + '.bin',
    windowClose: 'sdk1-window-close-' + runId + '.bin'
  }
  const routePaths = {
    pluginZip: '/' + runId + '/plugin.zip',
    success: '/' + runId + '/success.bin',
    httpFailure: '/' + runId + '/http-503.bin',
    timeout: '/' + runId + '/timeout.bin',
    windowClose: '/' + runId + '/window-close.bin'
  }
  const baseUrl = 'http://127.0.0.1:' + port
  const scenarios = Object.fromEntries(scenarioIds.map(id => [id, {
    id,
    routePath: routePaths[id],
    url: baseUrl + routePaths[id],
    fileName: fileNames[id],
    targetPath: path.win32.join(downloadDirectory, fileNames[id])
  }]))
  return {
    runId,
    port,
    profileRoot: path.win32.resolve(profileRoot),
    downloadDirectory: path.win32.resolve(downloadDirectory),
    baseUrl,
    archive: { routePath: routePaths.pluginZip, url: baseUrl + routePaths.pluginZip },
    routes: routePaths,
    scenarios
  }
}

export function resolveFixtureRoute(plan, requestPath) {
  if (!plan || typeof requestPath !== 'string') return null
  for (const id of routeIds) if (plan.routes[id] === requestPath) return id
  return null
}

function hasUuidTemporaryName(name, fileName) {
  const prefix = '.' + fileName + '.'
  const suffix = '.download'
  if (typeof name !== 'string' || !name.startsWith(prefix) || !name.endsWith(suffix)) return false
  return uuidPattern.test(name.slice(prefix.length, -suffix.length))
}

export function validateArtifactEntries(entries, plan, expected) {
  if (!Array.isArray(entries) || !plan?.scenarios || !expected ||
      !Array.isArray(expected.presentTargets)) throw new Error('ARTIFACT_EXPECTATION_INVALID')
  const allowedIds = new Set(scenarioIds)
  const expectedTargets = new Set(expected.presentTargets)
  const activeTarget = expected.activeTempTargetId ?? null
  if ([...expectedTargets].some(id => !allowedIds.has(id)) ||
      (activeTarget !== null && !allowedIds.has(activeTarget))) throw new Error('ARTIFACT_EXPECTATION_UNKNOWN_TARGET')
  const presentTargets = []
  const activeTemps = []
  const unexpected = []
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry || entry.includes('\\') || entry.includes('/')) {
      unexpected.push(String(entry))
      continue
    }
    const target = scenarioIds.find(id =>
      entry.toLocaleLowerCase('en-US') === plan.scenarios[id].fileName.toLocaleLowerCase('en-US'))
    if (target) {
      presentTargets.push(target)
      continue
    }
    const temporary = scenarioIds.find(id => hasUuidTemporaryName(entry, plan.scenarios[id].fileName))
    if (temporary) {
      activeTemps.push(temporary)
      continue
    }
    unexpected.push(entry)
  }
  const duplicateTargets = presentTargets.filter((id, index) => presentTargets.indexOf(id) !== index)
  const targetSetMatches = presentTargets.length === expectedTargets.size &&
    presentTargets.every(id => expectedTargets.has(id))
  const tempSetMatches = activeTarget === null
    ? activeTemps.length === 0
    : activeTemps.length === 1 && activeTemps[0] === activeTarget
  const errors = []
  if (!targetSetMatches) errors.push('FINAL_TARGET_SET_MISMATCH')
  if (!tempSetMatches) errors.push('TEMPORARY_FILE_SET_MISMATCH')
  if (unexpected.length) errors.push('UNEXPECTED_DOWNLOAD_DIRECTORY_ENTRY')
  if (duplicateTargets.length) errors.push('DUPLICATE_TARGET_ENTRY')
  return {
    status: errors.length === 0 ? 'PASS' : 'FAIL',
    errors,
    entries: [...entries].sort(),
    presentTargets: [...presentTargets].sort(),
    activeTemporaryTargets: [...activeTemps].sort(),
    unexpected
  }
}

export function validateSuccessfulDownload(result, actualBytes, targetPath, expectedBytes) {
  const pathMatches = typeof result?.path === 'string' &&
    normalizeWindowsPath(result.path) === normalizeWindowsPath(targetPath)
  const statusMatches = Number.isSafeInteger(result?.statusCode) && result.statusCode >= 200 && result.statusCode < 300
  const sizeMatches = Number.isSafeInteger(result?.size) && result.size === expectedBytes.length
  const bytesMatch = Buffer.isBuffer(actualBytes) && actualBytes.equals(expectedBytes)
  const errors = []
  if (result?.success !== true) errors.push('DOWNLOAD_RESULT_NOT_SUCCESS')
  if (!pathMatches) errors.push('DOWNLOAD_RESULT_PATH_MISMATCH')
  if (!statusMatches) errors.push('DOWNLOAD_RESULT_STATUS_INVALID')
  if (!sizeMatches) errors.push('DOWNLOAD_RESULT_SIZE_MISMATCH')
  if (!bytesMatch) errors.push('DOWNLOAD_BYTES_MISMATCH')
  return {
    status: errors.length === 0 ? 'PASS' : 'FAIL',
    errors,
    pathMatches,
    statusCode: Number.isSafeInteger(result?.statusCode) ? result.statusCode : null,
    resultSize: Number.isSafeInteger(result?.size) ? result.size : null,
    actualSize: Buffer.isBuffer(actualBytes) ? actualBytes.length : null,
    expectedSize: expectedBytes.length,
    actualSha256: Buffer.isBuffer(actualBytes) ? digest(actualBytes) : null,
    expectedSha256: digest(expectedBytes)
  }
}

export function createScopeBoundary() {
  return {
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
  }
}

function mainRequireExpression(body) {
  return '(() => { const mainModule = process.mainModule; if (!mainModule || typeof mainModule.require !== "function") throw new Error("MAIN_MODULE_REQUIRE_UNAVAILABLE"); const requireMain = mainModule.require.bind(mainModule); ' +
    body + ' })()'
}

function readVersions() {
  const packageInfo = JSON.parse(fs.readFileSync(path.join(clientRoot, 'package.json'), 'utf8'))
  const protocol = fs.readFileSync(path.join(clientRoot, 'src', 'contracts', 'protocol-versions.ts'), 'utf8')
  const sdk = protocol.match(/SDK_CONTRACT\s*=\s*(\d+)/)
  const electron = JSON.parse(fs.readFileSync(path.join(clientRoot, 'node_modules', 'electron', 'package.json'), 'utf8'))
  const appName = typeof packageInfo.productName === 'string' ? packageInfo.productName : packageInfo.name
  if (!sdk || typeof appName !== 'string' || typeof packageInfo.version !== 'string' || electron.version !== '43.4.1') {
    throw new Error('RUNTIME_VERSION_METADATA_INVALID')
  }
  return {
    appName,
    appVersion: packageInfo.version,
    electronVersion: electron.version,
    sdkContractVersion: Number(sdk[1])
  }
}

function safeErrorCode(error) {
  const value = typeof error?.code === 'string' ? error.code :
    typeof error?.message === 'string' ? error.message : ''
  return /^[A-Z0-9_]{1,96}$/.test(value) ? value : 'NORMAL_APP_NETWORK_CHAIN_UNCLASSIFIED_FAILURE'
}

function safeError(error) {
  return {
    code: safeErrorCode(error),
    message: typeof error?.message === 'string' ? error.message.slice(0, 240) : 'unknown'
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(read, accept, timeoutMs, code, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await read()
    if (accept(last)) return last
    await delay(intervalMs)
  }
  const error = new Error(code)
  error.code = code
  error.diagnostic = last ?? null
  throw error
}

function recordPromiseExpression(caseId, url, targetPath, timeoutMs) {
  const id = JSON.stringify(caseId)
  const sourceUrl = JSON.stringify(url)
  const destination = JSON.stringify(targetPath)
  return '(() => {' +
    'if (!window.ztools?.network || typeof window.ztools.network.download !== "function") throw new Error("SDK1_NETWORK_DOWNLOAD_UNAVAILABLE");' +
    'window.__normalAppNetworkChain = window.__normalAppNetworkChain || {};' +
    'if (window.__normalAppNetworkChain[' + id + ']) throw new Error("DOWNLOAD_CASE_ALREADY_STARTED");' +
    'const state = { caseId: ' + id + ', startedAt: Date.now(), settled: false, result: null, error: null, progress: [] };' +
    'window.__normalAppNetworkChain[' + id + '] = state;' +
    'window.ztools.network.download(' + sourceUrl + ', ' + destination + ', {' +
      'timeout: ' + timeoutMs + ', onProgress: (downloaded, total) => state.progress.push({ downloaded, total, at: Date.now() })' +
    '}).then(result => { state.settled = true; state.result = result; state.settledAt = Date.now(); }, error => {' +
      'state.settled = true; state.error = { code: typeof error?.code === "string" ? error.code : null,' +
      'name: typeof error?.name === "string" ? error.name : null,' +
      'message: typeof error?.message === "string" ? error.message.slice(0, 240) : "unknown" }; state.settledAt = Date.now();' +
    '});' +
    'return { started: true, caseId: ' + id + ', lane: window.__ztoolsElectron?.contractVersion ?? null };' +
  '})()'
}

async function readRendererDownloadState(page, caseId) {
  return await page.evaluate('(() => {' +
    'const state = window.__normalAppNetworkChain?.[' + JSON.stringify(caseId) + '];' +
    'return state ? JSON.parse(JSON.stringify(state)) : null;' +
  '})()')
}

function inspectSdkLane(page) {
  return page.evaluate('(() => ({ isElectron: window.ztools?.isElectron?.() === true,' +
    ' contractVersion: window.__ztoolsElectron?.contractVersion ?? null,' +
    ' networkDownloadType: typeof window.ztools?.network?.download,' +
    ' nodeType: typeof process, requireType: typeof require }))()')
}

function temporaryNamesFor(entries, scenario) {
  return entries.filter(entry => hasUuidTemporaryName(entry, scenario.fileName))
}

function readDownloadEntries(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).map(entry => entry.name)
}

function verifyDirectory(directory, plan, expected) {
  const entries = readDownloadEntries(directory)
  const symlinks = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isSymbolicLink()).map(entry => entry.name)
  const validation = validateArtifactEntries(entries, plan, expected)
  if (symlinks.length) {
    validation.status = 'FAIL'
    validation.errors.push('UNEXPECTED_SYMLINK_IN_DOWNLOAD_DIRECTORY')
    validation.unexpected.push(...symlinks)
  }
  return { entries, validation }
}

async function createLoopbackFixtureServer(plan, zipInfo) {
  const archiveBytes = fs.readFileSync(zipInfo.path)
  if (archiveBytes.length !== zipInfo.fileSize || digest(archiveBytes) !== zipInfo.checksum) {
    throw new Error('PLUGIN_ZIP_CHANGED_AFTER_VALIDATION')
  }
  const requests = []
  const sockets = new Set()
  let actualPort = null
  const server = http.createServer()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('request', (request, response) => {
    const routeId = resolveFixtureRoute(plan, request.url ?? '')
    const record = {
      routeId: routeId ?? 'rejected',
      method: request.method ?? 'unknown',
      requestPath: request.url ?? null,
      host: request.headers.host ?? null,
      statusCode: null,
      responseBytesSent: 0,
      requestAborted: false,
      clientDisconnected: false,
      responseEnded: false,
      acceptedAt: new Date().toISOString()
    }
    requests.push(record)
    request.once('aborted', () => { record.requestAborted = true })
    if (!routeId || request.method !== 'GET' || request.headers.host !== '127.0.0.1:' + actualPort) {
      record.statusCode = routeId ? 405 : 404
      response.writeHead(record.statusCode, { 'content-length': '0', 'cache-control': 'no-store' })
      response.end()
      record.responseEnded = true
      response.once('close', () => { record.clientDisconnected = !response.writableEnded })
      return
    }
    response.once('close', () => {
      record.clientDisconnected = !response.writableEnded
      record.closedAt = new Date().toISOString()
    })
    if (routeId === 'pluginZip') {
      record.statusCode = 200
      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': String(archiveBytes.length),
        'cache-control': 'no-store'
      })
      response.end(archiveBytes)
      record.responseBytesSent = archiveBytes.length
      record.responseEnded = true
      return
    }
    if (routeId === 'success') {
      record.statusCode = 200
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(successfulBytes.length),
        'cache-control': 'no-store'
      })
      response.end(successfulBytes)
      record.responseBytesSent = successfulBytes.length
      record.responseEnded = true
      return
    }
    if (routeId === 'httpFailure') {
      const failureBytes = Buffer.from('synthetic-http-503', 'utf8')
      record.statusCode = 503
      response.writeHead(503, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(failureBytes.length),
        'cache-control': 'no-store'
      })
      response.end(failureBytes)
      record.responseBytesSent = failureBytes.length
      record.responseEnded = true
      return
    }
    if (routeId === 'timeout' || routeId === 'windowClose') {
      record.statusCode = 200
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(holdBytes.length),
        'cache-control': 'no-store'
      })
      response.flushHeaders()
      response.write(holdPrefix)
      record.responseBytesSent = holdPrefix.length
      return
    }
    record.statusCode = 404
    response.writeHead(404, { 'content-length': '0', 'cache-control': 'no-store' })
    response.end()
    record.responseEnded = true
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1' ||
      !Number.isSafeInteger(address.port) || address.port < 1) {
    await new Promise(resolve => server.close(resolve))
    throw new Error('LOOPBACK_SERVER_BIND_FAILED')
  }
  actualPort = address.port
  const actualPlan = createScenarioPlan(plan.runId, address.port, plan.profileRoot, plan.downloadDirectory)
  let closed = false
  return {
    server,
    plan: actualPlan,
    requests,
    sockets,
    async close() {
      if (closed) return { closed: true, destroyedOwnedSockets: 0 }
      closed = true
      if (!server.listening) return { closed: true, destroyedOwnedSockets: 0 }
      let destroyedOwnedSockets = 0
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          for (const socket of sockets) {
            destroyedOwnedSockets += 1
            socket.destroy()
          }
        }, 1500)
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      return { closed: true, destroyedOwnedSockets }
    }
  }
}

function currentMainOwnerExpression(pluginUrl) {
  const body = 'const { BrowserWindow } = requireMain("electron"); const expectedUrl = ' +
    JSON.stringify(pluginUrl) + '; return BrowserWindow.getAllWindows().filter(window =>' +
    ' !window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.getURL() === expectedUrl &&' +
    ' expectedUrl.startsWith("ztools://plugins/' + pluginId + '/"))' +
    '.map(window => ({ webContentsId: window.webContents.id, url: window.webContents.getURL(),' +
    ' windowDestroyed: window.isDestroyed(), webContentsDestroyed: window.webContents.isDestroyed() }));'
  return mainRequireExpression(body)
}

async function installDialogGrant(session, opened, profile, report) {
  const inputDirectory = path.join(profile.root, 'fixtures')
  const downloadDirectory = path.join(profile.root, 'downloads')
  fs.mkdirSync(inputDirectory, { recursive: false })
  fs.mkdirSync(downloadDirectory, { recursive: false })
  const inputPath = path.join(inputDirectory, 'main-dialog-substitute-input.bin')
  fs.writeFileSync(inputPath, Buffer.from('synthetic one-shot Main dialog grant\n', 'utf8'), { flag: 'wx' })
  const owners = await session.inspector.evaluate(currentMainOwnerExpression(opened.target.url))
  if (!Array.isArray(owners) || owners.length !== 1 || !Number.isSafeInteger(owners[0]?.webContentsId) ||
      owners[0].windowDestroyed || owners[0].webContentsDestroyed || owners[0].url !== opened.target.url) {
    throw new Error('DIALOG_PLUGIN_OWNER_NOT_UNIQUE')
  }
  const install = await session.inspector.evaluate(buildDialogOverrideExpression(
    inputPath, downloadDirectory, owners[0].webContentsId, owners[0].url))
  if (install?.installed !== true || install.maxCalls !== 2) throw new Error('DIALOG_SUBSTITUTE_NOT_INSTALLED')
  session.networkDialogStubInstalled = true
  const page = opened.page
  const input = await page.evaluate('window.ztools.win.showOpenDialog({ properties: ["openFile", "multiSelections"] })')
  const folder = await page.evaluate('window.ztools.win.showSelectFolderDialog({})')
  if (input?.canceled !== false || input.filePath !== inputPath ||
      folder?.canceled !== false || folder.folderPath !== downloadDirectory) {
    throw new Error('SDK1_DIALOG_GRANT_RESULT_MISMATCH')
  }
  const state = await session.inspector.evaluate(buildDialogStateExpression())
  if (!state?.present || state.restored !== true || state.exactOriginalRestored !== true ||
      JSON.stringify(state.calls) !== JSON.stringify(['file', 'directory'])) {
    throw new Error('DIALOG_SUBSTITUTE_RESTORE_UNCONFIRMED')
  }
  await session.inspector.evaluate(buildDialogRestoreExpression())
  session.networkDialogStubInstalled = false
  const finalState = await session.inspector.evaluate(buildDialogStateExpression())
  if (finalState?.present) throw new Error('DIALOG_SUBSTITUTE_STATE_REMAINS')
  report.phases.dialogGrant = {
    status: 'PASS',
    owner: owners[0],
    inputPath,
    downloadDirectory,
    selectedInputPath: input.filePath,
    selectedFolder: folder.folderPath,
    calls: state.calls,
    originalDialogRestored: state.exactOriginalRestored,
    nativeDialogUi: 'NOT_RUN_MAIN_ONE_SHOT_DIALOG_SUBSTITUTE'
  }
  return { inputPath, downloadDirectory }
}

async function startRendererDownload(opened, scenario, timeoutMs) {
  const started = await opened.page.evaluate(recordPromiseExpression(
    scenario.id, scenario.url, scenario.targetPath, timeoutMs))
  if (started?.started !== true || started.caseId !== scenario.id || started.lane !== 1) {
    throw new Error('SDK1_DOWNLOAD_START_NOT_CONFIRMED')
  }
  return { status: 'STARTED', startedAt: new Date().toISOString(), lane: started.lane }
}

function requireArtifactSnapshot(directory, plan, expected, code) {
  const snapshot = verifyDirectory(directory, plan, expected)
  if (snapshot.validation.status !== 'PASS') {
    const error = new Error(code)
    error.code = code
    error.diagnostic = snapshot
    throw error
  }
  return snapshot
}

function validateTransferRequestRecord(server, routeId, expectedStatus) {
  const matches = server.requests.filter(item => item.routeId === routeId)
  if (matches.length !== 1 || matches[0].method !== 'GET' || matches[0].statusCode !== expectedStatus) {
    throw new Error('LOOPBACK_REQUEST_RECORD_MISMATCH_' + routeId.toLocaleUpperCase('en-US'))
  }
  return matches[0]
}

async function runScenarioChain(session, opened, profile, server, report) {
  const plan = server.plan
  const directory = plan.downloadDirectory
  const success = plan.scenarios.success
  await startRendererDownload(opened, success, 30_000)
  const successState = await waitFor(
    () => readRendererDownloadState(opened.page, success.id),
    value => value?.settled === true,
    30_000,
    'SDK1_DOWNLOAD_SUCCESS_DID_NOT_SETTLE'
  )
  if (successState.error || successState.result?.success !== true) throw new Error('SDK1_DOWNLOAD_SUCCESS_FAILED')
  const successBytesRead = fs.readFileSync(success.targetPath)
  const successCheck = validateSuccessfulDownload(successState.result, successBytesRead, success.targetPath, successfulBytes)
  if (successCheck.status !== 'PASS') {
    const error = new Error('SDK1_DOWNLOAD_SUCCESS_ARTIFACT_MISMATCH')
    error.code = 'SDK1_DOWNLOAD_SUCCESS_ARTIFACT_MISMATCH'
    error.diagnostic = successCheck
    throw error
  }
  const afterSuccess = requireArtifactSnapshot(directory, plan, { presentTargets: ['success'] }, 'SUCCESS_DIRECTORY_STATE_INVALID')
  const successRequest = validateTransferRequestRecord(server, 'success', 200)
  if (successRequest.responseBytesSent !== successfulBytes.length || !successRequest.responseEnded) {
    throw new Error('SUCCESS_FIXTURE_RESPONSE_NOT_COMPLETE')
  }
  report.phases.success = {
    status: 'PASS',
    apiResult: successState.result,
    artifact: successCheck,
    progressCallbacks: successState.progress,
    progressDelivery: successState.progress.length === 1 ? 'FINAL_ONLY' : 'OBSERVED_CALLBACKS',
    directory: afterSuccess.validation,
    loopback: successRequest
  }

  const failed = plan.scenarios.httpFailure
  await startRendererDownload(opened, failed, 30_000)
  const failedState = await waitFor(
    () => readRendererDownloadState(opened.page, failed.id),
    value => value?.settled === true,
    15_000,
    'SDK1_HTTP_FAILURE_DID_NOT_SETTLE'
  )
  if (!failedState.error || failedState.result?.success === true) throw new Error('HTTP_503_WAS_NOT_REJECTED')
  const afterHttpFailure = requireArtifactSnapshot(directory, plan, { presentTargets: ['success'] }, 'HTTP_FAILURE_LEFT_DOWNLOAD_ARTIFACT')
  const failureRequest = validateTransferRequestRecord(server, 'httpFailure', 503)
  if (!failureRequest.responseEnded || failureRequest.responseBytesSent === 0) throw new Error('HTTP_FAILURE_FIXTURE_INVALID')
  report.phases.httpFailure = {
    status: 'PASS',
    rendererError: failedState.error,
    targetAbsent: !fs.existsSync(failed.targetPath),
    temporaryFiles: afterHttpFailure.validation.activeTemporaryTargets,
    directory: afterHttpFailure.validation,
    loopback: failureRequest
  }

  const timed = plan.scenarios.timeout
  await startRendererDownload(opened, timed, 5000)
  const timeoutRequest = await waitFor(
    () => server.requests.find(item => item.routeId === 'timeout') ?? null,
    value => value?.statusCode === 200,
    10_000,
    'TIMEOUT_FIXTURE_REQUEST_NOT_SEEN'
  )
  await waitFor(
    () => {
      const entries = readDownloadEntries(directory)
      return temporaryNamesFor(entries, timed).some(name => fs.statSync(path.join(directory, name)).size > 0)
    },
    Boolean,
    4000,
    'TIMEOUT_PARTIAL_FILE_NOT_OBSERVED'
  )
  const timeoutActive = requireArtifactSnapshot(directory, plan,
    { presentTargets: ['success'], activeTempTargetId: 'timeout' }, 'TIMEOUT_ACTIVE_TEMP_NOT_CONFIRMED')
  const timeoutState = await waitFor(
    () => readRendererDownloadState(opened.page, timed.id),
    value => value?.settled === true,
    10_000,
    'SDK1_REQUEST_TIMEOUT_DID_NOT_SETTLE'
  )
  if (!timeoutState.error || timeoutState.result?.success === true ||
      !/TIMEOUT|超时/i.test(String(timeoutState.error.code) + ' ' + String(timeoutState.error.message))) {
    throw new Error('SDK1_REQUEST_TIMEOUT_NOT_REPORTED')
  }
  await waitFor(
    () => ({ disconnected: timeoutRequest.clientDisconnected, state: verifyDirectory(directory, plan,
      { presentTargets: ['success'] }) }),
    value => value.disconnected === true && value.state.validation.status === 'PASS',
    10_000,
    'TIMEOUT_ABORT_OR_TEMP_CLEANUP_NOT_CONFIRMED'
  )
  const timeoutAfter = requireArtifactSnapshot(directory, plan, { presentTargets: ['success'] },
    'TIMEOUT_LEFT_DOWNLOAD_ARTIFACT')
  report.phases.timeout = {
    status: 'PASS',
    timeoutMs: 5000,
    rendererError: timeoutState.error,
    partialTemporaryObserved: true,
    activeDirectory: timeoutActive.validation,
    targetAbsent: !fs.existsSync(timed.targetPath),
    cleanupDirectory: timeoutAfter.validation,
    serverDisconnected: timeoutRequest.clientDisconnected,
    loopback: timeoutRequest
  }

  const closing = plan.scenarios.windowClose
  await startRendererDownload(opened, closing, 60_000)
  const closeRequest = await waitFor(
    () => server.requests.find(item => item.routeId === 'windowClose') ?? null,
    value => value?.statusCode === 200,
    10_000,
    'WINDOW_CLOSE_FIXTURE_REQUEST_NOT_SEEN'
  )
  await waitFor(
    () => {
      const entries = readDownloadEntries(directory)
      return temporaryNamesFor(entries, closing).some(name => fs.statSync(path.join(directory, name)).size > 0)
    },
    Boolean,
    4000,
    'WINDOW_CLOSE_PARTIAL_FILE_NOT_OBSERVED'
  )
  const closeActive = requireArtifactSnapshot(directory, plan,
    { presentTargets: ['success'], activeTempTargetId: 'windowClose' }, 'WINDOW_CLOSE_ACTIVE_TEMP_NOT_CONFIRMED')
  await session.harness.close(session, pluginId)
  const routeDisconnected = await waitFor(
    () => ({ disconnected: closeRequest.clientDisconnected, snapshot: verifyDirectory(directory, plan,
      { presentTargets: ['success'] }) }),
    value => value.disconnected === true && value.snapshot.validation.status === 'PASS',
    10_000,
    'PLUGIN_WINDOW_CLOSE_DID_NOT_ABORT_DOWNLOAD'
  )
  report.phases.windowClose = {
    status: 'PASS',
    closeMethod: 'public ztools.plugin.close from normal main page',
    pluginTargetClosed: true,
    partialTemporaryObserved: true,
    activeDirectory: closeActive.validation,
    targetAbsent: !fs.existsSync(closing.targetPath),
    cleanupDirectory: routeDisconnected.snapshot.validation,
    serverDisconnected: routeDisconnected.disconnected,
    loopback: closeRequest,
    rendererSettlement: 'UNAVAILABLE_AFTER_OWNER_WEBCONTENTS_DESTROYED'
  }
}

async function canBindLoopbackPort(port) {
  return await new Promise(resolve => {
    const probe = net.createServer()
    probe.once('error', error => resolve({ available: false, code: error?.code ?? 'PORT_PROBE_FAILED' }))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve({ available: true, code: null })))
  })
}

async function assertHarnessPortsReleased() {
  const ports = [9336, 9337]
  for (const port of ports) {
    const result = await canBindLoopbackPort(port)
    if (!result.available) {
      const error = new Error('NORMAL_APP_CDP_PORT_BUSY_' + port)
      error.code = error.message
      error.diagnostic = { port, probeCode: result.code }
      throw error
    }
  }
  return { status: 'PASS', ports, loopbackAddress: '127.0.0.1' }
}

function createInitialReport(runId, output) {
  return {
    schemaVersion: 1,
    runId,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    status: 'FAIL',
    ...createScopeBoundary(),
    normalElectronEntry: true,
    isolatedProfileConfirmed: false,
    output,
    profileRoot: null,
    phases: {},
    inputs: {},
    ownedCleanup: { appInstances: [], loopbackServer: null }
  }
}

function createEvidenceMarkdown(report) {
  const lines = [
    '# F14 / T07 SDK1 正常 Electron 网络下载链',
    '',
    '- Run：' + report.runId,
    '- 结果：**' + report.status + '**（仅本 runner 范围）',
    '- 入口：真实 electron .，Windows x64 Electron ' + (report.inputs.electronVersion ?? 'NOT_RUN'),
    '- 插件：新鲜安装的 batch-text-convert，Windows Electron x64、纯 JS、SDK lane 1',
    '- 隔离 profile：' + (report.profileRoot ?? 'NOT_RUN') + '（保留）',
    '- 下载字节/HTTP 503/超时/关闭插件窗：' +
      ['success', 'httpFailure', 'timeout', 'windowClose'].map(key => key + '=' +
        (report.phases[key]?.status ?? 'NOT_RUN')).join('；'),
    '- 同 profile 重启复读：' + (report.phases.restartRead?.status ?? 'NOT_RUN'),
    '- 明确未关闭：SDK1 没有页面存活期间的逐请求 AbortSignal API；legacy path-based 下载 TOCTOU 仍存在。',
    '- F14 完成：false（未验证市场 resolver、target 绑定 URL/cache/checksum 或后台市场）；T07 完成：false（未公开/接入 FileRef/SaveRef）。',
    '- Mac 实际执行：NOT_RUN；本次仅为 Windows normal Electron SDK1 开发验证。',
    '- 本机 HTTP：只绑定 127.0.0.1 随机端口，使用本 runId 路由；profile 与下载文件由本 runner 创建并保留。',
    '- 原生文件对话框 UI：NOT_RUN，输出目录授权使用 Main Inspector 安装的一次性对话框替身。',
    '- 完整机器报告：' + (report.output ? path.join(report.output, 'report.json') : 'NOT_RUN'),
    ''
  ]
  return lines.join('\n')
}

async function run() {
  const parsed = parseArgs({ options: { zip: { type: 'string' }, help: { type: 'boolean' } } })
  if (parsed.values.help) {
    console.log('node scripts/test-windows-normal-app-network-chain.mjs --zip <fresh batch-text-convert windows-electron-x64 ZIP>')
    console.log('Requires a fresh single-plugin ZIP emitted by plugins/create-plugin. Starts normal electron . with an isolated profile, installs and opens the plugin through the public SDK, then tests SDK1 loopback download success, HTTP 503, timeout, owner-window close, and same-profile restart byte persistence.')
    console.log('Does not enable SDK2 or prove F14/T07 completion; Mac acceptance remains NOT_RUN.')
    return
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log(JSON.stringify({
      status: 'NOT_RUN',
      platform: process.platform,
      arch: process.arch,
      reason: 'WINDOWS_X64_NORMAL_ELECTRON_REQUIRED',
      macAcceptance: 'NOT_RUN'
    }))
    process.exitCode = 1
    return
  }
  if (!parsed.values.zip || !path.win32.isAbsolute(parsed.values.zip)) throw new Error('ZIP_ABSOLUTE_PATH_REQUIRED')
  const runId = randomUUID()
  const outputBase = path.join(clientRoot, 'out-test', 'normal-app-network-chain')
  fs.mkdirSync(outputBase, { recursive: true })
  const output = path.join(outputBase, runId)
  fs.mkdirSync(output, { recursive: false })
  fs.mkdirSync(path.join(output, 'profiles'), { recursive: false })
  const report = createInitialReport(runId, output)
  const sessions = new Set()
  let fixtureServer
  let appHarness
  let errorRecord
  try {
    report.phases.portPreflight = await assertHarnessPortsReleased()
    const versions = readVersions()
    if (versions.sdkContractVersion !== 1) throw new Error('APP_SDK_CONTRACT_NOT_LANE1')
    const sourceManifestPath = path.join(pluginRoot, 'src', 'plugins', pluginId, 'plugin.json')
    const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8'))
    const manifestCheck = validateSdk1PluginManifest(sourceManifest)
    if (manifestCheck.status !== 'PASS') throw new Error('SDK1_PURE_JS_PLUGIN_MANIFEST_INVALID')
    const zipInfo = validateFreshPluginZip(parsed.values.zip, pluginRoot, pluginId)
    const executable = path.join(clientRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    const bootstrap = path.join(clientRoot, 'out', 'main', 'bootstrap.js')
    const webIndex = path.join(clientRoot, 'out', 'assets', 'web', 'index.html')
    for (const [file, code] of [[executable, 'ELECTRON_EXECUTABLE_INVALID'],
      [bootstrap, 'PROJECT_BOOTSTRAP_NOT_BUILT'], [webIndex, 'NORMAL_APP_WEB_BUILD_NOT_FOUND']]) {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code)
    }
    assertPeMachine(executable, PE_MACHINE_X64)
    const bootstrapBytes = fs.readFileSync(bootstrap)
    const executableBytes = fs.readFileSync(executable)
    const profileRoot = path.join(output, 'profiles', 'normal')
    const provisionalPlan = createScenarioPlan(runId, 1, profileRoot, path.join(profileRoot, 'downloads'))
    fixtureServer = await createLoopbackFixtureServer(provisionalPlan, zipInfo)
    report.inputs = {
      appRoot: clientRoot,
      appVersion: versions.appVersion,
      electronVersion: versions.electronVersion,
      sdkContractVersion: versions.sdkContractVersion,
      pluginId,
      pluginVersion: sourceManifest.version,
      pluginManifest: manifestCheck,
      freshZip: {
        path: zipInfo.path,
        fileSize: zipInfo.fileSize,
        sha256: zipInfo.checksum,
        buildRun: zipInfo.buildRun
      },
      electronExecutable: executable,
      electronExecutableSha256: digest(executableBytes),
      bootstrap,
      bootstrapSha256: digest(bootstrapBytes),
      webIndex,
      loopbackAddress: '127.0.0.1',
      loopbackPort: fixtureServer.plan.port,
      fixtureRoutes: fixtureServer.plan.routes,
      f09PortUsePreflight: report.phases.portPreflight
    }
    appHarness = new WindowsNormalAppHarness({
      appRoot: clientRoot,
      executable,
      outputRoot: output,
      versions,
      ports: { cdp: 9336, inspect: 9337 }
    })
    const profile = appHarness.createProfile(path.join(output, 'profiles', 'normal'))
    const downloadDirectory = path.join(profile.root, 'downloads')
    report.profileRoot = profile.root
    report.isolatedProfileConfirmed = true
    const first = await appHarness.start({ profile, phase: 'network-first-start', report })
    first.harness = appHarness
    sessions.add(first)
    report.phases.firstStart = {
      status: 'PASS',
      mainIdentity: first.mainIdentity,
      rendererIdentity: first.rendererIdentity,
      process: first.processRecord,
      configuredPaths: first.configuredPaths
    }
    const installed = await appHarness.install(first, {
      pluginId,
      zipInfo,
      zipUrl: fixtureServer.plan.archive.url,
      version: sourceManifest.version
    })
    const installedManifestCheck = validateSdk1PluginManifest(installed.manifest)
    if (installedManifestCheck.status !== 'PASS') throw new Error('INSTALLED_PLUGIN_TARGET_OR_LANE_INVALID')
    const archiveRecord = validateTransferRequestRecord(fixtureServer, 'pluginZip', 200)
    if (archiveRecord.responseBytesSent !== zipInfo.fileSize || !archiveRecord.responseEnded) {
      throw new Error('PLUGIN_INSTALL_BYTES_NOT_CONFIRMED')
    }
    report.phases.install = {
      status: 'PASS',
      pluginDirectory: installed.pluginDirectory,
      manifest: installed.manifest,
      manifestCheck: installedManifestCheck,
      fileHashes: installed.fileHashes,
      accepted: installed.accepted,
      archiveRequest: archiveRecord
    }
    const opened = await appHarness.open(first, pluginId)
    const sdkIdentity = await inspectSdkLane(opened.page)
    if (sdkIdentity.isElectron !== true || sdkIdentity.contractVersion !== 1 ||
        sdkIdentity.networkDownloadType !== 'function' || sdkIdentity.nodeType !== 'undefined' ||
        sdkIdentity.requireType !== 'undefined') {
      throw new Error('SDK1_PLUGIN_RENDERER_IDENTITY_INVALID')
    }
    report.phases.pluginOpen = {
      status: 'PASS',
      targetId: opened.target.id,
      targetUrl: opened.target.url,
      commitProof: opened.commitProof,
      identity: sdkIdentity
    }
    const grants = await installDialogGrant(first, opened, profile, report)
    const actualPlan = createScenarioPlan(runId, fixtureServer.plan.port, profile.root, grants.downloadDirectory)
    if (normalizeWindowsPath(actualPlan.downloadDirectory) !== normalizeWindowsPath(downloadDirectory)) {
      throw new Error('SDK_DIALOG_DOWNLOAD_DIRECTORY_MISMATCH')
    }
    fixtureServer.plan = actualPlan
    report.inputs.fixtureRoutes = actualPlan.routes
    report.inputs.downloadDirectory = actualPlan.downloadDirectory

    await runScenarioChain(first, opened, profile, fixtureServer, report)
    await appHarness.stop(first)
    report.phases.firstExit = {
      status: first.processRecord.cleanup?.cleanupConfirmed && first.processRecord.cleanup?.exit?.code === 0 ? 'PASS' : 'FAIL',
      ...first.processRecord.cleanup
    }
    report.ownedCleanup.appInstances.push({
      phase: 'first',
      pid: first.child?.pid ?? null,
      result: first.processRecord?.cleanup ?? null
    })
    sessions.delete(first)
    if (report.phases.firstExit.status !== 'PASS') throw new Error('FIRST_APP_QUIT_NOT_CONFIRMED')

    const second = await appHarness.start({ profile, phase: 'network-same-profile-restart', report })
    second.harness = appHarness
    sessions.add(second)
    const reopened = await appHarness.open(second, pluginId)
    const restartedIdentity = await inspectSdkLane(reopened.page)
    if (restartedIdentity.isElectron !== true || restartedIdentity.contractVersion !== 1 ||
        restartedIdentity.networkDownloadType !== 'function') {
      throw new Error('RESTARTED_PLUGIN_SDK1_IDENTITY_INVALID')
    }
    const persistedBytes = fs.readFileSync(actualPlan.scenarios.success.targetPath)
    if (!persistedBytes.equals(successfulBytes)) throw new Error('SAME_PROFILE_RESTART_BYTES_MISMATCH')
    report.phases.restartRead = {
      status: 'PASS',
      rendererIdentity: restartedIdentity,
      profileRoot: profile.root,
      filePath: actualPlan.scenarios.success.targetPath,
      fileSize: persistedBytes.length,
      fileSha256: digest(persistedBytes),
      originalTransferSha256: digest(successfulBytes),
      bytesMatchOriginalTransfer: persistedBytes.equals(successfulBytes)
    }
    await appHarness.close(second, pluginId)
    await appHarness.stop(second)
    report.phases.restartExit = {
      status: second.processRecord.cleanup?.cleanupConfirmed && second.processRecord.cleanup?.exit?.code === 0 ? 'PASS' : 'FAIL',
      ...second.processRecord.cleanup
    }
    report.ownedCleanup.appInstances.push({
      phase: 'restart',
      pid: second.child?.pid ?? null,
      result: second.processRecord?.cleanup ?? null
    })
    sessions.delete(second)
    if (report.phases.restartExit.status !== 'PASS') throw new Error('RESTARTED_APP_QUIT_NOT_CONFIRMED')
    report.phases.profilePreserved = {
      status: fs.existsSync(profile.root) &&
        fs.existsSync(path.join(profile.appDataPath, 'ZTools', 'Data', 'Plugins', pluginId)) &&
        fs.existsSync(actualPlan.scenarios.success.targetPath) ? 'PASS' : 'FAIL',
      root: profile.root,
      appDataPath: profile.appDataPath,
      pluginDirectory: path.join(profile.appDataPath, 'ZTools', 'Data', 'Plugins', pluginId),
      successFile: actualPlan.scenarios.success.targetPath
    }
    if (report.phases.profilePreserved.status !== 'PASS') throw new Error('NORMAL_APP_PROFILE_NOT_PRESERVED')
  } catch (error) {
    errorRecord = safeError(error)
    report.error = { ...errorRecord, diagnostic: error?.diagnostic ?? null }
    report.status = 'FAIL'
  } finally {
    for (const session of [...sessions].reverse()) {
      if (session.networkDialogStubInstalled) {
        try {
          const restore = await session.inspector?.evaluate(buildDialogRestoreExpression())
          report.ownedCleanup.dialogRestore = restore ?? { status: 'NOT_RUN' }
        } catch (error) {
          report.ownedCleanup.dialogRestore = { status: 'FAIL', error: safeError(error) }
        }
      }
      try {
        await appHarness?.stop(session)
        report.ownedCleanup.appInstances.push({
          pid: session.child?.pid ?? null,
          result: session.processRecord?.cleanup ?? null
        })
      } catch (error) {
        report.ownedCleanup.appInstances.push({ pid: session.child?.pid ?? null, error: safeError(error) })
        report.status = 'FAIL'
      }
    }
    if (fixtureServer) {
      try {
        report.ownedCleanup.loopbackServer = {
          result: await fixtureServer.close(),
          remainingOwnedSockets: fixtureServer.sockets.size
        }
      } catch (error) {
        report.ownedCleanup.loopbackServer = { error: safeError(error) }
        report.status = 'FAIL'
      }
      report.phases.loopbackRequests = {
        status: fixtureServer.requests.every(item => item.statusCode !== 404 && item.statusCode !== 405) ? 'PASS' : 'FAIL',
        requests: fixtureServer.requests
      }
    }
    const required = [
      'portPreflight', 'firstStart', 'install', 'pluginOpen', 'dialogGrant', 'success',
      'httpFailure', 'timeout', 'windowClose', 'firstExit', 'restartRead', 'restartExit', 'profilePreserved'
    ]
    const complete = required.every(key => report.phases[key]?.status === 'PASS') &&
      report.phases.loopbackRequests?.status === 'PASS' &&
      report.ownedCleanup.appInstances.every(item => item.result?.cleanupConfirmed === true) &&
      report.ownedCleanup.loopbackServer?.result?.closed === true &&
      report.ownedCleanup.loopbackServer.remainingOwnedSockets === 0
    if (complete && !errorRecord) report.status = 'PASS'
    else if (!report.error) report.status = 'FAIL'
    report.finishedAt = new Date().toISOString()
    const reportPath = path.join(output, 'report.json')
    const markdownPath = path.join(output, 'report.md')
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    fs.writeFileSync(markdownPath, createEvidenceMarkdown(report), { flag: 'wx' })
    console.log(JSON.stringify({
      status: report.status,
      runId,
      output,
      reportPath,
      markdownPath,
      profileRoot: report.profileRoot,
      f14Complete: report.f14Complete,
      t07Complete: report.t07Complete,
      macAcceptance: report.macAcceptance,
      error: report.error ?? null
    }, null, 2))
  }
  if (report.status !== 'PASS') process.exitCode = 1
}

const invokedAsScript = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href.toLocaleLowerCase('en-US') === import.meta.url.toLocaleLowerCase('en-US')
if (invokedAsScript) {
  run().catch(error => {
    console.error(JSON.stringify({ status: 'FAIL', error: safeError(error) }))
    process.exitCode = 1
  })
}
