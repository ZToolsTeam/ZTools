import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, desktopCapturer, nativeImage, screen, systemPreferences, session } from 'electron'

const clientRoot = process.env.ZTOOLS_TEST_CLIENT_ROOT
const pluginRoot = process.env.ZTOOLS_TEST_PLUGIN_ROOT
const webRoot = process.env.ZTOOLS_TEST_WEB_ROOT
const diagnosticLog = process.env.ZTOOLS_TEST_DIAGNOSTIC_LOG
if (!clientRoot || !pluginRoot || !webRoot || !diagnosticLog) {
  throw new Error('插件 Renderer E2E 环境变量缺失')
}

const testRunId = `${process.pid}-${Date.now()}`
const testUserData = path.join(clientRoot, 'out-test', `plugin-renderer-user-data-${testRunId}`)
fs.mkdirSync(testUserData, { recursive: true })
app.setPath('userData', testUserData)

const log = (message) => {
  fs.appendFileSync(diagnosticLog, `${new Date().toISOString()} ${message}\n`, 'utf8')
}
log('module-start')

const importClientModule = (relativePath) => import(
  pathToFileURL(path.join(clientRoot, ...relativePath)).toString()
)

const { registerZToolsScheme, installZToolsProtocol } = await importClientModule(
  ['out', 'main', 'protocol', 'ztools-protocol.js']
)
const { createCoreServices } = await importClientModule(
  ['out', 'main', 'services', 'core-services.js']
)
const { IpcRouter } = await importClientModule(['out', 'main', 'ipc', 'router.js'])
const { createPlatformScreenClipboardAdapters } = await importClientModule(
  ['out', 'main', 'platform', 'screen-clipboard.js']
)
const { createWindowsScreenClipboardAdapters } = await importClientModule(
  ['out', 'main', 'platform', 'windows', 'screen-clipboard.js']
)
const { createMacosScreenClipboardAdapters } = await importClientModule(
  ['out', 'main', 'platform', 'macos', 'screen-clipboard.js']
)
const { createSystemPlatformAdapter } = await importClientModule(
  ['out', 'main', 'platform', 'system.js']
)
const { createWindowsSystemPlatformAdapter } = await importClientModule(
  ['out', 'main', 'platform', 'windows', 'system.js']
)
const { createMacosSystemPlatformAdapter } = await importClientModule(
  ['out', 'main', 'platform', 'macos', 'system.js']
)
const { createPlatformProcessDiscoveryAdapter } = await importClientModule(
  ['out', 'main', 'platform', 'process-discovery.js']
)
const { WindowRegistry } = await importClientModule(
  ['out', 'main', 'windows', 'window-registry.js']
)
const { configureSessionSecurity } = await importClientModule(
  ['out', 'main', 'windows', 'main-window.js']
)
log('production-modules-imported')

registerZToolsScheme()
log('scheme-registered')
app.on('window-all-closed', () => {
  log('window-all-closed')
})

function waitForRendererReady(window, pluginId) {
  return window.webContents.executeJavaScript(`
    (async function () {
      var deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (window.ztools && ztools.db && document.querySelector('#app') && document.querySelector('#app').children.length > 0) {
          return true;
        }
        await new Promise(function (resolve) { setTimeout(resolve, 100); });
      }
      throw new Error('插件页面初始化超时: ${pluginId}');
    })()
  `, true)
}

