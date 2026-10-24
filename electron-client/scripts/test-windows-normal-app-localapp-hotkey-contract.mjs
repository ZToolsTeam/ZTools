import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import {
  buildLocalAppDialogOverrideExpression,
  buildLocalAppDialogRestoreExpression,
  buildLocalAppDialogStateExpression,
  buildMainHotkeyHookSource,
  buildMainHotkeyHookFireExpression,
  buildMainHotkeyHookSnapshotExpression,
  buildProbeCmakeLists,
  buildProbeExecutableSource,
  createLocalAppHotkeyTrigger,
  mainHookNodeOptionsValue,
  windowsLocalAppId
} from './test-windows-normal-app-localapp-hotkey.mjs'

const PROBE_PATH = 'E:\\isolated\\run\\probe.exe'
const APP_ID = windowsLocalAppId(PROBE_PATH)
const TRIGGER_ID = 'f09-localapp-123e4567-e89b-42d3-a456-426614174000'
const PANEL_URL = 'ztools://web/super-panel/index.html'

function dialogFixture() {
  let originalCalls = 0
  const original = async () => { originalCalls += 1; return { canceled: true, filePaths: [] } }
  const dialog = { showOpenDialog: original }
  const electron = { dialog }
  const context = vm.createContext({ process: { mainModule: { require(name) {
    assert.equal(name, 'electron')
    return electron
  } } } })
  const evaluate = expression => vm.runInContext(expression, context)
  const owner = { isDestroyed: () => false, webContents: {
    id: 44, isDestroyed: () => false, getURL: () => PANEL_URL
  } }
  const options = { title: '添加本地软件', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Windows 程序', extensions: ['exe'] }] }
  return { dialog, original, owner, options, evaluate, originalCalls: () => originalCalls }
}

test('Windows local-app IDs use the same case-insensitive path identity as the saved SuperPanel record', () => {
  assert.match(APP_ID, /^localapp:[A-F0-9]{8}$/)
  assert.equal(windowsLocalAppId('e:/ISOLATED/RUN/PROBE.EXE'), APP_ID)
  assert.throws(() => windowsLocalAppId('relative.exe'), /LOCAL_APP_EXE_PATH_INVALID/)
})

test('test-only Main preload uses an absolute forward-slash path safe for Windows NODE_OPTIONS parsing', () => {
  assert.equal(mainHookNodeOptionsValue('E:\\isolated run\\main-hook.cjs'),
    '--require "E:/isolated run/main-hook.cjs"')
  assert.throws(() => mainHookNodeOptionsValue('relative/main-hook.cjs'), /MAIN_HOOK_PATH_INVALID/)
  assert.throws(() => mainHookNodeOptionsValue('E:\\isolated\\bad"path.cjs'), /MAIN_HOOK_PATH_INVALID/)
})

test('public hotkey registration carries only the Windows local-app ID and a fixed accelerator', () => {
  const trigger = createLocalAppHotkeyTrigger({ appId: APP_ID, triggerId: TRIGGER_ID, accelerator: 'Ctrl+Alt+Shift+F24' })
  assert.deepEqual(trigger, {
    id: TRIGGER_ID,
    pluginId: APP_ID,
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Alt+Shift+F24' },
    action: { mode: 'builtin', target: 'launch_local_app', params: { appId: APP_ID } }
  })
  assert.throws(() => createLocalAppHotkeyTrigger({ appId: APP_ID, triggerId: TRIGGER_ID,
    accelerator: 'Ctrl+Alt+Shift+F23' }), /TRIGGER_ACCELERATOR_INVALID/)
  assert.throws(() => createLocalAppHotkeyTrigger({ appId: APP_ID, triggerId: TRIGGER_ID,
    accelerator: 'Ctrl+Alt+Shift+F24', path: PROBE_PATH }), /LOCAL_APP_TRIGGER_OPTIONS_INVALID/)
  assert.throws(() => createLocalAppHotkeyTrigger({ appId: 'localapp:mac:' + 'A'.repeat(64),
    triggerId: TRIGGER_ID, accelerator: 'Ctrl+Alt+Shift+F24' }), /LOCAL_APP_ID_INVALID/)
})

test('controlled Main hook expressions are valid and only permit F23/F24 with a 256-bit token', () => {
  const snapshot = buildMainHotkeyHookSnapshotExpression()
  const fire = buildMainHotkeyHookFireExpression('CommandOrControl+Alt+Shift+F24', 'a'.repeat(64))
  assert.doesNotThrow(() => new vm.Script(snapshot))
  assert.doesNotThrow(() => new vm.Script(fire))
  assert.match(fire, /state\.fire\(/)
  assert.throws(() => buildMainHotkeyHookFireExpression('CommandOrControl+Alt+Shift+F12', 'a'.repeat(64)),
    /TEST_ACCELERATOR_INVALID/)
  assert.throws(() => buildMainHotkeyHookFireExpression('CommandOrControl+Alt+Shift+F24', 'short'), /TEST_TOKEN_INVALID/)
})

test('Main hook captures only allowlisted real register callbacks and removes them symmetrically on unregister', () => {
  const callbacks = new Map()
  const token = 'b'.repeat(64)
  const electron = { globalShortcut: {
    register(accelerator, callback) { callbacks.set(accelerator.toLowerCase(), callback); return true },
    unregister(accelerator) { callbacks.delete(accelerator.toLowerCase()) }
  } }
  const module = { _load(request) { assert.equal(request, 'electron'); return electron } }
  const context = vm.createContext({
    process: { type: 'browser', env: { ZTOOLS_F09_HOTKEY_TOKEN: token,
      ZTOOLS_F09_ALLOWED_ACCELERATORS: JSON.stringify(['commandorcontrol+alt+shift+f24']) } },
    require(name) { assert.equal(name, 'node:module'); return module }
  })
  vm.runInContext(buildMainHotkeyHookSource(), context)
  const originalRegister = electron.globalShortcut.register
  const facade = module._load('electron')
  const hookedElectron = vm.runInContext("require('node:module')._load('electron')", context)
  assert.equal(hookedElectron, facade)
  assert.equal(electron.globalShortcut.register, originalRegister)
  assert.notEqual(facade, electron)
  let fired = 0
  facade.globalShortcut.register('CommandOrControl+Alt+Shift+F24', () => { fired += 1 })
  facade.globalShortcut.register('CommandOrControl+Alt+Shift+F12', () => { fired += 10 })
  const hook = vm.runInContext("globalThis[Symbol.for('ztools.test.f09.localapp-hotkey.v1')]", context)
  assert.equal(hook.snapshot().installed, true)
  assert.deepEqual(Array.from(hook.snapshot().accelerators), ['commandorcontrol+alt+shift+f24'])
  assert.equal(hook.fire('CommandOrControl+Alt+Shift+F24', 'invalid').fired, false)
  assert.equal(hook.fire('CommandOrControl+Alt+Shift+F12', token).reason, 'ACCELERATOR_NOT_ALLOWED')
  assert.equal(hook.fire('CommandOrControl+Alt+Shift+F24', token).fired, true)
  assert.equal(fired, 1)
  facade.globalShortcut.unregister('CommandOrControl+Alt+Shift+F24')
  assert.equal(hook.fire('CommandOrControl+Alt+Shift+F24', token).reason, 'CALLBACK_NOT_REGISTERED')
})

test('one-shot Main dialog substitute is limited to the exact panel owner and restores Electron method after selection', async () => {
  const fixture = dialogFixture()
  const installed = fixture.evaluate(buildLocalAppDialogOverrideExpression(PROBE_PATH, fixture.owner.webContents.id))
  assert.equal(installed.installed, true)
  assert.equal(installed.oneShot, true)
  assert.notEqual(fixture.dialog.showOpenDialog, fixture.original)
  const result = await fixture.dialog.showOpenDialog(fixture.owner, fixture.options)
  assert.equal(result.canceled, false)
  assert.equal(result.filePaths[0], PROBE_PATH)
  assert.equal(fixture.dialog.showOpenDialog, fixture.original)
  const state = fixture.evaluate(buildLocalAppDialogStateExpression())
  assert.equal(state.calls, 1)
  assert.equal(state.restored, true)
  assert.equal(state.exactOriginalRestored, true)
  await fixture.dialog.showOpenDialog(fixture.owner, fixture.options)
  assert.equal(fixture.originalCalls(), 1)
  assert.equal(fixture.evaluate(buildLocalAppDialogRestoreExpression()).restored, true)
})

test('wrong Main dialog owner cannot consume the test path and the original method is restored on rejection', async () => {
  const fixture = dialogFixture()
  fixture.evaluate(buildLocalAppDialogOverrideExpression(PROBE_PATH, fixture.owner.webContents.id))
  const wrongOwner = { ...fixture.owner, webContents: { ...fixture.owner.webContents, id: 99 } }
  await assert.rejects(fixture.dialog.showOpenDialog(wrongOwner, fixture.options), /DIALOG_PANEL_OWNER_MISMATCH/)
  assert.equal(fixture.dialog.showOpenDialog, fixture.original)
  assert.equal(fixture.originalCalls(), 0)
  assert.equal(fixture.evaluate(buildLocalAppDialogStateExpression()).restored, true)
})

test('Main dialog substitution rejects changed panel URL, request shape, or filter before returning a selected EXE', async () => {
  const cases = [
    { owner: { webContents: { id: 44, isDestroyed: () => false, getURL: () => 'ztools://web/index.html' } }, options: null,
      expected: /DIALOG_PANEL_OWNER_MISMATCH/ },
    { owner: null, options: null, expected: /DIALOG_PANEL_OWNER_MISMATCH/ },
    { owner: 'expected', options: { ...dialogFixture().options, title: 'other' }, expected: /DIALOG_CALL_SHAPE_MISMATCH/ },
    { owner: 'expected', options: { ...dialogFixture().options, filters: [{ name: 'All', extensions: ['*'] }] },
      expected: /DIALOG_FILTER_MISMATCH/ }
  ]
  for (const item of cases) {
    const fixture = dialogFixture()
    fixture.evaluate(buildLocalAppDialogOverrideExpression(PROBE_PATH, fixture.owner.webContents.id))
    const owner = item.owner === 'expected' ? fixture.owner : item.owner
    await assert.rejects(fixture.dialog.showOpenDialog(owner, item.options ?? fixture.options), item.expected)
    assert.equal(fixture.dialog.showOpenDialog, fixture.original)
    assert.equal(fixture.originalCalls(), 0)
  }
  assert.throws(() => buildLocalAppDialogOverrideExpression('relative.exe', 44), /DIALOG_APP_PATH_INVALID/)
  assert.throws(() => buildLocalAppDialogOverrideExpression(PROBE_PATH, 0), /DIALOG_PANEL_OWNER_INVALID/)
})

test('probe EXE has no argv/environment input or process-termination path and writes only its own identity marker', () => {
  const source = buildProbeExecutableSource()
  assert.match(source, /GetModuleFileNameW/)
  assert.match(source, /GetCurrentProcessId/)
  assert.match(source, /launches\.tsv/)
  assert.match(source, /Sleep\(2500\)/)
  assert.doesNotMatch(source, /CommandLineToArgvW|GetCommandLineW|CreateProcessW|TerminateProcess|ExitProcess/)
  const cmake = buildProbeCmakeLists()
  assert.match(cmake, /add_executable\(ZToolsLocalAppHotkeyProbe WIN32/)
  assert.match(cmake, /RUNTIME_OUTPUT_DIRECTORY_RELEASE/)
})
