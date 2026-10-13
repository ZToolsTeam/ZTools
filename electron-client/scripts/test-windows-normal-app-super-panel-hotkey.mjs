import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'
import {
  NORMAL_APP_CDP_PORT,
  NORMAL_APP_INSPECT_PORT,
  WindowsNormalAppHarness
} from './lib/windows-normal-app-harness.mjs'
import { digest } from './windows-normal-app-plugin-file-chain-lib.mjs'

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runnerPath = fileURLToPath(import.meta.url)
const TEST_SHORTCUTS = Object.freeze([
  Object.freeze({ modifiers: Object.freeze(['Ctrl', 'Alt', 'Shift']), key: 'F23' }),
  Object.freeze({ modifiers: Object.freeze(['Ctrl', 'Alt', 'Shift']), key: 'F24' })
])
const INSPECTOR_SHORTCUTS = Object.freeze([
  'CommandOrControl+Alt+Shift+F23',
  'CommandOrControl+Alt+Shift+F24'
])

function errorCode(error) {
  const value = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : ''
  return /^[A-Z0-9_]{1,96}$/.test(value) ? value : 'NORMAL_APP_SUPER_PANEL_HOTKEY_UNCLASSIFIED_FAILURE'
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function createSuperPanelHotkeyConfig(existing, shortcut, enabled) {
  const source = isRecord(existing) ? existing : {}
  const currentKeyboard = isRecord(source.keyboardHotkey) ? source.keyboardHotkey : {}
  const currentMouse = isRecord(source.mouseHotkey) ? source.mouseHotkey : {}
  return {
    ...source,
    enabled: true,
    keyboardHotkey: {
      ...currentKeyboard,
      enabled: enabled === true,
      modifiers: [...shortcut.modifiers],
      key: shortcut.key
    },
    mouseHotkey: { ...currentMouse, enabled: false }
  }
}

export function electronAcceleratorForProbe(shortcut) {
  return [...shortcut.modifiers.map(token => token.toLowerCase() === 'ctrl' ? 'CommandOrControl' : token), shortcut.key]
    .join('+')
}

export function mainShortcutRegistrationProbe(accelerator) {
  return `(() => {
    const mainModule = process.mainModule;
    if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE');
    const electron = mainModule.require('electron');
    const globalShortcut = electron.globalShortcut;
    if (!globalShortcut || typeof globalShortcut.isRegistered !== 'function') throw new Error('GLOBAL_SHORTCUT_QUERY_UNAVAILABLE');
    return { pid: process.pid, appPath: electron.app.getAppPath(), registered: globalShortcut.isRegistered(${JSON.stringify(accelerator)}) };
  })()`
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

function ensureFile(file, code) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code)
}

