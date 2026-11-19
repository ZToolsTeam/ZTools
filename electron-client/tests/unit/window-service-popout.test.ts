import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { BrowserWindow, Session, WebContents } from 'electron'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes } from '../../src/contracts/errors.js'
import type { FileSystemService } from '../../src/main/services/file-system-service.js'
import { extractPopoutKey, requireLocalUrl, WindowService } from '../../src/main/services/window-service.js'
import {
  POPOUT_TITLE_BAR_HEIGHT,
  TRANSPARENT_TITLE_BAR_OVERLAY_COLOR,
  WM_SYSCHAR
} from '../../src/main/windows/main-window.js'
import { WindowRegistry } from '../../src/main/windows/window-registry.js'

class FakePopoutWindow extends EventEmitter {
  #destroyed = false
  #minimized = false
  #shown = false
  #focused = false
  #bounds = { x: 120, y: 80, width: 1140, height: 760 }
  loadedUrls: string[] = []
  overlays: Electron.TitleBarOverlayOptions[] = []
  backgrounds: string[] = []
  hookedMessages: number[] = []
  menuRemoved = false
  shouldFailLoad = false
  shouldThrowOverlay = false
  readonly webContents: WebContents

  constructor(readonly id: number) {
    super()
    const wc = new EventEmitter() as unknown as WebContents & { id: number; session: Session; isDestroyed(): boolean }
    wc.id = id
    wc.session = {} as Session
    wc.isDestroyed = () => this.#destroyed
    this.webContents = wc
  }

  isDestroyed(): boolean {
    return this.#destroyed
  }

  isMinimized(): boolean {
    return this.#minimized
  }

  setMinimized(val: boolean): void {
    this.#minimized = val
  }

  isMaximized(): boolean {
    return false
  }

  isFullScreen(): boolean {
    return false
  }

  restore(): void {
    this.#minimized = false
  }

  show(): void {
    this.#shown = true
  }

  focus(): void {
    this.#focused = true
  }

  isShown(): boolean {
    return this.#shown
  }

  isFocused(): boolean {
    return this.#focused
  }

