import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import { WindowsNormalAppHarness, startLoopbackZipServer, closeLoopbackZipServer } from './lib/windows-normal-app-harness.mjs'
import { digest, validateFreshPluginZip } from './windows-normal-app-plugin-file-chain-lib.mjs'

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(clientRoot, '..')
const pluginRoot = path.join(repositoryRoot, 'plugins', 'create-plugin')
const fixtureRoot = path.join(clientRoot, 'tests', 'fixtures', 'windows-normal-app-process-chain')
const pluginId = 'f11-process-chain-test'
const pluginVersion = '1.0.0'
const sdkContractVersion = 1
const ports = Object.freeze({ cdp: 9340, inspect: 9341 })
const cscPath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const dialogStateKey = '__ztoolsF11ProcessChainDialog__'
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function fail(code) { throw new Error(code) }

function codeOf(error) {
  const cdpCode = typeof error?.cdpException?.description === 'string'
    ? error.cdpException.description.match(/\bF11_[A-Z0-9_]{1,96}\b/)?.[0] : undefined
  if (cdpCode) return cdpCode
  const value = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : ''
  return /^[A-Z0-9_]{1,120}$/.test(value) ? value : 'F11_UNCLASSIFIED_FAILURE'
}

export function parseProcessChainArgs(args) {
  const parsed = parseArgs({ args, options: { help: { type: 'boolean' }, 'execute-normal-app': { type: 'boolean' }, 'preflight-only': { type: 'boolean' } }, strict: true, allowPositionals: false })
  if (parsed.values.help) return { help: true, execute: false, preflightOnly: false }
  if (parsed.values['execute-normal-app'] === true && parsed.values['preflight-only'] === true) throw new Error('F11_EXECUTION_MODE_CONFLICT')
  if (parsed.values['preflight-only'] === true) return { help: false, execute: false, preflightOnly: true }
  if (parsed.values['execute-normal-app'] !== true) throw new Error('F11_EXPLICIT_EXECUTION_FLAG_REQUIRED')
  return { help: false, execute: true, preflightOnly: false }
}

export function validateProcessFixtureManifest(manifest) {
  const errors = []
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { status: 'FAIL', errors: ['F11_MANIFEST_INVALID'] }
  if (manifest.id !== pluginId) errors.push('F11_PLUGIN_ID_MISMATCH')
  if (manifest.version !== pluginVersion) errors.push('F11_PLUGIN_VERSION_MISMATCH')
  if (manifest.entry !== 'index.html') errors.push('F11_ENTRY_INVALID')
  if (!String(manifest.name ?? '').includes('TEST ONLY') || !String(manifest.description ?? '').includes('TEST ONLY')) errors.push('F11_TEST_ONLY_MARKER_MISSING')
  if (JSON.stringify(manifest.targets) !== JSON.stringify([{ id: 'windows-electron-x64', platform: 'windows', runtime: 'electron', arch: 'x64' }])) errors.push('F11_TARGET_SET_INVALID')
  if (!Array.isArray(manifest.nativeComponents) || manifest.nativeComponents.length !== 0) errors.push('F11_NATIVE_COMPONENTS_INVALID')
  const lane = manifest.minimumSdkContractVersion ?? manifest.minSdkContractVersion ?? manifest.sdkContractVersion ?? 1
  if (lane !== 1) errors.push('F11_SDK1_REQUIRED')
  return { status: errors.length ? 'FAIL' : 'PASS', errors, testOnly: errors.length === 0, declaredSdkLane: lane }
}

export function buildFixtureArguments(mode, durationMs, exitCode) {
  if (mode === 'hold') {
    if (!Number.isSafeInteger(durationMs) || durationMs < 60_000 || durationMs > 120_000) throw new Error('F11_HOLD_DURATION_OUT_OF_RANGE')
    return ['hold', String(durationMs)]
  }
  if (mode === 'exit') {
    if (!Number.isSafeInteger(durationMs) || durationMs < 100 || durationMs > 120_000) throw new Error('F11_EXIT_DELAY_OUT_OF_RANGE')
    if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) throw new Error('F11_EXIT_CODE_OUT_OF_RANGE')
    return ['exit', String(durationMs), String(exitCode)]
  }
  throw new Error('F11_FIXTURE_MODE_INVALID')
}

export function parseChooserSelection(result, expectedPath) {
  if (!result || typeof result !== 'object' || result.canceled !== false) throw new Error('F11_CHOOSER_NOT_ACCEPTED')
  let selected
  let shape
  if (typeof result.filePath === 'string' && result.filePath) {
    selected = result.filePath
    shape = 'filePath'
  } else if (Array.isArray(result.filePaths) && result.filePaths.length === 1) {
    const item = result.filePaths[0]
    selected = typeof item === 'string' ? item : item && typeof item.path === 'string' ? item.path : undefined
    shape = typeof item === 'string' ? 'filePaths:string' : 'filePaths:object'
  }
  if (typeof selected !== 'string' || path.win32.normalize(selected).toLocaleLowerCase('en-US') !== path.win32.normalize(expectedPath).toLocaleLowerCase('en-US')) {
    throw new Error('F11_CHOOSER_PATH_MISMATCH')
  }
  return { selectedPath: selected, shape, returnedKeys: Object.keys(result).sort(), fileUrlPresent: typeof result.fileUrl === 'string' || typeof result.filePaths?.[0]?.fileUrl === 'string' }
}

export function summarizeProcessList(processes, lockedPids) {
  if (!Array.isArray(processes) || processes.length > 10_000 || !lockedPids || typeof lockedPids !== 'object' ||
      !Number.isSafeInteger(lockedPids.mainPid) || lockedPids.mainPid <= 0) throw new Error('F11_PROCESS_LIST_INVALID')
  const wanted = new Set([lockedPids.mainPid, lockedPids.fixturePid].filter(pid => Number.isSafeInteger(pid) && pid > 0))
  const matchingRows = processes.filter(row => wanted.has(row?.pid)).map(row => ({
    pid: row.pid,
    role: row.pid === lockedPids.mainPid ? 'isolated-main' : 'owned-fixture',
    fieldAvailability: {
      path: typeof row.fieldAvailability?.path === 'boolean' ? row.fieldAvailability.path : null,
      cpuUsage: typeof row.fieldAvailability?.cpuUsage === 'boolean' ? row.fieldAvailability.cpuUsage : null,
      memoryUsage: typeof row.fieldAvailability?.memoryUsage === 'boolean' ? row.fieldAvailability.memoryUsage : null
    }
  }))
  return { totalCount: processes.length, matchingRows }
}

