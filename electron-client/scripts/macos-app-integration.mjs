import { cleanupOwnedMacApp, validateOwnedMacBrowserProcess } from './macos-owned-cleanup.mjs'
import { macAppLaunchCommand, runMacLifecycleBaseline } from './macos-lifecycle-baseline.mjs'
import { MAC_PLUGIN_BASELINE_IDS, runMacPluginBaseline } from './macos-plugin-baseline.mjs'
import { startLoopbackFixtures } from './macos-loopback-fixtures.mjs'
import { collectMacCapabilityBaseline, collectMacDisplayBaseline, collectMacOwnedProcessBaseline, validateCapabilityBaseline, validateDisplayBaseline, validateOwnedProcessBaseline } from './macos-readonly-cases.mjs'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { parseMacTestArguments, inspectMacApp, compareOsVersions } from './macos-preflight.mjs'
import { CdpClient, runMainPrebootIsolationGate } from './lib/normal-app-preboot-isolation.mjs'

export const MAC_AUTOMATIC_CASES = Object.freeze(['M01', 'M03'])
export const MAC_COLLECTION_CASES = Object.freeze(['M01', 'M02', 'M03', 'M05', 'M06', 'M08', 'M13'])
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const snapshotExpression = `(async () => {
  const deadline = Date.now() + 10000;
  while (!window.ztools?.isElectron?.() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!window.ztools?.isElectron?.()) return { isElectron: false };
  const identity = await window.ztools.sys.getRuntimeIdentity();
  const info = await window.ztools.sys.getInfo();
  const capture = await window.ztools.sys.getCapability('screen.capture');
  let unknownCapabilityCode = null;
  try { await window.ztools.sys.getCapability('not.registered'); }
  catch (error) { unknownCapabilityCode = typeof error?.code === 'string' ? error.code : null; }
  return { isElectron: true, identity, platform: info.platform, osVersion: info.osVersion,
    capture, unknownCapabilityCode, userAgent: navigator.userAgent,
    nodeType: typeof process, requireType: typeof require, url: location.href };
})()`

export function validateMacSnapshot(snapshot, expectedArch, expectedAppVersion) {
  const fail = code => ({ status: 'FAIL', code })
  if (!snapshot?.isElectron || !/^ztools:\/\/web\//.test(snapshot.url ?? '')) return fail('WRONG_TEST_HOST')
  const identity = snapshot.identity
  if (identity?.contractVersion !== 1 || identity.target?.platform !== 'macos' ||
      identity.target?.runtime !== 'electron' || identity.target?.arch !== 'universal') return fail('RUNTIME_CONTRACT_MISMATCH')
  if (!identity.os || !['x64', 'arm64', 'unknown'].includes(identity.os.arch) ||
      typeof identity.os.productVersion !== 'string' ||
      !['native', 'translated', 'unknown'].includes(identity.process?.translationMode) ||
      !['available', 'unavailable', 'unknown', 'not-applicable'].includes(identity.nativeHost?.state) ||
      !['ia32', 'x64', 'arm64', 'unknown'].includes(identity.nativeHost?.arch) ||
      !(identity.nativeHost.protocolVersion === null ||
        Number.isSafeInteger(identity.nativeHost.protocolVersion) && identity.nativeHost.protocolVersion > 0)) return fail('RUNTIME_CONTRACT_MISMATCH')
  if (identity.process?.arch !== expectedArch) return fail('PROCESS_ARCH_MISMATCH')
  if (identity.appVersion !== expectedAppVersion) return fail('APP_VERSION_MISMATCH')
  if (!/\bElectron\/43\.4\.1(?:\s|$)/.test(snapshot.userAgent ?? '')) return fail('ELECTRON_VERSION_MISMATCH')
  if (snapshot.platform !== 'macos' || snapshot.nodeType !== 'undefined' || snapshot.requireType !== 'undefined') return fail('RENDERER_ISOLATION_MISMATCH')
  const capture = snapshot.capture
  if (capture?.contractVersion !== 1 || capture.capability !== 'screen.capture' ||
      capture.target?.platform !== 'macos' || capture.target?.runtime !== 'electron' || capture.target?.arch !== expectedArch ||
      !['supported', 'unsupported', 'unavailable'].includes(capture.implementation) ||
      !['granted', 'denied', 'unknown'].includes(capture.authorization) ||
      !['not-required', 'not-determined', 'granted', 'denied', 'restricted', 'unknown'].includes(capture.osPermission) ||
      !Number.isSafeInteger(capture.revision) || capture.revision < 0) return fail('CAPABILITY_CONTRACT_MISMATCH')
  if (snapshot.unknownCapabilityCode !== 'INVALID_REQUEST') return fail('ERROR_CONTRACT_MISMATCH')
  return { status: 'PASS', identity, capture, electronVersion: '43.4.1', osVersion: snapshot.osVersion }
}

async function freeLoopbackPort(excludedPorts = []) {
  const server = net.createServer()
  const excluded = new Set(excludedPorts)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    if (!excluded.has(port)) return port
  }
  throw new Error('LOOPBACK_PORT_ALLOCATION_FAILED')
}

async function connectCdp(url, port, expectedPathPrefix = '/devtools/') {
  return await CdpClient.connect(url, port, expectedPathPrefix)
}

const existingIdentityCaseId = 'F22-I01'

export function parseExistingCdpIdentityArguments(argv) {
  const { values } = parseArgs({ args: argv, options: {
    'attach-existing': { type: 'boolean' }, 'existing-cdp-port': { type: 'string' }, 'expected-process-path': { type: 'string' },
    'main-inspect-port': { type: 'string' },
    'expected-platform': { type: 'string' }, 'expect-process-arch': { type: 'string' },
    'expected-app-version': { type: 'string' }, 'expected-electron-version': { type: 'string' },
    'expected-user-data': { type: 'string' }, 'target-id': { type: 'string' }, action: { type: 'string' },
    output: { type: 'string' }, help: { type: 'boolean' }
  } })
  if (values.help) return values
  if (values['attach-existing'] !== true) throw new Error('ATTACH_EXISTING_REQUIRED')
  const port = Number(values['existing-cdp-port'])
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('INVALID_EXISTING_CDP_PORT')
  const mainInspectPort = values['main-inspect-port'] === undefined ? null : Number(values['main-inspect-port'])
  if (mainInspectPort !== null && (!Number.isSafeInteger(mainInspectPort) || mainInspectPort < 1024 || mainInspectPort > 65535)) {
    throw new Error('INVALID_MAIN_INSPECT_PORT')
  }
  if (mainInspectPort === port) throw new Error('INSPECTOR_PORT_COLLISION')
  if (!values.output || !path.isAbsolute(values.output)) throw new Error('OUTPUT_MUST_BE_ABSOLUTE')
  const expectedPlatform = values['expected-platform']
  if (!['windows', 'macos'].includes(expectedPlatform)) throw new Error('INVALID_EXPECTED_PLATFORM')
  const expectedArch = values['expect-process-arch']
  if (!['ia32', 'x64', 'arm64'].includes(expectedArch)) throw new Error('INVALID_EXPECTED_PROCESS_ARCH')
  const expectedProcessPath = values['expected-process-path']
  const pathIsAbsolute = expectedPlatform === 'windows' ? path.win32.isAbsolute : path.posix.isAbsolute
  if (!expectedProcessPath || !pathIsAbsolute(expectedProcessPath) || /[\u0000-\u001f\u007f]/.test(expectedProcessPath)) {
    throw new Error('EXPECTED_PROCESS_PATH_MUST_BE_ABSOLUTE')
  }
  if (values['expected-user-data'] && (!pathIsAbsolute(values['expected-user-data']) || /[\u0000-\u001f\u007f]/.test(values['expected-user-data']))) {
    throw new Error('EXPECTED_USER_DATA_MUST_BE_ABSOLUTE')
  }
  if (values['target-id'] && (values['target-id'].length > 128 || /[\u0000-\u001f\u007f]/.test(values['target-id']))) {
    throw new Error('INVALID_CDP_TARGET_ID')
  }
  if (values.action && values.action !== 'about-roundtrip') throw new Error('ACTION_NOT_PREPARED')
  for (const [key, value] of [['expected-app-version', values['expected-app-version']], ['expected-electron-version', values['expected-electron-version']]]) {
    if (value !== undefined && (value.length > 128 || !/^[0-9A-Za-z.-]+$/.test(value))) throw new Error(`INVALID_${key.toUpperCase().replaceAll('-', '_')}`)
  }
  return { ...values, port, expectedPlatform, expectedArch, expectedProcessPath,
    mainInspectPort, expectedElectronUserDataPath: values['expected-user-data'], targetId: values['target-id'] }
}

