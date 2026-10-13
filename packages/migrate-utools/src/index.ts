/**
 * index.ts
 * Main entry point and CLI implementation for @ztools/migrate
 */

import path from 'node:path'
import { StaticScanAnalyzer, COMPAT_TIERS } from './scanner.ts'
import { TransformerEngine } from './transformer.ts'
import { TransactionManager, TransactionAbortedError } from './transaction.ts'
import { normalizeManifest } from './manifest.ts'
import { LineEndingHelper } from './helpers/line-ending.ts'
import { ChecksumHelper } from './helpers/checksum.ts'
import { GitSafetyGuard } from './helpers/git-guard.ts'
import type { CliOptions, ScanResult, TransactionResult, RollbackResult } from './types.ts'

export {
  StaticScanAnalyzer,
  COMPAT_TIERS,
  TransformerEngine,
  TransactionManager,
  TransactionAbortedError,
  normalizeManifest,
  LineEndingHelper,
  ChecksumHelper,
  GitSafetyGuard
}

export * from './types.ts'

// Terminal colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
}

function colorize(color: keyof typeof colors, text: string): string {
  if (process.env.NO_COLOR || !process.stdout.isTTY) return text
  return `${colors[color] || ''}${text}${colors.reset}`
}

export function printHelp(): void {
  console.log(`
${colorize('bold', 'ZTools uTools 插件迁移 CLI 工具 (@ztools/migrate)')}

${colorize('cyan', '用法:')}
  ztools-migrate <sourceDir> [targetDir] [选项]

${colorize('cyan', '核心模式与选项:')}
  --analyze-only            仅静态扫描分析，计算 API 覆盖度、就绪度评分与风险提示 (不修改文件)
  --dry-run                 预演模式，仅推演生成 Diff 计划，绝对零触碰磁盘
  --rollback                执行事务原子回滚，从迁移记录或快照恢复初始状态
  --allow-dirty             允许目标目录包含未提交 Git 改动
  --plugin-id <id>          显式指定 ZTools 规范的插件 ID (^[a-z][a-z0-9-]*$)
  --json                    输出结构化 JSON 报告
  -v, --version             显示工具版本信息
  -h, --help                显示本帮助信息

${colorize('cyan', '示例:')}
  ztools-migrate ./my-utools-plugin --analyze-only
  ztools-migrate ./my-utools-plugin ./my-plugin-ztools --dry-run
  ztools-migrate ./my-utools-plugin ./my-plugin-ztools
  ztools-migrate ./my-plugin-ztools --rollback
`)
}

export function parseArgs(argv: string[]): CliOptions & { help?: boolean; version?: boolean } {
  const flags = new Set(argv.filter(a => a.startsWith('-')))
  const positional = argv.filter(a => !a.startsWith('-'))

  let pluginId: string | undefined
  const pidIndex = argv.indexOf('--plugin-id')
  if (pidIndex !== -1 && argv[pidIndex + 1] && !argv[pidIndex + 1].startsWith('-')) {
    pluginId = argv[pidIndex + 1]
  }

  const options: CliOptions & { help?: boolean; version?: boolean } = {
    sourceDir: positional[0] || '',
    targetDir: positional[1],
    dryRun: flags.has('--dry-run'),
    analyzeOnly: flags.has('--analyze-only'),
    rollback: flags.has('--rollback'),
    allowDirty: flags.has('--allow-dirty'),
    json: flags.has('--json'),
    help: flags.has('-h') || flags.has('--help'),
    version: flags.has('-v') || flags.has('--version')
  }

  if (pluginId) {
    options.pluginId = pluginId
  }

  return options
}

/**
 * Format colorized scan report to stdout
 */