export function validateFixtureCimRow(row, expected) {
  if (!row || !expected || row.pid !== expected.pid || row.parentPid !== expected.parentPid ||
      typeof row.imagePath !== 'string' || normalizeWinPath(row.imagePath) !== normalizeWinPath(expected.imagePath) ||
      typeof row.creationDate !== 'string' || !row.creationDate || row.creationDate !== expected.creationDate) {
    return { status: 'FAIL', code: 'F11_FIXTURE_PROCESS_IDENTITY_MISMATCH' }
  }
  return { status: 'PASS', pid: row.pid, parentPid: row.parentPid, imagePath: row.imagePath, creationDate: row.creationDate }
}

function normalizeWinPath(value) {
  return path.win32.normalize(path.win32.resolve(value)).replaceAll('/', '\\').toLocaleLowerCase('en-US')
}

function readVersions() {
  const packageInfo = JSON.parse(fs.readFileSync(path.join(clientRoot, 'package.json'), 'utf8'))
  const protocol = fs.readFileSync(path.join(clientRoot, 'src', 'contracts', 'protocol-versions.ts'), 'utf8')
  const sdk = protocol.match(/SDK_CONTRACT\s*=\s*(\d+)/)
  const electron = JSON.parse(fs.readFileSync(path.join(clientRoot, 'node_modules', 'electron', 'package.json'), 'utf8'))
  const appName = typeof packageInfo.productName === 'string' ? packageInfo.productName : packageInfo.name
  if (!sdk || Number(sdk[1]) !== sdkContractVersion || typeof appName !== 'string' ||
      typeof packageInfo.version !== 'string' || electron.version !== '43.4.1') throw new Error('F11_RUNTIME_VERSION_METADATA_INVALID')
  return { appName, appVersion: packageInfo.version, electronVersion: electron.version, sdkContractVersion: Number(sdk[1]) }
}

function sourceSnapshot() {
  const paths = [
    ['mainBootstrap', path.join(clientRoot, 'out', 'main', 'bootstrap.js')],
    ['preload', path.join(clientRoot, 'out', 'preload', 'main.js')],
    ['publicSdk', path.join(clientRoot, 'out', 'assets', 'web', 'sdk', 'ztools-api.js')],
    ['pluginProtocolSource', path.join(clientRoot, 'src', 'main', 'protocol', 'ztools-protocol.ts')],
    ['pluginProtocolRuntime', path.join(clientRoot, 'out', 'main', 'protocol', 'ztools-protocol.js')],
    ['harness', path.join(clientRoot, 'scripts', 'lib', 'windows-normal-app-harness.mjs')],
    ['runner', fileURLToPath(import.meta.url)],
    ['contract', path.join(clientRoot, 'scripts', 'test-windows-normal-app-process-chain.contract.test.mjs')],
    ['fixtureCs', path.join(fixtureRoot, 'ProcessFixture.cs')],
    ['fixtureManifest', path.join(fixtureRoot, 'plugin.json')],
    ['fixtureHtml', path.join(fixtureRoot, 'index.html')],
    ['fixtureJs', path.join(fixtureRoot, 'app.js')]
  ]
  return Object.fromEntries(paths.map(([label, file]) => [label, fs.existsSync(file) ? shaFile(file) : null]))
}

function shaFile(file) { return digest(fs.readFileSync(file)) }

function readPeClrInfo(file) {
  const data = fs.readFileSync(file)
  if (data.length < 256 || data.toString('ascii', 0, 2) !== 'MZ') throw new Error('F11_FIXTURE_PE_INVALID')
  const pe = data.readUInt32LE(0x3c)
  if (pe + 24 > data.length || data.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('F11_FIXTURE_PE_SIGNATURE_INVALID')
  const machine = data.readUInt16LE(pe + 4)
  const sectionCount = data.readUInt16LE(pe + 6)
  const optionalSize = data.readUInt16LE(pe + 20)
  const optional = pe + 24
  const magic = data.readUInt16LE(optional)
  if (machine !== 0x14c || magic !== 0x10b || optional + optionalSize > data.length) throw new Error('F11_FIXTURE_ANYCPU_PE32_REQUIRED')
  const numberOfDirectoriesOffset = optional + 92
  if (data.readUInt32LE(numberOfDirectoriesOffset) < 15) throw new Error('F11_FIXTURE_CLR_DIRECTORY_MISSING')
  const cliRva = data.readUInt32LE(optional + 96 + 14 * 8)
  if (!cliRva) throw new Error('F11_FIXTURE_CLR_DIRECTORY_MISSING')
  const sectionTable = optional + optionalSize
  let cliOffset = -1
  for (let index = 0; index < sectionCount; index++) {
    const section = sectionTable + index * 40
    const virtualSize = data.readUInt32LE(section + 8)
    const virtualAddress = data.readUInt32LE(section + 12)
    const rawSize = data.readUInt32LE(section + 16)
    const rawPointer = data.readUInt32LE(section + 20)
    const span = Math.max(virtualSize, rawSize)
    if (cliRva >= virtualAddress && cliRva < virtualAddress + span) { cliOffset = rawPointer + cliRva - virtualAddress; break }
  }
  if (cliOffset < 0 || cliOffset + 20 > data.length) throw new Error('F11_FIXTURE_CLR_HEADER_INVALID')
  const flags = data.readUInt32LE(cliOffset + 16)
  const ilOnly = (flags & 0x1) !== 0
  const requires32Bit = (flags & 0x2) !== 0
  const prefers32Bit = (flags & 0x20000) !== 0
  if (!ilOnly || requires32Bit || prefers32Bit) throw new Error('F11_FIXTURE_NOT_ANYCPU_ILONLY')
  return { machine: 'I386', optionalHeader: 'PE32', clrFlags: flags, ilOnly, requires32Bit, prefers32Bit, bytes: data.length, sha256: digest(data) }
}

function compileFixture(outputPath) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('F11_WINDOWS_X64_REQUIRED')
  if (!fs.existsSync(cscPath)) throw new Error('F11_LOCAL_CSC_NOT_FOUND')
  const sourcePath = path.join(fixtureRoot, 'ProcessFixture.cs')
  const result = spawnSync(cscPath, ['/nologo', '/target:exe', '/platform:anycpu', `/out:${outputPath}`, sourcePath], {
    cwd: path.dirname(outputPath), windowsHide: true, encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024
  })
  if (result.error || result.status !== 0 || !fs.existsSync(outputPath)) throw new Error('F11_FIXTURE_COMPILE_FAILED')
  return { compiler: cscPath, exitCode: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim(), pe: readPeClrInfo(outputPath) }
}

