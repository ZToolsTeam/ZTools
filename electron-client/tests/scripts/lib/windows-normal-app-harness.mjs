import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import vm from 'node:vm'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { publicPluginInstallExpression } from './normal-app-plugin-install.mjs'
import {
  validateBrowserTarget,
  validateMainIdentity,
  validatePluginOpenResult,
  validatePluginTargetOwnership,
  validateRendererIdentity,
  validateFreshPluginZip,
  normalizeWindowsPath,
  digest
} from '../windows-normal-app-plugin-file-chain-lib.mjs'

export const NORMAL_APP_CDP_PORT = 9336
export const NORMAL_APP_INSPECT_PORT = 9337
export const NORMAL_APP_BEFORE_BOOTSTRAP_CONTRACT = 1

/** Test-only hook at the existing owned, isolated bootstrap pause. */
export async function runNormalAppBeforeBootstrapHook({ beforeBootstrap, client, callFrameId, timeoutMs = 10_000 }) {
  if (beforeBootstrap === undefined) return { status: 'NOT_CONFIGURED' }
  if (typeof beforeBootstrap !== 'function' || !client || typeof client.evaluatePausedFrame !== 'function' ||
      typeof callFrameId !== 'string' || !callFrameId || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new Error('NORMAL_APP_BEFORE_BOOTSTRAP_HOOK_INVALID')
  }
  const controller = new AbortController()
  const subscriptions = new Set()
  let active = true
  const requireActive = () => { if (!active || controller.signal.aborted) throw new Error('NORMAL_APP_BEFORE_BOOTSTRAP_HOOK_INVALIDATED') }
  const scopedClient = Object.freeze({
    async call(method, params, timeout) { requireActive(); return client.call(method, params, timeout, { signal: controller.signal }) },
    async evaluate(expression, options) { requireActive(); return client.evaluate(expression, { ...options, signal: controller.signal }) },
    async evaluatePausedFrame(frame, expression, timeout) { requireActive(); return client.evaluatePausedFrame(frame, expression, timeout, { signal: controller.signal }) },
    async waitForEvent(method, accept, timeout) { requireActive(); return client.waitForEvent(method, accept, timeout, { signal: controller.signal }) },
    on(method, listener) {
      requireActive()
      const unsubscribe = client.on(method, value => { if (active && !controller.signal.aborted) listener(value) }, { signal: controller.signal })
      const release = () => { unsubscribe(); subscriptions.delete(release) }
      subscriptions.add(release)
      return release
    }
  })
  const invalidate = reason => {
    active = false
    controller.abort(reason)
    for (const release of [...subscriptions]) release()
  }
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => beforeBootstrap({ client: scopedClient, callFrameId, signal: controller.signal })),
      new Promise((_resolve, reject) => { timer = setTimeout(() => {
        reject(new Error('NORMAL_APP_BEFORE_BOOTSTRAP_HOOK_TIMEOUT'))
        invalidate('timeout')
      }, timeoutMs) })
    ])
  } finally { clearTimeout(timer); invalidate('settled') }
}
const DEFAULT_TIMEOUT_MS = 30_000

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function cdpExceptionDiagnostic(details) {
  const exception = details?.exception && typeof details.exception === 'object' ? details.exception : undefined
  return {
    text: typeof details?.text === 'string' ? details.text.slice(0, 240) : undefined,
    className: typeof exception?.className === 'string' ? exception.className.slice(0, 120) : undefined,
    description: typeof exception?.description === 'string' ? exception.description.slice(0, 1200) : undefined,
    lineNumber: Number.isSafeInteger(details?.lineNumber) ? details.lineNumber : undefined,
    columnNumber: Number.isSafeInteger(details?.columnNumber) ? details.columnNumber : undefined
  }
}

export class CdpClient {
  #socket
  #nextId = 0
  #pending = new Map()
  #listeners = new Map()
  #eventWaiters = new Set()
  #listenerDisposers = new Set()
  #closed = false

