import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { BrowserWindow } from 'electron'
import type { PluginManifest } from '../../src/main/services/plugin-install-service.js'
import { PluginViewManager } from '../../src/main/services/plugin-view-manager.js'
import { PluginWindowManager, type PluginManifestProvider } from '../../src/main/windows/plugin-window-manager.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'

let nextWebContentsId = 300

class FakeWebContents extends EventEmitter {
  readonly id = nextWebContentsId++
  audioMuted = false
  backgroundThrottling = false

  setAudioMuted(muted: boolean): void {
    this.audioMuted = muted
  }

  setBackgroundThrottling(throttling: boolean): void {
    this.backgroundThrottling = throttling
  }

  setWindowOpenHandler(): void {}
  async executeJavaScript(): Promise<unknown> {
    return undefined
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeWebContents()
  destroyed = false
  minimized = false
  bounds = { x: 100, y: 100, width: 800, height: 600 }

  async loadURL(): Promise<void> {}

  isDestroyed(): boolean {
    return this.destroyed
  }

  isMinimized(): boolean {
    return this.minimized
  }

  restore(): void {
    this.minimized = false
    this.emit('restore')
  }

  show(): void {
    this.emit('show')
  }

  hide(): void {
    this.emit('hide')
  }

  isMaximized(): boolean {
    return false
  }

  getNormalBounds(): Electron.Rectangle {
    return { ...this.bounds }
  }

  focus(): void {}

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('closed')
  }
}

function sampleManifest(id = 'view.plugin'): PluginManifest {
  return {
    id,
    name: 'View Plugin Test',
    version: '1.0.0',
    entry: 'index.html',
    dllloader: '',
    requireAdmin: false,
    commonLibs: [],
    enabled: true,
    window: {
      width: 800,
      height: 600,
      singleInstance: true
    }
  }
}

function createTestEnvironment(manifest: PluginManifest) {
  const windows: FakeWindow[] = []
  const provider: PluginManifestProvider = {
    async withPluginManifest<T>(_id: string, action: (item: PluginManifest) => Promise<T>): Promise<T> {
      return action(manifest)
    }
  }
  const registry = {
    registerPlugin: () => undefined
  } as unknown as WindowRegistry

  const rawManager = new PluginWindowManager({
    registry,
    manifests: provider,
    suspendTimeoutMs: 15,
    createWindow: () => {
      const win = new FakeWindow()
      windows.push(win)
      return win as unknown as BrowserWindow
    }
  })

  const viewManager = new PluginViewManager(rawManager)
  return { viewManager, rawManager, windows }
}

test('PluginViewManager wraps PluginWindowManager and exposes raw manager', () => {
  const env = createTestEnvironment(sampleManifest())
  assert.equal(env.viewManager.rawWindowManager, env.rawManager)
})

test('PluginViewManager handles full open, hide, suspend and resume lifecycle', async () => {
  const env = createTestEnvironment(sampleManifest('suspend.test'))
  const openResult = await env.viewManager.open({ pluginId: 'suspend.test' })
  assert.equal(openResult.success, true)
  assert.equal(env.viewManager.getState('suspend.test'), 'ready')

  const win = env.windows[0]
  assert.ok(win)
  assert.equal(win.webContents.audioMuted, false)

  // 隐藏并等待休眠
  win.hide()
  await new Promise((resolve) => setTimeout(resolve, 35))
  assert.equal(env.viewManager.getState('suspend.test'), 'suspended')
  assert.equal(win.webContents.audioMuted, true)
  assert.equal(win.webContents.backgroundThrottling, true)

  // 唤醒 Resume
  const resumed = env.viewManager.resume('suspend.test')
  assert.equal(resumed, true)
  assert.equal(env.viewManager.getState('suspend.test'), 'ready')
  assert.equal(win.webContents.audioMuted, false)

  await env.viewManager.stop()
})

test('PluginViewManager manages crash isolation and reload recovery', async () => {
  const env = createTestEnvironment(sampleManifest('crash.test'))
  await env.viewManager.open({ pluginId: 'crash.test' })
  assert.equal(env.viewManager.getState('crash.test'), 'ready')

  const win1 = env.windows[0]
  assert.ok(win1)

  // 模拟渲染进程由于内存耗尽崩毁
  win1.webContents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 })

  // 验证崩溃隔离
  assert.equal(env.viewManager.getState('crash.test'), 'crashed')
  const details = env.viewManager.getCrashDetails('crash.test')
  assert.ok(details)
  assert.equal(details.reason, 'oom')
  assert.equal(details.exitCode, 137)

  // 执行一键重载恢复
  const reloadResult = await env.viewManager.reload('crash.test')
  assert.equal(reloadResult.success, true)
  assert.equal(reloadResult.recovered, true)
  assert.equal(env.viewManager.getState('crash.test'), 'ready')
  assert.equal(env.windows.length, 2)
  assert.equal(win1.destroyed, true)

  // 优雅关闭
  await env.viewManager.close('crash.test')
  assert.equal(env.windows[1]?.destroyed, true)
  await env.viewManager.stop()
})
