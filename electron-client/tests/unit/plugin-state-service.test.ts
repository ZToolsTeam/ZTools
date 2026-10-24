import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { PluginStateService } from '../../src/main/services/plugin-state-service.js'

test('preserves plugin state fields while changing enabled, usage and icon data', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-plugin-state-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'plugin_state.json'), JSON.stringify({
    'Plugin.Test': {
      enabled: false,
      use_count: 4,
      custom_field: { keep: true }
    }
  }))

  const service = new PluginStateService(root)
  assert.equal(await service.isEnabled('plugin.test', true), false)
  assert.equal(await service.toggleEnabled('plugin.test', true), true)
  await service.markUsed('plugin.test')
  await service.setIconUrl('plugin.test', 'https://cdn.example/icon.png')

  const document = JSON.parse(
    (await fs.readFile(path.join(root, 'plugin_state.json'), 'utf8')).replace(/^\uFEFF/, '')
  ) as Record<string, any>
  assert.equal(document['Plugin.Test'].enabled, true)
  assert.equal(document['Plugin.Test'].use_count, 5)
  assert.equal(document['Plugin.Test'].custom_field.keep, true)
  assert.equal(document['Plugin.Test'].icon_url, 'https://cdn.example/icon.png')
})

test('removes plugin state case-insensitively without touching other plugins', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-plugin-state-remove-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'plugin_state.json'), JSON.stringify({
    'Plugin.Test': { enabled: false },
    other: { enabled: true }
  }))

  await new PluginStateService(root).remove('plugin.test')
  const document = JSON.parse(
    (await fs.readFile(path.join(root, 'plugin_state.json'), 'utf8')).replace(/^\uFEFF/, '')
  ) as Record<string, unknown>
  assert.deepEqual(document, { other: { enabled: true } })
})
