import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import {
  CdpClient, WindowsNormalAppHarness, enableRendererAfterCommit,
  startLoopbackZipServer, closeLoopbackZipServer
} from './lib/windows-normal-app-harness.mjs'
import { digest, validateFreshPluginZip } from './windows-normal-app-plugin-file-chain-lib.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginRoot = path.resolve(root, '../plugins/create-plugin')
const promptUrl = 'ztools://web/platform/runtime-permission-consent.html'
const fixtureKey = 'ztools.f07.owned-capture-fixture'
const ports = { cdp: 9342, inspect: 9343 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const { PNG } = createRequire(import.meta.url)('pngjs')

async function until(read, accept, code, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await sleep(100)
  }
  throw new Error(code)
}

async function targets() {
  const response = await fetch(`http://127.0.0.1:${ports.cdp}/json/list`, { signal: AbortSignal.timeout(3000) })
  if (!response.ok) throw new Error('CDP_TARGET_LIST_FAILED')
  const list = await response.json()
  if (!Array.isArray(list)) throw new Error('CDP_TARGET_LIST_INVALID')
  return list.filter(item => item.type === 'page' && item.url === promptUrl)
}

async function click(page, expression) {
  const bounds = await page.evaluate(`(() => {
    const element = ${expression};
    if (!element || element.disabled) throw new Error('CLICK_TARGET_UNAVAILABLE');
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error('CLICK_TARGET_NOT_VISIBLE');
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`)
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...bounds, button: 'left', clickCount: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...bounds, button: 'left', clickCount: 1 })
}

async function answerPrompt(allow, evidence) {
  const list = await until(targets, items => items.length === 1, 'CONSENT_PROMPT_NOT_UNIQUE')
  const target = list[0]
  const page = await CdpClient.connect(target.webSocketDebuggerUrl, ports.cdp, '/devtools/page/')
  try {
    const commit = await enableRendererAfterCommit(page, /^ztools:\/\/web\/platform\/runtime-permission-consent\.html$/)
    const identity = await until(() => page.evaluate(`(() => ({
      ready: !!document.querySelector('[data-testid="runtime-capability-allow"]'),
      url: location.href, node: typeof process, require: typeof require,
      pluginId: document.querySelector('[data-testid="runtime-capability-plugin-id"]')?.textContent,
      pluginName: document.querySelector('[data-testid="runtime-capability-plugin-name"]')?.textContent
    }))()`), value => value.ready && value.pluginId?.trim(), 'CONSENT_PROMPT_NOT_READY')
    assert.equal(identity.node, 'undefined')
    assert.equal(identity.require, 'undefined')
    assert.equal(identity.url, promptUrl)
    assert.equal(identity.pluginId.trim(), 'batch-text-convert')
    evidence.push({ targetId: target.id, commit, identity, answer: allow ? 'allow' : 'deny', interaction: 'CDP Input.dispatchMouseEvent' })
    await click(page, `document.querySelector('[data-testid="runtime-capability-${allow ? 'allow' : 'deny'}"]')`)
  } finally { page.dispose() }
  await until(targets, items => items.length === 0, 'CONSENT_PROMPT_NOT_CLOSED')
}

async function closePrompt(evidence) {
  const list = await until(targets, items => items.length === 1, 'CLOSE_PROMPT_NOT_UNIQUE')
  const target = list[0]
  const page = await CdpClient.connect(target.webSocketDebuggerUrl, ports.cdp, '/devtools/page/')
  try {
    const commit = await enableRendererAfterCommit(page, /^ztools:\/\/web\/platform\/runtime-permission-consent\.html$/)
    evidence.push({ targetId: target.id, commit, answer: 'close', interaction: 'CDP Page.close' })
    await page.call('Page.close')
  } finally { page.dispose() }
  await until(targets, items => items.length === 0, 'CLOSE_PROMPT_LEFT_WINDOW')
}

async function startRequests(page, count = 1) {
  await page.evaluate(`(() => {
    globalThis.__f07RequestResults = null;
    Promise.allSettled(Array.from({length:${count}}, () => window.ztools.sys.requestCapability({capability:'screen.capture'})))
      .then(results => { globalThis.__f07RequestResults = results.map(item => item.status === 'fulfilled'
        ? { status:item.status, record:item.value } : { status:item.status, code:item.reason?.code ?? null }); });
    return true;
  })()`)
}

