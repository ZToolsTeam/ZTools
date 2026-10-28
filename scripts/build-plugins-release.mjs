#!/usr/bin/env node

/**
 * build-plugins-release.mjs
 * ZTools GitOps 自动化打包与发布流水线脚本
 *
 * 功能：
 * 1. 自动遍历 plugins/{author}/{plugin-id} 目录结构（兼容 plugins/{plugin-id}）；
 * 2. 对每个插件执行 Schema 强校验与安全 AST 扫描门禁；
 * 3. 校验合规的插件打包为 {plugin-id}-{version}.zip；
 * 4. 计算并记录每个发布包的 SHA-256 校验和与文件大小；
 * 5. 自动生成包含全量插件元数据的静态全网索引 plugins.json（经阿里云 CDN 分发给客户端）；
 * 6. 支持模块化导出与独立 CLI 执行。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { scanPluginSecurity } from './scan-plugin-security.mjs'
import { getManifestPlatforms, validateStoreCatalog, OFFICIAL_PLUGIN_IDS } from '../packages/ztools-plugins-spec/src/validator.js'
import { resolvePluginMinAppVersion } from '../packages/ztools-plugins-spec/src/host-requirements.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

/**
 * 使用纯 Node.js 标准库制作 ZIP 二进制 Buffer
 * 保证跨平台（Windows/macOS/Linux/CI）零外部依赖、确定性与高效打包
 */
export function createZipArchiveFromDirectory(sourceDir, filterFn = null) {
  const files = []

  function walk(currentDir, baseRelative = '') {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (['node_modules', '.git', '.DS_Store', 'Thumbs.db', '.build-runs'].includes(entry.name)) {
        continue
      }
      // 真机截图不进安装包：安装包公开可下载，截图里可能拍到个人信息，客户端运行也用不到
      if (entry.isDirectory() && entry.name.toLowerCase() === 'screenshots') {
        continue
      }
      const fullPath = path.join(currentDir, entry.name)
      const relPath = path.join(baseRelative, entry.name).replace(/\\/g, '/')

      if (filterFn && !filterFn(relPath, fullPath)) {
        continue
      }

      if (entry.isDirectory()) {
        walk(fullPath, relPath)
      } else if (entry.isFile()) {
        const data = fs.readFileSync(fullPath)
        files.push({ name: relPath, data })
      }
    }
  }

  walk(sourceDir)

  // 保证打包内文件顺序确定性
  files.sort((a, b) => a.name.localeCompare(b.name))

  const localHeaders = []
  const centralHeaders = []
  let offset = 0

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8')
    const dataBuf = file.data
    const uncompressedSize = dataBuf.length
    const fileCrc = zlib.crc32(dataBuf)
    const compressedData = zlib.deflateRawSync(dataBuf)
    const compressedSize = compressedData.length

    // Local file header (30 bytes + name length)
    const localHeader = Buffer.alloc(30 + nameBuf.length)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4) // version needed to extract
    localHeader.writeUInt16LE(0, 6)  // flags
    localHeader.writeUInt16LE(8, 8)  // deflate
    localHeader.writeUInt16LE(0, 10) // dos time
    localHeader.writeUInt16LE(0, 12) // dos date
    localHeader.writeUInt32LE(fileCrc, 14)
    localHeader.writeUInt32LE(compressedSize, 18)
    localHeader.writeUInt32LE(uncompressedSize, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28) // extra field length
    nameBuf.copy(localHeader, 30)

    // Central directory file header (46 bytes + name length)
    const centralHeader = Buffer.alloc(46 + nameBuf.length)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0, 8)  // flags
    centralHeader.writeUInt16LE(8, 10) // deflate
    centralHeader.writeUInt16LE(0, 12) // dos time
    centralHeader.writeUInt16LE(0, 14) // dos date
    centralHeader.writeUInt32LE(fileCrc, 16)
    centralHeader.writeUInt32LE(compressedSize, 20)
    centralHeader.writeUInt32LE(uncompressedSize, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra field length
    centralHeader.writeUInt16LE(0, 32) // comment length
    centralHeader.writeUInt16LE(0, 34) // disk number start
    centralHeader.writeUInt16LE(0, 36) // internal file attributes
    centralHeader.writeUInt32LE(0, 38) // external file attributes
    centralHeader.writeUInt32LE(offset, 42) // relative offset
    nameBuf.copy(centralHeader, 46)

    localHeaders.push(localHeader, compressedData)
    centralHeaders.push(centralHeader)
    offset += localHeader.length + compressedData.length
  }

  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0)
  const endRecord = Buffer.alloc(22)
  endRecord.writeUInt32LE(0x06054b50, 0)
  endRecord.writeUInt16LE(0, 4) // disk number
  endRecord.writeUInt16LE(0, 6) // disk start
  endRecord.writeUInt16LE(files.length, 8)  // total entries this disk
  endRecord.writeUInt16LE(files.length, 10) // total entries
  endRecord.writeUInt32LE(centralDirSize, 12)
  endRecord.writeUInt32LE(offset, 16)
  endRecord.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, endRecord])
}

