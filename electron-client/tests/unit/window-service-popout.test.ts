import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { BrowserWindow, Session, WebContents } from 'electron'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes } from '../../src/contracts/errors.js'
import type { FileSystemService } from '../../src/main/services/file-system-service.js'
import { extractPopoutKey, requireLocalUrl, WindowService } from '../../src/main/services/window-service.js'
import { WindowRegistry } from '../../src/main/windows/window-registry.js'

class FakePopoutWindow extends EventEmitter {
  #destroyed = false
  #minimized = false
  #shown = false
  #focused = false
  #bounds = { x: 120, y: 80, width: 1140, height: 760 }
  loadedUrls: string[] = []
  shouldFailLoad = false
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