  getBounds() {
    return { ...this.#bounds }
  }

  getNormalBounds() {
    return { ...this.#bounds }
  }

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.#bounds = { ...bounds }
    this.emit('resize')
  }

  async loadURL(url: string): Promise<void> {
    if (this.shouldFailLoad) {
      throw new Error('Load failed')
    }
    this.loadedUrls.push(url)
  }

  setTitleBarOverlay(options: Electron.TitleBarOverlayOptions): void {
    if (this.shouldThrowOverlay) {
      throw new Error('OVERLAY_UPDATE_FAILED')
    }
    this.overlays.push(options)
  }

  setBackgroundColor(color: string): void {
    this.backgrounds.push(color)
  }

  removeMenu(): void {
    this.menuRemoved = true
  }

  hookWindowMessage(message: number, _callback: (wParam: Buffer, lParam: Buffer) => void): void {
    this.hookedMessages.push(message)
  }

  destroy(): void {
    if (this.#destroyed) return
    this.#destroyed = true
    this.emit('closed')
    this.webContents.emit('destroyed')
  }
}

const mainCaller: CallerIdentity = {
  type: 'main',
  webContentsId: 1
}

const pluginCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 2,
  pluginId: 'process-monitor',
  pluginInstanceId: 'inst-1'
}

test('extractPopoutKey normalizes plugin routes and query snapshots into a canonical single-instance key', () => {
  assert.equal(
    extractPopoutKey('index.html#/popout/software-manager?q=Microsoft&seg=all'),
    'plugin:software-manager'
  )
  assert.equal(
    extractPopoutKey('ztools://web/index.html#/declarative/Process-Monitor?q=chrome'),
    'plugin:process-monitor'
  )
  assert.equal(
    requireLocalUrl('index.html#/popout/software-manager?q=VSCode'),
    'ztools://web/index.html#/popout/software-manager?q=VSCode'
  )
})

test('WindowService.open enforces single-instance mutex, transfers URL snapshot on reuse, and registers main identity', async () => {
  const registry = new WindowRegistry()
  const createdWindows: FakePopoutWindow[] = []
  let nextId = 100

  const service = new WindowService(
    {} as FileSystemService,
    registry,
    registry,
    () => {
      const win = new FakePopoutWindow(nextId++)
      createdWindows.push(win)
      return win as unknown as BrowserWindow
    }
  )

  const first = await service.open(
    { url: 'index.html#/popout/software-manager?q=Chrome&seg=all' },
    mainCaller
  )
  assert.deepEqual(first, {
    success: true,
    windowInstanceStatus: 'created',
    popoutKey: 'plugin:software-manager'
  })
  assert.equal(createdWindows.length, 1)
  assert.equal(createdWindows[0]!.isShown(), true)
  assert.equal(createdWindows[0]!.isFocused(), true)
  assert.deepEqual(createdWindows[0]!.loadedUrls, [
    'ztools://web/index.html#/popout/software-manager?q=Chrome&seg=all'
  ])
  assert.deepEqual(registry.get(100), {
    type: 'main',
    webContentsId: 100
  })

  // Minimize and re-open the same plugin with a new search query -> must reuse and restore
  createdWindows[0]!.setMinimized(true)
  const second = await service.open(
    { url: 'index.html#/popout/software-manager?q=Firefox&seg=64' },
    mainCaller
  )
  assert.deepEqual(second, {
    success: true,
    windowInstanceStatus: 'reused',
    popoutKey: 'plugin:software-manager'
  })
  assert.equal(createdWindows.length, 1)
  assert.equal(createdWindows[0]!.isMinimized(), false)
  assert.equal(
    createdWindows[0]!.loadedUrls.at(-1),
    'ztools://web/index.html#/popout/software-manager?q=Firefox&seg=64'
  )
})

test('WindowService.open rejects non-main callers, external URLs, and cleans up on load failure or stop()', async () => {
  const createdWindows: FakePopoutWindow[] = []
  let nextId = 200
  let failNextLoad = false

  const service = new WindowService(
    {} as FileSystemService,
    undefined,
    undefined,
    () => {
      const win = new FakePopoutWindow(nextId++)
      win.shouldFailLoad = failNextLoad
      createdWindows.push(win)
      return win as unknown as BrowserWindow
    }
  )

  // 1. Reject plugin caller
  await assert.rejects(
    () => service.open({ url: 'index.html#/popout/process-monitor' }, pluginCaller),
    (err: { code?: string }) => err.code === errorCodes.permissionDenied
  )

  // 2. Reject external protocol URL
  await assert.rejects(
    () => service.open({ url: 'https://evil.example.com/phishing' }, mainCaller),
    (err: { code?: string }) => err.code === errorCodes.permissionDenied
  )

  // 3. Load failure destroys the half-created window and removes it from mutex map
  failNextLoad = true
  await assert.rejects(
    () => service.open({ url: 'index.html#/popout/process-monitor' }, mainCaller),
    /Load failed/u
  )
  assert.equal(createdWindows.length, 1)
  assert.equal(createdWindows[0]!.isDestroyed(), true)

  // 4. Subsequent open after failure succeeds cleanly
  failNextLoad = false
  const recovered = await service.open({ url: 'index.html#/popout/process-monitor' }, mainCaller)
  assert.equal(recovered.windowInstanceStatus, 'created')

  // 5. Enforce MAX_POPOUT_WINDOWS (8) cap
  for (let i = 1; i < 8; i++) {
    await service.open({ url: `index.html#/popout/plugin-${i}` }, mainCaller)
  }
  await assert.rejects(
    () => service.open({ url: 'index.html#/popout/plugin-overflow' }, mainCaller),
    (err: { code?: string }) => err.code === errorCodes.pluginBusy
  )

  // 6. Cascading destruction on stop()
  service.stop()
  for (const win of createdWindows) {
    assert.equal(win.isDestroyed(), true)
  }
})

test('WindowService.updateTheme synchronizes popout transparent titleBarOverlay across rapid switches, destroyed windows, and native errors', async () => {
  const registry = new WindowRegistry()
  const createdWindows: FakePopoutWindow[] = []
  const constructorOptionsList: Electron.BrowserWindowConstructorOptions[] = []
  let nextId = 300

  const service = new WindowService(
    {} as FileSystemService,
    registry,
    registry,
    (opts) => {
      constructorOptionsList.push(opts)
      const win = new FakePopoutWindow(nextId++)
      createdWindows.push(win)
      return win as unknown as BrowserWindow
    }
  )

  // 预设冰川蓝浅色主题后打开两个独立窗口
  service.updateTheme({ isDark: false, accent: 'glacier' }, 'win32')
  await service.open({ url: 'index.html#/popout/json-formatter' }, mainCaller)
  await service.open({ url: 'index.html#/popout/disk-analyzer' }, mainCaller)
  assert.equal(createdWindows.length, 2)
  assert.equal(constructorOptionsList[0]!.backgroundColor, '#f2f5f8')
  if (process.platform === 'win32') {
    assert.deepEqual(constructorOptionsList[0]!.titleBarOverlay, {
      color: TRANSPARENT_TITLE_BAR_OVERLAY_COLOR,
      symbolColor: '#475569',
      height: POPOUT_TITLE_BAR_HEIGHT
    })
  }

  // 故障注入：第一个窗口底层 overlay 抛错，第二个窗口正常；同时额外打开第三个窗口并中途销毁
  await service.open({ url: 'index.html#/popout/kill-process' }, mainCaller)
  createdWindows[0]!.shouldThrowOverlay = true
  createdWindows[2]!.destroy()

  // 连续高频切换 20 次亮暗模式与畸形主题输入，验证状态幂等且异常窗口不阻断正常窗口更新
  for (let i = 0; i < 20; i++) {
    service.updateTheme({ isDark: i % 2 === 0, accent: i === 19 ? '__invalid__' : 'glacier' }, 'win32')
  }

  // 第 20 次 (i=19): isDark = false, accent 畸形回退为 'ember'
  assert.equal(createdWindows[0]!.backgrounds.at(-1), '#f4f3f0')
  assert.deepEqual(createdWindows[1]!.overlays.at(-1), {
    color: '#00000000',
    symbolColor: '#55555c',
    height: POPOUT_TITLE_BAR_HEIGHT
  })
  assert.equal(createdWindows[1]!.backgrounds.at(-1), '#f4f3f0')
  assert.equal(createdWindows[2]!.overlays.length, 0)

  service.stop()
  for (const win of createdWindows) {
    assert.equal(win.isDestroyed(), true)
  }
})

test('关闭插件取消新建或复用中的加载，旧请求不删除新实例且不影响其他插件', async context => {
  for (const [reuse, failAfterClose] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    const created: FakePopoutWindow[] = []
    let blockLoad = false
    let entered!: () => void
    let release!: () => void
    const loading = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    const service = new WindowService({} as FileSystemService, undefined, undefined, () => {
      const window = new FakePopoutWindow(500 + created.length)
      window.loadURL = async url => {
        if (blockLoad) {
          entered()
          await barrier
          if (failAfterClose) throw new Error('ERR_ABORTED')
        }
        window.loadedUrls.push(url)
      }
      created.push(window)
      return window as unknown as BrowserWindow
    })
    context.after(() => { release(); service.stop() })
    await service.open({ url: 'index.html#/popout/todo' }, mainCaller)
    if (reuse) await service.open({ url: 'index.html#/popout/memo' }, mainCaller)
    blockLoad = true
    const opening = service.open({ url: 'index.html#/popout/memo' }, mainCaller)
    const rejected = assert.rejects(opening, { code: errorCodes.cancelled })
    await loading
    service.closePlugin('MEMO')
    assert.equal(created[1]!.isDestroyed(), true)
    assert.equal(created[0]!.isDestroyed(), false)
    blockLoad = false
    assert.equal((await service.open({ url: 'index.html#/popout/memo' }, mainCaller)).windowInstanceStatus, 'created')
    release()
    await rejected
    assert.equal((await service.open({ url: 'index.html#/popout/memo' }, mainCaller)).windowInstanceStatus, 'reused')
    assert.equal(created.length, 3, '旧请求清理后仍复用新实例')
    service.closePlugin('memo')
    service.closePlugin('memo')
    assert.equal(created[2]!.isDestroyed(), true)
    service.stop()
  }
})

test('Popout 窗口接入 Windows 系统菜单抑制且 toggleDevTools 在正式版拒绝打开开发者工具', async () => {
  const created: FakePopoutWindow[] = []
  const registry = new WindowRegistry()
  const service = new WindowService({} as FileSystemService, registry, registry, () => {
    const win = new FakePopoutWindow(801 + created.length)
    created.push(win)
    return win as unknown as BrowserWindow
  })
  try {
    await service.open({ url: 'index.html#/popout/json-formatter' }, mainCaller)
    const popout = created[0]!
    if (process.platform === 'win32') {
      assert.equal(popout.menuRemoved, true, 'win32 Popout 创建后必须移除原生菜单')
      assert.deepEqual(popout.hookedMessages, [WM_SYSCHAR], 'win32 Popout 必须挂载 WM_SYSCHAR 拦截')
      let sysMenuPrevented = false
      popout.emit('system-context-menu', { preventDefault: () => { sysMenuPrevented = true } })
      assert.equal(sysMenuPrevented, true, 'win32 Popout 必须拦截系统右键菜单')
    }

    assert.throws(
      () => service.toggleDevTools(mainCaller, true),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === errorCodes.permissionDenied
    )
    try {
      service.toggleDevTools(mainCaller, false)
    } catch (error) {
      assert.ok(
        !(error instanceof Error && 'code' in error && error.code === errorCodes.permissionDenied),
        '非正式版不应触发 permissionDenied 拦截'
      )
    }
  } finally {
    service.stop()
  }
})
