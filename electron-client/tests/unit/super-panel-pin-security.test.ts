import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { ConfigService } from '../../src/main/services/config-service.js'
import { EventService } from '../../src/main/services/event-service.js'
import { FileSystemService } from '../../src/main/services/file-system-service.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'
import { PluginStateService } from '../../src/main/services/plugin-state-service.js'
import { WindowRegistry } from '../../src/main/windows/window-registry.js'

class MockBrowserWindow extends EventEmitter {
  static latest: MockBrowserWindow
  visible = false
  focused = false
  destroyed = false
  bounds = { x: 0, y: 0, width: 750, height: 480 }
  webContents = Object.assign(new EventEmitter(), {
    id: 300,
    mainFrame: { frame: 'launcher-main' },
    isDestroyed: () => this.destroyed,
    setBackgroundThrottling: (_enabled: boolean) => undefined,
    setFrameRate: (_fps: number) => undefined,
    executeJavaScript: async () => true
  })

  constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
    super()
    MockBrowserWindow.latest = this
  }

  isVisible(): boolean { return this.visible }
  isFocused(): boolean { return this.focused }
  isDestroyed(): boolean { return this.destroyed }
  isMinimized(): boolean { return false }
  restore(): void { this.visible = true }
  show(): void { this.visible = true; this.emit('show') }
  focus(): void { this.focused = true; this.emit('focus') }
  hide(): void { this.visible = false; this.focused = false; this.emit('hide') }
  destroy(): void { this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed') }
  setVisibleOnAllWorkspaces(): void {}
  getBounds(): typeof this.bounds { return this.bounds }
  setBounds(bounds: typeof this.bounds): void { this.bounds = bounds }
  async loadURL(): Promise<void> {}
}

const ipcHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
const openedTargets: string[] = []
const revealedTargets: string[] = []

const mockElectron = {
  app: {
    getFileIcon: async () => ({ toDataURL: () => 'data:image/png;base64,AA==' })
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] })
  },
  shell: {
    openPath: async (target: string) => {
      openedTargets.push(target)
      return ''
    },
    showItemInFolder: (target: string) => {
      revealedTargets.push(target)
    }
  },
  BrowserWindow: MockBrowserWindow,
  screen: Object.assign(new EventEmitter(), {
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  }),
  nativeTheme: { shouldUseDarkColors: false },
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      ipcHandlers.set(name, fn)
    },
    removeHandler: (name: string) => {
      ipcHandlers.delete(name)
    }
  }
}

const nodeModule = require('node:module') as { _load: (name: string, ...args: unknown[]) => unknown }
const previousLoad = nodeModule._load
let SuperPanelControllerClass: typeof import('../../src/main/super-panel/controller.js').SuperPanelController
let LauncherControllerClass: typeof import('../../src/main/windows/launcher-controller.js').LauncherController

try {
  nodeModule._load = function (name, ...args) {
    return name === 'electron' ? mockElectron : previousLoad.call(this, name, ...args)
  }
  SuperPanelControllerClass = (require('../../src/main/super-panel/controller.js') as typeof import('../../src/main/super-panel/controller.js')).SuperPanelController
  LauncherControllerClass = (require('../../src/main/windows/launcher-controller.js') as typeof import('../../src/main/windows/launcher-controller.js')).LauncherController
} finally {
  nodeModule._load = previousLoad
}

async function createSymlinkOrJunction(targetPath: string, linkPath: string, isDir: boolean): Promise<boolean> {
  try {
    await fs.symlink(targetPath, linkPath, isDir ? 'dir' : 'file')
    return true
  } catch (error) {
    if (process.platform === 'win32' && isDir && (error as NodeJS.ErrnoException).code === 'EPERM') {
      await fs.symlink(targetPath, linkPath, 'junction')
      return true
    }
    return false
  }
}