function readProjectRuntimeVersions() {
  const packageInfo = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
  const protocolSource = fs.readFileSync(fileURLToPath(new URL('../src/contracts/protocol-versions.ts', import.meta.url)), 'utf8')
  const contractMatch = protocolSource.match(/SDK_CONTRACT\s*=\s*(\d+)/)
  if (typeof packageInfo.version !== 'string' || !/^[0-9A-Za-z.-]{1,128}$/.test(packageInfo.version) ||
      typeof packageInfo.devDependencies?.electron !== 'string' || !/^\d+\.\d+\.\d+$/.test(packageInfo.devDependencies.electron) ||
      !contractMatch || !Number.isSafeInteger(Number(contractMatch[1]))) throw new Error('PROJECT_RUNTIME_VERSION_METADATA_INVALID')
  return { appVersion: packageInfo.version, electronVersion: packageInfo.devDependencies.electron, sdkContractVersion: Number(contractMatch[1]) }
}

export function validateExistingCdpIdentitySnapshot(snapshot, expected) {
  const fail = code => ({ status: 'FAIL', code })
  const targetArch = expected.platform === 'macos' ? 'universal' : expected.arch
  const pathIsAbsolute = expected.platform === 'windows' ? path.win32.isAbsolute : path.posix.isAbsolute
  if (!snapshot?.isElectron || !/^ztools:\/\/web(?:\/|$)/.test(snapshot.url ?? '')) return fail('WRONG_ZTOOLS_TARGET')
  const identity = snapshot.identity
  if (identity?.contractVersion !== 1 || identity.target?.platform !== expected.platform ||
      identity.target?.runtime !== 'electron' || identity.target?.arch !== targetArch ||
      !['ia32', 'x64', 'arm64'].includes(identity.os?.arch) ||
      !['ia32', 'x64', 'arm64'].includes(identity.process?.arch) ||
      !['native', 'translated', 'compatibility', 'not-applicable', 'unknown'].includes(identity.process?.translationMode) ||
      typeof identity.os.productVersion !== 'string' || !identity.os.productVersion ||
      identity.process.arch !== expected.arch || identity.appVersion !== expected.appVersion ||
      snapshot.targetId !== expected.targetId || snapshot.url !== expected.targetUrl) return fail('RUNTIME_IDENTITY_MISMATCH')
  if (snapshot.platform !== expected.platform || snapshot.osArch !== identity.os.arch || snapshot.osVersion !== identity.os.productVersion ||
      snapshot.processArch !== expected.arch || snapshot.appName !== 'ZTools' ||
      snapshot.appVersion !== expected.appVersion || snapshot.sdkContractVersion !== expected.sdkContractVersion ||
      snapshot.nodeType !== 'undefined' || snapshot.requireType !== 'undefined' ||
      !new RegExp(`\\bElectron/${expected.electronVersion.replaceAll('.', '\\.')}\\b`).test(snapshot.userAgent ?? '')) {
    return fail('APP_SDK_VERSION_OR_ISOLATION_MISMATCH')
  }
  const main = snapshot.mainInspector
  const pathApi = expected.platform === 'windows' ? path.win32 : path.posix
  if (!main || !Number.isSafeInteger(main.pid) || main.pid !== snapshot.browserPid ||
      typeof main.executablePath !== 'string' || !pathIsAbsolute(main.executablePath) ||
      normalizeCdpPath(main.executablePath, expected.platform) !== normalizeCdpPath(expected.processPath, expected.platform) ||
      main.electronVersion !== expected.electronVersion || main.appVersion !== expected.appVersion ||
      typeof main.electronUserDataPath !== 'string' || !pathIsAbsolute(main.electronUserDataPath) ||
      typeof main.electronAppDataPath !== 'string' || !pathIsAbsolute(main.electronAppDataPath) ||
      typeof main.ztoolsDataRoot !== 'string' || !pathIsAbsolute(main.ztoolsDataRoot) ||
      typeof main.pluginRoot !== 'string' || !pathIsAbsolute(main.pluginRoot) ||
      normalizeCdpPath(main.ztoolsDataRoot, expected.platform) !== normalizeCdpPath(pathApi.join(main.electronAppDataPath, 'ZTools', 'Data'), expected.platform) ||
      normalizeCdpPath(main.pluginRoot, expected.platform) !== normalizeCdpPath(pathApi.join(main.ztoolsDataRoot, 'Plugins'), expected.platform) ||
      main.isPackaged !== false && main.isPackaged !== true ||
      typeof main.inspectorTargetId !== 'string' || main.inspectorTargetId.length < 1 || main.inspectorTargetId.length > 128 ||
      typeof main.dataRootExists !== 'boolean' || typeof main.pluginRootExists !== 'boolean') {
    return fail('MAIN_INSPECTOR_IDENTITY_MISMATCH')
  }
  if (expected.electronUserDataPath && normalizeCdpPath(main.electronUserDataPath, expected.platform) !== normalizeCdpPath(expected.electronUserDataPath, expected.platform)) {
    return fail('USER_DATA_PATH_MISMATCH')
  }
  if (typeof snapshot.sdkSystemUserDataPath !== 'string' || !pathIsAbsolute(snapshot.sdkSystemUserDataPath) ||
      /[\u0000-\u001f\u007f]/.test(snapshot.sdkSystemUserDataPath)) return fail('SDK_SYSTEM_USER_DATA_PATH_MISMATCH')
  return { status: 'BASELINE_PASS', snapshot: {
    identity, platform: snapshot.platform, appName: snapshot.appName,
    appVersion: snapshot.appVersion, sdkContractVersion: snapshot.sdkContractVersion,
    electronVersion: expected.electronVersion, osVersion: identity.os.productVersion, osArch: identity.os.arch,
    processArch: identity.process.arch, translationMode: identity.process.translationMode,
    sdkSystemUserDataPath: snapshot.sdkSystemUserDataPath,
    browserPid: snapshot.browserPid, processPath: snapshot.processPath,
    mainInspector: main, targetId: snapshot.targetId, url: snapshot.url
  } }
}

function normalizeCdpPath(value, platform) {
  return platform === 'windows' ? path.win32.normalize(value).toLocaleLowerCase('en-US') : path.posix.normalize(value)
}

async function collectExistingIdentityInPage() {
  const sdk = window.ztools
  if (!sdk || typeof sdk.isElectron !== 'function' || !sdk.isElectron()) return { isElectron: false, url: location.href }
  const identity = await sdk.sys.getRuntimeIdentity()
  const info = await sdk.sys.getInfo()
  const sdkSystemUserDataPath = await sdk.sys.getPath('userData')
  return { isElectron: true, identity, platform: info.platform, processArch: info.processArch,
    osVersion: info.osVersion, osArch: info.osArch, appName: info.appName, appVersion: info.appVersion,
    sdkContractVersion: window.__ztoolsElectron?.contractVersion,
    sdkSystemUserDataPath, userAgent: navigator.userAgent, nodeType: typeof process, requireType: typeof require,
    url: location.href }
}

