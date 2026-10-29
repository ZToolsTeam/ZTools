import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { PluginManifest } from '../../src/main/services/plugin-install-service.js'
import { PluginIconService } from '../../src/main/services/plugin-icon-service.js'
import { PluginShortcutService } from '../../src/main/services/plugin-shortcut-service.js'
import type { PluginStateProvider } from '../../src/main/services/plugin-state-service.js'

function manifest(): PluginManifest {
  return {
    id: 'plugin.test',
    name: 'Test: Plugin',
    version: '1.0.0',
    entry: 'index.html',
    dllloader: '',
    requireAdmin: false,
    commonLibs: [],
    description: 'A test plugin'
  }
}

test('creates a legacy-compatible shortcut and prefers plugin icon.ico', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-plugin-shortcut-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'icon.ico'), 'ico')
  const calls: Array<{ shortcutPath: string; options: Electron.ShortcutDetails }> = []
  const service = new PluginShortcutService(
    {
      withPluginDirectory: async (_pluginId, action) => action(manifest(), root)
    },
    path.join(root, 'Desktop'),
    'C:\\ZTools\\ZTools.exe',
    (shortcutPath, options) => {
      calls.push({ shortcutPath, options })
      return true
    },
    'win32'
  )

  const result = await service.create('plugin.test')
  assert.equal(result.success, true)
  assert.equal(calls[0]?.options.target, 'C:\\ZTools\\ZTools.exe')
  assert.equal(calls[0]?.options.args, '--plugin "plugin.test"')
  assert.equal(calls[0]?.options.icon, path.join(root, 'icon.ico'))
  assert.match(calls[0]?.shortcutPath ?? '', /Test Plugin\.lnk$/)
})

test('removes the plugin shortcut while refusing non-file replacements', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-plugin-shortcut-remove-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const desktop = path.join(root, 'Desktop')
  const shortcutPath = path.join(desktop, 'Test Plugin.lnk')
  await fs.mkdir(desktop, { recursive: true })
  await fs.writeFile(shortcutPath, 'shortcut')
  const service = new PluginShortcutService(
    {
      withPluginDirectory: async (_pluginId, action) => action(manifest(), root)
    },
    desktop,
    'C:\\ZTools\\ZTools.exe',
    () => true,
    'win32'
  )

  const result = await service.remove('plugin.test')
  assert.equal(result.removed, true)
  assert.equal(await fs.access(shortcutPath).then(() => true, () => false), false)
})

test('卸载清理：非 Windows 不读清单，直接返回空操作（macOS 卸载不能被快捷方式挡住）', async () => {
  let manifestReads = 0
  const service = new PluginShortcutService(
    {
      withPluginDirectory: async () => {
        manifestReads += 1
        throw new Error('不应读取清单')
      }
    },
    '/Users/test/Desktop',
    '/Applications/ZTools.app',
    () => true,
    'darwin'
  )

  const cleanup = await service.planUninstallCleanup('plugin.test')
  await cleanup()
  assert.equal(manifestReads, 0)
  await assert.rejects(service.remove('plugin.test'), { code: 'NOT_SUPPORTED' })
})

test('卸载清理：Windows 上清单读不到（损坏或内置插件）时返回空操作，不抛错', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-plugin-shortcut-broken-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const desktop = path.join(root, 'Desktop')
  await fs.mkdir(desktop, { recursive: true })
  const unrelated = path.join(desktop, 'Test Plugin.lnk')
  await fs.writeFile(unrelated, 'shortcut')
  const warnings: unknown[] = []
  const warn = context.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
  const service = new PluginShortcutService(
    {
      withPluginDirectory: async () => {
        throw Object.assign(new Error('plugin.json 不是有效 JSON'), { code: 'PLUGIN_PACKAGE_INVALID' })
      }
    },
    desktop,
    'C:\\ZTools\\ZTools.exe',
    () => true,
    'win32'
  )

  const cleanup = await service.planUninstallCleanup('plugin.test')
  await cleanup()
  warn.mock.restore()
  assert.equal(warnings.length, 1)
  // 读不到清单就无从知道快捷方式名，不能误删桌面上的同名文件
  assert.equal(await fs.access(unrelated).then(() => true, () => false), true)
})

