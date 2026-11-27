import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_ARGON2_MEMORY_COST,
  argon2id,
  deriveMasterKey,
  encryptAesGcm,
  decryptAesGcm,
  decryptAesGcmString,
  DecryptionError,
  encryptConfigPayload,
  decryptConfigPayload,
  encryptClipboardPayload,
  decryptClipboardPayload,
  WebDavSyncAdapter,
  WebDavError,
  E2eeSyncEngine
} from '../dist/index.js'

test('Argon2id: exports RFC 9106 default memoryCost (65536 KiB) and does not mutate caller Buffers', () => {
  assert.equal(DEFAULT_ARGON2_MEMORY_COST, 65536)

  const pwdBuf = Buffer.from('CallerOwnedPassword!2026', 'utf8')
  const saltBuf = Buffer.from('CallerOwnedSalt_12345678', 'utf8')
  const pwdCopy = Buffer.from(pwdBuf)
  const saltCopy = Buffer.from(saltBuf)

  const key = deriveMasterKey(pwdBuf, saltBuf, { memoryCost: 64, timeCost: 2 })
  assert.equal(key.length, 32)
  // 调用方直接传入的外部 Buffer 不得被内部清零逻辑篡改
  assert.deepEqual(pwdBuf, pwdCopy)
  assert.deepEqual(saltBuf, saltCopy)

  // 验证纯 JS 实现输出与字符串入参等价且支持 64 字节以上任意长度派生
  const keyFromStr = argon2id('CallerOwnedPassword!2026', 'CallerOwnedSalt_12345678', {
    memoryCost: 64,
    timeCost: 2
  })
  assert.equal(key.toString('hex'), keyFromStr.toString('hex'))

  const longKey = argon2id('CallerOwnedPassword!2026', 'CallerOwnedSalt_12345678', {
    memoryCost: 64,
    timeCost: 2,
    outputLength: 96
  })
  assert.equal(longKey.length, 96)
})

test('AES-256-GCM & sync-payload: enforces expectedAadPrefix and blocks cross-domain ciphertext confusion', () => {
  const key = deriveMasterKey('AadTestPassword!2026', 'AadTestSalt_12345678', {
    memoryCost: 64,
    timeCost: 2
  })

  // 1. 缺失 AAD 时指定 expectedAadPrefix 必须抛出 DecryptionError
  const noAadPayload = encryptAesGcm('{"schemaVersion":1,"settings":{}}', key)
  assert.throws(
    () => decryptAesGcm(noAadPayload, key, { expectedAadPrefix: 'ztools:config:' }),
    (err) => err instanceof DecryptionError && /ztools:config:/.test(err.message)
  )
  assert.throws(
    () => decryptAesGcmString(noAadPayload, key, 'zh-CN', 'ztools:config:'),
    (err) => err instanceof DecryptionError && /缺少预期的 AAD 前缀/.test(err.message)
  )
  assert.throws(
    () => decryptConfigPayload(noAadPayload, key),
    (err) => err instanceof DecryptionError
  )
  assert.throws(
    () => decryptClipboardPayload(noAadPayload, key),
    (err) => err instanceof DecryptionError
  )

  // 2. 跨业务密文混淆：将配置密文喂给剪贴板解密器，或将剪贴板密文喂给配置解密器，必须拦截
  const configEnvelope = encryptConfigPayload(
    {
      schemaVersion: 1,
      updatedAt: '2026-11-26T00:00:00Z',
      settings: { theme: 'dark' }
    },
    key
  )
  const clipboardEnvelope = encryptClipboardPayload(
    {
      schemaVersion: 1,
      updatedAt: '2026-11-26T00:00:00Z',
      items: [{ id: '1', type: 'text', content: 'hi', timestamp: 1 }]
    },
    key
  )

  assert.throws(
    () => decryptClipboardPayload(configEnvelope, key),
    (err) => err instanceof DecryptionError
  )
  assert.throws(
    () => decryptConfigPayload(clipboardEnvelope, key),
    (err) => err instanceof DecryptionError
  )

  // 3. 合法 AAD 前缀可正常通过（兼容 options 对象与位置参数）
  const customPayload = encryptAesGcm('ok', key, 'ztools:custom:v1')
  assert.equal(
    decryptAesGcmString(customPayload, key, { expectedAadPrefix: 'ztools:custom:' }),
    'ok'
  )
  assert.equal(
    decryptAesGcmString(customPayload, key, undefined, 'ztools:custom:'),
    'ok'
  )
})