async function readNavigationStateInPage() {
  const active = document.querySelector('aside nav .sidebar-item.active')
  const aboutHeading = document.querySelector('main .about-page .brand-name')
  const myPage = document.querySelector('main .my-page')
  const heading = aboutHeading ?? document.querySelector('main .my-page h2.section-title')
  return { url: location.href, hash: location.hash, activeLabel: active?.innerText?.replace(/\s+/g, ' ').trim() ?? null,
    heading: heading?.textContent?.replace(/\s+/g, ' ').trim() ?? null,
    contentType: aboutHeading ? 'about' : myPage ? 'my' : 'other',
    sidebarItems: [...document.querySelectorAll('aside nav .sidebar-item')].map(item => ({
      label: item.innerText?.replace(/\s+/g, ' ').trim() ?? '', active: item.classList.contains('active'), visible: item.getClientRects().length > 0
    })),
    isElectron: typeof window.ztools?.isElectron === 'function' && window.ztools.isElectron() }
}

async function locateVisibleSidebarItemInPage(label) {
  const items = [...document.querySelectorAll('aside nav .sidebar-item')]
  const element = items.find(item => item.innerText?.replace(/\s+/g, ' ').trim() === label && item.getClientRects().length > 0)
  if (!element) return { found: false }
  const rect = element.getBoundingClientRect()
  return { found: true, label, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    width: rect.width, height: rect.height, viewportWidth: document.documentElement.clientWidth,
    viewportHeight: document.documentElement.clientHeight }
}

async function evaluatePageValue(page, expression, awaitPromise = true) {
  const result = await page.call('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (result.exceptionDetails) throw new Error('CDP_PAGE_EVALUATION_FAILED')
  return result.result?.value
}

async function readNavigationState(page) {
  return evaluatePageValue(page, `(${readNavigationStateInPage.toString()})()`)
}

async function locateSidebarItem(page, label) {
  const value = await evaluatePageValue(page, `(${locateVisibleSidebarItemInPage.toString()})(${JSON.stringify(label)})`)
  if (!value?.found || !Number.isFinite(value.x) || !Number.isFinite(value.y) || value.width <= 0 || value.height <= 0 ||
      value.x < 0 || value.y < 0 || value.x >= value.viewportWidth || value.y >= value.viewportHeight) {
    throw new Error('VISIBLE_NAVIGATION_TARGET_MISSING')
  }
  return { label, x: value.x, y: value.y }
}

async function dispatchRealMouseClick(page, point) {
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  try {
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  } catch (error) {
    await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }).catch(() => {})
    throw error
  }
}

async function waitForNavigationState(page, expectedHash, expectedLabel, expectedContentType, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let state
  do {
    state = await readNavigationState(page)
    if (state?.hash === expectedHash && state?.activeLabel === expectedLabel &&
        state?.contentType === expectedContentType && state?.isElectron === true) return state
    await delay(100)
  } while (Date.now() < deadline)
  return state
}

export async function runExistingAppAboutNavigation(page, { timeoutMs = 5000 } = {}) {
  const result = { caseId: 'F22-N01', status: 'ACTION_FAIL', scope: 'real-ui-about-navigation-roundtrip', completeCase: false,
    action: 'about-roundtrip', input: 'CDP Input.dispatchMouseEvent left-button click', cleanup: 'ROUTE_RESTORE_PENDING' }
  let initial, restored = false
  try {
    initial = await readNavigationState(page)
    result.initialState = initial
    if (!initial?.isElectron || initial.hash !== '#/' || initial.activeLabel !== '我的' || initial.contentType !== 'my') throw new Error('ACTION_PRECONDITION_FAILED')
    const aboutPoint = await locateSidebarItem(page, '关于我们')
    const homePoint = await locateSidebarItem(page, '我的')
    await page.call('Page.bringToFront')
    await dispatchRealMouseClick(page, aboutPoint)
    const about = await waitForNavigationState(page, '#/about', '关于我们', 'about', timeoutMs)
    if (about?.hash !== '#/about' || about?.activeLabel !== '关于我们' || about?.contentType !== 'about' || about?.isElectron !== true) throw new Error('ABOUT_NAVIGATION_ASSERTION_FAILED')
    await dispatchRealMouseClick(page, homePoint)
    const home = await waitForNavigationState(page, '#/', '我的', 'my', timeoutMs)
    restored = home?.hash === '#/' && home?.activeLabel === '我的' && home?.contentType === 'my' && home?.isElectron === true
    if (!restored) throw new Error('HOME_NAVIGATION_ASSERTION_FAILED')
    result.status = 'ACTION_PASS'
    result.steps = [
      { operation: 'click-sidebar', label: '关于我们', eventSequence: ['mouseMoved', 'mousePressed:left', 'mouseReleased:left'],
        assertedHash: about.hash, assertedActiveLabel: about.activeLabel, heading: about.heading },
      { operation: 'click-sidebar', label: '我的', eventSequence: ['mouseMoved', 'mousePressed:left', 'mouseReleased:left'],
        assertedHash: home.hash, assertedActiveLabel: home.activeLabel, heading: home.heading }
    ]
    result.initialUrl = initial.url
    result.finalUrl = home.url
    result.cleanup = 'ROUTE_RESTORED'
    return result
  } catch (error) {
    result.code = /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'UI_NAVIGATION_FAILED'
    if (initial?.url) result.initialUrl = initial.url
    return result
  } finally {
    if (!restored && initial?.hash === '#/') {
      try {
        const current = await readNavigationState(page)
        if (current?.hash !== initial.hash) {
          const homePoint = await locateSidebarItem(page, '我的')
          await dispatchRealMouseClick(page, homePoint)
          const state = await waitForNavigationState(page, '#/', '我的', 'my', timeoutMs)
          restored = state?.hash === '#/' && state?.activeLabel === '我的' && state?.contentType === 'my'
          result.cleanup = restored ? 'ROUTE_RESTORED_AFTER_FAILURE' : 'ROUTE_RESTORE_UNCONFIRMED'
        } else {
          result.cleanup = 'ROUTE_UNCHANGED'
        }
      } catch { result.cleanup = 'ROUTE_RESTORE_UNCONFIRMED' }
    }
  }
}

export function readCdpProcessExecutablePath(pid, platform = process.platform, exec = execFileSync) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('INVALID_CDP_PROCESS_ID')
  if (platform === 'win32') {
    const output = exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -First 1 -ExpandProperty ExecutablePath`],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 4096, windowsHide: true })
    const value = output.trim()
    if (!value || value.includes('\n') || value.includes('\r')) throw new Error('PROCESS_PATH_UNAVAILABLE')
    return value
  }
  if (platform === 'darwin') {
    const output = exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 8192 })
    const value = output.split(/\r?\n/).find(line => line.startsWith('n'))?.slice(1)
    if (!value || !path.posix.isAbsolute(value)) throw new Error('PROCESS_PATH_UNAVAILABLE')
    return value
  }
  throw new Error('UNSUPPORTED_PROCESS_PATH_PLATFORM')
}

async function fetchLoopbackJson(port, suffix, fetchImpl = fetch) {
  const response = await fetchImpl(`http://127.0.0.1:${port}${suffix}`, {
    redirect: 'error', signal: AbortSignal.timeout(3000)
  })
  if (!response.ok) throw new Error('CDP_HTTP_UNAVAILABLE')
  const body = await response.text()
  if (body.length > 2 * 1024 * 1024) throw new Error('CDP_RESPONSE_TOO_LARGE')
  try { return JSON.parse(body) } catch { throw new Error('INVALID_CDP_RESPONSE') }
}

