import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'
import {
  WindowsNormalAppHarness,
  startLoopbackZipServer,
  closeLoopbackZipServer
} from './lib/windows-normal-app-harness.mjs'
import { digest, validateFreshPluginZip } from './windows-normal-app-plugin-file-chain-lib.mjs'

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(clientRoot, '..')
const pluginRoot = path.join(repositoryRoot, 'plugins', 'create-plugin')
const runnerPath = fileURLToPath(import.meta.url)
const permissionEvent = 'runtime_permission_changed'
const settingsHash = '#/advanced-settings'
const alternateHash = '#/about'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const ownedSessions = new Set()

function safeErrorCode(error) {
  const value = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : ''
  return /^[A-Z0-9_]{1,96}$/.test(value) ? value : 'NORMAL_APP_PERMISSION_MONITOR_UNCLASSIFIED_FAILURE'
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

async function waitFor(read, accept, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = await read()
      if (accept(value)) return value
    } catch { /* Retry while the normal app page is rendering. */ }
    await delay(100)
  }
  throw new Error(code)
}

async function installRendererProbe(page) {
  return await page.evaluate(`(() => {
    const sdk = window.ztools;
    const events = sdk?.events;
    const transport = events?.transport;
    if (!sdk?.isElectron?.() || typeof sdk.sys?.getCapability !== 'function' ||
        typeof events?.on !== 'function' || typeof events?.off !== 'function' ||
        typeof transport?.call !== 'function') throw new Error('PERMISSION_RENDERER_PROBE_API_UNAVAILABLE');
    if (window.__f07PermissionProbe) throw new Error('PERMISSION_RENDERER_PROBE_ALREADY_INSTALLED');
    const probe = { capabilityCalls: [], eventTransportCalls: [], trustedRecheckClicks: [] };
    const originalGetCapability = sdk.sys.getCapability.bind(sdk.sys);
    sdk.sys.getCapability = async function(capability, ...rest) {
      if (capability === 'screen.capture') probe.capabilityCalls.push({ capability, at: Date.now() });
      return await originalGetCapability(capability, ...rest);
    };
    const originalTransportCall = transport.call;
    transport.call = async function(method, params, ...rest) {
      if ((method === 'event_subscribe' || method === 'event_unsubscribe') && params?.key === ${JSON.stringify(permissionEvent)}) {
        probe.eventTransportCalls.push({ method, key: params.key, at: Date.now() });
      }
      return await originalTransportCall.call(this, method, params, ...rest);
    };
    document.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (button?.innerText.replace(/\\s+/g, ' ').trim() === '重新检查') {
        probe.trustedRecheckClicks.push({ isTrusted: event.isTrusted === true, at: Date.now() });
      }
    }, true);
    window.__f07PermissionProbe = probe;
    return { isElectron: sdk.isElectron(), initialUrl: location.href, instrumented: true };
  })()`)
}

async function readRendererProbe(page) {
  return await page.evaluate(`(() => {
    const probe = window.__f07PermissionProbe;
    const handlers = window.ztools?.events?.handlers;
    const subscriptions = window.ztools?.events?.subscriptions;
    return {
      capabilityCalls: [...(probe?.capabilityCalls ?? [])],
      eventTransportCalls: [...(probe?.eventTransportCalls ?? [])],
      trustedRecheckClicks: [...(probe?.trustedRecheckClicks ?? [])],
      activeHandlerCount: handlers instanceof Map ? handlers.get(${JSON.stringify(permissionEvent)})?.size ?? 0 : null,
      activeTransportSubscription: subscriptions instanceof Set ? subscriptions.has(${JSON.stringify(permissionEvent)}) : null
    };
  })()`)
}

