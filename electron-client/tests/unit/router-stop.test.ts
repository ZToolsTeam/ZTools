import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import type { WebContents } from 'electron'
import type { CoreServices } from '../../src/main/services/core-services.js'
import type { IpcRouterOptions } from '../../src/main/ipc/router.js'
import type { ZToolsResponse } from '../../src/contracts/ipc.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'

class FixtureContents extends EventEmitter {
  readonly session = {}
  readonly sent: Array<{ channel: string; payload: unknown }> = []
  constructor(readonly id: number, private readonly url = 'ztools://web/index.html') { super() }
  getURL(): string { return this.url }
  isDestroyed(): boolean { return false }
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }
}

async function verifyWindowCloseCallers(
  registry: WindowRegistry,
  handlers: Map<string, (event: unknown, value: unknown) => unknown>,
  dataRoot: string
): Promise<void> {
  const { WindowService } = require('../../src/main/services/window-service.js') as typeof import('../../src/main/services/window-service.js')
  const closed: string[] = []
  const closePlugin = WindowService.prototype.closePlugin
  WindowService.prototype.closePlugin = function (pluginId) { closed.push(pluginId) }
  const main = new FixtureContents(1)
  registry.registerMain(main as unknown as WebContents)
  const instanceId = '11111111-1111-4111-8111-111111111111'
  const plugin = new FixtureContents(2, 'ztools://plugins/memo/index.html')
  registry.registerPlugin(plugin as unknown as WebContents, 'memo', instanceId)
  await fs.mkdir(path.join(dataRoot, 'web/bundled-plugins/memo'), { recursive: true })
  await fs.writeFile(path.join(dataRoot, 'web/bundled-plugins/memo/plugin.json'),
    JSON.stringify({ id: 'memo', version: '1.0.0', permissions: [] }))
  let sequence = 0
  const call = async (sender: FixtureContents, method: string, params: unknown, token?: string) => {
    const invoke = handlers.get('ztools:call')
    assert.ok(invoke)
    return await invoke({ sender }, { messageId: `close-${++sequence}`, method, params,
      ...(token ? { pluginSession: token } : {}) }) as ZToolsResponse
  }
  try {
    const opened = await call(main, 'declarative_session_open', { pluginId: 'memo' })
    assert.equal(opened.success, true)
    const token = (opened.data as { data: { token: string } }).data.token
    const close = (sender: FixtureContents, params: unknown, session?: string) => call(sender, 'plugin_window_close', params, session)
    for (const [label, sender, params, session] of [
      ['宿主指定实例', main, { pluginId: 'memo', instanceId }, undefined],
      ['声明式插件会话', main, { pluginId: 'memo' }, token],
      ['失效会话', main, { pluginId: 'memo' }, 'a'.repeat(43)],
      ['插件自己的窗口', plugin, { pluginId: 'memo' }, undefined]
    ] as const) {
      await close(sender, params, session)
      assert.deepEqual(closed, [], label + '不能关闭声明式 popout')
    }
    for (const params of [{ pluginId: 'other' },
      { pluginId: 'memo', instanceId: '22222222-2222-4222-8222-222222222222' }]) {
      const denied = await close(plugin, params)
      assert.equal(denied.success, false)
      assert.equal(denied.error?.code, 'PERMISSION_DENIED')
    }
    assert.deepEqual(closed, [])
    assert.equal((await call(main, 'db_put', { plugin_id: 'memo', key: 'probe', value: 'preserved' }, token)).success, true)
    assert.equal((await close(main, { pluginId: 'memo' })).success, true)
    assert.deepEqual(closed, ['memo'])
    const stillActive = await call(main, 'db_get', { plugin_id: 'memo', key: 'probe' }, token)
    assert.equal(stillActive.success, true, '只关闭独立窗口，不撤销主窗口同插件的会话')
    assert.equal((stillActive.data as { data: string }).data, 'preserved')
  } finally {
    WindowService.prototype.closePlugin = closePlugin
  }
}

