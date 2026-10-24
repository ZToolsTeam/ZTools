import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'
import { CdpClient, NORMAL_APP_CDP_PORT, NORMAL_APP_INSPECT_PORT, WindowsNormalAppHarness } from './lib/windows-normal-app-harness.mjs'
import { digest } from './windows-normal-app-plugin-file-chain-lib.mjs'
import { createSuperPanelHotkeyConfig, electronAcceleratorForProbe, mainShortcutRegistrationProbe } from './test-windows-normal-app-super-panel-hotkey.mjs'

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runnerPath = fileURLToPath(import.meta.url)
const MAIN_HOOK_SYMBOL = 'ztools.test.f09.localapp-hotkey.v1'
const DIALOG_HOOK_SYMBOL = 'ztools.test.f09.localapp-dialog.v1'
const PANEL_URL = 'ztools://web/super-panel/index.html'
const PANEL_SHORTCUT = Object.freeze({ modifiers: Object.freeze(['Ctrl', 'Alt', 'Shift']), key: 'F23' })
const LOCAL_APP_SHORTCUT = Object.freeze({ modifiers: Object.freeze(['Ctrl', 'Alt', 'Shift']), key: 'F24' })
const DEFAULT_CMAKE = 'D:\\Program Files\\CMake\\bin\\cmake.exe'
const PROBE_TARGET = 'ZToolsLocalAppHotkeyProbe'
const PROBE_EXE_NAME = `${PROBE_TARGET}.exe`

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function errorCode(error) {
  const value = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : ''
  return /^[A-Z0-9_]{1,96}$/.test(value) ? value : 'NORMAL_APP_LOCALAPP_HOTKEY_UNCLASSIFIED_FAILURE'
}
function ensureRegularFile(file, code) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code)
}
function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}
function requireWithin(root, candidate, code) {
  if (!isWithin(root, candidate)) throw new Error(code)
  return path.resolve(candidate)
}
function expectedWindowsBootstrapSha(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('EXPECTED_BOOTSTRAP_SHA256_REQUIRED')
  return value.toLowerCase()
}

export function windowsLocalAppId(executablePath) {
  if (typeof executablePath !== 'string' || !path.win32.isAbsolute(executablePath) || executablePath.includes('\0')) {
    throw new Error('LOCAL_APP_EXE_PATH_INVALID')
  }
  const source = `${executablePath.trim().replaceAll('/', '\\').toLowerCase()}|`
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `localapp:${hash.toString(16).toUpperCase().padStart(8, '0')}`
}

export function mainHookNodeOptionsValue(hookPath) {
  if (typeof hookPath !== 'string' || !path.win32.isAbsolute(hookPath) || /[\0\r\n"]/.test(hookPath)) {
    throw new Error('MAIN_HOOK_PATH_INVALID')
  }
  return `--require "${hookPath.replaceAll(String.fromCharCode(92), '/')}"`
}

export function createLocalAppHotkeyTrigger(options) {
  if (!isRecord(options) || Object.keys(options).some(key => !['appId', 'triggerId', 'accelerator'].includes(key))) {
    throw new Error('LOCAL_APP_TRIGGER_OPTIONS_INVALID')
  }
  const { appId, triggerId, accelerator } = options
  if (typeof appId !== 'string' || !/^localapp:[A-F0-9]{8}$/i.test(appId)) throw new Error('LOCAL_APP_ID_INVALID')
  if (typeof triggerId !== 'string' || !/^f09-localapp-[a-f0-9-]{36}$/.test(triggerId)) throw new Error('TRIGGER_ID_INVALID')
  if (typeof accelerator !== 'string' || accelerator !== 'Ctrl+Alt+Shift+F24') throw new Error('TRIGGER_ACCELERATOR_INVALID')
  return {
    id: triggerId, pluginId: appId, type: 'hotkey', enabled: true, config: { key: accelerator },
    action: { mode: 'builtin', target: 'launch_local_app', params: { appId } }
  }
}

const MAIN_HOOK_SOURCE = String.raw`'use strict'
const Module = require('node:module')
const symbol = Symbol.for('ztools.test.f09.localapp-hotkey.v1')
if (!globalThis[symbol]) {
  const allowed = new Set(JSON.parse(process.env.ZTOOLS_F09_ALLOWED_ACCELERATORS || '[]').map(value => String(value).toLowerCase()))
  const token = process.env.ZTOOLS_F09_HOTKEY_TOKEN || ''
  const state = {
    version: 1, pid: process.pid, installed: false, installError: null, callbacks: new Map(), fires: [],
    snapshot() { return { version: this.version, pid: this.pid, installed: this.installed, installError: this.installError,
      accelerators: [...this.callbacks.keys()], fireCount: this.fires.length } },
    fire(accelerator, suppliedToken) {
      if (!token || suppliedToken !== token) return { fired: false, reason: 'INVALID_TEST_TOKEN' }
      const key = String(accelerator).toLowerCase()
      if (!allowed.has(key)) return { fired: false, reason: 'ACCELERATOR_NOT_ALLOWED' }
      const callback = this.callbacks.get(key)
      if (typeof callback !== 'function') return { fired: false, reason: 'CALLBACK_NOT_REGISTERED' }
      try { callback(); this.fires.push(key); return { fired: true, accelerator: key, processId: this.pid } }
      catch { return { fired: false, reason: 'CALLBACK_FAILED' } }
    }
  }
  Object.defineProperty(globalThis, symbol, { value: state, configurable: false, enumerable: false, writable: false })
  const originalLoad = Module._load
  let patchedElectron = null
  let electronFacade = null
  function install(electron) {
    if (patchedElectron === electron && electronFacade) return electronFacade
    patchedElectron = electron
    try {
      const shortcuts = electron?.globalShortcut
      const originalRegister = shortcuts?.register
      const originalUnregister = shortcuts?.unregister
      if (process.type !== 'browser' || typeof originalRegister !== 'function' || typeof originalUnregister !== 'function') {
        throw new Error('MAIN_GLOBAL_SHORTCUT_API_UNAVAILABLE')
      }
      const wrappedRegister = function (accelerator, callback) {
        const key = String(accelerator).toLowerCase()
        state.callbacks.delete(key)
        const registered = originalRegister.call(shortcuts, accelerator, callback)
        if (registered === true && allowed.has(key) && typeof callback === 'function') state.callbacks.set(key, callback)
        return registered
      }
      const wrappedUnregister = function (accelerator) {
        const key = String(accelerator).toLowerCase()
        try { return originalUnregister.call(shortcuts, accelerator) }
        finally { state.callbacks.delete(key) }
      }
      const wrappedShortcuts = new Proxy(shortcuts, { get(target, property) {
        if (property === 'register') return wrappedRegister
        if (property === 'unregister') return wrappedUnregister
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      } })
      electronFacade = new Proxy(electron, { get(target, property) {
        if (property === 'globalShortcut') return wrappedShortcuts
        return Reflect.get(target, property, target)
      } })
      state.installed = true
      return electronFacade
    } catch (error) { state.installError = String(error?.message || 'MAIN_GLOBAL_SHORTCUT_HOOK_INSTALL_FAILED') }
  }
  Module._load = function (request, parent, isMain) {
    const result = originalLoad.call(this, request, parent, isMain)
    if (request === 'electron' && process.type === 'browser') return install(result) || result
    return result
  }
}`

export function buildMainHotkeyHookSnapshotExpression() {
  return `(() => { const state = globalThis[Symbol.for(${JSON.stringify(MAIN_HOOK_SYMBOL)})]; return state?.snapshot?.() ?? null; })()`
}

export function buildMainHotkeyHookFireExpression(accelerator, token) {
  if (typeof accelerator !== 'string' || !/^CommandOrControl\+Alt\+Shift\+F(?:23|24)$/i.test(accelerator)) {
    throw new Error('TEST_ACCELERATOR_INVALID')
  }
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('TEST_TOKEN_INVALID')
  return `(() => { const state = globalThis[Symbol.for(${JSON.stringify(MAIN_HOOK_SYMBOL)})]; if (!state?.fire) return { fired: false, reason: 'HOOK_UNAVAILABLE' }; return state.fire(${JSON.stringify(accelerator)}, ${JSON.stringify(token)}); })()`
}

function mainRequire(body) {
  return `(() => { const mainModule = process.mainModule; if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE'); const requireMain = mainModule.require.bind(mainModule); ${body} })()`
}

export function buildLocalAppDialogOverrideExpression(selectedPath, webContentsId) {
  if (!path.win32.isAbsolute(selectedPath) || selectedPath.includes('\0')) throw new Error('DIALOG_APP_PATH_INVALID')
  if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) throw new Error('DIALOG_PANEL_OWNER_INVALID')
  const symbol = JSON.stringify(DIALOG_HOOK_SYMBOL)
  const fixedPath = JSON.stringify(path.win32.normalize(selectedPath))
  const expectedUrl = JSON.stringify(PANEL_URL)
  return mainRequire(`
    const electron = requireMain('electron');
    const dialog = electron.dialog;
    const original = dialog.showOpenDialog;
    if (typeof original !== 'function') throw new Error('DIALOG_METHOD_UNAVAILABLE');
    const key = Symbol.for(${symbol});
    if (globalThis[key]) throw new Error('DIALOG_SUBSTITUTE_ALREADY_PRESENT');
    const state = { calls: 0, restored: false, original, wrapped: null,
      restore() { if (dialog.showOpenDialog === this.wrapped) dialog.showOpenDialog = original;
        this.restored = dialog.showOpenDialog === original; return this.restored; } };
    const wrapped = async function(owner, options) {
      try {
        const contents = owner?.webContents;
        if (!owner || owner.isDestroyed?.() === true || !contents || contents.isDestroyed?.() === true ||
            contents.id !== ${webContentsId} || contents.getURL?.() !== ${expectedUrl}) {
          throw new Error('DIALOG_PANEL_OWNER_MISMATCH');
        }
        const properties = options?.properties;
        if (options?.title !== '添加本地软件' || !Array.isArray(properties) || properties.length !== 2 ||
            properties[0] !== 'openFile' || properties[1] !== 'multiSelections') {
          throw new Error('DIALOG_CALL_SHAPE_MISMATCH');
        }
        const filters = options?.filters;
        if (!Array.isArray(filters) || filters.length !== 1 || filters[0]?.name !== 'Windows 程序' ||
            !Array.isArray(filters[0]?.extensions) || filters[0].extensions.length !== 1 || filters[0].extensions[0] !== 'exe') {
          throw new Error('DIALOG_FILTER_MISMATCH');
        }
        state.calls += 1;
        if (!state.restore()) throw new Error('DIALOG_METHOD_RESTORE_FAILED');
        return { canceled: false, filePaths: [${fixedPath}] };
      } catch (error) { state.restore(); throw error; }
    };
    state.wrapped = wrapped;
    Object.defineProperty(globalThis, key, { value: state, configurable: true, enumerable: false, writable: false });
    dialog.showOpenDialog = wrapped;
    if (dialog.showOpenDialog !== wrapped) { delete globalThis[key]; throw new Error('DIALOG_METHOD_NOT_PATCHABLE'); }
    return { installed: true, expectedOwnerWebContentsId: ${webContentsId}, expectedUrl: ${expectedUrl}, oneShot: true };
  `)
}

