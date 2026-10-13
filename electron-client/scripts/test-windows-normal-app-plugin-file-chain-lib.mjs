import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { NORMAL_APP_CDP_PORT, NORMAL_APP_INSPECT_PORT, WindowsNormalAppHarness } from './lib/windows-normal-app-harness.mjs'
import {
  validateMainIdentity, validateRendererIdentity, validateBrowserTarget,
  validatePluginTargetOwnership, validatePluginOpenResult, validateFreshPluginZip,
  isWithin, requireIsolatedPath, buildDialogOverrideExpression,
  buildDialogStateExpression, buildDialogRestoreExpression
} from './windows-normal-app-plugin-file-chain-lib.mjs'

const app = {
  pid: 123, execPath: 'E:\\project\\electron.exe', electronVersion: '43.4.1',
  appName: 'ztools-electron-client', appVersion: '1.1.7.1', appPath: 'E:\\project',
  appDataPath: 'E:\\test\\appData', userDataPath: 'E:\\test\\userData', sessionDataPath: 'E:\\test\\sessionData'
}
const main = { ...app, dataRoot: 'E:\\test\\appData\\ZTools\\Data',
  pluginRoot: 'E:\\test\\appData\\ZTools\\Data\\Plugins', isPackaged: false }
const target = { type: 'page', id: 'owned', url: 'ztools://web/index.html',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9336/devtools/page/owned' }
const pluginUrl = 'ztools://plugins/batch-text-convert/index.html?instanceId=test'

test('normal app harness keeps its default ports and validates isolated caller-selected ports', () => {
  const configuration = { appRoot: 'E:\\project', executable: 'E:\\project\\electron.exe',
    outputRoot: 'E:\\project\\out-test', versions: { electronVersion: '43.4.1' } }
  const defaults = new WindowsNormalAppHarness(configuration)
  assert.deepEqual(defaults.ports, { cdp: 9336, inspect: 9337 })
  assert.equal(NORMAL_APP_CDP_PORT, 9336)
  assert.equal(NORMAL_APP_INSPECT_PORT, 9337)
  const isolated = new WindowsNormalAppHarness({ ...configuration, ports: { cdp: 9338, inspect: 9339 } })
  assert.deepEqual(isolated.ports, { cdp: 9338, inspect: 9339 })
  assert.deepEqual(new WindowsNormalAppHarness({ ...configuration, ports: { cdp: 1, inspect: 65535 } }).ports,
    { cdp: 1, inspect: 65535 })
  for (const ports of [{ cdp: 0, inspect: 9339 }, { cdp: 65536, inspect: 9339 },
    { cdp: 9338, inspect: 9338 }, { cdp: 9338.5, inspect: 9339 }]) {
    assert.throws(() => new WindowsNormalAppHarness({ ...configuration, ports }), { message: 'NORMAL_APP_HARNESS_CONFIGURATION_INVALID' })
  }
})

test('Main identity rejects an unrelated process and any non-isolated application data root', () => {
  assert.equal(validateMainIdentity(main, app).status, 'PASS')
  for (const patch of [{ pid: 124 }, { execPath: 'E:\\other\\electron.exe' },
    { appDataPath: 'C:\\Users\\daily\\AppData\\Roaming' }, { dataRoot: 'E:\\other' },
    { appName: 'other-client' }, { appVersion: '0.0.0' }]) {
    assert.equal(validateMainIdentity({ ...main, ...patch }, app).status, 'FAIL')
  }
})

test('Renderer acceptance requires actual Electron identity, a normal ztools page and no Node exposure', () => {
  const expected = { ...app, targetId: target.id, sdkContractVersion: 1 }
  const renderer = { isElectron: true, url: target.url, targetId: target.id,
    identity: { contractVersion: 1, appVersion: app.appVersion,
      target: { platform: 'windows', runtime: 'electron', arch: 'x64' }, process: { arch: 'x64' } },
    sdkContractVersion: 1, userAgent: 'Mozilla Electron/43.4.1', nodeType: 'undefined', requireType: 'undefined' }
  assert.equal(validateRendererIdentity(renderer, expected).status, 'PASS')
  for (const patch of [{ url: 'file:///test.html' }, { targetId: 'other' },
    { nodeType: 'object' }, { requireType: 'function' }, { sdkContractVersion: 2 }]) {
    assert.equal(validateRendererIdentity({ ...renderer, ...patch }, expected).status, 'FAIL')
  }
})

test('CDP target checks reject remote sockets, wrong ports and a neighboring plugin identity', () => {
  assert.equal(validateBrowserTarget(target, 9336, /^ztools:\/\/web\//).status, 'PASS')
  for (const socket of ['ws://example.com:9336/devtools/page/owned',
    'ws://127.0.0.1:9222/devtools/page/owned', 'http://127.0.0.1:9336/devtools/page/owned']) {
    assert.equal(validateBrowserTarget({ ...target, webSocketDebuggerUrl: socket }, 9336, /^ztools:/).status, 'FAIL')
  }
  assert.equal(validatePluginTargetOwnership({ ...target, url: pluginUrl }, 'batch-text-convert', 9336).status, 'PASS')
  assert.equal(validatePluginTargetOwnership({ ...target, url: 'ztools://plugins/batch-text-convert-other/index.html' }, 'batch-text-convert', 9336).status, 'FAIL')
  assert.equal(validatePluginOpenResult({ success: true, pluginId: 'other', instanceId: 'instance' }, 'batch-text-convert').status, 'FAIL')
})

test('path checks reject sibling prefixes, other drives and unrelated ZIP inputs before filesystem access', () => {
  assert.equal(isWithin('E:\\test', 'E:\\test\\output'), true)
  for (const candidate of ['E:\\test-other\\output', 'D:\\test\\output', 'E:\\test\\..\\daily']) {
    assert.equal(isWithin('E:\\test', candidate), false)
  }
  assert.throws(() => requireIsolatedPath('E:\\daily', 'E:\\test', 'APPDATA'), /ISOLATION_MISMATCH/)
  assert.throws(() => validateFreshPluginZip('E:\\daily\\plugin.zip', 'E:\\plugins'), /OUTSIDE_FRESH_SINGLE_PLUGIN_RUN/)
  assert.throws(() => validateFreshPluginZip('plugin.zip', 'E:\\plugins'), /MUST_BE_ABSOLUTE/)
})

function dialogFixture() {
  let originalCalls = 0
  const original = async () => { originalCalls++; return { canceled: true, filePaths: [] } }
  const dialog = { showOpenDialog: original }
  const context = vm.createContext({ process: { mainModule: { require(name) {
    assert.equal(name, 'electron'); return { dialog }
  } } } })
  const owner = { isDestroyed: () => false, webContents: { id: 42, isDestroyed: () => false, getURL: () => pluginUrl } }
  const evaluate = expression => vm.runInContext(expression, context)
  evaluate(buildDialogOverrideExpression('E:\\test\\input.txt', 'E:\\test\\output', 42, pluginUrl))
  return { dialog, owner, original, evaluate, originalCalls: () => originalCalls }
}

test('one-shot Main dialog plan restores its exact original after the two expected owned requests', async () => {
  const f = dialogFixture()
  const first = await f.dialog.showOpenDialog(f.owner, { properties: ['openFile', 'multiSelections'] })
  assert.equal(first.filePaths[0], 'E:\\test\\input.txt')
  const second = await f.dialog.showOpenDialog(f.owner, { properties: ['openDirectory', 'createDirectory'] })
  assert.equal(second.filePaths[0], 'E:\\test\\output')
  assert.equal(f.dialog.showOpenDialog, f.original)
  assert.equal(f.evaluate(buildDialogStateExpression()).exactOriginalRestored, true)
  await f.dialog.showOpenDialog(f.owner, {})
  assert.equal(f.originalCalls(), 1)
  assert.equal(f.evaluate(buildDialogRestoreExpression()).restored, true)
  assert.equal(f.evaluate(buildDialogStateExpression()).present, false)
})

test('wrong owner or navigated/destroyed plugin cannot consume a dialog result; failure restores the method', async () => {
  for (const patch of [{ id: 99 }, { getURL: () => 'ztools://web/index.html' }, { isDestroyed: () => true }]) {
    const f = dialogFixture()
    await assert.rejects(f.dialog.showOpenDialog({ ...f.owner, webContents: { ...f.owner.webContents, ...patch } },
      { properties: ['openFile', 'multiSelections'] }), /DIALOG_OWNER_MISMATCH/)
    assert.equal(f.dialog.showOpenDialog, f.original)
    assert.deepEqual(JSON.parse(JSON.stringify(f.evaluate(buildDialogStateExpression()).calls)), [])
  }
})

test('unexpected dialog shape or properties restore immediately and cannot return the synthetic path', async () => {
  for (const args of [[{ properties: ['openFile', 'multiSelections'] }],
    [null, { properties: ['openFile', 'multiSelections'] }],
    ['owner', { properties: ['openFile'] }]]) {
    const f = dialogFixture()
    if (args[0] === 'owner') args[0] = f.owner
    await assert.rejects(f.dialog.showOpenDialog(...args))
    assert.equal(f.dialog.showOpenDialog, f.original)
    assert.deepEqual(JSON.parse(JSON.stringify(f.evaluate(buildDialogStateExpression()).calls)), [])
  }
  assert.throws(() => buildDialogOverrideExpression('relative.txt', 'E:\\test', 42, pluginUrl), /MUST_BE_ABSOLUTE/)
  assert.throws(() => buildDialogOverrideExpression('E:\\input.txt', 'E:\\output', 0, pluginUrl), /OWNER_INVALID/)
})
