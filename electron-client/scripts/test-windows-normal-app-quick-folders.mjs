import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'
import { WindowsNormalAppHarness, startLoopbackZipServer, closeLoopbackZipServer } from './lib/windows-normal-app-harness.mjs'
import { validateFreshPluginZip, digest } from './windows-normal-app-plugin-file-chain-lib.mjs'
import {
  QUICK_FOLDERS_DIALOG_TITLE,
  QUICK_FOLDERS_DOCUMENT_IDS,
  QUICK_FOLDERS_MAIN_STATE_KEY,
  QUICK_FOLDERS_NORMAL_APP_MATRIX,
  QUICK_FOLDERS_PLUGIN_ID,
  advanceFavoriteReadFailure,
  advanceFolderDialog,
  buildQuickFoldersMainGuardInstallExpression,
  buildQuickFoldersMainGuardReportExpression,
  buildQuickFoldersMainGuardRestoreExpression,
  classifyQuickFoldersPowerShellRequest,
  summarizeQuickFoldersDocuments
} from './lib/windows-normal-app-quick-folders-lib.mjs'

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(clientRoot, '..')
const pluginRoot = path.join(repositoryRoot, 'plugins', 'create-plugin')
const sourcePluginRoot = path.join(pluginRoot, 'src', 'plugins', QUICK_FOLDERS_PLUGIN_ID)
const runnerPath = fileURLToPath(import.meta.url)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function errorCode(error) {
  const value = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : ''
  return /^[A-Z0-9_]{1,96}$/.test(value) ? value : 'QUICK_FOLDERS_NORMAL_APP_UNCLASSIFIED_FAILURE'
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
  return { appName, appVersion: packageInfo.version, electronVersion: electron.version, sdkContractVersion: Number(sdk[1]) }
}