  static async connect(url, port, expectedPathPrefix) {
    if (typeof WebSocket !== 'function') throw new Error('NODE_GLOBAL_WEBSOCKET_REQUIRED')
    const parsed = new URL(url)
    if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1' || parsed.port !== String(port) ||
        !parsed.pathname.startsWith(expectedPathPrefix)) throw new Error('CDP_TARGET_IDENTITY_MISMATCH')
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP_CONNECT_TIMEOUT')) }, 10_000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_CONNECT_FAILED')) }, { once: true })
    })
    return new CdpClient(socket)
  }

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', event => {
      if (this.#closed) return
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.method) {
        for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params)
        return
      }
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error('CDP_METHOD_FAILED'))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => this.#failClosed('CDP_CLOSED', false))
    socket.addEventListener('error', () => this.#failClosed('CDP_SOCKET_ERROR', true))
  }

  on(method, listener, { signal } = {}) {
    if (this.#closed) throw new Error('CDP_CLOSED')
    if (signal?.aborted) throw new Error('CDP_ABORTED')
    const listeners = this.#listeners.get(method) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(method, listeners)
    const unsubscribe = () => {
      listeners.delete(listener)
      if (!listeners.size) this.#listeners.delete(method)
      signal?.removeEventListener('abort', unsubscribe)
      this.#listenerDisposers.delete(unsubscribe)
    }
    this.#listenerDisposers.add(unsubscribe)
    signal?.addEventListener('abort', unsubscribe, { once: true })
    return unsubscribe
  }

  waitForEvent(method, accept = () => true, timeoutMs = DEFAULT_TIMEOUT_MS, { signal } = {}) {
    if (this.#closed) return Promise.reject(new Error('CDP_CLOSED'))
    if (signal?.aborted) return Promise.reject(new Error('CDP_ABORTED'))
    let resolveEvent
    let rejectEvent
    let unsubscribe = () => {}
    let timer
    let finished = false
    const cleanup = () => {
      clearTimeout(timer)
      unsubscribe()
      this.#eventWaiters.delete(cancel)
      signal?.removeEventListener('abort', onAbort)
    }
    const cancel = code => {
      if (finished) return
      finished = true
      cleanup()
      rejectEvent(new Error(code))
    }
    const promise = new Promise((resolve, reject) => { resolveEvent = resolve; rejectEvent = reject })
    const onAbort = () => cancel('CDP_ABORTED')
    timer = setTimeout(() => cancel('CDP_EVENT_TIMEOUT'), timeoutMs)
    unsubscribe = this.on(method, value => {
      if (finished) return
      let matches = false
      try { matches = accept(value) === true } catch { cancel('CDP_EVENT_PREDICATE_FAILED'); return }
      if (!matches) return
      finished = true
      cleanup()
      resolveEvent(value)
    })
    this.#eventWaiters.add(cancel)
    signal?.addEventListener('abort', onAbort, { once: true })
    promise.catch(() => {})
    return promise
  }

  call(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, { signal } = {}) {
    if (this.#closed) return Promise.reject(new Error('CDP_CLOSED'))
    if (signal?.aborted) return Promise.reject(new Error('CDP_ABORTED'))
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const methodLabel = method.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
      const cleanup = () => { clearTimeout(timer); this.#pending.delete(id); signal?.removeEventListener('abort', onAbort) }
      const onAbort = () => { cleanup(); reject(new Error('CDP_ABORTED')) }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`CDP_METHOD_TIMEOUT_${methodLabel}`)) }, timeoutMs)
      this.#pending.set(id, { resolve: value => { cleanup(); resolve(value) }, reject: error => { cleanup(); reject(error) }, timer })
      signal?.addEventListener('abort', onAbort, { once: true })
      try { this.#socket.send(JSON.stringify({ id, method, params })) }
      catch { cleanup(); reject(new Error('CDP_SEND_FAILED')) }
    })
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
    try { new vm.Script(expression) }
    catch (cause) {
      const error = new Error('CDP_EXPRESSION_SYNTAX_INVALID')
      error.cdpException = { text: 'SyntaxError', className: typeof cause?.name === 'string' ? cause.name : 'SyntaxError',
        description: typeof cause?.message === 'string' ? cause.message.slice(0, 600) : undefined }
      throw error
    }
    const response = await this.call('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true, userGesture: false, timeout: timeoutMs
    }, timeoutMs + 1000, { signal })
    if (response.exceptionDetails) {
      const error = new Error('CDP_EVALUATION_FAILED')
      error.cdpException = cdpExceptionDiagnostic(response.exceptionDetails)
      throw error
    }
    return response.result?.value
  }

  async evaluatePausedFrame(callFrameId, expression, timeoutMs = DEFAULT_TIMEOUT_MS, { signal } = {}) {
    if (typeof callFrameId !== 'string' || !callFrameId) throw new Error('CDP_PAUSED_FRAME_ID_MISSING')
    const response = await this.call('Debugger.evaluateOnCallFrame', {
      callFrameId, expression, returnByValue: true, silent: false, generatePreview: false
    }, timeoutMs + 1000, { signal })
    if (response.exceptionDetails) {
      const error = new Error('CDP_EVALUATION_FAILED')
      error.cdpException = cdpExceptionDiagnostic(response.exceptionDetails)
      throw error
    }
    return response.result?.value
  }

  dispose() {
    this.#failClosed('CDP_CLOSED', true)
  }

  #failClosed(code, closeSocket) {
    if (this.#closed) return
    this.#closed = true
    this.#rejectPending(code)
    for (const cancel of [...this.#eventWaiters]) cancel(code)
    for (const unsubscribe of [...this.#listenerDisposers]) unsubscribe()
    this.#listeners.clear()
    if (closeSocket) {
      try { this.#socket.close() } catch { /* The socket is already unusable. */ }
    }
  }

  #rejectPending(code) {
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(code)) }
    this.#pending.clear()
  }
}

function mainRequire(body) {
  return `(() => { const mainModule = process.mainModule; if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE'); const requireMain = mainModule.require.bind(mainModule); ${body} })()`
}

function mainProbeExpression() {
  return mainRequire(`const electron = requireMain('electron'); const path = requireMain('node:path'); const app = electron.app; return {
    pid: process.pid, execPath: process.execPath, electronVersion: process.versions.electron,
    appPath: app.getAppPath(), appName: app.getName(), appVersion: app.getVersion(), isPackaged: app.isPackaged,
    appDataPath: app.getPath('appData'), userDataPath: app.getPath('userData'), sessionDataPath: app.getPath('sessionData'),
    dataRoot: path.join(app.getPath('appData'), 'ZTools', 'DataV2'), pluginRoot: path.join(app.getPath('appData'), 'ZTools', 'DataV2', 'Plugins'),
    argv: process.argv, execArgv: process.execArgv
  };`)
}

function isolatedPathsExpression(profile) {
  return mainRequire(`const app = requireMain('electron').app;
    app.setPath('appData', ${JSON.stringify(profile.appDataPath)});
    app.setPath('userData', ${JSON.stringify(profile.userDataPath)});
    app.setPath('sessionData', ${JSON.stringify(profile.sessionDataPath)});
    const path = requireMain('node:path');
    return { appDataPath: app.getPath('appData'), userDataPath: app.getPath('userData'), sessionDataPath: app.getPath('sessionData'),
      dataRoot: path.join(app.getPath('appData'), 'ZTools', 'DataV2'), pluginRoot: path.join(app.getPath('appData'), 'ZTools', 'DataV2', 'Plugins') };`)
}

function appQuitExpression() { return mainRequire(`requireMain('electron').app.quit(); return true;`) }

async function waitForJson(url, timeoutMs, predicate) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
      if (response.ok) {
        const value = await response.json()
        if (predicate(value)) return value
      }
    } catch { /* Retry until the bounded deadline. */ }
    await delay(100)
  }
  throw new Error('CDP_TARGET_NOT_READY')
}

async function waitForCondition(read, accept, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await delay(150)
  }
  throw new Error(code)
}

async function requirePortsAvailable(ports) {
  for (const port of ports) {
    const server = net.createServer()
    await new Promise((resolve, reject) => {
      const fail = error => reject(error.code === 'EADDRINUSE' ? new Error(`CDP_PORT_CONFLICT_${port}`) : error)
      server.once('error', fail)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', fail)
        server.close(error => error ? reject(error) : resolve())
      })
    })
  }
}

function bootstrapExpression(bootstrapPath) { return pathToFileURL(path.resolve(bootstrapPath)).href }

