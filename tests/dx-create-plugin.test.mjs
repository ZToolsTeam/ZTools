import { test, describe, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync, fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validatePluginManifest } from '../packages/ztools-plugins-spec/src/index.js'
import { scanPluginSecurity } from '../scripts/scan-plugin-security.mjs'
import { createPlugin, validatePluginId, parsePlatformOption } from '../scripts/create-plugin.mjs'
import { getManifestPlatforms } from '../packages/ztools-plugins-spec/src/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const createScriptPath = path.resolve(rootDir, 'scripts/create-plugin.mjs')

// 隔离的临时测试目录
const TEST_DIR_NAME = `temp-dx-test-${Date.now()}`
const TEST_BASE_DIR = path.resolve(rootDir, TEST_DIR_NAME)

function cleanupTestDir() {
  if (fs.existsSync(TEST_BASE_DIR)) {
    try {
      fs.rmSync(TEST_BASE_DIR, { recursive: true, force: true })
    } catch {}
  }
}

describe('DX 基线与插件脚手架自动化集成测试 (create-plugin.mjs)', () => {
  before(() => {
    cleanupTestDir()
    fs.mkdirSync(TEST_BASE_DIR, { recursive: true })
  })

  after(() => {
    cleanupTestDir()
  })

  // ==========================================================================
  // 链路 1: 正常全链路集成测试 (Happy Path & End-to-End Delivery)
  // ==========================================================================
  describe('链路 1: 标准插件工程一键生成与规范闭环', () => {
    const pluginId = 'geek-notes'
    const title = '极客便签'
    const desc = '专为极客打造的纯声明式快速随手记便签'

    test('1.1 编程式创建标准插件工程并验证全量文件生成与 LF 换行', async () => {
      const result = await createPlugin({
        pluginId,
        title,
        description: desc,
        targetDir: TEST_BASE_DIR,
        force: true
      })

      assert.equal(result.success, true)
      assert.ok(fs.existsSync(result.pluginDir))

      const expectedFiles = [
        'plugin.json',
        'package.json',
        'tsconfig.json',
        'icon.svg',
        'src/index.tsx',
        'dist/index.js',
        'tests/index.test.mjs',
        'README.md'
      ]

      for (const rel of expectedFiles) {
        const full = path.join(result.pluginDir, rel)
        assert.ok(fs.existsSync(full), `必需文件 ${rel} 必须被正确生成`)

        // 验证文件换行符规范：严禁使用 CRLF，必须为标准 LF
        const content = fs.readFileSync(full, 'utf8')
        assert.doesNotMatch(content, /\r\n/, `文件 ${rel} 包含 CRLF，违反项目代码换行符规范 (LF)`)
      }
    })

    test('1.2 校验生成的 plugin.json 符合 @ztools/plugins-spec 规约', () => {
      const pluginDir = path.join(TEST_BASE_DIR, pluginId)
      const manifestPath = path.join(pluginDir, 'plugin.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

      const validation = validatePluginManifest(manifest, { baseDir: pluginDir })
      assert.equal(validation.valid, true, `plugin.json 校验未通过: ${validation.errors.join('; ')}`)
      assert.equal(validation.errors.length, 0)

      assert.equal(manifest.id, pluginId)
      assert.equal(manifest.name, title)
      assert.equal(manifest.description, desc)
      assert.equal(manifest.version, '1.0.0')
      assert.equal(manifest.author, 'ZTools Developer')
      assert.equal(manifest.entry, 'dist/index.js')
      assert.equal(manifest.icon, 'icon.svg')
      assert.deepEqual(manifest.permissions, ['clipboard'])
      assert.ok(Array.isArray(manifest.commands))
      assert.equal(manifest.commands[0].name, 'index')
    })

    test('1.3 生成的插件工程必须 100% 通过 AST 静态安全扫描门禁 (无违规/零CSS/零DOM)', async () => {
      const pluginDir = path.join(TEST_BASE_DIR, pluginId)
      const scanResult = await scanPluginSecurity(pluginDir)

      assert.equal(scanResult.passed, true, `AST 静态安全扫描失败: ${JSON.stringify(scanResult.violations)}`)
      assert.equal(scanResult.violations.length, 0)
      assert.equal(scanResult.requiresTwoManReview, false)
      assert.ok(scanResult.scannedFiles.length >= 1)
      assert.ok(scanResult.scannedFiles.includes('src/index.tsx'))
    })

    test('1.4 生成的测试套件 (tests/index.test.mjs) 可以在 Node.js 中 100% 跑通', () => {
      const pluginDir = path.join(TEST_BASE_DIR, pluginId)
      const testFile = path.join(pluginDir, 'tests/index.test.mjs')

      const childEnv = { ...process.env }
      delete childEnv.NODE_TEST_CONTEXT

      const proc = spawnSync(process.execPath, ['--test', testFile], {
        cwd: rootDir,
        encoding: 'utf8',
        env: childEnv
      })

      assert.equal(proc.status, 0, `生成的测试套件执行失败:\nSTDOUT:\n${proc.stdout}\nSTDERR:\n${proc.stderr}`)
      assert.match(proc.stdout, /✔ 1\. plugin\.json 清单结构与规范校验/)
      assert.match(proc.stdout, /✔ 2\. 声明式规范与无原生 DOM\/CSS 审计/)
      assert.match(proc.stdout, /✔ 3\. 声明式组件挂载与视图描述符渲染验证/)
    })
  })

  // ==========================================================================
  // 链路 2: CLI 命令行调用与参数解析测试
  // ==========================================================================
  describe('链路 2: CLI 命令行接口交互与参数处理', () => {
    test('2.1 CLI 成功生成插件工程并支持自定义参数', () => {
      const cliPluginId = 'cli-sample-tool'
      const proc = spawnSync(
        process.execPath,
        [
          createScriptPath,
          cliPluginId,
          '命令行插件',
          '通过 CLI 传参生成的插件',
          '--target-dir',
          TEST_BASE_DIR
        ],
        { cwd: rootDir, encoding: 'utf8' }
      )

      assert.equal(proc.status, 0, `CLI 执行失败: ${proc.stderr}`)
      assert.match(proc.stdout, /插件工程创建成功/)
      assert.ok(fs.existsSync(path.join(TEST_BASE_DIR, cliPluginId, 'plugin.json')))
    })

    test('2.2 CLI --help 打印友好帮助信息并正常退出 (exit code 0)', () => {
      const proc = spawnSync(process.execPath, [createScriptPath, '--help'], {
        cwd: rootDir,
        encoding: 'utf8'
      })

      assert.equal(proc.status, 0)
      assert.match(proc.stdout, /ZTools 官方插件一键脚手架工具/)
      assert.match(proc.stdout, /用法:/)
      assert.match(proc.stdout, /示例:/)
    })

    test('2.3 CLI 非交互环境下缺少必填参数时拦截并返回友好提示 (exit code 1)', () => {
      const proc = spawnSync(process.execPath, [createScriptPath], {
        cwd: rootDir,
        encoding: 'utf8',
        // 非交互模式（无 TTY）
        stdio: ['pipe', 'pipe', 'pipe']
      })

      assert.equal(proc.status, 1, '缺少必填参数时必须返回状态码 1')
      assert.match(proc.stderr, /缺少必填参数 <plugin-id>/)
      assert.match(proc.stderr, /用法: node scripts\/create-plugin\.mjs/)
    })
  })

  // ==========================================================================
  // 链路 3: 严苛异常与破坏性边界测试 (Beyond Happy Path)
  // ==========================================================================
  describe('链路 3: 破坏性输入与目录冲突异常防护', () => {
    test('3.1 非法插件 ID 格式防御拦截 (大小写、特殊符号、数字开头、过短过长)', async () => {
      const invalidIds = [
        { id: '', reason: '空字符串' },
        { id: '   ', reason: '纯空格' },
        { id: 'MyPlugin', reason: '包含大写字母' },
        { id: '123plugin', reason: '以数字开头' },
        { id: '-plugin', reason: '以短横线开头' },
        { id: '_plugin', reason: '以下划线开头' },
        { id: 'plugin@tool', reason: '包含非法特殊字符 @' },
        { id: 'plugin#name', reason: '包含非法特殊字符 #' },
        { id: 'plugin name', reason: '包含空格' },
        { id: 'a', reason: '单字符过短 (长度 < 2)' },
        { id: 'a'.repeat(65), reason: '超长字符 (长度 > 64)' },
        { id: '  valid-id  ', reason: '首尾含空格' }
      ]

      for (const item of invalidIds) {
        // 校验函数验证
        const check = validatePluginId(item.id)
        assert.equal(check.valid, false, `应当拦截非法 ID [${item.id}] (${item.reason})`)
        assert.ok(check.error, `非法 ID [${item.id}] 必须返回明确错误提示`)

        // 脚手架核心逻辑验证
        await assert.rejects(
          async () => {
            await createPlugin({
              pluginId: item.id,
              targetDir: TEST_BASE_DIR
            })
          },
          /插件 ID/,
          `脚手架应当拒绝非法 ID: ${item.id} (${item.reason})`
        )
      }
    })

    test('3.2 目录穿越与绝对路径注入攻击防御', async () => {
      const maliciousIds = [
        '../malicious-plugin',
        '../../etc/passwd',
        'foo/bar',
        'foo\\bar',
        '..\\sub-plugin'
      ]

      for (const malId of maliciousIds) {
        const check = validatePluginId(malId)
        assert.equal(check.valid, false, `应当拦截目录穿越 ID: ${malId}`)

        await assert.rejects(
          async () => {
            await createPlugin({
              pluginId: malId,
              targetDir: TEST_BASE_DIR
            })
          },
          /路径分隔符|上级目录|格式不符合规范/,
          `必须拦截目录穿越攻击: ${malId}`
        )
      }
    })

    test('3.3 目标目录已存在时的冲突保护机制 (无 --force 抛错，有 --force 允许覆盖)', async () => {
      const conflictId = 'conflict-guard-tool'

      // 首次创建成功
      await createPlugin({
        pluginId: conflictId,
        title: '初始标题',
        targetDir: TEST_BASE_DIR
      })

      // 第二次在没有指定 force 的情况下尝试创建，必须被拦截
      await assert.rejects(
        async () => {
          await createPlugin({
            pluginId: conflictId,
            title: '重复尝试覆盖',
            targetDir: TEST_BASE_DIR,
            force: false
          })
        },
        /目标插件目录已存在.*若要强制覆盖，请指定 --force 标志/,
        '目录已存在时未指定 force 必须拒绝覆盖'
      )

      // 第三次指定 force: true，允许安全覆盖并更新内容
      const overwriteResult = await createPlugin({
        pluginId: conflictId,
        title: '强制覆盖后的新标题',
        targetDir: TEST_BASE_DIR,
        force: true
      })

      assert.equal(overwriteResult.success, true)
      const manifest = JSON.parse(
        fs.readFileSync(path.join(TEST_BASE_DIR, conflictId, 'plugin.json'), 'utf8')
      )
      assert.equal(manifest.name, '强制覆盖后的新标题')
    })
  })

  describe('平台声明', () => {
    test('默认生成跨平台插件；--platform windows / macos 只声明对应平台，生成的插件能通过规范校验与安全扫描', async () => {
      for (const [option, expected] of [[undefined, ['windows', 'macos']], ['windows', ['windows']], ['mac', ['macos']], ['cross', ['windows', 'macos']]]) {
        const pluginId = `platform-${option || 'default'}`
        const { pluginDir } = await createPlugin({ pluginId, targetDir: TEST_BASE_DIR, platforms: parsePlatformOption(option) })
        const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'))
        assert.deepEqual(getManifestPlatforms(manifest), expected, String(option))
        assert.deepEqual(manifest.nativeComponents, [])
        assert.deepEqual(validatePluginManifest(manifest, { baseDir: pluginDir }).errors.filter((e) => /targets|nativeComponents/.test(e)), [])
      }
    })

    test('[破坏性] 非法平台选项直接报错，不生成目录', async () => {
      assert.throws(() => parsePlatformOption('linux'), /无法识别的平台选项/)
      assert.throws(() => parsePlatformOption('windows,linux'), /无法识别的平台选项/)
      await assert.rejects(createPlugin({ pluginId: 'platform-bad', targetDir: TEST_BASE_DIR, platforms: ['linux'] }), /非空组合/)
      assert.equal(fs.existsSync(path.join(TEST_BASE_DIR, 'platform-bad')), false)
    })

    test('[集成] 命令行 --platform windows 生成仅 Windows 插件；缺少取值时退出并提示', () => {
      const ok = spawnSync(process.execPath, [createScriptPath, 'platform-cli', '--platform', 'windows', '--target-dir', TEST_BASE_DIR], { encoding: 'utf8' })
      assert.equal(ok.status, 0, ok.stderr)
      assert.match(ok.stdout, /仅 Windows/)
      const manifest = JSON.parse(fs.readFileSync(path.join(TEST_BASE_DIR, 'platform-cli', 'plugin.json'), 'utf8'))
      assert.deepEqual(getManifestPlatforms(manifest), ['windows'])
      const bad = spawnSync(process.execPath, [createScriptPath, 'platform-cli2', '--target-dir', TEST_BASE_DIR, '--platform'], { encoding: 'utf8' })
      assert.notEqual(bad.status, 0)
      assert.match(bad.stderr, /--platform 需要指定/)
    })
  })
})