async function startCancellableRequests(page, count = 1) {
  await page.evaluate(`(() => {
    globalThis.__f07RequestResults = null;
    globalThis.__f07RequestController = new AbortController();
    const requests = [window.ztools.sys.requestCapability({capability:'screen.capture'}, {signal:globalThis.__f07RequestController.signal})];
    for(let index=1;index<${count};index++) requests.push(window.ztools.sys.requestCapability({capability:'screen.capture'}));
    Promise.allSettled(requests).then(results => { globalThis.__f07RequestResults = results.map(item => item.status === 'fulfilled'
      ? {status:item.status,record:item.value} : {status:item.status,code:item.reason?.code ?? null}); });
    return true;
  })()`)
}

async function cancellationCases(page, report) {
  const alreadyAborted = await page.evaluate(`(async () => {
    const controller = new AbortController(); controller.abort();
    try { await window.ztools.sys.requestCapability({capability:'screen.capture'}, {signal:controller.signal}); return {unexpectedSuccess:true}; }
    catch(error) { return {code:error?.code ?? null}; }
  })()`)
  assert.equal(alreadyAborted.code, 'CALLER_DESTROYED')
  assert.equal((await targets()).length, 0)
  report.checks.alreadyAbortedRequest = alreadyAborted
  await startCancellableRequests(page)
  await until(targets, items => items.length === 1, 'CANCEL_REQUEST_PROMPT_MISSING')
  await page.evaluate('globalThis.__f07RequestController.abort(); true')
  await until(targets, items => items.length === 0, 'CANCEL_REQUEST_LEFT_PROMPT')
  const cancelled = await until(() => page.evaluate('globalThis.__f07RequestResults'), Array.isArray, 'CANCEL_REQUEST_RESULT_MISSING')
  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0].status, 'rejected')
  assert.equal(cancelled[0].code, 'CALLER_DESTROYED')
  report.checks.lastWaiterCancellation = cancelled
  await snapshot(page, 'denied')
  await startCancellableRequests(page, 2)
  await until(targets, items => items.length === 1, 'MERGED_CANCEL_PROMPT_MISSING')
  await page.evaluate('globalThis.__f07RequestController.abort(); true')
  await sleep(300)
  assert.equal((await targets()).length, 1, 'One cancelled waiter must not close the remaining waiter prompt')
  await answerPrompt(false, report.prompts)
  const merged = await until(() => page.evaluate('globalThis.__f07RequestResults'), Array.isArray, 'MERGED_CANCEL_RESULTS_MISSING')
  assert.equal(merged.length, 2)
  assert.equal(merged[0].status, 'rejected')
  assert.equal(merged[0].code, 'CALLER_DESTROYED')
  assert.equal(merged[1].status, 'fulfilled')
  assert.equal(merged[1].record.authorization, 'denied')
  report.checks.oneOfTwoWaitersCancellation = merged
}

async function results(page, expected, count = 1) {
  const value = await until(() => page.evaluate('globalThis.__f07RequestResults'), Array.isArray, 'CONSENT_RESULTS_MISSING')
  assert.equal(value.length, count)
  for (const item of value) {
    assert.equal(item.status, 'fulfilled')
    assert.equal(item.record.capability, 'screen.capture')
    assert.equal(item.record.authorization, expected)
  }
  return value
}

async function snapshot(page, authorization) {
  const record = await page.evaluate("window.ztools.sys.getCapability('screen.capture')")
  assert.equal(record.capability, 'screen.capture')
  assert.equal(record.authorization, authorization)
  assert.equal(record.osPermission, 'not-required')
  assert.equal((await targets()).length, 0, 'Read-only query must not open a consent prompt')
  return record
}

async function deniedCapture(page) {
  const result = await page.evaluate(`(async () => {
    try { await window.ztools.screen.capture({x:0,y:0,width:1,height:1}); return {unexpectedSuccess:true}; }
    catch(error) { return {code:error?.code ?? null}; }
  })()`)
  assert.equal(result.code, 'PERMISSION_DENIED')
  await sleep(300)
  assert.equal((await targets()).length, 0, 'Denied capture must not repeatedly prompt')
  return result
}

async function mainGrants(session) {
  const value = await session.browserPage.page.evaluate('window.ztools.sys.listCapabilityGrants()')
  assert.equal(value.success, true)
  assert.ok(Array.isArray(value.grants))
  return value.grants
}

