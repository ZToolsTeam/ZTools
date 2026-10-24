import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertPeMachine, PE_MACHINE_X64 } from './windows-pe-architecture.mjs'
import { WindowsNormalAppHarness, startLoopbackZipServer, closeLoopbackZipServer } from './lib/windows-normal-app-harness.mjs'
import { validateFreshPluginZip, digest } from './windows-normal-app-plugin-file-chain-lib.mjs'

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(clientRoot, '..')
const pluginRoot = path.join(repositoryRoot, 'plugins', 'create-plugin')
const runnerPath = fileURLToPath(import.meta.url)

function errorCode(error) {
  const value = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : ''
  return /^[A-Z0-9_]{1,96}$/.test(value) ? value : 'NORMAL_APP_DATABASE_CHAIN_UNCLASSIFIED_FAILURE'
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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

function recordHash(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

async function waitFor(read, accept, timeoutMs, code) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(code)
}

async function clickButton(page, label) {
  const deadline = Date.now() + 15_000
  let latest = null
  while (Date.now() < deadline) {
    latest = await page.evaluate(`(() => {
      const normalize = value => String(value ?? '').replace(/\\s+/g, ' ').trim();
      const buttons = [...document.querySelectorAll('button')];
      const expected = ${JSON.stringify(label)}.replace(/\\s+/g, '');
      const toolbarButtons = [...document.querySelectorAll('.toolbar button')];
      const orderedButtons = [...new Set([...toolbarButtons, ...buttons])];
      const button = orderedButtons.find(item => normalize(item.textContent).replace(/\\s+/g, '') === expected &&
        item.getBoundingClientRect().width > 0 && !item.disabled);
      let target = null;
      if (button) {
        button.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = button.getBoundingClientRect();
        target = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
          text: normalize(button.innerText || button.textContent) };
      }
      return { target, snapshot: {
        readyState: document.readyState,
        url: location.href,
        title: document.title,
        todoContainerPresent: Boolean(document.querySelector('.todo-container')),
        appText: (document.querySelector('#app')?.innerText ?? '').trim().slice(0, 500),
        buttons: buttons.map(item => {
          const rect = item.getBoundingClientRect();
          const style = getComputedStyle(item);
          return {
            text: normalize(item.innerText || item.textContent).slice(0, 80),
            textContent: normalize(item.textContent).slice(0, 80),
            disabled: item.disabled,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            display: style.display,
            visibility: style.visibility,
            ariaDisabled: item.getAttribute('aria-disabled')
          };
        }).filter(item => item.text).slice(0, 40)
      } };
    })()`)
    if (latest?.target && Number.isFinite(latest.target.x) && Number.isFinite(latest.target.y)) break
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  const target = latest?.target
  if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    const error = new Error('TODO_UI_BUTTON_NOT_FOUND')
    error.code = 'TODO_UI_BUTTON_NOT_FOUND'
    error.diagnostic = latest?.snapshot ?? null
    throw error
  }
  await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 })
  return target
}