export function installIsolatedClipboardGuard(electron) {
  const clipboard = electron.clipboard
  const empty = {
    read: () => String(), readText: () => '', readHTML: () => '', readRTF: () => '', readFindText: () => '',
    readBookmark: () => ({ title: '', url: '' }), readImage: () => electron.nativeImage.createEmpty(),
    readBuffer: () => Buffer.alloc(0), availableFormats: () => [], has: () => false
  }
  const methods = Object.getOwnPropertyNames(clipboard).filter(name => typeof clipboard[name] === 'function')
  for (const name of methods) {
    if ((name.startsWith('read') || name.startsWith('write') || name === 'clear') &&
        !Object.hasOwn(empty, name) && !name.startsWith('write') && name !== 'clear') {
      throw new Error('ISOLATED_CLIPBOARD_METHOD_UNSUPPORTED')
    }
  }
  const guarded = []
  for (const name of methods) {
    const replacement = empty[name] ?? ((name.startsWith('write') || name === 'clear')
      ? () => { throw new Error('ISOLATED_CLIPBOARD_WRITE_BLOCKED') } : undefined)
    if (!replacement) continue
    const descriptor = Object.getOwnPropertyDescriptor(clipboard, name)
    if (!descriptor || (!descriptor.configurable && !descriptor.writable)) throw new Error('ISOLATED_CLIPBOARD_GUARD_UNAVAILABLE')
    Object.defineProperty(clipboard, name, { ...descriptor, value: replacement })
    guarded.push(name)
  }
  for (const required of ['readText', 'readImage', 'availableFormats', 'has']) {
    if (!guarded.includes(required)) throw new Error('ISOLATED_CLIPBOARD_GUARD_INCOMPLETE')
  }
  return { status: 'PASS', source: 'synthetic-empty', guardedMethods: guarded, lifetime: 'owned-process' }
}

async function connectInspector(child, executable, appRoot, bootstrapPath, profile, report, phase, inspectPort = NORMAL_APP_INSPECT_PORT, beforeBootstrap) {
  const targets = await waitForJson(`http://127.0.0.1:${inspectPort}/json/list`, 15_000,
    value => Array.isArray(value) && value.some(item => typeof item.webSocketDebuggerUrl === 'string'))
  const target = targets.find(item => typeof item.webSocketDebuggerUrl === 'string')
  if (!target) throw new Error('MAIN_INSPECTOR_TARGET_MISSING')
  const client = await CdpClient.connect(target.webSocketDebuggerUrl, inspectPort, '/')
  const diagnostics = { status: 'IN_PROGRESS', targetId: target.id, targetTitle: target.title ?? '', targetUrl: target.url ?? '', trace: [] }
  report.phases[`${phase}Inspector`] = diagnostics
  let currentStep = 'attach-inspector'
  const perform = async (name, action) => {
    currentStep = name
    const value = await action()
    diagnostics.trace.push({ step: name, status: 'PASS' })
    return value
  }
  try {
    const scriptUrls = new Map()
    client.on('Debugger.scriptParsed', params => {
      if (typeof params?.scriptId === 'string' && typeof params?.url === 'string') scriptUrls.set(params.scriptId, params.url)
    })
    await perform('runtime-enable', () => client.call('Runtime.enable'))
    const initialPausePromise = client.waitForEvent('Debugger.paused', () => true, 15_000)
    await perform('debugger-enable', () => client.call('Debugger.enable'))
    const url = bootstrapExpression(bootstrapPath)
    const breakpoint = await perform('bootstrap-breakpoint-install', () => client.call('Debugger.setBreakpointByUrl', { lineNumber: 0, url }))
    if (typeof breakpoint?.breakpointId !== 'string') throw new Error('BOOTSTRAP_BREAKPOINT_NOT_INSTALLED')
    const isBootstrapPause = params => params?.hitBreakpoints?.includes(breakpoint.breakpointId) === true ||
      Array.isArray(params?.callFrames) && params.callFrames.some(frame =>
        frame.url === url || scriptUrls.get(frame.location?.scriptId) === url)
    await perform('run-if-waiting-for-debugger', () => client.call('Runtime.runIfWaitingForDebugger'))
    const initialPause = await perform('initial-debugger-pause', () => initialPausePromise)
    let pause = initialPause
    if (!isBootstrapPause(initialPause)) {
      const bootstrapPause = client.waitForEvent('Debugger.paused', isBootstrapPause, 30_000)
      await perform('resume-default-app-pause', () => client.call('Debugger.resume'))
      pause = await perform('wait-bootstrap-pause', () => bootstrapPause)
    }
    if (!isBootstrapPause(pause)) throw new Error('BOOTSTRAP_FIRST_LINE_NOT_CONFIRMED')
    const callFrameId = pause.callFrames?.[0]?.callFrameId
    if (typeof callFrameId !== 'string' || !callFrameId) throw new Error('BOOTSTRAP_CALL_FRAME_MISSING')
    await client.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId })
    const entryIdentity = await perform('bootstrap-entry-identity-evaluate', () => client.evaluatePausedFrame(callFrameId,
      mainRequire(`const electron = requireMain('electron'); const app = electron.app; return { pid: process.pid,
        execPath: process.execPath, electronVersion: process.versions.electron, appPath: app.getAppPath(),
        appName: app.getName(), appVersion: app.getVersion(), isPackaged: app.isPackaged };`)))
    diagnostics.bootstrapEntryIdentity = entryIdentity
    if (entryIdentity?.pid !== child.pid || normalizeWindowsPath(entryIdentity.execPath ?? '') !== normalizeWindowsPath(executable) ||
        normalizeWindowsPath(entryIdentity.appPath ?? '') !== normalizeWindowsPath(appRoot) || entryIdentity.electronVersion !== '43.4.1' ||
        entryIdentity.isPackaged !== false) throw new Error('PROJECT_MAIN_ENTRY_IDENTITY_MISMATCH')
    const configured = await perform('isolated-paths-set', () => client.evaluatePausedFrame(callFrameId, isolatedPathsExpression(profile)))
    if (normalizeWindowsPath(configured?.appDataPath ?? '') !== normalizeWindowsPath(profile.appDataPath) ||
        normalizeWindowsPath(configured?.userDataPath ?? '') !== normalizeWindowsPath(profile.userDataPath) ||
        normalizeWindowsPath(configured?.sessionDataPath ?? '') !== normalizeWindowsPath(profile.sessionDataPath)) {
      throw new Error('ISOLATED_PATH_CONFIGURATION_FAILED')
    }
    report.isolatedAppData = true
    report.isolationConfirmed = true
    report.phases[`${phase}Isolation`] = { status: 'PASS', inspectorTargetId: target.id, ownedPid: child.pid,
      pauseReason: pause.reason ?? null, pauseHitBreakpoints: pause.hitBreakpoints ?? [], entryIdentity, configuredPaths: configured }
    const identity = await perform('isolated-main-identity-verify', () => client.evaluatePausedFrame(callFrameId, mainProbeExpression()))
    if (identity?.pid !== child.pid || normalizeWindowsPath(identity.execPath ?? '') !== normalizeWindowsPath(executable) ||
        normalizeWindowsPath(identity.appPath ?? '') !== normalizeWindowsPath(appRoot) || identity.electronVersion !== '43.4.1') {
      throw new Error('PROJECT_MAIN_ENTRY_IDENTITY_MISMATCH')
    }
    report.phases[`${phase}ClipboardIsolation`] = await perform('isolate-clipboard-before-bootstrap', () =>
      client.evaluatePausedFrame(callFrameId, mainRequire(`return (${installIsolatedClipboardGuard.toString()})(requireMain('electron'));`)))
    if (beforeBootstrap !== undefined) {
      report.phases[`${phase}BeforeBootstrapTestHook`] = await perform('before-bootstrap-test-hook', () =>
        runNormalAppBeforeBootstrapHook({ beforeBootstrap, client, callFrameId }))
    }
    await perform('resume-isolated-bootstrap', () => client.call('Debugger.resume'))
    diagnostics.status = 'PASS'
    return { client, targetId: target.id, initialIdentity: entryIdentity, bootstrapIdentity: identity, configuredPaths: configured }
  } catch (error) {
    diagnostics.status = 'FAIL'
    diagnostics.failureStep = currentStep
    diagnostics.errorName = typeof error?.name === 'string' ? error.name : 'UnknownError'
    diagnostics.errorMessage = typeof error?.message === 'string' ? error.message.slice(0, 240) : ''
    if (error && typeof error === 'object') error.stage = `${phase}-${currentStep}`
    client.dispose()
    throw error
  }
}