test('E2eeSyncEngine: rejects state snapshot without ztools:sync-state: AAD prefix', async () => {
  const key = deriveMasterKey('EngineAadPass!2026', 'EngineAadSalt123456', {
    memoryCost: 64,
    timeCost: 2
  })
  // 使用配置 AAD 加密一个伪装成 SyncStateSnapshot 的 JSON，试图跨业务注入
  const forgedState = encryptAesGcm(
    JSON.stringify({ schemaVersion: 1, updatedAt: '2026-11-26T00:00:00Z', deviceId: 'evil', records: [] }),
    key,
    'ztools:config:v1:2026-11-26T00:00:00Z'
  )

  const adapter = new WebDavSyncAdapter({
    endpoint: 'https://dav.example.com/dav/',
    fetchFn: async () => new Response(JSON.stringify(forgedState), { status: 200 })
  })

  const engine = new E2eeSyncEngine({
    masterPassword: 'EngineAadPass!2026',
    salt: 'EngineAadSalt123456',
    adapter,
    argon2Options: { memoryCost: 64, timeCost: 2 }
  })

  await assert.rejects(
    () => engine.pull(),
    (err) => err instanceof DecryptionError && /ztools:sync-state:/.test(err.message)
  )
})

test('E2eeSyncEngine: hides raw key getter and locks engine after idempotent destroy()', async () => {
  const adapter = new WebDavSyncAdapter({
    endpoint: 'https://dav.example.com/dav/',
    fetchFn: async () => new Response('', { status: 201 })
  })

  const engine = new E2eeSyncEngine({
    masterPassword: 'DestroyPassword!2026',
    salt: 'DestroySalt_12345678',
    adapter,
    argon2Options: { memoryCost: 64, timeCost: 2 }
  })

  // 不再暴露裸 key getter
  assert.equal('key' in engine, false)
  assert.equal(engine.isDestroyed, false)

  engine.upsertRecord('item-1', { secret: 'top' }, { updatedAt: 100 })
  assert.equal(engine.listRecords().length, 1)

  // 销毁与幂等再次销毁
  engine.destroy()
  assert.equal(engine.isDestroyed, true)
  assert.equal(engine.listRecords({ includeDeleted: true }).length, 0)
  engine.destroy()
  assert.equal(engine.isDestroyed, true)

  // 销毁后所有加解密/同步方法必须立即抛错（中英文双语均生效）
  await assert.rejects(() => engine.push(), /destroyed/i)
  await assert.rejects(() => engine.pull(undefined, { locale: 'zh-CN' }), /已销毁/)
  await assert.rejects(() => engine.sync(), /destroyed/i)
  await assert.rejects(
    () =>
      engine.pushConfigToWebDav(adapter, {
        schemaVersion: 1,
        updatedAt: '2026-11-26T00:00:00Z',
        settings: {}
      }),
    /destroyed/i
  )
  await assert.rejects(() => engine.pullConfigFromWebDav(adapter), /destroyed/i)
  await assert.rejects(
    () =>
      engine.pushClipboardToWebDav(adapter, {
        schemaVersion: 1,
        updatedAt: '2026-11-26T00:00:00Z',
        items: []
      }),
    /destroyed/i
  )
  await assert.rejects(() => engine.pullClipboardFromWebDav(adapter), /destroyed/i)
})

