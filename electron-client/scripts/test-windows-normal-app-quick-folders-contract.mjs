import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

import {
  QUICK_FOLDERS_DIALOG_PROPERTIES,
  QUICK_FOLDERS_DIALOG_TITLE,
  QUICK_FOLDERS_DOCUMENT_IDS,
  QUICK_FOLDERS_MAIN_STATE_KEY,
  QUICK_FOLDERS_NORMAL_APP_MATRIX,
  QUICK_FOLDERS_PLUGIN_ID,
  QUICK_FOLDERS_POWER_SHELL_PATH,
  advanceFavoriteReadFailure,
  advanceFolderDialog,
  buildQuickFoldersMainGuardInstallExpression,
  buildQuickFoldersMainGuardReportExpression,
  buildQuickFoldersMainGuardRestoreExpression,
  classifyFavoriteReadFailure,
  classifyQuickFoldersFolderDialog,
  classifyQuickFoldersPowerShellRequest,
  summarizeQuickFoldersDocuments
} from './lib/windows-normal-app-quick-folders-lib.mjs'
import {
  isQuickFoldersTargetActionable,
  parseQuickFoldersRunnerArgs,
  publicDatabaseReadExpression,
  quickFoldersTargetGeometryStable,
  quickFoldersTargetSnapshotExpression,
  verifySyntheticDocuments
} from './test-windows-normal-app-quick-folders.mjs'

const scriptRoot = path.dirname(fileURLToPath(import.meta.url))
const clientRoot = path.resolve(scriptRoot, '..')
const repositoryRoot = path.resolve(clientRoot, '..')
const pluginRoot = path.join(repositoryRoot, 'plugins', 'create-plugin', 'src', 'plugins', QUICK_FOLDERS_PLUGIN_ID)
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'plugin.json'), 'utf8'))