async function readPanel(page) {
  return await page.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="screen-permission-panel"]');
    return panel ? { present: true, status: panel.querySelector('[data-testid="screen-permission-status"]')?.innerText.trim() ?? '',
      authorizationStatus: panel.querySelector('[data-testid="screen-authorization-status"]')?.innerText.trim() ?? '',
      text: panel.innerText.replace(/\\s+/g, ' ').trim(), buttonDisabled: panel.querySelector('button')?.disabled ?? true,
      url: location.href } : { present: false, status: '', authorizationStatus: '', text: '', buttonDisabled: true, url: location.href };
  })()`)
}

async function readAutostartState(page) {
  return await page.evaluate(`(() => {
    const description = document.querySelector('[data-testid="autostart-status"]');
    const toggle = document.querySelector('[data-testid="autostart-switch"]');
    return { present: Boolean(description && toggle), status: description?.innerText.trim() ?? '',
      disabled: toggle?.disabled ?? true, checked: toggle?.getAttribute('aria-checked') ?? null, url: location.href };
  })()`)
}

async function clickSidebarEntry(page, label, hash, expectedPanel) {
  const target = await page.evaluate(`(() => {
    const entry = [...document.querySelectorAll('.sidebar-item')].find(item =>
      item.innerText.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(label)});
    if (!entry) return null;
    entry.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = entry.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2, label: entry.innerText.replace(/\\s+/g, ' ').trim() } : null;
  })()`)
  if (!target || target.label !== label) throw new Error('NORMAL_MAIN_SIDEBAR_ENTRY_UNAVAILABLE')
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  return await waitFor(() => readPanel(page), value => value?.present === expectedPanel &&
    value.url.endsWith(hash), 20_000,
  expectedPanel ? 'SCREEN_PERMISSION_PANEL_NOT_OPEN' : 'SCREEN_PERMISSION_PANEL_NOT_CLOSED')
}

async function clickRecheck(page) {
  const target = await page.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="screen-permission-panel"]');
    const button = panel?.querySelector('button');
    if (!button || button.disabled) return null;
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
      label: button.innerText.replace(/\\s+/g, ' ').trim() } : null;
  })()`)
  if (!target || target.label !== '重新检查') throw new Error('SCREEN_PERMISSION_RECHECK_BUTTON_UNAVAILABLE')
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  return target
}

async function readCapability(page) {
  return await page.evaluate(`(async () => {
    if (typeof window.ztools?.sys?.getCapability !== 'function') throw new Error('RUNTIME_CAPABILITY_SDK_UNAVAILABLE');
    return await window.ztools.sys.getCapability('screen.capture');
  })()`)
}

async function injectHostSignals(session) {
  return await session.inspector.evaluate(`(async () => {
    const mainModule = process.mainModule;
    if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE');
    const electron = mainModule.require('electron');
    const path = mainModule.require('node:path');
    const app = electron.app;
    const monitorModulePath = path.join(app.getAppPath(), 'out', 'main', 'services', 'runtime-permission-monitor-service.js');
    const Monitor = mainModule.require(monitorModulePath).RuntimePermissionMonitorService;
    const prototype = Monitor?.prototype;
    if (typeof prototype?.refreshOwner !== 'function' || typeof prototype?.refreshSubscribedOwners !== 'function') {
      throw new Error('PERMISSION_MONITOR_INSPECTOR_HOOKS_UNAVAILABLE');
    }
    const mainWindow = electron.BrowserWindow.getAllWindows().find(window =>
      !window.isDestroyed() && /^ztools:\\x2f\\x2fweb(?:\\/|$)/.test(window.webContents.getURL()));
    if (!mainWindow) throw new Error('NORMAL_MAIN_WINDOW_NOT_FOUND_FOR_FOCUS_SIGNAL');
    const target = { pid: process.pid, webContentsId: mainWindow.webContents.id,
      url: mainWindow.webContents.getURL(), appPath: app.getAppPath() };
    const calls = [];
    const pending = [];
    const originalRefreshOwner = prototype.refreshOwner;
    const originalRefreshSubscribedOwners = prototype.refreshSubscribedOwners;
    prototype.refreshOwner = function(owner, ...args) {
      calls.push({ method: 'refreshOwner', ownerType: owner?.type ?? null, webContentsId: owner?.webContentsId ?? null });
      const result = originalRefreshOwner.call(this, owner, ...args);
      pending.push(Promise.resolve(result).catch(() => {}));
      return result;
    };
    prototype.refreshSubscribedOwners = function(...args) {
      calls.push({ method: 'refreshSubscribedOwners' });
      const result = originalRefreshSubscribedOwners.apply(this, args);
      pending.push(Promise.resolve(result).catch(() => {}));
      return result;
    };
    let waitTimedOut = false;
    try {
      app.emit('browser-window-focus', {}, mainWindow);
      if (!electron.powerMonitor || typeof electron.powerMonitor.emit !== 'function') throw new Error('POWER_MONITOR_UNAVAILABLE');
      electron.powerMonitor.emit('resume');
      const settled = await Promise.race([
        Promise.allSettled(pending),
        new Promise(resolve => setTimeout(() => resolve(null), 10_000))
      ]);
      waitTimedOut = settled === null;
    } finally {
      prototype.refreshOwner = originalRefreshOwner;
      prototype.refreshSubscribedOwners = originalRefreshSubscribedOwners;
    }
    return { target, injectedFocusSignal: true, injectedResumeSignal: true,
      monitorRefreshCalls: calls, waitTimedOut, appPath: path.resolve(app.getAppPath()) };
  })()`)
}