test('真实装配集成：读权限校验、路径规范化、符号链接拒绝、失效打开拦截与无授权取消固定', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-pin-sec-'))
  const dataRoot = path.join(root, 'data')
  const cacheRoot = path.join(root, 'cache')
  const workDir = path.join(root, 'work')
  const subDir = path.join(workDir, 'sub')
  const outsideFile = path.join(root, 'outside-secret.txt')
  const allowedFile = path.join(workDir, 'report.txt')
  await fs.mkdir(dataRoot, { recursive: true })
  await fs.mkdir(subDir, { recursive: true })
  await fs.writeFile(outsideFile, 'secret', 'utf8')
  await fs.writeFile(allowedFile, 'report', 'utf8')

  openedTargets.length = 0
  revealedTargets.length = 0

  const registry = new WindowRegistry()
  const mainWebContents = Object.assign(new EventEmitter(), {
    id: 1,
    mainFrame: { frame: 'main-web' },
    isDestroyed: () => false,
    send: () => undefined
  }) as unknown as Electron.WebContents
  const mainCaller = registry.registerMain(mainWebContents)

  const store = new JsonFileStore(dataRoot, ConfigService.allowedStoreFiles)
  const config = new ConfigService(store)
  const files = new FileSystemService(registry, cacheRoot)
  const pluginState = new PluginStateService(dataRoot)
  const events = new EventService(registry)

  const superPanel = new SuperPanelControllerClass({
    dataRoot,
    config,
    pluginState,
    getInstalledPlugins: async () => ({ success: true, data: [] }),
    openPlugin: async () => ({ success: true }),
    resolveAuthorizedReadPath: async (rawPath, caller) => {
      if (!caller) throw new Error('缺少调用方身份')
      return files.resolveAuthorizedPath(rawPath, caller, 'read', false)
    },
    revealPath: (fullPath) => {
      revealedTargets.push(fullPath)
    },
    onChanged: () => {
      events.publishHostToMain('super_panel_changed', {})
    }
  })

  let launcher: InstanceType<typeof LauncherControllerClass> | undefined
  launcher = new LauncherControllerClass({
    icon: {} as Electron.NativeImage,
    registry,
    isAuthorizedCaller: ({ senderId }): boolean =>
      senderId === mainWebContents.id || senderId === launcher?.webContentsId,
    showMainWindow: () => undefined,
    hideMainWindow: () => undefined,
    panelBridge: {
      getData: () => superPanel.getData(),
      togglePin: (id, itemType) => superPanel.togglePin(id, itemType),
      setPin: (entry, pinned, caller) => superPanel.setPin(entry, pinned, caller),
      reorderPins: (order) => superPanel.reorderPins(order),
      openItem: (id, itemType, query, action) => superPanel.openPanelItem(id, itemType, query, action)
    }
  })

  context.after(async () => {
    launcher?.stop()
    await superPanel.stop()
    events.stop()
    await files.stop()
    await fs.rm(root, { recursive: true, force: true })
  })

  launcher.register()
  launcher.show()
  await new Promise((resolve) => setImmediate(resolve))
  const callHandler = ipcHandlers.get('ztools:launcher_call')
  assert.ok(callHandler)
  const mainEvent = { sender: mainWebContents, senderFrame: (mainWebContents as unknown as { mainFrame: unknown }).mainFrame }
  const launcherEvent = {
    sender: MockBrowserWindow.latest.webContents,
    senderFrame: MockBrowserWindow.latest.webContents.mainFrame
  }

  // 1. 未授读权限的路径拒绝固定
  const unauthorizedRes = await callHandler(mainEvent, 'set_pin', {
    entry: { kind: 'file', path: outsideFile, name: 'outside-secret.txt', isDir: false, isApplication: false },
    pinned: true
  }) as { success: boolean; error?: string }
  assert.equal(unauthorizedRes.success, false)
  assert.match(String(unauthorizedRes.error), /未由当前窗口授权/)

  // 2. 授予 mainCaller 读取 allowedFile 的权限后，通过含 .. 的路径固定，入库路径必须规范化
  await files.grantResultPaths(mainCaller, [{ path: allowedFile, isDir: false }], 'search')
  const traversedInput = path.join(subDir, '..', 'report.txt')
  const pinRes = await callHandler(mainEvent, 'set_pin', {
    entry: { kind: 'file', path: traversedInput, name: 'report.txt', isDir: false, isApplication: false },
    pinned: true
  }) as { success: boolean; pinKey: string; pinnedEntries: Array<{ entry: { path?: string } }> }
  assert.equal(pinRes.success, true)
  const realAllowedFile = await fs.realpath(allowedFile)
  assert.equal(pinRes.pinnedEntries[0]?.entry.path, realAllowedFile)

  // 3. 符号链接（文件符号链接与目录联接）即使指向已授权目标也必须拒绝固定
  const fileLink = path.join(workDir, 'link-to-report.txt')
  if (await createSymlinkOrJunction(allowedFile, fileLink, false)) {
    const fileLinkRes = await callHandler(mainEvent, 'set_pin', {
      entry: { kind: 'file', path: fileLink, name: 'link-to-report.txt', isDir: false, isApplication: false },
      pinned: true
    }) as { success: boolean; error?: string }
    assert.equal(fileLinkRes.success, false)
    assert.match(String(fileLinkRes.error), /符号链接/)
  }

  const dirLink = path.join(workDir, 'link-to-sub')
  if (await createSymlinkOrJunction(subDir, dirLink, true)) {
    await files.grantOpenPath(subDir, mainCaller)
    const symlinkRes = await callHandler(mainEvent, 'set_pin', {
      entry: { kind: 'file', path: dirLink, name: 'link-to-sub', isDir: true, isApplication: false },
      pinned: true
    }) as { success: boolean; error?: string }
    assert.equal(symlinkRes.success, false)
    assert.match(String(symlinkRes.error), /符号链接/)
  }

  // 4. open_panel_item 传入未在白名单固定的路径被拒绝，且悬浮条不隐藏
  assert.equal(MockBrowserWindow.latest.visible, true)
  const unpinnedOpenRes = await callHandler(launcherEvent, 'open_panel_item', {
    id: `file:${outsideFile}`,
    itemType: 'pinned',
    action: 'open'
  }) as { success: boolean; error?: string }
  assert.equal(unpinnedOpenRes.success, false)
  assert.match(String(unpinnedOpenRes.error), /不存在或已失效/)
  assert.deepEqual(openedTargets, [])
  assert.equal(MockBrowserWindow.latest.visible, true)

  // 5. 文件被删除后：getData 返回 available=false，打开报错并保持窗口，但可无需权限直接取消固定
  await fs.rm(realAllowedFile)
  const dataAfterDelete = await callHandler(launcherEvent, 'get_panel_data') as {
    success: boolean
    pinnedEntries: Array<{ pinKey: string; available: boolean }>
  }
  assert.equal(dataAfterDelete.pinnedEntries[0]?.available, false)

  const openDeletedRes = await callHandler(launcherEvent, 'open_panel_item', {
    id: pinRes.pinKey,
    itemType: 'pinned',
    action: 'open'
  }) as { success: boolean; error?: string }
  assert.equal(openDeletedRes.success, false)
  assert.match(String(openDeletedRes.error), /不存在或已失效/)
  assert.equal(MockBrowserWindow.latest.visible, true)

  // 用不具备该路径读授权的悬浮条窗口也能取消固定失效文件
  const unpinRes = await callHandler(launcherEvent, 'set_pin', {
    entry: { kind: 'file', path: realAllowedFile, name: 'report.txt', isDir: false, isApplication: false },
    pinned: false
  }) as { success: boolean; pinned: boolean; pinnedEntries: unknown[] }
  assert.equal(unpinRes.success, true)
  assert.equal(unpinRes.pinned, false)
  assert.deepEqual(unpinRes.pinnedEntries, [])

  // 6. 绿色 .exe 作为 kind: 'file' 固定（setPin）与打开（openPanelItem(..., 'pinned', '', 'open')）端到端正常跑通
  const greenExe = path.join(workDir, 'GreenPortable.exe')
  await fs.writeFile(greenExe, 'MZ-portable-exe', 'utf8')
  await files.grantResultPaths(mainCaller, [{ path: greenExe, isDir: false }], 'search')
  const pinGreenRes = await callHandler(mainEvent, 'set_pin', {
    entry: { kind: 'file', path: greenExe, name: 'GreenPortable.exe', isDir: false, isApplication: true },
    pinned: true
  }) as {
    success: boolean
    pinned: boolean
    pinKey: string
    pinnedEntries: Array<{ pinKey: string; available: boolean; iconUrl?: string; entry: { kind: string; path?: string } }>
  }
  assert.equal(pinGreenRes.success, true)
  assert.equal(pinGreenRes.pinned, true)
  const realGreenExe = await fs.realpath(greenExe)
  assert.equal(pinGreenRes.pinnedEntries[0]?.available, true)
  assert.equal(pinGreenRes.pinnedEntries[0]?.iconUrl, 'data:image/png;base64,AA==')
  assert.equal(pinGreenRes.pinnedEntries[0]?.entry.path, realGreenExe)

  await superPanel.openPanelItem(pinGreenRes.pinKey, 'pinned', '', 'open')
  assert.deepEqual(openedTargets, [realGreenExe])

  const launcherOpenGreenRes = await callHandler(launcherEvent, 'open_panel_item', {
    id: pinGreenRes.pinKey,
    itemType: 'pinned',
    query: '',
    action: 'open'
  }) as { success: boolean }
  assert.equal(launcherOpenGreenRes.success, true)
  assert.deepEqual(openedTargets, [realGreenExe, realGreenExe])

  // 7. 已下线的 local-app / add_local_app 全链路异常断言：setPin、togglePin、openPanelItem、launcher_call 均明确拒绝
  await assert.rejects(
    superPanel.setPin({ kind: 'local-app', appId: 'localapp:AABBCCDD' }, true, mainCaller),
    /固定项格式无效/
  )
  await assert.rejects(
    superPanel.togglePin('localapp:AABBCCDD', 'local'),
    /不支持的项目类型/
  )
  await assert.rejects(
    superPanel.openPanelItem('localapp:AABBCCDD', 'local'),
    /悬浮条项目无效/
  )

  const badSetPinRes = await callHandler(mainEvent, 'set_pin', {
    entry: { kind: 'local-app', appId: 'localapp:AABBCCDD' },
    pinned: true
  }) as { success: boolean; error?: string }
  assert.equal(badSetPinRes.success, false)
  assert.match(String(badSetPinRes.error), /固定项格式无效/)

  const badTogglePinRes = await callHandler(launcherEvent, 'toggle_pin', {
    id: 'localapp:AABBCCDD',
    itemType: 'local'
  }) as { success: boolean; error?: string }
  assert.equal(badTogglePinRes.success, false)
  assert.match(String(badTogglePinRes.error), /不支持的项目类型/)

  const badOpenLocalRes = await callHandler(launcherEvent, 'open_panel_item', {
    id: 'localapp:AABBCCDD',
    itemType: 'local'
  }) as { success: boolean; error?: string }
  assert.equal(badOpenLocalRes.success, false)
  assert.match(String(badOpenLocalRes.error), /悬浮条项目无效/)

  const removedAddLocalRes = await callHandler(launcherEvent, 'add_local_app') as {
    success: boolean
    error?: string
  }
  assert.deepEqual(removedAddLocalRes, { success: false, error: '未知动作' })
})

