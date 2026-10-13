const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const [output, compiled, broker] = process.argv.slice(2)
if (![output, compiled, broker].every(value => value && path.isAbsolute(value))) process.exit(2)
const load = file => import(pathToFileURL(path.join(compiled, 'src/main', file)).href)
fs.mkdirSync(path.join(output, 'user-data')); app.setPath('userData', path.join(output, 'user-data'))
app.setPath('sessionData', path.join(output, 'user-data')); app.disableHardwareAcceleration()
require(path.join(compiled, 'src/main/protocol/ztools-protocol.js')).registerZToolsScheme()
app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  let runtime, files, resources, registry
  const windows = [], observations = []
  let failure
  try {
    const { WindowRegistry } = await load('windows/window-registry.js')
    const { FileSystemService } = await load('services/file-system-service.js')
    const { createPathAccessRuntime } = await load('platform/path-access-runtime.js')
    const { electronJournalSealer } = await load('platform/path-write-journal-storage.js')
    const { ReferenceFileResources } = await load('protocol/reference-file-resources.js')
    const { installZToolsProtocol } = await load('protocol/ztools-protocol.js')
    const { configureSessionSecurity } = await load('windows/main-window.js')
    registry = new WindowRegistry({ hostMaximumSdkContractVersion: 2 })
    const data = path.join(output, 'Data'), web = path.join(output, 'web'), plugins = path.join(output, 'plugins')
    for (const directory of [data, web, plugins, path.join(plugins, 'fixture')]) fs.mkdirSync(directory)
    fs.writeFileSync(path.join(web, 'index.html'), '<html><body>owned resource fixture</body></html>')
    fs.writeFileSync(path.join(plugins, 'fixture/index.html'), '<html><body>owned reference fixture</body></html>')
    const selected = path.join(data, 'selected.txt'), text = '中文 resource fixture\n'
    fs.writeFileSync(selected, text, { flag: 'wx' })
    runtime = await createPathAccessRuntime({ executable: broker, dataRoot: data, platform: process.platform,
      sealer: electronJournalSealer, owners: { isActive: owner => !!registry.get(owner), get: owner => registry.get(owner), onRemoved: listener => registry.onRemoved(listener) } })
    files = new FileSystemService(registry, path.join(data, 'Cache'))
    resources = new ReferenceFileResources(registry, runtime.grants)
    installZToolsProtocol({ web, plugins, cache: web, temp: web }, files, resources)
    configureSessionSecurity(files, resources)
    const main = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
    windows.push(main); const mainOwner = registry.registerMain(main.webContents)
    const plugin = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } })
    windows.push(plugin); registry.registerPlugin(plugin.webContents, 'fixture', 'owned-reference-instance', 2)
    await main.loadURL('ztools://web/index.html'); await plugin.loadURL('ztools://plugins/fixture/index.html')
    for (const window of windows) window.webContents.debugger.attach('1.3')
    async function evaluate(window, expression) {
      const result = await window.webContents.debugger.sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
      if (result.exceptionDetails) throw Error('RESOURCE_CDP_EXCEPTION')
      return result.result.value
    }
    const legacyUrl = await files.grantOpenPath(selected, mainOwner)
    const grant = await runtime.grants.createSelected(plugin.webContents.id, selected)
    const referenceUrl = runtime.grants.resourceUrl(plugin.webContents.id, grant.grantId)
    async function request(window, url, method = 'GET') {
      return evaluate(window, `(async()=>{try{const r=await fetch(${JSON.stringify(url)}, {method:${JSON.stringify(method)}});return {status:r.status,text:await r.text(),size:r.headers.get('content-length')}}catch{return {blocked:true}}})()`)
    }
    assert.equal((await request(main, legacyUrl)).text, text); observations.push('lane1-legacy-get')
    assert.equal((await request(plugin, referenceUrl)).text, text); observations.push('lane2-native-get')
    const head = await request(plugin, referenceUrl, 'HEAD'); assert.equal(head.status, 200); assert.equal(head.text, ''); assert.equal(Number(head.size), Buffer.byteLength(text)); observations.push('lane2-native-head')
    assert.deepEqual(await request(main, referenceUrl), { blocked: true }); observations.push('lane1-ref-rejected')
    assert.deepEqual(await request(plugin, legacyUrl), { blocked: true }); observations.push('lane2-legacy-rejected')
    const save = await runtime.grants.create(plugin.webContents.id, path.join(data, 'output.txt'), 'save', ['write'])
    const saveUrl = 'ztools://file/' + save.grantId + '/' + encodeURIComponent(save.displayName)
    assert.deepEqual(await request(plugin, saveUrl), { blocked: true }); observations.push('save-ref-not-readable')
    await runtime.grants.revoke(plugin.webContents.id, grant.grantId)
    assert.deepEqual(await request(plugin, referenceUrl), { blocked: true }); observations.push('revoked-ref-rejected')
    assert.deepEqual(await request(main, 'ztools://file/' + 'X'.repeat(43) + '/unknown.txt'), { blocked: true }); observations.push('unknown-token-rejected')
    assert.equal(await evaluate(main, 'typeof require'), 'undefined'); observations.push('sandbox-no-node')
    assert.equal(fs.existsSync(path.join(data, 'output.txt')), false)
    assert.equal(fs.readFileSync(selected, 'utf8'), text)
  } catch (error) { failure = error; console.error(error) }
  finally {
    for (const window of windows) { if (!window.isDestroyed()) { try { window.webContents.debugger.detach() } catch {} window.destroy() } }
    for (const close of [() => resources?.stop(), () => files?.stop(), () => runtime?.stop(), () => registry?.clear()]) {
      try { await close() } catch (error) { failure ??= error }
    }
  }
  fs.writeFileSync(path.join(output, 'observed.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', observations,
    electronVersion: process.versions.electron, processArch: process.arch, realNativeBroker: true,
    actualChromiumWebRequest: true, cdpRuntimeEvaluate: true, injectedHostMaximum: 2, productionZToolsAcceptance: false }, null, 2), { flag: 'wx' })
  app.exit(failure ? 1 : 0)
}).catch(error => { console.error(error); app.exit(1) })