async function writeRuntimeZip(runId) {
  const buildRun = path.join(pluginRoot, '.build-runs', runId)
  const zipDir = path.join(buildRun, 'zips')
  const stageDir = path.join(buildRun, 'stage')
  await fsp.mkdir(zipDir, { recursive: true })
  await fsp.mkdir(stageDir, { recursive: true })
  const names = ['plugin.json', 'index.html', 'app.js']
  for (const name of names) {
    const source = path.join(fixtureRoot, name)
    const stat = await fsp.lstat(source)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('F11_PLUGIN_FIXTURE_SOURCE_INVALID')
    await fsp.copyFile(source, path.join(stageDir, name), fs.constants.COPYFILE_EXCL)
  }
  const manifest = JSON.parse(await fsp.readFile(path.join(stageDir, 'plugin.json'), 'utf8'))
  const validation = validateProcessFixtureManifest(manifest)
  if (validation.status !== 'PASS') throw new Error('F11_PLUGIN_FIXTURE_MANIFEST_INVALID')
  const zipPath = path.join(zipDir, `${pluginId}-${pluginVersion}-windows-electron-x64.zip`)
  const requirePlugin = createRequire(path.join(pluginRoot, 'package.json'))
  const archiver = requirePlugin('archiver')
  const archive = archiver('zip', { zlib: { level: 9 } })
  const output = fs.createWriteStream(zipPath, { flags: 'wx' })
  const finished = new Promise((resolve, reject) => {
    output.once('close', resolve)
    output.once('error', reject)
    archive.once('error', reject)
  })
  archive.pipe(output)
  for (const name of names) archive.file(path.join(stageDir, name), { name })
  await archive.finalize()
  await finished
  const zipInfo = validateFreshPluginZip(zipPath, pluginRoot, pluginId)
  const entries = await readZipEntries(zipInfo.path)
  const entryNames = entries.map(item => item.name).sort()
  if (entryNames.join('|') !== [...names].sort().join('|')) throw new Error('F11_PLUGIN_ZIP_TREE_MISMATCH')
  for (const entry of entries) {
    const sourceBytes = await fsp.readFile(path.join(stageDir, entry.name))
    if (entry.sha256 !== digest(sourceBytes)) throw new Error('F11_PLUGIN_ZIP_ENTRY_HASH_MISMATCH')
  }
  return { ...zipInfo, pluginId, pluginVersion, testOnly: true, entries: entries.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) }
}

async function readZipEntries(zipPath) {
  const requireClient = createRequire(path.join(clientRoot, 'package.json'))
  const yauzl = requireClient('yauzl')
  const bytes = await fsp.readFile(zipPath)
  return await new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings: true }, (openError, zip) => {
      if (openError || !zip) { reject(openError ?? new Error('F11_ZIP_OPEN_FAILED')); return }
      const entries = []
      zip.once('error', reject)
      zip.once('end', () => resolve(entries))
      zip.on('entry', entry => {
        if (entry.fileName.endsWith('/')) { reject(new Error('F11_ZIP_DIRECTORY_ENTRY_UNEXPECTED')); zip.close(); return }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { reject(streamError ?? new Error('F11_ZIP_ENTRY_STREAM_FAILED')); zip.close(); return }
          const chunks = []
          stream.on('data', chunk => chunks.push(chunk))
          stream.once('error', error => { reject(error); zip.close() })
          stream.once('end', () => {
            const value = Buffer.concat(chunks)
            entries.push({ name: entry.fileName, sha256: digest(value), bytes: value.length })
            zip.readEntry()
          })
        })
      })
      zip.readEntry()
    })
  })
}

function buildDialogInstallExpression(pluginUrl, fixturePath) {
  if (typeof pluginUrl !== 'string' || !pluginUrl.startsWith(`ztools://plugins/${pluginId}/`) || !path.win32.isAbsolute(fixturePath)) {
    throw new Error('F11_DIALOG_INSTALL_INPUT_INVALID')
  }
  return `(() => {
    const mainModule = process.mainModule;
    if (!mainModule || typeof mainModule.require !== 'function') throw new Error('MAIN_MODULE_REQUIRE_UNAVAILABLE');
    const requireMain = mainModule.require.bind(mainModule);
    const electron = requireMain('electron');
    const key = Symbol.for(${JSON.stringify(dialogStateKey)});
    if (globalThis[key]) throw new Error('F11_DIALOG_STATE_ALREADY_PRESENT');
    const targets = electron.BrowserWindow.getAllWindows().filter(owner => {
      try { return !owner.isDestroyed() && !owner.webContents.isDestroyed() && owner.webContents.getURL() === ${JSON.stringify(pluginUrl)}; }
      catch { return false; }
    });
    if (targets.length !== 1) throw new Error('F11_DIALOG_OWNER_NOT_UNIQUE');
    const expectedOwnerId = targets[0].webContents.id;
    const expectedUrl = ${JSON.stringify(pluginUrl)};
    const expectedPath = ${JSON.stringify(fixturePath)};
    const dialog = electron.dialog;
    const original = dialog.showOpenDialog;
    if (typeof original !== 'function') throw new Error('F11_DIALOG_METHOD_UNAVAILABLE');
    const state = { expectedOwnerId, expectedUrl, calls: 0, restored: false, ownerMatched: false, propertiesMatched: false };
    const restore = () => {
      if (dialog.showOpenDialog === wrapped) dialog.showOpenDialog = original;
      state.restored = dialog.showOpenDialog === original;
      return state.restored;
    };
    const wrapped = async function (...args) {
      try {
        if (state.calls !== 0 || args.length !== 2 || !args[0] || !args[1]) throw new Error('F11_DIALOG_CALL_SHAPE_INVALID');
        const owner = args[0]; const options = args[1];
        state.ownerMatched = !owner.isDestroyed() && !owner.webContents.isDestroyed() &&
          owner.webContents.id === expectedOwnerId && owner.webContents.getURL() === expectedUrl;
        state.propertiesMatched = Array.isArray(options.properties) && options.properties.length === 1 && options.properties[0] === 'openFile';
        if (!state.ownerMatched || !state.propertiesMatched) throw new Error('F11_DIALOG_SCOPE_MISMATCH');
        state.calls += 1;
        restore();
        return { canceled: false, filePaths: [expectedPath] };
      } catch (error) {
        restore();
        throw error;
      }
    };
    globalThis[key] = { state, restore, original };
    dialog.showOpenDialog = wrapped;
    if (dialog.showOpenDialog !== wrapped) { delete globalThis[key]; throw new Error('F11_DIALOG_OVERRIDE_FAILED'); }
    return { installed: true, expectedOwnerId, expectedUrl, oneShot: true };
  })()`
}

