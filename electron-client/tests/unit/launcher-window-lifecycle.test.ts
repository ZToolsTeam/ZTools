import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
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
try {
  modules._load = function (name, ...args) { return name === 'electron' ? electron : originalLoad.call(this, name, ...args) }
  Controller = (require('../../src/main/windows/launcher-controller.js') as typeof import('../../src/main/windows/launcher-controller.js')).LauncherController
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
