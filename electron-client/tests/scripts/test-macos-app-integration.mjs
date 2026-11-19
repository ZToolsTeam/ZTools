import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { validateMacSnapshot, validateExistingCdpIdentitySnapshot, parseExistingCdpIdentityArguments,
  runExistingCdpIdentity, inspectMainProcessIdentity, collectInstalledPluginInventory,
  runExistingAppAboutNavigation, runMacAppIntegration, MAC_AUTOMATIC_CASES, main,
  selectMacMainPageTarget, startMacNormalDatabaseChainSession, stopMacNormalDatabaseChainSession } from './macos-app-integration.mjs'

test('startup exception still produces a failed reviewable report without raw diagnostic data', async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-mac-failed-start-'))
  try {
    const messages = []
    const code = await main(['--app', path.join(output, 'Fixture.app'), '--output', output,
      '--bundle-id', 'test.ztools.fixture', '--minimum-os', '13.0', '--expect-process-arch', 'arm64', '--case', 'M02'], {
      runApp: async () => { throw new Error('private-path-and-secret-never-log') }, stdout: text => messages.push(JSON.parse(text))
    })
    assert.equal(code, 1); assert.equal(messages[0].status, 'FAIL')
    const raw = fs.readFileSync(messages[0].reportPath, 'utf8'), report = JSON.parse(raw)
    assert.equal(raw.includes('private-path-and-secret'), false)
    assert.equal(report.cleanup, 'STARTUP_EXCEPTION_REQUIRES_REVIEW')
    assert.equal(report.cases[0].caseId, 'M02'); assert.equal(report.cases[0].status, 'FAIL')
    assert.equal(report.preflight.code, 'APP_INTEGRATION_START_FAILED')
  } finally { fs.rmSync(output, { recursive: true, force: true }) }
})

function snapshot(arch = 'arm64') {
  return { isElectron: true, url: 'ztools://web/index.html', platform: 'macos', osVersion: '12.0',
    userAgent: 'Mozilla/5.0 Electron/43.4.1', nodeType: 'undefined', requireType: 'undefined',
    identity: { contractVersion: 1, appVersion: '1.1.7.1', target: { platform: 'macos', runtime: 'electron', arch: 'universal' },
      os: { arch, productVersion: '12.0' }, process: { arch, translationMode: 'native' },
      nativeHost: { state: 'not-applicable', arch: 'unknown', protocolVersion: null } },
    capture: { contractVersion: 1, capability: 'screen.capture', target: { platform: 'macos', runtime: 'electron', arch },
      implementation: 'supported', authorization: 'granted', osPermission: 'not-determined', revision: 0 },
    unknownCapabilityCode: 'INVALID_REQUEST' }
}

test('M01/M03分开包架构与实际进程架构，不将未授权视为失败或触发采集', () => {
  assert.deepEqual(MAC_AUTOMATIC_CASES, ['M01', 'M03'])
  for (const arch of ['arm64', 'x64']) assert.equal(validateMacSnapshot(snapshot(arch), arch, '1.1.7.1').status, 'PASS')
})
test('桥接目标、实际slice、版本、隔离和错误码不一致必须失败', () => {
  for (const [change, code] of [
    [s => { s.isElectron = false }, 'WRONG_TEST_HOST'],
    [s => { s.identity.target.arch = 'arm64' }, 'RUNTIME_CONTRACT_MISMATCH'],
    [s => { s.identity.process.arch = 'x64' }, 'PROCESS_ARCH_MISMATCH'],
    [s => { s.identity.appVersion = 'other' }, 'APP_VERSION_MISMATCH'],
    [s => { s.userAgent = 'Chrome/145' }, 'ELECTRON_VERSION_MISMATCH'],
    [s => { s.nodeType = 'object' }, 'RENDERER_ISOLATION_MISMATCH'],
    [s => { s.capture.osPermission = 'future' }, 'CAPABILITY_CONTRACT_MISMATCH'],
    [s => { s.unknownCapabilityCode = 'not supported' }, 'ERROR_CONTRACT_MISMATCH']
  ]) {
    const value = snapshot(); change(value)
    assert.equal(validateMacSnapshot(value, 'arm64', '1.1.7.1').code, code)
  }
})
test('真实Mac模式在Windows不启动进程，保持NOT_RUN且非伪造测试通过', { skip: process.platform === 'darwin' }, async () => {
  const result = await runMacAppIntegration({ app: '/fixture/Test.app' })
  assert.equal(result.preflight.status, 'NOT_RUN')
  assert.deepEqual(result.cases, [])
  assert.equal(result.cleanup, 'NO_PROCESS_CREATED')
})

