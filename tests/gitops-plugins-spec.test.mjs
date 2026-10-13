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
  HIGH_RISK_PERMISSIONS
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
        permissions: ['clipboard', 'dialog']
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
        permissions: []
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
        permissions: []
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
  })

  describe('4. 对象存储与 EdgeOne CDN 部署 (scripts/deploy-plugins-storage.mjs)', () => {
    it('在 --dry-run 模式下应完成 COS、R2 与 EdgeOne CDN 预热仿真', async () => {
      const testOutputDir = path.join(rootDir, 'dist/test-plugins-release')
      const deployRes = await deployPluginsStorage({
        dir: testOutputDir,
        dryRun: true,
        cdnBaseUrl: 'https://plugins.ztools.cn'
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
  })
})
