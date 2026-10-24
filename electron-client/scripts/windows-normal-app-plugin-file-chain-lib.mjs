import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const NORMAL_APP_CDP_PORT = 9336
export const NORMAL_APP_INSPECT_PORT = 9337
export const DIALOG_STUB_KEY = '__ztoolsNormalAppFileChainDialogStub__'

export function normalizeWindowsPath(value) {
  return path.win32.normalize(value).toLocaleLowerCase('en-US')
}

export function isWithin(root, candidate, pathApi = path.win32) {
  const relative = pathApi.relative(pathApi.resolve(root), pathApi.resolve(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative))
}

export function validateMainIdentity(snapshot, expected) {
  const fail = code => ({ status: 'FAIL', code })
  if (!snapshot || typeof snapshot !== 'object') return fail('MAIN_IDENTITY_MISSING')
  if (!Number.isSafeInteger(snapshot.pid) || snapshot.pid !== expected.pid) return fail('MAIN_PID_MISMATCH')
  if (normalizeWindowsPath(snapshot.execPath ?? '') !== normalizeWindowsPath(expected.execPath)) return fail('MAIN_EXECUTABLE_MISMATCH')
  if (snapshot.electronVersion !== expected.electronVersion) return fail('ELECTRON_VERSION_MISMATCH')
  if (snapshot.appName !== expected.appName) return fail('APP_NAME_MISMATCH')
  if (snapshot.appVersion !== expected.appVersion) return fail('APP_VERSION_MISMATCH')
  if (normalizeWindowsPath(snapshot.appPath ?? '') !== normalizeWindowsPath(expected.appPath)) return fail('APP_PATH_MISMATCH')
  for (const key of ['appDataPath', 'userDataPath', 'sessionDataPath']) {
    if (normalizeWindowsPath(snapshot[key] ?? '') !== normalizeWindowsPath(expected[key])) return fail(`${key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`).toUpperCase()}_MISMATCH`)
  }
  const expectedDataRoot = path.win32.join(expected.appDataPath, 'ZTools', 'Data')
  const expectedPluginRoot = path.win32.join(expectedDataRoot, 'Plugins')
  if (normalizeWindowsPath(snapshot.dataRoot ?? '') !== normalizeWindowsPath(expectedDataRoot) ||
      normalizeWindowsPath(snapshot.pluginRoot ?? '') !== normalizeWindowsPath(expectedPluginRoot)) return fail('ISOLATED_DATA_ROOT_MISMATCH')
  if (snapshot.isPackaged !== false) return fail('DEVELOPMENT_APP_EXPECTED')
  return { status: 'PASS', snapshot }
}

export function validateRendererIdentity(snapshot, expected) {
  const fail = code => ({ status: 'FAIL', code })
  if (!snapshot?.isElectron || !/^ztools:\/\/web(?:\/|$)/.test(snapshot.url ?? '')) return fail('WRONG_ZTOOLS_TARGET')
  if (snapshot.targetId !== expected.targetId) return fail('CDP_TARGET_ID_MISMATCH')
  if (snapshot.identity?.contractVersion !== 1 || snapshot.identity?.target?.platform !== 'windows' ||
      snapshot.identity?.target?.runtime !== 'electron' || snapshot.identity?.target?.arch !== 'x64' ||
      snapshot.identity?.process?.arch !== 'x64' || snapshot.identity?.appVersion !== expected.appVersion) return fail('RUNTIME_IDENTITY_MISMATCH')
  if (snapshot.sdkContractVersion !== expected.sdkContractVersion ||
      !new RegExp(`\\bElectron/${expected.electronVersion.replaceAll('.', '\\.')}\\b`).test(snapshot.userAgent ?? '') ||
      snapshot.nodeType !== 'undefined' || snapshot.requireType !== 'undefined') return fail('SDK_ELECTRON_OR_ISOLATION_MISMATCH')
  return { status: 'PASS', snapshot }
}

export function validatePluginTargetOwnership(target, expectedPluginId, expectedPort) {
  if (typeof expectedPluginId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(expectedPluginId)) {
    return { status: 'FAIL', code: 'EXPECTED_PLUGIN_ID_INVALID' }
  }
  const pattern = new RegExp(`^ztools://plugins/${expectedPluginId}(?:/|$)`)
  const result = validateBrowserTarget(target, expectedPort, pattern)
  if (result.status !== 'PASS') return result
  return { ...result, pluginId: expectedPluginId }
}

export function validatePluginOpenResult(result, expectedPluginId) {
  if (typeof expectedPluginId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(expectedPluginId)) {
    return { status: 'FAIL', code: 'EXPECTED_PLUGIN_ID_INVALID' }
  }
  if (!result || typeof result !== 'object' || result.success !== true) return { status: 'FAIL', code: 'PLUGIN_OPEN_FAILED' }
  if (result.pluginId !== expectedPluginId) return { status: 'FAIL', code: 'ACTIVE_PLUGIN_OWNERSHIP_MISMATCH' }
  if (typeof result.instanceId !== 'string' || !result.instanceId) return { status: 'FAIL', code: 'PLUGIN_OPEN_INSTANCE_MISSING' }
  return { status: 'PASS', pluginId: expectedPluginId, instanceId: result.instanceId, result }
}

