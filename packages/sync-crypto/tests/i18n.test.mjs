import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveSyncLocale,
  stripSyncLocaleSuffix,
  matchSyncSupportedLocale,
  formatSyncTemplate,
  tSync,
  SYNC_MESSAGES,
  argon2id,
  encryptAesGcm,
  decryptAesGcm,
  DecryptionError,
  decryptConfigPayload,
  decryptClipboardPayload,
  WebDavSyncAdapter,
  WebDavError,
  GistSyncAdapter,
  GistError,
  GistConflictError,
  E2eeSyncEngine,
  SyncConflictError
} from '../dist/index.js'

/**
 * 在回调期间临时覆盖 globalThis.__ztoolsLocale，并在结束后可靠恢复
 */
async function withGlobalLocale(locale, fn) {
  const prevExists = Object.prototype.hasOwnProperty.call(globalThis, '__ztoolsLocale')
  const prevValue = globalThis.__ztoolsLocale
  if (locale === undefined) {
    delete globalThis.__ztoolsLocale
  } else {
    globalThis.__ztoolsLocale = locale
  }
  try {
    return await fn()
  } finally {
    if (prevExists) {
      globalThis.__ztoolsLocale = prevValue
    } else {
      delete globalThis.__ztoolsLocale
    }
  }
}

test('resolveSyncLocale: priority (explicit > globalThis.__ztoolsLocale > en-US) and Chinese variant normalization', async () => {
  await withGlobalLocale(undefined, () => {
    assert.equal(resolveSyncLocale(), 'en-US')
    assert.equal(resolveSyncLocale(''), 'en-US')
    assert.equal(resolveSyncLocale('fr-FR'), 'en-US')
    assert.equal(resolveSyncLocale('zh'), 'zh-CN')
    assert.equal(resolveSyncLocale('zh-CN'), 'zh-CN')
    assert.equal(resolveSyncLocale('zh_TW'), 'zh-CN')
    assert.equal(resolveSyncLocale('ZH-HK'), 'zh-CN')
    assert.equal(resolveSyncLocale('zh-Hans'), 'zh-CN')
  })

  await withGlobalLocale('zh-TW', () => {
    assert.equal(resolveSyncLocale(), 'zh-CN')
    assert.equal(resolveSyncLocale('en-US'), 'en-US')
    assert.equal(resolveSyncLocale('en'), 'en-US')
  })

  await withGlobalLocale('en-GB', () => {
    assert.equal(resolveSyncLocale(), 'en-US')
    assert.equal(resolveSyncLocale('zh-CN'), 'zh-CN')
  })
})

test('tSync: formats placeholders including numeric 0 and keeps en-US/zh-CN dictionary keys aligned', async () => {
  const enKeys = Object.keys(SYNC_MESSAGES['en-US']).sort()
  const zhKeys = Object.keys(SYNC_MESSAGES['zh-CN']).sort()
  assert.deepEqual(enKeys, zhKeys)

  assert.equal(
    tSync('webdav.connectionSuccess', { count: 0 }, 'en-US'),
    'Connection succeeded (0 resources detected)'
  )
  assert.equal(
    tSync('webdav.connectionSuccess', { count: 0 }, 'zh-CN'),
    '连接成功 (检测到 0 个资源)'
  )
  assert.equal(
    tSync('aesGcm.invalidKeyLength', { length: 0 }, 'en-US'),
    'AES-256-GCM key must be 32 bytes, received 0 bytes'
  )
})