export function buildLocalAppDialogStateExpression() {
  const symbol = JSON.stringify(DIALOG_HOOK_SYMBOL)
  return mainRequire(`const state = globalThis[Symbol.for(${symbol})]; if (!state) return { present: false, restored: true, calls: 0 }; const dialog = requireMain('electron').dialog; return { present: true, calls: state.calls, restored: state.restored, exactOriginalRestored: dialog.showOpenDialog === state.original };`)
}

export function buildLocalAppDialogRestoreExpression() {
  const symbol = JSON.stringify(DIALOG_HOOK_SYMBOL)
  return mainRequire(`const key = Symbol.for(${symbol}); const state = globalThis[key]; if (!state) return { present: false, restored: true }; const restored = state.restore(); const result = { present: true, calls: state.calls, restored }; delete globalThis[key]; return result;`)
}

export function buildProbeCmakeLists() {
  return `cmake_minimum_required(VERSION 3.20)\nproject(ZToolsNormalAppLocalAppHotkeyProbe LANGUAGES CXX)\nadd_executable(${PROBE_TARGET} WIN32 local-app-probe.cpp)\ntarget_compile_features(${PROBE_TARGET} PRIVATE cxx_std_17)\nset_target_properties(${PROBE_TARGET} PROPERTIES RUNTIME_OUTPUT_DIRECTORY_RELEASE "\${CMAKE_BINARY_DIR}/probe/Release")\n`
}

export function buildProbeExecutableSource() {
  return String.raw`#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <string>

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  wchar_t modulePath[32768] = {};
  const DWORD capacity = static_cast<DWORD>(sizeof(modulePath) / sizeof(modulePath[0]));
  const DWORD length = GetModuleFileNameW(nullptr, modulePath, capacity);
  if (length == 0 || length >= capacity) return 10;
  const std::wstring executable(modulePath, length);
  const size_t separator = executable.find_last_of(L"\\/");
  if (separator == std::wstring::npos) return 11;
  const std::wstring markerPath = executable.substr(0, separator + 1) + L"launches.tsv";
  HANDLE marker = CreateFileW(markerPath.c_str(), FILE_APPEND_DATA,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (marker == INVALID_HANDLE_VALUE) return 12;
  const std::wstring record = std::to_wstring(GetCurrentProcessId()) + L"\t" + executable +
    L"\t" + std::to_wstring(GetTickCount64()) + L"\r\n";
  const int byteCount = WideCharToMultiByte(CP_UTF8, 0, record.data(), static_cast<int>(record.size()),
    nullptr, 0, nullptr, nullptr);
  if (byteCount <= 0) { CloseHandle(marker); return 13; }
  std::string utf8(static_cast<size_t>(byteCount), '\0');
  if (WideCharToMultiByte(CP_UTF8, 0, record.data(), static_cast<int>(record.size()),
    utf8.data(), byteCount, nullptr, nullptr) != byteCount) { CloseHandle(marker); return 14; }
  DWORD written = 0;
  const BOOL writeOk = WriteFile(marker, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
  if (!writeOk || written != utf8.size() || !FlushFileBuffers(marker)) { CloseHandle(marker); return 15; }
  CloseHandle(marker);
  Sleep(2500);
  return 0;
}`
}