export async function enableRendererAfterCommit(page, urlPattern, timeoutMs = 30_000) {
  if (!(urlPattern instanceof RegExp)) throw new Error('COMMITTED_RENDERER_URL_PATTERN_REQUIRED')
  await page.call('Page.enable')
  const committed = await waitForCondition(async () => {
    const response = await page.call('Page.getFrameTree')
    const frame = response?.frameTree?.frame
    urlPattern.lastIndex = 0
    if (typeof frame?.url !== 'string' || !urlPattern.test(frame.url) ||
        typeof frame.loaderId !== 'string' || !frame.loaderId) return null
    return { url: frame.url, loaderId: frame.loaderId }
  }, Boolean, timeoutMs, 'NORMAL_RENDERER_NAVIGATION_NOT_COMMITTED')
  await page.call('Runtime.enable')
  return committed
}

export async function waitForMainPageTarget(readTargets, timeoutMs = 45_000) {
  if (typeof readTargets !== 'function') throw new Error('MAIN_TARGET_READER_INVALID')
  return await waitForCondition(async () => {
    let targets
    try {
      targets = await readTargets()
    } catch (error) {
      if (error instanceof Error && error.message === 'CDP_TARGET_NOT_READY') return null
      throw error
    }
    const matching = targets.filter(item => /^ztools:\/\/web(?:\/|$)/.test(item.url ?? ''))
    return matching.length === 1 ? matching[0] : null
  }, Boolean, timeoutMs, 'NORMAL_MAIN_ZTOOLS_TARGET_NOT_FOUND')
}

async function connectMainPage(cdpPort = NORMAL_APP_CDP_PORT) {
  const target = await waitForMainPageTarget(() =>
    waitForJson(`http://127.0.0.1:${cdpPort}/json/list`, 2000, Array.isArray))
  const validation = validateBrowserTarget(target, cdpPort, /^ztools:\/\/web(?:\/|$)/)
  if (validation.status !== 'PASS') throw new Error(validation.code)
  const page = await CdpClient.connect(target.webSocketDebuggerUrl, cdpPort, '/devtools/page/')
  const events = []
  page.on('Page.domContentEventFired', () => events.push('dom-content-loaded'))
  page.on('Page.loadEventFired', () => events.push('load'))
  page.on('Runtime.exceptionThrown', params => events.push({ type: 'exception',
    text: String(params?.exceptionDetails?.text ?? '').slice(0, 240) }))
  page.on('Runtime.consoleAPICalled', params => {
    if (params?.type === 'error' || params?.type === 'warning') events.push({ type: params.type,
      text: (params.args ?? []).map(item => String(item?.value ?? item?.description ?? '')).join(' ').slice(0, 240) })
  })
  let commitProof, lastReadiness
  try {
  commitProof = await enableRendererAfterCommit(page, /^ztools:\/\/web(?:\/|$)/)
  const readiness = await waitForCondition(() => page.evaluate(`(async () => {
    const sdk = window.ztools; const ready = document.readyState === 'complete';
    if (!ready || !sdk || typeof sdk.isElectron !== 'function' || !sdk.isElectron() ||
        typeof sdk.sys?.getRuntimeIdentity !== 'function') return { ready, sdkType: typeof sdk, runtimeIdentityType: typeof sdk?.sys?.getRuntimeIdentity, isElectron: sdk?.isElectron?.() === true, url: location.href, electronBridge: typeof window.__ztoolsElectron, scripts: Array.from(document.scripts).map(s => s.src), resources: performance.getEntriesByType('resource').map(r => ({ name: r.name, duration: r.duration, transferSize: r.transferSize })), html: document.documentElement?.outerHTML?.slice(0, 1000) };
    return { ready, isElectron: true, identity: await sdk.sys.getRuntimeIdentity(), sdkContractVersion: window.__ztoolsElectron?.contractVersion,
      url: location.href, targetId: ${JSON.stringify(target.id)}, userAgent: navigator.userAgent, nodeType: typeof process, requireType: typeof require,
      pluginInstallType: typeof sdk.plugin?.install, pluginOpenType: typeof sdk.plugin?.open, pluginCloseType: typeof sdk.plugin?.close,
      fsWriteType: typeof sdk.fs?.writeFile };
  })()`).then(value => { lastReadiness = value; return value }), value => value?.ready === true && value.isElectron === true && /^ztools:\/\/web(?:\/|$)/.test(value.url ?? ''),
  30_000, 'MAIN_RENDERER_NOT_READY')
  const validationIdentity = validateRendererIdentity(readiness, { targetId: target.id,
    appVersion: readiness.identity?.appVersion, electronVersion: '43.4.1', sdkContractVersion: readiness.sdkContractVersion })
  if (validationIdentity.status !== 'PASS' || readiness.pluginInstallType !== 'function' || readiness.pluginOpenType !== 'function' ||
      readiness.pluginCloseType !== 'function' || readiness.fsWriteType !== 'function') throw new Error(validationIdentity.code ?? 'PUBLIC_SDK_METHOD_MISSING')
  return { target, page, commitProof, identity: validationIdentity.snapshot, rawIdentity: readiness,
    readiness: { readyState: 'complete', url: readiness.url, ztoolsType: 'object', isElectronType: 'function',
      isElectron: readiness.isElectron, runtimeIdentityType: 'function' }, events }
  } catch (error) {
    if (error && typeof error === 'object') error.cdpDiagnostics = { targetId: target.id, targetUrl: target.url,
      commitProof: commitProof ?? null, lastReadiness: lastReadiness ?? null, events }
    page.dispose()
    throw error
  }
}