function existingIdentitySnapshot(platform = 'windows', arch = 'x64') {
  const targetArch = platform === 'macos' ? 'universal' : arch
  const appDataPath = platform === 'windows' ? 'C:\\Users\\tester\\AppData\\Roaming' : '/Users/tester/Library/Application Support'
  const pathApi = platform === 'windows' ? path.win32 : path.posix
  return { isElectron: true, url: 'ztools://web/index.html', targetId: 'main-target', browserPid: 4321,
    processPath: platform === 'windows' ? 'E:\\ZTools\\electron.exe' : '/Applications/ZTools.app/Contents/MacOS/ZTools', platform,
    osVersion: '10.0.26100', osArch: arch, processArch: arch, appName: 'ZTools', appVersion: '1.1.7.1',
    sdkContractVersion: 1, sdkSystemUserDataPath: platform === 'windows' ? 'C:\\Users\\tester\\AppData\\Local' : '/Users/tester/Library/Application Support/ZTools',
    userAgent: 'Mozilla/5.0 Electron/43.4.1', nodeType: 'undefined', requireType: 'undefined',
    identity: { contractVersion: 1, appVersion: '1.1.7.1', target: { platform, runtime: 'electron', arch: targetArch },
      os: { arch, productVersion: '10.0.26100' }, process: { arch, translationMode: platform === 'macos' ? 'native' : 'not-applicable' },
      nativeHost: { state: 'unavailable', arch: 'ia32', protocolVersion: null } },
    mainInspector: { inspectorTargetId: 'main-inspector-target', pid: 4321, executablePath: platform === 'windows'
      ? 'E:\\ZTools\\electron.exe' : '/Applications/ZTools.app/Contents/MacOS/ZTools', electronVersion: '43.4.1',
      appVersion: '1.1.7.1', electronUserDataPath: platform === 'windows'
        ? 'C:\\Users\\tester\\AppData\\Roaming\\ztools-electron-client' : '/Users/tester/Library/Application Support/ZTools',
      electronAppDataPath: appDataPath, ztoolsDataRoot: pathApi.join(appDataPath, 'ZTools', 'Data'),
      pluginRoot: pathApi.join(appDataPath, 'ZTools', 'Data', 'Plugins'), dataRootExists: true, pluginRootExists: true, isPackaged: false } }
}

const windowsIdentityExpectation = Object.freeze({ platform: 'windows', arch: 'x64', appVersion: '1.1.7.1',
  electronVersion: '43.4.1', sdkContractVersion: 1, processPath: 'e:\\ztools\\electron.exe',
  electronUserDataPath: 'C:\\Users\\tester\\AppData\\Roaming\\ztools-electron-client',
  targetId: 'main-target', targetUrl: 'ztools://web/index.html' })

test('existing normal-App identity is explicitly a baseline and binds OS, slice, SDK, separate paths, inspector, and target', () => {
  const snapshot = existingIdentitySnapshot()
  const result = validateExistingCdpIdentitySnapshot(snapshot, windowsIdentityExpectation)
  assert.equal(result.status, 'BASELINE_PASS')
  assert.equal(result.snapshot.targetId, 'main-target')
  assert.equal(result.snapshot.sdkSystemUserDataPath, snapshot.sdkSystemUserDataPath)
  assert.equal(result.snapshot.mainInspector.electronUserDataPath, snapshot.mainInspector.electronUserDataPath)
  assert.equal(result.snapshot.mainInspector.ztoolsDataRoot, 'C:\\Users\\tester\\AppData\\Roaming\\ZTools\\Data')
  assert.equal(result.snapshot.sdkContractVersion, 1)
  assert.equal(result.snapshot.processArch, 'x64')
})