export function buildMainHotkeyHookSource() { return MAIN_HOOK_SOURCE }

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

function runTool(executable, args, code, { timeout = 180_000, cwd = clientRoot } = {}) {
  const result = spawnSync(executable, args, { cwd, shell: false, windowsHide: true, encoding: 'utf8', timeout,
    maxBuffer: 4 * 1024 * 1024 })
  if (result.error || result.status !== 0) {
    const error = new Error(code)
    error.code = code
    error.diagnostic = { executable, args, status: result.status, signal: result.signal,
      errorCode: result.error?.code, stdout: typeof result.stdout === 'string' ? result.stdout.slice(-4000) : '',
      stderr: typeof result.stderr === 'string' ? result.stderr.slice(-4000) : '' }
    throw error
  }
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function resolveCmake(value) {
  const candidate = value ?? DEFAULT_CMAKE
  if (!path.win32.isAbsolute(candidate)) throw new Error('CMAKE_ABSOLUTE_PATH_REQUIRED')
  ensureRegularFile(candidate, 'CMAKE_EXECUTABLE_INVALID')
  return path.resolve(candidate)
}

function buildProbeExecutable(output, cmakePath) {
  const sourceRoot = path.join(output, 'probe-source')
  const buildRoot = path.join(output, 'probe-build')
  fs.mkdirSync(sourceRoot, { recursive: false })
  fs.writeFileSync(path.join(sourceRoot, 'CMakeLists.txt'), buildProbeCmakeLists(), { encoding: 'utf8', flag: 'wx' })
  fs.writeFileSync(path.join(sourceRoot, 'local-app-probe.cpp'), buildProbeExecutableSource(), { encoding: 'utf8', flag: 'wx' })
  const version = runTool(cmakePath, ['--version'], 'CMAKE_VERSION_FAILED', { timeout: 15_000 })
  const configured = runTool(cmakePath, ['-S', sourceRoot, '-B', buildRoot, '-G', 'Visual Studio 17 2022', '-A', 'x64'],
    'PROBE_CMAKE_CONFIGURE_FAILED', { timeout: 120_000 })
  const built = runTool(cmakePath, ['--build', buildRoot, '--config', 'Release', '--target', PROBE_TARGET],
    'PROBE_CMAKE_BUILD_FAILED', { timeout: 240_000 })
  const executable = path.join(buildRoot, 'probe', 'Release', PROBE_EXE_NAME)
  ensureRegularFile(executable, 'PROBE_EXECUTABLE_NOT_BUILT')
  assertPeMachine(executable, PE_MACHINE_X64, '本次生成的短生命周期 EXE')
  return { executable, sha256: digest(fs.readFileSync(executable)), cmakePath,
    cmakeVersion: version.stdout.trim().split(/\r?\n/)[0] ?? '',
    configureOutput: configured.stdout.trim().slice(-1200), buildOutput: built.stdout.trim().slice(-2000) }
}

function seedProfile(profile, output) {
  const dataRoot = requireWithin(output, path.join(profile.appDataPath, 'ZTools', 'Data'), 'PROFILE_DATA_NOT_ISOLATED')
  fs.mkdirSync(dataRoot, { recursive: true })
  const settingsPath = requireWithin(output, path.join(dataRoot, 'user_settings.json'), 'PROFILE_SETTINGS_NOT_ISOLATED')
  const settings = { super_panel: {
    enabled: true,
    keyboardHotkey: { enabled: false, modifiers: [], key: '' },
    mouseHotkey: { enabled: false, button: 'middle_long', longPressMs: 300 }
  } }
  fs.writeFileSync(settingsPath, `\uFEFF${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return { dataRoot, settingsPath }
}

function parseJsonFile(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) }
function writeJsonFile(file, value) { fs.writeFileSync(file, `\uFEFF${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' }) }

function appLocalRecord(dataRoot, appId) {
  const file = requireWithin(dataRoot, path.join(dataRoot, 'local_apps.json'), 'LOCAL_APP_STORE_NOT_ISOLATED')
  const document = parseJsonFile(file)
  const apps = Array.isArray(document.apps) ? document.apps : []
  const app = apps.find(item => isRecord(item) && item.id === appId)
  if (!app) throw new Error('LOCAL_APP_NOT_PERSISTED')
  return { file, document, app }
}

function triggerRecord(dataRoot, triggerId) {
  const file = requireWithin(dataRoot, path.join(dataRoot, 'triggers.json'), 'TRIGGER_STORE_NOT_ISOLATED')
  const document = parseJsonFile(file)
  const triggers = Array.isArray(document.triggers) ? document.triggers : []
  return { file, document, trigger: triggers.find(item => isRecord(item) && item.id === triggerId) }
}

function parseLaunchMarker(markerPath) {
  if (!fs.existsSync(markerPath)) return []
  return fs.readFileSync(markerPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    const [pidText, executablePath, tickText, ...extra] = line.split('\t')
    const pid = Number(pidText)
    const tick = Number(tickText)
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(tick) || extra.length !== 0 || !executablePath) {
      throw new Error('PROBE_LAUNCH_MARKER_INVALID')
    }
    return { pid, executablePath, tick }
  })
}

function queryProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('PROBE_PID_INVALID')
  const command = `$target = ${pid}; $row = Get-CimInstance Win32_Process -Filter "ProcessId=$target" | Select-Object -First 1; if ($null -eq $row) { '[]' } else { ConvertTo-Json -InputObject @(@{ pid=[int]$row.ProcessId; executablePath=$row.ExecutablePath; commandLine=$row.CommandLine }) -Compress }`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024
  })
  if (result.error || result.status !== 0) throw new Error('PROBE_PROCESS_IDENTITY_QUERY_FAILED')
  const parsed = JSON.parse(result.stdout.trim() || '[]')
  return Array.isArray(parsed) ? parsed[0] ?? null : parsed
}

async function delay(ms) { await new Promise(resolve => setTimeout(resolve, ms)) }
async function waitFor(read, accept, code, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await read()
    if (accept(latest)) return latest
    await delay(100)
  }
  const error = new Error(code)
  error.code = code
  error.diagnostic = latest
  throw error
}

async function observeProbeLaunch(markerPath, previousCount, expectedPath, expectedUseCount, appRecordFile, appId) {
  const records = await waitFor(() => parseLaunchMarker(markerPath), value => value.length === previousCount + 1,
    'PROBE_LAUNCH_NOT_OBSERVED')
  const current = records.at(-1)
  if (!current || path.win32.normalize(current.executablePath).toLowerCase() !== path.win32.normalize(expectedPath).toLowerCase()) {
    throw new Error('PROBE_MARKER_EXECUTABLE_PATH_MISMATCH')
  }
  const process = await waitFor(async () => queryProcessIdentity(current.pid),
    identity => identity === null || typeof identity?.executablePath === 'string', 'PROBE_PROCESS_IDENTITY_UNAVAILABLE', 3000)
  if (!process || Number(process.pid) !== current.pid ||
      path.win32.normalize(process.executablePath).toLowerCase() !== path.win32.normalize(expectedPath).toLowerCase()) {
    throw new Error('PROBE_PROCESS_NOT_OWNED_BY_THIS_RUN')
  }
  await waitFor(async () => queryProcessIdentity(current.pid), identity => identity === null,
    'PROBE_PROCESS_DID_NOT_EXIT_NATURALLY', 10_000)
  const document = parseJsonFile(appRecordFile)
  const app = Array.isArray(document.apps) ? document.apps.find(item => isRecord(item) && item.id === appId) : undefined
  if (!app || app.useCount !== expectedUseCount) throw new Error('LOCAL_APP_USAGE_COUNT_MISMATCH')
  return { marker: current, processIdentityMatched: true, exitedNaturally: true, useCount: app.useCount }
}