async function injectAutostartReadFailure(session) {
  return await session.inspector.evaluate(`(() => {
    const mainModule = process.mainModule;
    if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE');
    const path = mainModule.require('node:path');
    const root = mainModule.require('electron').app.getAppPath();
    const ConfigService = mainModule.require(path.join(root, 'out', 'main', 'services', 'config-service.js')).ConfigService;
    const LoginItemConfigService = mainModule.require(path.join(root, 'out', 'main', 'services', 'login-item-config-service.js')).LoginItemConfigService;
    const configPrototype = ConfigService?.prototype;
    const loginItemPrototype = LoginItemConfigService?.prototype;
    if (typeof configPrototype?.get !== 'function' || typeof loginItemPrototype?.set !== 'function') {
      throw new Error('AUTOSTART_CONFIG_PROTOTYPE_UNAVAILABLE');
    }
    if (globalThis.__f07AutostartReadProbe) throw new Error('AUTOSTART_READ_PROBE_ALREADY_INSTALLED');
    const originalGet = configPrototype.get;
    const originalSet = loginItemPrototype.set;
    const probe = { readFailures: 0, readFile: null, readPath: null, getRestoredAfterFailure: false,
      blockedAutostartWrites: [], restoreComplete: false };
    const injectedGet = function(fileName, pathValue, defaultValue, ...rest) {
      if (probe.readFailures === 0 && fileName === 'user_settings.json' && pathValue === 'system.autostart') {
        probe.readFailures += 1;
        probe.readFile = fileName;
        probe.readPath = pathValue;
        configPrototype.get = originalGet;
        probe.getRestoredAfterFailure = configPrototype.get === originalGet;
        const error = new Error('F07_INJECTED_AUTOSTART_READ_FAILURE');
        error.code = 'F07_INJECTED_AUTOSTART_READ_FAILURE';
        throw error;
      }
      return originalGet.apply(this, [fileName, pathValue, defaultValue, ...rest]);
    };
    const guardedSet = function(fileName, pathValue, value, syncEnabled, ...rest) {
      if (fileName === 'user_settings.json' && (pathValue === 'system.autostart' || pathValue === 'system')) {
        probe.blockedAutostartWrites.push({ file: fileName, path: pathValue });
        const error = new Error('F07_AUTOSTART_WRITE_BLOCKED_BY_TEST');
        error.code = 'F07_AUTOSTART_WRITE_BLOCKED_BY_TEST';
        throw error;
      }
      return originalSet.apply(this, [fileName, pathValue, value, syncEnabled, ...rest]);
    };
    probe.restore = () => {
      if (configPrototype.get === injectedGet) configPrototype.get = originalGet;
      if (loginItemPrototype.set === guardedSet) loginItemPrototype.set = originalSet;
      probe.restoreComplete = configPrototype.get === originalGet && loginItemPrototype.set === originalSet;
      return probe.restoreComplete;
    };
    probe.originalGet = originalGet;
    probe.originalSet = originalSet;
    probe.injectedGet = injectedGet;
    probe.guardedSet = guardedSet;
    configPrototype.get = injectedGet;
    loginItemPrototype.set = guardedSet;
    globalThis.__f07AutostartReadProbe = probe;
    return { installed: configPrototype.get === injectedGet && loginItemPrototype.set === guardedSet,
      failureTarget: { file: 'user_settings.json', path: 'system.autostart' },
      matchingWritesBlocked: ['system.autostart', 'system'] };
  })()`)
}

async function readAutostartInjectionState(session) {
  return await session.inspector.evaluate(`(() => {
    const mainModule = process.mainModule;
    const path = mainModule.require('node:path');
    const root = mainModule.require('electron').app.getAppPath();
    const ConfigService = mainModule.require(path.join(root, 'out', 'main', 'services', 'config-service.js')).ConfigService;
    const LoginItemConfigService = mainModule.require(path.join(root, 'out', 'main', 'services', 'login-item-config-service.js')).LoginItemConfigService;
    const probe = globalThis.__f07AutostartReadProbe;
    return probe ? { readFailures: probe.readFailures, readFile: probe.readFile, readPath: probe.readPath,
      getRestoredAfterFailure: probe.getRestoredAfterFailure,
      getCurrentlyOriginal: ConfigService.prototype.get === probe.originalGet,
      blockedAutostartWrites: [...probe.blockedAutostartWrites],
      writeGuardInstalled: LoginItemConfigService.prototype.set === probe.guardedSet,
      restoreComplete: probe.restoreComplete } : null;
  })()`)
}

