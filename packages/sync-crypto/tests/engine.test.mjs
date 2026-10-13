import assert from 'node:assert/strict'
import test from 'node:test'
import {
  E2eeSyncEngine,
  WebDavSyncAdapter,
  GistSyncAdapter,
  DecryptionError
} from '../dist/index.js'

test('E2eeSyncEngine: WebDAV end-to-end encrypted config and clipboard sync', async () => {
  const remoteStore = new Map()

  const mockWebDavFetch = async (url, init) => {
    const key = url.toString()
    if (init.method === 'PUT') {
      remoteStore.set(key, Buffer.from(init.body))
      return new Response('', {
        status: 201,
        headers: { ETag: '"e2ee-webdav-etag-001"' }
      })
    }
    if (init.method === 'GET') {
      const data = remoteStore.get(key)
      if (!data) return new Response('Not Found', { status: 404 })
      return new Response(data, {
        status: 200,
        headers: { ETag: '"e2ee-webdav-etag-001"' }
      })
    }
    return new Response('', { status: 404 })
  }

  const adapter = new WebDavSyncAdapter({
    endpoint: 'https://dav.jianguoyun.com/dav/',
    basePath: '/ztools/',
    fetchFn: mockWebDavFetch
  })

  const engine = new E2eeSyncEngine({
    masterPassword: 'GeekMasterPassword!2026',
    salt: 'UserDeviceSalt12345678',
    argon2Options: { memoryCost: 64, timeCost: 2 }
  })

  // 1. 同步配置
  const originalConfig = {
    schemaVersion: 1,
    updatedAt: '2026-10-12T09:00:00Z',
    deviceId: 'client-node-1',
    settings: {
      doubleCtrl: true,
      e2eeSyncEnabled: true,
      activePlugins: ['calculator', 'json-viewer']
    }
  }

  const pushConfigRes = await engine.pushConfigToWebDav(adapter, originalConfig)
  assert.equal(pushConfigRes.etag, '"e2ee-webdav-etag-001"')

  // 验证在远端存储中是密文
  const rawEncryptedConfig = remoteStore.get('https://dav.jianguoyun.com/dav/ztools/ztools_config.enc')
  assert.ok(rawEncryptedConfig)
  const parsedEnvelope = JSON.parse(rawEncryptedConfig.toString('utf8'))
  assert.equal(parsedEnvelope.algorithm, 'aes-256-gcm')
  assert.notEqual(rawEncryptedConfig.toString('utf8'), JSON.stringify(originalConfig))

  // 解密拉取
  const { config: restoredConfig } = await engine.pullConfigFromWebDav(adapter)
  assert.deepEqual(restoredConfig, originalConfig)

  // 2. 同步剪贴板
  const originalClipboard = {
    schemaVersion: 1,
    updatedAt: '2026-10-12T09:05:00Z',
    deviceId: 'client-node-1',
    items: [
      { id: '1', type: 'text', content: 'Top Secret API Key', timestamp: 12345678 }
    ]
  }

  await engine.pushClipboardToWebDav(adapter, originalClipboard)
  const { clipboard: restoredClipboard } = await engine.pullClipboardFromWebDav(adapter)
  assert.deepEqual(restoredClipboard, originalClipboard)

  // 3. 错误密码解密应失败
  const wrongEngine = new E2eeSyncEngine({
    masterPassword: 'WrongPassword!',
    salt: 'UserDeviceSalt12345678',
    argon2Options: { memoryCost: 64, timeCost: 2 }
  })

  await assert.rejects(
    async () => {
      await wrongEngine.pullConfigFromWebDav(adapter)
    },
    (err) => err instanceof DecryptionError
  )
})

test('E2eeSyncEngine: GitHub Gist end-to-end encrypted config and clipboard sync', async () => {
  let gistStorage = null

  const mockGistFetch = async (url, init) => {
    if (init.method === 'POST') {
      const body = JSON.parse(init.body)
      gistStorage = {
        id: 'gist-sync-e2ee-456',
        description: body.description,
        public: false,
        created_at: '2026-10-12T09:00:00Z',
        updated_at: '2026-10-12T09:00:00Z',
        files: body.files
      }
      return new Response(JSON.stringify(gistStorage), { status: 201 })
    }
    if (init.method === 'GET') {
      return new Response(JSON.stringify(gistStorage), { status: 200 })
    }
    return new Response('', { status: 404 })
  }

  const adapter = new GistSyncAdapter({
    token: 'ghp_SamplePersonalAccessToken123456789',
    fetchFn: mockGistFetch
  })

  const engine = new E2eeSyncEngine({
    masterPassword: 'MyGistMasterPassword!2026',
    salt: 'GistUniqueDeviceSalt98765432',
    argon2Options: { memoryCost: 64, timeCost: 2 }
  })

  const sampleConfig = {
    schemaVersion: 1,
    updatedAt: '2026-10-12T09:10:00Z',
    settings: { syncProvider: 'gist' }
  }

  // 推送到 Gist
  const { gistId } = await engine.pushConfigToGist(adapter, sampleConfig)
  assert.equal(gistId, 'gist-sync-e2ee-456')

  // 从 Gist 拉取并解密
  const { config: restoredConfig } = await engine.pullConfigFromGist(adapter, gistId)
  assert.deepEqual(restoredConfig, sampleConfig)
})
