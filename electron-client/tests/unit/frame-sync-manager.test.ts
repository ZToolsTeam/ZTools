import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FrameSyncManager,
  HotKeyProtector,
  type ManagedWindow,
  type ManagedWebContents,
  type GlobalShortcutApi,
  type HookIsolationPort,
  type HookIsolationEvent
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

class FakeGlobalShortcutApi implements GlobalShortcutApi {
  registered = new Map<string, () => void>()
  failAccelerators = new Set<string>()

  register(accelerator: string, callback: () => void): boolean {
    if (this.failAccelerators.has(accelerator)) return false
    this.registered.set(accelerator, callback)
    return true
  }

  unregister(accelerator: string): void {
    this.registered.delete(accelerator)
  }

  isRegistered(accelerator: string): boolean {
    return this.registered.has(accelerator)
  }
}

class FakeHookIsolationPort implements HookIsolationPort {
  isIsolated = true
  isAlive = true
  listener: ((event: HookIsolationEvent) => void) | null = null

  onLifecycleEvent(listener: (event: HookIsolationEvent) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = null
    }
  }

  emit(event: HookIsolationEvent): void {
    this.listener?.(event)
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

test('FrameSyncManager: window hidden triggers 15s suspend timer and releases GPU memory', async () => {
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
  assert.equal(window.webContents.clearCacheCalled, true)
  assert.ok(window.webContents.executedScripts.length > 0)

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

// =========================================================================
// HotKeyProtector 测试
// =========================================================================

test('HotKeyProtector: registers shortcut and detects duplicate accelerator conflict', () => {
  const shortcutApi = new FakeGlobalShortcutApi()
  const protector = new HotKeyProtector({ shortcutApi })

  const ok1 = protector.register('item1', 'CommandOrControl+Shift+K', () => {})
  assert.equal(ok1, true)
  assert.equal(shortcutApi.isRegistered('CommandOrControl+Shift+K'), true)

  // 相同快捷键被其他 ID 注册应冲突拒绝
  const ok2 = protector.register('item2', 'CommandOrControl+Shift+K', () => {})
  assert.equal(ok2, false)
  assert.equal(protector.diagnostics.conflictCount, 1)

  protector.dispose()
  assert.equal(shortcutApi.isRegistered('CommandOrControl+Shift+K'), false)
})

test('HotKeyProtector: watchdog detects silent unregistration and automatically self-heals', () => {
  const shortcutApi = new FakeGlobalShortcutApi()
  const protector = new HotKeyProtector({ shortcutApi })

  let triggerCount = 0
  protector.register('app_toggle', 'Alt+Space', () => {
    triggerCount++
  })
  assert.equal(shortcutApi.isRegistered('Alt+Space'), true)

  // 模拟 Windows 锁屏/第三方软件静默夺走快捷键
  shortcutApi.unregister('Alt+Space')
  assert.equal(shortcutApi.isRegistered('Alt+Space'), false)

  // 执行自愈巡检
  const result = protector.verifyAndRepair()
  assert.equal(result.verified, 1)
  assert.deepEqual(result.repaired, ['app_toggle'])
  assert.equal(result.failed.length, 0)

  // 快捷键已被自动重新注册
  assert.equal(shortcutApi.isRegistered('Alt+Space'), true)
  assert.equal(protector.diagnostics.repairedCount, 1)

  // 验证重新绑定的 handler 依然有效
  shortcutApi.registered.get('Alt+Space')?.()
  assert.equal(triggerCount, 1)

  protector.dispose()
})

test('HotKeyProtector: monitors isolated hook lifecycle events and triggers repair', () => {
  const shortcutApi = new FakeGlobalShortcutApi()
  const hookPort = new FakeHookIsolationPort()
  const protector = new HotKeyProtector({ shortcutApi, hookPort })

  protector.register('super_panel', 'Alt+D', () => {})

  // 模拟底层钩子独立进程/线程崩溃事件
  hookPort.emit({ type: 'crashed', detail: { code: 1 } })

  assert.equal(protector.diagnostics.hookIsolated, true)
  assert.equal(shortcutApi.isRegistered('Alt+D'), true)

  // 模拟钩子线程重启恢复事件
  hookPort.emit({ type: 'restarted' })
  assert.equal(shortcutApi.isRegistered('Alt+D'), true)

  protector.dispose()
})
