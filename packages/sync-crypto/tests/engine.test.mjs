import assert from 'node:assert/strict'
import test from 'node:test'
import {
  E2eeSyncEngine,
  SyncConflictError,
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

test('E2eeSyncEngine: core state machine (upsertRecord, deleteRecord, getRecord, listRecords)', () => {
  const engine = new E2eeSyncEngine({
    masterPassword: 'StateMachinePassword!2026',
    salt: 'StateMachineSalt123456',
    deviceId: 'device-alpha',
    argon2Options: { memoryCost: 64, timeCost: 2 }
  })

  // 新增与读取记录
  const rec1 = engine.upsertRecord('note-1', { title: 'Hello', body: 'World' }, { collection: 'notes', updatedAt: 1000 })
  assert.equal(rec1.id, 'note-1')
  assert.equal(rec1.deleted, false)
  assert.equal(rec1.updatedAt, 1000)

  engine.upsertRecord({ id: 'snippet-1', data: { trigger: ': hi' }, collection: 'snippets', updatedAt: 1100 })

  assert.equal(engine.listRecords().length, 2)
  assert.equal(engine.listRecords({ collection: 'notes' }).length, 1)
  assert.deepEqual(engine.getRecord('note-1')?.data, { title: 'Hello', body: 'World' })

  // 删除记录生成 Tombstone 墓碑
  const tomb = engine.deleteRecord('note-1', { updatedAt: 1200 })
  assert.equal(tomb.deleted, true)
  assert.equal(tomb.data, null)
  assert.equal(engine.getRecord('note-1'), undefined)
  assert.equal(engine.getRecord('note-1', { includeDeleted: true })?.deleted, true)
  assert.equal(engine.listRecords().length, 1)
  assert.equal(engine.listRecords({ includeDeleted: true }).length, 2)

  // 非法空 ID 异常断言
  assert.throws(() => engine.upsertRecord('', { a: 1 }), /同步记录 ID 必须为非空字符串/)
  assert.throws(() => engine.deleteRecord(''), /同步记录 ID 必须为非空字符串/)
})

test('E2eeSyncEngine: multi-device sync(), LWW timestamp tie-breaking, and Tombstone anti-resurrection', async () => {
  const remoteFiles = new Map()
  let etagCounter = 1

  const mockWebDavFetch = async (url, init) => {
    const key = url.toString()
    if (init.method === 'PUT') {
      const current = remoteFiles.get(key)
      const ifMatch = init.headers?.['If-Match']
      if (ifMatch && current && current.etag !== ifMatch) {
        return new Response('Precondition Failed', { status: 412 })
      }
      const nextEtag = `"etag-v${etagCounter++}"`
      remoteFiles.set(key, { body: Buffer.from(init.body), etag: nextEtag })
      return new Response('', { status: 201, headers: { ETag: nextEtag } })
    }
    if (init.method === 'GET') {
      const current = remoteFiles.get(key)
      if (!current) return new Response('Not Found', { status: 404 })
      return new Response(current.body, { status: 200, headers: { ETag: current.etag } })
    }
    return new Response('', { status: 404 })
  }

  const adapterA = new WebDavSyncAdapter({
    endpoint: 'https://dav.example.com/dav/',
    basePath: '/ztools/',
    fetchFn: mockWebDavFetch
  })
  const adapterB = new WebDavSyncAdapter({
    endpoint: 'https://dav.example.com/dav/',
    basePath: '/ztools/',
    fetchFn: mockWebDavFetch
  })

  const deviceA = new E2eeSyncEngine({
    masterPassword: 'SharedPassword!2026',
    salt: 'SharedSalt12345678',
    deviceId: 'device-A',
    adapter: adapterA,
    argon2Options: { memoryCost: 64, timeCost: 2 }
  })
  const deviceB = new E2eeSyncEngine({
    masterPassword: 'SharedPassword!2026',
    salt: 'SharedSalt12345678',
    deviceId: 'device-B',
    adapter: adapterB,
    argon2Options: { memoryCost: 64, timeCost: 2 }
  })

  // 1. 设备 A 写入两条记录并推送到远端
  deviceA.upsertRecord('rec-lww', { version: 'A-old' }, { updatedAt: 1000 })
  deviceA.upsertRecord('rec-to-delete', { secret: 'remove-me' }, { updatedAt: 1000 })
  deviceA.upsertRecord('rec-a-only', { owner: 'A' }, { updatedAt: 1000 })
  await deviceA.push()

  // 2. 设备 B 未执行 pull() 直接尝试 push() -> 必须拦截并抛出 SyncConflictError，防止新设备盲目覆盖远端
  deviceB.upsertRecord('rec-b-only', { owner: 'B' }, { updatedAt: 1500 })
  await assert.rejects(
    async () => {
      await deviceB.push()
    },
    (err) => {
      assert.ok(err instanceof SyncConflictError)
      assert.match(err.message, /pull\(\) 或 sync\(\)/)
      return true
    }
  )

  // 3. 设备 B 修改 rec-lww（时间戳 2000 > 1000），并删除 rec-to-delete（时间戳 2500），然后执行 sync()
  deviceB.upsertRecord('rec-lww', { version: 'B-newer' }, { updatedAt: 2000 })
  deviceB.deleteRecord('rec-to-delete', { updatedAt: 2500 })
  const syncResB = await deviceB.sync()
  assert.equal(syncResB.records.length, 3) // rec-a-only, rec-b-only, rec-lww (rec-to-delete 已墓碑化)

  // 4. 设备 A 本地有旧版 rec-to-delete (updatedAt: 1800 < 墓碑 2500)，测试 Tombstone 防复活
  deviceA.upsertRecord('rec-to-delete', { secret: 'resurrect-attempt' }, { updatedAt: 1800 })
  const syncResA = await deviceA.sync()

  // 验证 Tombstone 阻止了旧版本复活，且 LWW 保留了 B-newer
  assert.equal(deviceA.getRecord('rec-to-delete'), undefined, 'Tombstone 必须阻止旧时间戳记录复活')
  assert.equal(deviceA.getRecord('rec-to-delete', { includeDeleted: true })?.deleted, true)
  assert.deepEqual(deviceA.getRecord('rec-lww')?.data, { version: 'B-newer' })
  assert.deepEqual(deviceA.getRecord('rec-b-only')?.data, { owner: 'B' })
  assert.equal(syncResA.records.length, 3)
})

test('E2eeSyncEngine & GistSyncAdapter: automatically fetches raw_url when truncated is true (>1MB payload)', async () => {
  let rawUrlFetched = false
  let storedFullContent = ''

  const mockGistFetch = async (url, init) => {
    const urlStr = url.toString()
    if (urlStr === 'https://gist.githubusercontent.com/raw/full-encrypted-blob') {
      rawUrlFetched = true
      return new Response(storedFullContent, { status: 200 })
    }
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body)
      const fileEntry = Object.values(body.files)[0]
      storedFullContent = fileEntry.content
      return new Response(
        JSON.stringify({
          id: 'gist-large-1mb',
          updated_at: '2026-10-12T12:00:00Z',
          created_at: '2026-10-12T12:00:00Z',
          public: false,
          files: {
            'ztools_sync_state.enc.json': {
              filename: 'ztools_sync_state.enc.json',
              content: storedFullContent.slice(0, 20), // 模拟截断残缺内容
              truncated: true,
              size: storedFullContent.length,
              raw_url: 'https://gist.githubusercontent.com/raw/full-encrypted-blob'
            }
          }
        }),
        { status: 201 }
      )
    }
    if (init?.method === 'GET') {
      return new Response(
        JSON.stringify({
          id: 'gist-large-1mb',
          updated_at: '2026-10-12T12:00:00Z',
          created_at: '2026-10-12T12:00:00Z',
          public: false,
          files: {
            'ztools_sync_state.enc.json': {
              filename: 'ztools_sync_state.enc.json',
              content: storedFullContent.slice(0, 20), // 截断内容无法直接 JSON.parse / 解密
              truncated: true,
              size: storedFullContent.length,
              raw_url: 'https://gist.githubusercontent.com/raw/full-encrypted-blob'
            }
          }
        }),
        { status: 200 }
      )
    }
    return new Response('', { status: 404 })
  }

  const gistAdapter = new GistSyncAdapter({
    token: 'ghp_ValidGistTokenForTruncatedTest',
    fetchFn: mockGistFetch
  })

  const senderEngine = new E2eeSyncEngine({
    masterPassword: 'LargeGistPassword!2026',
    salt: 'LargeGistSalt12345678',
    adapter: gistAdapter,
    fetchFn: mockGistFetch,
    argon2Options: { memoryCost: 64, timeCost: 2 }
  })

  senderEngine.upsertRecord('large-item', { text: 'X'.repeat(4096) }, { updatedAt: 5000 })
  const { gistId } = await senderEngine.push()
  assert.equal(gistId, 'gist-large-1mb')

  // 另一台设备拉取时，遇到 truncated: true 自动回源 raw_url 拉取完整密文并成功解密
  const receiverEngine = new E2eeSyncEngine({
    masterPassword: 'LargeGistPassword!2026',
    salt: 'LargeGistSalt12345678',
    adapter: gistAdapter,
    gistId: 'gist-large-1mb',
    fetchFn: mockGistFetch,
    argon2Options: { memoryCost: 64, timeCost: 2 }
  })

  rawUrlFetched = false
  const pullRes = await receiverEngine.pull()
  assert.equal(rawUrlFetched, true, '遇到 truncated: true 时必须自动请求 raw_url 获取完整密文')
  assert.equal(pullRes.records.length, 1)
  assert.equal(pullRes.records[0].data.text.length, 4096)
})