function profilePaths(profileRoot, outputRoot) {
  const absoluteRoot = path.resolve(profileRoot)
  const absoluteOutput = path.resolve(outputRoot)
  const outputStat = fs.lstatSync(absoluteOutput)
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink() ||
      normalizeWindowsPath(fs.realpathSync.native(absoluteOutput)) !== normalizeWindowsPath(absoluteOutput)) {
    throw new Error('NORMAL_APP_OUTPUT_ROOT_INVALID')
  }
  const relative = path.relative(absoluteOutput, absoluteRoot)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PROFILE_OUTSIDE_RUN_ROOT')
  const profile = { root: absoluteRoot, appDataPath: path.join(absoluteRoot, 'appData'),
    userDataPath: path.join(absoluteRoot, 'userData'), sessionDataPath: path.join(absoluteRoot, 'sessionData'),
    tempPath: path.join(absoluteRoot, 'tmp') }
  fs.mkdirSync(profile.root, { recursive: false })
  for (const key of ['appDataPath', 'userDataPath', 'sessionDataPath', 'tempPath']) fs.mkdirSync(profile[key], { recursive: false })
  return profile
}

function assertIsolatedProfile(profile, outputRoot) {
  if (!profile || typeof profile !== 'object') throw new Error('ISOLATED_PROFILE_INVALID')
  const root = path.resolve(profile.root ?? '')
  const relative = path.relative(path.resolve(outputRoot), root)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      normalizeWindowsPath(fs.realpathSync.native(root)) !== normalizeWindowsPath(root)) throw new Error('PROFILE_OUTSIDE_RUN_ROOT')
  for (const [key, leaf] of [['appDataPath', 'appData'], ['userDataPath', 'userData'],
    ['sessionDataPath', 'sessionData'], ['tempPath', 'tmp']]) {
    const expected = path.join(root, leaf)
    if (path.resolve(profile[key] ?? '') !== expected) throw new Error('ISOLATED_PROFILE_PATH_MISMATCH')
    const stat = fs.lstatSync(expected)
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        normalizeWindowsPath(fs.realpathSync.native(expected)) !== normalizeWindowsPath(expected)) {
      throw new Error('ISOLATED_PROFILE_DIRECTORY_INVALID')
    }
  }
}

function profileEnvironment(profile) {
  const env = { ...process.env, APPDATA: profile.appDataPath, LOCALAPPDATA: profile.userDataPath,
    TEMP: profile.tempPath, TMP: profile.tempPath, TMPDIR: profile.tempPath }
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

function openLogs(child, outputRoot, phase) {
  const stdoutPath = path.join(outputRoot, `${phase}.stdout.log`)
  const stderrPath = path.join(outputRoot, `${phase}.stderr.log`)
  const stdout = fs.createWriteStream(stdoutPath, { flags: 'wx' })
  const stderr = fs.createWriteStream(stderrPath, { flags: 'wx' })
  child.stdout?.pipe(stdout)
  child.stderr?.pipe(stderr)
  return { stdoutPath, stderrPath, stdout, stderr }
}

function runPowerShellJson(command, timeoutMs = 30_000) {
  const windowsDirectory = process.env.WINDIR ?? 'C:\\Windows'
  const executable = path.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    shell: false, windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024
  })
  if (result.error || result.status !== 0) throw new Error('OWNED_PROCESS_QUERY_FAILED')
  const value = result.stdout.trim()
  if (!value) return []
  const parsed = JSON.parse(value)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function getProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('OWNED_PARENT_PID_INVALID')
  const command = `$target = ${pid}; $row = Get-CimInstance Win32_Process -Filter "ProcessId=$target" | Select-Object -First 1; if ($null -eq $row) { '[]' } else { ConvertTo-Json -InputObject @(@{ pid=[int]$row.ProcessId; parentPid=[int]$row.ParentProcessId; executablePath=$row.ExecutablePath; commandLine=$row.CommandLine; creationUtc=$(if ($null -ne $row.CreationDate) { $row.CreationDate.ToUniversalTime().ToString('o') } else { $null }) }) -Compress }`
  return runPowerShellJson(command)[0] ?? null
}

export function verifyOwnedElectronProcess(snapshot, expected) {
  if (!snapshot || !expected || !Number.isSafeInteger(expected.pid) || expected.pid <= 0 || snapshot.pid !== expected.pid ||
      typeof snapshot.executablePath !== 'string' || normalizeWindowsPath(snapshot.executablePath) !== normalizeWindowsPath(expected.executablePath) ||
      typeof snapshot.commandLine !== 'string') return { status: 'FAIL', reason: 'PROCESS_IDENTITY_MISMATCH' }
  const validCreation = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value) && Number.isFinite(Date.parse(value))
  if (!validCreation(snapshot.creationUtc) || !validCreation(expected.creationUtc) || snapshot.creationUtc !== expected.creationUtc) {
    return { status: 'FAIL', reason: 'PROCESS_CREATION_IDENTITY_MISMATCH' }
  }
  if (expected.parentPid !== undefined && snapshot.parentPid !== expected.parentPid) return { status: 'FAIL', reason: 'PROCESS_PARENT_IDENTITY_MISMATCH' }
  const commandArguments = parseWindowsCommandLine(snapshot.commandLine)
  const expectedArguments = [expected.executablePath, ...(expected.launchArguments ?? [
    '.', `--inspect-brk=127.0.0.1:${NORMAL_APP_INSPECT_PORT}`,
    `--remote-debugging-port=${NORMAL_APP_CDP_PORT}`, '--remote-debugging-address=127.0.0.1'
  ])]
  if (commandArguments.length !== expectedArguments.length || commandArguments.some((argument, index) =>
      index === 0 ? normalizeWindowsPath(argument) !== normalizeWindowsPath(expectedArguments[index]) :
        argument.toLocaleLowerCase('en-US') !== expectedArguments[index].toLocaleLowerCase('en-US'))) {
    return { status: 'FAIL', reason: 'APP_ENTRY_ARGUMENTS_MISMATCH' }
  }
  return { status: 'PASS', pid: snapshot.pid, executablePath: snapshot.executablePath,
    creationUtc: snapshot.creationUtc, appEntryConfirmed: true, requiredArgumentsConfirmed: true }
}