function buildDialogStateExpression(remove = false) {
  const key = JSON.stringify(dialogStateKey)
  if (remove) return `(() => { const symbol = Symbol.for(${key}); const value = globalThis[symbol]; if (!value) return { present: false, removed: true }; const electron = process.mainModule.require('electron'); const restored = value.restore(); const exactOriginal = electron.dialog.showOpenDialog === value.original; delete globalThis[symbol]; return { present: true, removed: !globalThis[symbol], restored, exactOriginal, ...value.state }; })()`
  return `(() => { const value = globalThis[Symbol.for(${key})]; return value ? { present: true, ...value.state } : { present: false }; })()`
}

function queryCimProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('F11_CIM_PID_INVALID')
  const script = `$ErrorActionPreference='Stop'; $row=Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction Stop | Select-Object -First 1; if ($null -eq $row) { 'null' } else { $value=[pscustomobject]@{ pid=[int]$row.ProcessId; parentPid=[int]$row.ParentProcessId; imagePath=[string]$row.ExecutablePath; creationDate=$row.CreationDate.ToUniversalTime().ToString('o') }; ConvertTo-Json -InputObject $value -Compress }`
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const result = spawnSync(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1024
  })
  if (result.error || result.status !== 0) throw new Error('F11_CIM_EXACT_PID_QUERY_FAILED')
  const text = result.stdout.trim()
  if (!text || text === 'null') return null
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.pid) || !Number.isSafeInteger(value.parentPid)) throw new Error('F11_CIM_ROW_INVALID')
  return value
}

function cimIdentity(row, expected) {
  const result = validateFixtureCimRow(row, expected)
  if (result.status !== 'PASS') return result
  return { status: 'PASS', pid: row.pid, parentPid: row.parentPid, imagePath: row.imagePath, creationDate: row.creationDate }
}

async function waitForFixtureIdentity(pid, expectedParentPid, fixturePath, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = queryCimProcess(pid)
    if (last && last.parentPid === expectedParentPid && normalizeWinPath(last.imagePath) === normalizeWinPath(fixturePath) && typeof last.creationDate === 'string' && last.creationDate) {
      return { pid, parentPid: expectedParentPid, imagePath: fixturePath, creationDate: last.creationDate }
    }
    await delay(200)
  }
  throw new Error(last ? 'F11_FIXTURE_CIM_IDENTITY_NOT_MATCHED' : 'F11_FIXTURE_NOT_VISIBLE_TO_CIM')
}

async function waitForFixtureGone(expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let polls = 0
  while (Date.now() < deadline) {
    polls += 1
    const row = queryCimProcess(expected.pid)
    if (!row) return { status: 'PASS', polls, pidAbsent: true }
    const identity = cimIdentity(row, expected)
    if (identity.status !== 'PASS') return { status: 'PASS', polls, pidAbsent: false, originalIdentityAbsent: true, pidReusedOrChanged: true }
    await delay(200)
  }
  return { status: 'FAIL', polls, pidAbsent: false, identityStillMatches: true }
}

function processErrorCode(result) { return result?.ok === false && typeof result.code === 'string' ? result.code : null }

async function setUiInputs(page, values) {
  const literal = JSON.stringify(values)
  return await page.evaluate(`(() => { const values=${literal}; for (const [id,value] of Object.entries(values)) { const element=document.getElementById(id); if (!element) throw new Error('F11_UI_INPUT_MISSING'); element.value=String(value); element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true})); } return true; })()`)
}

async function clickAction(page, action, timeoutMs = 15_000) {
  const before = await page.evaluate(`Number(document.getElementById('result')?.dataset.sequence ?? 0)`)
  const snapshot = await page.evaluate(`(() => { const button=document.querySelector('[data-action="${action}"]'); if (!button) return null; const rect=button.getBoundingClientRect(); const style=getComputedStyle(button); const x=rect.left+rect.width/2, y=rect.top+rect.height/2; const hit=x>=0&&y>=0&&x<innerWidth&&y<innerHeight?document.elementFromPoint(x,y):null; return {x,y,width:rect.width,height:rect.height,actionable:button.isConnected&&!button.disabled&&style.display!=='none'&&style.visibility==='visible'&&rect.width>0&&rect.height>0&&Boolean(hit)&&(hit===button||button.contains(hit))}; })()`)
  if (!snapshot?.actionable) throw new Error('F11_UI_ACTION_NOT_VISIBLE')
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: snapshot.x, y: snapshot.y })
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: snapshot.x, y: snapshot.y, button: 'left', buttons: 1, clickCount: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: snapshot.x, y: snapshot.y, button: 'left', buttons: 0, clickCount: 1 })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await page.evaluate(`(() => { const element=document.getElementById('result'); if (!element || Number(element.dataset.sequence ?? 0) <= ${before}) return null; try { return JSON.parse(element.textContent); } catch { return { ok:false, code:'F11_UI_RESULT_INVALID' }; } })()`)
    if (value) return value
    await delay(50)
  }
  throw new Error('F11_UI_ACTION_TIMEOUT')
}

