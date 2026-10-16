import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_TIMEOUT_MS = 15_000

function cdpFailureCode(details) {
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
  #closed = false

  static async connect(url, port, expectedPathPrefix, {
    WebSocketClass = globalThis.WebSocket, connectTimeoutMs = 10_000
  } = {}) {
    if (typeof WebSocketClass !== 'function') throw new Error('NODE_GLOBAL_WEBSOCKET_REQUIRED')
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || typeof expectedPathPrefix !== 'string') {
      throw new Error('CDP_CONNECT_ARGUMENTS_INVALID')
    }
    let parsed
    try { parsed = new URL(url) } catch { throw new Error('CDP_TARGET_IDENTITY_MISMATCH') }
    if (parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1' || parsed.port !== String(port) ||
        !parsed.pathname.startsWith(expectedPathPrefix) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('CDP_TARGET_IDENTITY_MISMATCH')
    }
    const socket = new WebSocketClass(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP_CONNECT_TIMEOUT')) }, connectTimeoutMs)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP_CONNECT_FAILED')) }, { once: true })
    })
    return new CdpClient(socket)
  }

  constructor(socket) {
    this.#socket = socket
    socket.addEventListener('message', event => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (typeof message?.method === 'string') {
        for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params)
        return
      }
      const pending = this.#pending.get(message?.id)
      if (!pending) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        const error = new Error(`CDP_METHOD_FAILED_${pending.methodLabel}`)
        error.cdpError = { code: Number.isSafeInteger(message.error.code) ? message.error.code : null,
          message: typeof message.error.message === 'string' ? message.error.message.slice(0, 240) : null }
        pending.reject(error)
      }
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => this.#failClosed('CDP_CLOSED', false))
    socket.addEventListener('error', () => this.#failClosed('CDP_SOCKET_ERROR', true))
  }

  on(method, listener) {
    if (this.#closed || typeof method !== 'string' || typeof listener !== 'function') throw new Error('CDP_LISTENER_INVALID')
    const listeners = this.#listeners.get(method) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(method, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.#listeners.delete(method)
    }
  }

  waitForEvent(method, accept = () => true, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.#closed) return Promise.reject(new Error('CDP_CLOSED'))
    if (typeof method !== 'string' || typeof accept !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new Error('CDP_EVENT_ARGUMENTS_INVALID'))
    }
    let resolveEvent
    let rejectEvent
    let unsubscribe = () => {}
    let timer
    let finished = false
    const cleanup = () => {
      clearTimeout(timer)
      unsubscribe()
      this.#eventWaiters.delete(cancel)
    }
    const cancel = code => {
      if (finished) return
      finished = true
      cleanup()
      rejectEvent(new Error(code))
    }
    const promise = new Promise((resolve, reject) => { resolveEvent = resolve; rejectEvent = reject })
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
    promise.catch(() => {})
    return promise
  }

  call(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.#closed) return Promise.reject(new Error('CDP_CLOSED'))
    if (typeof method !== 'string' || !method || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new Error('CDP_METHOD_ARGUMENTS_INVALID'))
    }
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const methodLabel = method.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`CDP_METHOD_TIMEOUT_${methodLabel}`)) }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer, methodLabel })
      try { this.#socket.send(JSON.stringify({ id, method, params })) }
      catch { clearTimeout(timer); this.#pending.delete(id); reject(new Error('CDP_SEND_FAILED')) }
    })
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    return this.#evaluate('Runtime.evaluate', { expression, awaitPromise, returnByValue: true,
      userGesture: false, timeout: timeoutMs }, timeoutMs)
  }

  async evaluatePausedFrame(callFrameId, expression, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (typeof callFrameId !== 'string' || !callFrameId) throw new Error('CDP_PAUSED_FRAME_ID_MISSING')
    return this.#evaluate('Debugger.evaluateOnCallFrame', { callFrameId, expression, returnByValue: true,
      silent: false, generatePreview: false }, timeoutMs)
  }

  async #evaluate(method, params, timeoutMs) {
    try { new vm.Script(params.expression) }
    catch { throw new Error('CDP_EXPRESSION_SYNTAX_INVALID') }
    const response = await this.call(method, params, timeoutMs + 1000)
    if (response?.exceptionDetails) {
      const error = new Error('CDP_EVALUATION_FAILED')
      error.cdpException = cdpFailureCode(response.exceptionDetails)
      throw error
    }
    if (!response?.result || !Object.hasOwn(response.result, 'value')) throw new Error('CDP_VALUE_UNAVAILABLE')
    return response.result.value
  }

  dispose() {
    this.#failClosed('CDP_CLOSED', true)
  }

  #failClosed(code, closeSocket) {
    if (this.#closed) return
    this.#closed = true
    this.#rejectPending(code)
    for (const cancel of [...this.#eventWaiters]) cancel(code)
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

function pathComparisonValue(value, platform) {
  const api = platform === 'win32' ? path.win32 : path.posix
  const normalized = api.normalize(value)
  return platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function isAbsoluteForPlatform(value, platform) {
  return (platform === 'win32' ? path.win32 : path.posix).isAbsolute(value)
}

function samePath(actual, expected, platform) {
  return typeof actual === 'string' && typeof expected === 'string' &&
    pathComparisonValue(actual, platform) === pathComparisonValue(expected, platform)
}

function insidePath(root, candidate, platform) {
  const api = platform === 'win32' ? path.win32 : path.posix
  const relative = api.relative(api.resolve(root), api.resolve(candidate))
  return relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative)
}

function identityExpression() {
  return `(() => {
    const mainModule = process.mainModule;
    if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE');
    const requireMain = mainModule.require.bind(mainModule);
    const app = requireMain('electron').app;
    return { pid: process.pid, execPath: process.execPath, argv: process.argv, processArch: process.arch,
      electronVersion: process.versions.electron ?? null, mainEntry: mainModule.filename,
      appPath: app.getAppPath(), appName: app.getName(), appVersion: app.getVersion(), isPackaged: app.isPackaged };
  })()`
}

function configurePathsExpression(profile) {
  return `(() => {
    const mainModule = process.mainModule;
    if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE');
    const requireMain = mainModule.require.bind(mainModule);
    const app = requireMain('electron').app;
    app.setPath('appData', ${JSON.stringify(profile.appDataPath)});
    app.setPath('userData', ${JSON.stringify(profile.userDataPath)});
    app.setPath('sessionData', ${JSON.stringify(profile.sessionDataPath)});
    const path = requireMain('node:path');
    return { appDataPath: app.getPath('appData'), userDataPath: app.getPath('userData'),
      sessionDataPath: app.getPath('sessionData'), dataRoot: path.join(app.getPath('appData'), 'ZTools', 'DataV2'),
      pluginRoot: path.join(app.getPath('appData'), 'ZTools', 'DataV2', 'Plugins') };
  })()`
}

function verifyPathsExpression() {
  return `(() => {
    const mainModule = process.mainModule;
    if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE');
    const requireMain = mainModule.require.bind(mainModule);
    const app = requireMain('electron').app;
    const fs = requireMain('node:fs');
    return { appDataPath: app.getPath('appData'), userDataPath: app.getPath('userData'),
      sessionDataPath: app.getPath('sessionData'), appDataRealPath: fs.realpathSync(app.getPath('appData')),
      userDataRealPath: fs.realpathSync(app.getPath('userData')), sessionDataRealPath: fs.realpathSync(app.getPath('sessionData')) };
  })()`
}

export function validatePrebootProfile(profile, outputRoot, { platform = process.platform, fsApi = fs } = {}) {
  const fail = code => ({ status: 'FAIL', code })
  if (!profile || typeof profile !== 'object' || typeof outputRoot !== 'string') return fail('ISOLATED_PROFILE_INVALID')
  const api = platform === 'win32' ? path.win32 : path.posix
  if (!api.isAbsolute(outputRoot) || !api.isAbsolute(profile.root ?? '')) return fail('ISOLATED_PROFILE_PATH_INVALID')
  const root = api.resolve(profile.root)
  const output = api.resolve(outputRoot)
  const relative = api.relative(output, root)
  if (!relative || relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
    return fail('PROFILE_OUTSIDE_RUN_ROOT')
  }
  if (platform !== 'win32' && (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(api.basename(root)))) {
    return fail('PROFILE_UUID_REQUIRED')
  }
  try {
    const outputInfo = fsApi.lstatSync(output)
    if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink() || !samePath(api.resolve(fsApi.realpathSync(output)), output, platform)) {
      return fail('NORMAL_APP_OUTPUT_ROOT_INVALID')
    }
    const rootInfo = fsApi.lstatSync(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(api.resolve(fsApi.realpathSync(root)), root, platform)) {
      return fail('ISOLATED_PROFILE_DIRECTORY_INVALID')
    }
    const expectedPaths = {
      appDataPath: api.join(root, 'appData'),
      userDataPath: platform === 'darwin' ? api.join(root, 'appData', 'ZTools') : api.join(root, 'userData'),
      sessionDataPath: api.join(root, 'sessionData')
    }
    for (const [key, expected] of Object.entries(expectedPaths)) {
      if (!samePath(profile[key], expected, platform)) return fail('ISOLATED_PROFILE_PATH_MISMATCH')
      const info = fsApi.lstatSync(expected)
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(api.resolve(fsApi.realpathSync(expected)), expected, platform)) {
        return fail('ISOLATED_PROFILE_DIRECTORY_INVALID')
      }
    }
  } catch { return fail('ISOLATED_PROFILE_DIRECTORY_INVALID') }
  return { status: 'PASS', profile: { root, appDataPath: profile.appDataPath,
    userDataPath: profile.userDataPath, sessionDataPath: profile.sessionDataPath } }
}

export function validatePrebootPathReadback(paths, profile, { platform = process.platform, requireRealPaths = false } = {}) {
  for (const key of ['appDataPath', 'userDataPath', 'sessionDataPath']) {
    if (!samePath(paths?.[key], profile?.[key], platform)) {
      return { status: 'FAIL', code: requireRealPaths ? 'ISOLATED_PATH_READBACK_FAILED' : 'ISOLATED_PATH_CONFIGURATION_FAILED' }
    }
    if (requireRealPaths) {
      const realPathKey = `${key.replace(/Path$/, '')}RealPath`
      if (!samePath(paths?.[realPathKey], profile?.[key], platform)) return { status: 'FAIL', code: 'ISOLATED_PATH_READBACK_FAILED' }
    }
  }
  return { status: 'PASS' }
}

function validateMainIdentity(snapshot, expected, platform) {
  const fail = code => ({ status: 'FAIL', code })
  if (!snapshot || typeof snapshot !== 'object') return fail('MAIN_IDENTITY_MISSING')
  if (snapshot.pid !== expected.childPid) return fail('MAIN_PID_MISMATCH')
  if (!samePath(snapshot.execPath, expected.executablePath, platform) ||
      !insidePath(expected.appRoot, snapshot.execPath, platform)) return fail('MAIN_EXECUTABLE_MISMATCH')
  if (!samePath(snapshot.appPath, expected.appArchivePath, platform)) return fail('APP_PATH_MISMATCH')
  if (snapshot.appVersion !== expected.appVersion) return fail('APP_VERSION_MISMATCH')
  if (snapshot.electronVersion !== expected.electronVersion) return fail('ELECTRON_VERSION_MISMATCH')
  if (snapshot.processArch !== expected.processArch) return fail('PROCESS_ARCH_MISMATCH')
  if (snapshot.isPackaged !== expected.isPackaged) return fail('PACKAGED_APP_IDENTITY_MISMATCH')
  if (expected.appName && snapshot.appName !== expected.appName) return fail('APP_NAME_MISMATCH')
  return { status: 'PASS', snapshot, bundleId: expected.bundleId ?? null }
}

function validateLauncherIdentity(snapshot, expected, platform) {
  if (!snapshot || typeof snapshot !== 'object') return { status: 'FAIL', code: 'MAIN_IDENTITY_MISSING' }
  const launcherRuntime = validateMainIdentity(snapshot, { ...expected, checkMainEntry: false,
    appArchivePath: snapshot.appPath, appName: snapshot.appName, appVersion: snapshot.appVersion,
    isPackaged: expected.isPackaged }, platform)
  if (launcherRuntime.status !== 'PASS') return launcherRuntime
  const expectedLaunchPath = expected.launcherAppPath ?? expected.appRoot
  const platformPath = platform === 'win32' ? path.win32 : path.posix
  const matchingArguments = Array.isArray(snapshot.argv) ? snapshot.argv.filter(argument =>
    typeof argument === 'string' && isAbsoluteForPlatform(argument, platform) &&
      samePath(platformPath.resolve(argument), expectedLaunchPath, platform)) : []
  if (matchingArguments.length !== 1) return { status: 'FAIL', code: 'LAUNCHER_APP_ARGUMENT_MISMATCH' }
  return { status: 'PASS', snapshot, requestedAppPath: expectedLaunchPath,
    appIdentity: { appArchivePath: expected.appArchivePath, entryPath: expected.entryPath,
      appVersion: expected.appVersion, appName: expected.appName ?? null, source: 'validated-launch-target' } }
}

function pausedFilePath(pause, scriptUrls) {
  const topFrame = pause?.callFrames?.[0]
  if (!topFrame || typeof topFrame.callFrameId !== 'string' || !topFrame.callFrameId) {
    return { status: 'FAIL', code: 'BOOTSTRAP_CALL_FRAME_MISSING' }
  }
  const frameUrl = typeof topFrame.url === 'string' && topFrame.url ? topFrame.url : scriptUrls.get(topFrame.location?.scriptId)
  let pausedPath
  try {
    const sourceUrl = new URL(frameUrl)
    if (sourceUrl.protocol !== 'file:') return { status: 'FAIL', code: 'BOOTSTRAP_FIRST_LINE_NOT_CONFIRMED' }
    pausedPath = fileURLToPath(sourceUrl)
  } catch { return { status: 'FAIL', code: 'BOOTSTRAP_FIRST_LINE_NOT_CONFIRMED' } }
  if (!Number.isSafeInteger(topFrame.location?.lineNumber)) {
    return { status: 'FAIL', code: 'BOOTSTRAP_FIRST_LINE_NOT_CONFIRMED' }
  }
  return { status: 'PASS', callFrameId: topFrame.callFrameId, pausedPath,
    lineNumber: topFrame.location.lineNumber, scriptId: topFrame.location?.scriptId ?? null, frameUrl }
}

function validatePause(pause, entryPath, platform, scriptUrls) {
  const file = pausedFilePath(pause, scriptUrls)
  if (file.status !== 'PASS') return file
  if (!samePath(file.pausedPath, entryPath, platform) || file.lineNumber > 1) {
    return { status: 'FAIL', code: 'BOOTSTRAP_FIRST_LINE_NOT_CONFIRMED' }
  }
  return { status: 'PASS', ...file, pauseReason: pause.reason ?? null,
    pauseHitBreakpoints: Array.isArray(pause.hitBreakpoints) ? pause.hitBreakpoints : [] }
}

async function proveBootstrapPauseSource(client, pauseProof) {
  if (!pauseProof || ![0, 1].includes(pauseProof.lineNumber) || typeof pauseProof.scriptId !== 'string' || !pauseProof.scriptId) {
    throw new Error('BOOTSTRAP_SOURCE_PROOF_UNAVAILABLE')
  }
  const response = await client.call('Debugger.getScriptSource', { scriptId: pauseProof.scriptId })
  const source = response?.scriptSource
  if (typeof source !== 'string' || source.length > 16 * 1024 * 1024) throw new Error('BOOTSTRAP_SOURCE_PROOF_UNAVAILABLE')
  const sourceSha256 = createHash('sha256').update(source, 'utf8').digest('hex')
  if (pauseProof.lineNumber === 1) {
    const firstLine = (source.split(/\r\n|\r|\n/, 1)[0] ?? '').replace(/^\uFEFF/, '')
    if (!/^\s*(?:"use strict"|'use strict');\s*$/.test(firstLine)) throw new Error('BOOTSTRAP_PREFIX_UNSAFE')
  }
  return { requestedLineNumber: 0, actualLineNumber: pauseProof.lineNumber,
    directiveOnlyPrefix: true, prefixKind: pauseProof.lineNumber === 0 ? 'none' : 'use-strict', sourceSha256 }
}

async function fetchInspectorTarget(port, fetchImpl, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastCode = 'MAIN_INSPECTOR_TARGET_MISSING'
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })
      if (!response?.ok) { lastCode = 'MAIN_INSPECTOR_HTTP_FAILED'; continue }
      const targets = await response.json()
      if (!Array.isArray(targets) || targets.length > 64) throw new Error('INVALID_MAIN_INSPECTOR_TARGET_LIST')
      const nodes = targets.filter(target => target?.type === 'node')
      if (nodes.length > 1) throw new Error('AMBIGUOUS_MAIN_INSPECTOR_TARGET')
      if (nodes.length === 1) {
        const target = nodes[0]
        if (typeof target.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(target.id) ||
            typeof target.webSocketDebuggerUrl !== 'string') throw new Error('INVALID_MAIN_INSPECTOR_TARGET')
        const endpoint = new URL(target.webSocketDebuggerUrl)
        if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.port !== String(port) ||
            endpoint.pathname !== `/${target.id}` || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
          throw new Error('INVALID_MAIN_INSPECTOR_ENDPOINT')
        }
        return target
      }
    } catch (error) {
      if (error?.message === 'AMBIGUOUS_MAIN_INSPECTOR_TARGET' || error?.message === 'INVALID_MAIN_INSPECTOR_TARGET' ||
          error?.message === 'INVALID_MAIN_INSPECTOR_ENDPOINT' || error?.message === 'INVALID_MAIN_INSPECTOR_TARGET_LIST') throw error
      lastCode = /^[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'MAIN_INSPECTOR_UNAVAILABLE'
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(lastCode)
}

function assertConfiguredPaths(configuredPaths, profile, platform) {
  const result = validatePrebootPathReadback(configuredPaths, profile, { platform })
  if (result.status !== 'PASS') throw new Error(result.code)
}

function assertVerifiedPaths(verifiedPaths, profile, platform) {
  const result = validatePrebootPathReadback(verifiedPaths, profile, { platform, requireRealPaths: true })
  if (result.status !== 'PASS') throw new Error(result.code)
}

export async function runMainPrebootIsolationGate(config, {
  platform = process.platform, fetchImpl = fetch, connect = (...args) => CdpClient.connect(...args)
} = {}) {
  let client
  let paused = false
  let resumed = false
  try {
    if (!config || !['darwin', 'win32'].includes(platform)) throw new Error('PREBOOT_GATE_PLATFORM_INVALID')
    const expected = { ...config, childPid: config.childPid, platform }
    if (!Number.isSafeInteger(expected.childPid) || expected.childPid <= 0 ||
        !Number.isSafeInteger(expected.inspectPort) || expected.inspectPort < 1024 || expected.inspectPort > 65_535 ||
        typeof expected.electronVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(expected.electronVersion) ||
        typeof expected.executablePath !== 'string' || !isAbsoluteForPlatform(expected.executablePath, platform) ||
        typeof expected.appRoot !== 'string' || !isAbsoluteForPlatform(expected.appRoot, platform) ||
        typeof expected.appArchivePath !== 'string' || !isAbsoluteForPlatform(expected.appArchivePath, platform) ||
        typeof expected.entryPath !== 'string' || !isAbsoluteForPlatform(expected.entryPath, platform) ||
        expected.launcherPath !== undefined && (typeof expected.launcherPath !== 'string' ||
          !isAbsoluteForPlatform(expected.launcherPath, platform) || !insidePath(expected.appRoot, expected.launcherPath, platform)) ||
        expected.launcherAppPath !== undefined && (typeof expected.launcherAppPath !== 'string' ||
          !isAbsoluteForPlatform(expected.launcherAppPath, platform) || !insidePath(expected.appRoot, expected.launcherAppPath, platform)) ||
        typeof expected.appVersion !== 'string' || !expected.appVersion ||
        !['x64', 'arm64', 'ia32'].includes(expected.processArch) ||
        !['darwin', 'win32'].includes(expected.platform) || typeof expected.isPackaged !== 'boolean' ||
        expected.bundleId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(expected.bundleId) ||
        platform === 'darwin' && (!expected.bundleId || expected.isPackaged !== true) ||
        !insidePath(expected.appRoot, expected.executablePath, platform) ||
        !insidePath(expected.appRoot, expected.appArchivePath, platform) ||
        !insidePath(expected.appArchivePath, expected.entryPath, platform)) {
      throw new Error('PREBOOT_GATE_CONFIGURATION_INVALID')
    }
    const profileValidation = validatePrebootProfile(expected.profile, expected.outputRoot, { platform })
    if (profileValidation.status !== 'PASS') throw new Error(profileValidation.code)
    const target = await fetchInspectorTarget(expected.inspectPort, fetchImpl, expected.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    client = await connect(target.webSocketDebuggerUrl, expected.inspectPort, `/${target.id}`)
    const scriptUrls = new Map()
    const pauseDiagnostics = []
    const resolvedBreakpoints = []
    client.on('Debugger.scriptParsed', params => {
      if (typeof params?.scriptId === 'string' && typeof params?.url === 'string') scriptUrls.set(params.scriptId, params.url)
    })
    client.on('Debugger.paused', params => {
      const frame = params?.callFrames?.[0]
      pauseDiagnostics.push({ reason: params?.reason ?? null, url: frame?.url || scriptUrls.get(frame?.location?.scriptId) || null,
        lineNumber: Number.isSafeInteger(frame?.location?.lineNumber) ? frame.location.lineNumber : null,
        hitBreakpoints: Array.isArray(params?.hitBreakpoints) ? params.hitBreakpoints.slice(0, 8) : [] })
      if (pauseDiagnostics.length > 32) pauseDiagnostics.shift()
    })
    client.on('Debugger.breakpointResolved', params => {
      resolvedBreakpoints.push({ breakpointId: params?.breakpointId ?? null, location: params?.location ?? null })
      if (resolvedBreakpoints.length > 32) resolvedBreakpoints.shift()
    })
    const pausedPromise = client.waitForEvent('Debugger.paused', () => true, expected.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    await client.call('Runtime.enable')
    await client.call('Debugger.enable')
    await client.call('Runtime.runIfWaitingForDebugger')
    const pause = await pausedPromise
    paused = true
    let pauseProof = validatePause(pause, expected.entryPath, platform, scriptUrls)
    let entryIdentity
    let launcherIdentity = null
    let configuredPaths
    let verifiedPaths
    let bootstrapSource
    if (pauseProof.status === 'PASS') {
      bootstrapSource = await proveBootstrapPauseSource(client, pauseProof)
      entryIdentity = await client.evaluatePausedFrame(pauseProof.callFrameId, identityExpression())
      const identityProof = validateMainIdentity(entryIdentity, expected, platform)
      if (identityProof.status !== 'PASS') throw new Error(identityProof.code)
      configuredPaths = await client.evaluatePausedFrame(pauseProof.callFrameId, configurePathsExpression(profileValidation.profile))
      assertConfiguredPaths(configuredPaths, profileValidation.profile, platform)
      verifiedPaths = await client.evaluatePausedFrame(pauseProof.callFrameId, verifyPathsExpression())
      assertVerifiedPaths(verifiedPaths, profileValidation.profile, platform)
    } else {
      const launcherProof = expected.launcherPath
        ? validatePause(pause, expected.launcherPath, platform, scriptUrls)
        : { status: 'FAIL', code: pauseProof.code }
      if (launcherProof.status !== 'PASS' || launcherProof.lineNumber !== 0) {
        const frame = pause?.callFrames?.[0]
        const error = new Error(pauseProof.code)
        error.pauseDiagnostic = { reason: pause?.reason ?? null, frameUrl: launcherProof.frameUrl ?? frame?.url ?? null,
          lineNumber: Number.isSafeInteger(frame?.location?.lineNumber) ? frame.location.lineNumber : null,
          scriptId: typeof frame?.location?.scriptId === 'string' ? frame.location.scriptId.slice(0, 128) : null,
          expectedEntry: expected.entryPath, expectedLauncher: expected.launcherPath ?? null }
        throw error
      }
      launcherIdentity = await client.evaluatePausedFrame(launcherProof.callFrameId, identityExpression())
      const launcherIdentityProof = validateLauncherIdentity(launcherIdentity, expected, platform)
      if (launcherIdentityProof.status !== 'PASS') {
        const error = new Error(launcherIdentityProof.code)
        error.identityDiagnostic = launcherIdentity
        throw error
      }
      configuredPaths = await client.evaluatePausedFrame(launcherProof.callFrameId, configurePathsExpression(profileValidation.profile))
      assertConfiguredPaths(configuredPaths, profileValidation.profile, platform)
      verifiedPaths = await client.evaluatePausedFrame(launcherProof.callFrameId, verifyPathsExpression())
      assertVerifiedPaths(verifiedPaths, profileValidation.profile, platform)

      const entryUrl = pathToFileURL(path.resolve(expected.entryPath)).href
      const breakpoint = await client.call('Debugger.setBreakpointByUrl', { lineNumber: 0, url: entryUrl })
      if (typeof breakpoint?.breakpointId !== 'string' || !breakpoint.breakpointId) throw new Error('BOOTSTRAP_BREAKPOINT_NOT_INSTALLED')
      const entryPausePromise = client.waitForEvent('Debugger.paused', candidate => {
        const candidateProof = validatePause(candidate, expected.entryPath, platform, scriptUrls)
        return candidateProof.status === 'PASS' && candidate.hitBreakpoints?.includes(breakpoint.breakpointId) === true
      }, expected.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      await client.call('Debugger.resume')
      paused = false
      let entryPause
      try { entryPause = await entryPausePromise }
      catch (error) {
        error.pauseDiagnostic = { observedPauses: pauseDiagnostics, resolvedBreakpoints,
          parsedEntryScripts: [...scriptUrls.entries()].filter(([, url]) => url.includes(path.basename(expected.entryPath))).slice(-8) }
        error.identityDiagnostic = launcherIdentity
        throw error
      }
      paused = true
      pauseProof = validatePause(entryPause, expected.entryPath, platform, scriptUrls)
      if (pauseProof.status !== 'PASS' || entryPause.hitBreakpoints?.includes(breakpoint.breakpointId) !== true) {
        throw new Error('BOOTSTRAP_FIRST_LINE_NOT_CONFIRMED')
      }
      bootstrapSource = await proveBootstrapPauseSource(client, pauseProof)
      await client.call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId })
      entryIdentity = await client.evaluatePausedFrame(pauseProof.callFrameId, identityExpression())
      const identityProof = validateMainIdentity(entryIdentity, expected, platform)
      if (identityProof.status !== 'PASS') {
        const error = new Error(identityProof.code)
        error.identityDiagnostic = entryIdentity
        throw error
      }
      verifiedPaths = await client.evaluatePausedFrame(pauseProof.callFrameId, verifyPathsExpression())
      assertVerifiedPaths(verifiedPaths, profileValidation.profile, platform)
    }
    await client.call('Debugger.resume')
    resumed = true
    paused = false
    return { status: 'PASS', childPid: expected.childPid, executablePath: entryIdentity.execPath,
      bundleId: expected.bundleId ?? null, entryIdentity, profile: profileValidation.profile,
      launcherIdentity, pause: pauseProof, bootstrapSource, configuredPaths, verifiedPaths, resumed: true, client }
  } catch (error) {
    if (client && !resumed) {
      if (error && typeof error === 'object') {
        error.prebootIsolationClient = client
        error.prebootIsolationPaused = paused
      }
    } else client?.dispose()
    throw error
  }
}