function summarizeCdpTargets(targets) {
  return targets.slice(0, 32).map(target => {
    target = target && typeof target === 'object' ? target : {}
    let url = null
    try {
      const parsed = new URL(target.url)
      parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''
      url = parsed.toString()
    } catch { /* Invalid URLs remain null and cannot be selected as ZTools. */ }
    return { id: typeof target.id === 'string' ? target.id.slice(0, 128) : null,
      type: typeof target.type === 'string' ? target.type.slice(0, 64) : null,
      title: typeof target.title === 'string' ? target.title.slice(0, 160) : null, url }
  })
}

async function evaluateInspectorValue(inspector, expression) {
  const evaluated = await inspector.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (evaluated.exceptionDetails) throw new Error('MAIN_INSPECTOR_EVALUATION_FAILED')
  if (!evaluated.result || !Object.hasOwn(evaluated.result, 'value')) throw new Error('MAIN_INSPECTOR_VALUE_UNAVAILABLE')
  return evaluated.result.value
}

export async function inspectMainProcessIdentity({ port, browserPid, expected, fetchImpl = fetch, connect = connectCdp }) {
  if (!port) return { status: 'FAIL', code: 'MAIN_INSPECTOR_NOT_PROVIDED' }
  let inspector
  try {
    const targets = await fetchLoopbackJson(port, '/json/list', fetchImpl)
    if (!Array.isArray(targets) || targets.length > 1024) throw new Error('INVALID_MAIN_INSPECTOR_TARGET_LIST')
    const nodeTargets = targets.filter(target => target?.type === 'node')
    if (nodeTargets.length !== 1) throw new Error(nodeTargets.length === 0
      ? 'MAIN_INSPECTOR_TARGET_MISSING' : 'AMBIGUOUS_MAIN_INSPECTOR_TARGET')
    const target = nodeTargets[0]
    if (typeof target.id !== 'string' || target.id.length < 1 || target.id.length > 128 ||
        typeof target.webSocketDebuggerUrl !== 'string') throw new Error('INVALID_MAIN_INSPECTOR_TARGET')
    const endpoint = new URL(target.webSocketDebuggerUrl)
    if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== String(port) ||
        endpoint.pathname !== `/${target.id}`) throw new Error('INVALID_MAIN_INSPECTOR_ENDPOINT')
    inspector = await connect(target.webSocketDebuggerUrl, port, `/${target.id}`)
    const processSnapshot = await evaluateInspectorValue(inspector,
      `(() => ({ pid: process.pid, executablePath: process.execPath, electronVersion: process.versions.electron ?? null }))()`)
    const pathIsAbsolute = expected.platform === 'windows' ? path.win32.isAbsolute : path.posix.isAbsolute
    if (!Number.isSafeInteger(processSnapshot.pid) || processSnapshot.pid !== browserPid) {
      return { status: 'FAIL', code: 'MAIN_INSPECTOR_PID_MISMATCH', snapshot: { inspectorTargetId: target.id, ...processSnapshot } }
    }
    if (typeof processSnapshot.executablePath !== 'string' || !pathIsAbsolute(processSnapshot.executablePath) ||
        normalizeCdpPath(processSnapshot.executablePath, expected.platform) !== normalizeCdpPath(expected.processPath, expected.platform)) {
      return { status: 'FAIL', code: 'MAIN_INSPECTOR_PROCESS_PATH_MISMATCH', snapshot: { inspectorTargetId: target.id, ...processSnapshot } }
    }
    if (processSnapshot.electronVersion !== expected.electronVersion) {
      return { status: 'FAIL', code: 'MAIN_INSPECTOR_ELECTRON_VERSION_MISMATCH', snapshot: { inspectorTargetId: target.id, ...processSnapshot } }
    }
    const appSnapshot = await evaluateInspectorValue(inspector, `(() => {
      const electron = process.mainModule?.require?.('electron');
      const app = electron?.app;
      if (!app) return null;
      const fs = process.mainModule.require('node:fs');
      const path = process.mainModule.require('node:path');
      const electronUserDataPath = app.getPath('userData');
      const electronAppDataPath = app.getPath('appData');
      const ztoolsDataRoot = path.join(electronAppDataPath, 'ZTools', 'Data');
      const pluginRoot = path.join(ztoolsDataRoot, 'Plugins');
      let dataRootExists = false, pluginRootExists = false;
      try { dataRootExists = fs.statSync(ztoolsDataRoot).isDirectory(); } catch {}
      try { pluginRootExists = fs.statSync(pluginRoot).isDirectory(); } catch {}
      return { appVersion: app.getVersion(), electronUserDataPath, electronAppDataPath,
        ztoolsDataRoot, pluginRoot, dataRootExists, pluginRootExists,
        isPackaged: app.isPackaged };
    })()`)
    if (appSnapshot === null) return { status: 'FAIL', code: 'MAIN_ELECTRON_APP_UNAVAILABLE', snapshot: { inspectorTargetId: target.id, ...processSnapshot } }
    const snapshot = { inspectorTargetId: target.id, ...processSnapshot, ...appSnapshot }
    if (snapshot.appVersion !== expected.appVersion) {
      return { status: 'FAIL', code: 'MAIN_INSPECTOR_APP_VERSION_MISMATCH', snapshot }
    }
    return { status: 'PASS', snapshot }
  } catch (error) {
    return { status: 'FAIL', code: /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'MAIN_INSPECTOR_FAILED' }
  } finally { inspector?.dispose() }
}

async function collectInstalledPluginInventoryInPage() {
  const sdk = window.ztools
  if (!sdk || typeof sdk.isElectron !== 'function' || !sdk.isElectron() || typeof sdk.plugin?.getList !== 'function') {
    return { status: 'READONLY_FAIL', code: 'PLUGIN_LIST_API_UNAVAILABLE' }
  }
  const result = await sdk.plugin.getList()
  if (!result?.success || !Array.isArray(result.data) || result.data.length > 1000) {
    return { status: 'READONLY_FAIL', code: 'PLUGIN_LIST_RESPONSE_INVALID' }
  }
  const plugins = result.data.map(plugin => ({ pluginId: plugin.pluginId ?? plugin.id ?? null,
    name: typeof plugin.name === 'string' ? plugin.name : null,
    version: typeof plugin.version === 'string' ? plugin.version : null,
    entry: typeof plugin.entry === 'string' ? plugin.entry : null,
    enabled: plugin.enabled !== false }))
  if (plugins.some(plugin => typeof plugin.pluginId !== 'string' || typeof plugin.version !== 'string')) {
    return { status: 'READONLY_FAIL', code: 'PLUGIN_LIST_ITEM_INVALID', count: plugins.length }
  }
  return { status: 'READONLY_PASS', scope: 'normal-app-installed-plugin-inventory', source: 'window.ztools.plugin.getList',
    count: plugins.length, plugins }
}

export async function collectInstalledPluginInventory(page) {
  try {
    const result = await evaluatePageValue(page, `(${collectInstalledPluginInventoryInPage.toString()})()`, true)
    return result && typeof result === 'object' ? result : { status: 'READONLY_FAIL', code: 'PLUGIN_LIST_RESULT_UNAVAILABLE' }
  } catch (error) {
    return { status: 'READONLY_FAIL', code: /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'PLUGIN_LIST_COLLECTION_FAILED' }
  }
}

