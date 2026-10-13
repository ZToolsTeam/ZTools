#!/usr/bin/env node
/**
 * 测试主入口
 *
 * 用法：
 *   node runner.main.cjs                    # 运行全部测试
 *   node runner.main.cjs --suite=api        # 只运行 API 测试
 *   node runner.main.cjs --suite=e2e        # 只运行 E2E 测试
 *   node runner.main.cjs --filter=数据库     # 按名称过滤测试套件
 *   node runner.main.cjs --verbose          # 详细输出
 *   node runner.main.cjs --port=9222        # 指定 CDP 端口
 *
 * 前置条件：
 *   1. ZTools 正在运行且开启了 CDP 调试端口（默认 9222）
 *   2. 已安装依赖：cd frontend/__test__ && npm install
 */

const fs = require('fs')
const path = require('path')
const { CONFIG, log, TestRunner } = require('./runner.cjs')

// API 测试模块
const API_MODULES = [
  'api/01-system.cjs',
  'api/02-database.cjs',
  'api/03-config.cjs',
  'api/04-filesystem.cjs',
  'api/05-plugin.cjs',
  'api/06-window.cjs',
]

// E2E 测试模块
const E2E_MODULES = [
  'e2e/01-page-navigation.cjs',
  'e2e/02-store-state.cjs',
  'e2e/03-dom-render.cjs',
  'e2e/04-theme-switch.cjs',
  'e2e/05-performance.cjs',
  'e2e/06-plugin-market.cjs',
  'e2e/07-settings.cjs',
  'e2e/08-feedback.cjs',
  'e2e/09-user-auth.cjs',
  'e2e/10-my-page.cjs',
]

async function main() {
  const startTime = Date.now()

  log.section('ZTools 前端测试')
  console.log(`  CDP 端口: ${CONFIG.port}`)
  console.log(`  测试范围: ${CONFIG.suite || '全部'}`)
  if (CONFIG.filter) console.log(`  过滤条件: ${CONFIG.filter}`)
  if (CONFIG.verbose) console.log(`  详细模式: 开启`)

  const runner = new TestRunner()

  try {
    // 连接 CDP
    await runner.ensureConnected()

    // 确定要运行的模块
    let modules = []
    if (!CONFIG.suite || CONFIG.suite === 'api') {
      modules = modules.concat(API_MODULES)
    }
    if (!CONFIG.suite || CONFIG.suite === 'e2e') {
      modules = modules.concat(E2E_MODULES)
    }

    // 逐个加载并运行
    for (const mod of modules) {
      const modPath = path.join(__dirname, mod)
      if (!fs.existsSync(modPath)) {
        log.warn(`模块不存在，跳过: ${mod}`)
        continue
      }
      const suite = require(modPath)
      await suite(runner)
    }

    // 汇总
    const success = runner.printSummary()
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`  耗时: ${elapsed}s\n`)

    runner.close()
    process.exit(success ? 0 : 1)
  } catch (err) {
    log.fail(`测试运行失败: ${err.message}`)
    if (CONFIG.verbose && err.stack) {
      console.error(err.stack)
    }
    runner.close()
    process.exit(1)
  }
}

main()
