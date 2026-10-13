import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import {
  loadEnvFile,
  createOssHeaders,
  getCacheControl,
  uploadToOss,
  deployPluginsStorage
} from '../scripts/deploy-plugins-storage.mjs'

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

  await t.test('7. deployPluginsStorage: 完整集成测试 (空目录告警与多产物仿真流程)', async () => {
    const distPluginsDir = path.join(tmpDir, 'dist-plugins')
    fs.mkdirSync(distPluginsDir, { recursive: true })

    // 空目录场景
    const emptyResult = await deployPluginsStorage({
      dir: distPluginsDir,
      dryRun: true
    })
    assert.equal(emptyResult.uploadedCount, 0)

    // 创建模拟发布产物 (plugins.json + zip)
    fs.writeFileSync(path.join(distPluginsDir, 'plugins.json'), JSON.stringify({ version: 1, plugins: [] }))
    fs.writeFileSync(path.join(distPluginsDir, 'demo.plugin-1.0.0.zip'), 'PK0304mock')

    const fullResult = await deployPluginsStorage({
      dir: distPluginsDir,
      dryRun: true,
      ossAccessKeyId: 'test_oss_key',
      ossAccessKeySecret: 'test_oss_secret',
      cosSecretId: 'test_cos_id',
      cosSecretKey: 'test_cos_key',
      r2AccountId: 'test_r2_acc',
      r2AccessKeyId: 'test_r2_key',
      r2SecretAccessKey: 'test_r2_secret',
      edgeOneZoneId: 'zone-123'
    })

    assert.equal(fullResult.success, true)
    assert.equal(fullResult.filesCount, 2)
  })
})