/**
 * 遍历发现插件目录列表
 * 支持两级 plugins/{author}/{plugin-id} 及单级 plugins/{plugin-id}
 */
export function discoverPluginDirectories(basePluginsDir) {
  const absBase = path.resolve(basePluginsDir)
  if (!fs.existsSync(absBase)) return []

  const pluginEntries = []

  // 1. 如果 basePluginsDir 本身就是一个插件（直接包含 plugin.json）
  if (fs.existsSync(path.join(absBase, 'plugin.json'))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(absBase, 'plugin.json'), 'utf8'))
    const authorStr = typeof manifest.author === 'string'
      ? manifest.author
      : (manifest.author?.name || 'unknown')
    return [{
      author: authorStr,
      pluginId: manifest.id || path.basename(absBase),
      dir: absBase
    }]
  }

  const level1 = fs.readdirSync(absBase, { withFileTypes: true })
  for (const l1 of level1) {
    if (!l1.isDirectory() || ['node_modules', '.git', 'dist'].includes(l1.name)) continue
    const l1Path = path.join(absBase, l1.name)

    // 检查是否为单级插件目录 plugins/{plugin-id}/plugin.json
    if (fs.existsSync(path.join(l1Path, 'plugin.json'))) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(l1Path, 'plugin.json'), 'utf8'))
        const authorStr = typeof manifest.author === 'string'
          ? manifest.author
          : (manifest.author?.name || 'community')
        pluginEntries.push({
          author: authorStr,
          pluginId: manifest.id || l1.name,
          dir: l1Path
        })
      } catch {}
      continue
    }

    // 检查是否为标准两级目录 plugins/{author}/{plugin-id}/plugin.json
    const level2 = fs.readdirSync(l1Path, { withFileTypes: true })
    for (const l2 of level2) {
      if (!l2.isDirectory()) continue
      const l2Path = path.join(l1Path, l2.name)
      if (fs.existsSync(path.join(l2Path, 'plugin.json'))) {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(l2Path, 'plugin.json'), 'utf8'))
          pluginEntries.push({
            author: l1.name,
            pluginId: manifest.id || l2.name,
            dir: l2Path
          })
        } catch {}
      }
    }
  }

  return pluginEntries
}

/**
 * 执行自动化打包与发布物索引生成
 * @param {object} options
 * @param {string} [options.pluginsDir] - 插件源码所在根目录
 * @param {string} [options.outputDir] - 发布物输出目录
 * @param {string} [options.cdnBaseUrl] - CDN 基础 URL
 * @param {boolean} [options.failFast] - 遇错立即退出
 * @param {boolean} [options.skipScan] - 是否跳过安全扫描（默认 false）
 * @returns {Promise<{
 *   success: boolean,
 *   total: number,
 *   passedCount: number,
 *   rejectedCount: number,
 *   draftIds: string[],
 *   pluginsIndex: object,
 *   publishedPackages: Array<{ pluginId: string, version: string, zipPath: string, sha256: string, size: number }>
 * }>}
 */