async function verifyPlugin(pluginId, router) {
  log(`${pluginId}:window-creating`)
  const beforeIds = new Set(BrowserWindow.getAllWindows().map((window) => window.id))
  const opened = await router.openPlugin({ pluginId })
  assert.equal(opened.success, true)
  assert.equal(opened.pluginId, pluginId)
  assert.equal(opened.windowInstanceStatus, 'created')
  const window = BrowserWindow.getAllWindows().find((candidate) => !beforeIds.has(candidate.id))
  assert.ok(window)

  try {
    log(`${pluginId}:load-finished`)
    await waitForRendererReady(window, pluginId)
    log(`${pluginId}:renderer-ready`)
    const result = await window.webContents.executeJavaScript(`
      (async function () {
        var key = 'electron-e2e:' + Date.now();
        await ztools.db.setPluginId('${pluginId}');
        await ztools.db.put({ _id: key, value: '${pluginId}' });
        var loaded = await ztools.db.get(key);
        await ztools.db.remove(key);
        await ztools.fs.writeCache('isolation/owned.txt', '${pluginId}');
        var legacyPath = 'isolation/legacy.bin';
        var legacyWritten = window._writeFileArrayBuffer(legacyPath, [0, 255, 128, 65, 10]);
        var legacySize = window._getFileSize(legacyPath);
        var legacyBuffer = window._readFileArrayBuffer(legacyPath);
        var legacyChunk = window._readFileArrayBufferChunk(legacyPath, 1, 3);
        var legacyTail = window._readFileArrayBufferChunk(legacyPath, 4, 100);
        var legacyEof = window._readFileArrayBufferChunk(legacyPath, 5, 10);
        function rejected(action) {
          try { action(); return false; } catch (_) { return true; }
        }
        var legacy = {
          written: legacyWritten, size: legacySize,
          arrayBuffer: legacyBuffer instanceof ArrayBuffer,
          bytes: Array.from(new Uint8Array(legacyBuffer)),
          chunk: Array.from(new Uint8Array(legacyChunk)),
          tail: Array.from(new Uint8Array(legacyTail)), eof: legacyEof.byteLength,
          missing: rejected(() => window._getFileSize('missing.bin')),
          invalidOffset: rejected(() => window._readFileArrayBufferChunk(legacyPath, -1, 1)),
          denied: rejected(() => window._getFileSize('../main/e2e-main-secret.txt')),
          deniedWrite: rejected(() => window._writeFileArrayBuffer('../main/forbidden.bin', [1]))
        };
        async function resource(url) {
          try {
            var response = await fetch(url, { cache: 'no-store' });
            return { status: response.status, text: response.ok ? await response.text() : '' };
          } catch (_) {
            return { status: 0, text: '' };
          }
        }
        var otherPlugin = '${pluginId === 'todo' ? 'clipboard-manager' : 'todo'}';
        var messageId = 'spoof:' + Date.now();
        var spoofed = await window.__ztoolsElectron.transport.methods.db_put({
          messageId: messageId,
          params: { plugin_id: '${pluginId === 'todo' ? 'context-menu' : 'todo'}', key: key, value: 'forbidden' }
        });
        var capability = await ztools.sys.getCapability('screen.capture');
        var spoofedCapability = await window.__ztoolsElectron.transport.methods.runtime_capability_get({
          messageId: 'spoof-capability:' + Date.now(),
          params: { capability: 'screen.capture', pluginId: 'todo' }
        });
        var unknownCapabilityCode = '';
        try {
          await ztools.sys.getCapability('not.registered');
        } catch (error) {
          unknownCapabilityCode = error.code || '';
        }
        return {
          url: location.href,
          legacy: legacy,
          loaded: loaded,
          spoofed: spoofed,
          capability: capability,
          preloadContractVersion: window.__ztoolsElectron.contractVersion,
          spoofedCapability: spoofedCapability,
          unknownCapabilityCode: unknownCapabilityCode,
          ownResource: await resource(location.href),
          otherResource: await resource('ztools://plugins/' + otherPlugin + '/index.html'),
          traversalResource: await resource('ztools://plugins/${pluginId}/%252e%252e/' + otherPlugin + '/index.html'),
          absoluteResource: await resource('ztools://plugins/${pluginId}/C%3A/Windows/win.ini'),
          mainCache: await resource('ztools://cache/e2e-main-secret.txt'),
          mainTemp: await resource('ztools://temp/e2e-main-secret.txt'),
          mainWeb: await resource('ztools://web/index.html'),
          sharedSdk: await resource('ztools://web/sdk/plugin-sdk.js'),
          ownCache: await resource('ztools://cache/isolation/owned.txt'),
          nodeType: typeof process,
          requireType: typeof require,
          electronEnvironment: ztools.isElectron(),
          childCount: document.querySelector('#app').children.length
        };
      })()
    `, true)
    assert.equal(result.url, `ztools://plugins/${pluginId}/index.html`)
    assert.equal(result.loaded.value, pluginId)
    assert.deepEqual(result.legacy, {
      written: true, size: 5, arrayBuffer: true, bytes: [0, 255, 128, 65, 10],
      chunk: [255, 128, 65], tail: [10], eof: 0,
      missing: true, invalidOffset: true, denied: true, deniedWrite: true
    })
    assert.equal(result.spoofed.success, false)
    assert.equal(result.spoofed.error.code, 'PERMISSION_DENIED')
    assert.equal(result.capability.capability, 'screen.capture')
    assert.equal(result.capability.contractVersion, 1)
    assert.equal(result.preloadContractVersion, result.capability.contractVersion)
    assert.deepEqual(result.capability.target, {
      platform: process.platform === 'darwin' ? 'macos' : 'windows', runtime: 'electron', arch: process.arch
    })
    assert.equal(result.capability.implementation, 'supported')
    assert.equal(result.capability.authorization, pluginId === 'todo' ? 'granted' : 'denied')
    assert.equal(result.capability.osPermission, 'unknown')
    assert.equal(result.spoofedCapability.success, false)
    assert.equal(result.spoofedCapability.error.code, 'INVALID_REQUEST')
    assert.equal(result.unknownCapabilityCode, 'INVALID_REQUEST')
    assert.equal(result.ownResource.status, 200)
    assert.notEqual(result.otherResource.status, 200)
    assert.notEqual(result.traversalResource.status, 200)
    assert.notEqual(result.absoluteResource.status, 200)
    assert.notEqual(result.mainCache.status, 200)
    assert.notEqual(result.mainTemp.status, 200)
    assert.notEqual(result.mainWeb.status, 200)
    assert.equal(result.sharedSdk.status, 200)
    assert.equal(result.ownCache.status, 200)
    assert.equal(result.ownCache.text, pluginId)
    assert.equal(result.nodeType, 'undefined')
    assert.equal(result.requireType, 'undefined')
    assert.equal(result.electronEnvironment, true)
    assert.ok(result.childCount > 0)
    log(`${pluginId}:verified`)
    console.log(JSON.stringify({ pluginId, status: 'passed', url: result.url }))
    return window.webContents.session
  } finally {
    if (!window.isDestroyed()) window.destroy()
    log(`${pluginId}:window-destroyed`)
  }
}

