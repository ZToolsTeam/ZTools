import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  validatePluginManifest,
  pluginSchema,
  PERMISSIONS,
  HIGH_RISK_PERMISSIONS,
  buildPlatformTargets,
  getManifestPlatforms,
  describePlatforms,
  DECLARATIVE_RUNTIME_NODE_MODULES
} from '../packages/ztools-plugins-spec/src/index.js'
import { scanPluginSecurity, scanCodeSnippet } from '../scripts/scan-plugin-security.mjs'
import { buildPluginsRelease } from '../scripts/build-plugins-release.mjs'
import { deployPluginsStorage, getCacheControl } from '../scripts/deploy-plugins-storage.mjs'
import { generateFixtures } from '../scripts/create-test-fixtures.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const fixturesDir = path.join(rootDir, 'tests/fixtures/plugins')

// 确保测试样本准备完毕
generateFixtures()

describe('ZTools GitOps 规范与安全扫描自测套件', () => {

  describe('1. Manifest Schema 与规范强校验 (packages/ztools-plugins-spec)', () => {
    it('应加载并导出合法的 plugin.schema.json', () => {
      assert.ok(pluginSchema, 'pluginSchema 应该存在')
      assert.equal(pluginSchema.title, 'ZTools Plugin Manifest Specification')
      assert.ok(pluginSchema.required.includes('id'))
      assert.ok(pluginSchema.required.includes('permissions'))
    })

    it('合法的 manifest 应通过校验', () => {
      const valid = {
        id: 'test-plugin',
        name: '测试插件',
        version: '1.0.0',
        description: '这是一个合规插件',
        author: 'developer',
        entry: 'index.html',
        icon: 'icon.png',
        permissions: ['clipboard', 'dialog'],
        targets: buildPlatformTargets(['windows', 'macos']),
        nativeComponents: []
      }
      const res = validatePluginManifest(valid)
      assert.equal(res.valid, true)
      assert.equal(res.errors.length, 0)
    })

    it('缺少必填字段（如 permissions, entry 等）必须被拦截', () => {
      const invalid = {
        id: 'test-plugin',
        name: '测试插件',
        version: '1.0.0'
        // 缺少 description, author, entry, icon, permissions
      }
      const res = validatePluginManifest(invalid)
      assert.equal(res.valid, false)
      assert.ok(res.errors.some(e => e.includes('缺少必填字段: permissions')))
      assert.ok(res.errors.some(e => e.includes('缺少必填字段: entry')))
      assert.ok(res.errors.some(e => e.includes('缺少必填字段: icon')))
    })

    it('非法 id 格式必须被拦截', () => {
      const invalidId = {
        id: '123_INVALID',
        name: '测试',
        version: '1.0.0',
        description: '测试',
        author: 'dev',
        entry: 'index.html',
        icon: 'icon.png',
        permissions: []
      }
      const res = validatePluginManifest(invalidId)
      assert.equal(res.valid, false)
      assert.ok(res.errors.some(e => e.includes('id 字段格式不符合规范')))
    })

    it('id 不能与客户端内置功能重名（否则客户端会隐藏插件）；已下架的历史条目不受影响', () => {
      const base = { name: '测试', version: '1.0.0', description: '测试', author: 'dev', entry: 'index.html', icon: 'icon.png', permissions: [] }
      const hit = validatePluginManifest({ ...base, id: 'github' })
      assert.ok(hit.errors.some(e => e.includes('与客户端内置功能重名')))
      const revoked = validatePluginManifest({ ...base, id: 'github', revoked: true, revokedReason: '已下架' })
      assert.ok(!revoked.errors.some(e => e.includes('与客户端内置功能重名')))
      assert.ok(!validatePluginManifest({ ...base, id: 'my-github' }).errors.some(e => e.includes('与客户端内置功能重名')))
    })

    it('id 不允许下划线（与插件编译脚本一致，避免清单校验通过却编译失败）', () => {
      for (const id of ['my_tool', 'a_b-c']) {
        const res = validatePluginManifest({ id, name: '测试', version: '1.0.0', description: '测试', author: 'dev', entry: 'index.html', icon: 'icon.png', permissions: [] })
        assert.ok(res.errors.some(e => e.includes('id 字段格式不符合规范')), id)
      }
      const ok = validatePluginManifest({ id: 'my-tool', name: '测试', version: '1.0.0', description: '测试', author: 'dev', entry: 'index.html', icon: 'icon.png', permissions: [] })
      assert.ok(!ok.errors.some(e => e.includes('id 字段格式不符合规范')))
    })

    it('未知的权限名称必须被拦截', () => {
      const invalidPerm = {
        id: 'test-plugin',
        name: '测试',
        version: '1.0.0',
        description: '测试',
        author: 'dev',
        entry: 'index.html',
        icon: 'icon.png',
        permissions: ['clipboard', 'invalid_hack_permission']
      }
      const res = validatePluginManifest(invalidPerm)
      assert.equal(res.valid, false)
      assert.ok(res.errors.some(e => e.includes('未知的权限声明: "invalid_hack_permission"')))
    })

    it('路径穿越攻击必须被拦截 (Directory Traversal)', () => {
      const traversal = {
        id: 'test-plugin',
        name: '测试',
        version: '1.0.0',
        description: '测试',
        author: 'dev',
        entry: '../../etc/passwd.html',
        icon: '../icons/evil.png',
        permissions: []
      }
      const res = validatePluginManifest(traversal)
      assert.equal(res.valid, false)
      assert.ok(res.errors.some(e => e.includes('entry 路径不合法')))
      assert.ok(res.errors.some(e => e.includes('icon 路径不合法')))
    })
  })

  describe('2. 安全 AST 扫描器门禁拦截 (scripts/scan-plugin-security.mjs)', () => {
    it('样本 1: 必须拦截动态 eval()', async () => {
      const pluginDir = path.join(fixturesDir, 'malicious-eval')
      const result = await scanPluginSecurity(pluginDir)
      assert.equal(result.passed, false, 'malicious-eval 应当未通过扫描')
      const violation = result.violations.find(v => v.rule === 'BANNED_DYNAMIC_EVAL')
      assert.ok(violation, '必须检测到 BANNED_DYNAMIC_EVAL 违规')
      assert.equal(violation.severity, 'error')
    })

    it('样本 2: 必须拦截动态 new Function()', async () => {
      const pluginDir = path.join(fixturesDir, 'malicious-new-function')
      const result = await scanPluginSecurity(pluginDir)
      assert.equal(result.passed, false, 'malicious-new-function 应当未通过扫描')
      const violation = result.violations.find(v => v.rule === 'BANNED_DYNAMIC_FUNCTION')
      assert.ok(violation, '必须检测到 BANNED_DYNAMIC_FUNCTION 违规')
      assert.equal(violation.severity, 'error')
    })

    it('样本 3: 必须拦截十六进制字符串混淆', async () => {
      const pluginDir = path.join(fixturesDir, 'malicious-hex-obfuscated')
      const result = await scanPluginSecurity(pluginDir)
      assert.equal(result.passed, false, 'malicious-hex-obfuscated 应当未通过扫描')
      const violation = result.violations.find(v => v.rule === 'HEX_STRING_OBFUSCATION')
      assert.ok(violation, '必须检测到 HEX_STRING_OBFUSCATION 违规')
      assert.equal(violation.severity, 'error')
    })

    it('样本 4: 必须拦截未在 permissions 声明的 Node 原生模块 (fs)', async () => {
      const pluginDir = path.join(fixturesDir, 'unauthorized-fs')
      const result = await scanPluginSecurity(pluginDir)
      assert.equal(result.passed, false, 'unauthorized-fs 应当未通过扫描')
      const violation = result.violations.find(v => v.rule === 'UNAUTHORIZED_NODE_MODULE')
      assert.ok(violation, '必须检测到 UNAUTHORIZED_NODE_MODULE 违规')
      assert.ok(violation.message.includes('fs'), '违规信息应指明缺少 fs 权限')
    })

    it('样本 5: 合规声明高危敏感权限 (network) 应触发 Two-Man Rule 人工双人复核', async () => {
      const pluginDir = path.join(fixturesDir, 'sensitive-network')
      const result = await scanPluginSecurity(pluginDir)
      assert.equal(result.passed, true, '合规声明 network 权限的插件扫描应当通过')
      assert.equal(result.requiresTwoManReview, true, '必须标记触发 Two-Man Rule 门禁')
      assert.ok(result.twoManReviewReasons.length > 0)
      assert.ok(result.twoManReviewReasons.some(r => r.includes('network') || r.includes('fetch')))
    })

    it('样本 6: 纯净合规插件应顺利通过且不触发 Two-Man Rule', async () => {
      const pluginDir = path.join(fixturesDir, 'compliant-plugin')
      const result = await scanPluginSecurity(pluginDir)
      assert.equal(result.passed, true, 'compliant-plugin 应当完全通过')
      assert.equal(result.requiresTwoManReview, false, '纯净插件不应触发人工双人审查')
      assert.equal(result.violations.length, 0)
    })

    it('样本 7: 纯声明式架构门禁：必须拦截任何自定义 CSS/LESS/SCSS 样式文件', async () => {
      const tempPluginDir = path.join(rootDir, 'tests/fixtures/plugins/temp-style-file-violation')
      fs.mkdirSync(tempPluginDir, { recursive: true })
      fs.writeFileSync(path.join(tempPluginDir, 'plugin.json'), JSON.stringify({
        id: 'style-violator',
        name: '样式违规插件',
        version: '1.0.0',
        description: '测试违规引入 CSS 文件',
        author: 'dev',
        entry: 'index.js',
        icon: 'icon.png',
        permissions: [],
        targets: buildPlatformTargets(['windows', 'macos']),
        nativeComponents: []
      }, null, 2))
      fs.writeFileSync(path.join(tempPluginDir, 'index.js'), 'console.log("hello");')
      fs.writeFileSync(path.join(tempPluginDir, 'theme.css'), 'body { background: #000; }')
      fs.writeFileSync(path.join(tempPluginDir, 'custom.scss'), '$c: red; .btn { color: $c; }')

      try {
        const result = await scanPluginSecurity(tempPluginDir)
        assert.equal(result.passed, false, '包含 .css/.scss 的插件应当未通过扫描')
        const violations = result.violations.filter(v => v.rule === 'DISALLOWED_STYLE_FILE')
        assert.equal(violations.length, 2, '必须同时检测出 theme.css 与 custom.scss 两个样式文件违规')
        assert.ok(violations.some(v => v.file.includes('theme.css')))
        assert.ok(violations.some(v => v.file.includes('custom.scss')))
      } finally {
        fs.rmSync(tempPluginDir, { recursive: true, force: true })
      }
    })

    it('样本 8: 必须拦截 HTML 中内嵌的 <style> 标签与内联 style 属性', async () => {
      const tempPluginDir = path.join(rootDir, 'tests/fixtures/plugins/temp-inline-style-violation')
      fs.mkdirSync(tempPluginDir, { recursive: true })
      fs.writeFileSync(path.join(tempPluginDir, 'plugin.json'), JSON.stringify({
        id: 'inline-style-violator',
        name: '内联样式违规插件',
        version: '1.0.0',
        description: '测试 HTML 内嵌 style 标签与内联样式',
        author: 'dev',
        entry: 'index.html',
        icon: 'icon.png',
        permissions: [],
        targets: buildPlatformTargets(['windows', 'macos']),
        nativeComponents: []
      }, null, 2))
      fs.writeFileSync(
        path.join(tempPluginDir, 'index.html'),
        '<!DOCTYPE html><html><head><style>body { color: red; }</style></head><body><div style="font-size: 14px;">Hi</div></body></html>'
      )

      try {
        const result = await scanPluginSecurity(tempPluginDir)
        assert.equal(result.passed, false, '包含 <style> 和 style 属性的插件应当未通过扫描')
        const violations = result.violations.filter(v => v.rule === 'DISALLOWED_INLINE_STYLE')
        assert.ok(violations.length >= 2, '必须同时检测出 <style> 与内联 style 属性违规')
      } finally {
        fs.rmSync(tempPluginDir, { recursive: true, force: true })
      }
    })

    it('样本 9: 必须拦截在 JS 代码中通过 document.createElement 动态注入 style/link', async () => {
      const snippet1 = "const s = document.createElement('style'); s.textContent = 'body{color:red}'; document.head.appendChild(s);"
      const res1 = await scanCodeSnippet(snippet1)
      assert.equal(res1.passed, false)
      assert.ok(res1.violations.some(v => v.rule === 'DISALLOWED_DOM_STYLE_INJECTION' && v.message.includes('style')))

      const snippet2 = "const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = 'https://cdn.example.com/a.css';"
      const res2 = await scanCodeSnippet(snippet2)
      assert.equal(res2.passed, false)
      assert.ok(res2.violations.some(v => v.rule === 'DISALLOWED_DOM_STYLE_INJECTION' && v.message.includes('link')))
    })

    it('样本 10: 必须拦截直接操纵 DOM 元素的 style 属性与 innerHTML 注入 <style>', async () => {
      const snippet1 = "const el = document.getElementById('box'); el.style.backgroundColor = 'blue';"
      const res1 = await scanCodeSnippet(snippet1)
      assert.equal(res1.passed, false)
      assert.ok(res1.violations.some(v => v.rule === 'DISALLOWED_DOM_STYLE_INJECTION' && v.message.includes('style')))

      const snippet2 = "document.body.innerHTML = '<style>h1 { font-size: 20px; }</style><h1>Hello</h1>';"
      const res2 = await scanCodeSnippet(snippet2)
      assert.equal(res2.passed, false)
      assert.ok(res2.violations.some(v => v.rule === 'DISALLOWED_DOM_STYLE_INJECTION' && v.message.includes('innerHTML')))
    })
  })

  describe('3. 自动化打包与全网静态索引流水线 (scripts/build-plugins-release.mjs)', () => {
    const testOutputDir = path.join(rootDir, 'dist/test-plugins-release')

    it('应自动过滤拦截 4 个恶意样本并成功打包 2 个合规样本生成 plugins.json', async () => {
      if (fs.existsSync(testOutputDir)) {
        fs.rmSync(testOutputDir, { recursive: true, force: true })
      }

      const releaseResult = await buildPluginsRelease({
        pluginsDir: fixturesDir,
        outputDir: testOutputDir,
        cdnBaseUrl: 'https://cdn.example.com',
        failFast: false
      })

      assert.equal(releaseResult.total, 6, '共检测到 6 个插件')
      assert.equal(releaseResult.passedCount, 2, '合规打包数量必须为 2')
      assert.equal(releaseResult.rejectedCount, 4, '拦截恶意插件数量必须为 4')

      // 验证 plugins.json
      const indexPath = path.join(testOutputDir, 'plugins.json')
      assert.ok(fs.existsSync(indexPath), 'plugins.json 索引文件必须已生成')
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))

      assert.equal(index.total, 2)
      assert.equal(index.plugins.length, 2)

      const textCounter = index.plugins.find(p => p.id === 'text-counter')
      assert.ok(textCounter, 'text-counter 插件必须包含在索引中')
      assert.equal(textCounter.twoManReview.status, 'approved')
      assert.equal(typeof textCounter.sha256, 'string')
      assert.equal(textCounter.sha256.length, 64)
      assert.ok(textCounter.size > 0)
      // 平台声明原样写入索引，并附带便于展示的 platforms
      assert.deepEqual(textCounter.platforms, ['windows', 'macos'])
      assert.deepEqual(textCounter.targets.map((t) => t.platform), ['windows', 'macos'])

      const sensitiveNet = index.plugins.find(p => p.id === 'sensitive-network')
      assert.ok(sensitiveNet, 'sensitive-network 插件必须包含在索引中')
      assert.equal(sensitiveNet.twoManReview.status, 'pending')
      assert.equal(sensitiveNet.twoManReview.required, true)

      // 验证 ZIP 物理文件存在且 SHA256 校验一致
      const expectedZipFile = path.join(testOutputDir, textCounter.author, 'text-counter', `text-counter-${textCounter.version}.zip`)
      assert.ok(fs.existsSync(expectedZipFile), `ZIP 打包物理文件必须存在: ${expectedZipFile}`)

      const fileBuffer = fs.readFileSync(expectedZipFile)
      const actualHash = crypto.createHash('sha256').update(fileBuffer).digest('hex')
      assert.equal(actualHash, textCounter.sha256, '索引中的 SHA256 必须与实际生成的 ZIP 完全吻合')
    })

    function makeTempPlugins(name, plugins) {
      const base = path.join(rootDir, 'dist', name)
      fs.rmSync(base, { recursive: true, force: true })
      for (const [dir, manifest, code] of plugins) {
        fs.mkdirSync(path.join(base, dir, 'dist'), { recursive: true })
        fs.writeFileSync(path.join(base, dir, 'plugin.json'), JSON.stringify(manifest))
        fs.writeFileSync(path.join(base, dir, 'dist', 'index.js'), code || 'export default function C() {}')
      }
      return base
    }

    it('下架开关：plugin.json 写 revoked 后只输出下架记录，即使代码违规也不打包、不拦截', async () => {
      const base = makeTempPlugins('test-revoked-src', [
        ['bad-tool', { id: 'bad-tool', name: '坏插件', version: '1.2.0', revoked: true, revokedReason: '发现窃取剪贴板' }, 'eval("steal()")']
      ])
      const out = path.join(rootDir, 'dist/test-revoked-out')
      try {
        const res = await buildPluginsRelease({ pluginsDir: base, outputDir: out, cdnBaseUrl: 'https://cdn.example.com' })
        assert.equal(res.success, true)
        assert.equal(res.rejectedCount, 0)
        assert.equal(res.publishedPackages.length, 0, '下架插件不能产出安装包')
        const catalog = JSON.parse(fs.readFileSync(path.join(out, 'catalog.json'), 'utf8'))
        const item = catalog.plugins.find((p) => p.id === 'bad-tool')
        assert.equal(item.revoked, true)
        assert.equal(item.revokedReason, '发现窃取剪贴板')
        assert.equal(item.downloadUrl, undefined)
        assert.equal(item.sha256, undefined)
        assert.ok(!fs.existsSync(path.join(out, 'community', 'bad-tool')), '不能生成下载目录')
      } finally {
        fs.rmSync(base, { recursive: true, force: true })
        fs.rmSync(out, { recursive: true, force: true })
      }
    })

    it('官方标记只看官方名单：名单内才是官方；作者名、目录名都不能换来官方标记，冒用官方作者名的插件被拦下', async () => {
      const copyFixture = (base, rel, patch) => {
        const dir = path.join(base, rel)
        fs.cpSync(path.join(fixturesDir, 'compliant-plugin'), dir, { recursive: true })
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'))
        fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ ...manifest, ...patch }))
      }
      const flat = path.join(rootDir, 'dist/test-official-src')
      const nested = path.join(rootDir, 'dist/test-official-nested-src')
      const out = path.join(rootDir, 'dist/test-official-out')
      const outNested = path.join(rootDir, 'dist/test-official-nested-out')
      for (const d of [flat, nested, out, outNested]) fs.rmSync(d, { recursive: true, force: true })
      try {
        copyFixture(flat, 'calculator', { id: 'calculator', author: 'ZTools Team' })
        copyFixture(flat, 'community-tool', { id: 'community-tool', author: 'ZTools Community' })
        copyFixture(flat, 'dev-tool', { id: 'dev-tool', author: 'ztools-dev' })
        copyFixture(flat, 'fake-official', { id: 'fake-official', author: 'ZTools Team' })
        const res = await buildPluginsRelease({ pluginsDir: flat, outputDir: out, cdnBaseUrl: 'https://cdn.example.com' })
        assert.equal(res.rejectedCount, 1, '冒用官方作者名的插件必须被拦下')
        const catalog = JSON.parse(fs.readFileSync(path.join(out, 'catalog.json'), 'utf8'))
        const byId = Object.fromEntries(catalog.plugins.map((p) => [p.id, p]))
        assert.equal(byId['fake-official'], undefined)
        assert.equal(byId.calculator.is_official, true)
        assert.equal(byId.calculator.official_badge, '官方自营')
        for (const id of ['community-tool', 'dev-tool']) {
          assert.equal(byId[id].is_official, false, `${id} 作者名含 ZTools 也不能算官方`)
          assert.equal(byId[id].official_badge, '')
        }

        // 两级目录 official/<id> 的目录名同样不能换来官方标记
        copyFixture(nested, 'official/other-tool', { id: 'other-tool', author: 'dev' })
        await buildPluginsRelease({ pluginsDir: nested, outputDir: outNested, cdnBaseUrl: 'https://cdn.example.com' })
        const nestedCatalog = JSON.parse(fs.readFileSync(path.join(outNested, 'catalog.json'), 'utf8'))
        assert.equal(nestedCatalog.plugins.find((p) => p.id === 'other-tool').is_official, false)
      } finally {
        for (const d of [flat, nested, out, outNested]) fs.rmSync(d, { recursive: true, force: true })
      }
    })

    it('草稿：plugin.json 写 draft 后不打包、不进插件目录，也不算拦截失败', async () => {
      const base = makeTempPlugins('test-draft-src', [
        ['demo-only', { id: 'demo-only', name: '示例数据插件', version: '1.0.0', draft: true, draftReason: '只有示例数据' }, 'eval("x")'],
        ['gone', { id: 'gone', name: '已下架', version: '1.0.0', revoked: true, revokedReason: '安全问题' }]
      ])
      const out = path.join(rootDir, 'dist/test-draft-out')
      try {
        const res = await buildPluginsRelease({ pluginsDir: base, outputDir: out, cdnBaseUrl: 'https://cdn.example.com' })
        assert.equal(res.success, true, '草稿不应让整次发布失败')
        assert.equal(res.rejectedCount, 0)
        assert.deepEqual(res.draftIds, ['demo-only'])
        assert.equal(res.publishedPackages.length, 0)
        const catalog = JSON.parse(fs.readFileSync(path.join(out, 'catalog.json'), 'utf8'))
        assert.deepEqual(catalog.plugins.map((p) => p.id), ['gone'], '插件目录里只能有下架记录，不能出现草稿')
      } finally {
        fs.rmSync(base, { recursive: true, force: true })
        fs.rmSync(out, { recursive: true, force: true })
      }
    })

    it('[破坏性] 草稿与下架字段类型错误或没写原因时清单校验不通过', () => {
      const base = { id: 'flag-check', name: '字段检查', version: '1.0.0', description: 'x', author: 'a', entry: 'dist/index.js', icon: 'icon.svg', permissions: [], nativeComponents: [],
        targets: [{ id: 'windows-electron-any', platform: 'windows', runtime: 'electron', arch: 'any' }] }
      assert.equal(validatePluginManifest(base).valid, true)
      const cases = [
        [{ draft: 'yes', draftReason: 'r' }, /draft 字段必须为布尔值/],
        [{ draft: true }, /draft 为 true 时必须用 draftReason 写明原因/],
        [{ draft: true, draftReason: '   ' }, /draft 为 true 时必须用 draftReason 写明原因/],
        [{ revoked: 1, revokedReason: 'r' }, /revoked 字段必须为布尔值/],
        [{ revoked: true }, /revoked 为 true 时必须用 revokedReason 写明原因/],
        [{ draftReason: 42 }, /draftReason 字段必须为字符串/]
      ]
      for (const [extra, pattern] of cases) {
        const result = validatePluginManifest({ ...base, ...extra })
        assert.equal(result.valid, false, JSON.stringify(extra))
        assert.ok(result.errors.some((e) => pattern.test(e)), `${JSON.stringify(extra)} -> ${result.errors.join('; ')}`)
      }
      assert.equal(validatePluginManifest({ ...base, draft: false }).valid, true, 'draft: false 等同于正式发布')
    })

    it('[破坏性] 两个目录声明了同一个插件 ID 时拒绝生成目录，旧目录保持不变', async () => {
      const base = makeTempPlugins('test-dup-src', [
        ['a', { id: 'same-id', name: 'A', version: '1.0.0', revoked: true }],
        ['b', { id: 'same-id', name: 'B', version: '1.0.0', revoked: true }]
      ])
      const out = path.join(rootDir, 'dist/test-dup-out')
      fs.mkdirSync(out, { recursive: true })
      fs.writeFileSync(path.join(out, 'catalog.json'), '{"old":true}')
      try {
        await assert.rejects(
          () => buildPluginsRelease({ pluginsDir: base, outputDir: out, cdnBaseUrl: 'https://cdn.example.com' }),
          /重复的插件 ID: "same-id"/
        )
        assert.equal(fs.readFileSync(path.join(out, 'catalog.json'), 'utf8'), '{"old":true}')
      } finally {
        fs.rmSync(base, { recursive: true, force: true })
        fs.rmSync(out, { recursive: true, force: true })
      }
    })
  })

  describe('4. 阿里云 OSS 上传与 CDN 刷新 (scripts/deploy-plugins-storage.mjs)', () => {
    it('在 --dry-run 模式下应完成 OSS 上传与 CDN 刷新的演练', async () => {
      const testOutputDir = path.join(rootDir, 'dist/test-plugins-release')
      const deployRes = await deployPluginsStorage({
        dir: testOutputDir,
        dryRun: true,
        cdnBaseUrl: 'https://cdn.ztools.cn'
      })

      assert.equal(deployRes.success, true)
      assert.equal(deployRes.dryRun, true)
      assert.ok(deployRes.filesCount > 0, '应该收集并仿真部署了生成的文件')
    })

    it('M1-9 静态分发缓存策略固化：带版本号的 zip 强缓存 30 天 immutable，plugins.json 短缓存 5 分钟', () => {
      // 1. 带版本号的发布包 (*.zip) -> max-age=2592000, immutable
      const zipHeader = getCacheControl('author/plugin-id/plugin-id-1.0.0.zip')
      assert.equal(zipHeader, 'public, max-age=2592000, immutable')

      const customZipHeader = getCacheControl('dist/text-counter-2.3.4.zip')
      assert.equal(customZipHeader, 'public, max-age=2592000, immutable')

      // 2. 全网静态索引 plugins.json -> max-age=300 短缓存
      const indexHeader = getCacheControl('plugins.json')
      assert.equal(indexHeader, 'public, max-age=300')

      const nestedIndexHeader = getCacheControl('dist/release/plugins.json')
      assert.equal(nestedIndexHeader, 'public, max-age=300')

      // 3. 其它静态资源（如 icon 图标）-> 默认 7 天
      const pngHeader = getCacheControl('author/plugin-id/icon.png')
      assert.equal(pngHeader, 'public, max-age=604800')
    })
  })

  describe('5. 官方投稿预检与 AST 门禁流水线深度防御测试 (M1-10)', () => {
    it('5.1 严禁动态 eval：拦截间接字符串拼接 (window["ev"+"al"] 与 globalThis["ev"+"al"])', async () => {
      const snippet1 = 'window["ev" + "al"]("alert(1)");'
      const res1 = await scanCodeSnippet(snippet1)
      assert.equal(res1.passed, false)
      assert.ok(res1.violations.some(v => v.rule === 'BANNED_DYNAMIC_EVAL'))

      const snippet2 = 'globalThis["e" + "val"]("console.log(2)");'
      const res2 = await scanCodeSnippet(snippet2)
      assert.equal(res2.passed, false)
      assert.ok(res2.violations.some(v => v.rule === 'BANNED_DYNAMIC_EVAL'))
    })

    it('5.2 严禁动态 eval：拦截数组包装间接调用 ([eval][0]) 与全局反射变量调用', async () => {
      const snippet1 = 'const fn = [eval][0]; fn("malicious()");'
      const res1 = await scanCodeSnippet(snippet1)
      assert.equal(res1.passed, false)
      assert.ok(res1.violations.some(v => v.rule === 'BANNED_DYNAMIC_EVAL'))

      const snippet2 = 'const method = "eval"; window[method]("hack()");'
      const res2 = await scanCodeSnippet(snippet2)
      assert.equal(res2.passed, false)
      assert.ok(res2.violations.some(v => v.rule === 'BANNED_DYNAMIC_EVAL'))
    })

    it('5.3 严禁动态 new Function：拦截 Function() 直接调用与 window.Function()', async () => {
      const snippet1 = 'const f = Function("return 42");'
      const res1 = await scanCodeSnippet(snippet1)
      assert.equal(res1.passed, false)
      assert.ok(res1.violations.some(v => v.rule === 'BANNED_DYNAMIC_FUNCTION'))

      const snippet2 = 'const f2 = window.Function("return process")();'
      const res2 = await scanCodeSnippet(snippet2)
      assert.equal(res2.passed, false)
      assert.ok(res2.violations.some(v => v.rule === 'BANNED_DYNAMIC_FUNCTION'))
    })

    it('5.4 严禁动态 new Function：拦截原型链逃逸构建构造函数 (({}).constructor.constructor)', async () => {
      const snippet = 'const evil = ({}).constructor.constructor("return process.mainModule.require")();'
      const res = await scanCodeSnippet(snippet)
      assert.equal(res.passed, false)
      assert.ok(res.violations.some(v => v.rule === 'BANNED_DYNAMIC_FUNCTION' && v.message.includes('constructor.constructor')))
    })

    it('5.5 严禁代码混淆：拦截密集十六进制转义与 javascript-obfuscator 特征变量', async () => {
      const hexSnippet = 'const a = "\\x73\\x79\\x73\\x74\\x65\\x6d"; const b = "\\x65\\x78\\x65\\x63";'
      const hexRes = await scanCodeSnippet(hexSnippet)
      assert.equal(hexRes.passed, false)
      assert.ok(hexRes.violations.some(v => v.rule === 'HEX_STRING_OBFUSCATION'))

      const obfSnippet = 'const _0x1a2b = "test"; const _0x3c4d = 123; const _0x5e6f = true; console.log(_0x1a2b);'
      const obfRes = await scanCodeSnippet(obfSnippet)
      assert.equal(obfRes.passed, false)
      assert.ok(obfRes.violations.some(v => v.rule === 'OBFUSCATOR_VARIABLE_DETECTED'))
    })

    it('5.6 严禁动态计算 require：拦截动态参数与 Buffer 解码构造模块名称', async () => {
      const snippet1 = 'const fs = require(Buffer.from("ZnM=", "base64").toString());'
      const res1 = await scanCodeSnippet(snippet1)
      assert.equal(res1.passed, false)
      assert.ok(res1.violations.some(v => v.rule === 'BANNED_DYNAMIC_REQUIRE'))

      const snippet2 = 'const modName = "child_" + "process"; const cp = require(modName);'
      const res2 = await scanCodeSnippet(snippet2)
      assert.equal(res2.passed, false)
      assert.ok(res2.violations.some(v => v.rule === 'BANNED_DYNAMIC_REQUIRE'))
    })

    it('5.7 运行时只提供 crypto 与 path：其余 Node 内置模块即使声明了权限也报 UNSUPPORTED_RUNTIME_MODULE', async () => {
      assert.deepEqual([...DECLARATIVE_RUNTIME_NODE_MODULES].sort(), ['crypto', 'path'])
      const unsupported = (res) => res.violations.filter(v => v.rule === 'UNSUPPORTED_RUNTIME_MODULE')

      // 已声明对应权限仍然拦截（各种引入写法）
      const cases = [
        ['const fs = require("fs");', ['fs'], 'fs'],
        ['import { exec } from "node:child_process"; exec("ls");', ['child_process'], 'node:child_process'],
        ['import os from "os"; os.platform();', ['system'], 'os'],
        ['async function f() { return import("net") }', ['network'], 'net'],
        ['import { readFile } from "fs/promises";', ['fs'], 'fs/promises'],
        ['import { join } from "path/posix";', [], 'path/posix']
      ]
      for (const [code, perms, mod] of cases) {
        const res = await scanCodeSnippet(code, perms)
        assert.equal(res.passed, false, `${mod} 必须被拦截`)
        const hits = unsupported(res)
        assert.equal(hits.length, 1, `${mod} 只报一次 UNSUPPORTED_RUNTIME_MODULE`)
        assert.equal(hits[0].severity, 'error')
        assert.ok(hits[0].message.includes(`"${mod}"`), `违规信息应指明模块 ${mod}`)
        assert.equal(hits[0].line, 1)
      }

      // 未声明权限：两条都报（权限缺失 + 运行时不提供）
      const noPerm = await scanCodeSnippet('const cp = require("child_process");', [])
      assert.ok(noPerm.violations.some(v => v.rule === 'UNAUTHORIZED_NODE_MODULE'))
      assert.equal(unsupported(noPerm).length, 1)
    })

    it('5.8 crypto / path 可以使用；crypto 仍要声明权限；非内置模块与纯类型引入不受影响', async () => {
      const ok = await scanCodeSnippet('import crypto from "node:crypto"; import path from "path"; crypto.randomUUID(); path.join("a", "b");', ['crypto'])
      assert.equal(ok.passed, true)
      assert.equal(ok.violations.length, 0)

      const cryptoNoPerm = await scanCodeSnippet('const crypto = require("crypto");', [])
      assert.equal(cryptoNoPerm.passed, false)
      assert.ok(cryptoNoPerm.violations.some(v => v.rule === 'UNAUTHORIZED_NODE_MODULE'))
      assert.equal(cryptoNoPerm.violations.some(v => v.rule === 'UNSUPPORTED_RUNTIME_MODULE'), false)

      const sdk = await scanCodeSnippet('import { List } from "@ztools/declarative-ui"; import x from "./local.js";', [])
      assert.equal(sdk.violations.some(v => v.rule === 'UNSUPPORTED_RUNTIME_MODULE'), false)

      // TypeScript 纯类型引入编译后不存在，不算引入模块
      const typeOnly = await scanCodeSnippet('import type { Stats } from "node:fs";\nexport type { Dirent } from "fs";\nconst size: number = 1;', [])
      assert.equal(typeOnly.violations.some(v => v.rule === 'UNSUPPORTED_RUNTIME_MODULE' || v.rule === 'UNAUTHORIZED_NODE_MODULE'), false)
    })

    it('5.9 [对抗] 经 export ... from 转出 Node 模块同样拦截', async () => {
      for (const code of ['export * from "os";', 'export { readFileSync } from "node:fs";', 'export * as cp from "child_process";']) {
        const res = await scanCodeSnippet(code, ['fs', 'system', 'child_process'])
        assert.equal(res.passed, false, `${code} 必须被拦截`)
        assert.ok(res.violations.some(v => v.rule === 'UNSUPPORTED_RUNTIME_MODULE'), `${code} 必须报 UNSUPPORTED_RUNTIME_MODULE`)
      }
    })

    it('5.10 合规声明 fs 但引入 fs 的整包扫描：失败并指明运行时不提供', async () => {
      const dir = fs.mkdtempSync(path.join(rootDir, 'tests/fixtures/plugins/.tmp-runtime-module-'))
      try {
        fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
          id: 'runtime-module-demo', name: '运行时模块示例', version: '1.0.0', description: '声明了 fs 权限仍引入 fs',
          author: 'dev', entry: 'index.js', icon: 'icon.png', permissions: ['fs']
        }))
        fs.writeFileSync(path.join(dir, 'icon.png'), '')
        fs.writeFileSync(path.join(dir, 'index.js'), 'import fs from "node:fs";\nexport default function Command() { return fs.readFileSync("/etc/hosts", "utf8") }\n')
        const result = await scanPluginSecurity(dir)
        assert.equal(result.passed, false)
        const hit = result.violations.find(v => v.rule === 'UNSUPPORTED_RUNTIME_MODULE')
        assert.ok(hit, '必须报 UNSUPPORTED_RUNTIME_MODULE')
        assert.equal(hit.file.replace(/\\/g, '/'), 'index.js')
        assert.equal(hit.line, 1)
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  describe('4. 插件平台声明（targets：跨平台 / 仅 Windows / 仅 macOS）', () => {
    const base = () => ({
      id: 'platform-demo', name: '平台示例', version: '1.0.0', description: '平台声明测试',
      author: 'dev', entry: 'dist/index.js', icon: 'icon.svg', permissions: [], nativeComponents: []
    })

    it('跨平台、仅 Windows、仅 macOS 三种声明都能通过，并能读出平台与说明文字', () => {
      for (const [platforms, label] of [[['windows', 'macos'], '跨平台'], [['windows'], '仅 Windows'], [['macos'], '仅 macOS']]) {
        const manifest = { ...base(), targets: buildPlatformTargets(platforms) }
        const res = validatePluginManifest(manifest)
        assert.deepEqual(res.errors, [], label)
        assert.deepEqual(getManifestPlatforms(manifest), platforms)
        assert.equal(describePlatforms(getManifestPlatforms(manifest)), label)
      }
      // 顺序与重复无关
      assert.deepEqual(buildPlatformTargets(['macos', 'windows', 'macos']).map((t) => t.platform), ['windows', 'macos'])
    })

    it('[破坏性] 缺少 targets、空数组、非法平台、重复 id、未知字段、没有 electron 目标、缺 nativeComponents 都被拦截', () => {
      const cases = [
        [{ ...base(), targets: undefined }, /缺少必填字段: targets/],
        [{ ...base(), targets: [] }, /targets 必须为非空数组/],
        [{ ...base(), targets: ['windows'] }, /必须为对象/],
        [{ ...base(), targets: [{ id: 'linux-electron-any', platform: 'linux', runtime: 'electron', arch: 'any' }] }, /platform 必须为/],
        [{ ...base(), targets: [...buildPlatformTargets(['windows']), ...buildPlatformTargets(['windows'])] }, /id 重复/],
        [{ ...base(), targets: [{ ...buildPlatformTargets(['windows'])[0], hack: true }] }, /未知字段: hack/],
        [{ ...base(), targets: [{ id: 'legacy', platform: 'windows', runtime: 'legacy-delphi', arch: 'ia32' }] }, /至少要有一个 runtime 为 electron/],
        [{ ...base(), targets: [{ id: 'mac-old', platform: 'macos', runtime: 'electron', arch: 'ia32' }] }, /macOS 不支持 ia32/],
        [{ ...base(), targets: buildPlatformTargets(['windows']), nativeComponents: undefined }, /nativeComponents 必须为数组/]
      ]
      for (const [manifest, pattern] of cases) {
        const res = validatePluginManifest(manifest)
        assert.equal(res.valid, false, String(pattern))
        assert.ok(res.errors.some((e) => pattern.test(e)), `${pattern} -> ${res.errors.join(' | ')}`)
      }
      assert.throws(() => buildPlatformTargets([]), /非空组合/)
      assert.throws(() => buildPlatformTargets(['linux']), /非空组合/)
      assert.deepEqual(getManifestPlatforms(null), [])
      assert.equal(describePlatforms([]), '未声明平台')
    })

    it('[集成] 安全扫描对缺少平台声明的插件不放行', async () => {
      const dir = path.join(rootDir, 'tests/fixtures/plugins/temp-missing-targets')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ ...base(), entry: 'index.js', icon: 'icon.png' }, null, 2))
      fs.writeFileSync(path.join(dir, 'index.js'), 'export default function Command() { return null }')
      fs.writeFileSync(path.join(dir, 'icon.png'), '')
      try {
        const result = await scanPluginSecurity(dir)
        assert.equal(result.passed, false)
        assert.ok(result.violations.some((v) => /targets/.test(v.message)))
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    // 官方插件源码只在内部仓库的 plugins/ 子模块里，公开客户端仓库没有这个目录
    const officialPluginsRoot = path.join(rootDir, 'plugins')
    it('[集成] 官方插件仓库里每个 plugin.json 都声明了合法平台', {
      skip: fs.existsSync(officialPluginsRoot) ? false : '缺少 plugins/ 目录（公开客户端仓库不含官方插件源码）'
    }, () => {
      const pluginsRoot = officialPluginsRoot
      const ids = fs.readdirSync(pluginsRoot).filter((d) => fs.existsSync(path.join(pluginsRoot, d, 'plugin.json')))
      assert.ok(ids.length >= 50, `插件数量异常: ${ids.length}`)
      for (const id of ids) {
        const manifest = JSON.parse(fs.readFileSync(path.join(pluginsRoot, id, 'plugin.json'), 'utf8'))
        assert.ok(getManifestPlatforms(manifest).length > 0, `${id} 未声明平台`)
        assert.ok(Array.isArray(manifest.nativeComponents), `${id} 缺 nativeComponents`)
      }
    })
  })
})