function parseWindowsCommandLine(commandLine) {
  const args = []
  let index = 0
  while (index < commandLine.length) {
    while (index < commandLine.length && /\s/.test(commandLine[index])) index++
    if (index >= commandLine.length) break
    let value = ''
    let quoted = false
    while (index < commandLine.length) {
      if (commandLine[index] === '\\') {
        let slashes = 0
        while (commandLine[index] === '\\') { slashes++; index++ }
        if (commandLine[index] === '"') {
          value += '\\'.repeat(Math.floor(slashes / 2))
          if (slashes % 2 === 1) { value += '"'; index++ }
          else { quoted = !quoted; index++ }
        } else value += '\\'.repeat(slashes)
        continue
      }
      if (commandLine[index] === '"') { quoted = !quoted; index++; continue }
      if (!quoted && /\s/.test(commandLine[index])) break
      value += commandLine[index++]
    }
    if (quoted) return []
    args.push(value)
    while (index < commandLine.length && /\s/.test(commandLine[index])) index++
  }
  return args
}

function getDescendants(rootPid) {
  const rows = runPowerShellJson("$rows = @(Get-CimInstance Win32_Process | Select-Object @{Name='pid';Expression={[int]$_.ProcessId}}, @{Name='parentPid';Expression={[int]$_.ParentProcessId}}, @{Name='name';Expression={$_.Name}}, @{Name='executablePath';Expression={$_.ExecutablePath}}); ConvertTo-Json -InputObject $rows -Compress", 30_000)
  const children = new Map()
  for (const row of rows) {
    if (!Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.parentPid)) continue
    const list = children.get(row.parentPid) ?? []
    list.push(row)
    children.set(row.parentPid, list)
  }
  const seen = new Set([rootPid])
  const pending = [rootPid]
  const descendants = []
  while (pending.length) {
    for (const child of children.get(pending.shift()) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      descendants.push(child)
      pending.push(child.pid)
    }
  }
  return descendants
}

async function waitForDescendantCleanup(rootPid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let remaining = []
  try {
    do {
      remaining = getDescendants(rootPid)
      if (!remaining.length) return { status: 'PASS', remaining: [] }
      await delay(200)
    } while (Date.now() < deadline)
    return { status: 'FAIL', remaining }
  } catch (error) { return { status: 'NOT_RUN', failureCode: error?.message ?? 'OWNED_PROCESS_QUERY_FAILED', remaining: null } }
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolve, reject) => {
    let settled = false
    const onDone = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('close', onDone)
      child.removeListener('exit', onDone)
      resolve({ code: code ?? child.exitCode, signal: signal ?? child.signalCode })
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.removeListener('close', onDone)
      child.removeListener('exit', onDone)
      reject(new Error('OWNED_ELECTRON_EXIT_TIMEOUT'))
    }, timeoutMs)
    child.once('close', onDone)
    child.once('exit', onDone)
  })
}

function safePluginId(pluginId) {
  if (typeof pluginId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(pluginId)) throw new Error('PLUGIN_ID_INVALID')
  return pluginId
}

async function waitForPluginTarget(pluginId, mustExist = true, cdpPort = NORMAL_APP_CDP_PORT) {
  const safeId = safePluginId(pluginId)
  const pattern = new RegExp(`^ztools:\\x2f\\x2fplugins\\/${safeId}(?:\\/|$)`)
  return await waitForCondition(async () => {
    const targets = await waitForJson(`http://127.0.0.1:${cdpPort}/json/list`, 2000, Array.isArray)
    return targets.filter(item => pattern.test(item.url ?? ''))
  }, targets => mustExist ? targets.length === 1 : targets.length === 0, 30_000,
  mustExist ? 'PLUGIN_CDP_TARGET_NOT_FOUND' : 'PLUGIN_CDP_TARGET_STILL_OPEN')
}

async function invokePublicPluginApi(page, source) {
  const value = await page.evaluate(`(async () => { if (!window.ztools?.plugin) throw new Error('PLUGIN_SDK_UNAVAILABLE'); return await (${source}); })()`)
  if (value?.success === false) throw new Error('PUBLIC_PLUGIN_API_FAILED')
  return value
}

function sha256File(file) { return digest(fs.readFileSync(file)) }

export class WindowsNormalAppHarness {
  constructor({ appRoot, executable, outputRoot, versions, ports = { cdp: NORMAL_APP_CDP_PORT, inspect: NORMAL_APP_INSPECT_PORT } }) {
    this.appRoot = path.resolve(appRoot)
    this.executable = path.resolve(executable)
    this.outputRoot = path.resolve(outputRoot)
    this.versions = versions
    this.ports = ports
    if (!versions || versions.electronVersion !== '43.4.1' || !ports ||
        !Number.isSafeInteger(ports.cdp) || ports.cdp < 1 || ports.cdp > 65535 ||
        !Number.isSafeInteger(ports.inspect) || ports.inspect < 1 || ports.inspect > 65535 || ports.cdp === ports.inspect) {
      throw new Error('NORMAL_APP_HARNESS_CONFIGURATION_INVALID')
    }
  }

  createProfile(profileRoot) { return profilePaths(profileRoot, this.outputRoot) }

