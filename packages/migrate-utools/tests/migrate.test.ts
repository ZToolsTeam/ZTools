/**
 * migrate.test.ts
 * Unit tests for @ztools/migrate CLI and API
 * Compatible with both `bun test` and `node --test`
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {
  StaticScanAnalyzer,
  TransformerEngine,
  TransactionManager,
  TransactionAbortedError,
  LineEndingHelper,
  ChecksumHelper,
  analyze,
  migrate,
  rollback
} from '../src/index.ts'

describe('@ztools/migrate Test Suite', () => {
  let sandboxDir: string
  let samplePluginDir: string
  let targetPluginDir: string

  beforeEach(() => {
    sandboxDir = path.join(
      os.tmpdir(),
      `ztools-migrate-test-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
    )
    fs.mkdirSync(sandboxDir, { recursive: true })

    samplePluginDir = path.join(sandboxDir, 'sample-calc-plugin')
    targetPluginDir = path.join(sandboxDir, 'sample-calc-plugin-ztools')
    fs.mkdirSync(samplePluginDir, { recursive: true })

    // 1. plugin.json
    const manifest = {
      name: 'calc-helper',
      pluginName: '超级计算助手',
      description: '全能数学公式与单位转换工具',
      author: 'Tester <tester@example.com>',
      version: '1.0.0',
      main: 'index.html',
      features: [
        {
          code: 'calc',
          explain: '快速计算',
          cmds: ['calc', '计算', 'js:']
        },
        {
          code: 'regex-calc',
          explain: '正则提取计算',
          cmds: [
            {
              type: 'regex',
              label: '匹配算式',
              match: '/\\d+[+\\-*/]\\d+/'
            }
          ]
        }
      ]
    }
    fs.writeFileSync(
      path.join(samplePluginDir, 'plugin.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8'
    )

    // 2. index.html (CRLF 换行符)
    const indexHtml =
      '<!DOCTYPE html>\r\n<html>\r\n<head>\r\n  <title>Calculator</title>\r\n</head>\r\n<body>\r\n  <div id="app">Calc</div>\r\n</body>\r\n</html>\r\n'
    fs.writeFileSync(path.join(samplePluginDir, 'index.html'), indexHtml, 'utf8')

    // 3. app.js (LF 换行符, 包含 utools API 与 sync DB 调用及 node 模块)
    const appJs = [
      '// Sample plugin app code',
      'const path = require("path");',
      'utools.onPluginEnter((action) => {',
      '  console.log("Plugin entered:", action);',
      '  const cached = utools.db.get("history_record");',
      '  if (cached) {',
      '    console.log("History found", cached);',
      '  }',
      '});',
      'function saveResult(val) {',
      '  utools.db.put({ _id: "res_" + Date.now(), val: val });',
      '  utools.dbStorage.setItem("last_calc", val);',
      '  utools.copyText(String(val));',
      '  utools.showNotification("计算结果已复制: " + val);',
      '  utools.hideMainWindow();',
      '}',
      'module.exports = { saveResult };',
      ''
    ].join('\n')
    fs.writeFileSync(path.join(samplePluginDir, 'app.js'), appJs, 'utf8')

    // 4. run.bat (CRLF 换行符)
    const runBat = '@echo off\r\necho Starting Calc...\r\n'
    fs.writeFileSync(path.join(samplePluginDir, 'run.bat'), runBat, 'utf8')
  })

  afterEach(() => {
    try {
      if (fs.existsSync(sandboxDir)) {
        fs.rmSync(sandboxDir, { recursive: true, force: true })
      }
    } catch {}
  })

  // 1. 静态扫描分析器测试
  it('静态扫描分析器：正确解析 Manifest 并计算 API 覆盖度与迁移就绪度评分', () => {
    const scanResult = StaticScanAnalyzer.scan(samplePluginDir)

    // Manifest 结构
    assert.strictEqual(scanResult.manifest.valid, true)
    assert.strictEqual(scanResult.manifest.name, '超级计算助手')
    assert.strictEqual(scanResult.manifest.version, '1.0.0')
    assert.strictEqual(scanResult.manifest.featuresCount, 2)
    assert.strictEqual(scanResult.manifest.cmdsCount, 4)

    // API 调用统计与覆盖度
    assert.ok(scanResult.apiUsage.totalCalls >= 6, '至少检测到 6 处 utools API 调用')
    assert.ok(scanResult.apiUsage.uniqueApisCount >= 5, '至少检测到 5 种独立 utools API')
    assert.ok(scanResult.apiUsage.coveragePercent >= 80, 'API 覆盖度应达到 80% 以上')

    // 同步数据库与 Node 依赖检测
    assert.strictEqual(scanResult.syncCalls.hasSyncDb, true, '成功检测到同步数据库调用')
    assert.strictEqual(scanResult.nodeUsage.modules.some(m => m.module === 'path'), true, '检测到 path 模块')

    // 评分与风险提示
    assert.ok(scanResult.readinessScore > 0 && scanResult.readinessScore <= 100, '就绪度评分在 0-100 区间')
    assert.ok(scanResult.risks.length > 0, '生成了对应风险评估与建议')
    assert.ok(
      scanResult.risks.some(r => r.message.includes('同步数据库')),
      '包含同步数据库风险警告'
    )
  })

  // 2. --analyze-only 模式测试
  it('--analyze-only：仅进行静态分析，绝对零触碰写盘', () => {
    const beforeFiles = fs.readdirSync(samplePluginDir)
    const scanResult = analyze(samplePluginDir)

    assert.strictEqual(scanResult.manifest.valid, true)
    assert.strictEqual(fs.existsSync(targetPluginDir), false, '目标目录绝对未被创建')

    const afterFiles = fs.readdirSync(samplePluginDir)
    assert.deepStrictEqual(beforeFiles, afterFiles, '源目录内容 100% 保持不变')
  })

  // 3. --dry-run 预演模式测试
  it('--dry-run：推演生成 Diff 计划，无磁盘副作用', () => {
    const plan = TransactionManager.createPlan(samplePluginDir, targetPluginDir)
    assert.ok(plan.operations.length >= 4, '计划包含所有源码及适配文件')
    assert.ok(plan.summary.create >= 4, '所有操作均为拟 CREATE')

    const res = TransactionManager.executeTransaction(plan, { dryRun: true })
    assert.strictEqual(res.success, true)
    assert.strictEqual(res.committed, false, 'dryRun 模式下未提交事务')
    assert.strictEqual(fs.existsSync(targetPluginDir), false, '目标目录绝对未在磁盘建立')
  })

  // 4. 迁移转换引擎与事务提交测试
  it('代码转换与事务提交：生成 <plugin>-ztools 副本并注入 SDK 与同步垫片，保留换行符', () => {
    const res = migrate(samplePluginDir, targetPluginDir)
    assert.strictEqual(res.success, true)
    assert.strictEqual(res.committed, true)
    assert.strictEqual(fs.existsSync(targetPluginDir), true, '目标目录成功建立')

    // 检查 Manifest 归一化
    const normManifestPath = path.join(targetPluginDir, 'plugin.json')
    assert.strictEqual(fs.existsSync(normManifestPath), true)
    const normManifest = JSON.parse(fs.readFileSync(normManifestPath, 'utf8'))
    assert.ok(normManifest.id, '生成了合法的规范插件 ID')
    assert.strictEqual(normManifest.entry, 'index.html')
    assert.ok(Array.isArray(normManifest.triggers), '成功生成 triggers 数组')
    assert.ok(normManifest.triggers.length >= 4, 'triggers 覆盖全部关键字与正则')

    // 检查原 Manifest 证据备份
    const utoolsManifestPath = path.join(targetPluginDir, 'plugin.utools.json')
    assert.strictEqual(fs.existsSync(utoolsManifestPath), true, '备份了原 plugin.utools.json')

    // 检查 HTML 脚本注入
    const targetHtmlPath = path.join(targetPluginDir, 'index.html')
    const targetHtml = fs.readFileSync(targetHtmlPath, 'utf8')
    assert.ok(targetHtml.includes('ztools://web/sdk/ztools-api.js'), '成功注入 ZTools API SDK')
    assert.ok(targetHtml.includes('utools-db-sync-shim.js'), '成功注入同步数据库垫片脚本')

    // 检查换行符保留
    assert.strictEqual(LineEndingHelper.detect(targetHtml), 'CRLF', 'index.html 严格保留原有 CRLF 换行符')
    const targetBat = fs.readFileSync(path.join(targetPluginDir, 'run.bat'), 'utf8')
    assert.strictEqual(LineEndingHelper.detect(targetBat), 'CRLF', 'run.bat 保持 CRLF 换行符')
    const targetApp = fs.readFileSync(path.join(targetPluginDir, 'app.js'), 'utf8')
    assert.strictEqual(LineEndingHelper.detect(targetApp), 'LF', 'app.js 保持 LF 换行符')

    // 检查同步数据库垫片植入
    const shimPath = path.join(targetPluginDir, 'utools-db-sync-shim.js')
    assert.strictEqual(fs.existsSync(shimPath), true, '成功生成 utools-db-sync-shim.js')

    // 检查元数据记录
    const metaPath = path.join(targetPluginDir, '.ztools-migration.json')
    assert.strictEqual(fs.existsSync(metaPath), true, '成功写入 .ztools-migration.json')
  })

  // 5. 异常中断与自动原子回滚测试
  it('异常中断与原子回滚：中间步骤出错时 100% 逆向撤销已应用变更', () => {
    // 构造一个计划并在第 3 步注入合成错误
    let caughtError: any = null
    try {
      migrate(samplePluginDir, targetPluginDir, {
        _syntheticErrorAtStep: 3
      })
    } catch (err: any) {
      caughtError = err
    }

    assert.ok(caughtError instanceof TransactionAbortedError, '成功捕获 TransactionAbortedError 异常')
    assert.strictEqual(caughtError.rollbackResult.totalReverted >= 2, true, '回滚记录已撤销 2 项已应用变更')

    // 校验目标目录未遗留半成品
    const leftoverFiles = fs.existsSync(targetPluginDir)
      ? fs.readdirSync(targetPluginDir).filter(f => f !== '.ztools-backups')
      : []
    assert.strictEqual(leftoverFiles.length, 0, '目标目录无任何半成品残留文件')
  })

  // 6. 显式 --rollback 事务回滚测试
  it('--rollback：从迁移记录中干净回滚目标目录', () => {
    // 1. 先执行一次正常迁移
    migrate(samplePluginDir, targetPluginDir)
    assert.strictEqual(fs.existsSync(path.join(targetPluginDir, 'plugin.json')), true)

    // 2. 执行回滚
    const rollbackRes = rollback(targetPluginDir)
    assert.ok(rollbackRes.totalReverted > 0, '回滚处理了已迁移的文件')

    // 3. 验证元数据与专有垫片被安全清理
    assert.strictEqual(fs.existsSync(path.join(targetPluginDir, '.ztools-migration.json')), false)
    assert.strictEqual(fs.existsSync(path.join(targetPluginDir, 'utools-db-sync-shim.js')), false)
  })

  // 7. 幂等性测试
  it('幂等性：重复执行迁移不会重复注入 script 标签', () => {
    // 第一次迁移
    migrate(samplePluginDir, targetPluginDir)
    const firstHtml = fs.readFileSync(path.join(targetPluginDir, 'index.html'), 'utf8')

    // 第二次迁移
    migrate(samplePluginDir, targetPluginDir)
    const secondHtml = fs.readFileSync(path.join(targetPluginDir, 'index.html'), 'utf8')

    assert.strictEqual(firstHtml, secondHtml, '二次迁移保持内容完全一致')

    // 验证 script 标签仅出现一次
    const matches = secondHtml.match(/ztools:\/\/web\/sdk\/ztools-api\.js/g)
    assert.strictEqual(matches?.length, 1, 'ztools-api.js 严格只注入一次')
  })
})