async function verifyHotkeyAndSystemIntegration(
  router: Awaited<ReturnType<typeof import('../../src/main/ipc/router.js').IpcRouter.create>>,
  registry: WindowRegistry,
  handlers: Map<string, (event: unknown, value: unknown) => unknown>,
  configWrites: Array<{ file: string; path: string; value: unknown }>,
  trayChangeCount: { count: number },
  mouseConfigs: unknown[],
  setPackaged: (packaged: boolean) => void
): Promise<void> {
  const main = new FixtureContents(11)
  registry.registerMain(main as unknown as WebContents)
  let seq = 0
  const call = async (method: string, params: unknown) => {
    const invoke = handlers.get('ztools:call')
    assert.ok(invoke)
    return await invoke({ sender: main }, { messageId: `hk-${++seq}`, method, params }) as ZToolsResponse
  }

  // 1. 验证冷启动 initialWakeHotkey 已自动建立 global_wake_hotkey
  assert.deepEqual(router.getGlobalWakeHotkey(), { exists: true, enabled: true, key: 'Alt+Space' })

  // 2. 验证 get_system_info 根据 platform 与 nativeInput.state === 'ready' 透出输入能力标志
  const sysInfo = await call('get_system_info', {})
  assert.equal(sysInfo.success, true)
  const infoData = sysInfo.data as Record<string, unknown>
  assert.equal(infoData.supportsDoubleModifierHotkeys, process.platform === 'win32')
  assert.equal(infoData.supportsMouseTriggers, process.platform === 'win32')

  // 3. 修改 global_wake_hotkey 时同步写回 user_settings.json 并触发托盘刷新回调
  const regRes = await call('trigger_register', {
    id: 'global_wake_hotkey',
    pluginId: 'system',
    type: 'hotkey',
    enabled: true,
    config: { key: 'Ctrl+Alt+Z' },
    action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
  })
  assert.equal(regRes.success, true)
  assert.deepEqual(router.getGlobalWakeHotkey(), { exists: true, enabled: true, key: 'Ctrl+Alt+Z' })
  assert.deepEqual(configWrites.at(-1), { file: 'user_settings.json', path: 'hotkey.global', value: 'Ctrl+Alt+Z' })
  assert.equal(trayChangeCount.count, 1)

  const disableRes = await call('trigger_set_enabled', { triggerId: 'global_wake_hotkey', enabled: false })
  assert.equal(disableRes.success, true)
  assert.deepEqual(router.getGlobalWakeHotkey(), { exists: true, enabled: false, key: 'Ctrl+Alt+Z' })
  assert.deepEqual(configWrites.at(-1), { file: 'user_settings.json', path: 'hotkey.global', value: '' })
  assert.equal(trayChangeCount.count, 2)

  // 4. win32 下验证真实路由放行 configureMouseTrigger
  if (process.platform === 'win32') {
    const mouseRes = await call('trigger_register', {
      id: 'router_mouse_hook',
      pluginId: 'system',
      type: 'hook',
      enabled: true,
      config: { kind: 'mouse', button: 'forward', action: 'long', longPressMs: 320, fullscreenDnd: true },
      action: { mode: 'builtin', target: 'toggle_main_window', params: {} }
    })
    assert.equal(mouseRes.success, true)
    assert.deepEqual(mouseConfigs.at(-1), {
      button: 'forward',
      action: 'long',
      longPressMs: 320,
      fullscreenDnd: true
    })
  }

  // 5. 正式版打包态 window_toggle_devtools 返回 PERMISSION_DENIED
  setPackaged(true)
  const devToolsRes = await call('window_toggle_devtools', {})
  assert.equal(devToolsRes.success, false)
  assert.equal(devToolsRes.error?.code, 'PERMISSION_DENIED')

  // 6. config_set 写入 user_settings.json 的 hotkey.shell 时跨窗口广播 system.ShellShortcutsChange 并刷新托盘
  const secondary = new FixtureContents(12, 'ztools://web/index.html?mode=launcher')
  registry.registerMain(secondary as unknown as WebContents)
  const callFrom = async (sender: FixtureContents, method: string, params: unknown) => {
    const invoke = handlers.get('ztools:call')
    assert.ok(invoke)
    return await invoke({ sender }, { messageId: `hk-${++seq}`, method, params }) as ZToolsResponse
  }
  assert.equal((await callFrom(main, 'event_subscribe', { key: 'system.ShellShortcutsChange' })).success, true)
  assert.equal((await callFrom(secondary, 'event_subscribe', { key: 'system.ShellShortcutsChange' })).success, true)

  const trayCountBeforeShellConfig = trayChangeCount.count
  const shellRaw = JSON.stringify({
    'focus-search': '  Ctrl+J  ',
    'open-settings': '',
    '__proto__': { polluted: true },
    'invalid-key': 'Ctrl+Q',
    'toggle-mode': 'Ctrl+U\nInjected'
  })
  const shellSetRes = await callFrom(main, 'config_set', {
    file: 'user_settings.json',
    path: 'hotkey.shell',
    value: shellRaw,
    sync_enabled: true
  })
  assert.equal(shellSetRes.success, true)
  assert.equal(trayChangeCount.count, trayCountBeforeShellConfig + 1)

  const expectedShortcuts = { 'focus-search': 'Ctrl+J', 'open-settings': '' }
  for (const recipient of [main, secondary]) {
    const shellEvents = recipient.sent
      .map((item) => (item.payload as { msgData?: { envelope?: { type?: string; payload?: unknown } } })?.msgData?.envelope)
      .filter((env) => env?.type === 'system.ShellShortcutsChange')
    assert.equal(shellEvents.length, 1)
    assert.deepEqual(shellEvents[0]?.payload, {
      shortcuts: expectedShortcuts,
      raw: JSON.stringify(expectedShortcuts)
    })
  }

  // 写入其他配置路径不触发 system.ShellShortcutsChange
  const unrelatedRes = await callFrom(main, 'config_set', {
    file: 'user_settings.json',
    path: 'ui.wake_preference',
    value: 'dashboard',
    sync_enabled: true
  })
  assert.equal(unrelatedRes.success, true)
  const mainShellEventCount = main.sent
    .map((item) => (item.payload as { msgData?: { envelope?: { type?: string } } })?.msgData?.envelope)
    .filter((env) => env?.type === 'system.ShellShortcutsChange').length
  assert.equal(mainShellEventCount, 1)
}