function seedDisabledHotkeys(profile, outputRoot) {
  const configRoot = path.resolve(profile.appDataPath, 'ZTools', 'Data')
  const relative = path.relative(outputRoot, configRoot)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('PROFILE_CONFIG_PATH_NOT_ISOLATED')
  }
  fs.mkdirSync(configRoot, { recursive: true })
  const settingsPath = path.join(configRoot, 'user_settings.json')
  const initialSettings = {
    super_panel: {
      enabled: true,
      keyboardHotkey: { enabled: false, modifiers: [], key: '' },
      mouseHotkey: { enabled: false, button: 'middle_long', longPressMs: 300 }
    }
  }
  fs.writeFileSync(settingsPath, `\uFEFF${JSON.stringify(initialSettings, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return { settingsPath, keyboardEnabled: false, mouseEnabled: false }
}

async function readSuperPanelSettings(session) {
  return await session.browserPage.page.evaluate(`(async () => {
    const sdk = window.ztools;
    if (!sdk?.config || typeof sdk.config.get !== 'function') throw new Error('PUBLIC_CONFIG_GET_UNAVAILABLE');
    const value = await sdk.config.get('super_panel', {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  })()`)
}

async function writeThroughPublicSdk(session, config) {
  const encoded = JSON.stringify(JSON.stringify(config))
  return await session.browserPage.page.evaluate(`(async () => {
    const sdk = window.ztools;
    if (!sdk?.config || typeof sdk.config.set !== 'function') throw new Error('PUBLIC_CONFIG_SET_UNAVAILABLE');
    if (!sdk?.sys || typeof sdk.sys.reloadHotkeys !== 'function') throw new Error('PUBLIC_HOTKEY_RELOAD_UNAVAILABLE');
    const next = JSON.parse(${encoded});
    const saved = await sdk.config.set('super_panel', next, false);
    if (saved !== true) throw new Error('PUBLIC_CONFIG_SET_NOT_CONFIRMED');
    const reloaded = await sdk.sys.reloadHotkeys();
    if (reloaded !== true) throw new Error('PUBLIC_HOTKEY_RELOAD_NOT_CONFIRMED');
    const persisted = await sdk.config.get('super_panel', {});
    return {
      saved,
      reloaded,
      keyboardHotkey: persisted?.keyboardHotkey ?? null,
      mouseHotkey: persisted?.mouseHotkey ?? null
    };
  })()`)
}

async function queryMainRegistration(session, accelerator) {
  const probe = await session.inspector.evaluate(mainShortcutRegistrationProbe(accelerator))
  if (probe?.pid !== session.child.pid || typeof probe?.registered !== 'boolean') {
    throw new Error('MAIN_INSPECTOR_SHORTCUT_PROBE_IDENTITY_MISMATCH')
  }
  return { pid: probe.pid, appPath: probe.appPath, accelerator, registered: probe.registered,
    query: 'Electron main Inspector: globalShortcut.isRegistered (read-only)' }
}

async function waitForRegistration(session, accelerator, expected, phase) {
  const deadline = Date.now() + 15_000
  let latest
  while (Date.now() < deadline) {
    latest = await queryMainRegistration(session, accelerator)
    if (latest.registered === expected) return latest
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  const error = new Error('GLOBAL_SHORTCUT_REGISTRATION_STATE_MISMATCH')
  error.code = 'GLOBAL_SHORTCUT_REGISTRATION_STATE_MISMATCH'
  error.diagnostic = { phase, expected, latest }
  throw error
}

async function saveShortcutState(session, current, shortcut, enabled, label) {
  const next = createSuperPanelHotkeyConfig(current, shortcut, enabled)
  const saved = await writeThroughPublicSdk(session, next)
  const expectedKey = { enabled: enabled === true, modifiers: [...shortcut.modifiers], key: shortcut.key }
  if (JSON.stringify(saved.keyboardHotkey) !== JSON.stringify(expectedKey) || saved.mouseHotkey?.enabled !== false) {
    const error = new Error('PUBLIC_CONFIG_READBACK_MISMATCH')
    error.code = 'PUBLIC_CONFIG_READBACK_MISMATCH'
    error.diagnostic = { label, expectedKeyboardHotkey: expectedKey, actualKeyboardHotkey: saved.keyboardHotkey,
      actualMouseEnabled: saved.mouseHotkey?.enabled }
    throw error
  }
  return { next, saved: { keyboardHotkey: saved.keyboardHotkey, mouseHotkey: saved.mouseHotkey } }
}

async function stopOwnedSession(harness, session, sessions, report, phase) {
  const stopped = await harness.stop(session)
  sessions.delete(session)
  const passed = stopped.cleanupConfirmed === true && stopped.exit?.code === 0
  report.phases[phase] = { status: passed ? 'PASS' : 'FAIL', ...stopped }
  if (!passed) throw new Error('NORMAL_APP_STOP_NOT_CONFIRMED')
  return stopped
}

async function run() {
  const parsed = parseArgs({ options: { help: { type: 'boolean' } } })
  if (parsed.values.help) {
    console.log('node scripts/test-windows-normal-app-super-panel-hotkey.mjs')
    console.log('Starts the source Electron app in an isolated profile, changes the SuperPanel hotkey through the public ztools SDK, checks actual Main globalShortcut registration through read-only Inspector queries, then disables/restarts/stops it.')
    return
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log(JSON.stringify({ status: 'NOT_RUN', platform: process.platform, arch: process.arch,
      reason: 'WINDOWS_X64_NORMAL_ELECTRON_REQUIRED', macAcceptance: 'NOT_RUN' }))
    process.exitCode = 1
    return
  }

  const runId = randomUUID()
  const output = path.join(clientRoot, 'out-test', 'normal-app-super-panel-hotkey', runId)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.mkdirSync(output, { recursive: false })
  fs.mkdirSync(path.join(output, 'profiles'), { recursive: false })
  const report = {
    schemaVersion: 1,
    runId,
    platform: process.platform,
    arch: process.arch,
    status: 'FAIL',
    scope: 'windows-normal-electron-super-panel-keyboard-hotkey',
    productionZToolsAcceptance: false,
    normalElectronEntry: true,
    isolatedAppData: false,
    isolationConfirmed: false,
    rendererArbitraryIpcExposed: false,
    rendererNodeExposed: false,
    physicalKeySent: false,
    nativeMouseRequested: false,
    macAcceptance: 'NOT_RUN',
    output,
    profileRoot: null,
    phases: {},
    inputs: { shortcutSettings: TEST_SHORTCUTS, inspectorAccelerators: INSPECTOR_SHORTCUTS,
      cdpPort: NORMAL_APP_CDP_PORT, inspectorPort: NORMAL_APP_INSPECT_PORT }
  }
  const sessions = new Set()
  let harness
  try {
    const versions = readVersions()
    const executable = path.join(clientRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    const bootstrap = path.join(clientRoot, 'out', 'main', 'bootstrap.js')
    const webIndex = path.join(clientRoot, 'out', 'assets', 'web', 'index.html')
    for (const [file, code] of [[executable, 'ELECTRON_EXECUTABLE_INVALID'], [bootstrap, 'PROJECT_BOOTSTRAP_NOT_BUILT'],
      [webIndex, 'NORMAL_APP_WEB_BUILD_NOT_FOUND']]) ensureFile(file, code)
    assertPeMachine(executable, PE_MACHINE_X64)
    report.inputs = { ...report.inputs, appRoot: clientRoot, appVersion: versions.appVersion,
      electronVersion: versions.electronVersion, sdkContractVersion: versions.sdkContractVersion,
      electronExecutable: executable, electronExecutableSha256: digest(fs.readFileSync(executable)),
      bootstrap, bootstrapSha256: digest(fs.readFileSync(bootstrap)), webIndex }

    harness = new WindowsNormalAppHarness({ appRoot: clientRoot, executable,
      outputRoot: output, versions })
    const profile = harness.createProfile(path.join(output, 'profiles', 'normal'))
    report.profileRoot = profile.root
    report.phases.isolatedProfileSeed = { status: 'PASS', ...seedDisabledHotkeys(profile, output),
      reason: 'Avoids registering the default Alt+Space or native mouse trigger before the real SDK test.' }

    const first = await harness.start({ profile, phase: 'super-panel-hotkey-first-start', report })
    first.harness = harness
    sessions.add(first)
    report.isolatedAppData = true
    report.isolationConfirmed = first.processRecord.isolationConfirmed === true
    report.phases.firstStart = { status: report.isolationConfirmed ? 'PASS' : 'FAIL',
      mainIdentity: first.mainIdentity, rendererIdentity: first.rendererIdentity, process: first.processRecord,
      configuredPaths: first.configuredPaths }
    if (!report.isolationConfirmed) throw new Error('NORMAL_APP_PROFILE_ISOLATION_NOT_CONFIRMED')

    let currentConfig = await readSuperPanelSettings(first)
    const firstState = await saveShortcutState(first, currentConfig, TEST_SHORTCUTS[0], true, 'initial-register')
    currentConfig = firstState.next
    const firstRegistration = await waitForRegistration(first, INSPECTOR_SHORTCUTS[0], true, 'initial-register')
    report.phases.initialRegistration = { status: 'PASS', config: firstState.saved, registration: firstRegistration,
      api: 'window.ztools.config.set + window.ztools.sys.reloadHotkeys' }

    const changedState = await saveShortcutState(first, currentConfig, TEST_SHORTCUTS[1], true, 'change-accelerator')
    currentConfig = changedState.next
    const oldRegistration = await waitForRegistration(first, INSPECTOR_SHORTCUTS[0], false, 'change-accelerator-old')
    const changedRegistration = await waitForRegistration(first, INSPECTOR_SHORTCUTS[1], true, 'change-accelerator-new')
    report.phases.changedRegistration = { status: 'PASS', config: changedState.saved,
      oldRegistration, newRegistration: changedRegistration }

    const disabledState = await saveShortcutState(first, currentConfig, TEST_SHORTCUTS[1], false, 'disable')
    currentConfig = disabledState.next
    const disabledRegistration = await waitForRegistration(first, INSPECTOR_SHORTCUTS[1], false, 'disable')
    report.phases.disabledRegistration = { status: 'PASS', config: disabledState.saved,
      registration: disabledRegistration }

    const enabledState = await saveShortcutState(first, currentConfig, TEST_SHORTCUTS[1], true, 're-enable')
    currentConfig = enabledState.next
    const enabledRegistration = await waitForRegistration(first, INSPECTOR_SHORTCUTS[1], true, 're-enable')
    report.phases.reEnabledRegistration = { status: 'PASS', config: enabledState.saved,
      registration: enabledRegistration }

    const savedBeforeRestart = await readSuperPanelSettings(first)
    if (savedBeforeRestart?.keyboardHotkey?.enabled !== true || savedBeforeRestart.keyboardHotkey.key !== TEST_SHORTCUTS[1].key) {
      throw new Error('SUPER_PANEL_HOTKEY_SETTINGS_NOT_PERSISTED')
    }
    report.phases.savedSettingsBeforeRestart = { status: 'PASS', keyboardHotkey: savedBeforeRestart.keyboardHotkey,
      storageApi: 'public config.get after public config.set' }

    await stopOwnedSession(harness, first, sessions, report, 'firstStop')

    const restarted = await harness.start({ profile, phase: 'super-panel-hotkey-restart', report })
    restarted.harness = harness
    sessions.add(restarted)
    const restoredSettings = await readSuperPanelSettings(restarted)
    if (restoredSettings?.keyboardHotkey?.enabled !== true ||
        restoredSettings.keyboardHotkey.key !== TEST_SHORTCUTS[1].key ||
        JSON.stringify(restoredSettings.keyboardHotkey.modifiers) !== JSON.stringify(TEST_SHORTCUTS[1].modifiers)) {
      throw new Error('SUPER_PANEL_HOTKEY_RESTART_SETTINGS_MISMATCH')
    }
    const restoredRegistration = await waitForRegistration(restarted, INSPECTOR_SHORTCUTS[1], true, 'restart-persisted-register')
    const removedOldRegistration = await waitForRegistration(restarted, INSPECTOR_SHORTCUTS[0], false, 'restart-old-not-registered')
    report.phases.restartPersistence = { status: 'PASS', keyboardHotkey: restoredSettings.keyboardHotkey,
      registration: restoredRegistration, oldRegistration: removedOldRegistration }
    await stopOwnedSession(harness, restarted, sessions, report, 'restartStop')

    const configPath = path.join(profile.appDataPath, 'ZTools', 'Data', 'user_settings.json')
    const persistedDocument = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''))
    const diskSettings = persistedDocument?.super_panel?.keyboardHotkey
    if (diskSettings?.enabled !== true || diskSettings.key !== TEST_SHORTCUTS[1].key) {
      throw new Error('SUPER_PANEL_HOTKEY_DISK_PERSISTENCE_MISMATCH')
    }
    report.phases.profilePersistence = { status: 'PASS', profileRoot: profile.root,
      settingsPath: configPath, keyboardHotkey: diskSettings, profilePreserved: fs.existsSync(profile.root) }
    report.status = 'PASS'
    report.completeCase = true
  } catch (error) {
    report.failureCode = errorCode(error)
    if (typeof error?.stage === 'string' && /^[a-z0-9-]{1,96}$/i.test(error.stage)) report.failureStage = error.stage
    if (error?.cleanup && typeof error.cleanup === 'object') report.failureCleanup = error.cleanup
    if (error?.diagnostic && typeof error.diagnostic === 'object') report.failureDiagnostic = error.diagnostic
    if (typeof error?.stack === 'string') report.errorStack = error.stack.slice(0, 4000)
    report.failedAt = new Date().toISOString()
    console.error(report.failureCode)
    process.exitCode = 1
  } finally {
    for (const session of [...sessions]) {
      if (!session || session.stopResult || !harness) continue
      const stopped = await harness.stop(session)
      sessions.delete(session)
      if (!stopped.cleanupConfirmed) {
        report.status = 'FAIL'
        report.failureCode ??= 'OWNED_ELECTRON_CLEANUP_UNCONFIRMED'
        process.exitCode = 1
      }
      report.failureCleanup ??= stopped.cleanupConfirmed ? undefined : stopped
    }
    report.updatedAt = new Date().toISOString()
    report.scratchPreserved = true
    const reportPath = path.join(output, 'report.json')
    if (!fs.existsSync(reportPath)) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    console.log(JSON.stringify(report))
    if (report.status !== 'PASS') process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === runnerPath) {
  void run().catch(error => { console.error(errorCode(error)); process.exitCode = 1 })
}
