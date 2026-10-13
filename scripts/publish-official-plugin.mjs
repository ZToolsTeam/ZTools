#!/usr/bin/env node

/**
 * publish-official-plugin.mjs
 * ZTools 闭源自营成品包发布 CLI 脚本
 *
 * 使用示例：
 *   node scripts/publish-official-plugin.mjs ./dist/my-plugin.zip
 *   node scripts/publish-official-plugin.mjs ./dist/my-plugin.zip --id official.calc --version 1.0.0 --badge "官方推荐" --dry-run
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  publishOfficialPlugin,
  computePackageSha256,
  extractManifestFromZipBuffer,
  validateAndNormalizeMetadata
} from '../backend/src/services/official-publisher.service.ts'

export function parseArgs(args = process.argv.slice(2)) {
  const options = {
    zipPath: '',
    metadata: {},
    skipUpload: false,
    skipDb: false,
    dryRun: false,
    json: false,
    help: false
  }

  const positional = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
      options.skipUpload = true
      options.skipDb = true
    } else if (arg === '--skip-upload') {
      options.skipUpload = true
    } else if (arg === '--skip-db') {
      options.skipDb = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--id' && i + 1 < args.length) {
      options.metadata.plugin_id = args[++i]
    } else if (arg === '--version' && i + 1 < args.length) {
      options.metadata.version = args[++i]
    } else if (arg === '--name' && i + 1 < args.length) {
      options.metadata.name = args[++i]
    } else if (arg === '--desc' && i + 1 < args.length) {
      options.metadata.description = args[++i]
    } else if (arg === '--author' && i + 1 < args.length) {
      options.metadata.author = args[++i]
    } else if (arg === '--badge' && i + 1 < args.length) {
      options.metadata.official_badge = args[++i]
    } else if (arg === '--homepage' && i + 1 < args.length) {
      options.metadata.homepage_url = args[++i]
    } else if (arg === '--platforms' && i + 1 < args.length) {
      options.metadata.platforms = args[++i].split(',').map((s) => s.trim())
    } else if (arg === '--sha256' && i + 1 < args.length) {
      options.metadata.sha256 = args[++i]
    } else if (arg === '--release-notes' && i + 1 < args.length) {
      options.metadata.release_notes = args[++i]
    } else if (!arg.startsWith('-')) {
      positional.push(arg)
    }
  }

  if (positional.length > 0) {
    options.zipPath = positional[0]
  }

  return options
}

export function printHelp() {
  console.log(`
ZTools 闭源自营成品包发布 CLI 脚本
==================================================

用法:
  node scripts/publish-official-plugin.mjs <zip-path> [选项]

参数:
  <zip-path>                   打包完成的自营插件 .zip 文件路径 (必填)

选项:
  --id <pluginId>             插件唯一标识符 (例如: official.calc)
  --version <version>         版本号 (符合 SemVer 2.0，如 1.0.0)
  --name <name>               插件显示名称
  --desc <description>        插件描述
  --author <author>           插件作者 (默认: ZTools Official)
  --badge <badge>             官方徽标标识 (默认: Official)
  --homepage <url>            官网或项目主页 URL
  --platforms <platforms>     支持平台，逗号分隔 (例如: windows,macos)
  --sha256 <sha256>           预期的 SHA-256 校验和 (可选强校验)
  --release-notes <notes>     版本更新说明
  --dry-run                   仿真模式：仅做校验与哈希计算，不上传不写入数据库
  --skip-upload               跳过 OSS/CDN 上传
  --skip-db                   跳过数据库入库
  --json                      以 JSON 格式输出结果
  -h, --help                  显示帮助信息
`)
}

export async function publishOfficialPluginCli(args = process.argv.slice(2)) {
  const options = parseArgs(args)

  if (options.help) {
    printHelp()
    return { success: true, help: true }
  }

  if (!options.zipPath) {
    console.error('❌ 错误: 缺少必填参数 <zip-path>')
    printHelp()
    process.exitCode = 1
    return { success: false, error: '缺少 zip-path 参数' }
  }

  try {
    const result = await publishOfficialPlugin({
      zipPath: options.zipPath,
      metadata: options.metadata,
      skipUpload: options.skipUpload,
      skipDb: options.skipDb
    })

    if (options.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`
==================================================
🚀 ZTools 自营插件发布成功！
==================================================
插件标识:   ${result.pluginId}
版本编号:   ${result.version}
包体大小:   ${result.fileSize} 字节 (${(result.fileSize / 1024).toFixed(2)} KB)
SHA-256:    ${result.sha256}
OSS 存储路径: ${result.ossKey}
CDN 下载地址: ${result.downloadUrl}
官方徽标:   ${result.metadata.official_badge || 'Official'}
支持平台:   ${(result.metadata.platforms || []).join(', ')}
${options.dryRun ? '⚠️  [仿真模式] 未执行实际网络上传与数据库写入' : '✅ 已成功上传 OSS 并同步数据库版本记录'}
==================================================
`)
    }

    return result
  } catch (err) {
    process.exitCode = 1
    if (options.json) {
      console.error(JSON.stringify({ success: false, error: err.message }))
    } else {
      console.error(`❌ 发布失败: ${err.message}`)
    }
    return { success: false, error: err.message }
  }
}

// 直接作为 CLI 脚本执行时调用
const isDirectCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isDirectCli) {
  publishOfficialPluginCli()
}
