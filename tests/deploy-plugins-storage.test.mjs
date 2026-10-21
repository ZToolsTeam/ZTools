import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import {
  loadEnvFile,
  createOssHeaders,
  getCacheControl,
  uploadToOss,
  deployPluginsStorage,
  aliyunPercentEncode,
  signAliyunRpcQuery,
  refreshAliyunCdnCache,
  readOssObject,
  findChangedPackageUrls
} from '../scripts/deploy-plugins-storage.mjs'

/**
 * 本地模拟阿里云：同一个服务既当 OSS（PUT 对象）又当 CDN 刷新接口（GET /?Action=...）。
 * 会真的校验 OSS 签名和 CDN 签名，并按 behavior 注入故障。
 */
async function startFakeAliyun({ secret = 'MOCK_SECRET', behavior = {} } = {}) {
  const puts = []
  const refreshes = []
  const gets = []
  // 按发生顺序记录 PUT / 刷新，用来断言「先刷新安装包，再更新目录」
  const events = []
  const objects = { ...(behavior.objects || {}) }
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'GET' && !req.url.startsWith('/?')) {
        const key = decodeURIComponent(req.url.replace(/^\//, ''))
        const stringToSign = ['GET', '', req.headers['content-type'], req.headers.date, `/ztools-data/${key}`].join('\n')
        const sig = crypto.createHmac('sha1', secret).update(stringToSign).digest('base64')
        if (req.headers.authorization !== `OSS MOCK_ID:${sig}`) {
          res.writeHead(403)
          return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>')
        }
        gets.push(key)
        if (behavior.getStatus) {
          res.writeHead(behavior.getStatus)
          return res.end('<Error><Code>InternalError</Code></Error>')
        }
        if (!(key in objects)) {
          res.writeHead(404)
          return res.end('<Error><Code>NoSuchKey</Code></Error>')
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(objects[key])
      }
      if (req.method === 'PUT') {
        const key = decodeURIComponent(req.url.replace(/^\//, ''))
        if (behavior.putStatus && behavior.putFailKey?.(key)) {
          res.writeHead(behavior.putStatus, { 'Content-Type': 'application/xml' })
          return res.end('<Error><Code>InternalError</Code></Error>')
        }
        const expected = createOssHeaders({
          method: 'PUT',
          bucket: 'ztools-data',
          objectKey: key,
          accessKeyId: 'MOCK_ID',
          accessKeySecret: secret,
          contentType: req.headers['content-type'],
          contentLength: Number(req.headers['content-length']),
          cacheControl: req.headers['cache-control']
        })
        // Date 每次生成，签名用请求自带的 Date 重算
        const stringToSign = ['PUT', '', req.headers['content-type'], req.headers.date, `/ztools-data/${key}`].join('\n')
        const sig = crypto.createHmac('sha1', secret).update(stringToSign).digest('base64')
        if (req.headers.authorization !== `OSS MOCK_ID:${sig}` || !expected.Authorization) {
          res.writeHead(403)
          return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>')
        }
        puts.push({ key, cacheControl: req.headers['cache-control'], body: Buffer.concat(chunks) })
        events.push(`put:${key}`)
        res.writeHead(200)
        return res.end()
      }
      const url = new URL(req.url, 'http://x')
      const params = Object.fromEntries(url.searchParams)
      const { Signature, ...rest } = params
      const expectedQuery = signAliyunRpcQuery(rest, secret)
      const expectedSig = decodeURIComponent(expectedQuery.split('&Signature=')[1])
      if (behavior.cdnStatus) {
        res.writeHead(behavior.cdnStatus, { 'Content-Type': 'application/json' })
        return res.end(behavior.cdnBody ?? JSON.stringify({ Code: 'Throttling.User', Message: 'Request was denied due to user flow control.' }))
      }
      if (Signature !== expectedSig) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ Code: 'SignatureDoesNotMatch', Message: 'bad signature' }))
      }
      refreshes.push(params)
      events.push(`refresh:${params.ObjectPath}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ RefreshTaskId: '123456', RequestId: 'req-1' }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  return { endpoint, puts, refreshes, gets, events, close: () => new Promise((r) => server.close(r)) }
}

const ZIP_URL = 'https://cdn.ztools.cn/plugins-v2/ztools-team/translator/translator-2.1.0.zip'

function makeDist(dir, entries = []) {
  fs.mkdirSync(path.join(dir, 'ztools-team', 'translator'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'ztools-team', 'translator', 'translator-2.1.0.zip'), 'PK\u0003\u0004mock')
  fs.writeFileSync(path.join(dir, 'ztools-team', 'translator', 'icon.svg'), '<svg/>')
  fs.writeFileSync(path.join(dir, 'catalog.json'), JSON.stringify({ list: entries, plugins: entries }))
  fs.writeFileSync(path.join(dir, 'plugins.json'), JSON.stringify({ list: entries, plugins: entries }))
}

const entry = (sha256, downloadUrl = ZIP_URL) => ({ id: 'translator', version: '2.1.0', downloadUrl, sha256 })

test('Deploy & Storage Pipeline - Integration & Chaos Suite', async (t) => {
  const tmpDir = path.resolve('tests/.tmp-deploy-test')
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  fs.mkdirSync(tmpDir, { recursive: true })

  t.after(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  await t.test('1. loadEnvFile: 能正确解析键值对并过滤注释与空行', () => {
    const testEnvPath = path.join(tmpDir, 'test.env')
    fs.writeFileSync(
      testEnvPath,
      `
      # 这是一个测试注释
      TEST_KEY_PLAIN=hello_world
      TEST_KEY_QUOTED="quoted_val"
      TEST_KEY_SINGLE='single_val'
      INVALID_LINE_NO_EQUALS
      EMPTY_VAL=
      `
    )

    const parsed = loadEnvFile(testEnvPath)
    assert.equal(parsed.TEST_KEY_PLAIN, 'hello_world')
    assert.equal(parsed.TEST_KEY_QUOTED, 'quoted_val')
    assert.equal(parsed.TEST_KEY_SINGLE, 'single_val')
    assert.equal(parsed.EMPTY_VAL, '')
    assert.equal(typeof parsed.INVALID_LINE_NO_EQUALS, 'undefined')
  })

  await t.test('2. getCacheControl: 严格断言静态分发多级缓存策略', () => {
    // 插件 zip 包必须强缓存 30 天 + immutable
    assert.match(getCacheControl('author.plugin-1.0.0.zip'), /max-age=2592000/)
    assert.match(getCacheControl('author.plugin-1.0.0.zip'), /immutable/)

    // 全网静态索引 plugins.json 必须短缓存 5 分钟 (300s)，保证秒级下架
    assert.match(getCacheControl('plugins.json'), /max-age=300/)
    assert.match(getCacheControl('metadata/catalog.json'), /max-age=300/)

    // 其他静态资产 (如 logo.png) 默认 7 天
    assert.match(getCacheControl('icons/icon.png'), /max-age=604800/)
  })

  await t.test('3. createOssHeaders: 正常生成标准 HMAC-SHA1 签名与规范头', () => {
    const headers = createOssHeaders({
      method: 'PUT',
      bucket: 'test-bucket',
      objectKey: 'plugins/author.plugin-1.0.0.zip',
      accessKeyId: 'LTAI_MOCK_KEY',
      accessKeySecret: 'MOCK_SECRET_12345',
      contentType: 'application/zip',
      contentLength: 1024,
      cacheControl: 'public, max-age=2592000, immutable',
      extraHeaders: {
        'x-oss-meta-author': 'ztools',
        'x-oss-storage-class': 'Standard'
      }
    })

    assert.ok(headers.Authorization.startsWith('OSS LTAI_MOCK_KEY:'))
    assert.equal(headers['Content-Type'], 'application/zip')
    assert.equal(headers['Content-Length'], '1024')
    assert.equal(headers['Cache-Control'], 'public, max-age=2592000, immutable')
    assert.ok(headers.Date)
    assert.equal(headers['x-oss-meta-author'], 'ztools')
  })

  await t.test('4. createOssHeaders: 边界与路径清洗 (多斜杠清洗与空值处理)', () => {
    const headers = createOssHeaders({
      method: 'PUT',
      bucket: 'test-bucket',
      objectKey: '///deep/nested//test.json',
      accessKeyId: 'KEY',
      accessKeySecret: 'SECRET'
    })

    assert.ok(headers.Authorization.startsWith('OSS KEY:'))
    assert.equal(headers['Content-Length'], '0')
    assert.equal(headers['Content-Type'], 'application/octet-stream')
  })

  await t.test('5. uploadToOss: 仿真演练模式 (--dry-run) 零网络副作用', async () => {
    const testFile = path.join(tmpDir, 'simulated.zip')
    fs.writeFileSync(testFile, 'dummy zip content')

    const res = await uploadToOss({
      file: {
        relPath: 'simulated.zip',
        fullPath: testFile,
        size: 17
      },
      accessKeyId: 'KEY',
      accessKeySecret: 'SECRET',
      bucket: 'bucket',
      region: 'oss-cn-shenzhen',
      dryRun: true
    })

    assert.equal(res.success, true)
    assert.equal(res.simulated, true)
  })

  await t.test('6. deployPluginsStorage: 非法路径异常防护', async () => {
    await assert.rejects(
      async () => {
        await deployPluginsStorage({
          dir: path.join(tmpDir, 'non-existent-dir'),
          dryRun: true
        })
      },
      /发布产物目录不存在/
    )
  })

  await t.test('7. deployPluginsStorage: 空目录告警与演练模式', async () => {
    const distPluginsDir = path.join(tmpDir, 'dist-plugins')
    fs.mkdirSync(distPluginsDir, { recursive: true })

    const emptyResult = await deployPluginsStorage({ dir: distPluginsDir, dryRun: true })
    assert.equal(emptyResult.uploadedCount, 0)

    makeDist(distPluginsDir)
    const fullResult = await deployPluginsStorage({ dir: distPluginsDir, dryRun: true })

    assert.equal(fullResult.success, true)
    assert.equal(fullResult.filesCount, 4)
    // 默认就是线上实际的地址：阿里云 OSS 的 plugins-v2/ 目录 + cdn.ztools.cn
    assert.ok(fullResult.uploadedKeys.every((k) => k.startsWith('plugins-v2/')))
    assert.deepEqual(fullResult.refreshedUrls.sort(), [
      'https://cdn.ztools.cn/plugins-v2/catalog.json',
      'https://cdn.ztools.cn/plugins-v2/plugins.json'
    ])
  })

  await t.test('8. 正式上传：签名正确、安装包先传、插件目录最后传，并刷新 CDN 上的目录', async () => {
    const fake = await startFakeAliyun()
    const dir = path.join(tmpDir, 'dist-real')
    makeDist(dir)
    try {
      const result = await deployPluginsStorage({
        dir,
        ossAccessKeyId: 'MOCK_ID',
        ossAccessKeySecret: 'MOCK_SECRET',
        ossEndpoint: fake.endpoint,
        cdnEndpoint: fake.endpoint
      })

      assert.equal(result.success, true)
      const keys = fake.puts.map((p) => p.key)
      assert.equal(keys.length, 4)
      // 目录文件必须排在所有安装包之后
      const lastNonIndex = Math.max(...keys.map((k, i) => (k.endsWith('.json') ? -1 : i)))
      const firstIndex = keys.findIndex((k) => k.endsWith('.json'))
      assert.ok(firstIndex > lastNonIndex, `上传顺序错误: ${keys.join(', ')}`)
      assert.ok(keys.includes('plugins-v2/ztools-team/translator/translator-2.1.0.zip'))

      const zip = fake.puts.find((p) => p.key.endsWith('.zip'))
      assert.equal(zip.cacheControl, 'public, max-age=2592000, immutable')
      assert.equal(zip.body.toString(), 'PK\u0003\u0004mock')
      const catalog = fake.puts.find((p) => p.key === 'plugins-v2/catalog.json')
      assert.equal(catalog.cacheControl, 'public, max-age=300')

      // 只刷新插件目录，安装包带版本号不用刷新
      assert.equal(fake.refreshes.length, 1)
      const refresh = fake.refreshes[0]
      assert.equal(refresh.Action, 'RefreshObjectCaches')
      assert.equal(refresh.ObjectType, 'File')
      assert.deepEqual(refresh.ObjectPath.split('\n').sort(), [
        'https://cdn.ztools.cn/plugins-v2/catalog.json',
        'https://cdn.ztools.cn/plugins-v2/plugins.json'
      ])
    } finally {
      await fake.close()
    }
  })

  await t.test('9. 没配阿里云密钥时直接报错，不会假装上传成功', async () => {
    const dir = path.join(tmpDir, 'dist-nokey')
    makeDist(dir)
    const saved = { id: process.env.OSS_ACCESS_KEY_ID, secret: process.env.OSS_ACCESS_KEY_SECRET }
    delete process.env.OSS_ACCESS_KEY_ID
    delete process.env.OSS_ACCESS_KEY_SECRET
    try {
      await assert.rejects(() => deployPluginsStorage({ dir }), /缺少阿里云 OSS 凭证/)
    } finally {
      if (saved.id !== undefined) process.env.OSS_ACCESS_KEY_ID = saved.id
      if (saved.secret !== undefined) process.env.OSS_ACCESS_KEY_SECRET = saved.secret
    }
  })

  await t.test('10. 密钥错误（签名不匹配）时报错，且插件目录不会被上传', async () => {
    const fake = await startFakeAliyun({ secret: 'REAL_SECRET' })
    const dir = path.join(tmpDir, 'dist-badkey')
    makeDist(dir)
    try {
      await assert.rejects(
        () => deployPluginsStorage({
          dir,
          ossAccessKeyId: 'MOCK_ID',
          ossAccessKeySecret: 'WRONG_SECRET',
          ossEndpoint: fake.endpoint,
          cdnEndpoint: fake.endpoint
        }),
        /OSS 上传失败 \[HTTP 403\]/
      )
      assert.equal(fake.puts.length, 0)
      assert.equal(fake.refreshes.length, 0)
    } finally {
      await fake.close()
    }
  })

  await t.test('11. 中途某个安装包上传失败（OSS 5xx）时立即停止，旧的插件目录保持不变', async () => {
    const fake = await startFakeAliyun({
      secret: 'MOCK_SECRET',
      behavior: { putStatus: 503, putFailKey: (k) => k.endsWith('.zip') }
    })
    const dir = path.join(tmpDir, 'dist-5xx')
    makeDist(dir)
    try {
      await assert.rejects(
        () => deployPluginsStorage({
          dir,
          ossAccessKeyId: 'MOCK_ID',
          ossAccessKeySecret: 'MOCK_SECRET',
          ossEndpoint: fake.endpoint,
          cdnEndpoint: fake.endpoint
        }),
        /OSS 上传失败 \[HTTP 503\]/
      )
      assert.ok(fake.puts.every((p) => !p.key.endsWith('.json')), '安装包没传上去时绝不能更新插件目录')
      assert.equal(fake.refreshes.length, 0)
    } finally {
      await fake.close()
    }
  })

  await t.test('12. CDN 刷新被限流或返回异常时报错，让流水线标红', async () => {
    for (const behavior of [
      { cdnStatus: 429 },
      { cdnStatus: 500, cdnBody: '<html>gateway error</html>' },
      { cdnStatus: 200, cdnBody: JSON.stringify({ Code: 'InvalidObjectPath.Malformed', Message: 'bad path' }) }
    ]) {
      const fake = await startFakeAliyun({ behavior })
      try {
        await assert.rejects(
          () => refreshAliyunCdnCache({
            accessKeyId: 'MOCK_ID',
            accessKeySecret: 'MOCK_SECRET',
            urls: ['https://cdn.ztools.cn/plugins-v2/catalog.json'],
            endpoint: fake.endpoint
          }),
          /阿里云 CDN 缓存刷新失败/
        )
      } finally {
        await fake.close()
      }
    }
  })

  await t.test('13. 阿里云签名编码：特殊字符按 RFC 3986 编码，参数按字典序排序', () => {
    assert.equal(aliyunPercentEncode("a b*c~d!'()"), 'a%20b%2Ac~d%21%27%28%29')
    assert.equal(aliyunPercentEncode('https://cdn.ztools.cn/a\nb'), 'https%3A%2F%2Fcdn.ztools.cn%2Fa%0Ab')
    const q = signAliyunRpcQuery({ b: '2', a: '1' }, 'secret')
    assert.ok(q.startsWith('a=1&b=2&Signature='))
    // 同样的参数和密钥必须得到同样的签名，密钥不同签名不同
    assert.equal(q, signAliyunRpcQuery({ a: '1', b: '2' }, 'secret'))
    assert.notEqual(q, signAliyunRpcQuery({ a: '1', b: '2' }, 'other'))
  })

  await t.test('14. 文件名含空格与中文时按 URL 编码上传，OSS 收到的对象名不变', async () => {
    const fake = await startFakeAliyun()
    const dir = path.join(tmpDir, 'dist-encode')
    fs.mkdirSync(path.join(dir, 'ztools-team', 'demo'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'ztools-team', 'demo', '图 标 1.png'), 'png')
    try {
      await deployPluginsStorage({
        dir,
        ossAccessKeyId: 'MOCK_ID',
        ossAccessKeySecret: 'MOCK_SECRET',
        ossEndpoint: fake.endpoint,
        cdnEndpoint: fake.endpoint
      })
      assert.deepEqual(fake.puts.map((p) => p.key), ['plugins-v2/ztools-team/demo/图 标 1.png'])
      assert.equal(fake.refreshes.length, 0, '没有插件目录文件时不需要刷新 CDN')
    } finally {
      await fake.close()
    }
  })

  const deployWith = (fake, dir) =>
    deployPluginsStorage({
      dir,
      ossAccessKeyId: 'MOCK_ID',
      ossAccessKeySecret: 'MOCK_SECRET',
      ossEndpoint: fake.endpoint,
      cdnEndpoint: fake.endpoint
    })

  await t.test('15. 版本号没变但安装包内容变了：先刷新该安装包的 CDN 缓存，再更新并刷新插件目录', async () => {
    const fake = await startFakeAliyun({
      behavior: { objects: { 'plugins-v2/catalog.json': JSON.stringify({ plugins: [entry('a'.repeat(64))] }) } }
    })
    const dir = path.join(tmpDir, 'dist-changed')
    makeDist(dir, [entry('b'.repeat(64))])
    try {
      const result = await deployWith(fake, dir)
      assert.deepEqual(fake.gets, ['plugins-v2/catalog.json'], '必须从源站读上一版目录')
      assert.deepEqual(result.changedPackageUrls, [ZIP_URL])
      assert.equal(fake.refreshes.length, 2)
      const zipRefresh = fake.events.indexOf(`refresh:${ZIP_URL}`)
      const zipPut = fake.events.indexOf('put:plugins-v2/ztools-team/translator/translator-2.1.0.zip')
      const catalogPut = fake.events.indexOf('put:plugins-v2/catalog.json')
      assert.ok(zipPut < zipRefresh && zipRefresh < catalogPut, `顺序错误: ${fake.events.join(' | ')}`)
    } finally {
      await fake.close()
    }
  })

  await t.test('16. 安装包内容没变：只刷新插件目录，不刷新安装包', async () => {
    const sha = 'c'.repeat(64)
    const fake = await startFakeAliyun({
      behavior: { objects: { 'plugins-v2/catalog.json': JSON.stringify({ plugins: [entry(sha)] }) } }
    })
    const dir = path.join(tmpDir, 'dist-same')
    makeDist(dir, [entry(sha)])
    try {
      const result = await deployWith(fake, dir)
      assert.deepEqual(result.changedPackageUrls, [])
      assert.equal(fake.refreshes.length, 1)
      assert.ok(!fake.refreshes[0].ObjectPath.includes('.zip'))
    } finally {
      await fake.close()
    }
  })

  await t.test('17. 读上一版目录失败（OSS 500）或目录损坏：保守地刷新全部安装包，发布照常完成', async () => {
    for (const behavior of [
      { getStatus: 500 },
      { objects: { 'plugins-v2/catalog.json': '{not json' } }
    ]) {
      const fake = await startFakeAliyun({ behavior })
      const dir = path.join(tmpDir, `dist-noprev-${behavior.getStatus || 'bad'}`)
      makeDist(dir, [entry('d'.repeat(64))])
      try {
        const result = await deployWith(fake, dir)
        assert.equal(result.success, true)
        assert.deepEqual(result.changedPackageUrls, [ZIP_URL])
        assert.ok(fake.puts.some((p) => p.key === 'plugins-v2/catalog.json'))
      } finally {
        await fake.close()
      }
    }
  })

  await t.test('18. 首次发布（线上还没有目录）：全部安装包都刷新一次', async () => {
    const fake = await startFakeAliyun()
    const dir = path.join(tmpDir, 'dist-first')
    makeDist(dir, [entry('e'.repeat(64))])
    try {
      const result = await deployWith(fake, dir)
      assert.deepEqual(result.changedPackageUrls, [ZIP_URL])
    } finally {
      await fake.close()
    }
  })

  await t.test('19. findChangedPackageUrls：新版本地址不刷新、其他域名忽略、超过 100 个分批提交', async () => {
    const base = 'https://cdn.ztools.cn'
    const prev = { plugins: [entry('1'.repeat(64)), entry('2'.repeat(64), `${base}/plugins-v2/x/a-1.0.0.zip`)] }
    const next = {
      plugins: [
        entry('9'.repeat(64)),
        entry('2'.repeat(64), `${base}/plugins-v2/x/a-1.0.0.zip`),
        entry('3'.repeat(64), `${base}/plugins-v2/x/a-1.0.1.zip`),
        entry('4'.repeat(64), 'https://evil.example.com/a.zip')
      ]
    }
    assert.deepEqual(findChangedPackageUrls(next, prev, base), [ZIP_URL])
    assert.deepEqual(findChangedPackageUrls(next, null, base).length, 3)
    assert.deepEqual(findChangedPackageUrls(null, prev, base), [])

    const many = Array.from({ length: 150 }, (_, i) => entry('f'.repeat(64), `${base}/plugins-v2/x/p${i}-1.0.0.zip`))
    const fake = await startFakeAliyun()
    const dir = path.join(tmpDir, 'dist-many')
    makeDist(dir, many)
    try {
      const result = await deployWith(fake, dir)
      assert.equal(result.changedPackageUrls.length, 150)
      const zipBatches = fake.refreshes.filter((r) => r.ObjectPath.includes('.zip'))
      assert.deepEqual(zipBatches.map((r) => r.ObjectPath.split('\n').length), [100, 50])
    } finally {
      await fake.close()
    }
  })

  await t.test('20. readOssObject：签名错误报错、不存在返回 null', async () => {
    const fake = await startFakeAliyun({ secret: 'REAL', behavior: { objects: { 'k.json': '{}' } } })
    try {
      await assert.rejects(
        () => readOssObject({ objectKey: 'k.json', accessKeyId: 'MOCK_ID', accessKeySecret: 'WRONG', bucket: 'ztools-data', endpoint: fake.endpoint }),
        /OSS 读取失败 \[HTTP 403\]/
      )
      const opts = { accessKeyId: 'MOCK_ID', accessKeySecret: 'REAL', bucket: 'ztools-data', endpoint: fake.endpoint }
      assert.equal(await readOssObject({ ...opts, objectKey: 'k.json' }), '{}')
      assert.equal(await readOssObject({ ...opts, objectKey: 'missing.json' }), null)
    } finally {
      await fake.close()
    }
  })
})
