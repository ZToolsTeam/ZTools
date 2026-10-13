import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { AnalyticsService } from '../../src/main/services/analytics-service.js'
import { ConfigService } from '../../src/main/services/config-service.js'
import { readWebVersion } from '../../src/main/services/core-services.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'
import { UserAccountService } from '../../src/main/services/user-account-service.js'

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

  await assert.rejects(
    config.get('user_account.json', 'current_token', ''),
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

test('user account lifecycle keeps the legacy response shape without exposing files', async () => {
  const user = new UserAccountService(createStore(runtimeRoot('user')))
  assert.deepEqual(await user.getInfo(), { success: true, logged_in: false })
  await user.setToken({
    token: 'access-token',
    refresh_token: 'refresh-token',
    user_id: 'user-1',
    username: 'tester',
    email: 'tester@example.com',
    expires_at: '2026-08-25T00:00:00.000Z'
  })
  const info = await user.getInfo()
  assert.deepEqual(info, {
    success: true,
    logged_in: true,
    user: {
      user_id: 'user-1',
      username: 'tester',
      email: 'tester@example.com',
      last_login_at: (info.user as Record<string, unknown>).last_login_at
    },
    token: 'access-token',
    refresh_token: 'refresh-token'
  })
  assert.notEqual(String((info.user as Record<string, unknown>).last_login_at), '')
  await user.logout()
  assert.deepEqual(await user.getInfo(), { success: true, logged_in: false })
})

test('analytics uses registered plugin identity instead of renderer plugin_id', async () => {
  let resolveRequest: ((body: Record<string, unknown>) => void) | undefined
  const request = new Promise<Record<string, unknown>>((resolve) => {
    resolveRequest = resolve
  })
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    resolveRequest?.(JSON.parse(String(init?.body)))
    return new Response(null, { status: 204 })
  }) as typeof fetch
  const analytics = new AnalyticsService({
    appVersion: 'v1.1.7.1',
    fetchImpl,
    resolveMetadata: async () => ({ deviceCode: 'device-1', source: 'test' }),
    now: () => new Date('2026-08-24T01:02:03.000Z')
  })
  analytics.report(
    { event: 'plugin_open', plugin_id: 'spoofed', web_version: 'v1.2.3' },
    { type: 'plugin', webContentsId: 2, pluginId: 'trusted-plugin' }
  )
  const body = await request
  assert.equal(body.plugin_id, 'trusted-plugin')
  assert.equal(body.app_version, '1.1.7.1')
  assert.equal(body.web_version, '1.2.3')
  analytics.stop()
})

test('analytics keeps host version defaults and separates plugin records from update events', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = []
  let resolveRequests!: () => void
  const completed = new Promise<void>((resolve) => { resolveRequests = resolve })
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init })
    if (requests.length === 2) resolveRequests()
    return new Response(null, { status: 204 })
  }) as typeof fetch
  const analytics = new AnalyticsService({
    appVersion: '1.1.7.1',
    webVersion: 'v2.0.0',
    apiBase: 'https://api.example',
    fetchImpl,
    resolveMetadata: async () => ({ deviceCode: 'device-1', source: 'test' })
  })

  analytics.report(
    { event: 'plugin_update', plugin_id: 'plugin.test', web_version: '' },
    { type: 'main', webContentsId: 1 }
  )
  analytics.reportPluginRecord('active', 'plugin.test', 'access-token')
  await completed

  const eventRequest = requests.find((request) => request.url.endsWith('/api/analytics/report'))
  assert.ok(eventRequest)
  const eventBody = JSON.parse(String(eventRequest.init?.body)) as Record<string, unknown>
  assert.equal(eventBody.web_version, '2.0.0')
  assert.equal(eventBody.event, 'plugin_update')

  const recordRequest = requests.find((request) => request.url.endsWith('/api/plugins/plugin.test/active'))
  assert.ok(recordRequest)
  assert.equal(recordRequest.init?.headers && (recordRequest.init.headers as Record<string, string>).Authorization, 'Bearer access-token')
  assert.deepEqual(JSON.parse(String(recordRequest.init?.body)), {})
  analytics.stop()
})