test('Crypto & payload errors switch cleanly between en-US and zh-CN', async () => {
  const validKey = Buffer.alloc(32, 7)
  const shortKey = Buffer.alloc(16, 1)
  const invalidConfigPayload = encryptAesGcm(JSON.stringify({ wrong: true }), validKey)
  const invalidClipboardPayload = encryptAesGcm(JSON.stringify({ items: 'not-array' }), validKey)
  const validPayload = encryptAesGcm('hello', validKey)

  await withGlobalLocale('en-US', () => {
    assert.throws(() => argon2id('pwd', '1234'), /Argon2id salt must be at least 8 bytes/)
    assert.throws(() => encryptAesGcm('hi', shortKey), /AES-256-GCM key must be 32 bytes, received 16 bytes/)
    assert.throws(() => decryptAesGcm(validPayload, shortKey), (err) => {
      assert.ok(err instanceof DecryptionError)
      assert.match(err.message, /received 16 bytes/)
      return true
    })
    assert.throws(
      () => decryptAesGcm({ ...validPayload, version: 2 }, validKey),
      /Unsupported encryption algorithm or payload version/
    )
    assert.throws(
      () => decryptAesGcm({ ...validPayload, iv: Buffer.alloc(4).toString('base64') }, validKey),
      /Invalid IV length: 4 bytes/
    )
    assert.throws(
      () => decryptAesGcm({ ...validPayload, tag: Buffer.alloc(8).toString('base64') }, validKey),
      /Invalid authentication tag length: 8 bytes/
    )
    assert.throws(
      () => decryptAesGcm(validPayload, Buffer.alloc(32, 9)),
      /AES-256-GCM authenticated decryption failed/
    )
    assert.throws(
      () => decryptConfigPayload(invalidConfigPayload, validKey),
      /Decrypted configuration payload format is invalid/
    )
    assert.throws(
      () => decryptClipboardPayload(invalidClipboardPayload, validKey),
      /Decrypted clipboard payload format is invalid/
    )
  })

  await withGlobalLocale('zh-CN', () => {
    assert.throws(() => argon2id('pwd', '1234'), /Argon2id 盐值长度至少需要 8 字节/)
    assert.throws(() => encryptAesGcm('hi', shortKey), /AES-256-GCM 密钥长度必须为 32 字节，当前为 16 字节/)
    assert.throws(
      () => decryptAesGcm({ ...validPayload, version: 2 }, validKey),
      /不支持的加密算法或封包版本/
    )
    assert.throws(
      () => decryptAesGcm({ ...validPayload, iv: Buffer.alloc(4).toString('base64') }, validKey),
      /无效的 IV 长度: 4 字节/
    )
    assert.throws(
      () => decryptAesGcm({ ...validPayload, tag: Buffer.alloc(8).toString('base64') }, validKey),
      /无效的认证标签 Tag 长度: 8 字节/
    )
    assert.throws(
      () => decryptAesGcm(validPayload, Buffer.alloc(32, 9)),
      /AES-256-GCM 认证解密失败/
    )
    assert.throws(
      () => decryptConfigPayload(invalidConfigPayload, validKey),
      /解密后的配置数据格式无效/
    )
    assert.throws(
      () => decryptClipboardPayload(invalidClipboardPayload, validKey),
      /解密后的剪贴板数据格式无效/
    )
  })
})

test('WebDavSyncAdapter: errors and testConnection message support en-US and zh-CN', async () => {
  const okPropfindFetch = async () =>
    new Response(
      `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/</D:href><D:status>HTTP/1.1 200 OK</D:status></D:response></D:multistatus>`,
      { status: 207 }
    )
  const failFetch = async (_url, init) => {
    if (init.method === 'PUT' && init.headers['If-Match']) {
      return new Response('Precondition Failed', { status: 412, statusText: 'Precondition Failed' })
    }
    return new Response('Forbidden', { status: 403, statusText: 'Forbidden' })
  }

  const okAdapter = new WebDavSyncAdapter({ endpoint: 'https://dav.example.com/', fetchFn: okPropfindFetch })
  const failAdapter = new WebDavSyncAdapter({ endpoint: 'https://dav.example.com/', fetchFn: failFetch })

  await withGlobalLocale('en-US', async () => {
    const conn = await okAdapter.testConnection()
    assert.equal(conn.ok, true)
    assert.equal(conn.message, 'Connection succeeded (1 resources detected)')

    await assert.rejects(() => failAdapter.propfind('a'), (err) => err instanceof WebDavError && /PROPFIND failed \[403 Forbidden\]: a/.test(err.message))
    await assert.rejects(() => failAdapter.mkcol('dir'), /MKCOL failed to create directory \[403 Forbidden\]: dir/)
    await assert.rejects(() => failAdapter.get('f.enc'), /GET failed to download file \[403 Forbidden\]: f\.enc/)
    await assert.rejects(() => failAdapter.put('f.enc', 'x', { ifMatch: '"1"' }), /PUT conflict \(412 Precondition Failed\)/)
    await assert.rejects(() => failAdapter.put('f.enc', 'x'), /PUT failed to upload file \[403 Forbidden\]: f\.enc/)
    await assert.rejects(() => failAdapter.delete('f.enc'), /DELETE failed \[403 Forbidden\]: f\.enc/)
  })

  await withGlobalLocale('zh-CN', async () => {
    const conn = await okAdapter.testConnection()
    assert.equal(conn.ok, true)
    assert.equal(conn.message, '连接成功 (检测到 1 个资源)')

    await assert.rejects(() => failAdapter.propfind('a'), /PROPFIND 失败 \[403 Forbidden\]: a/)
    await assert.rejects(() => failAdapter.mkcol('dir'), /MKCOL 创建目录失败 \[403 Forbidden\]: dir/)
    await assert.rejects(() => failAdapter.get('f.enc'), /GET 下载文件失败 \[403 Forbidden\]: f\.enc/)
    await assert.rejects(() => failAdapter.put('f.enc', 'x', { ifMatch: '"1"' }), /PUT 发生并发冲突/)
    await assert.rejects(() => failAdapter.put('f.enc', 'x'), /PUT 上传文件失败 \[403 Forbidden\]: f\.enc/)
    await assert.rejects(() => failAdapter.delete('f.enc'), /DELETE 删除失败 \[403 Forbidden\]: f\.enc/)
  })
})