export async function runExistingCdpIdentity(options, {
  runnerPlatform = process.platform, fetchImpl = fetch, connect = connectCdp,
  processPath = readCdpProcessExecutablePath, projectVersions = readProjectRuntimeVersions,
  inspectMain = inspectMainProcessIdentity, performNavigation = runExistingAppAboutNavigation,
  collectPlugins = collectInstalledPluginInventory
} = {}) {
  const expectedRunnerPlatform = options.expectedPlatform === 'windows' ? 'win32' : 'darwin'
  const result = { preflight: { status: 'PENDING' }, cases: [], cleanup: 'EXISTING_PROCESS_LEFT_RUNNING' }
  let browser, page
  try {
    if (runnerPlatform !== expectedRunnerPlatform) {
      result.preflight = { status: 'FAIL', code: 'RUNNER_PLATFORM_MISMATCH' }
      result.cases = [{ caseId: existingIdentityCaseId, status: 'FAIL', code: 'RUNNER_PLATFORM_MISMATCH' }]
      return result
    }
    const versions = projectVersions()
    const expected = { platform: options.expectedPlatform, arch: options.expectedArch,
      appVersion: options['expected-app-version'] ?? versions.appVersion,
      electronVersion: options['expected-electron-version'] ?? versions.electronVersion,
      sdkContractVersion: versions.sdkContractVersion, processPath: options.expectedProcessPath,
      electronUserDataPath: options.expectedElectronUserDataPath }
    const targets = await fetchLoopbackJson(options.port, '/json/list', fetchImpl)
    if (!Array.isArray(targets) || targets.length > 1024) throw new Error('INVALID_CDP_TARGET_LIST')
    const matches = targets.filter(target => target?.type === 'page' && /^ztools:\/\/web(?:\/|$)/.test(target.url ?? ''))
    const target = options.targetId ? matches.find(item => item.id === options.targetId) : matches.length === 1 ? matches[0] : null
    if (!target) {
      const code = matches.length > 1 && !options.targetId ? 'AMBIGUOUS_ZTOOLS_TARGET' : 'ZTOOLS_TARGET_MISSING'
      const availableTargets = summarizeCdpTargets(targets)
      result.preflight = { status: 'FAIL', code, availableTargets }
      result.cases = [{ caseId: existingIdentityCaseId, status: 'FAIL', code, availableTargets }]
      return result
    }
    if (typeof target.id !== 'string' || target.id.length < 1 || target.id.length > 128) throw new Error('INVALID_CDP_TARGET_ID')
    expected.targetId = target.id
    expected.targetUrl = target.url
    const browserInfo = await fetchLoopbackJson(options.port, '/json/version', fetchImpl)
    if (typeof browserInfo.webSocketDebuggerUrl !== 'string') throw new Error('INVALID_CDP_BROWSER_ENDPOINT')
    browser = await connect(browserInfo.webSocketDebuggerUrl, options.port)
    const browserProcesses = await browser.call('SystemInfo.getProcessInfo')
    const browserProcessInfo = browserProcesses?.processInfo?.find(item => item?.type === 'browser')
    if (!browserProcessInfo || !Number.isSafeInteger(browserProcessInfo.id) || browserProcessInfo.id <= 0) throw new Error('CDP_BROWSER_PROCESS_UNAVAILABLE')
    validateOwnedMacBrowserProcess(browserProcesses, browserProcessInfo.id)
    const actualProcessPath = processPath(browserProcessInfo.id, runnerPlatform)
    if (normalizeCdpPath(actualProcessPath, options.expectedPlatform) !== normalizeCdpPath(options.expectedProcessPath, options.expectedPlatform)) {
      result.preflight = { status: 'FAIL', code: 'PROCESS_PATH_MISMATCH' }
      result.cases = [{ caseId: existingIdentityCaseId, status: 'FAIL', code: 'PROCESS_PATH_MISMATCH' }]
      return result
    }
    page = await connect(target.webSocketDebuggerUrl, options.port)
    const expression = `(${collectExistingIdentityInPage.toString()})()`
    const evaluated = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (evaluated.exceptionDetails) throw new Error('CDP_IDENTITY_EVALUATION_FAILED')
    const snapshot = evaluated.result?.value
    if (snapshot && typeof snapshot === 'object') {
      snapshot.targetId = target.id
      snapshot.browserPid = browserProcessInfo.id
      snapshot.processPath = actualProcessPath
    }
    const mainIdentity = await inspectMain({ port: options.mainInspectPort, browserPid: browserProcessInfo.id,
      expected, fetchImpl, connect })
    result.mainInspector = { status: mainIdentity.status, ...(mainIdentity.code ? { code: mainIdentity.code } : {}),
      ...(mainIdentity.snapshot ? { snapshot: mainIdentity.snapshot } : {}) }
    if (mainIdentity.status !== 'PASS') {
      result.preflight = { status: 'FAIL', code: mainIdentity.code ?? 'MAIN_INSPECTOR_IDENTITY_MISMATCH',
        processPath: actualProcessPath, browserPid: browserProcessInfo.id,
        target: { id: target.id, url: target.url }, mode: options.action ? 'existing-instance-ui-navigation' : 'read-only-existing-instance' }
      result.cases = [{ caseId: existingIdentityCaseId, status: 'FAIL', scope: 'normal-app-cdp-identity-baseline',
        completeCase: false, code: mainIdentity.code ?? 'MAIN_INSPECTOR_IDENTITY_MISMATCH',
        ...(snapshot && typeof snapshot === 'object' ? { partialSnapshot: snapshot } : {}) }]
      return result
    }
    if (snapshot && typeof snapshot === 'object') snapshot.mainInspector = mainIdentity.snapshot
    const validation = validateExistingCdpIdentitySnapshot(snapshot, expected)
    result.preflight = { status: validation.status === 'BASELINE_PASS' ? 'PASS' : 'FAIL',
      ...(validation.code ? { code: validation.code } : {}), processPath: actualProcessPath, browserPid: browserProcessInfo.id,
      target: { id: target.id, url: target.url }, mode: options.action ? 'existing-instance-ui-navigation' : 'read-only-existing-instance' }
    result.cases = [{ caseId: existingIdentityCaseId, status: validation.status, scope: 'normal-app-cdp-identity-baseline',
      completeCase: false, ...(validation.snapshot ? { snapshot: validation.snapshot } : {}),
      ...(validation.code ? { code: validation.code, diagnostic: {
        isElectron: snapshot?.isElectron === true, url: snapshot?.url ?? null,
        runtimePlatform: snapshot?.identity?.target?.platform ?? null, runtimeArch: snapshot?.identity?.process?.arch ?? null,
        appVersion: snapshot?.appVersion ?? null, sdkContractVersion: snapshot?.sdkContractVersion ?? null,
        sdkSystemUserDataPathAbsolute: typeof snapshot?.sdkSystemUserDataPath === 'string' && (options.expectedPlatform === 'windows'
          ? path.win32.isAbsolute(snapshot.sdkSystemUserDataPath) : path.posix.isAbsolute(snapshot.sdkSystemUserDataPath))
      } } : {}) }]
    if (validation.status === 'BASELINE_PASS' && options.action === 'about-roundtrip') {
      try {
        const navigation = await performNavigation(page)
        result.cases.push(navigation)
        if (navigation.status === 'ACTION_PASS' && navigation.cleanup === 'ROUTE_RESTORED') {
          result.cases.push({ caseId: 'F22-P01', completeCase: false, ...await collectPlugins(page) })
        }
      }
      catch (error) {
        result.cases.push({ caseId: 'F22-N01', status: 'ACTION_FAIL', scope: 'real-ui-about-navigation-roundtrip',
          completeCase: false, action: 'about-roundtrip', code: /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'UI_NAVIGATION_FAILED',
          cleanup: 'ROUTE_RESTORE_UNCONFIRMED' })
      }
    }
    return result
  } catch (error) {
    const code = /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'EXISTING_CDP_IDENTITY_FAILED'
    result.preflight = { status: 'FAIL', code }
    result.cases = [{ caseId: existingIdentityCaseId, status: 'FAIL', code }]
    return result
  } finally {
    page?.dispose()
    browser?.dispose()
  }
}

