import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FrameSyncManager,
  type ManagedWindow,
  type ManagedWebContents
} from '../../src/main/services/frame-sync-manager.js'

class FakeWebContents implements ManagedWebContents {
  destroyed = false
  throttling = false
  frameRate = 60
  clearCacheCalled = false
  executedScripts: string[] = []
  rafDelayMs = 0

  isDestroyed(): boolean {
    return this.destroyed
  }

  setBackgroundThrottling(allowed: boolean): void {
    this.throttling = allowed
  }

  setFrameRate(fps: number): void {
    this.frameRate = fps
  }

  async executeJavaScript(code: string): Promise<unknown> {
    this.executedScripts.push(code)
    if (this.rafDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.rafDelayMs))
    }
    return true
  }

  session = {
    clearCache: async (): Promise<void> => {
      this.clearCacheCalled = true
    }
  }
}

class FakeManagedWindow implements ManagedWindow {
  visible = false
  minimized = false
  destroyed = false
  focused = false
  showCalledCount = 0
  hideCalledCount = 0
  readonly webContents = new FakeWebContents()
  readonly listeners = new Map<string, Array<() => void>>()

  isVisible(): boolean {
    return this.visible
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  show(): void {
    this.visible = true
    this.showCalledCount++
    this.#emit('show')
  }

  hide(): void {
    this.visible = false
    this.hideCalledCount++
    this.#emit('hide')
  }

  focus(): void {
    this.focused = true
    this.#emit('focus')
  }

  restore(): void {
    this.minimized = false
  }

  on(event: 'show' | 'hide' | 'close' | 'closed' | 'focus' | 'blur', listener: () => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  removeListener(event: string, listener: () => void): this {
    const list = this.listeners.get(event)
    if (list) {
      const idx = list.indexOf(listener)
      if (idx >= 0) list.splice(idx, 1)
    }
    return this
  }

  #emit(event: string): void {
    const list = this.listeners.get(event)
    if (list) {
      for (const listener of [...list]) {
        listener()
      }
    }
  }
}

test('FrameSyncManager: attaches to window and tracks visible state', () => {
  const window = new FakeManagedWindow()
  window.visible = true

  const manager = new FrameSyncManager()
  manager.attach(window)

  assert.equal(manager.state, 'visible')
  assert.equal(manager.isAttached, true)

  manager.dispose()
})

test('FrameSyncManager: window hidden throttles rendering without clearing the shared HTTP cache', async () => {
  const window = new FakeManagedWindow()
  window.visible = true

  let suspendCallbackCalled = false
  // 使用较短超时以加速测试（50ms 代替 15000ms）
  const manager = new FrameSyncManager({
    suspendTimeoutMs: 50,
    onSuspend: () => {
      suspendCallbackCalled = true
    }
  })
  manager.attach(window)
  assert.equal(manager.state, 'visible')

  // 隐藏窗口
  manager.hideWindow()
  assert.equal(manager.state, 'suspend_pending')
  assert.equal(window.visible, false)

  // 等待挂起超时触发
  await new Promise((resolve) => setTimeout(resolve, 80))

  assert.equal(manager.state, 'suspended')
  assert.equal(suspendCallbackCalled, true)
  assert.equal(window.webContents.throttling, true)
  assert.equal(window.webContents.frameRate, 1)
  assert.equal(window.webContents.clearCacheCalled, false)
  assert.equal(window.webContents.executedScripts.length, 0)

  manager.dispose()
})

test('FrameSyncManager: showWindow waits for rAF first frame confirmation before showing native window', async () => {
  const window = new FakeManagedWindow()
  window.visible = false

  let resumeCallbackCalled = false
  const manager = new FrameSyncManager({
    suspendTimeoutMs: 50,
    frameSyncTimeoutMs: 100,
    onResume: () => {
      resumeCallbackCalled = true
    }
  })
  manager.attach(window)

  // 模拟已进入挂起状态
  await manager.suspend()
  assert.equal(manager.state, 'suspended')
  assert.equal(window.visible, false)

  // 让 rAF 脚本有 20ms 的执行延迟，验证在此期间窗口尚未 show
  window.webContents.rafDelayMs = 20

  const showPromise = manager.showWindow()
  assert.equal(manager.state, 'resuming')
  assert.equal(window.webContents.throttling, false)
  assert.equal(window.webContents.frameRate, 60)
  // 此时尚未完成 rAF，窗口不能立即可见以防闪烁
  assert.equal(window.visible, false)

  await showPromise

  // rAF 确认后，窗口正式显示且状态为 visible
  assert.equal(manager.state, 'visible')
  assert.equal(window.visible, true)
  assert.equal(window.focused, true)
  assert.equal(resumeCallbackCalled, true)
  assert.equal(window.showCalledCount, 1)

  manager.dispose()
})

test('FrameSyncManager: concurrent showWindow calls share the same resuming promise', async () => {
  const window = new FakeManagedWindow()
  window.visible = false

  const manager = new FrameSyncManager({ frameSyncTimeoutMs: 100 })
  manager.attach(window)
  window.webContents.rafDelayMs = 30

  const p1 = manager.showWindow()
  const p2 = manager.showWindow()

  assert.equal(p1, p2)
  await Promise.all([p1, p2])

  assert.equal(window.showCalledCount, 1)
  assert.equal(manager.state, 'visible')

  manager.dispose()
})

test('FrameSyncManager: unhiding before 15s cancels suspend timer', async () => {
  const window = new FakeManagedWindow()
  window.visible = true

  let suspendCalled = false
  const manager = new FrameSyncManager({
    suspendTimeoutMs: 60,
    onSuspend: () => {
      suspendCalled = true
    }
  })
  manager.attach(window)

  manager.hideWindow()
  assert.equal(manager.state, 'suspend_pending')

  // 在 60ms 到达之前（20ms）重新呼出
  await new Promise((resolve) => setTimeout(resolve, 20))
  await manager.showWindow()

  assert.equal(manager.state, 'visible')

  // 等待超过 60ms，挂起不应触发
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(suspendCalled, false)
  assert.equal(manager.state, 'visible')

  manager.dispose()
})

test('FrameSyncManager: warm show does not wait for renderer work', async () => {
  const window = new FakeManagedWindow()
  window.visible = true
  const manager = new FrameSyncManager()
  manager.attach(window)
  try {
    manager.hideWindow()
    window.webContents.rafDelayMs = 500
    const showing = manager.showWindow()
    assert.equal(window.visible, true, '已绘制窗口必须同步显示，不能等待隐藏页 rAF')
    await showing
    assert.equal(window.webContents.executedScripts.length, 0)
  } finally {
    manager.dispose()
  }
})

test('FrameSyncManager: 即使可见性报告为 false，隐藏仍撤下原生窗口，随后可以再次唤醒', async () => {
  const window = new FakeManagedWindow()
  window.visible = true
  const manager = new FrameSyncManager({ platform: 'darwin' })
  manager.attach(window)
  try {
    window.isVisible = () => false
    manager.hideWindow()
    assert.equal(window.hideCalledCount, 1)
    assert.equal(window.visible, false)
    await manager.showWindow()
    assert.equal(window.visible, true)
    assert.equal(window.focused, true)
    assert.equal(manager.state, 'visible')
  } finally {
    manager.dispose()
  }
})

test('FrameSyncManager: 已映射但未聚焦的窗口再次唤醒时重新 show，而非仅请求 focus', async () => {
  const window = new FakeManagedWindow()
  window.visible = true
  const manager = new FrameSyncManager()
  manager.attach(window)
  try {
    await manager.showWindow()
    assert.equal(window.showCalledCount, 1)
    assert.equal(window.focused, true)
    assert.equal(window.webContents.executedScripts.length, 0)
  } finally {
    manager.dispose()
  }
})

test('FrameSyncManager: hide cancels a pending show without reopening', async () => {
  const window = new FakeManagedWindow()
  window.webContents.rafDelayMs = 30
  const manager = new FrameSyncManager()
  manager.attach(window)
  try {
    const showing = manager.showWindow()
    manager.hideWindow()
    await showing
    assert.equal(window.visible, false)
    assert.equal(window.showCalledCount, 0)
    assert.equal(manager.state, 'suspend_pending')
  } finally {
    manager.dispose()
  }
})

test('FrameSyncManager: detached or destroyed windows cannot be shown by stale callbacks', async () => {
  for (const action of ['detach', 'dispose'] as const) {
    const window = new FakeManagedWindow()
    window.webContents.rafDelayMs = 30
    const manager = new FrameSyncManager()
    manager.attach(window)
    const showing = manager.showWindow()
    manager[action]()
    await showing
    assert.equal(window.showCalledCount, 0, action)
    assert.equal(manager.isAttached, false)
    manager.dispose()
  }
})

test('FrameSyncManager: a new show supersedes a cancelled show', async () => {
  const window = new FakeManagedWindow()
  window.webContents.rafDelayMs = 30
  const manager = new FrameSyncManager()
  manager.attach(window)
  try {
    const stale = manager.showWindow()
    manager.hideWindow()
    const current = manager.showWindow()
    assert.notEqual(current, stale)
    await Promise.all([stale, current])
    assert.equal(window.showCalledCount, 1)
    assert.equal(manager.state, 'visible')
  } finally {
    manager.dispose()
  }
})

test('FrameSyncManager: first-frame timeout and renderer rejection still allow bounded display', async () => {
  for (const failure of ['timeout', 'rejection']) {
    const window = new FakeManagedWindow()
    const warnings: string[] = []
    window.webContents.executeJavaScript = () => failure === 'timeout'
      ? new Promise(() => undefined)
      : Promise.reject(new Error('renderer unavailable'))
    const manager = new FrameSyncManager({
      frameSyncTimeoutMs: 10,
      logger: (level, message) => { if (level === 'WARN') warnings.push(message) }
    })
    manager.attach(window)
    try {
      await manager.showWindow()
      assert.equal(window.visible, true, failure)
      if (failure === 'rejection') assert.equal(warnings.length, 1)
    } finally {
      manager.dispose()
    }
  }
})

test('FrameSyncManager: stale native visibility events cannot override the current window state', async () => {
  const window = new FakeManagedWindow()
  window.visible = true
  const manager = new FrameSyncManager()
  manager.attach(window)
  try {
    manager.hideWindow()
    await manager.showWindow()
    for (const listener of window.listeners.get('hide') ?? []) listener()
    assert.equal(manager.state, 'visible')
    manager.hideWindow()
    for (const listener of window.listeners.get('show') ?? []) listener()
    assert.equal(manager.state, 'suspend_pending')
  } finally {
    manager.dispose()
  }
})

test('FrameSyncManager: synchronous blur during warm show does not poison the next show', async () => {
  const window = new FakeManagedWindow()
  window.visible = true
  const manager = new FrameSyncManager()
  manager.attach(window)
  try {
    manager.hideWindow()
    const hideOnShow = () => manager.hideWindow()
    window.on('show', hideOnShow)
    await manager.showWindow()
    assert.equal(window.visible, false)
    window.removeListener('show', hideOnShow)
    await manager.showWindow()
    assert.equal(window.visible, true)
    assert.equal(window.showCalledCount, 2)
  } finally {
    manager.dispose()
  }
})

test('FrameSyncManager: macOS (darwin) hidden window skips occluded rAF wait and shows immediately', async () => {
  const win = new FakeManagedWindow()
  win.webContents.rafDelayMs = 500

  const fsm = new FrameSyncManager({
    platform: 'darwin',
    suspendTimeoutMs: 100,
    frameSyncTimeoutMs: 300
  })
  fsm.attach(win)

  const t0 = Date.now()
  await fsm.showWindow()
  const elapsed = Date.now() - t0

  assert.equal(win.isVisible(), true)
  assert.equal(win.focused, true)
  assert.equal(win.showCalledCount, 1)
  assert.equal(win.webContents.executedScripts.length, 0, 'macOS 隐藏窗口不应在 show() 前等待被 Occlusion 挂起的 rAF')
  assert.ok(elapsed < 80, `macOS 唤醒耗时应 < 80ms，实际 ${elapsed}ms`)

  fsm.dispose()
})
