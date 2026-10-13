import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import yauzl from 'yauzl'
import { inspectMacApp, parseMacTestArguments } from './macos-preflight.mjs'
import { CdpClient } from './lib/normal-app-preboot-isolation.mjs'
import { startMacNormalDatabaseChainSession, stopMacNormalDatabaseChainSession } from './macos-app-integration.mjs'
import { isPluginTarget } from './macos-plugin-baseline.mjs'

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(clientRoot, '..')
const pluginRoot = path.join(repositoryRoot, 'plugins', 'create-plugin')
const runnerPath = fileURLToPath(import.meta.url)
const TODO_TARGET_ID = 'macos-electron-any'

function safeErrorCode(error) {
  const value = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : ''
  return /^[A-Z0-9_]{1,96}$/.test(value) ? value : 'MAC_NORMAL_APP_DATABASE_CHAIN_FAILED'
}

export function parseMacDatabaseChainArguments(argv) {
  const remaining = []
  let zip
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const name = argument.split('=')[0]
    if (name !== '--zip') {
      remaining.push(argument)
      continue
    }
    if (zip !== undefined) throw new Error('DUPLICATE_ZIP')
    zip = argument.includes('=') ? argument.slice(name.length + 1) : argv[++index]
    if (!zip || zip.startsWith('--')) throw new Error('ZIP_REQUIRED')
  }
  if (!zip || !path.isAbsolute(zip)) throw new Error('ZIP_ABSOLUTE_PATH_REQUIRED')
  return { ...parseMacTestArguments(remaining), zip }
}

function validateZipEntryName(name) {
  if (typeof name !== 'string' || !name || name.includes('\0') || name.includes('\\') || name.startsWith('/') ||
      /^[A-Za-z]:/.test(name)) return false
  const directory = name.endsWith('/')
  const segments = (directory ? name.slice(0, -1) : name).split('/')
  return segments.length > 0 && segments.every(segment => segment && segment !== '.' && segment !== '..')
}

function readArchiveManifest(zipPath, yauzlApi = yauzl) {
  return new Promise((resolve, reject) => {
    yauzlApi.open(zipPath, { lazyEntries: true, autoClose: true, decodeStrings: true,
      strictFileNames: true, validateEntrySizes: true }, (openError, archive) => {
      if (openError || !archive) { reject(new Error('ZIP_OPEN_FAILED')); return }
      let settled = false
      let manifestText = null
      let uncompressedBytes = 0
      const names = new Set()
      const fail = code => {
        if (settled) return
        settled = true
        try { archive.close() } catch { /* The original validation error remains authoritative. */ }
        reject(new Error(code))
      }
      archive.once('error', () => fail('ZIP_READ_FAILED'))
      archive.on('entry', entry => {
        if (!validateZipEntryName(entry.fileName)) { fail('ZIP_ENTRY_NAME_INVALID'); return }
        if (names.has(entry.fileName)) { fail('ZIP_DUPLICATE_ENTRY'); return }
        names.add(entry.fileName)
        const mode = ((entry.externalFileAttributes ?? 0) >>> 16) & 0xffff
        if ((mode & 0o170000) === 0o120000) { fail('ZIP_SYMLINK_REJECTED'); return }
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > 100 * 1024 * 1024) {
          fail('ZIP_ENTRY_SIZE_INVALID'); return
        }
        uncompressedBytes += entry.uncompressedSize
        if (uncompressedBytes > 256 * 1024 * 1024) { fail('ZIP_UNCOMPRESSED_SIZE_LIMIT'); return }
        if (entry.fileName !== 'plugin.json') { archive.readEntry(); return }
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail('ZIP_MANIFEST_READ_FAILED'); return }
          const chunks = []
          let size = 0
          stream.on('data', chunk => {
            size += chunk.length
            if (size > 256 * 1024) { fail('ZIP_MANIFEST_SIZE_LIMIT'); return }
            chunks.push(chunk)
          })
          stream.once('error', () => fail('ZIP_MANIFEST_READ_FAILED'))
          stream.once('end', () => {
            if (settled) return
            manifestText = Buffer.concat(chunks).toString('utf8')
            archive.readEntry()
          })
        })
      })
      archive.once('end', () => {
        if (settled) return
        settled = true
        let manifest
        try { manifest = JSON.parse(manifestText ?? '') }
        catch { reject(new Error('ZIP_MANIFEST_INVALID')); return }
        resolve({ manifest, entryNames: [...names], uncompressedBytes })
      })
      archive.readEntry()
    })
  })
}

function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function assertNoSymlinkPath(base, target, fsApi) {
  const relative = path.relative(base, target)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('ZIP_OUTSIDE_BUILD_RUN')
  let cursor = base
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment)
    const info = fsApi.lstatSync(cursor)
    if (info.isSymbolicLink()) throw new Error('ZIP_PATH_CONTAINS_SYMLINK')
  }
}

