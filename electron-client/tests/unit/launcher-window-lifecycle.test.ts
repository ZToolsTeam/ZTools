import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { WindowRegistry } from '../../src/main/windows/window-registry.js'

class NativeWindow extends EventEmitter {
  static latest: NativeWindow
  visible = false
  focused = false
  destroyed = false
  occluded = false
  shows = 0
  hides = 0
  workspaceConversions = 0
  bounds = { x: 0, y: 0, width: 750, height: 480 }
  webContents = Object.assign(new EventEmitter(), {
    id: 100,
    mainFrame: { frame: 'main-launcher' },
    isDestroyed: () => this.destroyed,
    setBackgroundThrottling: (_enabled: boolean) => undefined,
    setFrameRate: (_fps: number) => undefined,
    executeJavaScript: async () => true
  })
  constructor(readonly options: Electron.BrowserWindowConstructorOptions) { super(); NativeWindow.latest = this }
  isVisible(): boolean { return this.visible && !this.occluded }
  isFocused(): boolean { return this.focused }
  isDestroyed(): boolean { return this.destroyed }
  isMinimized(): boolean { return false }
  restore(): void { this.visible = true }
  show(): void { this.shows++; this.visible = true; this.emit('show') }
  focus(): void { this.focused = true; this.emit('focus') }
  hide(): void {
    this.hides++
    this.visible = false
    const wasFocused = this.focused
    this.focused = false
    if (wasFocused) this.emit('blur')
    this.emit('hide')
  }
  destroy(): void { this.destroyed = true; this.webContents.emit('destroyed'); this.emit('closed') }
  setVisibleOnAllWorkspaces(): void { this.workspaceConversions++ }
  getBounds(): typeof this.bounds { return this.bounds }
  setBounds(bounds: typeof this.bounds): void { this.bounds = bounds }
  async loadURL(): Promise<void> {}
}

// 只替换原生 Electron 边界；真实 LauncherController、FrameSyncManager、WindowRegistry 串联运行。
const screen = Object.assign(new EventEmitter(), {
  getCursorScreenPoint: () => ({ x: 100, y: 100 }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
})
const handlers = new Map<string, unknown>()
const electron = { BrowserWindow: NativeWindow, screen, nativeTheme: { shouldUseDarkColors: true },
  ipcMain: { handle: (name: string, fn: unknown) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) }
}
const modules = require('node:module') as { _load: (name: string, ...args: unknown[]) => unknown }
const originalLoad = modules._load
let Controller: typeof import('../../src/main/windows/launcher-controller.js').LauncherController
let handleBeforeInput: typeof import('../../src/main/windows/launcher-controller.js').handleLauncherBeforeInputEvent
try {
  modules._load = function (name, ...args) { return name === 'electron' ? electron : originalLoad.call(this, name, ...args) }
  const launcherModule = require('../../src/main/windows/launcher-controller.js') as typeof import('../../src/main/windows/launcher-controller.js')
  Controller = launcherModule.LauncherController
  handleBeforeInput = launcherModule.handleLauncherBeforeInputEvent
} finally {
  modules._load = originalLoad
}