test('GistSyncAdapter and E2eeSyncEngine: bilingual error messages and locale-independent 404 sync recovery', async () => {
  const errFetch = async (url, init) => {
    if (url.toString().includes('raw.example')) {
      return new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' })
    }
    if (init.method === 'GET' && url.toString().includes('truncated-gist')) {
      return new Response(
        JSON.stringify({
          id: 'truncated-gist',
          updated_at: '2026-10-12T10:00:00Z',
          created_at: '2026-10-12T09:00:00Z',
          public: false,
          files: {
            'a.json': {
              filename: 'a.json',
              content: '',
              truncated: true,
              raw_url: 'https://raw.example/file'
            }
          }
        }),
        { status: 200 }
      )
    }
    if (init.method === 'GET' && url.toString().includes('conflict-gist')) {
      return new Response(
        JSON.stringify({
          id: 'conflict-gist',
          updated_at: '2026-10-12T11:00:00Z',
          created_at: '2026-10-12T09:00:00Z',
          public: false,
          files: {}
        }),
        { status: 200 }
      )
    }
    return new Response('Server Error', { status: 500, statusText: 'Internal Server Error' })
  }

  const gistAdapter = new GistSyncAdapter({ token: 'ghp_test', fetchFn: errFetch })
  const engine = new E2eeSyncEngine({
    masterPassword: 'TestPassword!123',
    salt: 'Salt1234567890',
    argon2Options: { memoryCost: 64, timeCost: 2 }
  })

  await withGlobalLocale('en-US', async () => {
    assert.throws(() => new GistSyncAdapter({ token: '' }), /GitHub Gist adapter requires a valid Personal Access Token/)
    await assert.rejects(() => gistAdapter.getGist(), (err) => err instanceof GistError && /Target Gist ID is not specified/.test(err.message))
    await assert.rejects(() => gistAdapter.getGist('g1'), /Failed to fetch Gist \[500 Internal Server Error\]/)
    await assert.rejects(() => gistAdapter.createGist({ 'a.txt': { content: 'x' } }), /Failed to create private Gist \[500 Internal Server Error\]/)
    await assert.rejects(
      () => gistAdapter.updateGist('conflict-gist', {}, { expectedUpdatedAt: '2026-10-12T10:00:00Z' }),
      (err) => err instanceof GistConflictError && /Gist sync conflict detected/.test(err.message)
    )
    await assert.rejects(() => gistAdapter.updateGist('g1', {}), /Failed to update Gist \[500 Internal Server Error\]/)
    await assert.rejects(() => gistAdapter.getGist('truncated-gist'), /Failed to fetch truncated raw Gist file \[502 Bad Gateway\]/)
    await assert.rejects(() => engine.push(), /Sync adapter is not configured/)
    await assert.rejects(() => engine.pull(), /Sync adapter is not configured/)
    await assert.rejects(() => engine.sync(), /Sync adapter is not configured/)
    assert.throws(() => engine.upsertRecord('', { a: 1 }), /Sync record ID must be a non-empty string/)
    assert.throws(() => engine.deleteRecord(''), /Sync record ID must be a non-empty string/)
  })

  await withGlobalLocale('zh-CN', async () => {
    assert.throws(() => new GistSyncAdapter({ token: '' }), /GitHub Gist 适配器需要有效的 Personal Access Token/)
    await assert.rejects(() => gistAdapter.getGist(), /未指定目标 Gist ID/)
    await assert.rejects(() => gistAdapter.getGist('g1'), /获取 Gist 失败 \[500 Internal Server Error\]/)
    await assert.rejects(() => gistAdapter.createGist({ 'a.txt': { content: 'x' } }), /创建私有 Gist 失败 \[500 Internal Server Error\]/)
    await assert.rejects(
      () => gistAdapter.updateGist('conflict-gist', {}, { expectedUpdatedAt: '2026-10-12T10:00:00Z' }),
      /检测到 Gist 同步冲突/
    )
    await assert.rejects(() => gistAdapter.updateGist('g1', {}), /更新 Gist 失败 \[500 Internal Server Error\]/)
    await assert.rejects(() => gistAdapter.getGist('truncated-gist'), /拉取截断 Gist 原始文件失败 \[502 Bad Gateway\]/)
    await assert.rejects(() => engine.push(), /未配置同步适配器/)
    await assert.rejects(() => engine.pull(), /未配置同步适配器/)
    await assert.rejects(() => engine.sync(), /未配置同步适配器/)
    assert.throws(() => engine.upsertRecord('', { a: 1 }), /同步记录 ID 必须为非空字符串/)
    assert.throws(() => engine.deleteRecord(''), /同步记录 ID 必须为非空字符串/)
  })

  // 验证英文模式下，远端 Gist 存在但尚未包含目标同步文件时，engine.sync() 仍能正确识别为 404 并自动推送初始化
  await withGlobalLocale('en-US', async () => {
    let patched = false
    const emptyGistFetch = async (_url, init) => {
      if (init.method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'empty-gist',
            updated_at: '2026-10-12T10:00:00Z',
            created_at: '2026-10-12T09:00:00Z',
            public: false,
            files: {}
          }),
          { status: 200 }
        )
      }
      if (init.method === 'PATCH') {
        patched = true
        return new Response(
          JSON.stringify({
            id: 'empty-gist',
            updated_at: '2026-10-12T10:05:00Z',
            created_at: '2026-10-12T09:00:00Z',
            public: false,
            files: JSON.parse(init.body).files
          }),
          { status: 200 }
        )
      }
      return new Response('', { status: 404 })
    }

    const emptyAdapter = new GistSyncAdapter({
      token: 'ghp_test',
      gistId: 'empty-gist',
      fetchFn: emptyGistFetch
    })
    const syncEngine = new E2eeSyncEngine({
      masterPassword: 'TestPassword!123',
      salt: 'Salt1234567890',
      adapter: emptyAdapter,
      gistId: 'empty-gist',
      argon2Options: { memoryCost: 64, timeCost: 2 }
    })
    syncEngine.upsertRecord('init-rec', { ok: true }, { updatedAt: 100 })
    const res = await syncEngine.sync()
    assert.equal(patched, true)
    assert.equal(res.records.length, 1)
  })

  // 验证远端 Gist 已存在同步文件且本地无基线时抛出双语 SyncConflictError
  const existingGistFetch = async () =>
    new Response(
      JSON.stringify({
        id: 'existing-gist',
        updated_at: '2026-10-12T10:00:00Z',
        created_at: '2026-10-12T09:00:00Z',
        public: false,
        files: {
          'ztools_sync_state.enc.json': {
            filename: 'ztools_sync_state.enc.json',
            content: '{}'
          }
        }
      }),
      { status: 200 }
    )
  const conflictGistAdapter = new GistSyncAdapter({
    token: 'ghp_test',
    gistId: 'existing-gist',
    fetchFn: existingGistFetch
  })
  const conflictEngine = new E2eeSyncEngine({
    masterPassword: 'TestPassword!123',
    salt: 'Salt1234567890',
    adapter: conflictGistAdapter,
    gistId: 'existing-gist',
    argon2Options: { memoryCost: 64, timeCost: 2 }
  })

  await withGlobalLocale('en-US', async () => {
    await assert.rejects(
      () => conflictEngine.push(),
      (err) => err instanceof SyncConflictError && /Remote Gist already contains a sync file/.test(err.message)
    )
  })
  await withGlobalLocale('zh-CN', async () => {
    await assert.rejects(
      () => conflictEngine.push(),
      (err) => err instanceof SyncConflictError && /检测到远端 Gist 已存在同步文件/.test(err.message)
    )
  })
})