function macMainPathSnapshotExpression() {
  return `(() => {
    const mainModule = process.mainModule;
    if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE');
    const requireMain = mainModule.require.bind(mainModule);
    const electron = requireMain('electron');
    const app = electron.app;
    const fs = requireMain('node:fs');
    return { pid: process.pid, execPath: process.execPath, processArch: process.arch,
      electronVersion: process.versions.electron ?? null, mainEntry: mainModule.filename,
      appPath: app.getAppPath(), appVersion: app.getVersion(), isPackaged: app.isPackaged,
      appDataPath: app.getPath('appData'), userDataPath: app.getPath('userData'),
      sessionDataPath: app.getPath('sessionData'), appDataRealPath: fs.realpathSync(app.getPath('appData')),
      userDataRealPath: fs.realpathSync(app.getPath('userData')),
      sessionDataRealPath: fs.realpathSync(app.getPath('sessionData')) };
  })()`
}

function macAppQuitExpression() {
  return `(() => {
    const app = process.mainModule?.require?.('electron')?.app;
    if (!app || typeof app.quit !== 'function') throw new Error('MAIN_APP_QUIT_UNAVAILABLE');
    app.quit();
    return true;
  })()`
}

export function validateMacIsolatedMainSnapshot(snapshot, { childPid, preflight, options, profile }) {
  const fail = code => ({ status: 'FAIL', code })
  const expectedAppPath = path.posix.join(preflight.appRoot, 'Contents', 'Resources', 'app.asar')
  const expectedEntry = path.posix.join(expectedAppPath, 'out', 'main', 'bootstrap.js')
  const executableRelative = path.posix.relative(preflight.appRoot, snapshot?.execPath ?? '')
  if (!snapshot || snapshot.pid !== childPid) return fail('MAIN_PID_MISMATCH')
  if (normalizeCdpPath(snapshot.execPath ?? '', 'macos') !== normalizeCdpPath(preflight.executable, 'macos') ||
      executableRelative === '..' || executableRelative.startsWith(`..${path.posix.sep}`) ||
      path.posix.isAbsolute(executableRelative)) return fail('MAIN_EXECUTABLE_MISMATCH')
  if (normalizeCdpPath(snapshot.mainEntry ?? '', 'macos') !== normalizeCdpPath(expectedEntry, 'macos') ||
      normalizeCdpPath(snapshot.appPath ?? '', 'macos') !== normalizeCdpPath(expectedAppPath, 'macos')) return fail('MAIN_APP_ARCHIVE_IDENTITY_MISMATCH')
  if (snapshot.appVersion !== preflight.appVersion || snapshot.electronVersion !== '43.4.1' ||
      snapshot.processArch !== options['expect-process-arch'] || snapshot.isPackaged !== true) return fail('MAIN_RUNTIME_IDENTITY_MISMATCH')
  for (const key of ['appDataPath', 'userDataPath', 'sessionDataPath']) {
    const realKey = `${key.replace(/Path$/, '')}RealPath`
    if (normalizeCdpPath(snapshot[key] ?? '', 'macos') !== normalizeCdpPath(profile[key], 'macos') ||
        normalizeCdpPath(snapshot[realKey] ?? '', 'macos') !== normalizeCdpPath(profile[key], 'macos')) {
      return fail('ISOLATED_PATH_READBACK_FAILED')
    }
  }
  return { status: 'PASS', bundleId: preflight.bundleId, appVersion: snapshot.appVersion,
    electronVersion: snapshot.electronVersion, processArch: snapshot.processArch,
    execPath: snapshot.execPath, appPath: snapshot.appPath, mainEntry: snapshot.mainEntry,
    appDataPath: snapshot.appDataPath, userDataPath: snapshot.userDataPath,
    sessionDataPath: snapshot.sessionDataPath }
}

