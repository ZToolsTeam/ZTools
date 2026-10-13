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