test('source manifest declares only the implemented Windows Electron target', () => {
  assert.equal(manifest.id, QUICK_FOLDERS_PLUGIN_ID)
  assert.deepEqual(manifest.targets, [{ id: 'windows-electron-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }])
  assert.deepEqual(manifest.nativeComponents, [])
  assert.equal(manifest.targets.some(target => target.platform === 'macos'), false)
})

test('normal-app matrix explicitly separates synthetic acceptance from Windows system data, native dialog, and Mac', () => {
  assert.equal(QUICK_FOLDERS_NORMAL_APP_MATRIX.systemRecords, 'NOT_RUN_PROCESS_START_BLOCKED_BEFORE_SPAWN')
  assert.equal(QUICK_FOLDERS_NORMAL_APP_MATRIX.nativeFolderDialogUi, 'NOT_RUN_MAIN_ONLY_SYNTHETIC_RESULT')
  assert.equal(QUICK_FOLDERS_NORMAL_APP_MATRIX.macOSDeviceExecution, 'NOT_RUN')
  assert.equal(QUICK_FOLDERS_DOCUMENT_IDS.favorites, 'favorite-folders')
  assert.equal(QUICK_FOLDERS_DOCUMENT_IDS.customizations, 'folder-customizations')
})

test('synthetic favorite read error is exact-caller, exact-document, one-shot, then real reads proceed', () => {
  const quickCaller = { type: 'plugin', pluginId: QUICK_FOLDERS_PLUGIN_ID, webContentsId: 41 }
  const otherCaller = { type: 'plugin', pluginId: 'memo', webContentsId: 42 }
  const state = { favoriteFailureState: 'ARMED', favoriteFailureInjectedCount: 0, unverifiedQuickFoldersCallCount: 0 }
  assert.equal(classifyFavoriteReadFailure('OTHER', { plugin_id: 'quick-folders', prefix: 'favorite-folders' }, true), 'DELEGATE')
  assert.equal(classifyFavoriteReadFailure('UNVERIFIED', { plugin_id: 'quick-folders', prefix: 'favorite-folders' }, true), 'REJECT_UNVERIFIED_CALLER')
  assert.equal(classifyFavoriteReadFailure('QUICK_FOLDERS', { plugin_id: 'quick-folders', prefix: 'folder-customizations' }, true), 'DELEGATE')
  assert.equal(advanceFavoriteReadFailure(state, 'OTHER', { plugin_id: 'quick-folders', prefix: 'favorite-folders' }), 'DELEGATE')
  assert.equal(advanceFavoriteReadFailure(state, 'QUICK_FOLDERS', { plugin_id: 'memo', prefix: 'favorite-folders' }), 'DELEGATE')
  assert.equal(advanceFavoriteReadFailure(state, 'QUICK_FOLDERS', { plugin_id: 'quick-folders', prefix: 'favorite-folders' }), 'INJECT_ONE_FAILURE')
  assert.equal(advanceFavoriteReadFailure(state, 'QUICK_FOLDERS', { plugin_id: 'quick-folders', prefix: 'favorite-folders' }), 'DELEGATE')
  assert.equal(state.favoriteFailureState, 'CONSUMED')
  assert.equal(state.favoriteFailureInjectedCount, 1)
  assert.equal(state.unverifiedQuickFoldersCallCount, 0)
  assert.equal(otherCaller.pluginId, 'memo')
  assert.equal(quickCaller.webContentsId, 41)
})

test('PowerShell process guard recognizes only the source command with profile-temp output and retains no script or user paths', () => {
  const tempPath = 'C:\\P031\\profile\\tmp'
  const outputPath = `${tempPath}\\quick-folders-1791454123456-abc123.json`
  const powershell = String.raw`$ErrorActionPreference = 'Stop'
$outputPath = '${outputPath}'
$recentRoot = [Environment]::GetFolderPath('Recent')
$typedPathsKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\TypedPaths'
$shell = New-Object -ComObject Shell.Application
$quickAccess = $shell.Namespace('shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}')`
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(powershell, 'utf16le').toString('base64')]
  const expected = classifyQuickFoldersPowerShellRequest({ path: QUICK_FOLDERS_POWER_SHELL_PATH, args, show: false },
    QUICK_FOLDERS_POWER_SHELL_PATH, tempPath, path.win32)
  assert.deepEqual(expected, { status: 'EXPECTED_BLOCKED_SYSTEM_RECORD_READ', executableMatched: true, argsMatched: true,
    outputInsideProfileTemp: true, readsWindowsRecent: true, readsTypedPaths: true, readsQuickAccess: true })
  const changedSwitches = classifyQuickFoldersPowerShellRequest({ path: QUICK_FOLDERS_POWER_SHELL_PATH,
    args: [...args.slice(0, 1), '-NoProfileChanged', ...args.slice(2)], show: false }, QUICK_FOLDERS_POWER_SHELL_PATH, tempPath, path.win32)
  assert.equal(changedSwitches.status, 'UNEXPECTED_QUICK_FOLDERS_PROCESS')
  const outside = powershell.replace(outputPath, 'C:\\Users\\someone\\Recent\\quick-folders-1791454123456-abc123.json')
  const outsideResult = classifyQuickFoldersPowerShellRequest({ path: QUICK_FOLDERS_POWER_SHELL_PATH,
    args: [...args.slice(0, -1), Buffer.from(outside, 'utf16le').toString('base64')], show: false },
  QUICK_FOLDERS_POWER_SHELL_PATH, tempPath, path.win32)
  assert.equal(outsideResult.status, 'UNEXPECTED_QUICK_FOLDERS_PROCESS')
  assert.equal(Object.hasOwn(expected, 'script'), false)
  assert.equal(Object.hasOwn(expected, 'outputPath'), false)
})

test('one scoped synthetic folder dialog is returned and every other or repeated native dialog is denied', () => {
  const outputRoot = 'C:\\P031\\run'
  const syntheticFolder = `${outputRoot}\\fixtures\\P031-Synthetic-Favorite`
  const options = { title: QUICK_FOLDERS_DIALOG_TITLE, properties: [...QUICK_FOLDERS_DIALOG_PROPERTIES] }
  const state = { folderDialogState: 'ARMED', folderDialogAttemptCount: 0, folderDialogAcceptedCount: 0,
    unexpectedFolderDialogCount: 0, unscopedDialogBlockedCount: 0 }
  assert.equal(classifyQuickFoldersFolderDialog('ztools://plugins/memo/index.html', options, syntheticFolder, outputRoot, path.win32),
    'NON_QUICK_FOLDERS_DIALOG')
  assert.equal(classifyQuickFoldersFolderDialog('ztools://plugins/quick-folders/index.html',
    { ...options, properties: ['openFile'] }, syntheticFolder, outputRoot, path.win32), 'REJECT_UNEXPECTED_DIALOG')
  assert.equal(classifyQuickFoldersFolderDialog('ztools://plugins/quick-folders/index.html', options,
    'C:\\outside\\favorite', outputRoot, path.win32), 'REJECT_UNEXPECTED_DIALOG')
  assert.equal(advanceFolderDialog(state, 'ztools://plugins/quick-folders/index.html', options,
    { syntheticFolderPath: syntheticFolder, outputRoot }, path.win32), 'RETURN_SYNTHETIC_DIRECTORY')
  assert.equal(advanceFolderDialog(state, 'ztools://plugins/quick-folders/index.html', options,
    { syntheticFolderPath: syntheticFolder, outputRoot }, path.win32), 'BLOCK_REPEAT_DIALOG')
  assert.equal(advanceFolderDialog(state, '', options, { syntheticFolderPath: syntheticFolder, outputRoot }, path.win32),
    'BLOCK_UNSCOPED_DIALOG')
  assert.equal(state.folderDialogAcceptedCount, 1)
  assert.equal(state.unexpectedFolderDialogCount, 1)
  assert.equal(state.unscopedDialogBlockedCount, 1)
})

test('Main-only hook expressions are syntactically valid, patch real Main service boundaries, and provide exact restore proof', () => {
  const token = '17914541-2345-4234-9234-179145412345'
  const install = buildQuickFoldersMainGuardInstallExpression({ token,
    outputRoot: 'C:\\P031\\run', syntheticFolderPath: 'C:\\P031\\run\\fixtures\\favorite',
    expectedTempPath: 'C:\\P031\\run\\profile\\tmp', injectFavoriteFailure: true, allowOneFolderDialog: true })
  const report = buildQuickFoldersMainGuardReportExpression(token)
  const restore = buildQuickFoldersMainGuardRestoreExpression(token)
  for (const expression of [install, report, restore]) assert.doesNotThrow(() => new vm.Script(expression))
  assert.match(install, /DatabaseService\.prototype, 'query'/)
  assert.match(install, /ProcessService\.prototype, 'start'/)
  assert.match(install, /dialog, 'showOpenDialog'/)
  assert.match(install, /P031_QUICK_FOLDERS_SYSTEM_PROCESS_BLOCKED_BEFORE_SPAWN/)
  assert.match(install, /P031_SYNTHETIC_FAVORITE_DOCUMENT_READ_FAILURE/)
  assert.match(install, /Object\.defineProperty\(record\.object, record\.key, record\.descriptor\)/)
  assert.match(restore, /state\.restorePatch\(patch\)/)
  assert.match(restore, /delete globalThis\[key\]/)
  assert.throws(() => buildQuickFoldersMainGuardInstallExpression({ token: 'bad', outputRoot: 'C:\\run',
    syntheticFolderPath: 'C:\\run\\favorite', expectedTempPath: 'C:\\run\\tmp' }), /TOKEN_REQUIRED/)
})

test('generated Main hooks fail one real query, block process spawn, return one synthetic dialog result, and restore originals', async () => {
  const token = '17914541-2345-4234-9234-179145412346'
  const outputRoot = 'C:\\P031\\run'
  const syntheticFolderPath = `${outputRoot}\\fixtures\\favorite`
  const expectedTempPath = `${outputRoot}\\profile\\tmp`
  let originalQueryCalls = 0
  let originalProcessCalls = 0
  let nativeDialogCalls = 0
  class DatabaseService { async query() { originalQueryCalls += 1; return { success: true, data: [] } } }
  class ProcessService { async start() { originalProcessCalls += 1; return { success: true, pid: 123 } } }
  const urls = new Map([[41, 'ztools://plugins/quick-folders/index.html'], [42, 'ztools://plugins/memo/index.html']])
  const electron = {
    app: { getAppPath: () => 'C:\\P031-TestApp' },
    webContents: { fromId(id) { return urls.has(id) ? { isDestroyed: () => false, getURL: () => urls.get(id) } : null } },
    dialog: { async showOpenDialog() { nativeDialogCalls += 1; return { canceled: true, filePaths: [] } } }
  }
  const fakeFs = { lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }) }
  fakeFs.realpathSync = () => syntheticFolderPath
  fakeFs.realpathSync.native = () => syntheticFolderPath
  const modules = {
    electron,
    'node:path': path,
    'node:fs': fakeFs,
    [path.win32.join('C:\\P031-TestApp', 'out', 'main', 'services', 'database-service.js')]: { DatabaseService },
    [path.win32.join('C:\\P031-TestApp', 'out', 'main', 'services', 'process-service.js')]: { ProcessService }
  }
  const fakeProcess = { mainModule: { require(name) {
    if (!Object.hasOwn(modules, name)) throw new Error(`UNEXPECTED_MAIN_REQUIRE:${name}`)
    return modules[name]
  } } }
  const context = vm.createContext({ process: fakeProcess, Buffer, Reflect, Object, Array, Map, Number, String, Error, Symbol, Promise })
  const installExpression = buildQuickFoldersMainGuardInstallExpression({ token, outputRoot, syntheticFolderPath,
    expectedTempPath, injectFavoriteFailure: true, allowOneFolderDialog: true })
  const installResult = vm.runInContext(installExpression, context)
  assert.equal(installResult.installed, true)
  assert.equal(installResult.token, token)

  const database = new DatabaseService()
  const caller = { type: 'plugin', pluginId: QUICK_FOLDERS_PLUGIN_ID, webContentsId: 41 }
  await assert.rejects(database.query({ plugin_id: QUICK_FOLDERS_PLUGIN_ID, prefix: 'favorite-folders' }, caller),
    /P031_SYNTHETIC_FAVORITE_DOCUMENT_READ_FAILURE/)
  assert.deepEqual(await database.query({ plugin_id: QUICK_FOLDERS_PLUGIN_ID, prefix: 'favorite-folders' }, caller), { success: true, data: [] })
  assert.equal(originalQueryCalls, 1)

  const powerShell = String.raw`$outputPath = '${expectedTempPath}\\quick-folders-1791454123456-abc123.json'
[Environment]::GetFolderPath('Recent')
HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\TypedPaths
New-Object -ComObject Shell.Application
shell:::{679f85cb-0220-4080-b29b-5540cc05aab6}`
  const processArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(powerShell, 'utf16le').toString('base64')]
  const processes = new ProcessService()
  await assert.rejects(processes.start({ path: QUICK_FOLDERS_POWER_SHELL_PATH, args: processArgs, show: false }, caller),
    /P031_QUICK_FOLDERS_SYSTEM_PROCESS_BLOCKED_BEFORE_SPAWN/)
  assert.equal(originalProcessCalls, 0)

  const options = { title: QUICK_FOLDERS_DIALOG_TITLE, properties: [...QUICK_FOLDERS_DIALOG_PROPERTIES] }
  const window = { webContents: { getURL: () => urls.get(41) } }
  const syntheticResult = await electron.dialog.showOpenDialog(window, options)
  assert.equal(syntheticResult.canceled, false)
  assert.deepEqual(Array.from(syntheticResult.filePaths), [syntheticFolderPath])
  await assert.rejects(electron.dialog.showOpenDialog(window, options), /P031_FOLDER_DIALOG_BLOCKED/)
  const otherWindow = { webContents: { getURL: () => urls.get(42) } }
  await assert.rejects(electron.dialog.showOpenDialog(otherWindow, options), /P031_UNEXPECTED_NATIVE_DIALOG_BLOCKED/)
  assert.equal(nativeDialogCalls, 0)

  const guardReport = vm.runInContext(buildQuickFoldersMainGuardReportExpression(token), context)
  assert.equal(guardReport.favoriteFailureInjectedCount, 1)
  assert.equal(guardReport.blockedProcessCallCount, 1)
  assert.equal(guardReport.expectedSystemReadBlockCount, 1)
  assert.equal(guardReport.folderDialogAcceptedCount, 1)
  assert.equal(guardReport.unexpectedFolderDialogCount, 1)
  assert.equal(guardReport.unscopedDialogBlockedCount, 1)

  const restored = vm.runInContext(buildQuickFoldersMainGuardRestoreExpression(token), context)
  assert.equal(restored.restored, true)
  assert.deepEqual(Array.from(restored.methods), [true, true, true])
  assert.deepEqual(await database.query({ plugin_id: QUICK_FOLDERS_PLUGIN_ID, prefix: 'favorite-folders' }, caller), { success: true, data: [] })
  assert.equal(originalQueryCalls, 2)
  assert.deepEqual(await processes.start({}, caller), { success: true, pid: 123 })
  assert.equal(originalProcessCalls, 1)
  assert.deepEqual(await electron.dialog.showOpenDialog(window, options), { canceled: true, filePaths: [] })
  assert.equal(nativeDialogCalls, 1)
  assert.equal(Object.hasOwn(context, QUICK_FOLDERS_MAIN_STATE_KEY), false)
})