async function waitForMainZtoolsPage(port, fetchImpl, child, hasExited = () => child.exitCode !== null || child.signalCode !== null) {
  const deadline = Date.now() + 30_000
  let target, browserUrl
  while (Date.now() < deadline) {
    if (hasExited()) throw new Error('OWNED_APP_EXITED_BEFORE_CONNECTION')
    try {
      const targetsResponse = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      const targets = await targetsResponse.json()
      if (targetsResponse.ok && Array.isArray(targets) && targets.length <= 1024) {
        const matches = targets.filter(item => item?.type === 'page' && /^ztools:\/\/web\//.test(item.url ?? ''))
        if (matches.length > 1) throw new Error('AMBIGUOUS_NORMAL_APP_TARGET')
        if (matches.length === 1) {
          target = matches[0]
          const versionResponse = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
          const version = await versionResponse.json()
          if (versionResponse.ok && typeof version?.webSocketDebuggerUrl === 'string') browserUrl = version.webSocketDebuggerUrl
          break
        }
      }
    } catch (error) {
      if (error?.message === 'AMBIGUOUS_NORMAL_APP_TARGET') throw error
    }
    await delay(250)
  }
  if (!target || !browserUrl) throw new Error('NORMAL_APP_TARGET_TIMEOUT')
  return { target, browserUrl }
}

export async function startMacNormalDatabaseChainSession(options, {
  platform = process.platform, preflight = undefined, allocatePort = freeLoopbackPort,
  spawnApp = spawn, connect = connectCdp, fetchImpl = fetch, isolationGate = runMainPrebootIsolationGate
} = {}) {
  if (platform !== 'darwin') throw new Error('DARWIN_REQUIRED')
  const appPreflight = preflight ?? inspectMacApp(options, { platform })
  if (appPreflight.status !== 'PASS') throw new Error(appPreflight.code ?? 'APP_PREFLIGHT_FAILED')
  let minimumOsMatches = false
  try { minimumOsMatches = compareOsVersions(appPreflight.minimumOs, options['minimum-os']) === 0 } catch { /* Invalid preflight metadata fails closed. */ }
  if (appPreflight.bundleId !== options['bundle-id'] || !minimumOsMatches ||
      appPreflight.expectedProcessArch !== options['expect-process-arch'] ||
      !Array.isArray(appPreflight.slices) || !appPreflight.slices.includes('arm64') || !appPreflight.slices.includes('x86_64') ||
      typeof appPreflight.appRoot !== 'string' || !path.posix.isAbsolute(appPreflight.appRoot) ||
      typeof appPreflight.executable !== 'string' || !path.posix.isAbsolute(appPreflight.executable)) {
    throw new Error('APP_PREFLIGHT_IDENTITY_MISMATCH')
  }
  const reservedPorts = new Set([9336, 9337])
  const cdpPort = await allocatePort(reservedPorts)
  if (!Number.isSafeInteger(cdpPort) || cdpPort < 1024 || cdpPort > 65_535 || reservedPorts.has(cdpPort)) {
    throw new Error('INVALID_CDP_PORT')
  }
  const inspectPort = await allocatePort(new Set([...reservedPorts, cdpPort]))
  if (!Number.isSafeInteger(inspectPort) || inspectPort < 1024 || inspectPort > 65_535 ||
      reservedPorts.has(inspectPort) || inspectPort === cdpPort) throw new Error('INSPECTOR_PORT_COLLISION')
  const command = macAppLaunchCommand(appPreflight.executable, options['expect-process-arch'], cdpPort)
  command.args.push(`--inspect-brk=127.0.0.1:${inspectPort}`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawnApp(command.executable, command.args,
    { cwd: appPreflight.appRoot, shell: false, stdio: 'ignore', env })
  let exited = false
  let launchError = null
  child.once('error', error => { launchError = error; exited = true })
  child.once('exit', () => { exited = true })
  const session = { child, preflight: appPreflight, options, profile: options.profile,
    cdpPort, inspectPort, launchArguments: command.args, inspector: undefined, browser: undefined,
    mainPage: undefined, browserVerified: false, isolation: undefined, stopped: false, exited: () => exited }
  try {
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('OWNED_APP_PID_UNAVAILABLE')
    const expectedAppPath = path.join(appPreflight.appRoot, 'Contents', 'Resources', 'app.asar')
    const entryPath = path.join(expectedAppPath, 'out', 'main', 'bootstrap.js')
    const isolation = await isolationGate({ childPid: child.pid, inspectPort, executablePath: appPreflight.executable,
      appRoot: appPreflight.appRoot, appArchivePath: expectedAppPath, entryPath,
      bundleId: appPreflight.bundleId, appName: 'ZTools', appVersion: appPreflight.appVersion, electronVersion: '43.4.1',
      processArch: options['expect-process-arch'], isPackaged: true, outputRoot: options.output,
      profile: options.profile, timeoutMs: 20_000 }, { platform, fetchImpl, connect })
    session.isolation = isolation
    session.inspector = isolation.client
    const main = await session.inspector.evaluate(macMainPathSnapshotExpression())
    const mainValidation = validateMacIsolatedMainSnapshot(main, { childPid: child.pid, preflight: appPreflight,
      options, profile: options.profile })
    if (mainValidation.status !== 'PASS') throw new Error(mainValidation.code)
    const { target, browserUrl } = await waitForMainZtoolsPage(cdpPort, fetchImpl, child, () => exited || Boolean(launchError))
    session.browser = await connect(browserUrl, cdpPort)
    validateOwnedMacBrowserProcess(await session.browser.call('SystemInfo.getProcessInfo'), child.pid)
    if (exited || launchError) throw new Error('OWNED_APP_EXITED_BEFORE_CONNECTION')
    session.browserVerified = true
    const page = await connect(target.webSocketDebuggerUrl, cdpPort)
    session.mainPage = { page, target }
    const evaluated = await page.call('Runtime.evaluate', { expression: snapshotExpression, awaitPromise: true, returnByValue: true })
    if (evaluated.exceptionDetails) throw new Error('SDK_SNAPSHOT_FAILED')
    const runtime = validateMacSnapshot(evaluated.result?.value, options['expect-process-arch'], appPreflight.appVersion)
    if (runtime.status !== 'PASS') throw new Error(runtime.code)
    session.mainValidation = mainValidation
    session.runtime = runtime
    return session
  } catch (error) {
    if (error?.prebootIsolationClient) session.inspector = error.prebootIsolationClient
    const cleanup = await stopMacNormalDatabaseChainSession(session, { requestQuit: session.isolation?.resumed === true })
    if (error && typeof error === 'object') error.cleanup = cleanup
    throw error
  }
}

export async function stopMacNormalDatabaseChainSession(session, { requestQuit = true } = {}) {
  if (!session) return { cleanup: 'NO_PROCESS_CREATED', quitRequested: false }
  if (session.stopPromise) return await session.stopPromise
  session.stopPromise = (async () => {
    let quitRequested = false
    let quitRequestError = null
    const hasExited = () => session.exited?.() === true || session.child?.exitCode !== null || session.child?.signalCode !== null
    if (requestQuit && session.isolation?.resumed === true && session.inspector && !hasExited()) {
      try { quitRequested = await session.inspector.evaluate(macAppQuitExpression(), { timeoutMs: 3000 }) === true }
      catch (error) { quitRequestError = /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'APP_QUIT_REQUEST_FAILED' }
    }
    const cleanup = await cleanupOwnedMacApp({ child: session.child, hasExited,
      closeBrowser: async () => {
        if (session.browser && session.browserVerified && !hasExited()) {
          validateOwnedMacBrowserProcess(await session.browser.call('SystemInfo.getProcessInfo'), session.child.pid)
          if (!hasExited()) await session.browser.call('Browser.close')
        }
      } })
    session.mainPage?.page.dispose()
    session.browser?.dispose()
    session.inspector?.dispose()
    session.stopped = true
    session.stopResult = { ...cleanup, quitRequested, quitRequestError,
      normalQuitConfirmed: quitRequested && cleanup.cleanup === 'OWNED_PROCESS_EXITED',
      ownedPid: session.child?.pid ?? null, cdpPort: session.cdpPort, inspectorPort: session.inspectPort,
      descendantAcceptance: 'NOT_VERIFIED' }
    return session.stopResult
  })()
  return await session.stopPromise
}

export async function runMacAppIntegration(options) {
  if (options.case === 'M02') return runMacLifecycleBaseline(options, runMacAppIntegration)
  const preflight = inspectMacApp(options)
  if (preflight.status !== 'PASS') return { preflight, cases: [], cleanup: 'NO_PROCESS_CREATED' }
  const port = await freeLoopbackPort()
  const command = macAppLaunchCommand(preflight.executable, options['expect-process-arch'], port)
  const child = spawn(command.executable, command.args,
    { cwd: preflight.appRoot, shell: false, stdio: 'ignore', env: process.env })
  let exited = false, launchError = false, page, browser, loopback, browserVerified = false
  child.once('error', () => { launchError = true; exited = true })
  child.once('exit', () => { exited = true })
  const result = { preflight, ownedPid: child.pid ?? null, cases: [], cleanup: 'PENDING' }
  try {
    const deadline = Date.now() + 30_000
    let target, browserUrl
    while (Date.now() < deadline) {
      if (exited || launchError) throw new Error('OWNED_APP_EXITED_BEFORE_CONNECTION')
      try {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then(r => r.json())
        target = targets.find(t => t.type === 'page' && /^ztools:\/\/web\//.test(t.url))
        if (target) {
          browserUrl = (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.json())).webSocketDebuggerUrl
          break
        }
      } catch { /* App may not yet expose CDP; deadline remains bounded. */ }
      await delay(250)
    }
    if (!target || !browserUrl) throw new Error('NORMAL_APP_TARGET_TIMEOUT')
    browser = await connectCdp(browserUrl, port)
    validateOwnedMacBrowserProcess(await browser.call('SystemInfo.getProcessInfo'), child.pid)
    if (exited) throw new Error('OWNED_APP_EXITED_BEFORE_CONNECTION')
    browserVerified = true
    page = await connectCdp(target.webSocketDebuggerUrl, port)
    const evaluated = await page.call('Runtime.evaluate', { expression: snapshotExpression, awaitPromise: true, returnByValue: true })
    if (evaluated.exceptionDetails) throw new Error('SDK_SNAPSHOT_FAILED')
    const snapshot = validateMacSnapshot(evaluated.result?.value, options['expect-process-arch'], preflight.appVersion)
    if (snapshot.status === 'PASS' && options.case === 'M13') {
      result.cases = [{ caseId: 'M13', ...await runMacPluginBaseline(page, { pluginId: options.plugin, expectedArch: options['expect-process-arch'], appVersion: preflight.appVersion }, {
        targets: () => fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then(response => response.json()),
        connect: url => connectCdp(url, port)
      }) }]
    } else if (snapshot.status === 'PASS' && ['M05', 'M06', 'M08'].includes(options.case)) {
      if (options.case === 'M08') loopback = await startLoopbackFixtures()
      const collector = ({ M05: collectMacCapabilityBaseline, M06: collectMacDisplayBaseline, M08: collectMacOwnedProcessBaseline })[options.case]
      const collected = await page.call('Runtime.evaluate', {
        expression: `(${collector.toString()})(window.ztools, ${process.pid})`, awaitPromise: true, returnByValue: true
      })
      if (collected.exceptionDetails) throw new Error('READONLY_CASE_COLLECTION_FAILED')
      const validation = options.case === 'M05'
        ? validateCapabilityBaseline(collected.result?.value, options['expect-process-arch'])
        : options.case === 'M06' ? validateDisplayBaseline(collected.result?.value)
        : validateOwnedProcessBaseline(collected.result?.value, process.pid)
      result.cases = [{ caseId: options.case, ...validation, ...(loopback ? { fixtureEndpoints: loopback.endpoints, fixtureUnavailable: loopback.unavailable } : {}) }]
    } else {
      result.cases = (options.case ? [options.case] : MAC_AUTOMATIC_CASES).map(caseId => ({ caseId, ...snapshot,
        scope: caseId === 'M01' ? 'runtime-identity' : 'readonly-sdk-contract-subset' }))
    }
  } catch (error) {
    result.cases = (options.case ? [options.case] : MAC_AUTOMATIC_CASES).map(caseId => ({ caseId, status: 'FAIL',
      code: /^[A-Z_]+$/.test(error.message) ? error.message : 'APP_INTEGRATION_FAILED' }))
  } finally {
    Object.assign(result, await cleanupOwnedMacApp({ child, hasExited: () => exited,
      closeBrowser: async () => {
        if (browser && browserVerified && !exited) {
          validateOwnedMacBrowserProcess(await browser.call('SystemInfo.getProcessInfo'), child.pid)
          if (!exited) await browser.call('Browser.close')
        }
      } }))
    page?.dispose(); browser?.dispose()
    if (loopback) {
      try { result.fixtureCleanup = await loopback.stop() }
      catch { result.fixtureCleanup = { status: 'FAIL', code: 'LOOPBACK_CLEANUP_FAILED' }; result.cleanup = 'OWNED_RESOURCE_CLEANUP_FAILED' }
    }
  }
  if (result.cleanup !== 'OWNED_PROCESS_EXITED') {
    result.cases = result.cases.map(item => ({ ...item, status: 'FAIL', code: 'OWNED_APP_CLEANUP_UNCONFIRMED' }))
  }
  return result
}

export function parseMacIntegrationArguments(argv) {
  const remaining = [], selected = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index], name = argument.split('=')[0]
    if (name === '--case' || name === '--plugin') {
      const key = name.slice(2)
      if (selected[key] !== undefined) throw new Error('DUPLICATE_CASE_OR_PLUGIN')
      const value = argument.includes('=') ? argument.slice(name.length + 1) : argv[++index]
      if (!value || value.startsWith('--')) throw new Error('MISSING_CASE_OR_PLUGIN')
      selected[key] = value
    } else remaining.push(argument)
  }
  if (selected.case && !MAC_COLLECTION_CASES.includes(selected.case)) throw new Error('CASE_NOT_IMPLEMENTED')
  if (selected.case === 'M13' && !MAC_PLUGIN_BASELINE_IDS.includes(selected.plugin)) throw new Error('PLUGIN_BASELINE_NOT_PREPARED')
  if (selected.plugin && selected.case !== 'M13') throw new Error('PLUGIN_REQUIRES_M13')
  return { ...parseMacTestArguments(remaining), ...selected }
}

