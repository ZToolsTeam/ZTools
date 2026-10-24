#!/usr/bin/env node
/**
 * E2E 测试入口
 *
 * 测试模块按目录自动发现：只运行本目录中实际存在的“两位数字-名称.cjs”文件，
 * 按文件名（数字前缀）顺序执行，数字前缀即依赖顺序：
 *  01 系统基础 + 版本兼容性   （无依赖，验证运行环境）
 *  02 数据库操作              （无依赖）
 *  03 配置管理 + 主题切换     （无依赖）
 *  04 事件系统 + 触发器       （无依赖）
 *  06 插件市场 + 更新 + 卸载  （依赖版本 API）
 *  07 我的页面               （依赖 config API）
 *  08 高级设置               （依赖 config + trigger API）
 *  09 通知系统               （依赖 sys API）
 *  11 集成工作流             （依赖前面所有模块）
 *  12 性能测试 + 错误处理    （放最后，不影响其他状态）
 *
 * 使用方法：
 *   node scripts/e2e-test/index.cjs
 *   node scripts/e2e-test/index.cjs --verbose
 *   node scripts/e2e-test/index.cjs --test=插件市场
 */

const fs = require('fs')
const path = require('path')
const { logger, TestRunner } = require('./runner.cjs')

const MODULE_FILE_PATTERN = /^\d{2}-[^/\\]+\.cjs$/

function discoverModules() {
  return fs
    .readdirSync(__dirname)
    .filter((name) => MODULE_FILE_PATTERN.test(name))
    .sort()
}

async function main() {
  logger.section('前端 E2E 完整测试')

  const devtoolsPath = path.join(__dirname, '../../devtools')
  if (!fs.existsSync(devtoolsPath)) {
    logger.error(`DevTools 路径不存在: ${devtoolsPath}`)
    logger.error('请先安装 devtools 依赖: cd frontend/devtools && npm install')
    process.exit(1)
  }

  const runner = new TestRunner()

  for (const mod of discoverModules()) {
    const suite = require(path.join(__dirname, mod))
    await suite(runner)
  }

  const success = runner.printSummary()
  process.exit(success ? 0 : 1)
}

main().catch((err) => {
  logger.error(`测试运行失败: ${err.message}`)
  process.exit(1)
})