test('悬浮条跨窗口状态唤醒、失焦撤下及资源清理', async () => {
  let dashboardHides = 0
  const controller = new Controller({ icon: {} as Electron.NativeImage, registry: new WindowRegistry(),
    showMainWindow: () => undefined, hideMainWindow: () => { dashboardHides++ }
  })
  controller.register()
  try {
    controller.show()
    await new Promise(resolve => setImmediate(resolve))
    const window = NativeWindow.latest
    if (process.platform === 'darwin') {
      assert.equal(window.options.type, 'panel')
      assert.equal(window.options.fullscreenable, false, '跨桌面面板不能同时成为全屏主窗口')
      assert.equal(window.workspaceConversions, 0, 'panel 已支持跨桌面，不能再改变整个应用的激活策略')
    }
    assert.equal(controller.isFocused(), true)
    // 仍映射在别处但未聚焦：下一次快捷键应显示，而不能反向隐藏。
    window.focused = false
    const shows = window.shows
    controller.toggle()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(window.shows, shows + 1)
    assert.equal(controller.isFocused(), true)
    controller.toggle()
    assert.equal(window.visible, false)
    controller.show()
    await new Promise(resolve => setImmediate(resolve))
    window.occluded = true
    window.focused = false
    window.emit('blur')
    assert.equal(window.visible, false, 'isVisible=false 也必须实际 hide')
    window.occluded = false
    controller.toggle()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(controller.isFocused(), true)
    assert.ok(dashboardHides >= 3)
  } finally {
    controller.stop()
  }
  assert.equal(NativeWindow.latest.destroyed, true)
  assert.equal(handlers.size, 0)
  assert.equal(screen.listenerCount('display-metrics-changed'), 0)
  assert.equal(screen.listenerCount('display-removed'), 0)
})