  async start({ profile, phase, report, requireReferenceRuntime = false, beforeBootstrap }) {
    if (beforeBootstrap !== undefined && typeof beforeBootstrap !== 'function') throw new Error('NORMAL_APP_BEFORE_BOOTSTRAP_HOOK_INVALID')
    if (!report || typeof report !== 'object' || Array.isArray(report) ||
        !report.phases || typeof report.phases !== 'object' || Array.isArray(report.phases) ||
        !Object.isExtensible(report.phases)) throw new Error('NORMAL_APP_REPORT_INVALID')
    if (typeof phase !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(phase)) {
      throw new Error('NORMAL_APP_PHASE_INVALID')
    }
    assertIsolatedProfile(profile, this.outputRoot)
    await requirePortsAvailable([this.ports.cdp, this.ports.inspect])
    const bootstrapPath = path.join(this.appRoot, 'out', 'main', 'bootstrap.js')
    if (!fs.lstatSync(bootstrapPath).isFile()) throw new Error('PROJECT_BOOTSTRAP_NOT_BUILT')
    const launchArguments = ['.', `--inspect-brk=127.0.0.1:${this.ports.inspect}`,
      `--remote-debugging-port=${this.ports.cdp}`, '--remote-debugging-address=127.0.0.1']
    const child = spawn(this.executable, launchArguments, {
      cwd: this.appRoot, env: profileEnvironment(profile), shell: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe']
    })
    child.__normalAppClosePromise = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    const session = { child, logs: undefined, inspector: undefined, browserPage: undefined, pluginPages: [], processRecord: undefined,
      profile, appRoot: this.appRoot, executable: this.executable, ports: this.ports, versions: this.versions,
      outputRoot: this.outputRoot, launchArguments }
    try {
      const logs = openLogs(child, this.outputRoot, phase)
      session.logs = logs
      const processRecord = { status: 'STARTED', ownedPid: child.pid, executablePath: this.executable,
        isolationConfirmed: false, appEntry: 'electron .', inspectorPort: this.ports.inspect, cdpPort: this.ports.cdp,
        launchArguments,
        logPaths: { stdout: logs.stdoutPath, stderr: logs.stderrPath }, cleanup: { status: 'PENDING' } }
      session.processRecord = processRecord
      report.phases[`${phase}Process`] = processRecord
      const launchIdentity = getProcessIdentity(child.pid)
      const launchOwnership = verifyOwnedElectronProcess(launchIdentity, { pid: child.pid, executablePath: this.executable,
        launchArguments, creationUtc: launchIdentity?.creationUtc, parentPid: process.pid })
      if (launchOwnership.status !== 'PASS') throw new Error('OWNED_LAUNCH_IDENTITY_UNCONFIRMED')
      session.launchIdentity = launchIdentity
      processRecord.launchIdentity = launchIdentity
      const inspector = await connectInspector(child, this.executable, this.appRoot, bootstrapPath, profile, report, phase,
        this.ports.inspect, beforeBootstrap)
      processRecord.isolationConfirmed = true
      session.inspector = inspector.client
      const mainPage = await connectMainPage(this.ports.cdp)
      session.browserPage = mainPage
      session.targetId = mainPage.target.id
      session.inspectorTargetId = inspector.targetId
      session.mainIdentity = await session.inspector.evaluate(mainProbeExpression())
      const expected = { pid: child.pid, execPath: this.executable, electronVersion: this.versions.electronVersion,
        appName: this.versions.appName, appVersion: this.versions.appVersion, appPath: this.appRoot,
        appDataPath: profile.appDataPath, userDataPath: profile.userDataPath, sessionDataPath: profile.sessionDataPath }
      const mainValidation = validateMainIdentity(session.mainIdentity, expected)
      if (mainValidation.status !== 'PASS') throw new Error(mainValidation.code)
      session.rendererIdentity = mainPage.identity
      session.configuredPaths = inspector.configuredPaths
      report.phases[`${phase}RendererIdentity`] = { status: 'PASS', targetId: mainPage.target.id, targetUrl: mainPage.target.url,
        commitProof: mainPage.commitProof, runtimeEnablePolicy: 'after-expected-frame-commit',
        events: mainPage.events, readiness: mainPage.readiness, identity: mainPage.rawIdentity, validation: 'PASS' }
      if (requireReferenceRuntime) {
        const logPath = path.join(profile.appDataPath, 'ZTools', 'Logs', `electron-main-${new Date().toISOString().slice(0, 10)}.log`)
        const contents = await waitForCondition(() => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '',
          text => text.includes('Reference runtime available') || text.includes('Reference runtime unavailable'), 45_000,
          'REFERENCE_RUNTIME_LOG_NOT_FOUND')
        session.runtimeLogPath = logPath
        session.runtimeLog = contents
        session.referenceRuntime = contents.includes('Reference runtime available') ? 'AVAILABLE' : 'UNAVAILABLE'
      }
      return session
    } catch (error) {
      const cleanup = await this.stop(session)
      if (error && typeof error === 'object') error.cleanup = cleanup
      throw error
    }
  }