export function printScanReport(scanResult: ScanResult): void {
  const hr = colorize('dim', '═'.repeat(70))
  const subHr = colorize('dim', '─'.repeat(70))

  console.log(hr)
  console.log(colorize('bold', '  ZTools uTools 插件兼容性静态扫描评估报告'))
  console.log(hr)

  console.log(`\n  插件名称:   ${colorize('bold', scanResult.manifest.name || '未知')}`)
  console.log(`  版本编号:   ${scanResult.manifest.version || '1.0.0'}`)
  console.log(`  运行模式:   ${scanResult.manifest.mode}`)
  console.log(`  特性指令:   ${scanResult.manifest.featuresCount} 个 Feature / ${scanResult.manifest.cmdsCount} 条指令`)

  console.log(`\n${subHr}`)
  console.log(colorize('bold', '  [迁移就绪度评分]'))
  const scoreColor = scanResult.readinessScore >= 80 ? 'green' : (scanResult.readinessScore >= 50 ? 'yellow' : 'red')
  console.log(`  评分:       ${colorize(scoreColor, `${scanResult.readinessScore} / 100`)}`)
  console.log(`  兼容评级:   ${colorize('magenta', scanResult.tier.title)} (${scanResult.tier.code})`)
  console.log(`  评级说明:   ${scanResult.tier.description}`)

  console.log(`\n${subHr}`)
  console.log(colorize('bold', '  [uTools API 调用覆盖分析]'))
  console.log(`  API 调用总数:   ${scanResult.apiUsage.totalCalls} 处`)
  console.log(`  涉及独立 API:   ${scanResult.apiUsage.uniqueApisCount} 个`)
  console.log(`  已有对等支持:   ${colorize('green', `${scanResult.apiUsage.coveredApisCount} 个`)}`)
  console.log(`  未实现接口:     ${scanResult.apiUsage.uncoveredApisCount > 0 ? colorize('yellow', `${scanResult.apiUsage.uncoveredApisCount} 个`) : '0 个'}`)
  console.log(`  覆盖度比例:     ${colorize(scoreColor, `${scanResult.apiUsage.coveragePercent}%`)}`)

  if (scanResult.apiUsage.details.length > 0) {
    console.log('\n  API 使用清单:')
    for (const item of scanResult.apiUsage.details) {
      const syncBadge = item.isSync ? colorize('yellow', '[SYNC]') : colorize('dim', '[ASYNC]')
      console.log(`    ${syncBadge} ${item.api.padEnd(28)} x${item.count} -> ${item.ztoolsCounterpart}`)
    }
  }

  if (scanResult.nodeUsage.modules.length > 0) {
    console.log(`\n${subHr}`)
    console.log(colorize('bold', '  [Node.js 模块使用]'))
    for (const m of scanResult.nodeUsage.modules) {
      console.log(`    - ${m.module.padEnd(16)} (${m.count} 处调用)`)
    }
  }

  if (scanResult.risks.length > 0) {
    console.log(`\n${subHr}`)
    console.log(colorize('bold', '  [风险评估与适配建议]'))
    for (const r of scanResult.risks) {
      const badge = r.level === 'CRITICAL' ? colorize('red', '[CRITICAL]') : (r.level === 'HIGH' ? colorize('red', '[HIGH]') : colorize('yellow', '[WARN]'))
      console.log(`  ${badge} ${r.message}`)
      if (r.remedy) {
        console.log(colorize('dim', `         建议: ${r.remedy}`))
      }
    }
  }

  console.log(`\n${hr}\n`)
}

/**
 * Format plan and transaction result to stdout
 */
export function printTransactionReport(res: TransactionResult): void {
  const hr = colorize('dim', '═'.repeat(70))
  console.log(hr)
  if (res.isDryRun) {
    console.log(colorize('bold', '  ✔ 预演推演完成 (DRY-RUN 模式，零磁盘写入)'))
  } else {
    console.log(colorize('green', `  ✔ 迁移事务提交成功！已安全应用 ${res.appliedCount} 项文件操作。`))
  }
  console.log(hr)
  console.log(`  源工程目录:   ${res.plan.sourceDir}`)
  console.log(`  目标工程目录: ${res.plan.targetDir}`)
  console.log(`  拟新建文件:   ${res.plan.summary.create}`)
  console.log(`  拟修改文件:   ${res.plan.summary.modify}`)
  console.log(`  拟删除文件:   ${res.plan.summary.delete}`)
  console.log(`  保留不变:     ${res.plan.summary.retain}`)
  if (res.backupPath) {
    console.log(colorize('dim', `  快照备份路径: ${res.backupPath}`))
  }
  console.log(`${hr}\n`)
}