async function verifyOwnerEnter(session, plugin) {
  await plugin.page.evaluate(`(() => {
    if (typeof window.ztoolsPlugin?.onPluginEnter !== 'function') throw new Error('LIFECYCLE_SDK_UNAVAILABLE');
    globalThis.__f03ObservedEnter = [];
    globalThis.__f03StopEnter = window.ztoolsPlugin.onPluginEnter(meta => {
      globalThis.__f03ObservedEnter.push({pluginId:meta.pluginId,instanceId:meta.instanceId,status:meta.windowInstanceStatus});
    });
    return true;
  })()`)
  try {
    const opened = await session.browserPage.page.evaluate("window.ztools.plugin.open('batch-text-convert')")
    const events = await until(() => plugin.page.evaluate('globalThis.__f03ObservedEnter'),
      rows => Array.isArray(rows) && rows.some(row => row.status === 'reused'), 'OWNER_ENTER_EVENT_NOT_RECEIVED')
    assert.equal(events.length, 1)
    assert.equal(events[0].pluginId, 'batch-text-convert')
    assert.equal(typeof events[0].instanceId, 'string')
    assert.ok(events[0].instanceId.length > 0)
    await sleep(600)
    assert.equal(await plugin.page.evaluate('globalThis.__f03ObservedEnter.length'), 1, 'Delivered enter must not keep retrying')
    return {status:'PASS',opened,events,targetId:plugin.target.id,transport:'real owner-scoped plugin_enter via public lifecycle SDK'}
  } finally {
    await plugin.page.evaluate('globalThis.__f03StopEnter?.(); delete globalThis.__f03StopEnter; true')
  }
}

function mainFixtureExpression(remove = false) {
  if (remove) return `(() => {
    const key = Symbol.for(${JSON.stringify(fixtureKey)}), fixture = globalThis[key];
    if (!fixture) return {present:false,closed:true};
    if (!fixture.window.isDestroyed()) fixture.window.close();
    const closed = fixture.window.isDestroyed();
    if (closed) delete globalThis[key];
    return {present:true,closed};
  })()`
  return `(async () => {
    const electron = process.mainModule.require('electron'), key = Symbol.for(${JSON.stringify(fixtureKey)});
    if (globalThis[key]) throw new Error('F07_CAPTURE_FIXTURE_ALREADY_PRESENT');
    const area = electron.screen.getPrimaryDisplay().workArea;
    const window = new electron.BrowserWindow({width:80,height:80,x:area.x+24,y:area.y+24,
      frame:false,show:false,alwaysOnTop:true,focusable:false,resizable:false,minimizable:false,maximizable:false,
      webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,
        partition:'f07-owned-fixture-'+Date.now()}});
    globalThis[key] = {window};
    await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; style-src &apos;unsafe-inline&apos;"><title>F07 TEST ONLY owned capture</title><body style="margin:0;background:rgb(20,200,60);width:100vw;height:100vh"></body>'));
    window.showInactive();
    const bounds = window.getContentBounds();
    return {bounds,rect:{x:bounds.x+20,y:bounds.y+20,width:1,height:1},color:[20,200,60],
      url:window.webContents.getURL(),webContentsId:window.webContents.id};
  })()`
}

async function captureOwnedPixel(session, page) {
  const fixture = await session.inspector.evaluate(mainFixtureExpression(), { timeoutMs: 10_000 })
  try {
    await sleep(300)
    const result = await page.evaluate(`window.ztools.screen.capture(${JSON.stringify(fixture.rect)})`, { timeoutMs: 20_000 })
    assert.equal(typeof result, 'string')
    assert.match(result, /^data:image\/png;base64,/)
    const bytes = Buffer.from(result.slice('data:image/png;base64,'.length), 'base64')
    const decoded = PNG.sync.read(bytes)
    assert.equal(decoded.width, 1)
    assert.equal(decoded.height, 1)
    assert.deepEqual([...decoded.data.subarray(0, 3)], fixture.color)
    return {status:'PASS',source:'owned Main-side static synthetic window',rect:fixture.rect,
      fixtureWebContentsId:fixture.webContentsId,width:decoded.width,height:decoded.height,
      color:[...decoded.data.subarray(0,3)],pngSha256:digest(bytes),pngBytes:bytes.length,
      api:'window.ztools.screen.capture',clipboardRead:'synthetic-empty harness guard',wholeDesktopStored:false}
  } finally {
    const closed = await session.inspector.evaluate(mainFixtureExpression(true))
    assert.equal(closed.closed, true)
  }
}