test('悬浮条：支持跟随鼠标位置弹出与面板数据/全类型固定/排序/打开 IPC 桥接', async () => {
  const pinCalls: Array<{ id: string; itemType: string }> = []
  const setPinCalls: Array<{ entry: unknown; pinned: unknown; caller?: CallerIdentity | undefined }> = []
  const reorderCalls: unknown[] = []
  const openCalls: Array<{ id: string; itemType: string; query?: string | undefined; action?: unknown }> = []
  const registry = new WindowRegistry()

  const mainWebContents = Object.assign(new EventEmitter(), {
    id: 50,
    mainFrame: { frame: 'main-dashboard' },
    isDestroyed: () => false
  }) as unknown as Electron.WebContents
  registry.registerMain(mainWebContents)

  const popoutWebContents = Object.assign(new EventEmitter(), {
    id: 51,
    mainFrame: { frame: 'popout' },
    isDestroyed: () => false
  }) as unknown as Electron.WebContents
  registry.registerMain(popoutWebContents)

  const pluginWebContents = Object.assign(new EventEmitter(), {
    id: 52,
    mainFrame: { frame: 'plugin' },
    isDestroyed: () => false
  }) as unknown as Electron.WebContents
  registry.registerPlugin(pluginWebContents, 'third-party-plugin', 'inst-1')

  const controller = new Controller({
    icon: {} as Electron.NativeImage,
    registry,
    isAuthorizedCaller: ({ senderId }) => senderId === mainWebContents.id || senderId === NativeWindow.latest?.webContents.id,
    showMainWindow: () => undefined,
    hideMainWindow: () => undefined,
    panelBridge: {
      getData: async () => ({ success: true, data: { items: [{ id: 'json-format', type: 'plugin', pinned: true }] } }),
      togglePin: async (id, itemType) => {
        pinCalls.push({ id, itemType })
        return { success: true }
      },
      setPin: async (entry, pinned, caller) => {
        setPinCalls.push({ entry, pinned, caller })
        return { success: true, pinned: Boolean(pinned), pinKey: 'builtin:system:lock', pinnedEntries: [] }
      },
      reorderPins: async (order) => {
        reorderCalls.push(order)
        return { success: true, pinnedEntries: [] }
      },
      openItem: async (id, itemType, query, action) => {
        openCalls.push({ id, itemType, query, action })
        if (id === 'file:missing') {
          throw new Error('固定项目标不存在或已失效')
        }
        if (id === 'file:soft-fail') {
          return { success: false, error: '目标打开失败' }
        }
        return { success: true }
      }
    }
  })

  controller.register()
  try {
    controller.show({ position: 'cursor' })
    await new Promise(resolve => setImmediate(resolve))
    const window = NativeWindow.latest
    assert.equal(window.visible, true)
    assert.equal(controller.webContentsId, window.webContents.id)
    // 鼠标在 (100, 100)，窗口应当按光标相对位置定位而非屏幕正中心 (585, 194)
    assert.notEqual(window.bounds.x, 585)

    // 与 launcher-controller 中 ipcMain.handle 的真实签名一致：(event, action, payload)
    const callHandler = handlers.get('ztools:launcher_call') as (
      event: unknown,
      action: string,
      payload?: Record<string, unknown>
    ) => Promise<Record<string, unknown>>
    assert.equal(typeof callHandler, 'function')

    const validLauncherEvent = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const validMainEvent = { sender: mainWebContents, senderFrame: (mainWebContents as unknown as { mainFrame: unknown }).mainFrame }

    const panelDataRes = await callHandler(validLauncherEvent, 'get_panel_data')
    assert.equal(panelDataRes.success, true)
    assert.equal((panelDataRes.data as { items: unknown[] }).items.length, 1)

    const pinRes = await callHandler(validLauncherEvent, 'toggle_pin', { id: 'json-format', itemType: 'plugin' })
    assert.equal(pinRes.success, true)
    assert.deepEqual(pinCalls, [{ id: 'json-format', itemType: 'plugin' }])

    const setPinRes = await callHandler(validMainEvent, 'set_pin', {
      entry: { kind: 'builtin', commandKey: 'system:lock' },
      pinned: true
    })
    assert.equal(setPinRes.success, true)
    assert.equal(setPinCalls.length, 1)
    assert.equal(setPinCalls[0]?.caller?.webContentsId, mainWebContents.id)

    const reorderRes = await callHandler(validLauncherEvent, 'reorder_pins', { order: ['builtin:system:lock'] })
    assert.equal(reorderRes.success, true)
    assert.deepEqual(reorderCalls, [['builtin:system:lock']])

    // 已下线的 add_local_app 动作必须明确拒绝
    const addRes = await callHandler(validLauncherEvent, 'add_local_app')
    assert.deepEqual(addRes, { success: false, error: '未知动作' })

    // 打开已失效固定项失败（抛错或返回 success: false）时保持悬浮条可见以显示错误提示
    const missingOpenRes = await callHandler(validLauncherEvent, 'open_panel_item', {
      id: 'file:missing',
      itemType: 'pinned',
      action: 'open'
    })
    assert.equal(missingOpenRes.success, false)
    assert.match(String(missingOpenRes.error), /不存在或已失效/)
    assert.equal(window.visible, true)

    const softFailRes = await callHandler(validLauncherEvent, 'open_panel_item', {
      id: 'file:soft-fail',
      itemType: 'pinned',
      action: 'reveal'
    })
    assert.equal(softFailRes.success, false)
    assert.equal(window.visible, true)

    // 成功打开后应自动隐藏悬浮条
    const openRes = await callHandler(validLauncherEvent, 'open_panel_item', {
      id: 'sys-calc',
      itemType: 'system_tool',
      query: 'calc',
      action: 'reveal'
    })
    assert.equal(openRes.success, true)
    assert.equal(window.visible, false)
    assert.deepEqual(openCalls.at(-1), { id: 'sys-calc', itemType: 'system_tool', query: 'calc', action: 'reveal' })

    // 破坏性安全断言：拒绝插件窗口、popout 窗口、未注册发送方、iframe 与 null frame，且绝不执行任何动作
    const beforeSetPinCount = setPinCalls.length
    const badEvents: unknown[] = [
      undefined,
      {},
      { sender: { id: 9999, mainFrame: { frame: 'unknown' } }, senderFrame: { frame: 'unknown' } },
      { sender: pluginWebContents, senderFrame: (pluginWebContents as unknown as { mainFrame: unknown }).mainFrame },
      { sender: popoutWebContents, senderFrame: (popoutWebContents as unknown as { mainFrame: unknown }).mainFrame },
      { sender: window.webContents, senderFrame: { frame: 'iframe-child' } },
      { sender: window.webContents, senderFrame: null }
    ]
    for (const badEvent of badEvents) {
      for (const action of ['get_panel_data', 'set_pin', 'reorder_pins', 'show', 'hide', 'toggle', 'expand_to_dashboard']) {
        const denied = await callHandler(badEvent, action, {
          entry: { kind: 'builtin', commandKey: 'hack' },
          pinned: true
        })
        assert.equal(denied.success, false)
        assert.equal(denied.error, '无权调用悬浮条宿主接口')
      }
    }
    assert.equal(setPinCalls.length, beforeSetPinCount)

    // payload 伪造 attributedPlugin 同样被拒
    const spoofedPayloadRes = await callHandler(validLauncherEvent, 'set_pin', {
      entry: { kind: 'builtin', commandKey: 'hack' },
      pinned: true,
      attributedPlugin: { pluginId: 'evil' }
    })
    assert.equal(spoofedPayloadRes.success, false)
    assert.equal(spoofedPayloadRes.error, '无权调用悬浮条宿主接口')
    assert.equal(setPinCalls.length, beforeSetPinCount)
  } finally {
    controller.stop()
  }
})