export function parseQuickFoldersRunnerArgs(args) {
  const parsed = parseArgs({ args, options: { help: { type: 'boolean' }, zip: { type: 'string' } }, strict: true, allowPositionals: false })
  if (parsed.values.help) return { help: true }
  if (typeof parsed.values.zip !== 'string' || !parsed.values.zip.trim()) throw new Error('P031_PLUGIN_ZIP_REQUIRED')
  if (!path.isAbsolute(parsed.values.zip)) throw new Error('P031_PLUGIN_ZIP_MUST_BE_ABSOLUTE')
  return { help: false, zipPath: path.resolve(parsed.values.zip) }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

function recordHash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

async function waitFor(read, accept, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(code)
}

function quickFoldersTargetSnapshotExpression(selector, label, matchMode = 'exact') {
  if (typeof selector !== 'string' || !selector.trim()) throw new Error('QUICK_FOLDERS_TARGET_SELECTOR_REQUIRED')
  if (label !== null && typeof label !== 'string') throw new Error('QUICK_FOLDERS_TARGET_LABEL_INVALID')
  if (matchMode !== 'exact' && matchMode !== 'includes') throw new Error('QUICK_FOLDERS_TARGET_MATCH_MODE_INVALID')
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    const label = ${JSON.stringify(label)};
    const matchMode = ${JSON.stringify(matchMode)};
    const normalize = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
    const elements = [...document.querySelectorAll(selector)].filter(element => {
      if (label === null) return true;
      const text = normalize(element.innerText || element.textContent);
      const comparableText = text.replace(/\\s+/g, '');
      const comparableLabel = String(label).replace(/\\s+/g, '');
      return matchMode === 'exact' ? comparableText === comparableLabel : comparableText.includes(comparableLabel);
    });
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    return { selector, label, count: elements.length, viewport, candidates: elements.map((element, index) => {
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      let ancestorsVisible = true;
      for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
        const currentStyle = getComputedStyle(current);
        if (currentStyle.display === 'none' || currentStyle.visibility === 'hidden' || currentStyle.visibility === 'collapse' ||
            Number(currentStyle.opacity) <= 0 || current.hidden) { ancestorsVisible = false; break; }
      }
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = x >= 0 && y >= 0 && x < viewport.width && y < viewport.height ? document.elementFromPoint(x, y) : null;
      const disabled = element.disabled === true || element.getAttribute('aria-disabled') === 'true';
      const actionable = element.isConnected && !disabled && rect.width > 0 && rect.height > 0 && ancestorsVisible &&
        style.display !== 'none' && style.visibility === 'visible' && x >= 0 && y >= 0 &&
        x < viewport.width && y < viewport.height && Boolean(hit) && (hit === element || element.contains(hit));
      return { index, text: normalize(element.innerText || element.textContent), actionable,
        disabled, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        style: { display: style.display, visibility: style.visibility, opacity: style.opacity }, hit: Boolean(hit) };
    }) };
  })()`
}

function isQuickFoldersTargetActionable(snapshot) {
  if (!snapshot || snapshot.count !== 1 || !Array.isArray(snapshot.candidates) || snapshot.candidates.length !== 1) return false
  const candidate = snapshot.candidates[0]
  const rect = candidate?.rect
  return candidate?.actionable === true && candidate.disabled === false && candidate.hit === true &&
    rect && Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
    rect.width > 0 && rect.height > 0 && snapshot.viewport && Number.isFinite(snapshot.viewport.width) &&
    Number.isFinite(snapshot.viewport.height) && rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.width <= snapshot.viewport.width && rect.y + rect.height <= snapshot.viewport.height
}

function quickFoldersTargetGeometryStable(before, after, tolerance = 0.5) {
  if (!isQuickFoldersTargetActionable(before) || !isQuickFoldersTargetActionable(after) || before.selector !== after.selector ||
      before.label !== after.label || before.candidates[0].text !== after.candidates[0].text) return false
  return ['x', 'y', 'width', 'height'].every(key =>
    Math.abs(before.candidates[0].rect[key] - after.candidates[0].rect[key]) <= tolerance)
}

async function clickTarget(page, selector, label = null, matchMode = 'exact', button = 'left') {
  const expression = quickFoldersTargetSnapshotExpression(selector, label, matchMode)
  let before = null
  const after = (await waitFor(async () => {
    const snapshot = await page.evaluate(expression)
    const stable = quickFoldersTargetGeometryStable(before, snapshot)
    before = isQuickFoldersTargetActionable(snapshot) ? snapshot : null
    return { stable, snapshot }
  }, value => value.stable, 5000, 'QUICK_FOLDERS_UI_TARGET_GEOMETRY_UNSTABLE')).snapshot
  const rect = after.candidates[0].rect
  const x = rect.x + rect.width / 2
  const y = rect.y + rect.height / 2
  const right = button === 'right'
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: right ? 2 : 1, clickCount: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 })
  return { selector, label, button, x, y, text: after.candidates[0].text }
}

async function replaceInputText(page, selector, value) {
  await clickTarget(page, selector)
  await page.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 })
  await page.call('Input.insertText', { text: value })
}

function publicDatabaseReadExpression() {
  return `(async () => {
    const database = window.ztools?.db;
    if (!database || typeof database.setPluginId !== 'function' || typeof database.allDocs !== 'function') {
      throw new Error('QUICK_FOLDERS_PUBLIC_DATABASE_API_UNAVAILABLE');
    }
    await database.setPluginId('quick-folders');
    const [favoriteRows, customizationRows] = await Promise.all([
      database.allDocs('favorite-folders'), database.allDocs('folder-customizations')
    ]);
    if (!Array.isArray(favoriteRows) || !Array.isArray(customizationRows)) throw new Error('QUICK_FOLDERS_PUBLIC_DATABASE_RESULT_INVALID');
    const exact = (rows, id) => {
      const matches = rows.filter(row => row && typeof row === 'object' && row._id === id);
      if (matches.length > 1) throw new Error('QUICK_FOLDERS_PUBLIC_DATABASE_DUPLICATE_DOCUMENT');
      return matches[0] ?? null;
    };
    return {
      favorites: exact(favoriteRows, 'favorite-folders'),
      customizations: exact(customizationRows, 'folder-customizations')
    };
  })()`
}

async function readPublicDatabase(page) {
  const documents = await page.evaluate(publicDatabaseReadExpression())
  if (!documents || typeof documents !== 'object') throw new Error('QUICK_FOLDERS_PUBLIC_DATABASE_RESULT_INVALID')
  return documents
}

function quickFoldersUiStateExpression() {
  return `(() => ({
    url: location.href,
    alertText: document.querySelector('.qf-content [role="alert"]')?.innerText?.trim() ?? null,
    reloadVisible: [...document.querySelectorAll('button')].some(button => button.innerText?.trim() === '重新读取'),
    cardNames: [...document.querySelectorAll('.qf-card-name')].map(item => item.innerText.trim()),
    dialogTitle: document.querySelector('.ant-modal-title')?.innerText?.trim() ?? null,
    favoriteTabSelected: [...document.querySelectorAll('[role="tab"]')].some(tab => tab.innerText.includes('收藏') && tab.getAttribute('aria-selected') === 'true')
  }))()`
}

async function readGuard(session, token) {
  return await session.inspector.evaluate(buildQuickFoldersMainGuardReportExpression(token), { timeoutMs: 5000 })
}

async function installGuard(session, config) {
  const installed = await session.inspector.evaluate(buildQuickFoldersMainGuardInstallExpression(config), { timeoutMs: 5000 })
  if (installed?.installed !== true || installed.token !== config.token) throw new Error('QUICK_FOLDERS_MAIN_GUARD_INSTALL_FAILED')
  return installed
}

async function restoreGuard(session, token) {
  const restored = await session.inspector.evaluate(buildQuickFoldersMainGuardRestoreExpression(token), { timeoutMs: 5000 })
  if (restored?.restored !== true || !Array.isArray(restored.methods) || restored.methods.length !== 3 || restored.methods.some(value => value !== true)) {
    throw new Error('QUICK_FOLDERS_MAIN_GUARD_RESTORE_UNCONFIRMED')
  }
  return restored
}

function exactDocument(documents, key) {
  const value = documents?.[key]
  if (value === null) return null
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) throw new Error('QUICK_FOLDERS_DOCUMENT_SHAPE_INVALID')
  return value
}

function verifySyntheticDocuments(documents, syntheticFolderPath, expectedName, expectedIcon) {
  const favorites = exactDocument(documents, 'favorites')
  const customizations = exactDocument(documents, 'customizations')
  if (!favorites || favorites.items.length !== 1 || favorites.items[0]?.path !== syntheticFolderPath ||
      typeof favorites.items[0]?.id !== 'string' || typeof favorites.items[0]?.name !== 'string') {
    throw new Error('QUICK_FOLDERS_FAVORITE_DOCUMENT_MISMATCH')
  }
  if (!customizations || customizations.items.length !== 1 || customizations.items[0]?.path !== syntheticFolderPath ||
      customizations.items[0]?.name !== expectedName || customizations.items[0]?.icon !== expectedIcon ||
      typeof customizations.items[0]?.updatedAt !== 'string' || !Number.isFinite(Date.parse(customizations.items[0].updatedAt))) {
    throw new Error('QUICK_FOLDERS_CUSTOMIZATION_DOCUMENT_MISMATCH')
  }
  return { documents, digest: recordHash(documents), favoritesCount: favorites.items.length,
    customizationsCount: customizations.items.length, favoriteId: favorites.items[0].id,
    favoriteBaseName: favorites.items[0].name, customizationName: customizations.items[0].name,
    customizationIcon: customizations.items[0].icon }
}

async function waitForBlockedSystemRead(session, token, minimumCount, code) {
  return await waitFor(() => readGuard(session, token), value =>
    value.blockedProcessCallCount >= minimumCount && value.expectedSystemReadBlockCount >= minimumCount &&
    value.unexpectedQuickFoldersProcessCount === 0 && value.unverifiedProcessCallerCount === 0,
  15_000, code)
}

function requireOwnedDirectory(directory, allowedRoot) {
  const absolute = path.resolve(directory)
  const relative = path.relative(path.resolve(allowedRoot), absolute)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('QUICK_FOLDERS_OUTPUT_PATH_OUTSIDE_RUN')
  }
  const stat = fs.lstatSync(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(fs.realpathSync.native(absolute)) !== absolute) {
    throw new Error('QUICK_FOLDERS_OUTPUT_DIRECTORY_INVALID')
  }
  return absolute
}

function createReport(runId, zipPath) {
  return {
    schemaVersion: 1,
    phases: {},
    runId,
    createdAt: new Date().toISOString(),
    pluginId: QUICK_FOLDERS_PLUGIN_ID,
    pluginZipPath: zipPath,
    status: 'NOT_RUN',
    windowsNormalAppAcceptance: 'NOT_RUN',
    systemRecords: { status: 'NOT_RUN', recent: 'NOT_READ', typedPaths: 'NOT_READ', quickAccess: 'NOT_READ',
      enforcement: 'Main ProcessService.start guard throws before spawn for quick-folders callers' },
    nativeFolderDialogUi: 'NOT_RUN_MAIN_ONLY_SYNTHETIC_DIALOG_RESULT',
    macOSDeviceExecution: 'NOT_RUN',
    publicDatabase: 'window.ztools.db.setPluginId + allDocs + plugin UI writes',
    scenarioMatrix: QUICK_FOLDERS_NORMAL_APP_MATRIX,
    steps: [],
    sessions: [],
    errors: []
  }
}

function recordStep(report, id, status, details = {}) {
  report.steps.push({ id, status, ...details })
}

function createRunOutput(runId) {
  const outputBase = path.join(clientRoot, 'out-test', 'normal-app-quick-folders')
  fs.mkdirSync(outputBase, { recursive: true })
  const realBase = fs.realpathSync.native(outputBase)
  if (path.resolve(realBase) !== path.resolve(outputBase)) throw new Error('QUICK_FOLDERS_OUTPUT_BASE_REALPATH_MISMATCH')
  const outputRoot = path.join(outputBase, runId)
  fs.mkdirSync(outputRoot, { recursive: false })
  requireOwnedDirectory(outputRoot, outputBase)
  const fixturesRoot = path.join(outputRoot, 'fixtures')
  const syntheticFolderPath = path.join(fixturesRoot, 'P031-Synthetic-Favorite')
  fs.mkdirSync(syntheticFolderPath, { recursive: true })
  requireOwnedDirectory(fixturesRoot, outputRoot)
  requireOwnedDirectory(syntheticFolderPath, outputRoot)
  return { outputRoot, syntheticFolderPath }
}

async function stopSession(harness, session, token, reportRecord) {
  if (!session) return { stopped: true, cleanupConfirmed: true, ownedPid: null }
  if (token && reportRecord?.mainGuardRestore?.restored !== true) {
    try {
      reportRecord.mainGuardRestore = await restoreGuard(session, token)
    } catch (error) {
      reportRecord.mainGuardRestore = { restored: false, code: errorCode(error) }
    }
  }
  const stopped = await harness.stop(session)
  reportRecord.stop = stopped
  if (reportRecord.mainGuardRestore?.restored !== true) reportRecord.failure = 'QUICK_FOLDERS_MAIN_GUARD_RESTORE_UNCONFIRMED'
  return stopped
}

async function runNormalApp(zipPath) {
  if (process.platform !== 'win32') throw new Error('P031_WINDOWS_NORMAL_APP_ONLY')
  const runId = randomUUID()
  const report = createReport(runId, zipPath)
  const stoppedSessions = []
  let zipServer = null
  let harness = null
  let active = null
  let activeToken = null
  let activeSessionRecord = null
  let thrown = null
  const runPaths = createRunOutput(runId)
  report.outputRoot = runPaths.outputRoot
  report.syntheticFolderPath = runPaths.syntheticFolderPath

  try {
    const versions = readVersions()
    const manifest = JSON.parse(fs.readFileSync(path.join(sourcePluginRoot, 'plugin.json'), 'utf8'))
    const expectedTarget = { id: 'windows-electron-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }
    if (manifest.id !== QUICK_FOLDERS_PLUGIN_ID || !/Windows/i.test(manifest.description) ||
        JSON.stringify(manifest.targets) !== JSON.stringify([expectedTarget]) || !Array.isArray(manifest.nativeComponents) ||
        manifest.nativeComponents.length !== 0) {
      throw new Error('QUICK_FOLDERS_SOURCE_MANIFEST_SCOPE_INVALID')
    }
    const executable = path.join(clientRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    assertPeMachine(executable, PE_MACHINE_X64)
    const zipInfo = validateFreshPluginZip(zipPath, pluginRoot, QUICK_FOLDERS_PLUGIN_ID)
    report.input = { appVersion: versions.appVersion, electronVersion: versions.electronVersion,
      sdkContractVersion: versions.sdkContractVersion, runtimeExecutable: executable,
      runtimeExecutableSha256: digest(fs.readFileSync(executable)), pluginZipSha256: zipInfo.checksum,
      pluginVersion: manifest.version, targetScope: Array.isArray(manifest.targets) ? manifest.targets.map(item => item.platform) : ['LEGACY_WINDOWS_SOURCE_ONLY'],
      mainBootstrapSha256: digest(fs.readFileSync(path.join(clientRoot, 'out', 'main', 'bootstrap.js'))) }
    zipServer = await startLoopbackZipServer(zipInfo, 'quick-folders.zip', runId)
    report.installServer = { host: '127.0.0.1', port: zipServer.port, requests: zipServer.requests }
    harness = new WindowsNormalAppHarness({ appRoot: clientRoot, executable,
      outputRoot: runPaths.outputRoot, versions })
    const profile = harness.createProfile(path.join(runPaths.outputRoot, 'profile'))
    report.profile = { root: profile.root, appDataPath: profile.appDataPath, userDataPath: profile.userDataPath,
      sessionDataPath: profile.sessionDataPath, tempPath: profile.tempPath }
    const hookFactory = (session, { injectFavoriteFailure, allowOneFolderDialog }) => {
      const token = randomUUID()
      const installConfig = { token, outputRoot: runPaths.outputRoot, syntheticFolderPath: runPaths.syntheticFolderPath,
        expectedTempPath: path.join(profile.userDataPath, 'Cache',
          'plugin-' + Buffer.from(QUICK_FOLDERS_PLUGIN_ID, 'utf8').toString('base64url'), 'Temp'),
        injectFavoriteFailure, allowOneFolderDialog }
      return { token, install: () => installGuard(session, installConfig) }
    }

    active = await harness.start({ profile, phase: 'p031-initial', report })
    activeSessionRecord = { phase: 'initial', pid: active.child.pid, mainIdentity: active.mainIdentity,
      hooks: null, interactions: [], mainGuardRestore: null }
    report.sessions.push(activeSessionRecord)
    const firstHook = hookFactory(active, { injectFavoriteFailure: true, allowOneFolderDialog: true })
    activeToken = firstHook.token
    activeSessionRecord.hooks = await firstHook.install()
    if (activeSessionRecord.hooks.installed !== true) throw new Error('QUICK_FOLDERS_MAIN_GUARD_INSTALL_FAILED')
    recordStep(report, 'normal-app-start-main-identity-isolated-profile', 'PASS', { phase: 'initial', pid: active.child.pid,
      mainIdentity: active.mainIdentity, profile: active.profile })

    const installed = await harness.install(active, { pluginId: QUICK_FOLDERS_PLUGIN_ID, zipInfo,
      zipUrl: zipServer.url, version: manifest.version, pluginRoot })
    activeSessionRecord.install = installed
    if (zipServer.requests.filter(item => item.status === 200).length !== 1) throw new Error('QUICK_FOLDERS_ZIP_INSTALL_REQUEST_NOT_EXACTLY_ONCE')
    recordStep(report, 'fresh-zip-public-install', 'PASS', { installedPluginDirectory: installed.pluginDirectory,
      fileHashes: installed.fileHashes, loopbackRequests: zipServer.requests })

    let opened = await harness.open(active, QUICK_FOLDERS_PLUGIN_ID)
    activeSessionRecord.open = opened.identity
    const failedState = await waitFor(() => opened.page.evaluate(quickFoldersUiStateExpression()),
      value => typeof value?.alertText === 'string' && value.alertText.includes('收藏和自定义数据读取失败') && value.reloadVisible,
      20_000, 'QUICK_FOLDERS_INITIAL_READ_FAILURE_UI_MISSING')
    const failureGuard = await readGuard(active, activeToken)
    if (failureGuard.favoriteFailureInjectedCount !== 1 || failureGuard.favoriteFailureState !== 'CONSUMED' ||
        failureGuard.unverifiedQuickFoldersCallCount !== 0) throw new Error('QUICK_FOLDERS_EXACT_READ_FAILURE_NOT_PROVEN')
    activeSessionRecord.interactions.push({ id: 'initial-db-read-failure', ui: failedState,
      guard: failureGuard, retryButtonAction: 'PENDING' })
    recordStep(report, 'one-exact-favorite-query-failure-visible-without-mutation', 'PASS', {
      errorAlert: failedState.alertText, injectedFailureCount: failureGuard.favoriteFailureInjectedCount,
      failureState: failureGuard.favoriteFailureState })

    const retryAction = await clickTarget(opened.page, 'button', '重新读取')
    activeSessionRecord.interactions[0].retryButtonAction = retryAction
    const loadedState = await waitFor(() => opened.page.evaluate(quickFoldersUiStateExpression()),
      value => value?.alertText === null && !value?.reloadVisible,
      20_000, 'QUICK_FOLDERS_RETRY_DID_NOT_RECOVER')
    const afterRetryGuard = await waitForBlockedSystemRead(active, activeToken, 1, 'QUICK_FOLDERS_SYSTEM_READ_NOT_BLOCKED_AFTER_RETRY')
    const emptyDocuments = await readPublicDatabase(opened.page)
    if (emptyDocuments.favorites !== null || emptyDocuments.customizations !== null) throw new Error('QUICK_FOLDERS_FRESH_PROFILE_NOT_EMPTY')
    activeSessionRecord.interactions.push({ id: 'retry-real-isolated-db-query', ui: loadedState,
      guard: afterRetryGuard, publicDatabase: emptyDocuments })
    recordStep(report, 'retry-loads-real-empty-plugin-database-and-blocks-system-read', 'PASS', {
      uiAlertCleared: loadedState.alertText === null, systemProcessBlocked: afterRetryGuard.expectedSystemReadBlockCount,
      systemRecordsRead: false, publicDocumentIds: [] })

    const addAction = await clickTarget(opened.page, 'button.qf-toolbar-add', '添加收藏')
    const afterDialogGuard = await waitFor(() => readGuard(active, activeToken), value => value.folderDialogAcceptedCount === 1,
      10_000, 'QUICK_FOLDERS_CONTROLLED_FOLDER_DIALOG_NOT_USED')
    const favoriteExpectedPath = path.resolve(runPaths.syntheticFolderPath)
    const favoriteDocuments = await waitFor(() => readPublicDatabase(opened.page), value => {
      const favorites = value?.favorites
      return favorites && Array.isArray(favorites.items) && favorites.items.some(item => item?.path === favoriteExpectedPath)
    }, 15_000, 'QUICK_FOLDERS_FAVORITE_NOT_PERSISTED')
    const favoriteValidation = summarizeQuickFoldersDocuments(favoriteDocuments.favorites, favoriteDocuments.customizations)
    if (favoriteValidation.favorites.itemCount !== 1 || favoriteValidation.customizations.itemCount !== 0) {
      throw new Error('QUICK_FOLDERS_FAVORITE_PUBLIC_DB_SHAPE_INVALID')
    }
    activeSessionRecord.interactions.push({ id: 'add-synthetic-favorite', action: addAction,
      dialogGuard: afterDialogGuard, publicDatabase: favoriteDocuments })
    recordStep(report, 'trusted-add-favorite-uses-single-main-dialog-substitute-and-real-db-put', 'PASS', {
      folderDialogAttempts: afterDialogGuard.folderDialogAttemptCount, folderDialogAccepted: afterDialogGuard.folderDialogAcceptedCount,
      syntheticDirectory: favoriteExpectedPath, favoritesDocumentCount: favoriteValidation.favorites.itemCount,
      nativeDialogUi: 'NOT_RUN' })

    await clickTarget(opened.page, '[role="tab"]', '收藏', 'includes')
    const cardReady = await waitFor(() => opened.page.evaluate(quickFoldersUiStateExpression()),
      value => value?.favoriteTabSelected === true && value.cardNames?.length === 1,
      10_000, 'QUICK_FOLDERS_FAVORITE_CARD_NOT_VISIBLE')
    const contextAction = await clickTarget(opened.page, '.qf-card[role="listitem"]', null, 'exact', 'right')
    const editorState = await waitFor(() => opened.page.evaluate(quickFoldersUiStateExpression()),
      value => value?.dialogTitle === '编辑文件夹显示', 10_000, 'QUICK_FOLDERS_CUSTOMIZATION_EDITOR_NOT_OPEN')
    await replaceInputText(opened.page, '.qf-editor input', 'P031 合成收藏')
    const iconAction = await clickTarget(opened.page, '.qf-icon-option', '主页')
    const saveAction = await clickTarget(opened.page, '.ant-modal-footer button.ant-btn-primary', '保存')
    const customizationDocuments = await waitFor(() => readPublicDatabase(opened.page), value => {
      const items = value?.customizations?.items
      return Array.isArray(items) && items.some(item => item?.path === favoriteExpectedPath &&
        item?.name === 'P031 合成收藏' && item?.icon === 'home')
    }, 15_000, 'QUICK_FOLDERS_CUSTOMIZATION_NOT_PERSISTED')
    const customizationValidation = verifySyntheticDocuments(customizationDocuments, favoriteExpectedPath,
      'P031 合成收藏', 'home')
    const customizedUi = await waitFor(() => opened.page.evaluate(quickFoldersUiStateExpression()),
      value => value?.cardNames?.includes('P031 合成收藏'), 10_000, 'QUICK_FOLDERS_CUSTOMIZATION_UI_NOT_UPDATED')
    activeSessionRecord.interactions.push({ id: 'customize-synthetic-favorite', before: cardReady,
      contextMenuAction: contextAction, editor: editorState, iconAction, saveAction,
      publicDatabase: customizationValidation, ui: customizedUi })
    recordStep(report, 'trusted-context-menu-customization-persists-name-icon-and-timestamp', 'PASS', {
      favoritesCount: customizationValidation.favoritesCount, customizationsCount: customizationValidation.customizationsCount,
      customizationName: customizationValidation.customizationName, customizationIcon: customizationValidation.customizationIcon,
      documentDigest: customizationValidation.digest })
    const expectedDocuments = customizationDocuments
    const expectedDigest = recordHash(expectedDocuments)

    await harness.close(active, QUICK_FOLDERS_PLUGIN_ID)
    recordStep(report, 'plugin-close', 'PASS', { phase: 'initial' })
    const processCountBeforeReopen = afterRetryGuard.blockedProcessCallCount
    opened = await harness.open(active, QUICK_FOLDERS_PLUGIN_ID)
    const reopenedInitial = await waitFor(() => readPublicDatabase(opened.page), value => {
      try { return verifySyntheticDocuments(value, favoriteExpectedPath, 'P031 合成收藏', 'home').digest === expectedDigest }
      catch { return false }
    }, 15_000, 'QUICK_FOLDERS_CLOSE_REOPEN_DATABASE_MISMATCH')
    const reopenedProcess = await waitForBlockedSystemRead(active, activeToken, processCountBeforeReopen + 1,
      'QUICK_FOLDERS_REOPEN_SYSTEM_READ_NOT_BLOCKED')
    const reopenedUi = await waitFor(() => opened.page.evaluate(quickFoldersUiStateExpression()),
      value => value?.cardNames?.includes('P031 合成收藏'), 10_000, 'QUICK_FOLDERS_CLOSE_REOPEN_UI_MISMATCH')
    activeSessionRecord.interactions.push({ id: 'close-reopen-same-process', digest: recordHash(reopenedInitial),
      processGuard: reopenedProcess, ui: reopenedUi })
    recordStep(report, 'close-reopen-retains-public-db-documents', 'PASS', {
      documentDigest: recordHash(reopenedInitial), systemProcessBlocked: reopenedProcess.blockedProcessCallCount,
      displayNameVisible: reopenedUi.cardNames.includes('P031 合成收藏') })
    await harness.close(active, QUICK_FOLDERS_PLUGIN_ID)
    const firstFinalGuard = await readGuard(active, activeToken)
    if (firstFinalGuard.favoriteFailureInjectedCount !== 1 || firstFinalGuard.folderDialogAcceptedCount !== 1 ||
        firstFinalGuard.unexpectedFolderDialogCount !== 0 || firstFinalGuard.unscopedDialogBlockedCount !== 0 ||
        firstFinalGuard.unexpectedQuickFoldersProcessCount !== 0 || firstFinalGuard.unverifiedProcessCallerCount !== 0 ||
        firstFinalGuard.blockedProcessCallCount !== 2 || firstFinalGuard.expectedSystemReadBlockCount !== 2) {
      throw new Error('QUICK_FOLDERS_FIRST_PHASE_GUARD_COUNTS_INVALID')
    }
    activeSessionRecord.mainGuardBeforeRestore = firstFinalGuard
    activeSessionRecord.mainGuardRestore = await restoreGuard(active, activeToken)
    if (activeSessionRecord.mainGuardRestore.restored !== true) throw new Error('QUICK_FOLDERS_FIRST_PHASE_GUARD_RESTORE_FAILED')
    activeToken = null
    const firstStop = await harness.stop(active)
    activeSessionRecord.stop = firstStop
    stoppedSessions.push({ phase: 'initial', ...firstStop })
    active = null
    activeSessionRecord = null
    if (!firstStop.cleanupConfirmed) throw new Error('QUICK_FOLDERS_FIRST_APP_CLEANUP_UNCONFIRMED')

    active = await harness.start({ profile, phase: 'p031-restart', report })
    activeSessionRecord = { phase: 'restart', pid: active.child.pid, mainIdentity: active.mainIdentity,
      hooks: null, interactions: [], mainGuardRestore: null }
    report.sessions.push(activeSessionRecord)
    const restartHook = hookFactory(active, { injectFavoriteFailure: false, allowOneFolderDialog: false })
    activeToken = restartHook.token
    activeSessionRecord.hooks = await restartHook.install()
    const persistedPluginManifest = JSON.parse(fs.readFileSync(path.join(profile.appDataPath, 'ZTools', 'Data', 'Plugins',
      QUICK_FOLDERS_PLUGIN_ID, 'plugin.json'), 'utf8'))
    if (persistedPluginManifest.id !== QUICK_FOLDERS_PLUGIN_ID) throw new Error('QUICK_FOLDERS_PLUGIN_INSTALL_NOT_PERSISTED')
    opened = await harness.open(active, QUICK_FOLDERS_PLUGIN_ID)
    activeSessionRecord.open = opened.identity
    const restartedDocuments = await waitFor(() => readPublicDatabase(opened.page), value => {
      try { return verifySyntheticDocuments(value, favoriteExpectedPath, 'P031 合成收藏', 'home').digest === expectedDigest }
      catch { return false }
    }, 15_000, 'QUICK_FOLDERS_APP_RESTART_DATABASE_MISMATCH')
    const restartedGuard = await waitForBlockedSystemRead(active, activeToken, 1, 'QUICK_FOLDERS_RESTART_SYSTEM_READ_NOT_BLOCKED')
    const restartedUi = await waitFor(() => opened.page.evaluate(quickFoldersUiStateExpression()),
      value => value?.cardNames?.includes('P031 合成收藏'), 10_000, 'QUICK_FOLDERS_APP_RESTART_UI_MISMATCH')
    const restartValidation = verifySyntheticDocuments(restartedDocuments, favoriteExpectedPath, 'P031 合成收藏', 'home')
    activeSessionRecord.interactions.push({ id: 'same-profile-app-restart', publicDatabase: restartValidation,
      processGuard: restartedGuard, ui: restartedUi })
    recordStep(report, 'same-profile-app-restart-retains-installed-plugin-and-real-db-state', 'PASS', {
      documentDigest: restartValidation.digest, favoritesCount: restartValidation.favoritesCount,
      customizationsCount: restartValidation.customizationsCount, systemProcessBlocked: restartedGuard.expectedSystemReadBlockCount,
      displayNameVisible: restartedUi.cardNames.includes('P031 合成收藏') })
    await harness.close(active, QUICK_FOLDERS_PLUGIN_ID)
    activeSessionRecord.mainGuardBeforeRestore = await readGuard(active, activeToken)
    if (activeSessionRecord.mainGuardBeforeRestore.favoriteFailureInjectedCount !== 0 ||
        activeSessionRecord.mainGuardBeforeRestore.blockedProcessCallCount !== 1 ||
        activeSessionRecord.mainGuardBeforeRestore.expectedSystemReadBlockCount !== 1 ||
        activeSessionRecord.mainGuardBeforeRestore.unexpectedQuickFoldersProcessCount !== 0) {
      throw new Error('QUICK_FOLDERS_RESTART_GUARD_COUNTS_INVALID')
    }
    activeSessionRecord.mainGuardRestore = await restoreGuard(active, activeToken)
    if (activeSessionRecord.mainGuardRestore.restored !== true) throw new Error('QUICK_FOLDERS_RESTART_GUARD_RESTORE_FAILED')
    activeToken = null
    const secondStop = await harness.stop(active)
    activeSessionRecord.stop = secondStop
    stoppedSessions.push({ phase: 'restart', ...secondStop })
    active = null
    activeSessionRecord = null
    if (!secondStop.cleanupConfirmed) throw new Error('QUICK_FOLDERS_RESTART_APP_CLEANUP_UNCONFIRMED')

    report.status = 'PASS'
    report.windowsNormalAppAcceptance = 'PASS_ISOLATED_PROFILE_FAVORITES_AND_CUSTOMIZATION_ONLY'
    report.systemRecords = { status: 'NOT_RUN', recent: 'NOT_READ', typedPaths: 'NOT_READ', quickAccess: 'NOT_READ',
      enforcement: 'Every quick-folders ProcessService.start was denied in Main before spawn',
      blockedExpectedCalls: firstFinalGuard.expectedSystemReadBlockCount + restartedGuard.expectedSystemReadBlockCount,
      unexpectedCalls: firstFinalGuard.unexpectedQuickFoldersProcessCount + restartedGuard.unexpectedQuickFoldersProcessCount }
    report.cleanup = { ownedElectronSessions: stoppedSessions, loopbackZipServerStopped: false }
  } catch (error) {
    thrown = error
    report.status = 'FAIL'
    report.windowsNormalAppAcceptance = 'FAIL'
    report.errors.push({ code: errorCode(error), diagnostic: error?.cdpException ?? null })
  } finally {
    if (active) {
      const stopRecord = activeSessionRecord ?? { phase: 'unclassified', mainGuardRestore: null }
      try {
        const stopResult = await stopSession(harness, active, activeToken, stopRecord)
        stoppedSessions.push({ phase: stopRecord.phase, ...stopResult })
      } catch (error) {
        stoppedSessions.push({ phase: stopRecord.phase, cleanupConfirmed: false, code: errorCode(error) })
        report.errors.push({ code: 'QUICK_FOLDERS_OWNED_APP_CLEANUP_FAILED', detail: errorCode(error) })
      }
      active = null
      activeToken = null
    }
    if (zipServer) {
      try { await closeLoopbackZipServer(zipServer.server); report.cleanup = { ...(report.cleanup ?? {}), loopbackZipServerStopped: true } }
      catch (error) { report.errors.push({ code: 'QUICK_FOLDERS_LOOPBACK_SERVER_CLEANUP_FAILED', detail: errorCode(error) }) }
    }
    report.cleanup = { ...(report.cleanup ?? {}), ownedElectronSessions: stoppedSessions }
    if (report.errors.length > 0 || stoppedSessions.some(session => session.cleanupConfirmed !== true) || report.cleanup.loopbackZipServerStopped !== true) {
      report.status = 'FAIL'
      report.windowsNormalAppAcceptance = 'FAIL'
    }
    if (report.status === 'NOT_RUN') report.status = thrown ? 'FAIL' : 'NOT_RUN'
    const reportPath = path.join(runPaths.outputRoot, 'report.json')
    try {
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
      report.reportPath = reportPath
    } catch (error) {
      report.errors.push({ code: 'QUICK_FOLDERS_REPORT_WRITE_FAILED', detail: errorCode(error) })
      report.status = 'FAIL'
      report.windowsNormalAppAcceptance = 'FAIL'
    }
  }
  if (thrown) {
    const error = new Error(errorCode(thrown))
    error.report = report
    throw error
  }
  return report
}

async function run() {
  const args = parseQuickFoldersRunnerArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write('Usage: node scripts/test-windows-normal-app-quick-folders.mjs --zip <fresh absolute quick-folders ZIP>\n')
    return
  }
  const report = await runNormalApp(args.zipPath)
  process.stdout.write(`${JSON.stringify({ runId: report.runId, status: report.status, windowsNormalAppAcceptance: report.windowsNormalAppAcceptance,
    reportPath: report.reportPath, systemRecords: report.systemRecords, nativeFolderDialogUi: report.nativeFolderDialogUi,
    macOSDeviceExecution: report.macOSDeviceExecution }, null, 2)}\n`)
  if (report.status !== 'PASS') process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === runnerPath) {
  void run().catch(error => {
    process.stderr.write(`${errorCode(error)}\n`)
    if (error?.report?.reportPath) process.stderr.write(`${error.report.reportPath}\n`)
    process.exitCode = 1
  })
}

export {
  QUICK_FOLDERS_MAIN_STATE_KEY,
  QUICK_FOLDERS_NORMAL_APP_MATRIX,
  QUICK_FOLDERS_DOCUMENT_IDS,
  isQuickFoldersTargetActionable,
  quickFoldersTargetGeometryStable,
  quickFoldersTargetSnapshotExpression,
  publicDatabaseReadExpression,
  quickFoldersUiStateExpression,
  verifySyntheticDocuments,
  recordHash,
  advanceFavoriteReadFailure,
  advanceFolderDialog,
  classifyQuickFoldersPowerShellRequest,
  summarizeQuickFoldersDocuments
}