async function verifyPluginRevokeIdempotency(
  registry: WindowRegistry,
  handlers: Map<string, (event: unknown, value: unknown) => unknown>
): Promise<void> {
  const { PluginInstallService } = require('../../src/main/services/plugin-install-service.js') as typeof import('../../src/main/services/plugin-install-service.js')
  const { DllPluginService } = require('../../src/main/services/dll-plugin-service.js') as typeof import('../../src/main/services/dll-plugin-service.js')
  const { TriggerService } = require('../../src/main/services/trigger-service.js') as typeof import('../../src/main/services/trigger-service.js')

  const main = new FixtureContents(21)
  registry.registerMain(main as unknown as WebContents)
  let seq = 0
  const call = async (method: string, params: unknown) => {
    const invoke = handlers.get('ztools:call')
    assert.ok(invoke)
    return await invoke({ sender: main }, { messageId: `rev-${++seq}`, method, params }) as ZToolsResponse
  }

  const origMarkRevoked = PluginInstallService.prototype.markRevoked
  const origUnloadPlugin = DllPluginService.prototype.unloadPlugin
  const origSyncEnabled = TriggerService.prototype.syncPluginEnabled
  const counters = { markRevoked: 0, unloadPlugin: 0, syncPluginEnabled: 0 }

  PluginInstallService.prototype.markRevoked = async function (...args) {
    counters.markRevoked += 1
    return origMarkRevoked.apply(this, args)
  }
  DllPluginService.prototype.unloadPlugin = async function (...args) {
    counters.unloadPlugin += 1
    return origUnloadPlugin.apply(this, args)
  }
  TriggerService.prototype.syncPluginEnabled = async function (...args) {
    counters.syncPluginEnabled += 1
    return origSyncEnabled.apply(this, args)
  }

  try {
    // 1. 首次下架：执行完整副作用
    const first = await call('plugin_revoke', { pluginId: 'demo-plugin', revoked: true, reason: 'policy violation' })
    assert.equal(first.success, true)
    assert.deepEqual(first.data, { success: true, pluginId: 'demo-plugin', revoked: true })
    assert.deepEqual(counters, { markRevoked: 1, unloadPlugin: 1, syncPluginEnabled: 1 })

    // 2. 相同 revoked 与 reason 重复调用：完全幂等跳过副作用
    const second = await call('plugin_revoke', { pluginId: 'demo-plugin', revoked: true, reason: 'policy violation' })
    assert.equal(second.success, true)
    assert.deepEqual(second.data, { success: true, pluginId: 'demo-plugin', revoked: true })
    assert.deepEqual(counters, { markRevoked: 1, unloadPlugin: 1, syncPluginEnabled: 1 })

    // 3. reason 变化时：应更新状态并执行副作用
    const changedReason = await call('plugin_revoke', { pluginId: 'demo-plugin', revoked: true, reason: 'updated reason' })
    assert.equal(changedReason.success, true)
    assert.deepEqual(counters, { markRevoked: 2, unloadPlugin: 2, syncPluginEnabled: 2 })

    // 4. 解除下架：执行一次 markRevoked（不触发 unload/sync false）
    const unrevoked = await call('plugin_revoke', { pluginId: 'demo-plugin', revoked: false })
    assert.equal(unrevoked.success, true)
    assert.deepEqual(counters, { markRevoked: 3, unloadPlugin: 2, syncPluginEnabled: 2 })

    // 5. 重复解除下架：状态未变，跳过重写 plugin_state.json
    const unrevokedAgain = await call('plugin_revoke', { pluginId: 'demo-plugin', revoked: false })
    assert.equal(unrevokedAgain.success, true)
    assert.deepEqual(counters, { markRevoked: 3, unloadPlugin: 2, syncPluginEnabled: 2 })
  } finally {
    PluginInstallService.prototype.markRevoked = origMarkRevoked
    DllPluginService.prototype.unloadPlugin = origUnloadPlugin
    TriggerService.prototype.syncPluginEnabled = origSyncEnabled
  }
}