export async function buildPluginsRelease(options = {}) {
  const pluginsDir = path.resolve(options.pluginsDir || path.join(rootDir, 'plugins'))
  const outputDir = path.resolve(options.outputDir || path.join(rootDir, 'dist/plugins'))
  const cdnBaseUrl = (options.cdnBaseUrl || process.env.CDN_BASE_URL || 'https://cdn.ztools.cn').replace(/\/$/, '')
  const urlPrefix = (options.urlPrefix !== undefined ? String(options.urlPrefix) : (process.env.PLUGIN_URL_PREFIX || 'plugins-v2')).replace(/^\/+|\/+$/g, '')
  const failFast = !!options.failFast
  const skipScan = !!options.skipScan

  fs.mkdirSync(outputDir, { recursive: true })

  console.log('🚀 开始执行 ZTools GitOps 插件打包与发布流程...')
  console.log(`📂 插件扫描源: ${pluginsDir}`)
  console.log(`📦 产物输出目录: ${outputDir}`)
  console.log(`🌐 静态 CDN 域名: ${cdnBaseUrl}${urlPrefix ? '/' + urlPrefix : ''}\n`)

  const pluginEntries = discoverPluginDirectories(pluginsDir)
  if (pluginEntries.length === 0) {
    console.warn(`⚠️ 未在目录 ${pluginsDir} 下发现有效的插件工程！`)
    const emptyIndex = {
      schemaVersion: '2.0.0',
      generatedAt: new Date().toISOString(),
      cdnBaseUrl,
      total: 0,
      list: [],
      plugins: []
    }
    fs.writeFileSync(path.join(outputDir, 'plugins.json'), JSON.stringify(emptyIndex, null, 2), 'utf8')
    fs.writeFileSync(path.join(outputDir, 'catalog.json'), JSON.stringify({ success: true, ...emptyIndex }, null, 2), 'utf8')
    return {
      success: true,
      total: 0,
      passedCount: 0,
      rejectedCount: 0,
      draftIds: [],
      pluginsIndex: emptyIndex,
      publishedPackages: []
    }
  }

  const publishedPackages = []
  const catalogList = []
  const draftIds = []
  let rejectedCount = 0

  for (const entry of pluginEntries) {
    const { author, pluginId, dir } = entry
    const authorSlug = String(author || 'official')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'official'
    console.log(`\n------------------------------------------------------------`)
    console.log(`🔨 正在处理插件: [${authorSlug}/${pluginId}] (路径: ${dir})`)

    const manifestPath = path.join(dir, 'plugin.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const version = manifest.version || '1.0.0'

    // 下架开关：plugin.json 写 "revoked": true 后，目录里只保留下架记录（不扫描、不打包、不提供下载），
    // 客户端刷新目录时据此禁用已安装的该插件。有问题的插件也能立刻下架，不会被扫描失败挡住。
    if (manifest.revoked === true) {
      const reason = typeof manifest.revokedReason === 'string' && manifest.revokedReason.trim()
        ? manifest.revokedReason.trim()
        : '该插件已被官方下架禁用'
      console.warn(`⛔ [${pluginId}] 已下架，只写入下架记录: ${reason}`)
      catalogList.push({
        id: manifest.id || pluginId,
        pluginId: manifest.id || pluginId,
        name: manifest.name || pluginId,
        version,
        description: manifest.description || '',
        author: manifest.author,
        revoked: true,
        revokedReason: reason,
        revoked_reason: reason,
        publishedAt: new Date().toISOString()
      })
      continue
    }

    // 草稿：plugin.json 写 "draft": true 表示功能还没做完（例如只有示例数据），仓库里照常编译、扫描、跑测试，
    // 但不打包、不进插件目录，用户在插件市场里看不到。做完后删掉 draft 字段，PR 合并后由官方发布到插件市场。
    if (manifest.draft === true) {
      const reason = typeof manifest.draftReason === 'string' && manifest.draftReason.trim() ? manifest.draftReason.trim() : '未说明'
      console.warn(`📝 [${pluginId}] 是草稿，本次不发布: ${reason}`)
      draftIds.push(manifest.id || pluginId)
      continue
    }

    // 1. 安全 AST 扫描与 Schema 门禁
    let scanResult = null
    if (!skipScan) {
      scanResult = await scanPluginSecurity(dir)
      if (!scanResult.passed) {
        console.error(`❌ [${pluginId}] 安全审计门禁未通过，拒绝打包发布:`)
        for (const v of scanResult.violations) {
          console.error(`   - [${v.rule}] ${v.file}:${v.line}:${v.column} -> ${v.message}`)
        }
        rejectedCount++
        if (failFast) {
          throw new Error(`插件 ${pluginId} 安全审计失败，构建中止！`)
        }
        continue
      }
      console.log(`✅ [${pluginId}] AST 安全扫描通过！`)
      if (scanResult.requiresTwoManReview) {
        console.warn(`⚠️  [${pluginId}] 触发双人人工复核 (Two-Man Rule): ${scanResult.twoManReviewReasons.join('; ')}`)
      }
    }

    // 2. 打包为 ZIP 文件
    const zipFileName = `${pluginId}-${version}.zip`
    const pluginOutputDir = path.join(outputDir, authorSlug, pluginId)
    fs.mkdirSync(pluginOutputDir, { recursive: true })

    const zipFilePath = path.join(pluginOutputDir, zipFileName)
    console.log(`📦 正在生成 ZIP 发布包: ${zipFileName}...`)

    const zipBuffer = createZipArchiveFromDirectory(dir)
    fs.writeFileSync(zipFilePath, zipBuffer)

    // 3. 计算 SHA256 校验和与包体大小
    const sha256 = crypto.createHash('sha256').update(zipBuffer).digest('hex')
    const size = zipBuffer.length

    console.log(`✓ 压缩打包完成: 大小 ${(size / 1024).toFixed(2)} KB, SHA256 = ${sha256}`)

    const relPrefix = urlPrefix ? `${urlPrefix}/${authorSlug}/${pluginId}` : `${authorSlug}/${pluginId}`
    const downloadRelPath = `${relPrefix}/${zipFileName}`
    const downloadUrl = `${cdnBaseUrl}/${downloadRelPath}`

    // 4. 拷贝图标至输出目录以便 CDN 静态分发
    let iconUrl = manifest.icon
    if (manifest.icon && fs.existsSync(path.join(dir, manifest.icon))) {
      const iconExt = path.extname(manifest.icon)
      const iconTargetName = `icon${iconExt}`
      const iconTargetPath = path.join(pluginOutputDir, iconTargetName)
      fs.copyFileSync(path.join(dir, manifest.icon), iconTargetPath)
      iconUrl = `${cdnBaseUrl}/${relPrefix}/${iconTargetName}`
    }

    const twoManReviewStatus = (scanResult && scanResult.requiresTwoManReview)
      ? { required: true, reasons: scanResult.twoManReviewReasons, status: 'pending' }
      : { required: false, reasons: [], status: 'approved' }

    // 官方标记只看维护者维护的官方名单（packages/ztools-plugins-spec/official-ids.json），不看作者名或目录名：
    // 作者名谁都能写，按作者名判断会让社区插件拿到官方标记
    const isOfficial = OFFICIAL_PLUGIN_IDS.has(manifest.id)

    const { minAppVersion, apis: requiredHostApis } = resolvePluginMinAppVersion(dir, manifest)
    if (minAppVersion) {
      console.log(`ℹ 最低客户端版本 ${minAppVersion}${requiredHostApis.length ? `（用到 ${requiredHostApis.join('、')}）` : ''}`)
    }

    const pluginMetadata = {
      id: manifest.id,
      pluginId: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      author: manifest.author,
      category: manifest.category || [],
      keywords: manifest.keywords || [],
      permissions: manifest.permissions || [],
      icon: iconUrl,
      entry: manifest.entry,
      minZToolsVersion: manifest.minZToolsVersion || '2.0.0',
      // 客户端只认 minAppVersion：低于它时不提供更新、安装前提示先升级客户端
      ...(minAppVersion ? { minAppVersion } : {}),
      requireAdmin: !!manifest.requireAdmin,
      // 平台声明由 plugin.json 的 targets 决定（安全扫描已校验必填与格式），不再默认填「双端」
      targets: manifest.targets,
      // 便于客户端与市场直接展示：'windows' / 'macos' 的子集
      platforms: getManifestPlatforms(manifest),
      nativeComponents: Array.isArray(manifest.nativeComponents) ? manifest.nativeComponents : [],
      is_official: isOfficial,
      official_badge: isOfficial ? '官方自营' : '',
      window: manifest.window,
      features: manifest.features || [],
      downloadUrl,
      sha256,
      checksum: sha256,
      size,
      file_size: size,
      twoManReview: twoManReviewStatus,
      publishedAt: new Date().toISOString()
    }

    catalogList.push(pluginMetadata)
    publishedPackages.push({
      author: authorSlug,
      pluginId,
      version,
      zipPath: zipFilePath,
      sha256,
      size,
      downloadUrl
    })
  }

  // 5. 生成包含全量插件元数据的静态全网索引 plugins.json 与 catalog.json
  const generatedAt = new Date().toISOString()
  const pluginsIndex = {
    schemaVersion: '2.0.0',
    generatedAt,
    cdnBaseUrl,
    total: catalogList.length,
    list: catalogList,
    plugins: catalogList
  }

  // 写出前整体校验：插件 ID 重复、版本号或下载信息不合法时不生成目录
  const catalogCheck = validateStoreCatalog(pluginsIndex)
  if (!catalogCheck.valid) {
    throw new Error(`插件目录校验失败，已停止生成:\n  - ${catalogCheck.errors.join('\n  - ')}`)
  }

  const indexPath = path.join(outputDir, 'plugins.json')
  fs.writeFileSync(indexPath, JSON.stringify(pluginsIndex, null, 2), 'utf8')

  const catalogPath = path.join(outputDir, 'catalog.json')
  fs.writeFileSync(catalogPath, JSON.stringify({ success: true, ...pluginsIndex }, null, 2), 'utf8')

  console.log(`\n============================================================`)
  console.log(`📄 静态全网索引 plugins.json & catalog.json 已生成: ${indexPath}`)
  console.log(`📊 统计: 共发现 ${pluginEntries.length} 个插件，成功打包 ${catalogList.length} 个，拦截拒绝 ${rejectedCount} 个，草稿未发布 ${draftIds.length} 个`)
  console.log(`============================================================\n`)

  return {
    success: rejectedCount === 0,
    total: pluginEntries.length,
    passedCount: catalogList.length,
    rejectedCount,
    draftIds,
    pluginsIndex,
    publishedPackages
  }
}

async function runCli() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
用法:
  node scripts/build-plugins-release.mjs [选项]

选项:
  --plugins-dir <path>    插件源码根目录 (默认: plugins)
  --output-dir <path>     产物输出目录 (默认: dist/plugins)
  --cdn-base-url <url>    静态分发 CDN 域名 (默认: https://cdn.ztools.cn)
  --url-prefix <prefix>   CDN 相对路径前缀 (默认: plugins-v2，即阿里云 OSS 上的目录)
  --fail-fast             遇错立即退出
  --skip-scan             跳过安全扫描 (仅限调试)
  --help, -h              显示帮助信息
    `.trim())
    process.exit(0)
  }

  function getArg(flag, fallback) {
    const idx = args.indexOf(flag)
    if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]
    return fallback
  }

  const pluginsDir = getArg('--plugins-dir', path.join(rootDir, 'plugins'))
  const outputDir = getArg('--output-dir', path.join(rootDir, 'dist/plugins'))
  const cdnBaseUrl = getArg('--cdn-base-url', process.env.CDN_BASE_URL || 'https://cdn.ztools.cn')
  const urlPrefix = getArg('--url-prefix', process.env.PLUGIN_URL_PREFIX || 'plugins-v2')
  const failFast = args.includes('--fail-fast')
  const skipScan = args.includes('--skip-scan')

  const result = await buildPluginsRelease({
    pluginsDir,
    outputDir,
    cdnBaseUrl,
    urlPrefix,
    failFast,
    skipScan
  })

  if (!result.success) {
    console.error('❌ 发布流水线构建失败：存在被安全门禁拦截的插件！')
    process.exit(1)
  } else {
    console.log('🎉 插件发布流水线打包与全网静态索引构建圆满完成！')
    process.exit(0)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runCli().catch(err => {
    console.error('构建发生异常:', err)
    process.exit(1)
  })
}