export function validateBrowserTarget(target, expectedPort, urlPattern) {
  if (!target || target.type !== 'page' || typeof target.id !== 'string' || !target.id ||
      typeof target.url !== 'string' || !urlPattern.test(target.url) ||
      typeof target.webSocketDebuggerUrl !== 'string') return { status: 'FAIL', code: 'WRONG_CDP_TARGET' }
  let socketUrl
  try { socketUrl = new URL(target.webSocketDebuggerUrl) } catch { return { status: 'FAIL', code: 'INVALID_CDP_WEBSOCKET' } }
  if (socketUrl.protocol !== 'ws:' || socketUrl.hostname !== '127.0.0.1' || socketUrl.port !== String(expectedPort) ||
      !socketUrl.pathname.startsWith('/devtools/page/')) return { status: 'FAIL', code: 'INVALID_CDP_WEBSOCKET' }
  return { status: 'PASS', targetId: target.id, url: target.url, webSocketDebuggerUrl: target.webSocketDebuggerUrl }
}

export function makeSyntheticTextFixture() {
  const input = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('第一行\r\n第二行\n第三行\r尾行\n', 'utf8')
  ])
  const expected = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('第一行\n第二行\n第三行\n尾行\n', 'utf8')
  ])
  return { input, expected, outputFileName: 'notes.converted.txt' }
}

export function consumeDialogPlan(plan, priorCalls, properties, owner) {
  if (!Array.isArray(plan) || !Array.isArray(priorCalls) || !Array.isArray(properties) || !owner || typeof owner !== 'object') {
    throw new Error('DIALOG_PLAN_INVALID')
  }
  const expected = plan[priorCalls.length]
  if (!expected) throw new Error('DIALOG_CALL_BUDGET_EXCEEDED')
  const webContents = owner.webContents
  let ownerMatches = false
  try {
    ownerMatches = owner.isDestroyed?.() === false && webContents?.isDestroyed?.() === false &&
      webContents.id === expected.ownerWebContentsId && webContents.getURL() === expected.pluginUrl
  } catch { ownerMatches = false }
  if (!ownerMatches) throw new Error('DIALOG_OWNER_MISMATCH')
  const expectedProperties = expected.properties
  if (!Array.isArray(expectedProperties) || properties.length !== expectedProperties.length ||
      expectedProperties.some((property, index) => property !== properties[index])) {
    throw new Error('DIALOG_PROPERTIES_MISMATCH')
  }
  const actualKind = properties.includes('openDirectory') ? 'directory' : properties.includes('openFile') ? 'file' : 'unknown'
  if (actualKind !== expected.kind) throw new Error('DIALOG_CALL_SEQUENCE_MISMATCH')
  return { kind: actualKind, filePath: expected.filePath, complete: priorCalls.length + 1 === plan.length }
}

function mainRequireExpression(body) {
  return `(() => { const mainModule = process.mainModule; if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE'); const requireMain = mainModule.require.bind(mainModule); ${body} })()`
}

export function buildDialogOverrideExpression(inputPath, outputPath, ownerWebContentsId, pluginUrl) {
  if (!path.win32.isAbsolute(inputPath) || !path.win32.isAbsolute(outputPath)) throw new Error('DIALOG_PATHS_MUST_BE_ABSOLUTE')
  if (!Number.isSafeInteger(ownerWebContentsId) || ownerWebContentsId <= 0 ||
      typeof pluginUrl !== 'string' || !/^ztools:\/\/plugins\/batch-text-convert\/(?:[^\s]*)$/.test(pluginUrl)) {
    throw new Error('DIALOG_PLUGIN_OWNER_INVALID')
  }
  const plan = [
    { kind: 'file', filePath: inputPath, properties: ['openFile', 'multiSelections'],
      ownerWebContentsId, pluginUrl },
    { kind: 'directory', filePath: outputPath, properties: ['openDirectory', 'createDirectory'],
      ownerWebContentsId, pluginUrl }
  ]
  const consume = consumeDialogPlan.toString()
  const key = JSON.stringify(DIALOG_STUB_KEY)
  return mainRequireExpression(`
    const key = Symbol.for(${key});
    if (globalThis[key]) throw new Error('DIALOG_STUB_ALREADY_INSTALLED');
    const dialog = requireMain('electron').dialog;
    const original = dialog.showOpenDialog;
    if (typeof original !== 'function') throw new Error('DIALOG_METHOD_UNAVAILABLE');
    const state = { original, calls: [], restored: false };
    const restore = () => {
      if (dialog.showOpenDialog === wrapped) dialog.showOpenDialog = original;
      state.restored = dialog.showOpenDialog === original;
      return state.restored;
    };
    const consume = ${consume};
    const wrapped = async function (...args) {
      try {
        if (args.length !== 2 || !args[1] || typeof args[1] !== 'object') throw new Error('DIALOG_ARGUMENT_SHAPE_MISMATCH');
        const options = args.at(-1) ?? {};
        const decision = consume(${JSON.stringify(plan)}, state.calls, options.properties ?? [], args[0]);
        state.calls.push(decision.kind);
        if (decision.complete) restore();
        return { canceled: false, filePaths: [decision.filePath] };
      } catch (error) {
        restore();
        throw error;
      }
    };
    globalThis[key] = { state, restore };
    dialog.showOpenDialog = wrapped;
    if (dialog.showOpenDialog !== wrapped) { delete globalThis[key]; throw new Error('DIALOG_METHOD_NOT_REPLACEABLE'); }
    return { installed: true, maxCalls: ${plan.length} };
  `)
}