async function confirmProbeProcessCleanup(markerPath, expectedPath) {
  const records = parseLaunchMarker(markerPath)
  const outcomes = []
  for (const record of records) {
    if (path.win32.normalize(record.executablePath).toLowerCase() !== path.win32.normalize(expectedPath).toLowerCase()) {
      return { status: 'FAIL', reason: 'MARKER_PATH_MISMATCH', records: outcomes }
    }
    const current = await queryProcessIdentity(record.pid)
    if (!current) {
      outcomes.push({ pid: record.pid, status: 'ALREADY_EXITED' })
      continue
    }
    if (Number(current.pid) !== record.pid ||
        path.win32.normalize(current.executablePath).toLowerCase() !== path.win32.normalize(expectedPath).toLowerCase()) {
      return { status: 'FAIL', reason: 'PID_NO_LONGER_IDENTIFIES_OWNED_PROBE', records: outcomes }
    }
    await waitFor(async () => queryProcessIdentity(record.pid), value => value === null,
      'OWNED_PROBE_DID_NOT_EXIT_NATURALLY', 10_000)
    outcomes.push({ pid: record.pid, status: 'EXITED_NATURALLY' })
  }
  return { status: 'PASS', records: outcomes, processTerminationRequested: false }
}

function queryMainRegistrationExpression(accelerator) {
  return mainShortcutRegistrationProbe(accelerator)
}

function configureTestPreload(hookPath, token, accelerators) {
  ensureRegularFile(hookPath, 'MAIN_HOOK_PATH_INVALID')
  process.env.NODE_OPTIONS = mainHookNodeOptionsValue(hookPath)
  process.env.ZTOOLS_F09_HOTKEY_TOKEN = token
  process.env.ZTOOLS_F09_ALLOWED_ACCELERATORS = JSON.stringify(accelerators.map(value => value.toLowerCase()))
}

function saveEnvironment(keys) {
  return new Map(keys.map(key => [key, Object.hasOwn(process.env, key) ? process.env[key] : undefined]))
}