test('卸载清理：卸载前记下快捷方式位置，执行时删除；不是普通文件时拒绝删除', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-plugin-shortcut-plan-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const desktop = path.join(root, 'Desktop')
  const shortcutPath = path.join(desktop, 'Test Plugin.lnk')
  await fs.mkdir(desktop, { recursive: true })
  await fs.writeFile(shortcutPath, 'shortcut')
  let pluginExists = true
  const service = new PluginShortcutService(
    {
      withPluginDirectory: async (_pluginId, action) => {
        if (!pluginExists) throw new Error('插件不存在')
        return action(manifest(), root)
      }
    },
    desktop,
    'C:\\ZTools\\ZTools.exe',
    () => true,
    'win32'
  )

  const cleanup = await service.planUninstallCleanup('plugin.test')
  // 模拟插件目录已被卸载：删除动作不再依赖清单
  pluginExists = false
  assert.equal(await fs.access(shortcutPath).then(() => true, () => false), true, '计划阶段不删除')
  await cleanup()
  assert.equal(await fs.access(shortcutPath).then(() => true, () => false), false)
  // 快捷方式已不存在时再次执行不报错
  await cleanup()

  pluginExists = true
  await fs.mkdir(shortcutPath)
  const refuse = await service.planUninstallCleanup('plugin.test')
  await assert.rejects(refuse(), { code: 'PERMISSION_DENIED' })
})

test('downloads supported icon formats into the plugin directory and records the URL', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-plugin-icon-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  let recorded = ''
  const state: PluginStateProvider = {
    async readAll() { return {} },
    async isEnabled() { return true },
    async toggleEnabled() { return true },
    async markUsed() {},
    async setIconUrl(_pluginId, iconUrl) { recorded = iconUrl },
    async update() {}
  }
  const service = new PluginIconService(
    {
      withPluginDirectory: async (_pluginId, action) => action(manifest(), root)
    },
    state,
    (async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' }
    })) as typeof fetch
  )

  const result = await service.refresh('plugin.test', 'https://cdn.example/icon.png')
  assert.equal(result.status, 'refreshing')
  assert.deepEqual([...await fs.readFile(path.join(root, 'icon.png'))], [1, 2, 3])
  assert.equal(await fs.readFile(path.join(root, 'icon.url'), 'utf8'), 'https://cdn.example/icon.png\n')
  assert.equal(recorded, 'https://cdn.example/icon.png')
})

test('图标下载在插件目录锁之外进行：下载期间不占锁，下载失败或超时不进入目录写入', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-plugin-icon-lock-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const state: PluginStateProvider = {
    async readAll() { return {} },
    async isEnabled() { return true },
    async toggleEnabled() { return true },
    async markUsed() {},
    async setIconUrl() {},
    async update() {}
  }
  let locked = 0
  let lockedDuringFetch = false
  let signalPassed = false
  const directory = { withPluginDirectory: async <T>(_pluginId: string, action: (m: PluginManifest, r: string) => Promise<T>) => { locked++; try { return await action(manifest(), root) } finally { locked-- } } }
  const ok = new PluginIconService(directory, state, (async (_url: URL, init?: RequestInit) => {
    lockedDuringFetch = locked > 0
    signalPassed = init?.signal instanceof AbortSignal
    return new Response(new Uint8Array([7]), { status: 200, headers: { 'content-type': 'image/png' } })
  }) as typeof fetch)
  await ok.refresh('plugin.test', 'https://cdn.example/icon.png')
  assert.equal(lockedDuringFetch, false)
  assert.equal(signalPassed, true)

  let entered = 0
  const counting = { withPluginDirectory: async <T>(_pluginId: string, action: (m: PluginManifest, r: string) => Promise<T>) => { entered++; return action(manifest(), root) } }
  const offline = new PluginIconService(counting, state, (async () => { throw new DOMException('timeout', 'TimeoutError') }) as typeof fetch)
  await assert.rejects(offline.refresh('plugin.test', 'https://cdn.example/icon.png'), /下载插件图标失败/)
  const notFound = new PluginIconService(counting, state, (async () => new Response('x', { status: 404 })) as typeof fetch)
  await assert.rejects(notFound.refresh('plugin.test', 'https://cdn.example/icon.png'), /下载插件图标失败/)
  assert.equal(entered, 0)
})