async function clickAndInsert(page, selector, value) {
  const target = await page.evaluate(`(() => {
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
  await page.evaluate(`(() => {
    if (!window.ztools || window.__f12DatabaseEvents) throw new Error('F12_UI_RECORDER_STATE_INVALID');
    const events = [];
    document.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (button) {
        const text = button.innerText.replace(/\\s+/g, ' ').trim();
        events.push({ text, normalizedText: text.replace(/\\s+/g, ''), isTrusted: event.isTrusted, at: Date.now() });
      }
    }, true);
    window.__f12DatabaseEvents = events;
    return true;
  })()`)
}

async function readTodoState(page, title) {
  return await page.evaluate(`(async () => {
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
  await waitFor(() => page.evaluate(`Boolean(document.querySelector('.todo-form input'))`), Boolean, 15_000, 'TODO_CREATE_MODAL_NOT_OPEN')
  await clickAndInsert(page, '.todo-form input', title)
  await clickAndInsert(page, '.todo-form textarea', description)
  const formValues = await page.evaluate(`(() => ({
    title: document.querySelector('.todo-form input')?.value ?? null,
    description: document.querySelector('.todo-form textarea')?.value ?? null
  }))()`)
  const save = await clickButton(page, '保存')
  let lastState = null
  let state
  try {
    state = await waitFor(async () => {
      lastState = await readTodoState(page, title)
      return lastState
    }, value => value?.item?.title === title && value.item.description === description &&
      value.visibleTitles.includes(title), 20_000, 'TODO_CREATE_NOT_PERSISTED')
  } catch (error) {
    error.code = 'TODO_CREATE_NOT_PERSISTED'
    error.diagnostic = {
      formValues: {
        titleMatches: formValues.title === title,
        descriptionMatches: formValues.description === description,
        titleLength: typeof formValues.title === 'string' ? formValues.title.length : null,
        descriptionLength: typeof formValues.description === 'string' ? formValues.description.length : null
      },
      lastState: lastState ? {
        count: lastState.count,
        itemId: lastState.item?._id ?? null,
        itemTitleMatches: lastState.item?.title === title,
        itemDescriptionMatches: lastState.item?.description === description,
        itemDescriptionSha256: typeof lastState.item?.description === 'string'
          ? createHash('sha256').update(lastState.item.description, 'utf8').digest('hex') : null,
        visibleTitles: lastState.visibleTitles,
        events: lastState.events
      } : null,
      visibleErrors: await page.evaluate(`[...document.querySelectorAll('.ant-message-notice-content, .ant-notification-notice-message')]
        .map(node => node.innerText.trim()).filter(Boolean).slice(0, 8)`)
    }
    throw error
  }
  const trusted = state.events.filter(event => event.normalizedText === '新增待办' || event.normalizedText === '保存')
  if (trusted.length !== 2 || trusted.some(event => event.isTrusted !== true)) {
    const error = new Error('TODO_TRUSTED_UI_ACTIONS_NOT_CONFIRMED')
    error.code = 'TODO_TRUSTED_UI_ACTIONS_NOT_CONFIRMED'
    error.diagnostic = { events: state.events, itemId: state.item?._id ?? null,
      visibleTitle: state.visibleTitles.includes(title) }
    throw error
  }
  return { open, save, state, trustedEvents: trusted }
}

function createEvidenceMarkdown(report) {
  return [
    '# F12 normal Electron todo database chain', '',
    `- Run: \`${report.runId}\``,
    `- Result: **${report.status}**`,
    `- Isolated profile: \`${report.profileRoot ?? 'not created'}\` (preserved)`,
    `- Public SDK install/open: ${report.phases.install?.status ?? 'NOT_RUN'} / ${report.phases.pluginOpen?.status ?? 'NOT_RUN'}`,
    `- UI-created todo: ${report.phases.todoCreate?.status ?? 'NOT_RUN'}`,
    `- Plugin close/reopen: ${report.phases.closeReopen?.status ?? 'NOT_RUN'}`,
    `- Restart read: ${report.phases.restartRead?.status ?? 'NOT_RUN'}`,
    `- Database item count: ${report.phases.todoCreate?.count ?? 'NOT_RUN'} → ${report.phases.restartRead?.count ?? 'NOT_RUN'}`,
    `- Content SHA-256: \`${report.phases.todoCreate?.recordSha256 ?? 'NOT_RUN'}\``,
    `- Normal App evidence: \`${report.output}\``,
    '',
    'This is a source-run Windows Electron `electron .` acceptance with a fresh installed todo plugin and a private profile. It does not claim packaged-production, Mac, secret-store, or cross-device migration acceptance.',
    ''
  ].join('\n')
}

async function run() {
  const parsed = parseArgs({ options: { zip: { type: 'string' }, help: { type: 'boolean' } } })
  if (parsed.values.help) {
    console.log('node scripts/test-windows-normal-app-database-chain.mjs --zip <fresh todo windows-electron-x64 ZIP>')
    console.log('Starts `electron .` with a new isolated profile, installs todo through the public SDK, creates a todo through its UI, then quits/restarts and reads it through the public database SDK.')
    return
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log(JSON.stringify({ status: 'NOT_RUN', platform: process.platform, arch: process.arch,
      reason: 'WINDOWS_X64_NORMAL_ELECTRON_REQUIRED', macAcceptance: 'NOT_RUN' }))
    process.exitCode = 1
    return
  }
  if (!parsed.values.zip || !path.win32.isAbsolute(parsed.values.zip)) throw new Error('ZIP_ABSOLUTE_PATH_REQUIRED')
  const runId = randomUUID()
  const output = path.join(clientRoot, 'out-test', 'normal-app-database-chain', runId)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.mkdirSync(output, { recursive: false })
  fs.mkdirSync(path.join(output, 'profiles'), { recursive: false })
  const report = { schemaVersion: 1, runId, platform: process.platform, arch: process.arch, status: 'FAIL',
    scope: 'windows-normal-electron-todo-public-sdk-ui-database-restart', productionZToolsAcceptance: false,
    normalElectronEntry: true, isolatedAppData: false, isolationConfirmed: false,
    rendererArbitraryIpcExposed: false, rendererNodeExposed: false, macAcceptance: 'NOT_RUN',
    output, profileRoot: null, phases: {}, inputs: {} }
  const sessions = new Set()
  let zipServer
  try {
    const versions = readVersions()
    const manifestPath = path.join(pluginRoot, 'src', 'plugins', 'todo', 'plugin.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (manifest.id !== 'todo' || !manifest.version) throw new Error('TODO_PLUGIN_SOURCE_MANIFEST_INVALID')
    const zipInfo = validateFreshPluginZip(parsed.values.zip, pluginRoot, 'todo')
    const executable = path.join(clientRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    const bootstrap = path.join(clientRoot, 'out', 'main', 'bootstrap.js')
    const webIndex = path.join(clientRoot, 'out', 'assets', 'web', 'index.html')
    for (const [file, code] of [[executable, 'ELECTRON_EXECUTABLE_INVALID'], [bootstrap, 'PROJECT_BOOTSTRAP_NOT_BUILT'],
      [webIndex, 'NORMAL_APP_WEB_BUILD_NOT_FOUND']]) {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(code)
    }
    assertPeMachine(executable, PE_MACHINE_X64)
    const zipRunId = randomUUID()
    zipServer = await startLoopbackZipServer(zipInfo, 'todo.zip', zipRunId)
    report.inputs = { appRoot: clientRoot, appVersion: versions.appVersion, electronVersion: versions.electronVersion,
      sdkContractVersion: versions.sdkContractVersion, pluginId: manifest.id, pluginVersion: manifest.version,
      freshZip: { path: zipInfo.path, fileSize: zipInfo.fileSize, sha256: zipInfo.checksum, buildRun: zipInfo.buildRun },
      electronExecutable: executable, electronExecutableSha256: digest(fs.readFileSync(executable)),
      bootstrap, bootstrapSha256: digest(fs.readFileSync(bootstrap)), webIndex,
      loopbackRoute: zipServer.url, loopbackPort: zipServer.port }

    const harness = new WindowsNormalAppHarness({ appRoot: clientRoot, executable, outputRoot: output, versions })
    const profile = harness.createProfile(path.join(output, 'profiles', 'normal'))
    report.profileRoot = profile.root
    const first = await harness.start({ profile, phase: 'database-first-start', report })
    first.harness = harness
    sessions.add(first)
    report.phases.firstStart = { status: 'PASS', mainIdentity: first.mainIdentity, rendererIdentity: first.rendererIdentity,
      process: first.processRecord, configuredPaths: first.configuredPaths }

    const installed = await harness.install(first, { pluginId: 'todo', zipInfo, zipUrl: zipServer.url, version: manifest.version })
    report.phases.install = { status: 'PASS', pluginDirectory: installed.pluginDirectory, manifest: installed.manifest,
      fileHashes: installed.fileHashes, accepted: installed.accepted }
    const opened = await harness.open(first, 'todo')
    report.phases.pluginOpen = { status: 'PASS', targetId: opened.target.id, targetUrl: opened.target.url,
      identity: opened.identity, opened: opened.opened }

    const marker = `F12_NORMAL_DB_${runId}`
    const markerHash = createHash('sha256').update(marker, 'utf8').digest('hex')
    const title = `F12 todo ${runId.slice(0, 8)}`
    const description = `${marker} sha256:${markerHash}`
    const created = await createTodoThroughUi(opened.page, title, description)
    if (!created.state.item || created.state.item._id !== `todo:${created.state.item.createdAt}`) {
      throw new Error('TODO_PUBLIC_SDK_RECORD_ID_INVALID')
    }
    const createdHash = recordHash(created.state.item)
    report.phases.todoCreate = { status: 'PASS', count: created.state.count, itemId: created.state.item._id,
      title, descriptionSha256: createHash('sha256').update(description, 'utf8').digest('hex'),
      markerSha256: markerHash, recordSha256: createdHash, trustedEvents: created.trustedEvents,
      visibleTitle: created.state.visibleTitles.includes(title), publicSdk: 'ztools.db.setPluginId + ztools.db.allDocs' }

    await harness.close(first, 'todo')
    const reopenedBeforeExit = await harness.open(first, 'todo')
    const inSession = await waitFor(() => readTodoState(reopenedBeforeExit.page, title), state =>
      state?.item?._id === created.state.item._id, 20_000, 'TODO_CLOSE_REOPEN_READ_NOT_FOUND')
    const inSessionHash = recordHash(inSession.item)
    if (inSessionHash !== createdHash || inSession.count !== created.state.count || !inSession.visibleTitles.includes(title)) {
      throw new Error('TODO_CLOSE_REOPEN_MISMATCH')
    }
    report.phases.closeReopen = { status: 'PASS', count: inSession.count, itemId: inSession.item._id,
      recordSha256: inSessionHash, hashMatches: true, countMatches: true,
      visibleTitle: inSession.visibleTitles.includes(title), openedTargetId: reopenedBeforeExit.target.id }

    await harness.close(first, 'todo')
    const firstStop = await harness.stop(first)
    sessions.delete(first)
    report.phases.firstExit = { status: firstStop.cleanupConfirmed && firstStop.exit?.code === 0 ? 'PASS' : 'FAIL', ...firstStop }
    if (!firstStop.cleanupConfirmed || firstStop.exit?.code !== 0) throw new Error('FIRST_APP_QUIT_NOT_CONFIRMED')

    const second = await harness.start({ profile, phase: 'database-restart', report })
    second.harness = harness
    sessions.add(second)
    const reopened = await harness.open(second, 'todo')
    const restarted = await waitFor(() => readTodoState(reopened.page, title), state => state?.item?._id === created.state.item._id,
      20_000, 'TODO_RESTART_READ_NOT_FOUND')
    const restartedHash = recordHash(restarted.item)
    const hashMatches = restartedHash === createdHash
    const countMatches = restarted.count === created.state.count
    if (!hashMatches || !countMatches || restarted.visibleTitles.includes(title) !== true) throw new Error('TODO_DATABASE_RESTART_MISMATCH')
    report.phases.restartRead = { status: 'PASS', count: restarted.count, itemId: restarted.item._id,
      recordSha256: restartedHash, hashMatches, countMatches, visibleTitle: restarted.visibleTitles.includes(title),
      rendererIdentity: reopened.identity, publicSdk: 'ztools.db.setPluginId + ztools.db.allDocs' }
    await harness.close(second, 'todo')
    const secondStop = await harness.stop(second)
    sessions.delete(second)
    report.phases.restartExit = { status: secondStop.cleanupConfirmed && secondStop.exit?.code === 0 ? 'PASS' : 'FAIL', ...secondStop }
    if (!secondStop.cleanupConfirmed || secondStop.exit?.code !== 0) throw new Error('RESTARTED_APP_QUIT_NOT_CONFIRMED')
    report.phases.profilePreserved = { status: fs.existsSync(profile.root) && fs.existsSync(path.join(profile.appDataPath, 'ZTools', 'Data', 'Plugins', 'todo')) ? 'PASS' : 'FAIL',
      root: profile.root, appDataPath: profile.appDataPath }
    report.phases.loopback = { status: zipServer.requests.length > 0 && zipServer.requests.every(item => item.status === 200) ? 'PASS' : 'FAIL',
      requests: zipServer.requests }
    report.status = report.phases.profilePreserved.status === 'PASS' && report.phases.loopback.status === 'PASS' ? 'PASS' : 'FAIL'
    report.completeCase = report.status === 'PASS'
    if (report.status !== 'PASS') process.exitCode = 1
  } catch (error) {
    report.failureCode = errorCode(error)
    if (typeof error?.stage === 'string' && /^[a-z0-9-]{1,80}$/i.test(error.stage)) report.failureStage = error.stage
    if (error?.cleanup && typeof error.cleanup === 'object') report.failureCleanup = error.cleanup
    if (typeof error?.stack === 'string') report.failureDiagnostic = {
      errorStack: error.stack.slice(0, 4000),
      ...(error?.diagnostic && typeof error.diagnostic === 'object' ? { details: error.diagnostic } : {})
    }
    report.failedAt = new Date().toISOString()
    console.error(report.failureCode)
    process.exitCode = 1
  } finally {
    for (const session of [...sessions]) {
      if (!session || session.stopResult) continue
      const stopped = await session.harness.stop(session)
      sessions.delete(session)
      if (!stopped.cleanupConfirmed) {
        report.status = 'FAIL'
        report.failureCode ??= 'OWNED_ELECTRON_CLEANUP_UNCONFIRMED'
        process.exitCode = 1
      }
      report.failureCleanup ??= stopped.cleanupConfirmed ? undefined : stopped
    }
    if (zipServer) {
      try { await closeLoopbackZipServer(zipServer.server); report.loopbackServerStopped = true }
      catch { report.loopbackServerStopped = false; report.status = 'FAIL'; report.failureCode ??= 'LOOPBACK_SERVER_CLOSE_UNCONFIRMED'; process.exitCode = 1 }
    }
    report.scratchPreserved = true
    report.updatedAt = new Date().toISOString()
    const reportPath = path.join(output, 'report.json')
    if (!fs.existsSync(reportPath)) fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    const evidenceDirectory = path.join(repositoryRoot, 'docs', 'mac-compat-evidence', 'F12')
    fs.mkdirSync(evidenceDirectory, { recursive: true })
    const evidencePath = path.join(evidenceDirectory, `normal-app-database-chain-${runId}.json`)
    const markdownPath = path.join(evidenceDirectory, `normal-app-database-chain-${runId}.md`)
    fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    fs.writeFileSync(markdownPath, createEvidenceMarkdown(report), { flag: 'wx' })
    console.log(JSON.stringify({ ...report, evidencePath, markdownPath }))
    if (report.status !== 'PASS') process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === runnerPath) {
  void run().catch(error => { console.error(errorCode(error)); process.exitCode = 1 })
}