// 独立 Node 子进程隔离 Electron 替身，不启动 Electron、原生辅助进程或系统剪贴板。
async function stopFixture(
  failFolderCleanup: boolean,
  mode: 'none' | 'window-close' | 'hotkey-integration' | 'plugin-revoke' = 'none'
): Promise<void> {
  const modules = require('node:module') as { _load: (name: string, ...args: unknown[]) => unknown }
  const load = modules._load
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false })
  const handlers = new Map<string, (event: unknown, value: unknown) => unknown>()
  const ipcMain = Object.assign(new EventEmitter(), {
    handle(channel: string, handler: (event: unknown, value: unknown) => unknown) { handlers.set(channel, handler) },
    removeHandler(channel: string) { handlers.delete(channel) }
  })
  const electron = { nativeTheme, ipcMain, shell: {}, BrowserWindow: {},
    globalShortcut: { register: () => true, unregister: () => {}, isRegistered: () => false, isSuspended: () => false },
    app: { isReady: () => true } }
  modules._load = function (name, ...args) { return name === 'electron' ? electron : load.call(this, name, ...args) }
  const { IpcRouter } = require('../../src/main/ipc/router.js') as typeof import('../../src/main/ipc/router.js')
  const { runtimePathsForBusinessDataRoot } = require('../../src/main/runtime/runtime-paths.js') as typeof import('../../src/main/runtime/runtime-paths.js')
  const { FolderSyncService } = require('../../src/main/services/folder-sync-service.js') as typeof import('../../src/main/services/folder-sync-service.js')
  const { FontManagerService } = require('../../src/main/services/font-manager-service.js') as typeof import('../../src/main/services/font-manager-service.js')
  const { MediaMetadataService } = require('../../src/main/services/media-metadata-service.js') as typeof import('../../src/main/services/media-metadata-service.js')
  const { OfficeDocumentService } = require('../../src/main/services/office-document-service.js') as typeof import('../../src/main/services/office-document-service.js')
  const { WindowRegistry } = require('../../src/main/windows/window-registry.js') as typeof import('../../src/main/windows/window-registry.js')
  modules._load = load
  const calls = { folder: 0, fonts: 0, media: 0, office: 0 }
  let releaseFolder: () => void = () => {}
  const gate = new Promise<void>(resolve => { releaseFolder = resolve })
  const stopFolder = FolderSyncService.prototype.stop
  FolderSyncService.prototype.stop = async function () {
    calls.folder++; await gate; await stopFolder.call(this)
    if (failFolderCleanup) throw new Error('TEST_FOLDER_CLEANUP_FAILED')
  }
  const stopFonts = FontManagerService.prototype.stop
  FontManagerService.prototype.stop = function () { calls.fonts++; stopFonts.call(this) }
  const stopMedia = MediaMetadataService.prototype.stop
  MediaMetadataService.prototype.stop = function () { calls.media++; stopMedia.call(this) }
  const stopOffice = OfficeDocumentService.prototype.stop
  OfficeDocumentService.prototype.stop = function () { calls.office++; stopOffice.call(this) }

  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-router-stop-'))
  const removedListeners = new Set<(id: number) => void>()
  const registry = new WindowRegistry()
  const onRemoved = registry.onRemoved.bind(registry)
  registry.onRemoved = listener => {
    removedListeners.add(listener)
    const unsubscribe = onRemoved(listener)
    return () => { removedListeners.delete(listener); unsubscribe() }
  }
  const mouseConfigs: unknown[] = []
  const configWrites: Array<{ file: string; path: string; value: unknown }> = []
  const trayChangeCount = { count: 0 }
  let packagedFlag = false
  const nativeHost = { state: 'ready', onDllEvent() { return () => {} }, onInputEvent() { return () => {} },
    onLifecycleEvent() { return () => {} }, async configureMouseTrigger() {} }
  const nativeInput = mode === 'hotkey-integration'
    ? {
        state: 'ready',
        onInputEvent() { return () => {} },
        onLifecycleEvent() { return () => {} },
        async configureKeyboardDoubleTap() {},
        async configureMouseTrigger(cfg: unknown) { mouseConfigs.push(cfg) }
      }
    : undefined
  const services = {
    dataRoot, runtimePaths: runtimePathsForBusinessDataRoot(dataRoot), appVersion: 'test', webVersion: 'test',
    config: {
      async get() { return mode === 'hotkey-integration' ? 'ember' : JSON.stringify({ enabled: false }) },
      async set(file: string, keyPath: string, value: unknown) { configWrites.push({ file, path: keyPath, value }) },
      async setSetting() {}
    },
    user: {}, analytics: { stop() {} }, clipboardHistory: { useImageThumbnailer() {} }, nativeHost,
    ...(nativeInput ? { nativeInput } : {}),
    serviceClient: null,
    update: { onProgress() { return () => {} } }, async stop() {}
  } as unknown as CoreServices
  const options = {
    toggleMainWindow() {}, closeConfirmationResolved() {},
    screenClipboardAdapters: {},
    ...(mode === 'hotkey-integration'
      ? {
          initialWakeHotkey: 'Alt+Space',
          onTrayStatePossiblyChanged: () => { trayChangeCount.count += 1 }
        }
      : {}),
    pluginResources: { webRoot: path.join(dataRoot, 'web'), pluginRoot: path.join(dataRoot, 'Plugins'),
      ztoolsApiPath: 'missing-sdk', preloadPath: 'missing-preload' },
    systemPlatformAdapter: { userDataPath: dataRoot, getRuntimeTarget() {
      return { platform: process.platform, runtime: 'electron', arch: process.arch }
    }, async getNativeId() { return '' } }, processDiscoveryAdapter: { async list() { return [] } }
  } as unknown as IpcRouterOptions
  const mainApp = { getPath: () => dataRoot, getAppPath: () => dataRoot,
    get isPackaged() { return packagedFlag },
    runningUnderARM64Translation: false, async getFileIcon() { return { toDataURL: () => '' } }
  } as unknown as Parameters<typeof IpcRouter.create>[3]
  let router: Awaited<ReturnType<typeof IpcRouter.create>> | undefined
  try {
    router = await IpcRouter.create(registry as never, services, options, mainApp)
    assert.ok(removedListeners.size > 0)
    if (mode === 'window-close') {
      router.register()
      await verifyWindowCloseCallers(registry, handlers, dataRoot)
    } else if (mode === 'hotkey-integration') {
      router.register()
      await verifyHotkeyAndSystemIntegration(
        router,
        registry,
        handlers,
        configWrites,
        trayChangeCount,
        mouseConfigs,
        (value) => { packagedFlag = value }
      )
    } else if (mode === 'plugin-revoke') {
      router.register()
      await verifyPluginRevokeIdempotency(registry, handlers)
    }
    const pending = router.stop()
    assert.equal(router.stop(), pending, '重复停止必须共用同一清理任务')
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, { folder: 1, fonts: 1, media: 1, office: 1 })
    assert.equal(settled, false, '必须等待目录同步资源释放完成')
    releaseFolder()
    if (failFolderCleanup) await assert.rejects(pending, error => error instanceof AggregateError &&
      error.errors.some(item => item instanceof Error && item.message === 'TEST_FOLDER_CLEANUP_FAILED'))
    else await pending
    assert.equal(removedListeners.size, 0, '服务失败也必须注销全部窗口关闭监听')
    assert.equal(nativeTheme.listenerCount('updated'), 0)
    assert.deepEqual(calls, { folder: 1, fonts: 1, media: 1, office: 1 })
  } finally {
    releaseFolder()
    await router?.stop().catch(() => {})
    await fs.rm(dataRoot, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--router-stop-fixture') {
  const arg = process.argv[3]
  const mode = arg === 'window-close'
    ? 'window-close'
    : arg === 'hotkey-integration'
      ? 'hotkey-integration'
      : arg === 'plugin-revoke'
        ? 'plugin-revoke'
        : 'none'
  void stopFixture(arg === 'failure', mode).catch(error => { console.error(error); process.exitCode = 1 })
} else {
  for (const scenario of ['success', 'failure']) {
    test(`生产路由正常停止回收四服务与监听，等待清理且隔离单项失败：${scenario}`, async () => {
      await promisify(execFile)(process.execPath, [__filename, '--router-stop-fixture', scenario], { timeout: 15000 })
    })
  }
  test('真实路由：宿主关闭全部插件窗口覆盖声明式 popout，实例和插件调用不扩大范围且主窗口会话保留', async () => {
    await promisify(execFile)(process.execPath, [__filename, '--router-stop-fixture', 'window-close'], { timeout: 15000 })
  })
  test('真实路由：冷启动唤醒加载、全局热键改写同步 user_settings 与托盘、鼠标钩子路由放行及正式版 DevTools 拦截', async () => {
    await promisify(execFile)(process.execPath, [__filename, '--router-stop-fixture', 'hotkey-integration'], { timeout: 15000 })
  })
  test('真实路由：plugin_revoke 幂等守卫在状态与原因未变时跳过重复落盘与卸载扫描', async () => {
    await promisify(execFile)(process.execPath, [__filename, '--router-stop-fixture', 'plugin-revoke'], { timeout: 15000 })
  })
}