async function run() {
  const { values } = parseArgs({ options: { zip: { type: 'string' }, help: { type: 'boolean' } }, strict: true })
  if (values.help) {
    console.log('node scripts/test-windows-normal-app-runtime-permission.mjs --zip <absolute SDK1 batch-text-convert ZIP from .build-runs>')
    return
  }
  if (process.platform !== 'win32') {
    console.log(JSON.stringify({ status: 'NOT_RUN', reason: 'WINDOWS_NORMAL_APP_REQUIRED', macAcceptance: 'NOT_RUN' }))
    return
  }
  if (!values.zip) throw new Error('SDK1_PLUGIN_ZIP_REQUIRED')
  const zipInfo = validateFreshPluginZip(values.zip, pluginRoot)
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const electronPackage = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/electron/package.json'), 'utf8'))
  const protocol = fs.readFileSync(path.join(root, 'src/contracts/protocol-versions.ts'), 'utf8')
  assert.match(protocol, /SDK_CONTRACT\s*=\s*1\b/)
  const appName = typeof packageInfo.productName === 'string' ? packageInfo.productName : packageInfo.name
  assert.match(appName, /^[0-9A-Za-z ._-]{1,128}$/)
  const versions = { appName, appVersion: packageInfo.version, electronVersion: electronPackage.version, sdkContractVersion: 1 }
  const runId = randomUUID()
  const output = path.join(root, 'out-test/normal-app-runtime-permission', runId)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.mkdirSync(output)
  const reportPath = path.join(output, 'report.json')
  const report = { runId, status: 'RUNNING', productionZToolsAcceptance: false, macAcceptance: 'NOT_RUN',
    scope: 'Windows normal Electron/CDP application consent, instance ownership and one-pixel SDK1 capture of a controlled synthetic window; DLL/SDK2/OS permission tests excluded',
    successfulScreenCapture: 'NOT_RUN', nativeTccInteraction: 'NOT_RUN', sdkMaximum: 1,
    fixtureZip: zipInfo, phases: {}, prompts: [], checks: {}, sourceFingerprints: {} }
  for (const relative of ['scripts/test-windows-normal-app-runtime-permission.mjs', 'scripts/lib/windows-normal-app-harness.mjs',
    'out/main/ipc/router.js', 'out/preload/main.js', 'out/assets/web/sdk/ztools-api.js']) {
    report.sourceFingerprints[relative] = digest(fs.readFileSync(path.join(root, relative)))
  }
  const harness = new WindowsNormalAppHarness({ appRoot: root, executable: path.join(root, 'node_modules/electron/dist/electron.exe'), outputRoot: output, versions, ports })
  const profile = harness.createProfile(path.join(output, 'profile'))
  let server, session
  try {
    server = await startLoopbackZipServer(zipInfo, 'permission-fixture.zip', runId)
    session = await harness.start({ profile, phase: 'consent-start', report })
    report.checks.install = await harness.install(session, { pluginId: 'batch-text-convert', zipInfo,
      zipUrl: server.url, version: '1.0.0', pluginRoot })
    let plugin = await harness.open(session, 'batch-text-convert')
    report.checks.ownerEnterLifecycle = await verifyOwnerEnter(session, plugin)
    report.checks.initial = await snapshot(plugin.page, 'not-requested')
    await startRequests(plugin.page, 2)
    await answerPrompt(false, report.prompts)
    report.checks.concurrentDenied = await results(plugin.page, 'denied', 2)
    report.checks.deniedCapture = await deniedCapture(plugin.page)
    const unsupported = await plugin.page.evaluate(`(async () => {
      try { return {unexpectedSuccess:await window.ztools.sys.requestCapability({capability:'system.hibernate'})}; }
      catch(error) { return {code:error?.code ?? null}; }
    })()`)
    assert.equal(unsupported.code, 'NOT_SUPPORTED')
    assert.equal((await targets()).length, 0)
    report.checks.unsupportedRequest = unsupported
    await cancellationCases(plugin.page, report)
    await startRequests(plugin.page)
    await closePrompt(report.prompts)
    report.checks.promptCloseDenial = await results(plugin.page, 'denied')
    await startRequests(plugin.page)
    await answerPrompt(true, report.prompts)
    report.checks.allowed = await results(plugin.page, 'granted')
    report.checks.ownedWindowCapture = await captureOwnedPixel(session, plugin.page)
    report.successfulScreenCapture = 'PASS_SDK1_OWNED_SYNTHETIC_PIXEL_ONLY'
    const grants = await mainGrants(session)
    assert.equal(grants.length, 1)
    assert.equal(grants[0].pluginId, 'batch-text-convert')
    assert.equal(grants[0].capability, 'screen.capture')
    assert.equal(typeof grants[0].grantId, 'string')
    report.checks.mainGrants = grants
    const pluginManagement = await plugin.page.evaluate(`(async () => {
      try { return {unexpectedSuccess:await window.ztools.sys.listCapabilityGrants()}; }
      catch(error) { return {code:error?.code ?? null}; }
    })()`)
    assert.equal(pluginManagement.code, 'PERMISSION_DENIED')
    report.checks.pluginManagementDenied = pluginManagement
    const ownRevocation = await plugin.page.evaluate("window.ztools.sys.revokeCapability({capability:'screen.capture'})")
    assert.equal(ownRevocation.success, true)
    report.checks.selfRevocation = await snapshot(plugin.page, 'denied')
    assert.equal((await mainGrants(session)).length, 0)
    await startRequests(plugin.page)
    await answerPrompt(true, report.prompts)
    await results(plugin.page, 'granted')
    await click(session.browserPage.page, "Array.from(document.querySelectorAll('.sidebar-item')).find(item => item.textContent.trim() === '高级设置')")
    await until(() => session.browserPage.page.evaluate("document.querySelectorAll('[data-testid=\"screen-permission-grant-revoke\"]').length"), count => count === 1, 'MAIN_GRANT_UI_NOT_READY')
    await click(session.browserPage.page, "document.querySelector('[data-testid=\"screen-permission-grant-revoke\"]')")
    await until(() => mainGrants(session), items => items.length === 0, 'MAIN_GRANT_UI_REVOKE_FAILED')
    report.checks.mainUiRevocation = await snapshot(plugin.page, 'denied')
    report.checks.revokedCapture = await deniedCapture(plugin.page)
    await startRequests(plugin.page)
    await until(targets, items => items.length === 1, 'OWNER_CLOSE_PENDING_PROMPT_MISSING')
    report.checks.closeWithPendingRequest = await harness.close(session, 'batch-text-convert')
    await until(targets, items => items.length === 0, 'OWNER_CLOSE_LEFT_PROMPT')
    assert.equal((await mainGrants(session)).length, 0)
    plugin = await harness.open(session, 'batch-text-convert')
    report.checks.reopenedIdentity = plugin.identity
    report.checks.reopenedAuthorization = await snapshot(plugin.page, 'not-requested')
    await startRequests(plugin.page)
    await answerPrompt(true, report.prompts)
    await results(plugin.page, 'granted')
    report.checks.firstExit = await harness.stop(session)
    assert.equal(report.checks.firstExit.cleanupConfirmed, true)
    assert.equal(report.checks.firstExit.exit.code, 0)
    session = undefined
    session = await harness.start({ profile, phase: 'consent-restart', report })
    plugin = await harness.open(session, 'batch-text-convert')
    report.checks.restartAuthorization = await snapshot(plugin.page, 'not-requested')
    assert.equal((await mainGrants(session)).length, 0)
    report.checks.finalClose = await harness.close(session, 'batch-text-convert')
    report.status = 'PASS'
  } catch (error) {
    report.status = 'FAIL'
    report.error = { message: error?.message ?? String(error), cdpException: error?.cdpException }
  } finally {
    if (session?.inspector) {
      try { report.captureFixtureCleanup = await session.inspector.evaluate(mainFixtureExpression(true)) }
      catch (error) { report.captureFixtureCleanup = {closed:false,error:error.message}; report.status = 'FAIL' }
    }
    if (session) report.checks.finalExit = await harness.stop(session)
    try { await closeLoopbackZipServer(server?.server); report.serverClosed = true }
    catch (error) { report.serverClosed = false; report.cleanupError = error.message }
    report.loopbackRequests = server?.requests ?? []
    if (report.checks.finalExit && (!report.checks.finalExit.cleanupConfirmed || report.checks.finalExit.exit?.code !== 0)) report.status = 'FAIL'
    if (!report.serverClosed) report.status = 'FAIL'
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  }
  console.log(JSON.stringify({ status: report.status, runId, reportPath, checks: Object.keys(report.checks), macAcceptance: report.macAcceptance }))
  if (report.status !== 'PASS') process.exitCode = 1
}

await run()
