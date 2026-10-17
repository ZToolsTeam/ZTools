/**
 * Build Script - 打包脚本
 * 将所有模块文件合并成单个文件
 * 使用方法: node build.cjs
 */
const fs = require('fs')
const path = require('path')

// 配置
const config = {
  srcDir: path.join(__dirname, 'src'),
  distDir: path.join(__dirname, '../../sdk'),
  outputFile: 'ztools-api.js',
  minify: false // 是否压缩(需要安装 terser)
}
const skipLegacyBinDeploy = process.env.ZTOOLS_BUILD_TARGET === 'electron' ||
  process.env.ZTOOLS_SKIP_LEGACY_BIN_DEPLOY === '1'

// 按依赖顺序定义文件列表
const files = [
  // 通信层(核心,无依赖)
  'core/environment.js', // 环境检测(最先加载,无依赖)
  'core/native-tooltip.js', // 全局接管 CEF title，转交宿主原生 Tooltip
  'core/mock-provider.js', // Mock 数据提供者
  'core/transport.js',
  'core/reference-transport.js', // SDK2 cancellation source; activated with contract migration
  'core/events.js',

  // 业务API层(依赖transport)
  'api/fs.js',
  'api/fs-reference.js', // SDK2 source; client activation waits for complete contract migration
  'api/db.js',
  'api/credentials.js', // OS-protected, versioned plugin credential store
  'api/sys.js',
  'api/runtime-capability.js', // shared Main/plugin screen authorization preflight
  'api/window.js',
  'api/plugin.js',
  'api/settings.js',
  'api/config.js',
  'api/user.js',
  'api/protocol.js', // 🆕 高性能协议API

  // 新增API层 (类似 uTools API)
  'api/clipboard.js',
  'api/screen.js',
  'api/file-producers-reference.js', // SDK2 source, no legacy path producer activation
  'api/shell.js',

  // Phase 1 新增API (2025-11-21)
  'api/network.js',
  'api/network-reference.js', // SDK2 FileRef/SaveRef transfer source
  'api/process.js',
  'api/ocr-reference.js',
  'api/ocr.js',
  'api/trigger.js',
  'api/privileged.js',
  'api/update.js',

  // Phase 2 新增API (2025-11-21) - DLL插件方式
  'api/image.js',
  'api/image-reference.js',
  'api/ffmpeg.js',

  // DLL 插件 API
  'api/dllplugin.js',

  // Screenshot API (依赖 dllplugin)
  'api/screenshot.js',

  // Zip API (依赖 dllplugin)
  'api/zip.js',
  'api/sqlite-reference.js',

  // 埋点上报 API
  'api/analytics.js',

  // 客户端组装(依赖所有模块)
  'client.js',

  // 入口文件(最后执行)
  'index.js'
]

// plugin-sdk.js 的可维护源码位于 frontend/src/sdk；若已迁移至 public/sdk 则直接复用。
function syncPluginSdkSource() {
  const sourcePath = path.resolve(__dirname, '../../../src/sdk/plugin-sdk.js')
  const outputPath = path.join(config.distDir, 'plugin-sdk.js')
  if (!fs.existsSync(sourcePath)) {
    if (fs.existsSync(outputPath)) {
      return
    }
    throw new Error(`Plugin SDK 源文件不存在: ${sourcePath}`)
  }

  const outputEol = fs.existsSync(outputPath) &&
      fs.readFileSync(outputPath, 'utf8').includes('\r\n')
    ? '\r\n'
    : '\n'
  const source = fs.readFileSync(sourcePath, 'utf8')
  const output = source.replace(/\r\n?/g, '\n').replace(/\n/g, outputEol)
  fs.writeFileSync(outputPath, output, 'utf8')
}