test('existing-App identity validator rejects wrong runtime, target, versions, and each path identity independently', () => {
  for (const [change, code] of [
    [value => { value.isElectron = false }, 'WRONG_ZTOOLS_TARGET'],
    [value => { value.url = 'https://example.test/' }, 'WRONG_ZTOOLS_TARGET'],
    [value => { value.identity.target.platform = 'macos' }, 'RUNTIME_IDENTITY_MISMATCH'],
    [value => { value.identity.process.arch = 'ia32' }, 'RUNTIME_IDENTITY_MISMATCH'],
    [value => { value.appVersion = 'old' }, 'APP_SDK_VERSION_OR_ISOLATION_MISMATCH'],
    [value => { value.sdkContractVersion = 2 }, 'APP_SDK_VERSION_OR_ISOLATION_MISMATCH'],
    [value => { value.mainInspector.electronUserDataPath = 'relative/path' }, 'MAIN_INSPECTOR_IDENTITY_MISMATCH'],
    [value => { value.sdkSystemUserDataPath = 'relative/path' }, 'SDK_SYSTEM_USER_DATA_PATH_MISMATCH'],
    [value => { value.mainInspector.appVersion = 'other' }, 'MAIN_INSPECTOR_IDENTITY_MISMATCH'],
    [value => { value.mainInspector.pluginRoot = 'C:\\other' }, 'MAIN_INSPECTOR_IDENTITY_MISMATCH'],
    [value => { value.url = 'ztools://web/other.html' }, 'RUNTIME_IDENTITY_MISMATCH'],
    [value => { value.targetId = 'other-target' }, 'RUNTIME_IDENTITY_MISMATCH']
  ]) {
    const value = existingIdentitySnapshot(); change(value)
    assert.equal(validateExistingCdpIdentitySnapshot(value, windowsIdentityExpectation).code, code)
  }
})

test('attach-existing CLI requires a loopback port, expected platform, executable path, and output directory', () => {
  const output = path.resolve('evidence')
  const options = parseExistingCdpIdentityArguments(['--attach-existing', '--existing-cdp-port', '9338',
    '--main-inspect-port', '9339', '--expected-user-data', 'C:\\Users\\tester\\AppData\\Roaming\\ztools-electron-client',
    '--expected-platform', 'windows', '--expect-process-arch', 'x64', '--expected-process-path', 'E:\\ZTools\\electron.exe',
    '--output', output, '--action', 'about-roundtrip'])
  assert.equal(options.port, 9338)
  assert.equal(options.mainInspectPort, 9339)
  assert.equal(options.expectedElectronUserDataPath, 'C:\\Users\\tester\\AppData\\Roaming\\ztools-electron-client')
  assert.equal(options.expectedProcessPath, 'E:\\ZTools\\electron.exe')
  assert.equal(options.action, 'about-roundtrip')
  assert.throws(() => parseExistingCdpIdentityArguments(['--attach-existing', '--existing-cdp-port', '80',
    '--expected-platform', 'windows', '--expect-process-arch', 'x64', '--expected-process-path', 'E:\\ZTools\\electron.exe',
    '--output', output]), /INVALID_EXISTING_CDP_PORT/)
  assert.throws(() => parseExistingCdpIdentityArguments(['--existing-cdp-port', '9338', '--expected-platform', 'windows',
    '--expect-process-arch', 'x64', '--expected-process-path', 'E:\\ZTools\\electron.exe', '--output', output]), /ATTACH_EXISTING_REQUIRED/)
  assert.throws(() => parseExistingCdpIdentityArguments(['--attach-existing', '--existing-cdp-port', '9338',
    '--expected-platform', 'windows', '--expect-process-arch', 'x64', '--expected-process-path', 'E:\\ZTools\\electron.exe',
    '--output', output, '--action', 'open-account-and-submit']), /ACTION_NOT_PREPARED/)
  assert.throws(() => parseExistingCdpIdentityArguments(['--attach-existing', '--existing-cdp-port', '9338',
    '--main-inspect-port', '9338', '--expected-platform', 'windows', '--expect-process-arch', 'x64',
    '--expected-process-path', 'E:\\ZTools\\electron.exe', '--output', output]), /INSPECTOR_PORT_COLLISION/)
})