export function buildDialogStateExpression() {
  const key = JSON.stringify(DIALOG_STUB_KEY)
  return mainRequireExpression(`const entry = globalThis[Symbol.for(${key})]; if (!entry) return { present: false }; const dialog = requireMain('electron').dialog; return { present: true, calls: [...entry.state.calls], restored: entry.state.restored, exactOriginalRestored: dialog.showOpenDialog === entry.state.original };`)
}

export function buildDialogRestoreExpression() {
  const key = JSON.stringify(DIALOG_STUB_KEY)
  return mainRequireExpression(`const symbol = Symbol.for(${key}); const entry = globalThis[symbol]; if (!entry) return { present: false, restored: true }; const restored = entry.restore(); const calls = [...entry.state.calls]; delete globalThis[symbol]; return { present: true, restored, calls };`)
}

export function validateFreshPluginZip(zipPath, createPluginRoot, expectedPluginId = 'batch-text-convert') {
  if (!path.win32.isAbsolute(zipPath)) throw new Error('ZIP_PATH_MUST_BE_ABSOLUTE')
  if (typeof expectedPluginId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(expectedPluginId)) {
    throw new Error('EXPECTED_PLUGIN_ID_INVALID')
  }
  const resolved = path.win32.resolve(zipPath)
  const root = path.win32.resolve(createPluginRoot)
  const runRoot = path.win32.resolve(root, '.build-runs')
  const relative = path.win32.relative(runRoot, resolved)
  if (relative === '..' || relative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(relative) ||
      !relative.includes(`${path.win32.sep}zips${path.win32.sep}`) ||
      !new RegExp(`^${expectedPluginId}-[0-9A-Za-z.+-]+-windows-electron-x64\\.zip$`, 'i').test(path.win32.basename(resolved))) {
    throw new Error('ZIP_OUTSIDE_FRESH_SINGLE_PLUGIN_RUN')
  }
  const stat = fs.lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 100 * 1024 * 1024) throw new Error('ZIP_INVALID')
  const runRootStat = fs.lstatSync(runRoot)
  if (!runRootStat.isDirectory() || runRootStat.isSymbolicLink()) throw new Error('PLUGIN_BUILD_RUN_ROOT_INVALID')
  const realRoot = fs.realpathSync.native(runRoot)
  if (normalizeWindowsPath(realRoot) !== normalizeWindowsPath(runRoot)) throw new Error('PLUGIN_BUILD_RUN_ROOT_SYMLINK')
  const realPath = fs.realpathSync.native(resolved)
  const realRelative = path.win32.relative(realRoot, realPath)
  if (realRelative === '..' || realRelative.startsWith(`..${path.win32.sep}`) || path.win32.isAbsolute(realRelative)) throw new Error('ZIP_REALPATH_OUTSIDE_FRESH_RUN')
  let cursor = realRoot
  for (const segment of realRelative.split(path.win32.sep)) {
    cursor = path.win32.join(cursor, segment)
    const component = fs.lstatSync(cursor)
    if (component.isSymbolicLink()) throw new Error('ZIP_PATH_CONTAINS_SYMLINK')
  }
  const checksum = createHash('sha256').update(fs.readFileSync(realPath)).digest('hex')
  return { path: realPath, fileSize: stat.size, checksum, buildRun: realRelative.split(path.win32.sep)[0] ?? '' }
}

export function toBootstrapUrl(bootstrapPath) {
  return pathToFileURL(path.resolve(bootstrapPath)).href
}

export function requireIsolatedPath(actual, expected, label) {
  if (!path.win32.isAbsolute(actual) || normalizeWindowsPath(actual) !== normalizeWindowsPath(expected)) {
    throw new Error(`${label}_ISOLATION_MISMATCH`)
  }
  return actual
}

export function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