test('public database verification uses only real SDK methods and validates exact synthetic documents', () => {
  const expression = publicDatabaseReadExpression()
  assert.doesNotThrow(() => new vm.Script(expression))
  assert.match(expression, /database\.setPluginId\('quick-folders'\)/)
  assert.match(expression, /database\.allDocs\('favorite-folders'\)/)
  assert.match(expression, /database\.allDocs\('folder-customizations'\)/)
  assert.doesNotMatch(expression, /window\.ztools\.db\s*=|Object\.defineProperty\(window\.ztools/)
  const folderPath = 'C:\\P031\\run\\fixtures\\P031-Synthetic-Favorite'
  const favorite = { _id: 'favorite-folders', items: [{ id: 'folder-1', name: 'P031-Synthetic-Favorite', path: folderPath, createdAt: '2026-10-08T00:00:00.000Z' }] }
  const customization = { _id: 'folder-customizations', items: [{ path: folderPath, name: 'P031 合成收藏', icon: 'home', updatedAt: '2026-10-08T00:00:01.000Z' }] }
  assert.equal(verifySyntheticDocuments({ favorites: favorite, customizations: customization }, folderPath,
    'P031 合成收藏', 'home').customizationsCount, 1)
  assert.throws(() => verifySyntheticDocuments({ favorites: favorite, customizations: customization }, folderPath,
    'unexpected', 'home'), /CUSTOMIZATION_DOCUMENT_MISMATCH/)
  assert.throws(() => summarizeQuickFoldersDocuments({ _id: 'other', items: [] }, null), /PUBLIC_DATABASE_DOCUMENT_INVALID/)
})

test('trusted UI targets must be visible, in viewport, hit-tested, and stable before real CDP input', () => {
  const make = (x, changes = {}) => ({ selector: 'button.qf-toolbar-add', label: '添加收藏', count: 1,
    viewport: { width: 1000, height: 700 }, candidates: [{ text: '添加收藏', actionable: true, disabled: false,
      hit: true, rect: { x, y: 120, width: 110, height: 38 }, ...changes }] })
  const before = make(40)
  const after = make(40.1)
  assert.equal(isQuickFoldersTargetActionable(before), true)
  assert.equal(quickFoldersTargetGeometryStable(before, after), true)
  assert.equal(quickFoldersTargetGeometryStable(before, make(41)), false)
  assert.equal(isQuickFoldersTargetActionable(make(-1)), false)
  assert.equal(isQuickFoldersTargetActionable(make(40, { actionable: false })), false)
  assert.doesNotThrow(() => new vm.Script(quickFoldersTargetSnapshotExpression('.qf-card', null, 'exact')))
  assert.throws(() => quickFoldersTargetSnapshotExpression('', null), /SELECTOR_REQUIRED/)
})

test('runner accepts only one fresh ZIP input and asserts close/reopen/restart plus cleanup steps', () => {
  assert.throws(() => parseQuickFoldersRunnerArgs([]), /PLUGIN_ZIP_REQUIRED/)
  assert.throws(() => parseQuickFoldersRunnerArgs(['--zip', 'quick-folders.zip']), /MUST_BE_ABSOLUTE/)
  assert.deepEqual(parseQuickFoldersRunnerArgs(['--zip', 'E:\\P031\\quick-folders.zip']), {
    help: false, zipPath: path.resolve('E:\\P031\\quick-folders.zip')
  })
  const runner = fs.readFileSync(new URL('./test-windows-normal-app-quick-folders.mjs', import.meta.url), 'utf8')
  assert.match(runner, /new WindowsNormalAppHarness/)
  assert.match(runner, /harness\.install\(active/)
  assert.match(runner, /harness\.open\(active, QUICK_FOLDERS_PLUGIN_ID\)/)
  assert.match(runner, /harness\.close\(active, QUICK_FOLDERS_PLUGIN_ID\)/)
  assert.match(runner, /p031-restart/)
  assert.match(runner, /same-profile-app-restart/)
  assert.match(runner, /harness\.stop\(active\)/)
  assert.match(runner, /systemRecords: \{ status: 'NOT_RUN'/)
  assert.match(runner, /nativeFolderDialogUi: 'NOT_RUN_MAIN_ONLY_SYNTHETIC_DIALOG_RESULT'/)
  assert.match(runner, /macOSDeviceExecution: 'NOT_RUN'/)
  assert.match(runner, /process\.platform !== 'win32'/)
  assert.doesNotMatch(runner, /execFile\(|spawn\(/)
})