test('explicit locale overrides runtime globalThis.__ztoolsLocale across crypto, adapters, and E2eeSyncEngine', async () => {
  const validKey = Buffer.alloc(32, 7)
  const shortKey = Buffer.alloc(16, 1)
  const validPayload = encryptAesGcm('hello', validKey)
  const invalidConfigPayload = encryptAesGcm(JSON.stringify({ wrong: true }), validKey)
  const invalidClipboardPayload = encryptAesGcm(JSON.stringify({ items: 'bad' }), validKey)

  await withGlobalLocale('en-US', async () => {
    // 1. 加密原语与封包解析：全局 en-US，显式传 zh-CN 应输出中文
    assert.throws(() => argon2id('pwd', 'short', { locale: 'zh-CN' }), /Argon2id 盐值长度至少需要 8 字节/)
    assert.throws(() => encryptAesGcm('hi', shortKey, undefined, 'zh-CN'), /AES-256-GCM 密钥长度必须为 32 字节/)
    assert.throws(() => decryptAesGcm(validPayload, shortKey, 'zh-CN'), /AES-256-GCM 密钥长度必须为 32 字节/)
    assert.throws(() => decryptConfigPayload(invalidConfigPayload, validKey, 'zh-CN'), /解密后的配置数据格式无效/)
    assert.throws(() => decryptClipboardPayload(invalidClipboardPayload, validKey, 'zh-CN'), /解密后的剪贴板数据格式无效/)

    // 2. WebDavSyncAdapter：实例 locale 与方法级 locale 覆盖全局 en-US
    const okFetch = async () =>
      new Response(
        `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/</D:href><D:status>HTTP/1.1 200 OK</D:status></D:response></D:multistatus>`,
        { status: 207 }
      )
    const failFetch = async () => new Response('Forbidden', { status: 403, statusText: 'Forbidden' })
    const zhWebDav = new WebDavSyncAdapter({ endpoint: 'https://dav.example.com/', fetchFn: okFetch, locale: 'zh-CN' })
    assert.equal(zhWebDav.locale, 'zh-CN')
    const zhConn = await zhWebDav.testConnection()
    assert.equal(zhConn.message, '连接成功 (检测到 1 个资源)')
    // 方法级 en-US 覆盖实例 zh-CN
    const enConnOverride = await zhWebDav.testConnection({ locale: 'en-US' })
    assert.equal(enConnOverride.message, 'Connection succeeded (1 resources detected)')

    const failWebDav = new WebDavSyncAdapter({ endpoint: 'https://dav.example.com/', fetchFn: failFetch, locale: 'zh-CN' })
    await assert.rejects(() => failWebDav.get('a.enc'), /GET 下载文件失败 \[403 Forbidden\]: a\.enc/)
    await assert.rejects(() => failWebDav.get('a.enc', { locale: 'en-US' }), /GET failed to download file \[403 Forbidden\]: a\.enc/)

    // 3. GistSyncAdapter：构造器与方法级 locale 覆盖全局 en-US
    assert.throws(() => new GistSyncAdapter({ token: '', locale: 'zh-CN' }), /GitHub Gist 适配器需要有效的 Personal Access Token/)
    const zhGist = new GistSyncAdapter({ token: 'ghp_test', fetchFn: failFetch, locale: 'zh-CN' })
    await assert.rejects(() => zhGist.getGist(), /未指定目标 Gist ID/)
    await assert.rejects(() => zhGist.getGist(undefined, { locale: 'en-US' }), /Target Gist ID is not specified/)

    // 4. E2eeSyncEngine：构造器与方法级 locale 覆盖全局 en-US
    assert.throws(
      () => new E2eeSyncEngine({ masterPassword: 'pwd', salt: '123', locale: 'zh-CN' }),
      /Argon2id 盐值长度至少需要 8 字节/
    )
    const zhEngine = new E2eeSyncEngine({
      masterPassword: 'TestPassword!123',
      salt: 'Salt1234567890',
      argon2Options: { memoryCost: 64, timeCost: 2 },
      locale: 'zh-CN'
    })
    assert.equal(zhEngine.locale, 'zh-CN')
    assert.throws(() => zhEngine.upsertRecord('', { x: 1 }), /同步记录 ID 必须为非空字符串/)
    assert.throws(() => zhEngine.upsertRecord('', { x: 1 }, { locale: 'en-US' }), /Sync record ID must be a non-empty string/)
    await assert.rejects(() => zhEngine.push(), /未配置同步适配器/)
    await assert.rejects(() => zhEngine.push(undefined, { locale: 'en-US' }), /Sync adapter is not configured/)
  })

  await withGlobalLocale('zh-CN', async () => {
    // 全局 zh-CN 时，显式传 en-US 覆盖为英文
    assert.throws(() => argon2id('pwd', 'short', { locale: 'en-US' }), /Argon2id salt must be at least 8 bytes/)
    assert.throws(() => new GistSyncAdapter({ token: '', locale: 'en-US' }), /GitHub Gist adapter requires a valid Personal Access Token/)
  })
})