async function main() {
  let router
  let services
  let exitCode = 0
  try {
    log('app-ready-wait')
    await app.whenReady()
    log('app-ready')
    const dataRoot = path.join(testUserData, 'data')
    fs.mkdirSync(dataRoot, { recursive: true })
    const installedPluginRoot = path.join(dataRoot, 'Plugins')
    fs.mkdirSync(installedPluginRoot, { recursive: true })
    for (const pluginId of ['todo', 'clipboard-manager', 'context-menu']) {
      fs.cpSync(path.join(pluginRoot, pluginId), path.join(installedPluginRoot, pluginId), {
        recursive: true,
        force: false,
        errorOnExist: true
      })
    }
    const registry = new WindowRegistry()
    services = createCoreServices(dataRoot, app.getVersion(), 'test')
    router = await IpcRouter.create(registry, services, {
      pluginResources: { webRoot, pluginRoot: installedPluginRoot },
      screenClipboardAdapters: createPlatformScreenClipboardAdapters(process.platform, {
        windows: () => createWindowsScreenClipboardAdapters({ screen, desktopCapturer, nativeImage }),
        macos: () => createMacosScreenClipboardAdapters({ screen, desktopCapturer, nativeImage, systemPreferences })
      }),
      systemPlatformAdapter: createSystemPlatformAdapter(process.platform, {
        windows: () => createWindowsSystemPlatformAdapter(app.getPath('userData')),
        macos: () => createMacosSystemPlatformAdapter(app.getPath('userData'))
      }),
      processDiscoveryAdapter: createPlatformProcessDiscoveryAdapter(process.platform),
      runtimeCapabilityProviders: {
        getAuthorization: (capability, caller) =>
          capability === 'screen.capture' && caller.type === 'plugin' && caller.pluginId === 'todo'
            ? 'granted'
            : 'denied',
        getOsPermission: () => 'unknown'
      },
      toggleMainWindow() {},
      toggleSuperPanel() {},
      getPanelLocalApps: async () => [],
      launchLocalApp: async () => {},
      closeConfirmationResolved() {}
    })
    const roots = await router.fileService.prepareMainProtocolRoots()
    fs.writeFileSync(path.join(roots.cache, 'e2e-main-secret.txt'), 'main-cache', 'utf8')
    fs.writeFileSync(path.join(roots.temp, 'e2e-main-secret.txt'), 'main-temp', 'utf8')
    installZToolsProtocol({ web: webRoot, ...roots }, router.fileService)
    configureSessionSecurity(router.fileService)
    router.register()
    log('router-registered')

    const pluginSessions = new Map()
    for (const pluginId of ['todo', 'clipboard-manager', 'context-menu']) {
      pluginSessions.set(pluginId, await verifyPlugin(pluginId, router))
    }
    const todoSession = pluginSessions.get('todo')
    const clipboardSession = pluginSessions.get('clipboard-manager')
    assert.ok(todoSession)
    assert.ok(clipboardSession)
    assert.notEqual(todoSession, clipboardSession)
    assert.equal(todoSession.isPersistent(), true)
    assert.equal(clipboardSession.isPersistent(), true)
    assert.ok(todoSession.storagePath)
    assert.ok(clipboardSession.storagePath)
    assert.notEqual(todoSession.storagePath, clipboardSession.storagePath)
    await todoSession.cookies.set({
      url: 'https://plugin-isolation.invalid/',
      name: 'owner',
      value: 'todo'
    })
    assert.equal(
      (await todoSession.cookies.get({ url: 'https://plugin-isolation.invalid/' }))[0]?.value,
      'todo'
    )
    assert.equal(
      (await clipboardSession.cookies.get({ url: 'https://plugin-isolation.invalid/' })).length,
      0
    )
    const defaultPluginResponse = await session.defaultSession.fetch(
      'ztools://plugins/todo/index.html'
    )
    assert.equal(defaultPluginResponse.status, 404)
    log('plugin-isolation:verified')
    await router.stop()
    router = undefined
    await services.stop()
    services = undefined
    registry.clear()
    log('cleanup-complete')
  } catch (error) {
    exitCode = 1
    log(`failure:${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    console.error(error)
    await router?.stop().catch((stopError) => console.error(stopError))
    await services?.stop().catch((stopError) => console.error(stopError))
  } finally {
    log(`app-exit:${exitCode}`)
    process.exitCode = exitCode
    app.exit(exitCode)
  }
}

void main()