test('identity runner refuses to call SDK userData a Main userData when no explicit inspector port is supplied', async () => {
  assert.deepEqual(await inspectMainProcessIdentity({ port: null, browserPid: 4321,
    expected: windowsIdentityExpectation }), { status: 'FAIL', code: 'MAIN_INSPECTOR_NOT_PROVIDED' })
})

test('Main inspector proves PID, executable, Electron and app version before reading actual paths', async () => {
  const calls = [], fetchUrls = []
  const appDataPath = 'C:\\Users\\tester\\AppData\\Roaming'
  const result = await inspectMainProcessIdentity({ port: 9339, browserPid: 4321, expected: windowsIdentityExpectation,
    fetchImpl: async url => {
      fetchUrls.push(url)
      return { ok: true, text: async () => JSON.stringify([{ type: 'node', id: 'node-target',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9339/node-target' }]) }
    },
    connect: async (url, port, pathPrefix) => {
      assert.equal(url, 'ws://127.0.0.1:9339/node-target')
      assert.equal(port, 9339); assert.equal(pathPrefix, '/node-target')
      return { call: async (_method, params) => {
        calls.push(params.expression)
        return { result: { value: calls.length === 1
          ? { pid: 4321, executablePath: 'E:\\ZTools\\electron.exe', electronVersion: '43.4.1' }
          : { appVersion: '1.1.7.1', electronUserDataPath: 'C:\\Users\\tester\\AppData\\Roaming\\ztools-electron-client',
            electronAppDataPath: appDataPath, ztoolsDataRoot: 'C:\\Users\\tester\\AppData\\Roaming\\ZTools\\Data',
            pluginRoot: 'C:\\Users\\tester\\AppData\\Roaming\\ZTools\\Data\\Plugins',
            dataRootExists: true, pluginRootExists: true, isPackaged: false } } }
      }, dispose() { calls.push('disposed') } }
    } })
  assert.equal(result.status, 'PASS')
  assert.equal(result.snapshot.pid, 4321)
  assert.equal(result.snapshot.electronUserDataPath, windowsIdentityExpectation.electronUserDataPath)
  assert.equal(result.snapshot.ztoolsDataRoot, 'C:\\Users\\tester\\AppData\\Roaming\\ZTools\\Data')
  assert.deepEqual(fetchUrls, ['http://127.0.0.1:9339/json/list'])
  assert.equal(calls.length, 3)
})

test('installed-plugin inventory collector uses only the read-only SDK list method', async () => {
  const calls = []
  const inventory = { status: 'READONLY_PASS', scope: 'normal-app-installed-plugin-inventory', source: 'window.ztools.plugin.getList',
    count: 1, plugins: [{ pluginId: 'calculator', name: 'Calculator', version: '1.2.3', entry: 'index.html', enabled: true }] }
  const result = await collectInstalledPluginInventory({ call: async (method, params) => {
    calls.push({ method, params })
    return { result: { value: inventory } }
  } })
  assert.deepEqual(result, inventory)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'Runtime.evaluate')
  assert.equal(calls[0].params.awaitPromise, true)
  assert.match(calls[0].params.expression, /getList/)
})

test('existing-CDP runner rejects a browser target and never sends a close command', async () => {
  let connectCount = 0, processPathCount = 0, sentMethods = []
  const result = await runExistingCdpIdentity({ port: 19222, expectedPlatform: 'windows', expectedArch: 'x64',
    expectedProcessPath: 'E:\\ZTools\\electron.exe' }, {
    runnerPlatform: 'win32', projectVersions: () => ({ appVersion: '1.1.7.1', electronVersion: '43.4.1', sdkContractVersion: 1 }),
    fetchImpl: async url => ({ ok: true, text: async () => url.endsWith('/json/list')
      ? JSON.stringify([{ id: 'browser-target', type: 'page', title: 'OpenChatCut', url: 'https://openchatcut.example/?secret=omit#private' }]) : '{}' }),
    connect: async () => { connectCount += 1; return { call: async method => { sentMethods.push(method); return {} }, dispose() {} } },
    processPath: () => { processPathCount += 1; return 'E:\\ZTools\\electron.exe' }
  })
  assert.equal(result.cases[0].status, 'FAIL')
  assert.equal(result.cases[0].code, 'ZTOOLS_TARGET_MISSING')
  assert.deepEqual(result.preflight.availableTargets, [{ id: 'browser-target', type: 'page',
    title: 'OpenChatCut', url: 'https://openchatcut.example/' }])
  assert.equal(result.cleanup, 'EXISTING_PROCESS_LEFT_RUNNING')
  assert.equal(connectCount, 0)
  assert.equal(processPathCount, 0)
  assert.deepEqual(sentMethods, [])
})

test('prepared real-UI action dispatches paired mouse events and restores the original route', async () => {
  const calls = []
  let state = { url: 'ztools://web/index.html#/', hash: '#/', activeLabel: '我的', heading: null, contentType: 'my', isElectron: true }
  const page = { call: async (method, params = {}) => {
    calls.push({ method, params })
    if (method === 'Page.bringToFront') return {}
    if (method === 'Runtime.evaluate' && params.expression.includes('readNavigationStateInPage')) return { result: { value: state } }
    if (method === 'Runtime.evaluate' && params.expression.includes('locateVisibleSidebarItemInPage')) {
      const label = params.expression.includes('"关于我们"') ? '关于我们' : '我的'
      return { result: { value: { found: true, label, x: label === '我的' ? 80 : 220, y: 40, width: 60, height: 30,
        viewportWidth: 800, viewportHeight: 600 } } }
    }
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      state = params.x === 220
        ? { ...state, url: 'ztools://web/index.html#/about', hash: '#/about', activeLabel: '关于我们', heading: 'ZTools', contentType: 'about' }
        : { ...state, url: 'ztools://web/index.html#/', hash: '#/', activeLabel: '我的', heading: '热门推荐', contentType: 'my' }
      return {}
    }
    if (method === 'Input.dispatchMouseEvent') return {}
    throw new Error(`unexpected method ${method}`)
  } }
  const result = await runExistingAppAboutNavigation(page)
  assert.equal(result.status, 'ACTION_PASS')
  assert.equal(result.completeCase, false)
  assert.equal(result.cleanup, 'ROUTE_RESTORED')
  assert.equal(result.steps.length, 2)
  assert.deepEqual(calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mousePressed').map(call => call.params.x), [220, 80])
  assert.deepEqual(calls.filter(call => call.method === 'Input.dispatchMouseEvent' && call.params.type === 'mouseReleased').map(call => call.params.x), [220, 80])
  assert.equal(calls.some(call => call.method === 'Browser.close'), false)
  assert.equal(state.hash, '#/')
})

test('existing-CDP main writes a baseline report without upgrading its status to complete-case', async () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-f22-cdp-baseline-'))
  try {
    const messages = []
    const code = await main(['--attach-existing', '--existing-cdp-port', '9338', '--expected-platform', 'windows',
      '--expect-process-arch', 'x64', '--expected-process-path', 'E:\\ZTools\\electron.exe', '--output', output], {
      runExisting: async () => ({ preflight: { status: 'PASS', mode: 'read-only-existing-instance' },
        cases: [{ caseId: 'F22-I01', status: 'BASELINE_PASS', completeCase: false }], cleanup: 'EXISTING_PROCESS_LEFT_RUNNING' }),
      stdout: value => messages.push(JSON.parse(value))
    })
    assert.equal(code, 0)
    assert.equal(messages[0].status, 'BASELINE_PASS')
    const report = JSON.parse(fs.readFileSync(messages[0].reportPath, 'utf8'))
    assert.equal(report.completeCase, false)
    assert.equal(report.scope, 'normal-app-cdp-identity-baseline')
    assert.equal(report.cleanup, 'EXISTING_PROCESS_LEFT_RUNNING')
  } finally { fs.rmSync(output, { recursive: true, force: true }) }
})

const normalMainTarget = { id: 'normal-main', type: 'page', url: 'ztools://web/index.html#/my',
  webSocketDebuggerUrl: 'ws://127.0.0.1:19421/devtools/page/normal-main' }
const normalLauncherTarget = { id: 'normal-launcher', type: 'page', url: 'ztools://web/index.html?mode=launcher#/launcher',
  webSocketDebuggerUrl: 'ws://127.0.0.1:19421/devtools/page/normal-launcher' }

test('主窗口选择按明确URL区分Launcher，保留双主窗口歧义拒绝', () => {
  assert.equal(selectMacMainPageTarget([normalLauncherTarget, normalMainTarget]), normalMainTarget)
  assert.equal(selectMacMainPageTarget([normalMainTarget, normalLauncherTarget]), normalMainTarget)
  assert.equal(selectMacMainPageTarget([normalLauncherTarget]), undefined)
  assert.throws(() => selectMacMainPageTarget([normalMainTarget, { ...normalMainTarget, id: 'second' }]), /AMBIGUOUS_NORMAL_APP_TARGET/)
  for (const url of ['https://web/index.html', 'ztools://web/other.html', 'ztools://web/index.html?other=true',
    'ztools://user:password@web/index.html', 'ztools://web:1234/index.html', 'ztools://web/index.html\n']) {
    assert.equal(selectMacMainPageTarget([{ ...normalMainTarget, url }]), undefined)
  }
})

function normalSessionFixture({ runtimeAppName = 'ztools-electron-client',
  targets = [normalLauncherTarget, normalMainTarget], browserPid = 4321 } = {}) {
  const calls = []
  const child = Object.assign(new EventEmitter(), { pid: 4321, exitCode: null, signalCode: null })
  const exit = () => { child.exitCode = 0; child.emit('exit', 0) }
  child.kill = signal => { calls.push({ action: 'kill', signal }); exit() }
  const appRoot = '/Applications/Fixture.app'
  const appArchive = path.join(appRoot, 'Contents/Resources/app.asar')
  const preflight = { status: 'PASS', appRoot, executable: path.join(appRoot, 'Contents/MacOS/ZTools'),
    bundleId: 'test.ztools.fixture', appVersion: '1.1.7.1', runtimeAppName, minimumOs: '13.0',
    expectedProcessArch: 'arm64', slices: ['arm64', 'x86_64'] }
  const profile = { root: '/isolated/profile', appDataPath: '/isolated/profile/appData',
    userDataPath: '/isolated/profile/appData/ZTools', sessionDataPath: '/isolated/profile/sessionData' }
  const options = { app: appRoot, output: '/isolated', profile, 'bundle-id': preflight.bundleId,
    'minimum-os': '13.0', 'expect-process-arch': 'arm64' }
  const main = { pid: child.pid, execPath: preflight.executable, processArch: 'arm64',
    electronVersion: '43.4.1', appVersion: preflight.appVersion, isPackaged: true,
    appPath: appArchive, mainEntry: path.join(appArchive, 'out/main/bootstrap.js'),
    ...Object.fromEntries(['appDataPath', 'userDataPath', 'sessionDataPath'].flatMap(key => [
      [key, profile[key]], [key.replace(/Path$/, 'RealPath'), profile[key]]
    ])) }
  const inspector = {
    async evaluate(expression, evaluationOptions) {
      calls.push({ action: 'inspector-evaluate', expression, options: evaluationOptions })
      if (expression.includes('app.quit();')) { exit(); return true }
      return main
    },
    dispose() { calls.push({ action: 'inspector-dispose' }) }
  }
  const browser = {
    async call(method) {
      calls.push({ action: 'browser-call', method })
      if (method === 'SystemInfo.getProcessInfo') return { processInfo: [{ type: 'browser', id: browserPid }] }
      if (method === 'Browser.close') { exit(); return {} }
      throw new Error('UNEXPECTED_BROWSER_CALL')
    },
    dispose() { calls.push({ action: 'browser-dispose' }) }
  }
  const page = {
    async call(method, params) {
      calls.push({ action: 'page-call', method, params })
      assert.equal(method, 'Runtime.evaluate')
      return { result: { value: snapshot() } }
    },
    dispose() { calls.push({ action: 'page-dispose' }) }
  }
  let nextPort = 19421
  const dependencies = {
    platform: 'darwin', preflight,
    allocatePort: async () => { calls.push({ action: 'allocate-port' }); return nextPort++ },
    spawnApp(executable, args, spawnOptions) { calls.push({ action: 'spawn', executable, args, options: spawnOptions }); return child },
    async isolationGate(config) {
      calls.push({ action: 'gate', config })
      return { status: 'PASS', resumed: true, client: inspector }
    },
    fetchImpl: async url => ({ ok: true, json: async () => url.endsWith('/json/list') ? targets
      : { webSocketDebuggerUrl: 'ws://127.0.0.1:19421/devtools/browser/owned' } }),
    connect: async url => { calls.push({ action: 'connect', url }); return url.includes('/devtools/browser/') ? browser : page }
  }
  return { calls, options, dependencies, child }
}

test('隔离normal-session使用静态预检包名与同步主进程求值，renderer继续await异步且只连接主窗口', async () => {
  const h = normalSessionFixture()
  const session = await startMacNormalDatabaseChainSession(h.options, h.dependencies)
  try {
    assert.equal(h.calls.find(call => call.action === 'gate').config.appName, 'ztools-electron-client')
    assert.equal(session.mainPage.target, normalMainTarget)
    assert.equal(h.calls.some(call => call.action === 'connect' && call.url === normalLauncherTarget.webSocketDebuggerUrl), false)
    assert.equal(h.calls.find(call => call.action === 'inspector-evaluate').options.awaitPromise, false)
    assert.equal(h.calls.find(call => call.action === 'page-call').params.awaitPromise, true)
    assert.equal(session.browserVerified, true)
  } finally {
    const cleanup = await stopMacNormalDatabaseChainSession(session)
    assert.equal(cleanup.normalQuitConfirmed, true)
  }
  const quitting = h.calls.filter(call => call.action === 'inspector-evaluate').at(-1)
  assert.match(quitting.expression, /app.quit/)
  assert.deepEqual(quitting.options, { awaitPromise: false, timeoutMs: 3000 })
  assert.equal(h.calls.some(call => call.action === 'kill'), false)
})

test('normal-session在启动前拒绝缺失或畸形静态包名，保留owned browser PID与双主窗口拒绝', async () => {
  for (const value of [undefined, null, '', '\u0000', 'x'.repeat(129)]) {
    const h = normalSessionFixture()
    h.dependencies.preflight.runtimeAppName = value
    await assert.rejects(startMacNormalDatabaseChainSession(h.options, h.dependencies), /APP_PREFLIGHT_IDENTITY_MISMATCH/)
    assert.deepEqual(h.calls, [], '身份无效不能分配端口或启动进程')
  }
  for (const [overrides, code] of [
    [{ browserPid: 9999 }, 'OWNED_CDP_PROCESS_MISMATCH'],
    [{ targets: [normalMainTarget, { ...normalMainTarget, id: 'second' }] }, 'AMBIGUOUS_NORMAL_APP_TARGET']
  ]) {
    const h = normalSessionFixture(overrides)
    await assert.rejects(startMacNormalDatabaseChainSession(h.options, h.dependencies), new RegExp(code))
    assert.equal(h.calls.some(call => call.action === 'page-call'), false)
    assert.equal(h.calls.some(call => call.method === 'Browser.close'), false, '未确认owned browser之前不得关闭浏览器')
    assert.equal(h.child.exitCode, 0)
  }
})