export async function validateMacTodoPluginZip(zipPath, createPluginRoot = pluginRoot, {
  fsApi = fs, readArchive = value => readArchiveManifest(value)
} = {}) {
  if (typeof zipPath !== 'string' || !path.isAbsolute(zipPath)) throw new Error('ZIP_PATH_MUST_BE_ABSOLUTE')
  const resolved = path.resolve(zipPath)
  const pluginDirectory = path.resolve(createPluginRoot)
  const buildRunsRoot = path.join(pluginDirectory, '.build-runs')
  const relative = path.relative(buildRunsRoot, resolved)
  const segments = relative.split(path.sep)
  if (!isWithin(buildRunsRoot, resolved) || segments.length !== 3 || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(segments[0]) ||
      segments[1] !== 'zips' || !/^todo-[0-9A-Za-z.+-]+-macos-electron-any\.zip$/i.test(segments[2])) {
    throw new Error('ZIP_OUTSIDE_FRESH_MAC_PLUGIN_RUN')
  }
  const pluginInfo = fsApi.lstatSync(pluginDirectory)
  const buildRunsInfo = fsApi.lstatSync(buildRunsRoot)
  if (!pluginInfo.isDirectory() || pluginInfo.isSymbolicLink() || !buildRunsInfo.isDirectory() || buildRunsInfo.isSymbolicLink() ||
      fsApi.realpathSync(buildRunsRoot) !== path.join(fsApi.realpathSync(pluginDirectory), '.build-runs')) {
    throw new Error('PLUGIN_BUILD_RUN_ROOT_INVALID')
  }
  assertNoSymlinkPath(buildRunsRoot, resolved, fsApi)
  const zipStat = fsApi.lstatSync(resolved)
  if (!zipStat.isFile() || zipStat.isSymbolicLink() || zipStat.size < 1 || zipStat.size > 100 * 1024 * 1024 ||
      fsApi.realpathSync(resolved) !== resolved) throw new Error('ZIP_INVALID')

  const sourceManifestPath = path.join(pluginDirectory, 'src', 'plugins', 'todo', 'plugin.json')
  const sourceManifestStat = fsApi.lstatSync(sourceManifestPath)
  if (!sourceManifestStat.isFile() || sourceManifestStat.isSymbolicLink()) throw new Error('TODO_SOURCE_MANIFEST_INVALID')
  const sourceManifest = JSON.parse(fsApi.readFileSync(sourceManifestPath, 'utf8'))
  if (sourceManifest.id !== 'todo' || typeof sourceManifest.version !== 'string' ||
      !/^[0-9A-Za-z.+-]{1,64}$/.test(sourceManifest.version) ||
      !Array.isArray(sourceManifest.targets) || !sourceManifest.targets.some(target => target?.id === TODO_TARGET_ID &&
        target.platform === 'macos' && target.runtime === 'electron' && target.arch === 'any')) {
    throw new Error('TODO_SOURCE_MAC_TARGET_INVALID')
  }
  if (path.basename(resolved) !== `todo-${sourceManifest.version}-${TODO_TARGET_ID}.zip`) throw new Error('TODO_ZIP_VERSION_MISMATCH')
  const archive = await readArchive(resolved)
  const manifest = archive?.manifest
  const targets = manifest?.targets
  if (manifest?.id !== 'todo' || manifest.version !== sourceManifest.version || !Array.isArray(targets) || targets.length !== 1 ||
      targets[0]?.id !== TODO_TARGET_ID || targets[0]?.platform !== 'macos' || targets[0]?.runtime !== 'electron' ||
      targets[0]?.arch !== 'any' || !Array.isArray(manifest.nativeComponents) || manifest.nativeComponents.length !== 0) {
    throw new Error('TODO_ZIP_TARGET_MISMATCH')
  }
  if (!Array.isArray(archive.entryNames) || !archive.entryNames.includes('plugin.json') ||
      !archive.entryNames.includes('index.html') || !archive.entryNames.includes('app.js')) throw new Error('TODO_ZIP_FILES_MISSING')
  const realPath = fsApi.realpathSync(resolved)
  return { path: realPath, fileSize: zipStat.size, checksum: createHash('sha256').update(fsApi.readFileSync(realPath)).digest('hex'),
    buildRun: segments[0], targetId: TODO_TARGET_ID, manifest, entryCount: archive.entryNames.length,
    uncompressedBytes: archive.uncompressedBytes }
}

export function createMacDatabaseProfile(outputRoot, { fsApi = fs, id = randomUUID() } = {}) {
  const root = path.resolve(outputRoot)
  const outputStat = fsApi.lstatSync(root)
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || fsApi.realpathSync(root) !== root) {
    throw new Error('NORMAL_APP_OUTPUT_ROOT_INVALID')
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('PROFILE_UUID_INVALID')
  }
  const profiles = path.join(root, 'profiles')
  fsApi.mkdirSync(profiles, { recursive: false })
  const profileRoot = path.join(profiles, id)
  fsApi.mkdirSync(profileRoot, { recursive: false })
  const profile = { root: profileRoot, appDataPath: path.join(profileRoot, 'appData'),
    userDataPath: path.join(profileRoot, 'appData', 'ZTools'), sessionDataPath: path.join(profileRoot, 'sessionData') }
  fsApi.mkdirSync(profile.appDataPath, { recursive: false })
  fsApi.mkdirSync(profile.userDataPath, { recursive: false })
  fsApi.mkdirSync(profile.sessionDataPath, { recursive: false })
  return profile
}