async function restoreAutostartInjection(session) {
  return await session.inspector.evaluate(`(() => {
    const probe = globalThis.__f07AutostartReadProbe;
    if (!probe) return { restored: false, reason: 'AUTOSTART_PROBE_NOT_INSTALLED' };
    return { restored: probe.restore(), readFailures: probe.readFailures,
      blockedAutostartWrites: [...probe.blockedAutostartWrites] };
  })()`)
}

async function forgePermissionEvent(pluginPage) {
  return await pluginPage.evaluate(`(async () => {
    const events = window.ztools?.events;
    if (typeof events?.emit !== 'function') throw new Error('PLUGIN_EVENT_PUBLISH_API_UNAVAILABLE');
    try {
      const result = await events.emit(${JSON.stringify(permissionEvent)}, { capability: 'screen.capture', revision: 999999 });
      return { status: result?.success === false ? 'REJECTED' : 'RESOLVED',
        code: result?.code ?? result?.error?.code ?? null, result };
    } catch (error) {
      return { status: 'REJECTED', code: error?.code ?? error?.data?.code ?? null,
        message: typeof error?.message === 'string' ? error.message.slice(0, 240) : '' };
    }
  })()`)
}

async function capturePanel(page, outputPath) {
  const screenshot = await page.call('Page.captureScreenshot', { format: 'png', fromSurface: true })
  if (typeof screenshot?.data !== 'string' || !screenshot.data) throw new Error('SCREEN_PERMISSION_SCREENSHOT_UNAVAILABLE')
  fs.writeFileSync(outputPath, Buffer.from(screenshot.data, 'base64'), { flag: 'wx' })
}

function assertRegularFile(file, code) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code)
}

function writeEvidence(report) {
  const root = path.join(repositoryRoot, 'docs', 'mac-compat-evidence', 'F07')
  fs.mkdirSync(root, { recursive: true })
  const jsonPath = path.join(root, `normal-app-permission-monitor-${report.runId}.json`)
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  const markdownPath = path.join(root, `normal-app-permission-monitor-${report.runId}.md`)
  const markdown = [
    '# F07 Windows normal Electron permission monitor', '',
    `- Run: \`${report.runId}\``,
    `- Result: **${report.status}**`,
    `- Main identity: PID ${report.phases.start?.identity?.main?.pid ?? 'NOT_RUN'}, app ${report.inputs.appVersion ?? 'NOT_RUN'}, Electron ${report.inputs.electronVersion ?? 'NOT_RUN'}`,
    `- Advanced settings route: \`${report.phases.settingsOpen?.url ?? 'NOT_RUN'}\``,
    `- Windows OS permission: \`${report.phases.initialCapability?.osPermission ?? 'NOT_RUN'}\``,
    `- Feature authorization: \`${report.phases.initialCapability?.authorization ?? 'NOT_RUN'}\``,
    `- Autostart read failure/recovery: ${report.phases.autostartRecovery?.status ?? 'NOT_RUN'} (Main config read failure injected once; no login-item write requested)`,
    `- Recheck trusted click: ${report.phases.recheck?.trustedInput ?? 'NOT_RUN'}`,
    `- Host focus/resume injected signals: ${report.phases.hostRefreshSignals?.status ?? 'NOT_RUN'} (injected signals do not represent an OS resume)`,
    `- Plugin reserved-topic attempt: ${report.phases.pluginReservedEvent?.status ?? 'NOT_RUN'}`,
    `- Settings listener lifecycle: ${report.phases.settingsLifecycle?.status ?? 'NOT_RUN'}`,
    `- Mac TCC denial/recovery: ${report.macAcceptance}`,
    `- Detailed report: \`${report.outputReport}\``,
    '',
    'This run uses the normal Windows Electron source entry with an isolated profile. The host signals are injected through Main Inspector, the Windows `screen.capture` state is `not-required`, and this evidence does not claim macOS TCC denial/recovery or packaged production acceptance.',
    ''
  ].join('\n')
  fs.writeFileSync(markdownPath, markdown, { flag: 'wx' })
  return { jsonPath, markdownPath }
}