  async install(session, { pluginId, zipPath, zipInfo, zipUrl, version, pluginRoot }) {
    const id = safePluginId(pluginId)
    const resolvedZip = zipInfo ?? validateFreshPluginZip(zipPath, pluginRoot, id)
    const directory = path.join(session.profile.appDataPath, 'ZTools', 'DataV2', 'Plugins', id)
    if (fs.existsSync(directory)) throw new Error('PLUGIN_ALREADY_PRESENT_IN_FRESH_PROFILE')
    const { accepted, completion } = await session.browserPage.page.evaluate(publicPluginInstallExpression({
      pluginId: id, zipUrl, version, checksum: resolvedZip.checksum, fileSize: resolvedZip.fileSize
    }), { timeoutMs: 95_000 })
    const installed = await waitForCondition(async () => {
      const manifestPath = path.join(directory, 'plugin.json')
      if (!fs.existsSync(manifestPath)) return null
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        const entries = fs.readdirSync(directory)
        if (manifest.id !== id || manifest.version !== version || !entries.includes('index.html') || !entries.includes('app.js')) return null
        return { manifest, entries }
      } catch { return null }
    }, value => Boolean(value), 90_000, 'PLUGIN_INSTALL_FILES_NOT_READY')
    const refresh = await session.browserPage.page.evaluate('window.ztools.plugin.refresh()')
    if (refresh?.success === false) throw new Error('PLUGIN_LIST_REFRESH_FAILED')
    const root = path.join(session.profile.appDataPath, 'ZTools', 'DataV2', 'Plugins')
    const relative = path.relative(root, directory)
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('INSTALLED_PLUGIN_PATH_NOT_ISOLATED')
    const names = installed.entries.filter(name => name === 'plugin.json' || name === 'index.html' || name === 'app.js')
    return { pluginDirectory: directory, manifest: installed.manifest, entries: installed.entries,
      listRefreshResult: refresh, fileHashes: Object.fromEntries(names.map(name => [name, sha256File(path.join(directory, name))])), accepted, completion }
  }

  async open(session, pluginId) {
    const id = safePluginId(pluginId)
    const opened = await invokePublicPluginApi(session.browserPage.page, `window.ztools.plugin.open(${JSON.stringify(id)})`)
    const openedValidation = validatePluginOpenResult(opened, id)
    if (openedValidation.status !== 'PASS') throw new Error(openedValidation.code)
    const targets = await waitForPluginTarget(id, true, this.ports.cdp)
    const target = targets[0]
    const validation = validatePluginTargetOwnership(target, id, this.ports.cdp)
    if (validation.status !== 'PASS') throw new Error(validation.code)
    const page = await CdpClient.connect(target.webSocketDebuggerUrl, this.ports.cdp, '/devtools/page/')
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const commitProof = await enableRendererAfterCommit(page, new RegExp(`^ztools://plugins/${escapedId}/`))
    const identity = await waitForCondition(() => page.evaluate(`(() => ({ ready: document.readyState === 'complete', url: location.href,
      isElectron: window.ztools?.isElectron?.() === true, nodeType: typeof process, requireType: typeof require,
      sdkDbType: typeof window.ztools?.db, title: document.title }))()`),
    value => value?.ready === true && value.isElectron === true && value.url.startsWith(`ztools://plugins/${id}/`),
    30_000, 'PLUGIN_RENDERER_NOT_READY')
    if (identity.nodeType !== 'undefined' || identity.requireType !== 'undefined' || identity.sdkDbType !== 'object') {
      page.dispose()
      throw new Error('PLUGIN_RENDERER_IDENTITY_MISMATCH')
    }
    const entry = { page, targetId: target.id, url: target.url, pluginId: id }
    session.pluginPages.push(entry)
    return { opened, target, page, identity, commitProof }
  }

  async close(session, pluginId) {
    const id = safePluginId(pluginId)
    const result = await invokePublicPluginApi(session.browserPage.page, `window.ztools.plugin.close(${JSON.stringify(id)})`)
    await waitForPluginTarget(id, false, this.ports.cdp)
    for (const entry of session.pluginPages.filter(item => item.pluginId === id)) entry.page.dispose()
    session.pluginPages = session.pluginPages.filter(item => item.pluginId !== id)
    return { result, remainingTargets: 0 }
  }

  async stop(session) {
    if (!session) return { stopped: true, ownedPid: null, exit: null, cleanupConfirmed: true }
    if (session.stopResult) return session.stopResult
    if (session.stopping) return await session.stopping
    session.stopping = (async () => {
      let quitRequested = false
      let quitRequestError = null
      try {
        if (session.inspector) { await session.inspector.evaluate(appQuitExpression(), { timeoutMs: 3000 }); quitRequested = true }
      } catch (error) { quitRequestError = typeof error?.message === 'string' ? error.message : 'APP_QUIT_REQUEST_FAILED' }
      session.browserPage?.page.dispose()
      for (const item of session.pluginPages ?? []) item.page.dispose()
      session.inspector?.dispose()
      let forcedOwnedMainTermination = false
      let processAbsentConfirmed = false
      let ownershipCheck = { status: 'NOT_RUN', reason: 'NORMAL_QUIT_COMPLETED' }
      let exit
      try { exit = await waitForChildClose(session.child, quitRequested ? 30_000 : 5000) }
      catch {
        const snapshot = getProcessIdentity(session.child.pid)
        if (snapshot === null) {
          processAbsentConfirmed = true
          ownershipCheck = { status: 'NOT_RUN', reason: 'PROCESS_ALREADY_ABSENT' }
          exit = await waitForChildClose(session.child, 1000).catch(() => null)
        } else {
          ownershipCheck = verifyOwnedElectronProcess(snapshot, { pid: session.child.pid, executablePath: session.executable,
            launchArguments: session.launchArguments, creationUtc: session.launchIdentity?.creationUtc, parentPid: process.pid })
        }
        if (!processAbsentConfirmed && ownershipCheck.status === 'PASS' && session.child.exitCode === null && session.child.signalCode === null) {
          forcedOwnedMainTermination = true
          session.sigtermRequested = true
          try { session.child.kill('SIGTERM') } catch { /* Actual launch creation time, PID/path/entry/parent matched before this request. */ }
          exit = await waitForChildClose(session.child, 10_000).catch(() => null)
        }
      }
      for (const stream of [session.logs?.stdout, session.logs?.stderr]) stream?.end()
      const descendants = await waitForDescendantCleanup(session.child.pid)
      session.stopResult = { stopped: Boolean(exit) || processAbsentConfirmed, ownedPid: session.child.pid, exit, quitRequested, quitRequestError, processAbsentConfirmed,
        forcedOwnedMainTermination, sigtermRequested: session.sigtermRequested === true, processIdentityCheck: ownershipCheck,
        descendantCleanup: descendants, logPaths: { stdout: session.logs?.stdoutPath ?? null, stderr: session.logs?.stderrPath ?? null },
        cleanupConfirmed: (Boolean(exit) || processAbsentConfirmed) && descendants.status === 'PASS' }
      if (session.processRecord) {
        session.processRecord.status = session.stopResult.cleanupConfirmed ? 'STOPPED' : 'CLEANUP_UNCONFIRMED'
        session.processRecord.cleanup = session.stopResult
      }
      return session.stopResult
    })()
    return await session.stopping
  }
}

export async function startLoopbackZipServer(zipInfo, routeName, runId) {
  if (!zipInfo || typeof zipInfo.path !== 'string' || !zipInfo.path.trim() ||
      !Number.isSafeInteger(zipInfo.fileSize) || zipInfo.fileSize <= 0) {
    throw new Error('ZIP_ARTIFACT_INVALID')
  }
  const safeName = typeof routeName === 'string' && /^[a-z0-9-]{1,64}\.zip$/.test(routeName) ? routeName : null
  if (!safeName) throw new Error('ZIP_ROUTE_NAME_INVALID')
  const route = `/${runId}/${safeName}`
  const requests = []
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== route) {
      requests.push({ method: request.method, route: request.url, status: 404 })
      response.writeHead(404, { 'content-length': '0', 'cache-control': 'no-store' }).end()
      return
    }
    requests.push({ method: request.method, route, status: 200 })
    response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipInfo.fileSize), 'cache-control': 'no-store' })
    fs.createReadStream(zipInfo.path).pipe(response)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('LOOPBACK_SERVER_BIND_FAILED')
  return { server, url: `http://127.0.0.1:${address.port}${route}`, requests, port: address.port }
}

export async function closeLoopbackZipServer(server) {
  if (!server) return
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
