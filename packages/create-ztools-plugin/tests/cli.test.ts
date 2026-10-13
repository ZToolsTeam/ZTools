import { existsSync, rmSync, readFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { createPlugin, parseArgs } from '../src/index.js'
import { validatePluginId } from '../src/utils.js'

// 动态适配 Bun 测试运行器与 Node 原生测试运行器
let describe: any
let it: any
let expect: any
let beforeEach: any
let afterEach: any

if (typeof (globalThis as any).Bun !== 'undefined') {
  const bunTest = await import('bun:test')
  describe = bunTest.describe
  it = bunTest.it
  expect = bunTest.expect
  beforeEach = bunTest.beforeEach
  afterEach = bunTest.afterEach
} else {
  const nodeTest = await import('node:test')
  const assert = await import('node:assert/strict')
  describe = nodeTest.describe
  it = nodeTest.it
  beforeEach = nodeTest.beforeEach
  afterEach = nodeTest.afterEach
  expect = (actual: any) => ({
    toBe: (expected: any) => assert.default.strictEqual(actual, expected),
    toEqual: (expected: any) => assert.default.deepStrictEqual(actual, expected),
    toBeGreaterThan: (expected: any) => assert.default.ok(actual > expected),
    toBeGreaterThanOrEqual: (expected: any) => assert.default.ok(actual >= expected),
    toContain: (expected: any) => {
      if (typeof actual === 'string') {
        assert.default.ok(actual.includes(expected), `Expected string to contain "${expected}"`)
      } else if (Array.isArray(actual)) {
        assert.default.ok(actual.includes(expected), `Expected array to contain ${expected}`)
      }
    },
    toThrow: () => assert.default.throws(actual)
  })
}

describe('create-ztools-plugin CLI 工具测试套件', () => {
  const testBaseDir = resolve(tmpdir(), 'ztools-cli-test-' + Date.now())

  beforeEach(() => {
    if (!existsSync(testBaseDir)) {
      mkdirSync(testBaseDir, { recursive: true })
    }
  })

  afterEach(() => {
    if (existsSync(testBaseDir)) {
      rmSync(testBaseDir, { recursive: true, force: true })
    }
  })

  describe('1. 基础校验与参数解析', () => {
    it('validatePluginId 应该正确校验合法的插件 ID', () => {
      expect(validatePluginId('my-tool').valid).toBe(true)
      expect(validatePluginId('quick-notes').valid).toBe(true)
      expect(validatePluginId('tool123').valid).toBe(true)
      expect(validatePluginId('a').valid).toBe(true)
    })

    it('validatePluginId 应该拒绝非法的插件 ID', () => {
      expect(validatePluginId('123tool').valid).toBe(false)
      expect(validatePluginId('MyTool').valid).toBe(false)
      expect(validatePluginId('my_tool').valid).toBe(false)
      expect(validatePluginId('-bad').valid).toBe(false)
      expect(validatePluginId('').valid).toBe(false)
    })

    it('parseArgs 应该正确解析各类 CLI 标志', () => {
      const args = [
        'my-output',
        '--id', 'custom-id',
        '--name', '自定义插件',
        '--author', '测试作者',
        '--description', '测试描述',
        '--template', 'react-vite',
        '-y',
        '--overwrite'
      ]
      const { targetDir, options } = parseArgs(args)
      expect(targetDir).toBe('my-output')
      expect(options.id).toBe('custom-id')
      expect(options.name).toBe('自定义插件')
      expect(options.author).toBe('测试作者')
      expect(options.description).toBe('测试描述')
      expect(options.template).toBe('react-vite')
      expect(options.yes).toBe(true)
      expect(options.overwrite).toBe(true)
    })
  })

  describe('2. 生成 declarative 纯声明式模板项目 (推荐默认与零 CSS 规范)', () => {
    it('在未显式指定模板时应默认使用 declarative 模板，且严格无 CSS 与无 HTML', async () => {
      const targetDir = join(testBaseDir, 'test-default-declarative')
      const result = await createPlugin({
        id: 'test-default-declarative',
        name: '测试声明式插件',
        author: 'Declarative Dev',
        description: '基于 Raycast 兼容组件库的纯声明式插件',
        targetDir,
        silent: true
      })

      expect(result.success).toBe(true)
      expect(result.config.template).toBe('declarative')

      // 验证核心文件存在
      const requiredFiles = [
        'plugin.json',
        'package.json',
        'tsconfig.json',
        'src/index.ts',
        'icon.svg',
        'README.md'
      ]

      for (const file of requiredFiles) {
        expect(existsSync(join(targetDir, file))).toBe(true)
      }

      // 强断言：纯声明式插件严禁包含任何 .css 或 .html 文件
      for (const generatedFile of result.files) {
        const lower = generatedFile.toLowerCase()
        expect(lower.endsWith('.css')).toBe(false)
        expect(lower.endsWith('.less')).toBe(false)
        expect(lower.endsWith('.scss')).toBe(false)
        expect(lower.endsWith('.html')).toBe(false)
      }

      // 验证 plugin.json 内容与规范
      const manifestPath = join(targetDir, 'plugin.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      expect(manifest.id).toBe('test-default-declarative')
      expect(manifest.name).toBe('测试声明式插件')
      expect(manifest.author).toBe('Declarative Dev')
      expect(manifest.entry).toBe('dist/index.js')
      expect(manifest.icon).toBe('icon.svg')
      expect(Array.isArray(manifest.permissions)).toBe(true)

      // 验证 package.json 依赖
      const pkg = JSON.parse(readFileSync(join(targetDir, 'package.json'), 'utf8'))
      expect(pkg.dependencies['@ztools/raycast-compat']).toBe('^1.0.0')

      // 验证 src/index.ts 代码引用
      const code = readFileSync(join(targetDir, 'src/index.ts'), 'utf8')
      expect(code).toContain('@ztools/raycast-compat')
      expect(code).toContain('export default function Command')
      expect(code).not.toContain('<style>')
      expect(code).not.toContain('style=')
    })
  })

  describe('3. 生成 vue-vite 模板项目 (兼容老模式)', () => {
    it('应该生成完整的文件结构并通过规范校验', async () => {
      const targetDir = join(testBaseDir, 'test-vue-plugin')
      const result = await createPlugin({
        id: 'test-vue-plugin',
        name: '测试 Vue 插件',
        author: 'Vue Author',
        description: '测试基于 Vue 3 的 ZTools 插件',
        template: 'vue-vite',
        targetDir,
        silent: true
      })

      expect(result.success).toBe(true)

      // 验证核心文件存在
      const requiredFiles = [
        'plugin.json',
        'index.html',
        'src/App.vue',
        'src/main.ts',
        'src/theme.css',
        'vite.config.ts',
        'package.json',
        'tsconfig.json',
        'icon.svg',
        'README.md'
      ]

      for (const file of requiredFiles) {
        expect(existsSync(join(targetDir, file))).toBe(true)
      }

      // 验证 plugin.json 内容与规范合法性
      const manifestPath = join(targetDir, 'plugin.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      expect(manifest.id).toBe('test-vue-plugin')
      expect(manifest.name).toBe('测试 Vue 插件')
      expect(manifest.author).toBe('Vue Author')
      expect(manifest.entry).toBe('index.html')
      expect(manifest.icon).toBe('icon.svg')

      // 验证 window 属性规范
      expect(typeof manifest.window).toBe('object')
      expect(manifest.window.width).toBe(800)
      expect(manifest.window.height).toBe(600)
      expect(manifest.window.minWidth).toBe(480)
      expect(manifest.window.minHeight).toBe(360)
      expect(manifest.window.resizable).toBe(true)
      expect(manifest.window.singleInstance).toBe(true)
      expect(manifest.window.controls.minimize).toBe(true)
      expect(manifest.window.controls.maximize).toBe(true)

      // 验证 index.html 中引入了必要 SDK
      const htmlContent = readFileSync(join(targetDir, 'index.html'), 'utf8')
      expect(htmlContent).toContain('ztools://web/sdk/ztools-api.js')
      expect(htmlContent).toContain('ztools://web/sdk/plugin-sdk.js')

      // 使用仓库官方校验脚本执行合规检验
      const validatorPath = resolve(process.cwd(), 'ztools-open/scripts/validate-plugin.mjs')
      if (existsSync(validatorPath)) {
        const cmd = `node "${validatorPath}" "${targetDir}"`
        const output = execSync(cmd, { encoding: 'utf8' })
        expect(output).toContain('OK')
      }
    })
  })

  describe('3. 生成 react-vite 模板项目', () => {
    it('应该生成完整的文件结构并通过规范校验', async () => {
      const targetDir = join(testBaseDir, 'test-react-plugin')
      const result = await createPlugin({
        id: 'test-react-plugin',
        name: '测试 React 插件',
        author: 'React Author',
        description: '测试基于 React 18 的 ZTools 插件',
        template: 'react-vite',
        targetDir,
        silent: true
      })

      expect(result.success).toBe(true)

      // 验证核心文件存在
      const requiredFiles = [
        'plugin.json',
        'index.html',
        'src/App.tsx',
        'src/main.tsx',
        'src/theme.css',
        'vite.config.ts',
        'package.json',
        'tsconfig.json',
        'icon.svg',
        'README.md'
      ]

      for (const file of requiredFiles) {
        expect(existsSync(join(targetDir, file))).toBe(true)
      }

      // 验证 plugin.json
      const manifestPath = join(targetDir, 'plugin.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      expect(manifest.id).toBe('test-react-plugin')
      expect(manifest.name).toBe('测试 React 插件')
      expect(manifest.window.width).toBe(800)
      expect(manifest.window.height).toBe(600)
      expect(manifest.window.resizable).toBe(true)

      // 验证 index.html
      const htmlContent = readFileSync(join(targetDir, 'index.html'), 'utf8')
      expect(htmlContent).toContain('ztools://web/sdk/ztools-api.js')
      expect(htmlContent).toContain('ztools://web/sdk/plugin-sdk.js')

      // 官方校验脚本
      const validatorPath = resolve(process.cwd(), 'ztools-open/scripts/validate-plugin.mjs')
      if (existsSync(validatorPath)) {
        const cmd = `node "${validatorPath}" "${targetDir}"`
        const output = execSync(cmd, { encoding: 'utf8' })
        expect(output).toContain('OK')
      }
    })
  })

  describe('4. 生成 preload-only 模板项目', () => {
    it('应该生成完整的文件结构并通过规范校验', async () => {
      const targetDir = join(testBaseDir, 'test-preload-plugin')
      const result = await createPlugin({
        id: 'test-preload-plugin',
        name: '测试无 UI 插件',
        author: 'Preload Author',
        description: '纯无 UI 快速功能插件',
        template: 'preload-only',
        targetDir,
        silent: true
      })

      expect(result.success).toBe(true)

      // 验证核心文件存在
      const requiredFiles = [
        'plugin.json',
        'index.html',
        'src/index.ts',
        'package.json',
        'tsconfig.json',
        'icon.svg',
        'README.md'
      ]

      for (const file of requiredFiles) {
        expect(existsSync(join(targetDir, file))).toBe(true)
      }

      // 验证 plugin.json
      const manifestPath = join(targetDir, 'plugin.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      expect(manifest.id).toBe('test-preload-plugin')
      expect(manifest.name).toBe('测试无 UI 插件')
      expect(manifest.entry).toBe('index.html')
      expect(manifest.window.width).toBe(540)
      expect(manifest.window.height).toBe(380)
      expect(manifest.window.resizable).toBe(false)
      expect(manifest.window.singleInstance).toBe(true)
      expect(manifest.features[0].code).toBe('execute')

      // 验证 index.html
      const htmlContent = readFileSync(join(targetDir, 'index.html'), 'utf8')
      expect(htmlContent).toContain('ztools://web/sdk/ztools-api.js')
      expect(htmlContent).toContain('ztools://web/sdk/plugin-sdk.js')

      // 官方校验脚本
      const validatorPath = resolve(process.cwd(), 'ztools-open/scripts/validate-plugin.mjs')
      if (existsSync(validatorPath)) {
        const cmd = `node "${validatorPath}" "${targetDir}"`
        const output = execSync(cmd, { encoding: 'utf8' })
        expect(output).toContain('OK')
      }
    })
  })

  describe('5. 异常处理与边界测试', () => {
    it('非法插件 ID 应该抛出错误', async () => {
      let threw = false
      try {
        await createPlugin({
          id: 'Invalid_ID!',
          targetDir: join(testBaseDir, 'err-1'),
          silent: true
        })
      } catch (err) {
        threw = true
      }
      expect(threw).toBe(true)
    })

    it('不支持的模板类型应该抛出错误', async () => {
      let threw = false
      try {
        await createPlugin({
          id: 'test-plugin',
          template: 'angular' as any,
          targetDir: join(testBaseDir, 'err-2'),
          silent: true
        })
      } catch (err) {
        threw = true
      }
      expect(threw).toBe(true)
    })

    it('目标目录已存在且未提供 overwrite 时应抛出错误', async () => {
      const targetDir = join(testBaseDir, 'exist-dir')
      mkdirSync(targetDir, { recursive: true })

      let threw = false
      try {
        await createPlugin({
          id: 'test-plugin',
          template: 'vue-vite',
          targetDir,
          overwrite: false,
          silent: true
        })
      } catch (err) {
        threw = true
      }
      expect(threw).toBe(true)

      // 开启 overwrite 时应成功
      const successResult = await createPlugin({
        id: 'test-plugin',
        template: 'vue-vite',
        targetDir,
        overwrite: true,
        silent: true
      })
      expect(successResult.success).toBe(true)
    })
  })
})