function buildUiIdentityExpression() {
  return `(() => ({ url:location.href, isElectron:window.ztools?.isElectron?.()===true,
    hasProcessApi:typeof window.ztools?.process?.list==='function'&&typeof window.ztools?.process?.getInfo==='function'&&
      typeof window.ztools?.process?.exists==='function'&&typeof window.ztools?.process?.start==='function'&&
      typeof window.ztools?.process?.wait==='function'&&typeof window.ztools?.process?.kill==='function',
    hasChooser:typeof window.ztools?.win?.showOpenDialog==='function', nodeType:typeof process, requireType:typeof require }))()`
}

async function portIsClosed(port) {
  return await new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); resolve(false) })
    socket.once('timeout', () => { socket.destroy(); resolve(false) })
    socket.once('error', error => resolve(error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH'))
  })
}

async function verifyPortsClosed() {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await portIsClosed(ports.cdp) && await portIsClosed(ports.inspect)) return { status: 'PASS', cdp: ports.cdp, inspect: ports.inspect }
    await delay(150)
  }
  return { status: 'FAIL', cdp: ports.cdp, inspect: ports.inspect }
}

async function maybeFallbackCleanup(expected, report, label) {
  const before = queryCimProcess(expected.pid)
  const identity = before ? cimIdentity(before, expected) : { status: 'NOT_PRESENT' }
  if (identity.status !== 'PASS') return { attempted: false, reason: identity.status === 'NOT_PRESENT' ? 'ALREADY_ABSENT' : 'IDENTITY_NO_LONGER_MATCHES' }
  report.cleanupFailures.push(`${label}_OWNED_PROCESS_NOT_CLEANED`)
  const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
  const result = spawnSync(taskkill, ['/PID', String(expected.pid), '/F'], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 })
  const gone = await waitForFixtureGone(expected, 8000)
  return { attempted: true, reason: 'LIFECYCLE_FAILURE_ALREADY_RECORDED', taskkillExitCode: result.status, gone, cleanupPassNotClaimed: true }
}

async function buildReportBase(runId, runRoot) {
  return {
    schemaVersion: 1,
    runId,
    status: 'IN_PROGRESS',
    scope: 'F11 Windows SDK1 normal Electron app process chain development test',
    productionZToolsAcceptance: false,
    completeF11Card: false,
    macOS: 'NOT_RUN',
    nativeDialogUI: 'NOT_RUN_MAIN_ONE_SHOT_TEST_REPLACEMENT',
    runtime: { processPlatform: process.platform, processArch: process.arch, ports, sourceSnapshot: sourceSnapshot() },
    paths: { runRoot, report: path.join(runRoot, 'report.json'), pluginBuildRun: path.join(pluginRoot, '.build-runs', runId) },
    phases: {},
    checks: {},
    cleanupFailures: []
  }
}