test('launcher_call 拒绝带 attributedPlugin 或 stalePluginSession 的伪装调用方', async () => {
  const spoofedMainFrame = { frame: 'main' }
  const fakeRegistry = {
    get: (id: number): CallerIdentity | undefined => {
      if (id === 201) {
        return {
          type: 'main',
          webContentsId: 201,
          attributedPlugin: {
            pluginId: 'declarative-plugin',
            sessionId: 'sess-1',
            permissions: new Set(),
            source: 'installed'
          }
        }
      }
      if (id === 202) {
        return {
          type: 'main',
          webContentsId: 202,
          stalePluginSession: true
        }
      }
      return undefined
    }
  } as unknown as WindowRegistry

  let called = false
  const controller = new Controller({
    icon: {} as Electron.NativeImage,
    registry: fakeRegistry,
    showMainWindow: () => { called = true },
    hideMainWindow: () => undefined,
    panelBridge: {
      getData: async () => { called = true; return { success: true } },
      togglePin: async () => { called = true; return { success: true } },
      setPin: async () => { called = true; return { success: true } },
      openItem: async () => { called = true; return { success: true } }
    }
  })

  controller.register()
  try {
    const callHandler = handlers.get('ztools:launcher_call') as (
      event: unknown,
      action: string,
      payload?: Record<string, unknown>
    ) => Promise<Record<string, unknown>>

    for (const senderId of [201, 202]) {
      for (const action of ['get_panel_data', 'set_pin', 'show', 'expand_to_dashboard']) {
        const res = await callHandler({ sender: { id: senderId, mainFrame: spoofedMainFrame }, senderFrame: spoofedMainFrame }, action, {})
        assert.equal(res.success, false)
        assert.equal(res.error, '无权调用悬浮条宿主接口')
      }
    }
    assert.equal(called, false)
  } finally {
    controller.stop()
  }
})

test('悬浮窗 before-input 仅拦截纯 Alt+Space，不误拦其它带修饰键的 Space 组合', () => {
  let hideCalls = 0
  let prevented = 0
  const fakeEvent = { preventDefault: () => { prevented += 1 } }
  const fakeTarget = { hide: () => { hideCalls += 1 } }
  // Alt+Shift+Space / Ctrl+Alt+Space 不得被纯 Alt+Space 逻辑误拦
  assert.equal(
    handleBeforeInput(fakeEvent, { alt: true, shift: true, code: 'Space', key: ' ', type: 'keyDown' }, fakeTarget),
    false
  )
  assert.equal(
    handleBeforeInput(fakeEvent, { alt: true, control: true, code: 'Space', key: ' ', type: 'keyDown' }, fakeTarget),
    false
  )
  assert.equal(hideCalls, 0)
  assert.equal(prevented, 0)

  // 纯 Alt+Space 仍照常拦截并隐藏
  assert.equal(
    handleBeforeInput(fakeEvent, { alt: true, code: 'Space', key: ' ', type: 'keyDown' }, fakeTarget),
    true
  )
  assert.equal(hideCalls, 1)
  assert.equal(prevented, 1)
})