function createFreshOutput(outputRoot, forbiddenRoot, fsApi = fs) {
  if (!path.isAbsolute(outputRoot)) throw new Error('OUTPUT_MUST_BE_ABSOLUTE')
  const resolved = path.resolve(outputRoot)
  const parent = path.dirname(resolved)
  let parentReal
  try {
    if (!fsApi.statSync(parent).isDirectory()) throw new Error('OUTPUT_PARENT_INVALID')
    parentReal = fsApi.realpathSync(parent)
  } catch { throw new Error('OUTPUT_PARENT_INVALID') }
  const canonical = path.join(parentReal, path.basename(resolved))
  if (forbiddenRoot && isWithin(forbiddenRoot, canonical)) throw new Error('OUTPUT_MUST_BE_OUTSIDE_APP')
  if (fsApi.existsSync(canonical)) throw new Error('OUTPUT_MUST_BE_FRESH')
  fsApi.mkdirSync(canonical, { recursive: false })
  return canonical
}

export async function startMacTodoZipServer(zipInfo, runId, { createServer = http.createServer } = {}) {
  if (!zipInfo || typeof zipInfo.path !== 'string' || !Number.isSafeInteger(zipInfo.fileSize) || zipInfo.fileSize < 1 ||
      !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('ZIP_SERVER_INPUT_INVALID')
  const route = `/${runId}/todo.zip`
  const requests = []
  const server = createServer((request, response) => {
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

export async function closeMacTodoZipServer(server) {
  if (!server) return
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

function recordHash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

async function waitFor(read, accept, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(code)
}

async function evaluatePage(page, expression) {
  const evaluated = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (evaluated.exceptionDetails) throw new Error('PAGE_EVALUATION_FAILED')
  if (!evaluated.result || !Object.hasOwn(evaluated.result, 'value')) throw new Error('PAGE_VALUE_UNAVAILABLE')
  return evaluated.result.value
}

async function clickButton(page, label) {
  const deadline = Date.now() + 15_000
  let latest = null
  while (Date.now() < deadline) {
    latest = await evaluatePage(page, `(() => {
      const normalize = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const buttons = [...document.querySelectorAll('button')];
      const expected = ${JSON.stringify(label)}.replace(/\\s+/g, '');
      const ordered = [...new Set([...document.querySelectorAll('.toolbar button'), ...buttons])];
      const button = ordered.find(item => normalize(item.textContent).replace(/\\s+/g, '') === expected &&
        item.getBoundingClientRect().width > 0 && !item.disabled);
      if (!button) return { target: null, buttons: buttons.map(item => normalize(item.textContent)).filter(Boolean).slice(0, 40) };
      button.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = button.getBoundingClientRect();
      return { target: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
        text: normalize(button.innerText || button.textContent) }, buttons: [] };
    })()`)
    if (latest?.target && Number.isFinite(latest.target.x) && Number.isFinite(latest.target.y)) break
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  const target = latest?.target
  if (!target) {
    const error = new Error('TODO_UI_BUTTON_NOT_FOUND')
    error.diagnostic = latest
    throw error
  }
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  return target
}

async function clickAndInsert(page, selector, value) {
  const target = await evaluatePage(page, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element || element.disabled) return null;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`)
  if (!target) throw new Error('TODO_UI_INPUT_NOT_FOUND')
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await page.call('Input.insertText', { text: value })
}

async function installUiEventRecorder(page) {
  await evaluatePage(page, `(() => {
    if (!window.ztools || window.__f12DatabaseEvents) throw new Error('F12_UI_RECORDER_STATE_INVALID');
    const events = [];
    document.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button) return;
      const text = String(button.innerText || button.textContent || '').replace(/\\s+/g, ' ').trim();
      events.push({ text, normalizedText: text.replace(/\\s+/g, ''), isTrusted: event.isTrusted, at: Date.now() });
    }, true);
    window.__f12DatabaseEvents = events;
    return true;
  })()`)
}

async function readTodoState(page, title) {
  return await evaluatePage(page, `(async () => {
    const sdk = window.ztools;
    if (!sdk?.db || typeof sdk.db.setPluginId !== 'function' || typeof sdk.db.allDocs !== 'function') {
      throw new Error('TODO_PUBLIC_DATABASE_SDK_UNAVAILABLE');
    }
    await sdk.db.setPluginId('todo');
    const docs = await sdk.db.allDocs('todo:');
    const item = docs.find(value => value?.title === ${JSON.stringify(title)}) ?? null;
    return { count: docs.length, item, visibleTitles: [...document.querySelectorAll('.todo-title')].map(node => node.innerText.trim()),
      events: [...(window.__f12DatabaseEvents ?? [])] };
  })()`)
}

async function createTodoThroughUi(page, title, description) {
  await installUiEventRecorder(page)
  const open = await clickButton(page, '新增待办')
  await waitFor(() => evaluatePage(page, `Boolean(document.querySelector('.todo-form input'))`), Boolean,
    15_000, 'TODO_CREATE_MODAL_NOT_OPEN')
  await clickAndInsert(page, '.todo-form input', title)
  await clickAndInsert(page, '.todo-form textarea', description)
  const formValues = await evaluatePage(page, `(() => ({ title: document.querySelector('.todo-form input')?.value ?? null,
    description: document.querySelector('.todo-form textarea')?.value ?? null }))()`)
  const save = await clickButton(page, '保存')
  let lastState = null
  let state
  try {
    state = await waitFor(async () => { lastState = await readTodoState(page, title); return lastState },
      value => value?.item?.title === title && value.item.description === description && value.visibleTitles.includes(title),
      20_000, 'TODO_CREATE_NOT_PERSISTED')
  } catch (error) {
    error.code = 'TODO_CREATE_NOT_PERSISTED'
    error.diagnostic = { formTitleMatches: formValues.title === title,
      formDescriptionMatches: formValues.description === description,
      itemId: lastState?.item?._id ?? null, itemTitleMatches: lastState?.item?.title === title,
      visibleTitles: lastState?.visibleTitles ?? [], events: lastState?.events ?? [] }
    throw error
  }
  const trusted = state.events.filter(event => event.normalizedText === '新增待办' || event.normalizedText === '保存')
  if (trusted.length !== 2 || trusted.some(event => event.isTrusted !== true)) throw new Error('TODO_TRUSTED_UI_ACTIONS_NOT_CONFIRMED')
  return { open, save, state, trustedEvents: trusted, formValues }
}

async function findPluginPage(session, pluginId, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const response = await fetchImpl(`http://127.0.0.1:${session.cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) throw new Error('PLUGIN_CDP_HTTP_FAILED')
    const targets = await response.json()
    if (!Array.isArray(targets) || targets.length > 1024) throw new Error('PLUGIN_CDP_TARGET_LIST_INVALID')
    const matches = targets.filter(item => item?.type === 'page' && isPluginTarget(item.url, pluginId))
    if (matches.length > 1) throw new Error('AMBIGUOUS_PLUGIN_CDP_TARGET')
    if (matches.length === 1) {
      const target = matches[0]
      const page = await CdpClient.connect(target.webSocketDebuggerUrl, session.cdpPort, '/devtools/page/')
      await page.call('Runtime.enable')
      await page.call('Page.enable')
      const identity = await waitFor(() => evaluatePage(page, `(() => ({ ready: document.readyState === 'complete', url: location.href,
        isElectron: window.ztools?.isElectron?.() === true, nodeType: typeof process, requireType: typeof require,
        identityType: typeof window.ztools?.sys?.getRuntimeIdentity, dbType: typeof window.ztools?.db }))()`),
      value => value?.ready === true && value.isElectron === true && isPluginTarget(value.url, pluginId),
      30_000, 'PLUGIN_RENDERER_NOT_READY')
      const runtimeIdentity = await evaluatePage(page, 'window.ztools.sys.getRuntimeIdentity()')
      if (identity.nodeType !== 'undefined' || identity.requireType !== 'undefined' || identity.dbType !== 'object' ||
          identity.identityType !== 'function' || runtimeIdentity?.contractVersion !== 1 ||
          runtimeIdentity.target?.platform !== 'macos' || runtimeIdentity.target?.runtime !== 'electron' ||
          runtimeIdentity.target?.arch !== 'universal' || runtimeIdentity.process?.arch !== session.options['expect-process-arch'] ||
          runtimeIdentity.appVersion !== session.preflight.appVersion) {
        page.dispose()
        throw new Error('PLUGIN_RUNTIME_IDENTITY_MISMATCH')
      }
      return { target, page, identity, runtimeIdentity }
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('PLUGIN_CDP_TARGET_TIMEOUT')
}

async function openTodoPlugin(session, { fetchImpl = fetch } = {}) {
  const opened = await evaluatePage(session.mainPage.page, `window.ztools.plugin.open('todo')`)
  if (opened?.success !== true || opened.pluginId !== 'todo' || typeof opened.instanceId !== 'string' || !opened.instanceId) {
    throw new Error('PLUGIN_OPEN_NOT_CONFIRMED')
  }
  const plugin = await findPluginPage(session, 'todo', { fetchImpl })
  return { opened, ...plugin }
}

async function closeTodoPlugin(session, pluginPage, { fetchImpl = fetch } = {}) {
  const closed = await evaluatePage(session.mainPage.page, `window.ztools.plugin.close('todo')`)
  if (closed?.success !== true) throw new Error('PLUGIN_CLOSE_NOT_CONFIRMED')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await fetchImpl(`http://127.0.0.1:${session.cdpPort}/json/list`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) throw new Error('PLUGIN_CDP_HTTP_FAILED')
    const targets = await response.json()
    if (!Array.isArray(targets) || targets.length > 1024) throw new Error('PLUGIN_CDP_TARGET_LIST_INVALID')
    if (!targets.some(item => item?.type === 'page' && isPluginTarget(item.url, 'todo'))) break
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  pluginPage?.dispose()
  return { closed, remainingTargets: 0 }
}

async function installTodoPlugin(session, zipInfo, zipUrl, sourceManifest) {
  const pluginDirectory = path.join(session.profile.appDataPath, 'ZTools', 'Data', 'Plugins', 'todo')
  if (fs.existsSync(pluginDirectory)) throw new Error('PLUGIN_ALREADY_PRESENT_IN_FRESH_PROFILE')
  const accepted = await evaluatePage(session.mainPage.page, `window.ztools.plugin.install('todo', ${JSON.stringify(zipUrl)}, {
    version: ${JSON.stringify(sourceManifest.version)}, checksum: ${JSON.stringify(zipInfo.checksum)}, fileSize: ${zipInfo.fileSize}
  })`)
  if (accepted?.success !== true || typeof accepted.operationId !== 'string' || !accepted.operationId) {
    throw new Error('PLUGIN_INSTALL_NOT_ACCEPTED')
  }
  const installed = await waitFor(() => {
    try {
      const stat = fs.lstatSync(pluginDirectory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null
      const manifest = JSON.parse(fs.readFileSync(path.join(pluginDirectory, 'plugin.json'), 'utf8'))
      const entries = fs.readdirSync(pluginDirectory)
      return manifest.id === 'todo' && manifest.version === sourceManifest.version &&
        entries.includes('index.html') && entries.includes('app.js') ? { manifest, entries } : null
    } catch { return null }
  }, Boolean, 90_000, 'PLUGIN_INSTALL_FILES_NOT_READY')
  const relative = path.relative(path.join(session.profile.appDataPath, 'ZTools', 'Data', 'Plugins'), pluginDirectory)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('INSTALLED_PLUGIN_PATH_NOT_ISOLATED')
  if (!Array.isArray(installed.manifest.targets) || installed.manifest.targets.length !== 1 ||
      installed.manifest.targets[0]?.id !== TODO_TARGET_ID) throw new Error('INSTALLED_PLUGIN_TARGET_MISMATCH')
  const refresh = await evaluatePage(session.mainPage.page, 'window.ztools.plugin.refresh()')
  if (refresh?.success !== true) throw new Error('PLUGIN_LIST_REFRESH_FAILED')
  const names = installed.entries.filter(name => ['plugin.json', 'index.html', 'app.js'].includes(name))
  const hashes = Object.fromEntries(names.map(name => [name,
    createHash('sha256').update(fs.readFileSync(path.join(pluginDirectory, name))).digest('hex')]))
  return { pluginDirectory, manifest: installed.manifest, entries: installed.entries, fileHashes: hashes,
    accepted, refresh, publicSdk: 'window.ztools.plugin.install + refresh' }
}

async function inspectLoadedClassicLevelAddon(session) {
  const snapshot = await session.inspector.evaluate(`(() => {
    const report = process.report?.getReport?.();
    const sharedObjects = Array.isArray(report?.sharedObjects) ? report.sharedObjects : [];
    return { available: Array.isArray(report?.sharedObjects), paths: sharedObjects.filter(value =>
      typeof value === 'string' && /[\\/]classic-level\\.node$/i.test(value)).slice(0, 16) };
  })()`)
  const expectedPath = path.join(session.preflight.appRoot, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules',
    'classic-level', 'prebuilds', 'darwin-x64+arm64', 'classic-level.node')
  const loaded = snapshot.paths?.find(value => path.posix.normalize(value) === path.posix.normalize(expectedPath)) ?? null
  return { status: loaded ? 'PASS' : 'FAIL', code: loaded ? null : 'CLASSIC_LEVEL_ADDON_NOT_LOADED_FROM_APP',
    processReportAvailable: snapshot.available === true, expectedPath, loadedPath: loaded,
    observedPaths: snapshot.paths ?? [], observedAfter: 'public todo database SDK query' }
}

function summarizeIsolation(session) {
  const isolation = session?.isolation
  if (!isolation) return { status: 'NOT_RUN' }
  return { status: isolation.status, childPid: isolation.childPid, executablePath: isolation.executablePath,
    bundleId: isolation.bundleId, entryIdentity: isolation.entryIdentity, profile: isolation.profile,
    pause: isolation.pause, bootstrapSource: isolation.bootstrapSource,
    configuredPaths: isolation.configuredPaths, verifiedPaths: isolation.verifiedPaths,
    resumed: isolation.resumed }
}

function evidenceMarkdown(report) {
  return [
    '# F12 macOS packaged normal App database chain', '',
    `- Run: \`${report.runId}\``, `- Result: **${report.status}**`,
    `- Bundle: \`${report.inputs.bundleId}\` (${report.inputs.processArch})`,
    `- App version: \`${report.inputs.appVersion}\``,
    `- Fresh Mac todo ZIP: \`${report.inputs.todoZip.path}\` (${report.inputs.todoZip.targetId})`,
    `- Isolated profile: \`${report.profileRoot ?? 'not created'}\` (preserved)`,
    `- Main Inspector first-line gate: ${report.phases.firstStart?.isolation?.status ?? 'NOT_RUN'}`,
    `- Main source pause: requested ${report.phases.firstStart?.isolation?.bootstrapSource?.requestedLineNumber ?? 'n/a'}, ` +
      `actual ${report.phases.firstStart?.isolation?.bootstrapSource?.actualLineNumber ?? 'n/a'}, ` +
      `source SHA-256 \`${report.phases.firstStart?.isolation?.bootstrapSource?.sourceSha256 ?? 'n/a'}\``,
    `- Public SDK install/open: ${report.phases.install?.status ?? 'NOT_RUN'} / ${report.phases.pluginOpen?.status ?? 'NOT_RUN'}`,
    `- Trusted UI todo creation: ${report.phases.todoCreate?.status ?? 'NOT_RUN'}`,
    `- Close/reopen and restart: ${report.phases.closeReopen?.status ?? 'NOT_RUN'} / ${report.phases.restartRead?.status ?? 'NOT_RUN'}`,
    `- Database item count: ${report.phases.todoCreate?.count ?? 'NOT_RUN'} → ${report.phases.restartRead?.count ?? 'NOT_RUN'}`,
    `- Record SHA-256: \`${report.phases.todoCreate?.recordSha256 ?? 'NOT_RUN'}\``,
    `- Actual ClassicLevel addon: ${report.phases.classicLevelAddon?.status ?? 'NOT_RUN'}`,
    '',
    'This entry runs only on Darwin against the approved packaged App. Windows returns NOT_RUN before reading paths. The profile and installed synthetic todo data remain available for review. No user database, secrets, imports, or delete operations are used.',
    ''
  ].join('\n')
}

async function writeEvidence(report, { fsApi = fs } = {}) {
  if (!report.output) return { status: 'NOT_RUN' }
  const reportPath = path.join(report.output, 'report.json')
  fsApi.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  const evidenceDirectory = path.join(repositoryRoot, 'docs', 'mac-compat-evidence', 'F12')
  fsApi.mkdirSync(evidenceDirectory, { recursive: true })
  const evidenceJsonPath = path.join(evidenceDirectory, `macos-normal-app-database-chain-${report.runId}.json`)
  const evidenceMarkdownPath = path.join(evidenceDirectory, `macos-normal-app-database-chain-${report.runId}.md`)
  fsApi.writeFileSync(evidenceJsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  fsApi.writeFileSync(evidenceMarkdownPath, evidenceMarkdown(report), { encoding: 'utf8', flag: 'wx' })
  return { status: 'PASS', reportPath, evidenceJsonPath, evidenceMarkdownPath }
}

export async function runMacNormalAppDatabaseChain(argv = process.argv.slice(2), {
  platform = process.platform, inspectApp = inspectMacApp, validateZip = validateMacTodoPluginZip,
  startSession = startMacNormalDatabaseChainSession, stopSession = stopMacNormalDatabaseChainSession,
  startZipServer = startMacTodoZipServer, closeZipServer = closeMacTodoZipServer,
  fsApi = fs, fetchImpl = fetch, writeReport = writeEvidence, stdout = console.log
} = {}) {
  if (platform !== 'darwin') return { status: 'NOT_RUN', caseId: 'F12-MAC-PACKAGED-DATABASE', code: 'DARWIN_REQUIRED',
    appStarted: false, processCreated: false, completeCase: false, macAcceptance: 'NOT_RUN' }

  let options
  try { options = parseMacDatabaseChainArguments(argv) }
  catch { return { status: 'FAIL', caseId: 'F12-MAC-PACKAGED-DATABASE', code: 'INVALID_ARGUMENTS',
    appStarted: false, processCreated: false, completeCase: false } }
  const preflight = inspectApp(options, { platform })
  if (preflight.status !== 'PASS') return { status: preflight.status, caseId: 'F12-MAC-PACKAGED-DATABASE',
    code: preflight.code ?? 'APP_PREFLIGHT_FAILED', appStarted: false, processCreated: false,
    completeCase: false, preflight }
  let zipInfo
  let sourceManifest
  try {
    zipInfo = await validateZip(options.zip, pluginRoot)
    sourceManifest = JSON.parse(fsApi.readFileSync(path.join(pluginRoot, 'src', 'plugins', 'todo', 'plugin.json'), 'utf8'))
  } catch (error) {
    return { status: 'FAIL', caseId: 'F12-MAC-PACKAGED-DATABASE', code: safeErrorCode(error),
      appStarted: false, processCreated: false, completeCase: false, preflight,
      requiredInputs: { app: options.app, zip: options.zip, bundleId: options['bundle-id'],
        minimumOs: options['minimum-os'], expectedProcessArch: options['expect-process-arch'] } }
  }
  let output
  let profile
  try {
    output = createFreshOutput(options.output, preflight.appRoot, fsApi)
    options = { ...options, output }
    profile = createMacDatabaseProfile(output, { fsApi })
  } catch (error) {
    return { status: 'FAIL', caseId: 'F12-MAC-PACKAGED-DATABASE', code: safeErrorCode(error),
      appStarted: false, processCreated: false, completeCase: false, preflight, zipInfo }
  }

  const runId = randomUUID()
  const report = { schemaVersion: 1, runId, caseId: 'F12-MAC-PACKAGED-DATABASE', phase: 2, platform, arch: process.arch,
    status: 'FAIL', scope: 'macos-packaged-normal-app-todo-public-sdk-ui-database-restart', completeCase: false,
    productionZToolsAcceptance: false, macAcceptance: 'IN_PROGRESS', appStarted: false, processCreated: false,
    isolatedAppData: false, isolationConfirmed: false, rendererArbitraryIpcExposed: false,
    rendererNodeExposed: false, startedAt: new Date().toISOString(), updatedAt: null,
    output, profileRoot: profile.root, phases: {},
    inputs: { app: options.app, bundleId: options['bundle-id'], minimumOs: options['minimum-os'],
      processArch: options['expect-process-arch'], appVersion: preflight.appVersion,
      appExecutable: preflight.executable, appExecutableSha256: preflight.executableSha256,
      bundleSlices: preflight.slices, todoZip: { path: zipInfo.path, fileSize: zipInfo.fileSize,
        sha256: zipInfo.checksum, buildRun: zipInfo.buildRun, targetId: zipInfo.targetId,
        entryCount: zipInfo.entryCount, uncompressedBytes: zipInfo.uncompressedBytes } } }
  const sessions = new Set()
  let zipServer
  let todoCreated
  let installedDirectory
  try {
    zipServer = await startZipServer(zipInfo, runId)
    report.phases.loopbackServer = { status: 'PASS', address: '127.0.0.1', port: zipServer.port, route: zipServer.url }
    const first = await startSession({ ...options, profile }, { platform, preflight })
    sessions.add(first)
    report.appStarted = true
    report.processCreated = true
    report.isolatedAppData = first.isolation?.status === 'PASS'
    report.isolationConfirmed = first.isolation?.status === 'PASS' && first.isolation.resumed === true
    report.phases.firstStart = { status: report.isolationConfirmed ? 'PASS' : 'FAIL', ownedPid: first.child?.pid ?? null,
      launchArguments: first.launchArguments, cdpPort: first.cdpPort, inspectorPort: first.inspectPort,
      isolation: summarizeIsolation(first), mainIdentity: first.mainValidation,
      rendererIdentity: first.runtime?.identity ?? null, url: first.mainPage?.target?.url ?? null }
    if (!report.isolationConfirmed) throw new Error('PREBOOT_ISOLATION_NOT_CONFIRMED')

    const installed = await installTodoPlugin(first, zipInfo, zipServer.url, sourceManifest)
    installedDirectory = installed.pluginDirectory
    report.phases.install = { status: 'PASS', ...installed }
    const opened = await openTodoPlugin(first, { fetchImpl })
    report.phases.pluginOpen = { status: 'PASS', targetId: opened.target.id, targetUrl: opened.target.url,
      opened: opened.opened, identity: opened.runtimeIdentity, publicSdk: 'window.ztools.plugin.open' }

    const marker = `F12_MAC_NORMAL_DB_${runId}`
    const markerHash = createHash('sha256').update(marker, 'utf8').digest('hex')
    const title = `F12 Mac todo ${runId.slice(0, 8)}`
    const description = `${marker} sha256:${markerHash}`
    const created = await createTodoThroughUi(opened.page, title, description)
    if (!created.state.item || created.state.item._id !== `todo:${created.state.item.createdAt}`) throw new Error('TODO_PUBLIC_SDK_RECORD_ID_INVALID')
    todoCreated = { title, itemId: created.state.item._id, count: created.state.count, recordHash: recordHash(created.state.item) }
    report.phases.todoCreate = { status: 'PASS', count: created.state.count, itemId: created.state.item._id, title,
      descriptionSha256: createHash('sha256').update(description, 'utf8').digest('hex'), markerSha256: markerHash,
      recordSha256: todoCreated.recordHash, trustedEvents: created.trustedEvents,
      visibleTitle: created.state.visibleTitles.includes(title), formValues: created.formValues,
      publicSdk: 'ztools.db.setPluginId + ztools.db.allDocs', createdThrough: 'trusted CDP mouse/input events' }
    report.phases.classicLevelAddon = await inspectLoadedClassicLevelAddon(first)
    if (report.phases.classicLevelAddon.status !== 'PASS') throw new Error(report.phases.classicLevelAddon.code)

    await closeTodoPlugin(first, opened.page, { fetchImpl })
    const reopened = await openTodoPlugin(first, { fetchImpl })
    const inSession = await waitFor(() => readTodoState(reopened.page, title), state => state?.item?._id === todoCreated.itemId,
      20_000, 'TODO_CLOSE_REOPEN_READ_NOT_FOUND')
    const inSessionHash = recordHash(inSession.item)
    if (inSessionHash !== todoCreated.recordHash || inSession.count !== todoCreated.count || !inSession.visibleTitles.includes(title)) {
      throw new Error('TODO_CLOSE_REOPEN_MISMATCH')
    }
    report.phases.closeReopen = { status: 'PASS', count: inSession.count, itemId: inSession.item._id,
      recordSha256: inSessionHash, hashMatches: true, countMatches: true, visibleTitle: inSession.visibleTitles.includes(title),
      reopenedTargetId: reopened.target.id, publicSdk: 'ztools.db.setPluginId + ztools.db.allDocs' }
    await closeTodoPlugin(first, reopened.page, { fetchImpl })
    const firstStop = await stopSession(first, { requestQuit: true })
    sessions.delete(first)
    report.phases.firstExit = { status: firstStop.normalQuitConfirmed ? 'PASS' : 'FAIL', ...firstStop }
    if (!firstStop.normalQuitConfirmed) throw new Error('FIRST_APP_QUIT_NOT_CONFIRMED')

    const second = await startSession({ ...options, profile }, { platform, preflight })
    sessions.add(second)
    report.phases.restartStart = { status: second.isolation?.status === 'PASS' && second.isolation.resumed === true ? 'PASS' : 'FAIL',
      ownedPid: second.child?.pid ?? null, launchArguments: second.launchArguments,
      isolation: summarizeIsolation(second), mainIdentity: second.mainValidation }
    if (report.phases.restartStart.status !== 'PASS') throw new Error('RESTART_PREBOOT_ISOLATION_NOT_CONFIRMED')
    const restartedPlugin = await openTodoPlugin(second, { fetchImpl })
    const restarted = await waitFor(() => readTodoState(restartedPlugin.page, todoCreated.title),
      state => state?.item?._id === todoCreated.itemId, 20_000, 'TODO_RESTART_READ_NOT_FOUND')
    const restartedHash = recordHash(restarted.item)
    if (restartedHash !== todoCreated.recordHash || restarted.count !== todoCreated.count ||
        !restarted.visibleTitles.includes(todoCreated.title)) throw new Error('TODO_DATABASE_RESTART_MISMATCH')
    report.phases.restartRead = { status: 'PASS', count: restarted.count, itemId: restarted.item._id,
      recordSha256: restartedHash, hashMatches: true, countMatches: true,
      visibleTitle: restarted.visibleTitles.includes(todoCreated.title), rendererIdentity: restartedPlugin.runtimeIdentity,
      publicSdk: 'ztools.db.setPluginId + ztools.db.allDocs' }
    report.phases.classicLevelAddonAfterRestart = await inspectLoadedClassicLevelAddon(second)
    if (report.phases.classicLevelAddonAfterRestart.status !== 'PASS') throw new Error(report.phases.classicLevelAddonAfterRestart.code)
    await closeTodoPlugin(second, restartedPlugin.page, { fetchImpl })
    const secondStop = await stopSession(second, { requestQuit: true })
    sessions.delete(second)
    report.phases.restartExit = { status: secondStop.normalQuitConfirmed ? 'PASS' : 'FAIL', ...secondStop }
    if (!secondStop.normalQuitConfirmed) throw new Error('RESTARTED_APP_QUIT_NOT_CONFIRMED')
    const profilePreserved = fsApi.existsSync(profile.root) && fsApi.existsSync(installedDirectory)
    report.phases.profilePreserved = { status: profilePreserved ? 'PASS' : 'FAIL', root: profile.root,
      appDataPath: profile.appDataPath, pluginDirectory: installedDirectory, retained: profilePreserved }
    const loopbackPass = zipServer.requests.length > 0 && zipServer.requests.every(request => request.status === 200)
    report.phases.loopback = { status: loopbackPass ? 'PASS' : 'FAIL', requests: zipServer.requests }
    if (!profilePreserved || !loopbackPass) throw new Error(!profilePreserved ? 'ISOLATED_PROFILE_NOT_PRESERVED' : 'ZIP_LOOPBACK_REQUEST_INVALID')
    report.status = 'PASS'
    report.completeCase = true
    report.macAcceptance = 'PASS'
  } catch (error) {
    report.failureCode = safeErrorCode(error)
    if (typeof error?.stage === 'string' && /^[a-z0-9-]{1,80}$/i.test(error.stage)) report.failureStage = error.stage
    if (error?.cleanup && typeof error.cleanup === 'object') report.failureCleanup = error.cleanup
    report.failureDiagnostic = { message: String(error?.message ?? '').slice(0, 240),
      ...(error?.diagnostic && typeof error.diagnostic === 'object' ? { details: error.diagnostic } : {}) }
    report.failedAt = new Date().toISOString()
    report.status = 'FAIL'
    report.completeCase = false
    report.macAcceptance = 'FAIL'
  } finally {
    for (const session of [...sessions]) {
      try {
        const stopped = await stopSession(session, { requestQuit: session.isolation?.resumed === true })
        sessions.delete(session)
        report.phases.cleanup ??= []
        report.phases.cleanup.push(stopped)
        if (!stopped.normalQuitConfirmed) {
          report.status = 'FAIL'
          report.completeCase = false
          report.macAcceptance = 'FAIL'
          report.failureCode ??= 'OWNED_APP_CLEANUP_UNCONFIRMED'
        }
      } catch (error) {
        report.status = 'FAIL'
        report.completeCase = false
        report.macAcceptance = 'FAIL'
        report.failureCode ??= safeErrorCode(error)
      }
    }
    if (zipServer) {
      try { await closeZipServer(zipServer.server); report.loopbackServerStopped = true }
      catch { report.loopbackServerStopped = false; report.status = 'FAIL'; report.completeCase = false;
        report.macAcceptance = 'FAIL'; report.failureCode ??= 'LOOPBACK_SERVER_CLOSE_UNCONFIRMED' }
    }
    report.scratchPreserved = true
    report.updatedAt = new Date().toISOString()
    try { report.evidence = await writeReport(report, { fsApi }) }
    catch (error) {
      report.evidence = { status: 'FAIL', code: safeErrorCode(error) }
      report.status = 'FAIL'
      report.completeCase = false
      report.macAcceptance = 'FAIL'
      report.failureCode ??= 'EVIDENCE_WRITE_FAILED'
    }
  }
  stdout(JSON.stringify({ status: report.status, caseId: report.caseId, reportPath: report.evidence?.reportPath ?? null,
    evidenceMarkdownPath: report.evidence?.evidenceMarkdownPath ?? null, failureCode: report.failureCode ?? null }))
  return report
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const platform = dependencies.platform ?? process.platform
  const stdout = dependencies.stdout ?? console.log
  if (platform !== 'darwin') {
    const result = { status: 'NOT_RUN', caseId: 'F12-MAC-PACKAGED-DATABASE', code: 'DARWIN_REQUIRED',
      appStarted: false, processCreated: false, completeCase: false, macAcceptance: 'NOT_RUN' }
    stdout(JSON.stringify(result))
    return 1
  }
  if (argv.length === 1 && argv[0] === '--help') {
    stdout('npm run test:mac:normal-app:database-chain -- --app <approved absolute .app> --bundle-id <approved ID> --minimum-os <approved version> --expect-process-arch <arm64|x64> --zip <fresh todo Mac-target ZIP> --output <fresh absolute directory>')
    stdout('Launches the packaged normal App with a Main Inspector first-line gate, isolates appData/userData/sessionData before bootstrap resumes, then installs todo through the public SDK and checks trusted UI-created database data across close/reopen and app restart.')
    return 0
  }
  const report = await runMacNormalAppDatabaseChain(argv, { ...dependencies, platform, stdout: value => stdout(value) })
  return report.status === 'PASS' ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === runnerPath) {
  void main().then(code => { process.exitCode = code }).catch(error => {
    console.error(safeErrorCode(error))
    process.exitCode = 1
  })
}