/**
 * High-level programmatic API: analyze
 */
export function analyze(sourceDir: string): ScanResult {
  return StaticScanAnalyzer.scan(sourceDir)
}

/**
 * High-level programmatic API: migrate
 */
export function migrate(
  sourceDir: string,
  targetDir?: string,
  options: {
    dryRun?: boolean
    pluginId?: string
    strictTargets?: boolean
    allowDirty?: boolean
    backup?: boolean
    _syntheticErrorAtStep?: number
  } = {}
): TransactionResult {
  const target = targetDir || `${path.resolve(sourceDir)}-ztools`
  const plan = TransactionManager.createPlan(sourceDir, target, options)
  return TransactionManager.executeTransaction(plan, options)
}

/**
 * High-level programmatic API: rollback
 */
export function rollback(targetDir: string): RollbackResult {
  return TransactionManager.rollbackTarget(targetDir)
}

/**
 * CLI Main execution function
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)

  if (options.help) {
    printHelp()
    return
  }

  if (options.version) {
    console.log('1.0.0')
    return
  }

  if (options.rollback) {
    const target = options.sourceDir || options.targetDir
    if (!target) {
      console.error(colorize('red', '错误: 请指定需要执行回滚的目标目录。'))
      process.exit(1)
    }
    console.log(colorize('yellow', `正在回滚目标目录: ${target}...`))
    try {
      const res = rollback(target)
      console.log(colorize('green', `✔ 回滚成功: 已清理 ${res.deletedCount} 项新增文件，恢复 ${res.restoredCount} 项原文件。`))
      return
    } catch (err: any) {
      console.error(colorize('red', `✖ 回滚失败: ${err.message}`))
      process.exit(1)
    }
  }

  if (!options.sourceDir) {
    console.error(colorize('red', '错误: 缺少源插件目录参数。'))
    printHelp()
    process.exit(1)
  }

  // 1. Analyze-only mode
  if (options.analyzeOnly) {
    try {
      const scanResult = analyze(options.sourceDir)
      if (options.json) {
        console.log(JSON.stringify(scanResult, null, 2))
      } else {
        printScanReport(scanResult)
      }
      return
    } catch (err: any) {
      console.error(colorize('red', `✖ 分析失败: ${err.message}`))
      process.exit(1)
    }
  }

  // 2. Migration execution (dry-run or commit)
  const targetDir = options.targetDir || `${path.resolve(options.sourceDir)}-ztools`

  try {
    const plan = TransactionManager.createPlan(options.sourceDir, targetDir, options)

    if (options.dryRun) {
      const res = TransactionManager.executeTransaction(plan, { dryRun: true })
      if (options.json) {
        console.log(JSON.stringify(res, null, 2))
      } else {
        printTransactionReport(res)
      }
      return
    }

    const res = TransactionManager.executeTransaction(plan, options)
    if (options.json) {
      console.log(JSON.stringify(res, null, 2))
    } else {
      printTransactionReport(res)
    }
  } catch (err: any) {
    if (err instanceof TransactionAbortedError) {
      console.error(colorize('red', `\n✖ 迁移事务异常中断并已全量回滚: ${err.message}`))
      console.error(`  回滚文件统计: 撤销新建 ${err.rollbackResult.deletedCount} 项, 还原文件 ${err.rollbackResult.restoredCount} 项`)
    } else {
      console.error(colorize('red', `\n✖ 执行失败: ${err.message}`))
    }
    process.exit(1)
  }
}
