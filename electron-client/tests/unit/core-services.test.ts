import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { ConfigService } from '../../src/main/services/config-service.js'
import { readWebVersion } from '../../src/main/services/core-services.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'

function runtimeRoot(name: string): string {
  return path.resolve('out-test', 'runtime-data', `${process.pid}-${Date.now()}-${name}`)
}

function createStore(root: string): JsonFileStore {
  return new JsonFileStore(root, ConfigService.allowedStoreFiles)
}

test('renderer version is read from the built web root with a stable fallback', async () => {
  const root = runtimeRoot('web-version')
  await fs.mkdir(root, { recursive: true })
  try {
    await fs.writeFile(path.join(root, 'version.json'), '{"version":"1.1.7.1"}', 'utf8')
    assert.equal(await readWebVersion(root), '1.1.7.1')
    await fs.writeFile(path.join(root, 'version.json'), '{"version":"invalid"}', 'utf8')
    assert.equal(await readWebVersion(root), '0')
    await fs.rm(path.join(root, 'version.json'))
    assert.equal(await readWebVersion(root), '0')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config service preserves Delphi grouped JSON and serializes concurrent writes', async () => {
  const root = runtimeRoot('config')
  const config = new ConfigService(createStore(root))
  await config.set('user_settings.json', 'super_panel', '{"enabled":true}', false)
  await Promise.all(
    Array.from({ length: 12 }, (_value, index) =>
      config.set('user_settings.json', `batch.item_${index}`, String(index), true)
    )
  )
  assert.deepEqual(JSON.parse(await config.get('user_settings.json', 'super_panel', '')), {
    enabled: true
  })
  assert.equal(await config.get('user_settings.json', 'batch.item_11', ''), '11')
  const persistedSource = await fs.readFile(path.join(root, 'user_settings.json'), 'utf8')
  assert.equal(persistedSource.startsWith('\uFEFF'), true)
  const persisted = JSON.parse(persistedSource.slice(1))
  assert.equal(persisted._sync.batch, true)
  assert.equal(Object.keys(persisted.batch).length, 12)
})

test('independent JsonFileStore instances serialize writes to the same legacy file', async () => {
  const root = runtimeRoot('shared-store-queue')
  const first = createStore(root)
  const second = createStore(root)
  try {
    await Promise.all(
      Array.from({ length: 16 }, (_value, index) => {
        const store = index % 2 === 0 ? first : second
        return store.update('user_settings.json', (document) => {
          const batch = typeof document.batch === 'object' && document.batch !== null && !Array.isArray(document.batch)
            ? document.batch as Record<string, unknown>
            : {}
          batch[`item_${index}`] = index
          document.batch = batch
        })
      })
    )
    const persisted = JSON.parse((await fs.readFile(path.join(root, 'user_settings.json'), 'utf8')).slice(1)) as Record<string, unknown>
    assert.equal(Object.keys(persisted.batch as Record<string, unknown>).length, 16)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config service allows page-local settings, maps ungrouped settings, and rejects private files', async () => {
  const config = new ConfigService(createStore(runtimeRoot('settings')))
  assert.equal(await config.setSetting('closeConfirm', false), 'false')
  assert.equal(await config.getSetting('closeConfirm'), 'false')

  await config.set('my_page_settings.json', 'my-page.pinned', '["plugin-1"]', false)
  await config.set('my_page_settings.json', 'my-page.recent-order', '["plugin-2","plugin-1"]', false)
  assert.deepEqual(
    JSON.parse(await config.get('my_page_settings.json', 'my-page.pinned', '[]')),
    ['plugin-1']
  )
  assert.deepEqual(
    JSON.parse(await config.get('my_page_settings.json', 'my-page.recent-order', '[]')),
    ['plugin-2', 'plugin-1']
  )

  // 宿主私有文件不对渲染层的 config_get 开放
  await assert.rejects(
    config.get('app_config.json', 'cef.windowWidth', ''),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
})

test('corrupt JSON is reported and never replaced with an empty document', async () => {
  const root = runtimeRoot('corrupt')
  await fs.mkdir(root, { recursive: true })
  const file = path.join(root, 'user_settings.json')
  await fs.writeFile(file, '{broken', 'utf8')
  const config = new ConfigService(createStore(root))
  await assert.rejects(
    config.get('user_settings.json', 'ui.theme', 'light'),
    (error) => error instanceof ZToolsError && error.code === errorCodes.dataCorrupt
  )
  assert.equal(await fs.readFile(file, 'utf8'), '{broken')
})

test('config service accepts UTF-8 BOM written by Delphi TEncoding.UTF8', async () => {
  const root = runtimeRoot('bom')
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, 'user_settings.json'),
    '\uFEFF{"ui":{"theme":"dark"}}',
    'utf8'
  )
  const config = new ConfigService(createStore(root))
  assert.equal(await config.get('user_settings.json', 'ui.theme', 'light'), 'dark')
})

test('main window size uses the private app config without exposing that file to renderers', async () => {
  const root = runtimeRoot('main-window-size')
  const store = createStore(root)
  const config = new ConfigService(store)
  try {
    assert.equal(await config.getMainWindowSize(), undefined)
    await store.replace('app_config.json', { legacy: { keep: true }, cef: { windowHeight: 720 } })
    await config.setMainWindowSize(1280, 720)
    assert.deepEqual(await config.getMainWindowSize(), { width: 1280, height: 720 })
    const persisted = JSON.parse((await fs.readFile(path.join(root, 'app_config.json'), 'utf8')).slice(1)) as Record<string, unknown>
    assert.deepEqual(persisted.legacy, { keep: true })
    await assert.rejects(
      config.get('app_config.json', 'cef.windowWidth', ''),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    assert.throws(
      () => config.setMainWindowSize(100, 100),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