async function run() {
  const parsed = parseArgs({ options: { zip: { type: 'string' }, help: { type: 'boolean' } } })
  if (parsed.values.help) {
    console.log('node scripts/test-windows-normal-app-permission-monitor.mjs --zip <fresh todo windows-electron-x64 ZIP>')
    console.log('Starts the normal Electron entry with an isolated profile, opens Advanced Settings, checks both permission axes and trusted recheck, injects one Main autostart config read failure, tries a plugin event spoof, injects focus/resume host signals, then verifies recovery and listener cleanup after leaving and reopening settings.')
    console.log('Writes reports under out-test/normal-app-permission-monitor/<runId> and docs/mac-compat-evidence/F07/. Mac TCC system-setting interaction remains NOT_RUN.')
    return
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log(JSON.stringify({ status: 'NOT_RUN', platform: process.platform, arch: process.arch,
      reason: 'WINDOWS_X64_NORMAL_ELECTRON_REQUIRED', macAcceptance: 'NOT_RUN' }))
    process.exitCode = 1
    return
  }
  if (!parsed.values.zip || !path.win32.isAbsolute(parsed.values.zip)) throw new Error('ABSOLUTE_TODO_ZIP_PATH_REQUIRED')

  const runId = randomUUID()
  const output = path.join(clientRoot, 'out-test', 'normal-app-permission-monitor', runId)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.mkdirSync(output, { recursive: false })
  fs.mkdirSync(path.join(output, 'profiles'), { recursive: false })
  const report = {
    schemaVersion: 1, runId, platform: process.platform, arch: process.arch, status: 'FAIL',
    scope: 'windows-normal-electron-permission-panel-autostart-read-recovery-event-refresh-and-listener-lifecycle',
    productionZToolsAcceptance: false, normalElectronEntry: true, isolatedAppData: false, isolationConfirmed: false,
    rendererArbitraryIpcExposed: false, rendererNodeExposed: false,
    macAcceptance: 'NOT_RUN', output, phases: {}, inputs: {}
  }
  report.outputReport = path.join(output, 'report.json')
  let session
  let zipServer
  let autostartInjectionInstalled = false
  try {
    const versions = readVersions()
    const todoManifestPath = path.join(pluginRoot, 'src', 'plugins', 'todo', 'plugin.json')
    const todoManifest = JSON.parse(fs.readFileSync(todoManifestPath, 'utf8'))
    if (todoManifest.id !== 'todo' || !todoManifest.version) throw new Error('TODO_PLUGIN_SOURCE_MANIFEST_INVALID')
    const zipInfo = validateFreshPluginZip(parsed.values.zip, pluginRoot, 'todo')
    const executable = path.join(clientRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    const bootstrap = path.join(clientRoot, 'out', 'main', 'bootstrap.js')
    const webIndex = path.join(clientRoot, 'out', 'assets', 'web', 'index.html')
    for (const [file, code] of [[executable, 'ELECTRON_EXECUTABLE_INVALID'], [bootstrap, 'PROJECT_BOOTSTRAP_NOT_BUILT'],
      [webIndex, 'NORMAL_APP_WEB_BUILD_NOT_FOUND']]) assertRegularFile(file, code)
    assertPeMachine(executable, PE_MACHINE_X64)
    const zipRunId = randomUUID()
    zipServer = await startLoopbackZipServer(zipInfo, 'todo.zip', zipRunId)
    report.inputs = {
      appRoot: clientRoot, appVersion: versions.appVersion, electronVersion: versions.electronVersion,
      sdkContractVersion: versions.sdkContractVersion, pluginId: todoManifest.id, pluginVersion: todoManifest.version,
      freshZip: { path: zipInfo.path, fileSize: zipInfo.fileSize, sha256: zipInfo.checksum, buildRun: zipInfo.buildRun },
      electronExecutable: executable, electronExecutableSha256: digest(fs.readFileSync(executable)),
      bootstrap, bootstrapSha256: digest(fs.readFileSync(bootstrap)), webIndex,
      loopbackUrl: zipServer.url, loopbackPort: zipServer.port
    }

    const harness = new WindowsNormalAppHarness({ appRoot: clientRoot, executable, outputRoot: output, versions })
    const profile = harness.createProfile(path.join(output, 'profiles', 'normal'))
    report.profileRoot = profile.root
    session = await harness.start({ profile, phase: 'permission-monitor-start', report })
    session.harness = harness
    ownedSessions.add(session)
    report.phases.start = { status: 'PASS', identity: { main: session.mainIdentity, renderer: session.rendererIdentity },
      targetId: session.targetId, inspectorTargetId: session.inspectorTargetId, process: session.processRecord,
      configuredPaths: session.configuredPaths }
    report.isolatedAppData = true
    report.isolationConfirmed = session.processRecord?.isolationConfirmed === true
    report.rendererNodeExposed = session.rendererIdentity?.nodeType !== 'undefined' ||
      session.rendererIdentity?.requireType !== 'undefined'

    await installRendererProbe(session.browserPage.page)
    const installed = await harness.install(session, { pluginId: 'todo', zipInfo, zipUrl: zipServer.url, version: todoManifest.version })
    report.phases.pluginInstall = { status: 'PASS', pluginDirectory: installed.pluginDirectory,
      manifest: installed.manifest, fileHashes: installed.fileHashes, accepted: installed.accepted }
    const plugin = await harness.open(session, 'todo')
    report.phases.pluginOpen = { status: 'PASS', targetId: plugin.target.id, targetUrl: plugin.target.url,
      identity: plugin.identity, opened: plugin.opened }
    const forged = await forgePermissionEvent(plugin.page)
    report.phases.pluginReservedEvent = { status: forged.status === 'REJECTED' && forged.code === 'PERMISSION_DENIED' ? 'PASS' : 'FAIL',
      attemptedEvent: permissionEvent, outcome: forged, source: 'plugin events.emit', hostOnlyEvent: true }
    if (report.phases.pluginReservedEvent.status !== 'PASS') throw new Error('PLUGIN_RESERVED_PERMISSION_EVENT_NOT_REJECTED')
    await harness.close(session, 'todo')

    const autostartInjection = await injectAutostartReadFailure(session)
    autostartInjectionInstalled = true
    if (autostartInjection?.installed !== true) throw new Error('AUTOSTART_READ_FAILURE_INJECTION_NOT_INSTALLED')
    const settingsPanel = await clickSidebarEntry(session.browserPage.page, '高级设置', settingsHash, true)
    const baseline = await waitFor(() => readRendererProbe(session.browserPage.page),
      value => value?.capabilityCalls?.length >= 1 && value.eventTransportCalls?.some(item => item.method === 'event_subscribe'),
      15_000, 'PERMISSION_PANEL_INITIAL_QUERY_OR_SUBSCRIPTION_MISSING')
    const panel = await waitFor(() => readPanel(session.browserPage.page),
      value => value?.present === true && value.status.includes('无需申请') &&
        value.authorizationStatus === '功能授权：状态未知', 10_000,
      'SCREEN_PERMISSION_PANEL_STATUS_NOT_RENDERED')
    const initialCapability = await readCapability(session.browserPage.page)
    if (!panel.status.includes('无需申请') || panel.authorizationStatus !== '功能授权：状态未知' ||
        initialCapability?.target?.platform !== 'windows' ||
        initialCapability?.osPermission !== 'not-required' || initialCapability?.authorization !== 'unknown') {
      throw new Error('WINDOWS_PERMISSION_SNAPSHOT_MISMATCH')
    }
    const autostartFailureState = await waitFor(() => readAutostartState(session.browserPage.page),
      value => value?.present === true && value.disabled === true &&
        value.status === '无法读取登录项状态，请重新打开设置后重试', 10_000,
      'AUTOSTART_READ_FAILURE_UI_NOT_FAIL_CLOSED')
    const injectedReadState = await readAutostartInjectionState(session)
    report.phases.autostartReadFailure = { status: injectedReadState?.readFailures === 1 &&
      injectedReadState.readFile === 'user_settings.json' && injectedReadState.readPath === 'system.autostart' &&
      injectedReadState.getRestoredAfterFailure === true && injectedReadState.getCurrentlyOriginal === true &&
      injectedReadState.writeGuardInstalled === true && injectedReadState.blockedAutostartWrites.length === 0 &&
      autostartFailureState.disabled === true ? 'PASS' : 'FAIL', injection: autostartInjection,
      observed: injectedReadState, ui: autostartFailureState,
      limitation: 'One Main ConfigService read error was injected in the isolated app; no real login-item API or user setting was changed.' }
    if (report.phases.autostartReadFailure.status !== 'PASS') throw new Error('AUTOSTART_READ_FAILURE_UI_NOT_FAIL_CLOSED')
    const screenshotPath = path.join(output, 'advanced-settings-permission-panel.png')
    await capturePanel(session.browserPage.page, screenshotPath)
    report.phases.settingsOpen = { status: 'PASS', navigation: 'CDP trusted mouse input on Main sidebar',
      sidebarEntry: settingsPanel, url: panel.url, panel, activeHandlerCount: baseline.activeHandlerCount,
      activeTransportSubscription: baseline.activeTransportSubscription, screenshotPath }
    report.phases.initialCapability = { status: 'PASS', ...initialCapability }

    const callsBeforeRecheck = baseline.capabilityCalls.length
    const click = await clickRecheck(session.browserPage.page)
    const afterRecheck = await waitFor(() => readRendererProbe(session.browserPage.page),
      value => value?.capabilityCalls?.length > callsBeforeRecheck && value.trustedRecheckClicks?.length > 0,
      10_000, 'SCREEN_PERMISSION_TRUSTED_RECHECK_DID_NOT_QUERY')
    const afterRecheckSnapshot = await readCapability(session.browserPage.page)
    const trustedClick = afterRecheck.trustedRecheckClicks.at(-1)?.isTrusted === true
    report.phases.recheck = { status: trustedClick && afterRecheckSnapshot?.osPermission === 'not-required' ? 'PASS' : 'FAIL',
      input: click, trustedInput: trustedClick, sdkCallsBefore: callsBeforeRecheck,
      sdkCallsAfter: afterRecheck.capabilityCalls.length, snapshot: afterRecheckSnapshot }
    if (report.phases.recheck.status !== 'PASS') throw new Error('SCREEN_PERMISSION_RECHECK_VALIDATION_FAILED')

    const injectedSignals = await injectHostSignals(session)
    const postSignalCapability = await readCapability(session.browserPage.page)
    const focusRefreshedMain = injectedSignals?.monitorRefreshCalls?.some(call => call.method === 'refreshOwner' &&
      call.ownerType === 'main' && call.webContentsId === injectedSignals?.target?.webContentsId) === true
    const resumeRefreshedSubscribers = injectedSignals?.monitorRefreshCalls?.some(call => call.method === 'refreshSubscribedOwners') === true
    report.phases.hostRefreshSignals = { status: injectedSignals?.injectedFocusSignal === true && injectedSignals?.injectedResumeSignal === true &&
      focusRefreshedMain && resumeRefreshedSubscribers && injectedSignals?.waitTimedOut === false &&
      postSignalCapability?.osPermission === 'not-required' ? 'PASS' : 'FAIL', injectedOSsignal: true,
      injectedSignals: ['app.browser-window-focus', 'powerMonitor.resume'], target: injectedSignals?.target,
      monitorRefreshCalls: injectedSignals?.monitorRefreshCalls ?? [], focusRefreshedMain, resumeRefreshedSubscribers,
      stateAfter: postSignalCapability, limitation: 'Windows screen capture has no changing OS permission; this verifies injected hooks and stable state only.' }
    if (report.phases.hostRefreshSignals.status !== 'PASS') throw new Error('PERMISSION_HOST_REFRESH_SIGNAL_FAILED')

    await clickSidebarEntry(session.browserPage.page, '关于我们', alternateHash, false)
    const closedProbe = await waitFor(() => readRendererProbe(session.browserPage.page),
      value => value?.eventTransportCalls?.filter(item => item.method === 'event_unsubscribe').length >= 1 &&
        value.activeHandlerCount === 0 && value.activeTransportSubscription === false,
      10_000, 'PERMISSION_EVENT_SUBSCRIPTION_LEAKED_AFTER_ROUTE_EXIT')
    await clickSidebarEntry(session.browserPage.page, '高级设置', settingsHash, true)
    const autostartRecoveredState = await waitFor(() => readAutostartState(session.browserPage.page),
      value => value?.present === true && value.disabled === false && value.status.length > 0 &&
        value.status !== '无法读取登录项状态，请重新打开设置后重试', 10_000,
      'AUTOSTART_READ_STATE_DID_NOT_RECOVER_AFTER_REENTRY')
    const recoveredInjectionState = await readAutostartInjectionState(session)
    const injectionCleanup = await restoreAutostartInjection(session)
    autostartInjectionInstalled = false
    report.phases.autostartRecovery = { status: recoveredInjectionState?.readFailures === 1 &&
      recoveredInjectionState.readFile === 'user_settings.json' && recoveredInjectionState.readPath === 'system.autostart' &&
      recoveredInjectionState.getCurrentlyOriginal === true && autostartRecoveredState.disabled === false &&
      autostartRecoveredState.status !== '无法读取登录项状态，请重新打开设置后重试' &&
      autostartRecoveredState.checked === autostartFailureState.checked &&
      recoveredInjectionState.writeGuardInstalled === true && recoveredInjectionState.blockedAutostartWrites.length === 0 &&
      injectionCleanup?.restored === true ? 'PASS' : 'FAIL',
      ui: autostartRecoveredState, beforeRestore: recoveredInjectionState, cleanup: injectionCleanup,
      limitation: 'The failed getter restored itself before page reentry; retry reads the saved state. The write guard blocked matching changes and observed zero attempts.' }
    if (report.phases.autostartRecovery.status !== 'PASS') throw new Error('AUTOSTART_READ_STATE_DID_NOT_RECOVER_AFTER_REENTRY')
    const reopenedProbe = await waitFor(() => readRendererProbe(session.browserPage.page),
      value => value?.eventTransportCalls?.filter(item => item.method === 'event_subscribe').length >= 2 &&
        value.activeHandlerCount === 1 && value.activeTransportSubscription === true,
      15_000, 'PERMISSION_EVENT_SUBSCRIPTION_NOT_REESTABLISHED')
    report.phases.settingsLifecycle = {
      status: closedProbe.eventTransportCalls.filter(item => item.method === 'event_unsubscribe').length === 1 &&
        reopenedProbe.eventTransportCalls.filter(item => item.method === 'event_subscribe').length === 2 ? 'PASS' : 'FAIL',
      firstExit: { activeHandlerCount: closedProbe.activeHandlerCount,
        activeTransportSubscription: closedProbe.activeTransportSubscription,
        subscribeCalls: closedProbe.eventTransportCalls.filter(item => item.method === 'event_subscribe').length,
        unsubscribeCalls: closedProbe.eventTransportCalls.filter(item => item.method === 'event_unsubscribe').length },
      reopen: { activeHandlerCount: reopenedProbe.activeHandlerCount,
        activeTransportSubscription: reopenedProbe.activeTransportSubscription,
        subscribeCalls: reopenedProbe.eventTransportCalls.filter(item => item.method === 'event_subscribe').length,
        unsubscribeCalls: reopenedProbe.eventTransportCalls.filter(item => item.method === 'event_unsubscribe').length }
    }
    if (report.phases.settingsLifecycle.status !== 'PASS') throw new Error('PERMISSION_EVENT_LISTENER_LIFECYCLE_MISMATCH')
    report.status = 'PASS'
    report.completeCase = true
  } catch (error) {
    report.failureCode = safeErrorCode(error)
    if (typeof error?.stage === 'string' && /^[a-z0-9-]{1,80}$/i.test(error.stage)) report.failureStage = error.stage
    if (error?.cleanup && typeof error.cleanup === 'object') report.failureCleanup = error.cleanup
    if (typeof error?.stack === 'string') report.failureDiagnostic = error.stack.slice(0, 4000)
    report.failedAt = new Date().toISOString()
    console.error(report.failureCode)
    process.exitCode = 1
  } finally {
    if (session) {
      if (autostartInjectionInstalled) {
        try {
          const cleanup = await restoreAutostartInjection(session)
          report.phases.autostartInjectionCleanup = { status: cleanup?.restored === true ? 'PASS' : 'FAIL', ...cleanup }
          if (cleanup?.restored !== true) { report.status = 'FAIL'; report.failureCode ??= 'AUTOSTART_PROBE_RESTORE_FAILED'; process.exitCode = 1 }
        } catch (error) {
          report.phases.autostartInjectionCleanup = { status: 'FAIL', reason: safeErrorCode(error) }
          report.status = 'FAIL'; report.failureCode ??= 'AUTOSTART_PROBE_RESTORE_FAILED'; process.exitCode = 1
        }
      }
      const stopped = await session.harness?.stop(session) ?? { cleanupConfirmed: false, reason: 'HARNESS_REFERENCE_MISSING' }
      ownedSessions.delete(session)
      report.phases.normalAppExit = { status: stopped.cleanupConfirmed ? 'PASS' : 'FAIL', ...stopped }
      if (!stopped.cleanupConfirmed) {
        report.status = 'FAIL'
        report.failureCode ??= 'OWNED_ELECTRON_CLEANUP_UNCONFIRMED'
        process.exitCode = 1
      }
    }
    for (const active of [...ownedSessions]) {
      const stopped = await active.harness?.stop(active) ?? { cleanupConfirmed: false }
      ownedSessions.delete(active)
      if (!stopped.cleanupConfirmed) { report.status = 'FAIL'; report.failureCode ??= 'OWNED_ELECTRON_CLEANUP_UNCONFIRMED'; process.exitCode = 1 }
    }
    if (zipServer) {
      try { await closeLoopbackZipServer(zipServer.server); report.loopbackServerStopped = true }
      catch { report.loopbackServerStopped = false; report.status = 'FAIL'; report.failureCode ??= 'LOOPBACK_SERVER_CLOSE_UNCONFIRMED'; process.exitCode = 1 }
    }
    report.updatedAt = new Date().toISOString()
    report.scratchPreserved = true
    report.macAcceptance = 'NOT_RUN'
    if (fs.existsSync(output) && !fs.existsSync(report.outputReport)) {
      fs.writeFileSync(report.outputReport, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    }
    if (report.status === 'PASS') {
      const evidence = writeEvidence(report)
      report.evidence = evidence
      fs.writeFileSync(report.outputReport, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' })
    }
    if (report.status === 'FAIL') process.exitCode = 1
    console.log(JSON.stringify(report))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === runnerPath) {
  void run().catch(error => { console.error(safeErrorCode(error)); process.exitCode = 1 })
}