function restoreEnvironment(saved) {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function mainPanelWindowsExpression() {
  return mainRequire(`const electron = requireMain('electron'); return electron.BrowserWindow.getAllWindows().map(window => ({
    id: window.webContents.id, url: window.webContents.getURL(), destroyed: window.isDestroyed(), visible: window.isVisible()
  }));`)
}

async function hookSnapshot(session) {
  return await session.inspector.evaluate(buildMainHotkeyHookSnapshotExpression())
}

async function queryRegistration(session, accelerator) {
  const result = await session.inspector.evaluate(queryMainRegistrationExpression(accelerator))
  if (result?.pid !== session.child.pid || typeof result?.registered !== 'boolean') throw new Error('MAIN_SHORTCUT_PROBE_IDENTITY_MISMATCH')
  return { pid: result.pid, appPath: result.appPath, accelerator, registered: result.registered }
}

async function waitForRegistration(session, accelerator, expected, phase) {
  return await waitFor(() => queryRegistration(session, accelerator), value => value.registered === expected,
    `GLOBAL_SHORTCUT_${phase}_STATE_MISMATCH`)
}

async function connectPanelPage(session) {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${NORMAL_APP_CDP_PORT}/json/list`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return null
    const targets = await response.json()
    return Array.isArray(targets) ? targets.find(item => item.type === 'page' && item.url === PANEL_URL) ?? null : null
  }, value => Boolean(value?.webSocketDebuggerUrl), 'SUPER_PANEL_CDP_TARGET_NOT_FOUND')
  const windowSnapshot = await waitFor(async () => {
    const windows = await session.inspector.evaluate(mainPanelWindowsExpression())
    return { windows, panelWindows: Array.isArray(windows) ? windows.filter(window => window.url === PANEL_URL) : [] }
  }, value => value.panelWindows.length === 1, 'SUPER_PANEL_MAIN_WINDOW_IDENTITY_MISMATCH')
  const { windows, panelWindows } = windowSnapshot
  if (panelWindows.length !== 1 || !Number.isSafeInteger(panelWindows[0]?.id) || panelWindows[0].id <= 0 || panelWindows[0].destroyed) {
    throw Object.assign(new Error('SUPER_PANEL_MAIN_WINDOW_IDENTITY_MISMATCH'), {
      diagnostic: { windows, panelWindows, target: { type: target.type, url: target.url, id: target.id } }
    })
  }
  const page = await CdpClient.connect(target.webSocketDebuggerUrl, NORMAL_APP_CDP_PORT, '/devtools/page/')
  await page.call('Runtime.enable')
  return { page, target, window: panelWindows[0] }
}

async function callPanel(page, method, params = {}) {
  const encoded = JSON.stringify(JSON.stringify(params))
  return await page.evaluate(`(async () => {
    const bridge = window.__ztoolsSuperPanel;
    if (!bridge || typeof bridge.call !== 'function') throw new Error('SUPER_PANEL_PRELOAD_API_UNAVAILABLE');
    return await bridge.call(${JSON.stringify(method)}, JSON.parse(${encoded}));
  })()`)
}

async function readPanelSettings(session) {
  return await session.browserPage.page.evaluate(`(async () => {
    const sdk = window.ztools;
    if (!sdk?.config || typeof sdk.config.get !== 'function') throw new Error('PUBLIC_CONFIG_GET_UNAVAILABLE');
    const value = await sdk.config.get('super_panel', {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  })()`)
}

async function savePanelShortcut(session, shortcut) {
  const current = await readPanelSettings(session)
  const next = createSuperPanelHotkeyConfig(current, shortcut, true)
  const encoded = JSON.stringify(JSON.stringify(next))
  const saved = await session.browserPage.page.evaluate(`(async () => {
    const sdk = window.ztools;
    if (!sdk?.config || typeof sdk.config.set !== 'function' || !sdk?.sys || typeof sdk.sys.reloadHotkeys !== 'function') {
      throw new Error('PUBLIC_SUPER_PANEL_HOTKEY_API_UNAVAILABLE');
    }
    const value = JSON.parse(${encoded});
    const configured = await sdk.config.set('super_panel', value, false);
    if (configured !== true) throw new Error('PUBLIC_CONFIG_SET_NOT_CONFIRMED');
    const reloaded = await sdk.sys.reloadHotkeys();
    if (reloaded !== true) throw new Error('PUBLIC_HOTKEY_RELOAD_NOT_CONFIRMED');
    return { configured, reloaded, persisted: await sdk.config.get('super_panel', {}) };
  })()`)
  if (saved?.configured !== true || saved?.reloaded !== true || saved?.persisted?.keyboardHotkey?.enabled !== true ||
      saved.persisted.keyboardHotkey.key !== shortcut.key) throw new Error('PUBLIC_SUPER_PANEL_HOTKEY_READBACK_MISMATCH')
  return saved
}

async function callTriggerApi(session, source) {
  return await session.browserPage.page.evaluate(`(async () => {
    const sdk = window.ztools;
    if (!sdk?.trigger) throw new Error('PUBLIC_TRIGGER_SDK_UNAVAILABLE');
    return await (${source});
  })()`)
}

async function triggerList(session) {
  const response = await callTriggerApi(session, 'sdk.trigger.list()')
  if (response?.success !== true || !Array.isArray(response.data)) throw new Error('PUBLIC_TRIGGER_LIST_SHAPE_INVALID')
  return { response, triggers: response.data }
}

async function stopOwnedSession(harness, session, sessions, report, phase) {
  const stopped = await harness.stop(session)
  sessions.delete(session)
  const passed = stopped.cleanupConfirmed === true && stopped.exit?.code === 0
  report.phases[phase] = { status: passed ? 'PASS' : 'FAIL', ...stopped }
  if (!passed) throw new Error('NORMAL_APP_STOP_NOT_CONFIRMED')
  return stopped
}

function setTriggerEnabledSource(triggerId, enabled) {
  return `sdk.trigger.setEnabled(${JSON.stringify(triggerId)}, ${enabled ? 'true' : 'false'})`
}

function triggerData({ appId, triggerId, shortcut = LOCAL_APP_SHORTCUT }) {
  return createLocalAppHotkeyTrigger({ appId, triggerId, accelerator: [...shortcut.modifiers, shortcut.key].join('+') })
}

function localAppDialogStatusExpression() { return buildLocalAppDialogStateExpression() }

async function run() {
  const parsed = parseArgs({ options: {
    help: { type: 'boolean' },
    cmake: { type: 'string' },
    'expected-bootstrap-sha256': { type: 'string' }
  } })
  if (parsed.values.help) {
    console.log('node scripts/test-windows-normal-app-localapp-hotkey.mjs --expected-bootstrap-sha256 <built bootstrap SHA-256> [--cmake <absolute cmake.exe>]')
    console.log('Starts isolated normal `electron .`, uses the public ztools SDK for SuperPanel and launch_local_app shortcuts, injects only the actual registered Main callback through a UUID-scoped preload, and launches only a self-exiting test EXE. Physical key and system dialog UI remain NOT_RUN.')
    return
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log(JSON.stringify({ status: 'NOT_RUN', platform: process.platform, arch: process.arch,
      reason: 'WINDOWS_X64_NORMAL_ELECTRON_REQUIRED', physicalKeySent: false, dialogUi: 'NOT_RUN', macAcceptance: 'NOT_RUN' }))
    process.exitCode = 1
    return
  }

  const expectedBootstrap = expectedWindowsBootstrapSha(parsed.values['expected-bootstrap-sha256'])
  const cmakePath = resolveCmake(parsed.values.cmake)
  const runId = randomUUID()
  const output = path.join(clientRoot, 'out-test', 'normal-app-localapp-hotkey', runId)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.mkdirSync(output, { recursive: false })
  fs.mkdirSync(path.join(output, 'profiles'), { recursive: false })
  const report = {
    schemaVersion: 1,
    runId,
    platform: process.platform,
    arch: process.arch,
    status: 'FAIL',
    scope: 'windows-normal-electron-local-app-hotkey-openpath',
    productionZToolsAcceptance: false,
    normalElectronEntry: true,
    isolatedAppData: false,
    isolationConfirmed: false,
    rendererArbitraryIpcExposed: false,
    rendererNodeExposed: false,
    physicalKeySent: false,
    dialogUi: 'NOT_RUN',
    dialogSelection: 'Main one-shot dialog substitute scoped to the current panel WebContents',
    nativeMouseRequested: false,
    macAcceptance: 'NOT_RUN',
    output,
    profileRoot: null,
    phases: {},
    inputs: {
      expectedBootstrapSha256: expectedBootstrap,
      cdpPort: NORMAL_APP_CDP_PORT,
      inspectPort: NORMAL_APP_INSPECT_PORT,
      panelShortcut: PANEL_SHORTCUT,
      localAppShortcut: LOCAL_APP_SHORTCUT,
      localAppShortcutAccelerator: electronAcceleratorForProbe(LOCAL_APP_SHORTCUT),
      panelShortcutAccelerator: electronAcceleratorForProbe(PANEL_SHORTCUT),
      mainHookSymbol: MAIN_HOOK_SYMBOL
    }
  }
  const sessions = new Set()
  const panelPages = new Set()
  const envKeys = ['NODE_OPTIONS', 'ZTOOLS_F09_HOTKEY_TOKEN', 'ZTOOLS_F09_ALLOWED_ACCELERATORS']
  const originalEnv = saveEnvironment(envKeys)
  let harness
  let hookInstalledInMain = false
  let hookPath
  let token
  let probe
  let appId
  let triggerId
  let localAppsFile
  let triggerStoreFile
  let dialogSubstituteInstalled = false
  let appRecordRestore
  let profileRoot
  let dataRoot
  try {
    const versions = readVersions()
    const electronExecutable = path.join(clientRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    const bootstrap = path.join(clientRoot, 'out', 'main', 'bootstrap.js')
    const webIndex = path.join(clientRoot, 'out', 'assets', 'web', 'index.html')
    for (const [file, code] of [[electronExecutable, 'ELECTRON_EXECUTABLE_INVALID'], [bootstrap, 'PROJECT_BOOTSTRAP_NOT_BUILT'],
      [webIndex, 'NORMAL_APP_WEB_BUILD_NOT_FOUND']]) ensureRegularFile(file, code)
    assertPeMachine(electronExecutable, PE_MACHINE_X64)
    const actualBootstrapSha = digest(fs.readFileSync(bootstrap))
    if (actualBootstrapSha !== expectedBootstrap) throw new Error('BOOTSTRAP_SHA256_DOES_NOT_MATCH_APPROVED_BUILD')
    report.inputs = { ...report.inputs, appRoot: clientRoot, appVersion: versions.appVersion,
      electronVersion: versions.electronVersion, sdkContractVersion: versions.sdkContractVersion,
      electronExecutable, electronExecutableSha256: digest(fs.readFileSync(electronExecutable)),
      bootstrap, bootstrapSha256: actualBootstrapSha, webIndex, runnerSha256: digest(fs.readFileSync(runnerPath)),
      contractTestPath: path.join(clientRoot, 'scripts', 'test-windows-normal-app-localapp-hotkey-contract.mjs'),
      cmakePath }
    report.phases.buildIdentity = { status: 'PASS', bootstrapSha256: actualBootstrapSha,
      expectedBootstrapSha256: expectedBootstrap, electronExecutableSha256: report.inputs.electronExecutableSha256 }

    probe = buildProbeExecutable(output, cmakePath)
    report.inputs.probeExecutable = probe.executable
    report.inputs.probeExecutableSha256 = probe.sha256
    report.phases.testExecutableBuild = { status: 'PASS', ...probe,
      behavior: 'No arguments or external input; appends PID and GetModuleFileNameW path under its own UUID directory, then exits naturally after 2500ms.' }
    const markerPath = path.join(path.dirname(probe.executable), 'launches.tsv')
    if (fs.existsSync(markerPath)) throw new Error('PROBE_MARKER_ALREADY_EXISTS_BEFORE_APP_LAUNCH')

    hookPath = path.join(output, 'main-hotkey-hook.cjs')
    fs.writeFileSync(hookPath, buildMainHotkeyHookSource(), { encoding: 'utf8', flag: 'wx' })
    token = randomBytes(32).toString('hex')
    const panelAccelerator = electronAcceleratorForProbe(PANEL_SHORTCUT)
    const localAppAccelerator = electronAcceleratorForProbe(LOCAL_APP_SHORTCUT)
    configureTestPreload(hookPath, token, [panelAccelerator, localAppAccelerator])
    report.inputs = { ...report.inputs, mainHookPath: hookPath, mainHookSha256: digest(fs.readFileSync(hookPath)),
      hookScope: 'Only isolated Main, exact F23/F24 accelerator allowlist, actual register callbacks, random per-run Inspector token.' }

    harness = new WindowsNormalAppHarness({ appRoot: clientRoot, executable: electronExecutable,
      outputRoot: output, versions })
    const profile = harness.createProfile(path.join(output, 'profiles', 'normal'))
    profileRoot = profile.root
    report.profileRoot = profile.root
    const seeded = seedProfile(profile, output)
    dataRoot = seeded.dataRoot
    report.inputs = { ...report.inputs, dataRoot: seeded.dataRoot, settingsPath: seeded.settingsPath }
    report.phases.isolatedProfileSeed = { status: 'PASS',
      settings: { superPanelKeyboardEnabled: false, superPanelMouseEnabled: false }, triggerFileInitiallyAbsent: true,
      reason: 'No default Alt+Space or mouse gesture; only F23/F24 are registered for this isolated instance.' }

    const first = await harness.start({ profile, phase: 'localapp-hotkey-first-start', report })
    first.harness = harness
    sessions.add(first)
    report.isolatedAppData = true
    report.isolationConfirmed = first.processRecord.isolationConfirmed === true
    report.phases.firstStart = { status: report.isolationConfirmed ? 'PASS' : 'FAIL',
      mainIdentity: first.mainIdentity, rendererIdentity: first.rendererIdentity, process: first.processRecord,
      configuredPaths: first.configuredPaths }
    if (!report.isolationConfirmed) throw new Error('NORMAL_APP_PROFILE_ISOLATION_NOT_CONFIRMED')

    const hookReady = await waitFor(() => hookSnapshot(first), value => value?.installed === true || Boolean(value?.installError),
      'MAIN_LOCALAPP_HOOK_STATUS_NOT_READY')
    report.phases.mainControlledHook = { status: 'CHECKED', snapshot: hookReady }
    if (hookReady.pid !== first.child.pid || hookReady.installed !== true || hookReady.installError) {
      throw new Error('MAIN_LOCALAPP_HOOK_NOT_INSTALLED')
    }
    hookInstalledInMain = true
    report.phases.mainControlledHook = { status: 'PASS', snapshot: hookReady,
      injection: 'The test-only NODE_OPTIONS preload captures callbacks passed to this isolated Main globalShortcut.register; no OS key event is sent.' }

    const savedPanel = await savePanelShortcut(first, PANEL_SHORTCUT)
    const panelRegistration = await waitForRegistration(first, electronAcceleratorForProbe(PANEL_SHORTCUT), true, 'PANEL_REGISTER')
    const capturedPanel = await waitFor(() => hookSnapshot(first), value =>
      value?.accelerators?.includes(electronAcceleratorForProbe(PANEL_SHORTCUT).toLowerCase()), 'PANEL_CALLBACK_NOT_CAPTURED')
    report.phases.publicPanelConfigAndRegistration = { status: 'PASS',
      api: 'window.ztools.config.set + window.ztools.sys.reloadHotkeys',
      readback: savedPanel, registration: panelRegistration, capturedMainCallback: capturedPanel.accelerators }

    const openedPanel = await first.inspector.evaluate(buildMainHotkeyHookFireExpression(
      electronAcceleratorForProbe(PANEL_SHORTCUT), token))
    if (openedPanel?.fired !== true) throw new Error('PANEL_MAIN_CALLBACK_INJECTION_FAILED')
    const panel = await connectPanelPage(first)
    panelPages.add(panel.page)
    report.phases.panelOpenedThroughRegisteredCallback = { status: 'PASS', fire: openedPanel,
      mainWindow: panel.window, cdpTarget: { id: panel.target.id, url: panel.target.url,
        websocketHost: new URL(panel.target.webSocketDebuggerUrl).host } }

    const installedDialog = await first.inspector.evaluate(buildLocalAppDialogOverrideExpression(probe.executable, panel.window.id))
    if (installedDialog?.installed !== true || installedDialog.expectedOwnerWebContentsId !== panel.window.id) {
      throw new Error('LOCAL_APP_DIALOG_SUBSTITUTE_INSTALL_FAILED')
    }
    dialogSubstituteInstalled = true
    const selected = await callPanel(panel.page, 'super_panel_add_local_app')
    if (selected?.success !== true || selected.added !== 1) throw new Error('SUPER_PANEL_ADD_LOCAL_APP_FAILED')
    const dialogState = await first.inspector.evaluate(localAppDialogStatusExpression())
    if (dialogState?.calls !== 1 || dialogState.restored !== true || dialogState.exactOriginalRestored !== true) {
      throw new Error('LOCAL_APP_DIALOG_SUBSTITUTE_NOT_RESTORED')
    }
    dialogSubstituteInstalled = false
    const appRecord = appLocalRecord(dataRoot, windowsLocalAppId(probe.executable))
    appId = appRecord.app.id
    localAppsFile = appRecord.file
    if (appRecord.app.exePath !== probe.executable || appRecord.app.arguments !== '' || appRecord.app.panelEnabled !== true) {
      throw new Error('LOCAL_APP_SELECTION_RECORD_MISMATCH')
    }
    const panelData = await callPanel(panel.page, 'super_panel_get_data')
    const panelLocalApp = Array.isArray(panelData?.items) ? panelData.items.find(item => item.id === appId && item.type === 'local') : null
    if (!panelLocalApp) throw new Error('LOCAL_APP_NOT_RETURNED_BY_REAL_PANEL_DATA')
    report.phases.localAppSelectedAndListed = { status: 'PASS', selection: 'Main one-shot dialog substitute',
      dialogUi: 'NOT_RUN', dialogState, added: selected.added, appId,
      persistedRecord: { id: appRecord.app.id, name: appRecord.app.name, exePath: appRecord.app.exePath,
        arguments: appRecord.app.arguments, panelEnabled: appRecord.app.panelEnabled },
      actualPanelItem: { id: panelLocalApp.id, type: panelLocalApp.type, name: panelLocalApp.name } }
    panel.page.dispose()
    panelPages.delete(panel.page)

    triggerId = `f09-localapp-${runId}`
    const trigger = triggerData({ appId, triggerId })
    const conflictTrigger = { ...trigger, id: `f09-localapp-${randomUUID()}`, config: { key: 'Ctrl+Alt+Shift+F23' } }
    const conflict = await callTriggerApi(first, `(async () => {
      try { return { rejected: false, value: await sdk.trigger.register(${JSON.stringify(conflictTrigger)}) }; }
      catch { return { rejected: true }; }
    })()`)
    const conflictRegistration = await queryRegistration(first, electronAcceleratorForProbe(PANEL_SHORTCUT))
    const conflictList = await triggerList(first)
    if (conflict?.rejected !== true || conflictRegistration.registered !== true ||
        conflictList.triggers.some(item => item.id === conflictTrigger.id)) throw new Error('REAL_SDK_SHORTCUT_CONFLICT_ROLLBACK_FAILED')
    report.phases.realSdkConflictRollback = { status: 'PASS', conflictRejected: true,
      existingPanelShortcutStillRegistered: conflictRegistration, failedTriggerPersisted: false,
      api: 'window.ztools.trigger.register; Main Inspector only reads globalShortcut.isRegistered' }

    const registration = await callTriggerApi(first, `sdk.trigger.register(${JSON.stringify(trigger)})`)
    if (registration?.success !== true || registration?.data?.triggerId !== triggerId) {
      throw new Error('PUBLIC_LOCAL_APP_TRIGGER_REGISTER_FAILED')
    }
    const listed = await triggerList(first)
    const listedTrigger = listed.triggers.find(item => item.id === triggerId)
    if (!listedTrigger || listedTrigger.pluginId !== appId || listedTrigger.enabled !== true || listedTrigger.effectiveEnabled !== true ||
        listedTrigger.action?.target !== 'launch_local_app' || listedTrigger.action?.params?.appId !== appId) {
      throw new Error('PUBLIC_LOCAL_APP_TRIGGER_READBACK_MISMATCH')
    }
    const localAppRegistration = await waitForRegistration(first, localAppAccelerator, true, 'LOCAL_APP_REGISTER')
    const capturedHotkey = await waitFor(() => hookSnapshot(first), value =>
      value?.accelerators?.includes(localAppAccelerator.toLowerCase()), 'LOCAL_APP_CALLBACK_NOT_CAPTURED')
    const storedTrigger = triggerRecord(dataRoot, triggerId)
    triggerStoreFile = storedTrigger.file
    if (!storedTrigger.trigger || storedTrigger.trigger.pluginId !== appId ||
        JSON.stringify(storedTrigger.trigger.action) !== JSON.stringify(trigger.action)) {
      throw new Error('LOCAL_APP_TRIGGER_DISK_RECORD_MISMATCH')
    }
    report.phases.publicLocalAppTriggerRegistered = { status: 'PASS',
      api: 'window.ztools.trigger.register + window.ztools.trigger.list', registration: localAppRegistration,
      readback: listedTrigger, diskAction: storedTrigger.trigger.action, capturedMainCallback: capturedHotkey.accelerators }

    const originalLocalDocument = appRecord.document
    const brokenDocument = structuredClone(originalLocalDocument)
    const brokenRecord = brokenDocument.apps.find(item => isRecord(item) && item.id === appId)
    if (!brokenRecord) throw new Error('LOCAL_APP_RECORD_FOR_FAILURE_FIXTURE_MISSING')
    brokenRecord.exePath = path.join(path.dirname(brokenRecord.exePath), 'missing-owned-localapp-probe.exe')
    const missingPath = brokenRecord.exePath
    appRecordRestore = { file: localAppsFile, document: originalLocalDocument }
    writeJsonFile(localAppsFile, brokenDocument)
    const invalidPathFire = await first.inspector.evaluate(buildMainHotkeyHookFireExpression(localAppAccelerator, token))
    await delay(900)
    const failedLaunchMarkers = parseLaunchMarker(path.join(path.dirname(probe.executable), 'launches.tsv'))
    const noFailedUsage = appLocalRecord(dataRoot, appId).app.useCount === 0
    writeJsonFile(localAppsFile, originalLocalDocument)
    appRecordRestore = null
    if (invalidPathFire?.fired !== true || failedLaunchMarkers.length !== 0 || !noFailedUsage) {
      throw new Error('INVALID_LOCAL_APP_RECORD_DID_NOT_FAIL_CLOSED')
    }
    report.phases.invalidLocalAppFailure = { status: 'PASS', callbackReached: true, missingIsolatedPath: missingPath,
      launchMarkerAbsent: true, usageCountUnchanged: true,
      note: 'Only the isolated profile record was temporarily changed to a missing path, then restored before continuing.' }

    const disabledResult = await callTriggerApi(first, setTriggerEnabledSource(triggerId, false))
    if (disabledResult?.success !== true) throw new Error('PUBLIC_LOCAL_APP_TRIGGER_DISABLE_FAILED')
    const disabledList = await triggerList(first)
    const disabledEntry = disabledList.triggers.find(item => item.id === triggerId)
    const disabledRegistration = await waitForRegistration(first, localAppAccelerator, false, 'LOCAL_APP_DISABLE')
    const disabledHookFire = await first.inspector.evaluate(buildMainHotkeyHookFireExpression(localAppAccelerator, token))
    await delay(400)
    if (!disabledEntry || disabledEntry.enabled !== false || disabledEntry.effectiveEnabled !== false ||
        disabledHookFire?.fired !== false || parseLaunchMarker(path.join(path.dirname(probe.executable), 'launches.tsv')).length !== 0) {
      throw new Error('DISABLED_LOCAL_APP_TRIGGER_STILL_FIREABLE')
    }
    report.phases.disabledAndUnregistered = { status: 'PASS', disabledEntry, registration: disabledRegistration,
      controlledInjection: disabledHookFire, launchMarkerCount: 0 }

    const enabledResult = await callTriggerApi(first, setTriggerEnabledSource(triggerId, true))
    if (enabledResult?.success !== true) throw new Error('PUBLIC_LOCAL_APP_TRIGGER_REENABLE_FAILED')
    const enabledList = await triggerList(first)
    const enabledEntry = enabledList.triggers.find(item => item.id === triggerId)
    const enabledRegistration = await waitForRegistration(first, localAppAccelerator, true, 'LOCAL_APP_REENABLE')
    if (!enabledEntry || enabledEntry.effectiveEnabled !== true) throw new Error('LOCAL_APP_TRIGGER_REENABLE_READBACK_FAILED')
    const firstFire = await first.inspector.evaluate(buildMainHotkeyHookFireExpression(localAppAccelerator, token))
    if (firstFire?.fired !== true) throw new Error('LOCAL_APP_MAIN_CALLBACK_INJECTION_FAILED')
    const firstLaunch = await observeProbeLaunch(markerPath, 0, probe.executable, 1, localAppsFile, appId)
    report.phases.realShellOpenPathLaunch = { status: 'PASS', callback: firstFire, registration: enabledRegistration,
      launch: firstLaunch,
      shellOpenPathAction: 'Main SuperPanelDataService resolved the selected ID to its saved EXE path and invoked existing shell.openPath; the EXE wrote a UUID-local marker and exited naturally.' }

    await stopOwnedSession(harness, first, sessions, report, 'firstStop')

    const restarted = await harness.start({ profile, phase: 'localapp-hotkey-restart', report })
    restarted.harness = harness
    sessions.add(restarted)
    const restartHook = await waitFor(() => hookSnapshot(restarted), value => value?.installed === true || Boolean(value?.installError),
      'RESTARTED_MAIN_LOCALAPP_HOOK_STATUS_NOT_READY')
    if (restartHook.pid !== restarted.child.pid || restartHook.installed !== true || restartHook.installError) {
      throw new Error('RESTARTED_MAIN_LOCALAPP_HOOK_NOT_INSTALLED')
    }
    const restoredList = await triggerList(restarted)
    const restoredEntry = restoredList.triggers.find(item => item.id === triggerId)
    const restoredSettings = await readPanelSettings(restarted)
    const restoredLocalAppRegistration = await waitForRegistration(restarted, localAppAccelerator, true, 'RESTART_LOCAL_APP_REGISTER')
    const restoredPanelRegistration = await waitForRegistration(restarted, electronAcceleratorForProbe(PANEL_SHORTCUT), true, 'RESTART_PANEL_REGISTER')
    const restartCaptures = await waitFor(() => hookSnapshot(restarted), value =>
      value?.accelerators?.includes(localAppAccelerator.toLowerCase()) &&
      value?.accelerators?.includes(electronAcceleratorForProbe(PANEL_SHORTCUT).toLowerCase()), 'RESTARTED_CALLBACKS_NOT_CAPTURED')
    if (!restoredEntry || restoredEntry.enabled !== true || restoredEntry.effectiveEnabled !== true ||
        restoredEntry.pluginId !== appId || restoredSettings?.keyboardHotkey?.enabled !== true ||
        restoredSettings.keyboardHotkey.key !== PANEL_SHORTCUT.key) throw new Error('LOCAL_APP_HOTKEY_RESTART_PERSISTENCE_FAILED')
    const secondFire = await restarted.inspector.evaluate(buildMainHotkeyHookFireExpression(localAppAccelerator, token))
    if (secondFire?.fired !== true) throw new Error('RESTARTED_LOCAL_APP_CALLBACK_INJECTION_FAILED')
    const secondLaunch = await observeProbeLaunch(markerPath, 1, probe.executable, 2, localAppsFile, appId)
    report.phases.restartPersistenceAndSecondLaunch = { status: 'PASS', trigger: restoredEntry,
      superPanelHotkey: restoredSettings.keyboardHotkey, localAppRegistration: restoredLocalAppRegistration,
      panelRegistration: restoredPanelRegistration, capturedCallbacks: restartCaptures.accelerators,
      launch: secondLaunch, triggerStore: triggerStoreFile }
    await stopOwnedSession(harness, restarted, sessions, report, 'restartStop')

    const finalApp = appLocalRecord(dataRoot, appId)
    const finalTrigger = triggerRecord(dataRoot, triggerId)
    const finalMarkers = parseLaunchMarker(markerPath)
    if (finalMarkers.length !== 2 || finalApp.app.useCount !== 2 || !finalTrigger.trigger?.enabled) {
      throw new Error('FINAL_ISOLATED_PROFILE_STATE_MISMATCH')
    }
    report.phases.finalPersistedState = { status: 'PASS', localAppUseCount: finalApp.app.useCount,
      launchMarkers: finalMarkers, trigger: { id: finalTrigger.trigger.id, enabled: finalTrigger.trigger.enabled,
        action: finalTrigger.trigger.action }, profilePreserved: fs.existsSync(profile.root) }
    report.status = 'PASS'
    report.completeCase = true
  } catch (error) {
    report.failureCode = errorCode(error)
    if (error?.diagnostic && typeof error.diagnostic === 'object') report.failureDiagnostic = error.diagnostic
    if (typeof error?.stack === 'string') report.errorStack = error.stack.slice(0, 4000)
    report.failedAt = new Date().toISOString()
    console.error(report.failureCode)
    process.exitCode = 1
  } finally {
    for (const page of panelPages) page.dispose()
    if (appRecordRestore) {
      try {
        writeJsonFile(appRecordRestore.file, appRecordRestore.document)
        report.phases.localAppFailureFixtureRestore = { status: 'PASS' }
      } catch {
        report.phases.localAppFailureFixtureRestore = { status: 'FAIL' }
        report.status = 'FAIL'
        process.exitCode = 1
      }
    }
    if (dialogSubstituteInstalled) {
      for (const session of sessions) {
        try {
          const state = await session.inspector.evaluate(buildLocalAppDialogRestoreExpression(), { timeoutMs: 3000 })
          report.phases.dialogSubstituteFailureCleanup = { status: state?.restored === true ? 'PASS' : 'FAIL', state }
          if (state?.restored !== true) { report.status = 'FAIL'; process.exitCode = 1 }
        } catch (error) {
          report.phases.dialogSubstituteFailureCleanup = { status: 'FAIL', errorCode: errorCode(error) }
          report.status = 'FAIL'
          process.exitCode = 1
        }
      }
    }
    for (const session of [...sessions]) {
      if (!session || session.stopResult || !harness) continue
      const stopped = await harness.stop(session)
      sessions.delete(session)
      report.phases.failureCleanup ??= { status: stopped.cleanupConfirmed ? 'PASS' : 'FAIL', ...stopped }
      if (!stopped.cleanupConfirmed) {
        report.status = 'FAIL'
        report.failureCode ??= 'OWNED_ELECTRON_CLEANUP_UNCONFIRMED'
        process.exitCode = 1
      }
    }
    if (probe) {
      try {
        const markerPath = path.join(path.dirname(probe.executable), 'launches.tsv')
        const cleanup = await confirmProbeProcessCleanup(markerPath, probe.executable)
        report.phases.testProbeCleanup = cleanup
        if (cleanup.status !== 'PASS') { report.status = 'FAIL'; process.exitCode = 1 }
      } catch (error) {
        report.phases.testProbeCleanup = { status: 'FAIL', errorCode: errorCode(error), processTerminationRequested: false }
        report.status = 'FAIL'
        process.exitCode = 1
      }
    }
    restoreEnvironment(originalEnv)
    report.updatedAt = new Date().toISOString()
    report.scratchPreserved = true
    report.physicalKeySent = false
    report.dialogUi = 'NOT_RUN'
    report.macAcceptance = 'NOT_RUN'
    report.mainHookInstalled = hookInstalledInMain
    report.testProbe = probe ? { executable: probe.executable, sha256: probe.sha256,
      marker: path.join(path.dirname(probe.executable), 'launches.tsv') } : null
    if (appId) report.localAppId = appId
    if (triggerId) report.localAppTriggerId = triggerId
    if (profileRoot) report.profileRoot = profileRoot
    const reportPath = path.join(output, 'report.json')
    if (!fs.existsSync(reportPath)) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    console.log(JSON.stringify(report))
    if (report.status !== 'PASS') process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === runnerPath) {
  void run().catch(error => { console.error(errorCode(error)); process.exitCode = 1 })
}