// 主函数
function build() {
  console.log('🚀 开始打包 ZTools API...\n')

  // 确保输出目录存在
  if (!fs.existsSync(config.distDir)) {
    fs.mkdirSync(config.distDir, { recursive: true })
  }

  // 开始构建
  let output = ''

  // 添加文件头注释
  output += generateHeader()

  // 添加IIFE包装开始
  output += '(function() {\n'
  output += '    "use strict";\n\n'

  // 读取并合并所有文件
  let totalLines = 0
  files.forEach((file, index) => {
    const filePath = path.join(config.srcDir, file)

    if (!fs.existsSync(filePath)) {
      console.error(`❌ 文件不存在: ${file}`)
      process.exit(1)
    }

    console.log(`📦 处理文件 [${index + 1}/${files.length}]: ${file}`)

    let content = fs.readFileSync(filePath, 'utf8')

    // 移除文件顶部的注释块(保留代码注释)
    content = removeHeaderComments(content)

    // 移除 import/export 语句
    content = removeImportExport(content)

    // 移除 IIFE 包装(如果有)
    content = removeIIFE(content)

    // 添加文件分隔注释
    output += `    // ========================================\n`
    output += `    // ${file}\n`
    output += `    // ========================================\n\n`

    // 添加文件内容(缩进4个空格)
    const lines = content.split('\n')
    totalLines += lines.length
    lines.forEach((line) => {
      if (line.trim()) {
        output += '    ' + line + '\n'
      } else {
        output += '\n'
      }
    })

    output += '\n'
  })

  // 添加IIFE包装结束
  output += '})();\n'

  // 写入输出文件
  const outputPath = path.join(config.distDir, config.outputFile)
  fs.writeFileSync(outputPath, output, 'utf8')
  syncPluginSdkSource()

  // 统计信息
  const stats = fs.statSync(outputPath)
  const sizeKB = (stats.size / 1024).toFixed(2)

  console.log('\n✅ 打包完成!')
  console.log(`📄 输出文件: ${outputPath}`)
  console.log(`📊 文件大小: ${sizeKB} KB`)
  console.log(`📝 总行数: ${totalLines}`)
  console.log(`📦 合并文件数: ${files.length}`)

  // 如果需要压缩
  if (config.minify) {
    minifyOutput(outputPath)
  }

  // 自动复制到其他位置
  copyToOutputDirectories(outputPath)
}

// 复制到插件 SDK 和兼容运行目录；Electron 装配跳过 legacy bin 副本。
function copyToOutputDirectories(sourcePath) {
  console.log('\n📋 开始复制文件到输出目录...')

  const projectRoot = path.resolve(__dirname, '../../../..')
  const sdkSource = path.join(__dirname, '../../sdk')
  const pluginSdkSource = path.join(sdkSource, 'plugin-sdk.js')

  // 目标目录列表
  const targetDirs = [
    ...(!skipLegacyBinDeploy ? [{
      dir: path.join(projectRoot, 'bin/WebResources/sdk'),
      label: 'bin/WebResources/sdk'
    }] : []),
    {
      dir: path.join(projectRoot, 'packages/api/runtime'),
      label: 'packages/api/runtime'
    }
  ]

  if (skipLegacyBinDeploy) {
    console.log('⏭️ Electron 装配跳过 bin/WebResources/sdk（legacy Windows运行目录）')
  }

  for (const { dir, label } of targetDirs) {
    // 确保目标目录存在
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // 复制 ztools-api.js
    try {
      fs.copyFileSync(sourcePath, path.join(dir, 'ztools-api.js'))
      console.log(`  ✅ 已复制到: ${label}/ztools-api.js`)
    } catch (error) {
      console.warn(
        `  ⚠️  复制 ztools-api.js 到 ${label} 失败: ${error.message}`
      )
    }

    // 复制 plugin-sdk.js（如果存在）
    if (fs.existsSync(pluginSdkSource)) {
      try {
        fs.copyFileSync(pluginSdkSource, path.join(dir, 'plugin-sdk.js'))
        console.log(`  ✅ 已复制到: ${label}/plugin-sdk.js`)
      } catch (error) {
        console.warn(
          `  ⚠️  复制 plugin-sdk.js 到 ${label} 失败: ${error.message}`
        )
      }
    }
  }

  console.log(`\n🎉 SDK 文件已同步到所有目标目录`)
}

// 生成文件头注释
// 不写入构建日期：产物只由源码决定，重复构建不会让已跟踪的 SDK 副本（packages/api/runtime）产生无意义改动
function generateHeader() {
  return `/**
 * ZTools API - 统一前端接口
 *
 * 这是一个自动生成的文件,请勿直接修改!
 * 如需修改,请编辑 src/ 目录下的源文件,然后重新运行 build.js
 *
 * 版本: 2.0.0
 *
 * 使用方法:
 *   <script src="sdk/ztools-api.js"></script>
 *   <script>
 *     // 全局变量 ztools 自动可用
 *     await ztools.fs.readFile('test.txt');
 *     await ztools.db.get('plugin-id', 'key');
 *     await ztools.sys.notify('标题', '内容');
 *   </script>
 */

`
}