test('resolveSyncLocale: strips POSIX .UTF-8/@... suffixes, skips system/third-party, and supports plural/escape templates', async () => {
  const prevEnv = process.env.ZTOOLS_LOCALE
  delete process.env.ZTOOLS_LOCALE
  try {
    assert.equal(stripSyncLocaleSuffix('zh_CN.UTF-8'), 'zh-CN')
    assert.equal(stripSyncLocaleSuffix('en_US@euro'), 'en-US')
    assert.equal(matchSyncSupportedLocale('system'), null)
    assert.equal(matchSyncSupportedLocale('ja-JP'), null)
    assert.equal(matchSyncSupportedLocale('fr-FR'), null)
    assert.equal(matchSyncSupportedLocale('zh_CN.UTF-8'), 'zh-CN')

    await withGlobalLocale(undefined, () => {
      assert.equal(resolveSyncLocale(['system', 'fr-FR', 'zh_CN.UTF-8']), 'zh-CN')
      assert.equal(resolveSyncLocale(['system', 'ja-JP']), 'en-US')
      assert.equal(resolveSyncLocale('en_US@euro'), 'en-US')
    })

    await withGlobalLocale('zh_CN.UTF-8', () => {
      assert.equal(resolveSyncLocale('system'), 'zh-CN')
      assert.equal(resolveSyncLocale('en_GB@euro'), 'en-US')
    })

    await withGlobalLocale(undefined, () => {
      process.env.ZTOOLS_LOCALE = 'zh_HK.UTF-8'
      assert.equal(resolveSyncLocale('system'), 'zh-CN')
      assert.equal(resolveSyncLocale('en-US'), 'en-US')
    })

    // 复数与字面量转义支持
    assert.equal(formatSyncTemplate('Synced {count} [[count:item|items]]', { count: 1 }), 'Synced 1 item')
    assert.equal(formatSyncTemplate('Synced {count} [[count:item|items]]', { count: 3 }), 'Synced 3 items')
    assert.equal(formatSyncTemplate('No items | One item | {count} items', { count: 0 }), 'No items')
    assert.equal(formatSyncTemplate('No items | One item | {count} items', { count: 1 }), 'One item')
    assert.equal(formatSyncTemplate('No items | One item | {count} items', { count: 5 }), '5 items')
    assert.equal(formatSyncTemplate('Keep {{date}} and pipe \\| for {id}', { date: 'ignored', id: 'sync-1' }), 'Keep {date} and pipe | for sync-1')
  } finally {
    if (prevEnv === undefined) delete process.env.ZTOOLS_LOCALE
    else process.env.ZTOOLS_LOCALE = prevEnv
  }
})
