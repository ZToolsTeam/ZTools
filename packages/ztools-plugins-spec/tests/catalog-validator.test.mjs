import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  validatePluginManifest,
  buildPlatformTargets,
  getManifestPlatforms,
  describePlatforms,
  validateCatalogPluginItem,
  validateStoreCatalog,
  PERMISSIONS,
  PLUGIN_CATEGORIES,
  PLUGIN_CATEGORY_IDS,
  HIGH_RISK_PERMISSIONS,
  OFFICIAL_PLUGIN_IDS,
  isOfficialAuthorName
} from '../src/validator.js'

describe('Store Catalog & Plugin Item Validator (Beyond Happy Path)', () => {
  describe('validateCatalogPluginItem', () => {
    it('Happy Case: 应该通过合法的插件条目', () => {
      const validItem = {
        id: 'everything-search',
        name: '文件秒搜',
        version: '1.2.0',
        author: 'ztools',
        description: '基于 NTFS MFT 的百万级文件检索',
        downloadUrl: 'https://cdn.ztools.top/plugins/ztools/everything-search/everything-search-1.2.0.zip',
        sha256: 'a'.repeat(64),
        size: 102400,
        revoked: false
      }
      const result = validateCatalogPluginItem(validItem)
      assert.equal(result.valid, true)
      assert.equal(result.errors.length, 0)
    })

    it('异常测试: 非对象与空值拦截', () => {
      assert.equal(validateCatalogPluginItem(null).valid, false)
      assert.equal(validateCatalogPluginItem(undefined).valid, false)
      assert.equal(validateCatalogPluginItem('string').valid, false)
      assert.equal(validateCatalogPluginItem([]).valid, false)
    })

    it('异常测试: 非法 ID（包含大写、特殊字符、空或越界）', () => {
      const badIds = ['', ' ', 'Invalid_ID', 'plugin@123', 'a'.repeat(65), '123start-with-number']
      for (const id of badIds) {
        const res = validateCatalogPluginItem({
          id,
          name: '测试',
          version: '1.0.0'
        })
        assert.equal(res.valid, false, `ID "${id}" 应被判定为无效`)
        assert.ok(res.errors.some((e) => e.includes('Invalid plugin id')))
      }
    })

    it('异常测试: 非法版本号（非 Semver）', () => {
      const badVersions = ['v1.0', '1.0', 'latest', '1.0.0.0', 'alpha', '']
      for (const version of badVersions) {
        const res = validateCatalogPluginItem({
          id: 'test-plugin',
          name: '测试',
          version
        })
        assert.equal(res.valid, false, `version "${version}" 应被判定为无效`)
        assert.ok(res.errors.some((e) => e.includes('SemVer')))
      }
    })

    it('异常测试: 非法 downloadUrl（协议不安全或格式畸形）', () => {
      const badUrls = ['ftp://files.example.com/p.zip', 'file:///C:/test.zip', 'javascript:alert(1)', 'not-a-url', '']
      for (const downloadUrl of badUrls) {
        const res = validateCatalogPluginItem({
          id: 'test-plugin',
          name: '测试',
          version: '1.0.0',
          downloadUrl
        })
        assert.equal(res.valid, false, `URL "${downloadUrl}" 应被判定为无效`)
        assert.ok(res.errors.some((e) => e.includes('downloadUrl')))
      }
    })

    it('异常测试: 非法 sha256 校验和（非 64 位、包含非十六进制、空等）', () => {
      const badSha = ['abc', 'a'.repeat(63), 'g'.repeat(64), '123456', '']
      for (const sha256 of badSha) {
        const res = validateCatalogPluginItem({
          id: 'test-plugin',
          name: '测试',
          version: '1.0.0',
          sha256
        })
        assert.equal(res.valid, false, `sha256 "${sha256}" 应被判定为无效`)
        assert.ok(res.errors.some((e) => e.includes('sha256')))
      }
    })

    it('异常测试: 非法包体 size（0、负数、浮点数、非整型）', () => {
      const badSizes = [0, -100, 10.5, NaN, Infinity, '1024']
      for (const size of badSizes) {
        const res = validateCatalogPluginItem({
          id: 'test-plugin',
          name: '测试',
          version: '1.0.0',
          size
        })
        assert.equal(res.valid, false, `size "${size}" 应被判定为无效`)
        assert.ok(res.errors.some((e) => e.includes('size')))
      }
    })

    it('异常测试: 非布尔类型的 revoked 状态', () => {
      const res = validateCatalogPluginItem({
        id: 'test-plugin',
        name: '测试',
        version: '1.0.0',
        revoked: 'true'
      })
      assert.equal(res.valid, false)
      assert.ok(res.errors.some((e) => e.includes('revoked')))
    })

    it('Happy Case: 支持校验合法的 defaultLocale、categoryId 与多语言 i18n（含目录截图）', () => {
      const validItem = {
        id: 'i18n-catalog-demo',
        name: '多语言目录插件',
        version: '1.0.0',
        defaultLocale: 'zh-CN',
        categoryId: ['files', 'productivity'],
        features: [{ code: 'inspect', explain: '查看内容' }],
        i18n: {
          'en-US': {
            name: 'Multilingual Catalog Plugin',
            description: 'Catalog entry with localized metadata and screenshots',
            keywords: ['i18n', 'catalog'],
            features: {
              inspect: { explain: 'Inspect contents', cmds: ['inspect'] }
            },
            screenshots: [
              {
                url: 'https://cdn.ztools.cn/plugins-v2/dev/i18n-catalog-demo/screenshots/1.0.0/en-US/01-12345678.png',
                title: 'Main View',
                width: 1280,
                height: 800
              }
            ]
          }
        }
      }
      const res = validateCatalogPluginItem(validItem)
      assert.equal(res.valid, true, res.errors.join('; '))
      assert.equal(validateCatalogPluginItem({ ...validItem, categoryId: 'developer' }).valid, true)
    })

    it('异常测试: 拦截非法的 defaultLocale、categoryId 与 i18n 结构及目录截图', () => {
      const badItem = {
        id: 'i18n-catalog-bad',
        name: '错误多语言插件',
        version: '1.0.0',
        defaultLocale: 'zh_CN',
        categoryId: ['developer', 'unknown-cat'],
        features: [{ code: 'real-code', explain: '真实命令' }],
        i18n: {
          en_US: {
            name: '   ',
            description: '',
            extraKey: true,
            keywords: [''],
            features: {
              'wrong-code': { explain: '' }
            },
            screenshots: [
              { url: 'http://insecure.example.com/01.png', width: 800, height: 600 }
            ]
          }
        }
      }
      const res = validateCatalogPluginItem(badItem)
      assert.equal(res.valid, false)
      assert.ok(res.errors.some((e) => e.includes('Invalid defaultLocale format')))
      assert.ok(res.errors.some((e) => e.includes('Unknown or non-standard categoryId')))
      assert.ok(res.errors.some((e) => e.includes('Invalid i18n locale tag')))
      assert.ok(res.errors.some((e) => e.includes('contains unknown fields: extraKey')))
      assert.ok(res.errors.some((e) => e.includes('.name must be a non-empty string')))
      assert.ok(res.errors.some((e) => e.includes('.description must be a non-empty string')))
      assert.ok(res.errors.some((e) => e.includes('not present in top-level manifest.features')))
      assert.ok(res.errors.some((e) => e.includes('screenshots[0]')))
      assert.equal(validateCatalogPluginItem({ id: 'bad-root', name: '测试', version: '1.0.0', i18n: ['en-US'] }).valid, false)
    })
  })

  describe('validateStoreCatalog', () => {
    it('Happy Case: 应该通过合法的全量 Catalog 索引并统计 revoked 数量', () => {
      const catalog = {
        schemaVersion: '1.0.0',
        generatedAt: new Date().toISOString(),
        plugins: [
          {
            id: 'calculator',
            name: '计算器',
            version: '1.0.0',
            downloadUrl: 'https://cdn.ztools.top/calculator.zip',
            sha256: 'b'.repeat(64),
            size: 2048,
            revoked: false
          },
          {
            id: 'malicious-tool',
            name: '恶意测试工具',
            version: '0.9.0',
            downloadUrl: 'https://cdn.ztools.top/malicious.zip',
            sha256: 'c'.repeat(64),
            size: 4096,
            revoked: true,
            revokedReason: '存在原型链逃逸风险，已被官方下架'
          }
        ]
      }
      const result = validateStoreCatalog(catalog)
      assert.equal(result.valid, true)
      assert.equal(result.totalValid, 2)
      assert.equal(result.revokedCount, 1)
      assert.equal(result.errors.length, 0)
    })

    it('异常测试: Catalog 顶层结构缺失或 plugins 非数组', () => {
      assert.equal(validateStoreCatalog(null).valid, false)
      assert.equal(validateStoreCatalog({}).valid, false)
      assert.equal(validateStoreCatalog({ plugins: 'not-array' }).valid, false)
    })

    it('异常测试: 包含重复 ID 的插件条目', () => {
      const catalogWithDuplicates = {
        schemaVersion: '1.0.0',
        plugins: [
          {
            id: 'duplicate-app',
            name: '应用 A',
            version: '1.0.0'
          },
          {
            id: 'duplicate-app',
            name: '应用 B (重复 ID)',
            version: '2.0.0'
          }
        ]
      }
      const result = validateStoreCatalog(catalogWithDuplicates)
      assert.equal(result.valid, false)
      assert.ok(result.errors.some((e) => e.includes('duplicate plugin ID')))
    })

    it('混合容错测试: 部分条目损坏时的精准定位与统计', () => {
      const mixedCatalog = {
        schemaVersion: '1.0.0',
        plugins: [
          { id: 'valid-one', name: '有效应用', version: '1.0.0' },
          { id: 'INVALID ID', name: '损坏应用', version: 'bad-ver' },
          { id: 'valid-two', name: '有效应用2', version: '1.1.0' }
        ]
      }
      const result = validateStoreCatalog(mixedCatalog)
      assert.equal(result.valid, false)
      assert.equal(result.totalValid, 2)
      assert.equal(result.errors.length, 1)
      assert.ok(result.errors[0].includes('plugins[1] validation failed'))
    })
  })

  describe('validatePluginManifest & Platform Helpers', () => {
    it('process 权限（结束本机任意进程）可声明；JSON Schema 枚举与校验器权限列表保持一致', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-spec-test-'))
      try {
        fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true })
        fs.writeFileSync(path.join(tmpDir, 'dist/index.js'), 'export default {}')
        fs.writeFileSync(path.join(tmpDir, 'icon.png'), 'png')
        const manifest = {
          id: 'port-manager',
          name: '端口管理',
          version: '1.0.2',
          description: '结束占用端口的进程',
          author: { name: 'Plugin Dev' },
          category: ['网络工具', '系统工具'],
          entry: 'dist/index.js',
          icon: 'icon.png',
          permissions: ['system', 'process'],
          targets: buildPlatformTargets(['windows', 'macos']),
          nativeComponents: [],
          mode: 'view'
        }
        const res = validatePluginManifest(manifest, { baseDir: tmpDir })
        assert.equal(res.valid, true, res.errors.join('; '))
        // 大小写不同的近似名不算
        const typo = validatePluginManifest({ ...manifest, permissions: ['Process'] }, { baseDir: tmpDir })
        assert.ok(typo.errors.some((e) => e.includes('Unknown permission')))
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
      const schema = JSON.parse(fs.readFileSync(new URL('../plugin.schema.json', import.meta.url), 'utf8'))
      assert.deepEqual([...schema.properties.permissions.items.enum].sort(), [...PERMISSIONS].sort())
      assert.ok(HIGH_RISK_PERMISSIONS.has('process'))
    })

    it('Happy Case: 校验合法的 plugin.json 与跨平台 targets', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-spec-test-'))
      try {
        fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true })
        fs.writeFileSync(path.join(tmpDir, 'dist/index.js'), 'export default {}')
        fs.writeFileSync(path.join(tmpDir, 'icon.png'), 'png')

        const targets = buildPlatformTargets(['windows', 'macos'])
        const manifest = {
          id: 'demo-plugin',
          name: '演示插件',
          version: '1.0.0',
          description: '标准跨平台插件',
          author: { name: 'Plugin Dev' },
          category: ['办公效率'],
          entry: 'dist/index.js',
          icon: 'icon.png',
          permissions: ['clipboard', 'network'],
          targets,
          nativeComponents: [],
          mode: 'view',
          features: [{ code: 'demo', explain: '打开演示', mode: 'view' }]
        }

        const res = validatePluginManifest(manifest, { baseDir: tmpDir })
        assert.equal(res.valid, true, res.errors.join('; '))
        assert.deepEqual(getManifestPlatforms(manifest), ['windows', 'macos'])
        assert.equal(describePlatforms(['windows', 'macos']), 'Cross-platform')
        assert.equal(describePlatforms(['windows']), 'Windows only')
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('mode 只接受客户端已实现的 view / no-view：menu-bar 与大小写变体被拒绝，Schema 枚举与校验器一致', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-spec-test-'))
      try {
        fs.mkdirSync(path.join(tmpDir, 'dist'), { recursive: true })
        fs.writeFileSync(path.join(tmpDir, 'dist/index.js'), 'export default {}')
        fs.writeFileSync(path.join(tmpDir, 'icon.png'), 'png')
        const manifest = {
          id: 'mode-plugin',
          name: '模式插件',
          version: '1.0.0',
          description: '校验 mode 取值',
          author: { name: 'Plugin Dev' },
          category: ['开发工具'],
          entry: 'dist/index.js',
          icon: 'icon.png',
          permissions: [],
          targets: buildPlatformTargets(['windows', 'macos']),
          nativeComponents: []
        }
        for (const mode of ['view', 'no-view']) {
          const ok = validatePluginManifest({ ...manifest, mode, features: [{ code: 'a', explain: '命令', mode }] }, { baseDir: tmpDir })
          assert.equal(ok.valid, true, ok.errors.join('; '))
        }
        for (const mode of ['menu-bar', 'Menu-Bar', 'VIEW', '', 1, null]) {
          const top = validatePluginManifest({ ...manifest, mode }, { baseDir: tmpDir })
          assert.equal(top.valid, false, `顶层 mode=${JSON.stringify(mode)} 应被拒绝`)
          assert.ok(top.errors.some((e) => e.startsWith('mode must be one of: view, no-view')), top.errors.join('; '))
          const feat = validatePluginManifest({ ...manifest, features: [{ code: 'a', explain: '命令', mode }] }, { baseDir: tmpDir })
          assert.equal(feat.valid, false, `features[0].mode=${JSON.stringify(mode)} 应被拒绝`)
          assert.ok(feat.errors.some((e) => e.startsWith('features[0].mode must be one of')), feat.errors.join('; '))
        }
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
      const schema = JSON.parse(fs.readFileSync(new URL('../plugin.schema.json', import.meta.url), 'utf8'))
      assert.deepEqual(schema.properties.mode.enum, ['view', 'no-view'])
      assert.deepEqual(schema.properties.features.items.properties.mode.enum, ['view', 'no-view'])
    })

    it('安全与边界拦截: 拦截 entry/icon/main 路径穿越、非法权限与缺失 targets', () => {
      const badManifest = {
        id: 'evil-plugin',
        name: '恶意插件',
        version: '1.0.0',
        description: '测试路径穿越与非法权限',
        author: 'attacker',
        entry: '../../etc/passwd.js',
        icon: '../outside.png',
        main: '../../evil.js',
        permissions: ['root-access', 'clipboard', 'clipboard'],
        mode: 'invalid-mode'
      }
      const res = validatePluginManifest(badManifest)
      assert.equal(res.valid, false)
      assert.ok(res.errors.some((e) => e.includes('Invalid entry path')))
      assert.ok(res.errors.some((e) => e.includes('Invalid icon path')))
      assert.ok(res.errors.some((e) => e.includes('Invalid main path')))
      assert.ok(res.errors.some((e) => e.includes('Unknown permission')))
      assert.ok(res.errors.some((e) => e.includes('Duplicate permission')))
      assert.ok(res.errors.some((e) => e.includes('Missing required field: targets')))
      assert.ok(res.errors.some((e) => e.includes('Missing required field: category')))
    })

    it('category 只接受 1-2 个标准 7 大分类（中文名或英文 slug），拒绝漏填、非数组、重复、其他工具或非标英文别名；已下架条目豁免', () => {
      const schema = JSON.parse(fs.readFileSync(new URL('../plugin.schema.json', import.meta.url), 'utf8'))
      assert.ok(schema.required.includes('category'))
      assert.deepEqual(schema.properties.category.items.enum, [...PLUGIN_CATEGORIES, ...PLUGIN_CATEGORY_IDS])

      const base = {
        id: 'cat-test',
        name: '分类测试',
        version: '1.0.0',
        description: '测试分类白名单',
        author: 'dev',
        entry: 'index.js',
        icon: 'icon.svg',
        permissions: [],
        targets: buildPlatformTargets(['windows']),
        nativeComponents: []
      }
      for (const cat of [...PLUGIN_CATEGORIES, ...PLUGIN_CATEGORY_IDS]) {
        assert.equal(validatePluginManifest({ ...base, category: [cat] }).valid, true, cat)
      }
      assert.equal(validatePluginManifest({ ...base, category: ['文件管理', '系统工具'], categoryId: ['files', 'system'] }).valid, true)
      assert.equal(validatePluginManifest({ ...base, category: ['developer'], categoryId: 'developer' }).valid, true)
      assert.equal(validatePluginManifest({ ...base, revoked: true, revokedReason: '下架' }).valid, true)

      for (const bad of [undefined, null, '', '系统工具', [], ['办公效率', '系统工具', '开发工具'], ['办公效率', '办公效率'], ['开发工具', 'developer'], ['其他工具'], ['utility'], ['效率工具'], ['AI工具'], ['金融理财']]) {
        const res = validatePluginManifest({ ...base, category: bad })
        assert.equal(res.valid, false, `category=${JSON.stringify(bad)} 应被拦截`)
      }
    })

    it('i18n.features 交叉校验：必须全部存在于顶层 manifest.features 中，顶层未定义 features 时拒绝声明 i18n.features', () => {
      const base = {
        id: 'i18n-feat-check',
        name: '功能翻译校验',
        version: '1.0.0',
        description: '校验 i18n.features 与顶层 features 的对应关系',
        author: 'dev',
        category: ['开发工具'],
        categoryId: 'developer',
        defaultLocale: 'zh-CN',
        entry: 'dist/index.js',
        icon: 'icon.svg',
        permissions: [],
        targets: buildPlatformTargets(['windows']),
        nativeComponents: []
      }

      // 1. 顶层与 i18n.features 精确匹配 -> 通过
      const ok = validatePluginManifest({
        ...base,
        features: [
          { code: 'open-main', explain: '打开主界面' },
          { code: 'quick-copy', explain: '快速复制' }
        ],
        i18n: {
          'en-US': {
            name: 'Feature I18n Check',
            description: 'Validate feature translation keys',
            features: {
              'open-main': { explain: 'Open Main View', cmds: ['open'] }
            }
          }
        }
      })
      assert.equal(ok.valid, true, ok.errors.join('; '))

      // 2. 写错 code -> 报错
      const typoCode = validatePluginManifest({
        ...base,
        features: [{ code: 'open-main', explain: '打开主界面' }],
        i18n: {
          'en-US': {
            features: {
              'open-mian': { explain: 'Typo Code' }
            }
          }
        }
      })
      assert.equal(typoCode.valid, false)
      assert.ok(typoCode.errors.some((e) => e.includes('open-mian') && e.includes('not present in top-level manifest.features')))

      // 3. 顶层没有 features 却声明了 i18n[loc].features -> 报错
      const missingTop = validatePluginManifest({
        ...base,
        i18n: {
          'en-US': {
            features: {
              main: { explain: 'Main Command' }
            }
          }
        }
      })
      assert.equal(missingTop.valid, false)
      assert.ok(missingTop.errors.some((e) => e.includes('top-level features is not defined')))
    })
  })

  describe('官方名单与官方作者名', () => {
    const base = { name: '测试', version: '1.0.0', description: '测试', category: ['办公效率'], entry: 'dist/index.js', icon: 'icon.svg', permissions: [], targets: buildPlatformTargets(['windows']), nativeComponents: [] }
    const authorErrors = (manifest) => validatePluginManifest(manifest).errors.filter((e) => e.includes('official name'))

    it('名单来自 official-ids.json：109 个 ID、无重复、格式合法', () => {
      const raw = JSON.parse(fs.readFileSync(new URL('../official-ids.json', import.meta.url), 'utf8'))
      assert.equal(raw.ids.length, 109)
      assert.equal(new Set(raw.ids).size, raw.ids.length)
      assert.deepEqual([...raw.ids].sort(), raw.ids, '名单按字母排序，方便审核 diff')
      for (const id of raw.ids) assert.match(id, /^[a-z][a-z0-9-]{1,63}$/, id)
      assert.equal(OFFICIAL_PLUGIN_IDS.size, 109)
    })

    it('官方作者名识别：大小写、空格、连字符变体都算；ZTools Community、普通名字不算', () => {
      for (const a of ['ZTools Team', 'ztools-team', ' ZTOOLS_TEAM ', 'ZTools', 'ZTools 官方', '官方', 'ZTools Official Team', 'Official', { name: 'ZTools Team' }, 'ZTools 团队']) {
        assert.equal(isOfficialAuthorName(a), true, JSON.stringify(a))
      }
      for (const a of ['ZTools Community', 'Plugin Dev', 'alice', 'ztools-fan-club', '', '   ', null, undefined, 42, {}, { name: 7 }]) {
        assert.equal(isOfficialAuthorName(a), false, JSON.stringify(a))
      }
    })

    it('名单外的插件用官方作者名被拒；名单内允许；已下架的历史条目不受影响', () => {
      assert.equal(authorErrors({ ...base, id: 'my-tool', author: 'ZTools Team' }).length, 1)
      assert.equal(authorErrors({ ...base, id: 'my-tool', author: { name: 'ZTools 官方' } }).length, 1)
      assert.equal(authorErrors({ ...base, id: 'my-tool', author: 'Plugin Dev' }).length, 0)
      assert.equal(authorErrors({ ...base, id: 'my-tool', author: 'ZTools Community' }).length, 0)
      const listed = [...OFFICIAL_PLUGIN_IDS][0]
      assert.equal(authorErrors({ ...base, id: listed, author: 'ZTools Team' }).length, 0)
      assert.equal(authorErrors({ ...base, id: 'retired-unlisted', author: 'ZTools Team', revoked: true, revokedReason: '已下架' }).length, 0)
      assert.equal(authorErrors({ ...base, id: 'retired-unlisted', author: 'ZTools Team', revoked: false }).length, 1, 'revoked 必须是 true 才豁免')
    })
  })
})