// 移除文件顶部的注释块
function removeHeaderComments(content) {
  // 移除顶部的 // ==== 形式的注释块
  const lines = content.split('\n')
  let startIndex = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (
      line.startsWith('// ====') ||
      line.startsWith('// 职责:') ||
      line.startsWith('// 使用方法:') ||
      (line.startsWith('//') &&
        line.length < 80 &&
        !line.includes('function') &&
        !line.includes('class'))
    ) {
      startIndex = i + 1
    } else if (line && !line.startsWith('//')) {
      break
    }
  }

  return lines.slice(startIndex).join('\n')
}

// 移除 import/export 语句
function removeImportExport(content) {
  const lines = content.split('\n')
  const filteredLines = []
  let skippingExportList = false
  for (const line of lines) {
    const trimmed = line.trim()

    if (skippingExportList) {
      if (trimmed.includes('}')) skippingExportList = false
      continue
    }

    // This builder manually concatenates every dependency, so module imports and
    // re-export lists are omitted. Keep executable declarations while removing
    // only their module-scope export keyword.
    if (trimmed.startsWith('import ')) continue
    if (/^export\s*\{/.test(trimmed)) {
      if (!trimmed.includes('}')) skippingExportList = true
      continue
    }
    if (/^export\s+default\s+/.test(trimmed)) {
      if (/^export\s+default\s+(?:async\s+)?(?:function|class)\b/.test(trimmed)) {
        filteredLines.push(line.replace(/^\s*export\s+default\s+/, match => match.replace(/export\s+default\s+/, '')))
      }
      continue
    }
    if (/^export\s+(?:async\s+)?(?:function|class|const|let|var)\b/.test(trimmed)) {
      filteredLines.push(line.replace(/^\s*export\s+/, match => match.replace(/export\s+/, '')))
      continue
    }
    if (/^export\b/.test(trimmed)) throw new Error(`无法合并的 export 语句: ${trimmed}`)
    filteredLines.push(line)
  }
  return filteredLines.join('\n')
}

// 移除 IIFE 包装
function removeIIFE(content) {
  content = content.trim()

  // 移除开头的 (function() { 或 (function(){
  if (content.startsWith('(function()')) {
    const firstBrace = content.indexOf('{')
    if (firstBrace !== -1) {
      content = content.substring(firstBrace + 1)
    }
  }

  // 移除结尾的 })(); 或 })()
  if (content.endsWith('})();') || content.endsWith('})()')) {
    const lastBrace = content.lastIndexOf('}')
    if (lastBrace !== -1) {
      content = content.substring(0, lastBrace)
    }
  }

  // 移除开头的 "use strict";
  content = content.replace(/^\s*["']use strict["'];?\s*\n?/, '')

  return content.trim()
}

// 压缩输出(可选)
function minifyOutput(outputPath) {
  try {
    const terser = require('terser')
    console.log('\n🔧 开始压缩...')

    const code = fs.readFileSync(outputPath, 'utf8')
    const result = terser.minify(code, {
      compress: {
        dead_code: true,
        drop_console: false,
        drop_debugger: true
      },
      mangle: false, // 不混淆变量名,保持可读性
      output: {
        comments: /^!/ // 保留 /*! */ 形式的注释
      }
    })

    if (result.error) {
      console.error('❌ 压缩失败:', result.error)
      return
    }

    const minPath = outputPath.replace('.js', '.min.js')
    fs.writeFileSync(minPath, result.code, 'utf8')

    const stats = fs.statSync(minPath)
    const sizeKB = (stats.size / 1024).toFixed(2)

    console.log(`✅ 压缩完成: ${minPath}`)
    console.log(`📊 压缩后大小: ${sizeKB} KB`)
  } catch (error) {
    console.warn('⚠️  压缩失败(需要安装 terser): npm install terser')
  }
}

// 执行构建
try {
  build()
} catch (error) {
  console.error('❌ 构建失败:', error)
  process.exit(1)
}