async function runPreflight() {
  const runId = randomUUID()
  const runRoot = path.join(clientRoot, 'out-test', 'windows-normal-app-process-chain', runId)
  await fsp.mkdir(path.join(runRoot, 'fixture'), { recursive: true })
  const report = await buildReportBase(runId, runRoot)
  const writeReport = () => fs.writeFileSync(report.paths.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  try {
    report.checks.fixtureCompile = compileFixture(path.join(runRoot, 'fixture', 'ProcessFixture.exe'))
    report.runtime.fixture = { path: path.join(runRoot, 'fixture', 'ProcessFixture.exe'), sha256: shaFile(path.join(runRoot, 'fixture', 'ProcessFixture.exe')),
      pe: report.checks.fixtureCompile.pe }
    report.checks.zip = await writeRuntimeZip(runId)
    report.phases.preflight = { status: 'PASS', appStarted: false, portsOpened: false, csharpCompileAndPe: 'PASS', exactPluginZipTreeAndHashes: 'PASS' }
    report.status = 'PASS'
  } catch (error) {
    report.status = 'FAIL'
    report.failure = { phase: 'preflight-only', code: codeOf(error) }
  } finally {
    report.runtime.sourceSnapshotAfter = sourceSnapshot()
    if (Object.keys(report.runtime.sourceSnapshot).some(key => report.runtime.sourceSnapshot[key] !== report.runtime.sourceSnapshotAfter[key])) {
      report.cleanupFailures.push('SOURCE_FINGERPRINT_CHANGED_DURING_PREFLIGHT')
      report.status = 'FAIL'
    }
    writeReport()
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, runId, reportPath: report.paths.report, pluginZip: report.checks.zip?.path ?? null, failure: report.failure ?? null })}\n`)
  if (report.status !== 'PASS') process.exitCode = 1
}

async function run() {
  let parsed
  try { parsed = parseProcessChainArgs(process.argv.slice(2)) }
  catch (error) { process.stderr.write(`${codeOf(error)}\n`); process.exitCode = 2; return }
  if (parsed.help) {
    process.stdout.write('Usage: node scripts/test-windows-normal-app-process-chain.mjs --preflight-only | --execute-normal-app\n')
    return
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') { process.stderr.write('F11_WINDOWS_X64_REQUIRED\n'); process.exitCode = 2; return }
  if (parsed.preflightOnly) { await runPreflight(); return }
  const runId = randomUUID()
  const runRoot = path.join(clientRoot, 'out-test', 'windows-normal-app-process-chain', runId)
  await fsp.mkdir(path.join(runRoot, 'fixture'), { recursive: true })
  const report = await buildReportBase(runId, runRoot)
  let session
  let zipServer
  let fixtureExe
  let ownedFixture
  let appStoppedByLifecycle = false
  const versions = readVersions()
  const appRoot = clientRoot
  const executable = path.join(clientRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  const harness = new WindowsNormalAppHarness({ appRoot, executable, outputRoot: runRoot, versions, ports })
  const writeReport = () => fs.writeFileSync(report.paths.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  let phase = 'fixture-build'
  try {
    report.runtime.versions = versions
    report.checks.fixtureCompile = compileFixture(path.join(runRoot, 'fixture', 'ProcessFixture.exe'))
    fixtureExe = path.join(runRoot, 'fixture', 'ProcessFixture.exe')
    report.runtime.fixture = { path: fixtureExe, sha256: shaFile(fixtureExe), pe: report.checks.fixtureCompile.pe }
    report.checks.zip = await writeRuntimeZip(runId)
    phase = 'normal-app-start'
    const profile = harness.createProfile(path.join(runRoot, 'profile'))
    report.phases.start = { status: 'IN_PROGRESS', ports, profileRoot: path.join(runRoot, 'profile') }
    session = await harness.start({ profile, phase: 'f11ProcessChain', report })
    report.phases.start = { status: 'PASS', mainPid: session.child.pid, mainIdentity: session.mainIdentity,
      rendererIdentity: session.rendererIdentity, inspectorTargetId: session.inspectorTargetId,
      cdpPort: ports.cdp, inspectPort: ports.inspect, launchArguments: session.launchArguments }
    phase = 'test-plugin-install-open'
    zipServer = await startLoopbackZipServer(report.checks.zip, `${pluginId}.zip`, runId)
    report.checks.install = await harness.install(session, { pluginId, zipPath: report.checks.zip.path,
      zipInfo: report.checks.zip, zipUrl: zipServer.url, version: pluginVersion, pluginRoot })
    report.checks.zipRequests = zipServer.requests
    const opened = await harness.open(session, pluginId)
    const page = opened.page
    const wrongSdkPathProbe = await page.evaluate(`(async () => { const url='ztools://plugins/sdk/ztools-api.js'; try { const response=await fetch(url,{cache:'no-store'}); return { requestedUrl:url, responseUrl:response.url, status:response.status, ok:response.ok }; } catch (error) { return { requestedUrl:url, fetchRejected:true, errorName:typeof error?.name==='string'?error.name:'Error' }; } })()`)
    report.checks.pluginResourceRouting = { expectedFailureUrl: 'ztools://plugins/sdk/ztools-api.js',
      incorrectRootRelativeSdkProbe: wrongSdkPathProbe, correctSharedSdkUrls: ['ztools://web/sdk/ztools-api.js', 'ztools://web/sdk/plugin-sdk.js'],
      pluginEntryUrl: `ztools://plugins/${pluginId}/app.js` }
    if (wrongSdkPathProbe?.status !== 404) fail('F11_PLUGIN_SCOPE_ROUTE_PROBE_UNEXPECTED')
    const uiIdentity = await page.evaluate(buildUiIdentityExpression())
    if (!uiIdentity.isElectron || !uiIdentity.hasProcessApi || !uiIdentity.hasChooser || uiIdentity.nodeType !== 'undefined' || uiIdentity.requireType !== 'undefined') fail('F11_PLUGIN_RUNTIME_API_IDENTITY_INVALID')
    report.checks.pluginOpen = { status: 'PASS', targetId: opened.target.id, url: opened.target.url, commitProof: opened.commitProof, identity: uiIdentity }
    const mainPid = session.child.pid

    phase = 'process-list-info-exists'
    await setUiInputs(page, { 'main-pid': mainPid, 'fixture-pid': 0 })
    const listed = await clickAction(page, 'list')
    if (listed.ok !== true || !Number.isSafeInteger(listed.value?.totalCount) || listed.value.totalCount < 1 ||
        listed.value.mainIncluded !== true || !Array.isArray(listed.value.matchingRows) || listed.value.matchingRows.length !== 1 ||
        listed.value.matchingRows[0].pid !== mainPid || listed.value.matchingRows[0].role !== 'isolated-main') fail('F11_PROCESS_LIST_MAIN_ROW_INVALID')
    report.checks.processList = { status: 'PASS', totalCount: listed.value.totalCount, matchingRows: listed.value.matchingRows }
    await setUiInputs(page, { 'pid': mainPid })
    const info = await clickAction(page, 'info')
    if (info.ok !== true || info.value?.success !== true || info.value?.data?.pid !== mainPid || typeof info.value.data.fieldAvailability?.path !== 'boolean') fail('F11_PROCESS_INFO_RESPONSE_INVALID')
    report.checks.processInfo = { status: 'PASS', responseKeys: Object.keys(info.value).sort(), dataKeys: Object.keys(info.value.data).sort(), pid: info.value.data.pid,
      fieldAvailability: info.value.data.fieldAvailability }
    const exists = await clickAction(page, 'exists')
    if (exists.ok !== true || exists.value?.success !== true || exists.value?.data?.exists !== true) fail('F11_PROCESS_EXISTS_RESPONSE_INVALID')
    report.checks.processExistsMain = { status: 'PASS', responseKeys: Object.keys(exists.value).sort(), value: exists.value.data.exists }
    await setUiInputs(page, { pid: mainPid })
    const mainKill = await clickAction(page, 'kill-main')
    if (mainKill.ok !== false || processErrorCode(mainKill) !== 'PERMISSION_DENIED') fail('F11_UNOWNED_MAIN_KILL_NOT_REJECTED')
    if (session.child.exitCode !== null || session.child.signalCode !== null) fail('F11_MAIN_PROCESS_CHANGED_AFTER_UNOWNED_KILL')
    report.checks.unownedMainKill = { status: 'PASS', errorCode: mainKill.code, isolatedMainStillOwned: true }

    phase = 'authorization-chooser'
    await setUiInputs(page, { 'exe-path': fixtureExe, mode: 'hold', duration: 110_000, 'exit-code': 23 })
    const unauthorizedStart = await clickAction(page, 'start')
    if (unauthorizedStart.ok !== false || processErrorCode(unauthorizedStart) !== 'PERMISSION_DENIED') fail('F11_UNAUTHORIZED_EXECUTABLE_NOT_REJECTED')
    report.checks.unauthorizedStart = { status: 'PASS', errorCode: unauthorizedStart.code, spawnedPid: null }
    const grantOne = async () => {
      const installed = await session.inspector.evaluate(buildDialogInstallExpression(opened.target.url, fixtureExe), { timeoutMs: 5000 })
      if (installed?.installed !== true || installed.oneShot !== true) fail('F11_DIALOG_OVERRIDE_NOT_INSTALLED')
      const chosen = await clickAction(page, 'choose-executable')
      if (chosen.ok !== true || !chosen.value) fail('F11_PUBLIC_CHOOSER_CALL_FAILED')
      const shape = parseChooserSelection(chosen.value, fixtureExe)
      const state = await session.inspector.evaluate(buildDialogStateExpression(false), { timeoutMs: 5000 })
      const cleanup = await session.inspector.evaluate(buildDialogStateExpression(true), { timeoutMs: 5000 })
      if (state?.present !== true || state.calls !== 1 || state.restored !== true || state.ownerMatched !== true || state.propertiesMatched !== true ||
          cleanup?.removed !== true || cleanup.restored !== true || cleanup.exactOriginal !== true) fail('F11_DIALOG_OVERRIDE_SCOPE_OR_RESTORE_INVALID')
      return { ...shape, dialogOverride: { ownerMatched: state.ownerMatched, propertiesMatched: state.propertiesMatched, calls: state.calls,
        restoredBeforeReturn: state.restored, exactOriginalRestored: cleanup.exactOriginal, removed: cleanup.removed } }
    }
    report.checks.authorization = await grantOne()

    phase = 'owned-process-lifecycle'
    const startHold = async () => {
      await setUiInputs(page, { 'exe-path': fixtureExe, mode: 'hold', duration: 110_000, 'exit-code': 23 })
      const started = await clickAction(page, 'start')
      if (started.ok !== true || started.value?.success !== true || !Number.isSafeInteger(started.value.pid) || started.value.pid <= 0) fail('F11_OWNED_FIXTURE_START_INVALID')
      const identity = await waitForFixtureIdentity(started.value.pid, mainPid, fixtureExe)
      ownedFixture = identity
      return { started, identity }
    }
    const hold = await startHold()
    await setUiInputs(page, { 'main-pid': mainPid, 'fixture-pid': hold.identity.pid })
    const listWithFixture = await clickAction(page, 'list')
    if (listWithFixture.ok !== true || listWithFixture.value.mainIncluded !== true || listWithFixture.value.fixtureIncluded !== true) fail('F11_PROCESS_LIST_OWNED_FIXTURE_ROW_MISSING')
    report.checks.processListOwnedFixture = { status: 'PASS', totalCount: listWithFixture.value.totalCount, matchingRows: listWithFixture.value.matchingRows }
    await setUiInputs(page, { 'pid': hold.identity.pid, timeout: 600 })
    const timedWait = await clickAction(page, 'wait')
    if (timedWait.ok !== false || timedWait.code !== 'REQUEST_TIMEOUT') fail('F11_PROCESS_WAIT_TIMEOUT_NOT_REPORTED')
    const afterTimeoutExists = await clickAction(page, 'exists')
    const afterTimeoutRow = queryCimProcess(hold.identity.pid)
    const afterTimeoutIdentity = cimIdentity(afterTimeoutRow, hold.identity)
    if (afterTimeoutExists.ok !== true || afterTimeoutExists.value?.data?.exists !== true || afterTimeoutIdentity.status !== 'PASS') fail('F11_WAIT_TIMEOUT_KILLED_OR_CHANGED_OWNED_PROCESS')
    report.checks.waitTimeoutDoesNotKill = { status: 'PASS', errorCode: timedWait.code, exists: afterTimeoutExists.value.data.exists,
      fixtureIdentityAfterTimeout: afterTimeoutIdentity }
    await setUiInputs(page, { pid: hold.identity.pid })
    const killed = await clickAction(page, 'kill-owned')
    if (killed.ok !== true || killed.value?.success !== true) fail('F11_OWNED_PROCESS_KILL_FAILED')
    await setUiInputs(page, { pid: hold.identity.pid, timeout: 10_000 })
    const killedWait = await clickAction(page, 'wait', 12_000)
    if (killedWait.ok !== true || killedWait.value?.success !== true || !Number.isSafeInteger(killedWait.value?.data?.exitCode)) fail('F11_OWNED_KILL_WAIT_RESPONSE_INVALID')
    const killedExists = await clickAction(page, 'exists')
    const killedGone = await waitForFixtureGone(hold.identity)
    if (killedExists.ok !== true || killedExists.value?.data?.exists !== false || killedGone.status !== 'PASS') fail('F11_OWNED_KILLED_PROCESS_NOT_GONE')
    report.checks.ownedKillWait = { status: 'PASS', killResult: killed.value, waitResult: killedWait.value, exists: killedExists.value.data.exists,
      cimAfterKill: killedGone }
    ownedFixture = null

    await setUiInputs(page, { 'exe-path': fixtureExe, mode: 'exit', duration: 15_000, 'exit-code': 23 })
    const normalExitStarted = await clickAction(page, 'start')
    if (normalExitStarted.ok !== true || normalExitStarted.value?.success !== true || !Number.isSafeInteger(normalExitStarted.value.pid)) fail('F11_NORMAL_EXIT_START_INVALID')
    const normalExitIdentity = await waitForFixtureIdentity(normalExitStarted.value.pid, mainPid, fixtureExe)
    await setUiInputs(page, { pid: normalExitIdentity.pid, timeout: 25_000 })
    const normalExitWait = await clickAction(page, 'wait', 27_000)
    if (normalExitWait.ok !== true || normalExitWait.value?.success !== true || normalExitWait.value?.data?.exitCode !== 23) fail('F11_NORMAL_EXIT_WAIT_INVALID')
    const normalExitExists = await clickAction(page, 'exists')
    const normalExitGone = await waitForFixtureGone(normalExitIdentity)
    if (normalExitExists.ok !== true || normalExitExists.value?.data?.exists !== false || normalExitGone.status !== 'PASS') fail('F11_NORMAL_EXIT_NOT_GONE')
    report.checks.normalExitWait = { status: 'PASS', waitResult: normalExitWait.value, exists: normalExitExists.value.data.exists, cimAfterExit: normalExitGone }

    phase = 'owner-close-cleanup'
    const ownerCloseChild = await startHold()
    const ownerClose = await harness.close(session, pluginId)
    const ownerCleanup = await waitForFixtureGone(ownerCloseChild.identity)
    report.checks.ownerCloseCleanup = { status: ownerCleanup.status, closeResult: ownerClose, childBeforeClose: ownerCloseChild.identity,
      childAfterClose: ownerCleanup, ownerDestroyedByPublicClose: ownerClose.remainingTargets === 0 }
    if (ownerCleanup.status !== 'PASS') {
      await maybeFallbackCleanup(ownerCloseChild.identity, report, 'owner-close')
      fail('F11_OWNER_CLOSE_DID_NOT_CLEAN_OWNED_PROCESS')
    }
    ownedFixture = null

    phase = 'owner-reopen-retry'
    const reopened = await harness.open(session, pluginId)
    const retryUiIdentity = await reopened.page.evaluate(buildUiIdentityExpression())
    if (!retryUiIdentity.isElectron || !retryUiIdentity.hasProcessApi) fail('F11_PLUGIN_REOPEN_RUNTIME_INVALID')
    const retryGrant = await (async () => {
      const temporaryOpened = { ...opened, target: reopened.target, page: reopened.page }
      const installed = await session.inspector.evaluate(buildDialogInstallExpression(reopened.target.url, fixtureExe), { timeoutMs: 5000 })
      if (installed?.installed !== true) fail('F11_RETRY_DIALOG_OVERRIDE_NOT_INSTALLED')
      const chosen = await clickAction(reopened.page, 'choose-executable')
      const shape = parseChooserSelection(chosen.value, fixtureExe)
      const state = await session.inspector.evaluate(buildDialogStateExpression(false), { timeoutMs: 5000 })
      const cleanup = await session.inspector.evaluate(buildDialogStateExpression(true), { timeoutMs: 5000 })
      if (state?.calls !== 1 || state.restored !== true || state.ownerMatched !== true || state.propertiesMatched !== true || cleanup?.exactOriginal !== true || cleanup?.removed !== true) fail('F11_RETRY_DIALOG_RESTORE_INVALID')
      return { ...shape, dialogOverrideRestored: true }
    })()
    await setUiInputs(reopened.page, { 'exe-path': fixtureExe, mode: 'hold', duration: 110_000, 'exit-code': 23 })
    const retryStarted = await clickAction(reopened.page, 'start')
    if (retryStarted.ok !== true || retryStarted.value?.success !== true || !Number.isSafeInteger(retryStarted.value.pid)) fail('F11_REOPEN_RETRY_START_INVALID')
    const retryIdentity = await waitForFixtureIdentity(retryStarted.value.pid, mainPid, fixtureExe)
    report.checks.ownerReopenRetry = { status: 'PASS', newTargetId: reopened.target.id, chooser: retryGrant, started: retryStarted.value, identity: retryIdentity }
    ownedFixture = retryIdentity

    phase = 'app-stop-owned-cleanup'
    report.checks.appStop = { status: 'IN_PROGRESS', ownedFixture: retryIdentity }
    const stopped = await harness.stop(session)
    session = null
    appStoppedByLifecycle = true
    const appStopCleanup = await waitForFixtureGone(retryIdentity)
    const closedPorts = await verifyPortsClosed()
    report.checks.appStop = { status: stopped.cleanupConfirmed && appStopCleanup.status === 'PASS' && closedPorts.status === 'PASS' ? 'PASS' : 'FAIL',
      harnessStop: stopped, ownedFixtureAfterAppQuit: appStopCleanup, ports: closedPorts,
      assertionOrder: ['request-normal-app-quit', 'observe-harness-stop', 'query-exact-owned-fixture-pid', 'verify-ports'] }
    if (appStopCleanup.status !== 'PASS') await maybeFallbackCleanup(retryIdentity, report, 'app-stop')
    if (report.checks.appStop.status !== 'PASS') fail('F11_APP_STOP_OWNED_PROCESS_CLEANUP_FAILED')
    ownedFixture = null
    await closeLoopbackZipServer(zipServer.server)
    zipServer = null
    report.runtime.sourceSnapshotAfter = sourceSnapshot()
    report.status = Object.values(report.checks).every(value => !value || value.status === undefined || value.status === 'PASS') ? 'PASS' : 'FAIL'
  } catch (error) {
    report.status = 'FAIL'
    report.failure = { phase, code: codeOf(error) }
    if (session && !appStoppedByLifecycle) {
      try {
        const stopped = await harness.stop(session)
        session = null
        report.checks.emergencyHarnessStop = stopped
      } catch (stopError) {
        report.cleanupFailures.push(`HARNESS_STOP_${codeOf(stopError)}`)
      }
    }
    if (ownedFixture) {
      try {
        const gone = await waitForFixtureGone(ownedFixture, 1000)
        report.checks.finalOwnedFixtureObservation = gone
        if (gone.status !== 'PASS') await maybeFallbackCleanup(ownedFixture, report, 'final-cleanup')
      } catch (cleanupError) { report.cleanupFailures.push(`FIXTURE_OBSERVATION_${codeOf(cleanupError)}`) }
    }
    if (zipServer) {
      try { await closeLoopbackZipServer(zipServer.server); zipServer = null }
      catch (closeError) { report.cleanupFailures.push(`ZIP_SERVER_CLOSE_${codeOf(closeError)}`) }
    }
    report.runtime.sourceSnapshotAfter = sourceSnapshot()
  } finally {
    if (session) {
      try { report.checks.finalHarnessStop = await harness.stop(session); session = null }
      catch (stopError) { report.cleanupFailures.push(`FINAL_HARNESS_STOP_${codeOf(stopError)}`) }
    }
    if (zipServer) {
      try { await closeLoopbackZipServer(zipServer.server); zipServer = null }
      catch (closeError) { report.cleanupFailures.push(`FINAL_ZIP_SERVER_CLOSE_${codeOf(closeError)}`) }
    }
    if (!report.runtime.sourceSnapshotAfter) report.runtime.sourceSnapshotAfter = sourceSnapshot()
    if (Object.keys(report.runtime.sourceSnapshot).some(key => report.runtime.sourceSnapshot[key] !== report.runtime.sourceSnapshotAfter[key])) {
      report.cleanupFailures.push('SOURCE_FINGERPRINT_CHANGED_DURING_RUN')
      report.status = 'FAIL'
    }
    report.cleanupFailures.length && (report.status = 'FAIL')
    writeReport()
  }
  process.stdout.write(`${JSON.stringify({ status: report.status, runId, reportPath: report.paths.report, failure: report.failure ?? null })}\n`)
  if (report.status !== 'PASS') process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch(error => { process.stderr.write(`${codeOf(error)}\n`); process.exitCode = 1 })
}