test('WebDavSyncAdapter: enforces HTTPS by default and allows HTTP only with allowInsecureHttp: true', async () => {
  // 默认拒绝明文 HTTP
  assert.throws(
    () => new WebDavSyncAdapter({ endpoint: 'http://dav.example.com/dav/' }),
    (err) => err instanceof WebDavError && /HTTPS/i.test(err.message)
  )
  assert.throws(
    () => new WebDavSyncAdapter({ endpoint: 'http://dav.example.com/dav/', locale: 'zh-CN' }),
    (err) => err instanceof WebDavError && /allowInsecureHttp/.test(err.message)
  )

  // 拒绝非法协议与非法 URL
  assert.throws(
    () => new WebDavSyncAdapter({ endpoint: 'file:///etc/passwd' }),
    (err) => err instanceof WebDavError
  )
  assert.throws(
    () => new WebDavSyncAdapter({ endpoint: 'not-a-valid-url' }),
    (err) => err instanceof WebDavError
  )

  // 显式 allowInsecureHttp: true 放行 HTTP
  let requestedUrl = ''
  const httpAdapter = new WebDavSyncAdapter({
    endpoint: 'http://nas.local:5005/dav',
    allowInsecureHttp: true,
    fetchFn: async (url) => {
      requestedUrl = url.toString()
      return new Response('ok', { status: 200 })
    }
  })
  await httpAdapter.get('sync.enc')
  assert.equal(requestedUrl, 'http://nas.local:5005/dav/sync.enc')
})

test('WebDavSyncAdapter: blocks basePath, subPath, and ensureDirectory traversal / URL injection', async () => {
  // basePath 穿越校验
  for (const badBase of ['../escape', '/a/../b', 'a\\b', '/%2e%2e/', '/%2fbad', '/bad\0null', 'https://evil.com/x', '//evil.com/x']) {
    assert.throws(
      () => new WebDavSyncAdapter({ endpoint: 'https://dav.example.com/dav/', basePath: badBase }),
      (err) => err instanceof WebDavError,
      `basePath should be rejected: ${badBase}`
    )
  }

  let fetchCalled = false
  const adapter = new WebDavSyncAdapter({
    endpoint: 'https://dav.example.com/dav/',
    basePath: '/ztools/',
    fetchFn: async () => {
      fetchCalled = true
      return new Response('', { status: 201 })
    }
  })

  const maliciousSubPaths = [
    '../secret.enc',
    'sub/../../secret.enc',
    './secret.enc',
    'a/./b',
    '..',
    '.',
    'a\\b\\c',
    'https://evil.com/steal',
    'http://evil.com/steal',
    '//evil.com/steal',
    'javascript:alert(1)',
    '%2e%2e/secret.enc',
    '%2E%2E%2Fsecret.enc',
    'sub%2f..%2fsecret',
    'sub%5cfile',
    'file\0.enc',
    'file\n.enc',
    'file?query=1',
    'file#hash'
  ]

  for (const badPath of maliciousSubPaths) {
    await assert.rejects(
      () => adapter.get(badPath),
      (err) => err instanceof WebDavError,
      `get() should reject malicious subPath: ${badPath}`
    )
    await assert.rejects(
      () => adapter.put(badPath, 'x'),
      (err) => err instanceof WebDavError,
      `put() should reject malicious subPath: ${badPath}`
    )
    await assert.rejects(
      () => adapter.ensureDirectory(badPath),
      (err) => err instanceof WebDavError,
      `ensureDirectory() should reject malicious dirPath: ${badPath}`
    )
  }
  assert.equal(fetchCalled, false, '非法路径在校验阶段即被拦截，不得触发任何网络请求')

  // 正常多层目录与相对路径可合法通过
  await adapter.ensureDirectory('backups/2026/monthly')
  assert.equal(fetchCalled, true)
})