test('super_panel_changed 广播仅主进程发往宿主窗口，渲染进程伪造发布与请求被拒', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-pin-events-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))

  const sentMessages: Array<{ webContentsId: number; value: unknown }> = []
  const removedListeners = new Set<(id: number) => void>()
  const fakeRegistry = {
    send: (webContentsId: number, _channel: string, value: unknown) => {
      sentMessages.push({ webContentsId, value })
      return true
    },
    onRemoved: (listener: (id: number) => void) => {
      removedListeners.add(listener)
      return () => removedListeners.delete(listener)
    }
  }

  const events = new EventService(fakeRegistry)
  const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)
  const config = new ConfigService(store)
  const superPanel = new SuperPanelControllerClass({
    dataRoot: root,
    config,
    getInstalledPlugins: async () => ({ success: true, data: [] }),
    openPlugin: async () => ({ success: true }),
    onChanged: () => {
      events.publishHostToMain('super_panel_changed', {})
    }
  })

  context.after(async () => {
    await superPanel.stop()
    events.stop()
  })

  const mainCaller = { type: 'main' as const, webContentsId: 10 }
  const launcherCaller = { type: 'main' as const, webContentsId: 11 }
  const pluginCaller = { type: 'plugin' as const, webContentsId: 12, pluginId: 'demo', pluginInstanceId: 'inst-1' }

  events.subscribe({ key: 'super_panel_changed' }, mainCaller)
  events.subscribe({ key: 'super_panel_changed' }, launcherCaller)
  events.subscribe({ key: '*' }, pluginCaller)

  // 渲染进程不得伪造 super_panel_changed
  const forgedEnvelope = {
    envelopeId: 'forged-1',
    version: 'v1' as const,
    timestamp: Date.now(),
    type: 'super_panel_changed',
    scope: 'system' as const,
    source: { kind: 'host' },
    target: { broadcast: true as const },
    payload: {}
  }
  for (const caller of [mainCaller, pluginCaller]) {
    assert.throws(
      () => events.publish({ envelope: forgedEnvelope }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    assert.throws(
      () => events.request({ envelope: forgedEnvelope }, caller),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
  }
  assert.equal(sentMessages.length, 0)

  // 通过宿主 setPin 触发真实广播：仅投递给 main 窗口（10 和 11），插件窗口 12 收不到
  await superPanel.setPin({ kind: 'system-tool', toolId: 'this_pc' }, true)
  assert.deepEqual(sentMessages.map((msg) => msg.webContentsId).sort(), [10, 11])
  for (const msg of sentMessages) {
    const envelope = (msg.value as { msgData: { envelope: Record<string, unknown> } }).msgData.envelope
    assert.equal(envelope.type, 'super_panel_changed')
    assert.deepEqual(envelope.source, { kind: 'host' })
    assert.deepEqual(envelope.target, { main: true })
  }
})

test('preload/main.ts 仅在 ztools://web 主框架暴露 __ztoolsLauncher 及其新方法', async () => {
  const preloadPath = path.resolve(__dirname, '../../../src/preload/main.ts')
  const source = await fs.readFile(preloadPath, 'utf8')
  const startMarker = "if (isMainFrame && window.location?.protocol === 'ztools:'"
  const endMarker = 'const isLauncherWindow ='
  const snippet = source.slice(source.indexOf(startMarker), source.indexOf(endMarker))
  assert.ok(snippet.includes('__ztoolsLauncher'))
  const transpiled = ts.transpile(snippet, { target: ts.ScriptTarget.ES2022 })

  const runBranch = (isMainFrame: boolean, protocol: string, hostname: string) => {
    const exposed: Record<string, Record<string, (...args: unknown[]) => unknown>> = {}
    const invoked: Array<{ channel: string; args: unknown[] }> = []
    vm.runInNewContext(transpiled, {
      isMainFrame,
      window: { location: { protocol, hostname } },
      contextBridge: {
        exposeInMainWorld: (name: string, value: Record<string, (...args: unknown[]) => unknown>) => {
          exposed[name] = value
        }
      },
      ipcRenderer: {
        invoke: (channel: string, ...args: unknown[]) => {
          invoked.push({ channel, args })
          return Promise.resolve({ success: true })
        }
      },
      invoke: () => Promise.resolve({ success: true })
    })
    return { exposed, invoked }
  }

  // 非 ztools://web 与 iframe 一律不暴露
  for (const [isMainFrame, protocol, hostname] of [
    [false, 'ztools:', 'web'],
    [true, 'ztools:', 'plugins'],
    [true, 'https:', 'evil.example'],
    [true, 'file:', '']
  ] as const) {
    const result = runBranch(isMainFrame, protocol, hostname)
    assert.equal('__ztoolsLauncher' in result.exposed, false, `${String(isMainFrame)}:${protocol}//${hostname}`)
  }

  // 主框架 ztools://web 正常暴露冻结的桥接对象并包含 setPin / reorderPins / openPanelItem(action)
  const webResult = runBranch(true, 'ztools:', 'web')
  const api = webResult.exposed.__ztoolsLauncher
  assert.ok(api)
  assert.ok(Object.isFrozen(api))
  const { setPin, reorderPins, openPanelItem } = api
  assert.equal('addLocalApp' in api, false)
  assert.equal(typeof setPin, 'function')
  assert.equal(typeof reorderPins, 'function')
  assert.equal(typeof openPanelItem, 'function')
  if (!setPin || !reorderPins || !openPanelItem) {
    throw new Error('__ztoolsLauncher 方法缺失')
  }

  await setPin({ kind: 'builtin', commandKey: 'system:lock' }, true)
  await reorderPins(['builtin:system:lock'])
  await openPanelItem('file:c:\\a.txt', 'pinned', 'q', 'reveal')
  assert.deepEqual(JSON.parse(JSON.stringify(webResult.invoked)), [
    {
      channel: 'ztools:launcher_call',
      args: ['set_pin', { entry: { kind: 'builtin', commandKey: 'system:lock' }, pinned: true }]
    },
    {
      channel: 'ztools:launcher_call',
      args: ['reorder_pins', { order: ['builtin:system:lock'] }]
    },
    {
      channel: 'ztools:launcher_call',
      args: ['open_panel_item', { id: 'file:c:\\a.txt', itemType: 'pinned', query: 'q', action: 'reveal' }]
    }
  ])
})