export async function main(argv = process.argv.slice(2), {
  runApp = runMacAppIntegration, runExisting = runExistingCdpIdentity, stdout = console.log
} = {}) {
  if (argv.length === 1 && argv[0] === '--list') {
    console.log(JSON.stringify(MAC_COLLECTION_CASES.map(caseId => ({ caseId, automatedScope: ({ M01: 'runtime-identity', M02: 'normal-start-quit-restart-readonly-baseline', M03: 'readonly-sdk-contract-subset', M05: 'readonly-capability-revision-baseline', M06: 'readonly-display-coordinate-baseline', M08: 'readonly-owned-process-baseline', M13: 'installed-plugin-renderer-baseline' })[caseId], manualPending: ['M02', 'M05', 'M06', 'M08', 'M13'].includes(caseId), ...(caseId === 'M13' ? { plugins: MAC_PLUGIN_BASELINE_IDS } : {}) }))))
    return 0
  }
  const attachExisting = argv.includes('--attach-existing') || argv.some(argument => argument.startsWith('--attach-existing='))
  let options
  try {
    options = attachExisting ? parseExistingCdpIdentityArguments(argv) : parseMacIntegrationArguments(argv)
  } catch (error) { console.error(error.message); return 1 }
  if (options.help) {
    console.log(attachExisting
      ? 'npm run test:mac:integration -- --attach-existing --existing-cdp-port <1024..65535> --main-inspect-port <explicit Node inspector port> --expected-platform <windows|macos> --expect-process-arch <ia32|x64|arm64> --expected-process-path <absolute executable> --output <absolute directory> [--expected-user-data <actual app.getPath(userData)>] [--target-id <CDP target ID>] [--action about-roundtrip]'
      : 'npm run test:mac:integration -- [--list] | --app <absolute.app> --bundle-id <approved ID> --minimum-os <approved version> --expect-process-arch <x64|arm64> --output <absolute directory> [--case M01|M02|M03|M05|M06|M08|M13] [--plugin <prepared plugin ID; requires M13>]')
    return 0
  }
  const startedAt = new Date().toISOString()
  let result
  try { result = attachExisting ? await runExisting(options) : await runApp(options) }
  catch {
    result = { preflight: { status: 'FAIL', code: 'APP_INTEGRATION_START_FAILED' },
      cases: [{ caseId: attachExisting ? existingIdentityCaseId : options.case ?? 'M01', status: 'FAIL', code: 'APP_INTEGRATION_START_FAILED' }],
      cleanup: attachExisting ? 'EXISTING_PROCESS_LEFT_RUNNING' : 'STARTUP_EXCEPTION_REQUIRES_REVIEW' }
  }
  const report = { schemaVersion: 1, runId: randomUUID(), phase: 2,
    scope: attachExisting ? options.action ? 'normal-app-cdp-navigation-subset' : 'normal-app-cdp-identity-baseline' : 'normal-app-sdk-subset', completeCase: false,
    startedAt, finishedAt: new Date().toISOString(), runner: { platform: process.platform, arch: process.arch, node: process.version }, ...result }
  try {
    fs.mkdirSync(options.output, { recursive: true })
    const reportPath = path.join(options.output, `${report.runId}.json`)
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
    const passed = result.preflight.status === 'PASS' && result.cases.length > 0 &&
      result.cases.every(c => c.status === 'PASS') && result.cleanup === 'OWNED_PROCESS_EXITED'
    const baselinePassed = attachExisting && result.preflight.status === 'PASS' && result.cases.length >= 1 &&
      result.cases[0].status === 'BASELINE_PASS' && result.cases.slice(1).every(c => ['ACTION_PASS', 'READONLY_PASS'].includes(c.status)) &&
      result.cleanup === 'EXISTING_PROCESS_LEFT_RUNNING'
    const status = baselinePassed ? 'BASELINE_PASS' : passed ? 'PASS' : result.preflight.status === 'NOT_RUN' ? 'NOT_RUN'
      : result.cleanup === 'OWNED_PROCESS_EXITED' && result.cases.length > 0 && result.cases.every(c => c.status === 'MANUAL_PENDING') ? 'MANUAL_PENDING' : 'FAIL'
    stdout(JSON.stringify({ status, reportPath }))
    return baselinePassed || passed ? 0 : 1
  } catch { console.error('报告写入失败'); return 1 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main()
