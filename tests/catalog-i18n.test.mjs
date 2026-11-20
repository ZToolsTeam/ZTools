/**
 * tests/catalog-i18n.test.mjs
 *
 * 插件市场构建与同步管线国际化集成测试（Wave 2 / W2-B）：
 * 1. build-plugins-release.mjs：双轨 category + categoryId、defaultLocale、i18n 元数据与多语言截图收集/CDN 拷贝、
 *    is_official 布尔标记与 revokedCode/多语言下架原因、异常多语言截图拦截；
 * 2. deploy-plugins-storage.mjs：多语言截图强缓存策略、先于目录上传与 CDN 目录刷新全覆盖；
 * 3. sync-plugins-to-backend.mjs：同步清单中的 categoryId、defaultLocale 与 i18n 到后台。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import {
  buildPluginsRelease,
  collectPluginScreenshots,
  screenshotCdnName,
  resolveCatalogCategories
} from '../scripts/build-plugins-release.mjs'
import {
  deployPluginsStorage,
  getCacheControl,
  signAliyunRpcQuery
} from '../scripts/deploy-plugins-storage.mjs'
import {
  buildPluginSeoMetadata,
  collectPluginSyncPayload,
  resolveSyncCategoryId,
  sanitizeSyncI18n
} from '../scripts/sync-plugins-to-backend.mjs'
import { createTempDirTracker } from './helpers/temp-dir.mjs'

const tmpTracker = createTempDirTracker()
test.after(() => {
  tmpTracker.cleanupAll()
})

function makePng(width, height, fillByte = 0) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  const raw = Buffer.alloc(height * (width + 1), fillByte)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function writePlugin(root, authorDir, id, manifestPatch = {}, files = {}) {
  const dir = path.join(root, authorDir, id)
  const manifest = {
    id,
    name: `${id} 插件`,
    version: '1.2.0',
    description: `${id} 默认描述`,
    author: authorDir === 'official' ? 'ZTools Team' : 'community-dev',
    category: ['开发工具'],
    entry: 'dist/index.js',
    icon: 'icon.svg',
    permissions: [],
    targets: [{ id: 'windows-electron-any', platform: 'windows', runtime: 'electron', arch: 'any' }],
    nativeComponents: [],
    ...manifestPatch
  }
  const allFiles = {
    'plugin.json': JSON.stringify(manifest, null, 2),
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'dist/index.js': 'export default function Command() { return null }\n',
    ...files
  }
  for (const [rel, content] of Object.entries(allFiles)) {
    const target = path.join(dir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }
  return dir
}

test('1. resolveCatalogCategories：保留中文 category 兼容老客户端，并生成标准英文 slug categoryId', () => {
  // 中文枚举自动推导英文 slug
  assert.deepEqual(
    resolveCatalogCategories({ category: ['开发工具', '办公效率'] }),
    { category: ['开发工具', '办公效率'], categoryId: ['developer', 'productivity'] }
  )

  // 纯英文 slug 的 category 自动补回中文标签，保证老客户端兼容
  assert.deepEqual(
    resolveCatalogCategories({ category: ['security'] }),
    { category: ['安全隐私'], categoryId: ['security'] }
  )

  // 显式单字符串 categoryId 保留字符串形态
  assert.deepEqual(
    resolveCatalogCategories({ category: ['网络工具'], categoryId: 'network' }),
    { category: ['网络工具'], categoryId: 'network' }
  )

  // 显式数组 categoryId 去重归一化
  assert.deepEqual(
    resolveCatalogCategories({ category: ['文件管理', '系统工具'], categoryId: ['FILES', 'system'] }),
    { category: ['文件管理', '系统工具'], categoryId: ['files', 'system'] }
  )
})

test('2. buildPluginsRelease：透传 defaultLocale / categoryId / i18n，收集拷贝多语言截图并输出 CDN URL', async (t) => {
  const root = tmpTracker.mkdtemp('ztools-catalog-i18n-')
  t.after(() => tmpTracker.remove(root))
  const pluginsDir = path.join(root, 'plugins')
  const outputDir = path.join(root, 'out')

  const zhShot = makePng(1280, 800, 1)
  const enShot1 = makePng(1280, 800, 2)
  const enShot2 = makePng(1440, 900, 3)
  const jaShot = makePng(1024, 640, 4)

  // 官方插件 calculator（在 official-ids.json 名单中）
  writePlugin(
    pluginsDir,
    'official',
    'calculator',
    {
      name: '科学计算器',
      description: '支持表达式与单位换算的计算器',
      defaultLocale: 'zh-CN',
      category: ['办公效率', 'developer'],
      categoryId: ['productivity', 'developer'],
      keywords: ['计算器', '换算'],
      screenshots: [{ path: 'screenshots/01.png', title: '中文主界面' }],
      i18n: {
        'en-US': {
          name: 'Scientific Calculator',
          description: 'Fast expression evaluator and unit converter',
          keywords: ['calculator', 'math'],
          features: {
            calc: {
              explain: 'Evaluate math expressions',
              cmds: ['calc', '=']
            }
          },
          screenshots: [
            { file: 'screenshots/en-US/01.png', title: 'Main View' },
            { file: 'screenshots/en-US/02.png', title: 'History' }
          ]
        },
        ja: {
          name: '関数電卓',
          description: '数式計算と単位変換に対応',
          screenshots: [{ file: 'screenshots/ja/01.png', title: 'メイン画面' }]
        }
      }
    },
    {
      'screenshots/01.png': zhShot,
      'screenshots/en-US/01.png': enShot1,
      'screenshots/en-US/02.png': enShot2,
      'screenshots/ja/01.png': jaShot
    }
  )

  // 社区插件（单字符串 categoryId）
  writePlugin(pluginsDir, 'alice', 'demo-helper', {
    name: '效率助手',
    category: ['files'],
    categoryId: 'files',
    defaultLocale: 'en-US'
  })

  const res = await buildPluginsRelease({
    pluginsDir,
    outputDir,
    cdnBaseUrl: 'https://cdn.ztools.cn',
    urlPrefix: 'plugins-v2'
  })

  assert.equal(res.success, true)
  assert.equal(res.passedCount, 2)
  assert.equal(res.rejectedCount, 0)

  const catalog = JSON.parse(fs.readFileSync(path.join(outputDir, 'catalog.json'), 'utf8'))
  const pluginsJson = JSON.parse(fs.readFileSync(path.join(outputDir, 'plugins.json'), 'utf8'))
  assert.deepEqual(catalog.plugins, pluginsJson.plugins)

  const calc = catalog.plugins.find((p) => p.id === 'calculator')
  assert.ok(calc)
  // category 保持中文向后兼容老客户端，categoryId 平行提供标准英文 slug
  assert.deepEqual(calc.category, ['办公效率', '开发工具'])
  assert.deepEqual(calc.categoryId, ['productivity', 'developer'])
  assert.equal(calc.defaultLocale, 'zh-CN')
  assert.equal(calc.is_official, true)

  // 默认截图 + 多语言截图 CDN URL 与磁盘产物校验
  const zhCdn = screenshotCdnName('1.2.0', 0, sha256Hex(zhShot))
  const enCdn1 = screenshotCdnName('1.2.0', 0, sha256Hex(enShot1), 'en-US')
  const enCdn2 = screenshotCdnName('1.2.0', 1, sha256Hex(enShot2), 'en-US')
  const jaCdn = screenshotCdnName('1.2.0', 0, sha256Hex(jaShot), 'ja')

  assert.equal(enCdn1, `screenshots/1.2.0/en-US/01-${sha256Hex(enShot1).slice(0, 8)}.png`)
  assert.equal(jaCdn, `screenshots/1.2.0/ja/01-${sha256Hex(jaShot).slice(0, 8)}.png`)

  assert.deepEqual(calc.screenshots, [
    { url: `https://cdn.ztools.cn/plugins-v2/official/calculator/${zhCdn}`, title: '中文主界面', width: 1280, height: 800 }
  ])
  assert.deepEqual(calc.i18n['en-US'], {
    name: 'Scientific Calculator',
    description: 'Fast expression evaluator and unit converter',
    keywords: ['calculator', 'math'],
    features: {
      calc: { explain: 'Evaluate math expressions', cmds: ['calc', '='] }
    },
    screenshots: [
      { url: `https://cdn.ztools.cn/plugins-v2/official/calculator/${enCdn1}`, title: 'Main View', width: 1280, height: 800 },
      { url: `https://cdn.ztools.cn/plugins-v2/official/calculator/${enCdn2}`, title: 'History', width: 1440, height: 900 }
    ]
  })
  assert.deepEqual(calc.i18n.ja, {
    name: '関数電卓',
    description: '数式計算と単位変換に対応',
    screenshots: [
      { url: `https://cdn.ztools.cn/plugins-v2/official/calculator/${jaCdn}`, title: 'メイン画面', width: 1024, height: 640 }
    ]
  })

  // 确认多语言截图已落盘到产物目录，且 ZIP 包不包含 screenshots/
  assert.deepEqual(fs.readFileSync(path.join(outputDir, 'official/calculator', enCdn1)), enShot1)
  assert.deepEqual(fs.readFileSync(path.join(outputDir, 'official/calculator', enCdn2)), enShot2)
  assert.deepEqual(fs.readFileSync(path.join(outputDir, 'official/calculator', jaCdn)), jaShot)
  const zipBuf = fs.readFileSync(path.join(outputDir, 'official/calculator/calculator-1.2.0.zip'))
  assert.equal(zipBuf.includes(Buffer.from('screenshots/')), false, 'ZIP 安装包严禁打入多语言截图')

  // 社区插件单字符串 categoryId 与非官方标记
  const helper = catalog.plugins.find((p) => p.id === 'demo-helper')
  assert.ok(helper)
  assert.deepEqual(helper.category, ['文件管理'])
  assert.equal(helper.categoryId, 'files')
  assert.equal(helper.defaultLocale, 'en-US')
  assert.equal(helper.is_official, false)
  assert.equal(helper.i18n, undefined)
})

test('3. buildPluginsRelease：revoked 插件输出 revokedCode 与可选多语言原因，且保留兼容字段', async (t) => {
  const root = tmpTracker.mkdtemp('ztools-revoked-i18n-')
  t.after(() => tmpTracker.remove(root))
  const pluginsDir = path.join(root, 'plugins')
  const outputDir = path.join(root, 'out')

  writePlugin(pluginsDir, 'community', 'retired-plugin', {
    name: '已停用插件',
    version: '2.0.0',
    defaultLocale: 'zh-CN',
    revoked: true,
    revokedReason: '存在安全风险，已官方下架',
    i18n: {
      'en-US': {
        name: 'Retired Plugin',
        description: 'Deprecated tool',
        revokedReason: 'Removed due to security issue'
      }
    }
  })

  const res = await buildPluginsRelease({ pluginsDir, outputDir, cdnBaseUrl: 'https://cdn.ztools.cn' })
  assert.equal(res.success, true)
  assert.equal(res.publishedPackages.length, 0)

  const catalog = JSON.parse(fs.readFileSync(path.join(outputDir, 'catalog.json'), 'utf8'))
  const item = catalog.plugins.find((p) => p.id === 'retired-plugin')
  assert.equal(item.revoked, true)
  assert.equal(item.revokedCode, 'OFFICIAL_REVOKED')
  assert.equal(item.revokedReason, '存在安全风险，已官方下架')
  assert.equal(item.revoked_reason, '存在安全风险，已官方下架')
  assert.equal(item.defaultLocale, 'zh-CN')
  assert.deepEqual(item.i18n, {
    'en-US': {
      name: 'Retired Plugin',
      description: 'Deprecated tool',
      revokedReason: 'Removed due to security issue'
    }
  })
})

test('4. [破坏性] 多语言截图缺失、伪造 PNG、路径穿越或超量时拒绝发布，不产出脏产物', async (t) => {
  const cases = [
    [
      'missing',
      { i18n: { 'en-US': { screenshots: [{ file: 'screenshots/en-US/missing.png', title: 'Missing' }] } } },
      {},
      /不存在/
    ],
    [
      'fake-png',
      { i18n: { 'en-US': { screenshots: [{ file: 'screenshots/en-US/01.png', title: 'Fake' }] } } },
      { 'screenshots/en-US/01.png': Buffer.from('not-a-png') },
      /不是有效的 PNG/
    ],
    [
      'traversal',
      { i18n: { 'en-US': { screenshots: [{ file: '../escape.png', title: 'Escape' }] } } },
      {},
      /不合法/
    ],
    [
      'bad-locale',
      { i18n: { en_US: { screenshots: [{ file: 'screenshots/en/01.png', title: 'BadLocale' }] } } },
      { 'screenshots/en/01.png': makePng(800, 600) },
      /语言标签格式不合法/
    ]
  ]

  for (const [caseName, manifestPatch, files, pattern] of cases) {
    const root = tmpTracker.mkdtemp(`ztools-bad-i18n-shot-${caseName}-`)
    t.after(() => tmpTracker.remove(root))
    const pluginsDir = path.join(root, 'plugins')
    const outputDir = path.join(root, 'out')

    const badDir = writePlugin(pluginsDir, 'dev', `bad-${caseName}`, manifestPatch, files)
    const manifest = JSON.parse(fs.readFileSync(path.join(badDir, 'plugin.json'), 'utf8'))
    const collected = collectPluginScreenshots(badDir, manifest)
    assert.match(collected.errors.join('\n'), pattern, caseName)

    const result = await buildPluginsRelease({ pluginsDir, outputDir, skipScan: true })
    assert.equal(result.success, false, caseName)
    assert.equal(result.rejectedCount, 1, caseName)
    assert.equal(fs.existsSync(path.join(outputDir, 'dev', `bad-${caseName}`)), false, `${caseName} 不得产出脏目录`)

    await assert.rejects(
      () => buildPluginsRelease({ pluginsDir, outputDir, skipScan: true, failFast: true }),
      /截图校验失败/
    )
  }
})

test('5. deploy-plugins-storage：多语言截图命中 30 天 immutable 强缓存，先于目录上传并刷新目录 CDN', async (t) => {
  // 缓存策略校验
  assert.equal(
    getCacheControl('official/calculator/screenshots/1.2.0/en-US/01-deadbeef.png'),
    'public, max-age=2592000, immutable'
  )
  assert.equal(
    getCacheControl('official/calculator/screenshots/1.2.0/zh-Hans-CN/02-01234567.png'),
    'public, max-age=2592000, immutable'
  )
  assert.equal(
    getCacheControl('official/calculator/screenshots/1.2.0/ja/01-89abcdef.png'),
    'public, max-age=2592000, immutable'
  )
  // 未带版本号与内容哈希的散落路径维持 7 天缓存
  assert.equal(
    getCacheControl('official/calculator/screenshots/en-US/01.png'),
    'public, max-age=604800'
  )

  // 端到端构建 + 本地模拟 OSS/CDN 上传校验
  const root = tmpTracker.mkdtemp('ztools-deploy-i18n-')
  t.after(() => tmpTracker.remove(root))
  const pluginsDir = path.join(root, 'plugins')
  const outputDir = path.join(root, 'out')

  const enShot = makePng(1280, 800, 9)
  writePlugin(
    pluginsDir,
    'official',
    'calculator',
    {
      i18n: {
        'en-US': {
          name: 'Calculator',
          screenshots: [{ file: 'screenshots/en-US/01.png', title: 'Main' }]
        }
      }
    },
    { 'screenshots/en-US/01.png': enShot }
  )

  await buildPluginsRelease({
    pluginsDir,
    outputDir,
    cdnBaseUrl: 'https://cdn.ztools.cn',
    urlPrefix: 'plugins-v2',
    skipScan: true
  })

  const puts = []
  const refreshes = []
  const secret = 'I18N_DEPLOY_SECRET'
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      if (req.method === 'GET' && !req.url.startsWith('/?')) {
        res.writeHead(404)
        return res.end('<Error><Code>NoSuchKey</Code></Error>')
      }
      if (req.method === 'PUT') {
        const key = decodeURIComponent(req.url.replace(/^\//, ''))
        puts.push({ key, cacheControl: req.headers['cache-control'], contentType: req.headers['content-type'] })
        res.writeHead(200)
        return res.end()
      }
      const url = new URL(req.url, 'http://127.0.0.1')
      const params = Object.fromEntries(url.searchParams)
      const { Signature, ...rest } = params
      const expectedSig = decodeURIComponent(signAliyunRpcQuery(rest, secret).split('&Signature=')[1])
      assert.equal(Signature, expectedSig)
      refreshes.push(params.ObjectPath.split('\n'))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ RefreshTaskId: 'task-i18n-1' }))
    })
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const endpoint = `http://127.0.0.1:${server.address().port}`
  try {
    const deployRes = await deployPluginsStorage({
      dir: outputDir,
      ossAccessKeyId: 'MOCK_KEY',
      ossAccessKeySecret: secret,
      ossBucket: 'test-bucket',
      ossRegion: 'oss-cn-hangzhou',
      ossEndpoint: endpoint,
      cdnEndpoint: endpoint,
      cdnBaseUrl: 'https://cdn.ztools.cn',
      ossPrefix: 'plugins-v2'
    })

    assert.equal(deployRes.success, true)
    const expectedShotKey = `plugins-v2/official/calculator/${screenshotCdnName('1.2.0', 0, sha256Hex(enShot), 'en-US')}`
    const shotPut = puts.find((p) => p.key === expectedShotKey)
    assert.ok(shotPut, `应上传多语言截图: ${expectedShotKey}`)
    assert.equal(shotPut.cacheControl, 'public, max-age=2592000, immutable')
    assert.equal(shotPut.contentType, 'image/png')

    const shotIdx = puts.findIndex((p) => p.key === expectedShotKey)
    const catalogIdx = puts.findIndex((p) => p.key === 'plugins-v2/catalog.json')
    const pluginsIdx = puts.findIndex((p) => p.key === 'plugins-v2/plugins.json')
    assert.ok(shotIdx >= 0 && shotIdx < catalogIdx && shotIdx < pluginsIdx, '多语言截图必须先于目录 JSON 上传')

    const refreshedFlat = refreshes.flat()
    assert.ok(refreshedFlat.includes('https://cdn.ztools.cn/plugins-v2/catalog.json'))
    assert.ok(refreshedFlat.includes('https://cdn.ztools.cn/plugins-v2/plugins.json'))
  } finally {
    await new Promise((r) => server.close(r))
  }
})

test('6. sync-plugins-to-backend：同步清单中的 categoryId、defaultLocale 与 i18n 到后台', async (t) => {
  assert.equal(resolveSyncCategoryId({}, { categoryId: 'developer' }, '系统工具'), 'developer')
  assert.deepEqual(
    resolveSyncCategoryId({}, { category: ['办公效率', '开发工具'] }, '办公效率'),
    ['productivity', 'developer']
  )
  assert.equal(resolveSyncCategoryId({}, {}, '安全工具'), 'security')
  assert.equal(sanitizeSyncI18n({ bad_locale: { name: 'Ignore' } }), undefined)

  const root = tmpTracker.mkdtemp('ztools-sync-i18n-')
  t.after(() => tmpTracker.remove(root))

  const pluginDir = path.join(root, 'plugins', 'json-format')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify({
      id: 'json-formatter',
      name: 'JSON 格式化',
      description: '快速格式化、校验与压缩 JSON 数据',
      version: '1.3.0',
      defaultLocale: 'zh-CN',
      category: ['开发工具'],
      categoryId: 'developer',
      i18n: {
        'en-US': {
          name: 'JSON Formatter',
          description: 'Format, validate and minify JSON offline',
          keywords: ['json', 'formatter'],
          features: {
            format: { explain: 'Format JSON', cmds: ['json'] }
          }
        },
        invalid_locale: {
          name: 'Should be filtered out'
        }
      }
    })
  )

  const seoMeta = buildPluginSeoMetadata(
    { pluginId: 'json-formatter', name: 'JSON 格式化', description: '快速格式化 JSON' },
    JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'))
  )
  assert.equal(seoMeta.categoryId, 'developer')
  assert.equal(seoMeta.defaultLocale, 'zh-CN')
  assert.deepEqual(seoMeta.i18n, {
    'en-US': {
      name: 'JSON Formatter',
      description: 'Format, validate and minify JSON offline',
      keywords: ['json', 'formatter'],
      features: {
        format: { explain: 'Format JSON', cmds: ['json'] }
      }
    }
  })

  const payload = await collectPluginSyncPayload({
    apiUrl: 'http://backend.test',
    rootDir: root,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        data: {
          list: [
            {
              pluginId: 'json-formatter',
              name: 'JSON 格式化',
              description: '快速格式化 JSON',
              category: '系统工具'
            }
          ]
        }
      })
    })
  })

  assert.equal(payload.length, 1)
  assert.equal(payload[0].categoryId, 'developer')
  assert.equal(payload[0].defaultLocale, 'zh-CN')
  assert.equal(payload[0].i18n['en-US'].name, 'JSON Formatter')
  assert.equal(payload[0].i18n.invalid_locale, undefined)
})
