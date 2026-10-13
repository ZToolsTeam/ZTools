#!/usr/bin/env node

/**
 * ingest-raycast-extension.mjs
 * ZTools Raycast 官方生态扩展自动化接入、安全门禁与 TSX 编译流水线
 *
 * 功能：
 * 1. 解析官方扩展 package.json 清单（commands, preferences, arguments）；
 * 2. 静态审计平台兼容性与安全门禁：拦截 macOS 专有（AppleScript/osascript）与恶意混淆代码；
 * 3. 使用 esbuild 将 TSX/JSX 零配置编译为标准化 Bundle，无缝桥接 @ztools/raycast-compat；
 * 4. 自动生成符合 ZTools GitOps 规范的 plugin.json 与资产包；
 * 5. 支持作为 Node.js 库函数导入，亦支持 CLI 独立执行。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

// 获取 esbuild 实例
let cachedEsbuild = null
export async function getEsbuild() {
  if (cachedEsbuild) return cachedEsbuild
  const candidates = [
    path.join(rootDir, 'frontend/node_modules/esbuild/lib/main.js'),
    path.join(rootDir, 'node_modules/esbuild/lib/main.js')
  ]
  for (const cand of candidates) {
    if (fs.existsSync(cand)) {
      const mod = await import(pathToFileURL(cand).href)
      cachedEsbuild = mod.default || mod
      return cachedEsbuild
    }
  }
  try {
    const resolved = require.resolve('esbuild')
    const mod = await import(pathToFileURL(resolved).href)
    cachedEsbuild = mod.default || mod
    return cachedEsbuild
  } catch {}
  throw new Error('未找到可用 esbuild 编译器！请检查 frontend/node_modules/esbuild 是否存在。')
}

/**
 * 平台与跨端专有代码静态审计
 */
export function auditPlatformCompatibility(extDir, manifest) {
  const issues = []
  let isMacOnly = false

  // 1. 检查 package.json platforms 声明
  if (Array.isArray(manifest.platforms)) {
    if (manifest.platforms.length === 1 && manifest.platforms[0].toLowerCase() === 'macos') {
      isMacOnly = true
      issues.push({
        type: 'PLATFORM_RESTRICTION',
        severity: 'blocking',
        message: '扩展清单 platforms 明确声明仅支持 macOS，物理缺少 Windows/跨端支持。'
      })
    }
  }

  // 2. 检查 dependencies 中的 macOS 专有库
  const allDeps = {
    ...(manifest.dependencies || {}),
    ...(manifest.devDependencies || {})
  }
  const macOnlyPackages = ['run-applescript', 'applescript', 'node-osascript', 'fsevents-compat']
  for (const pkg of macOnlyPackages) {
    if (allDeps[pkg]) {
      isMacOnly = true
      issues.push({
        type: 'MACOS_EXCLUSIVE_DEPENDENCY',
        severity: 'blocking',
        message: `依赖包含 macOS 专有库 "${pkg}"，在非 macOS 环境下无法物理执行。`
      })
    }
  }

  // 3. 递归扫描源码关键字 (runAppleScript, osascript)
  function scanSource(dir) {
    if (!fs.existsSync(dir)) return
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (['node_modules', '.git', 'dist'].includes(entry.name)) continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        scanSource(fullPath)
      } else if (/\.(tsx|ts|jsx|js|mjs)$/i.test(entry.name)) {
        const content = fs.readFileSync(fullPath, 'utf8')
        if (/runAppleScript|osascript\s+-e|NSAppleScript/i.test(content)) {
          isMacOnly = true
          issues.push({
            type: 'MACOS_SCRIPT_CALL',
            severity: 'blocking',
            file: path.relative(extDir, fullPath).replace(/\\/g, '/'),
            message: '源码中包含 AppleScript/osascript 硬件调用，Windows 宿主无法穿透执行。'
          })
        }
      }
    }
  }

  scanSource(path.join(extDir, 'src'))

  return {
    isCompatible: !isMacOnly,
    isMacOnly,
    issues
  }
}

/**
 * 将 Raycast 扩展构建转换为 ZTools 标准插件包
 * @param {string} extDir - Raycast 扩展根目录
 * @param {object} options - 构建配置
 * @param {string} [options.outDir] - 输出目录
 * @param {boolean} [options.allowMacOnly] - 是否强制构建 macOS 专有插件
 * @param {boolean} [options.minify] - 是否压缩产物
 */
export async function ingestRaycastExtension(extDir, options = {}) {
  const absExtDir = path.resolve(extDir)
  const pkgJsonPath = path.join(absExtDir, 'package.json')

  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`目录中不存在 package.json: ${absExtDir}`)
  }

  const manifest = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
  const authorName = typeof manifest.author === 'string' ? manifest.author : (manifest.author?.name || 'community')
  const extName = manifest.name || path.basename(absExtDir)
  const title = manifest.title || extName
  const version = manifest.version || '1.0.0'
  const description = manifest.description || ''

  console.log(`📦 正在介入并转译 Raycast 扩展: ${title} (${authorName}/${extName}) v${version}`)

  // 1. 平台兼容性审计
  const audit = auditPlatformCompatibility(absExtDir, manifest)
  if (!audit.isCompatible && !options.allowMacOnly) {
    const errorMsg = audit.issues.map(i => ` - [${i.type}] ${i.message}`).join('\n')
    throw new Error(`扩展 "${title}" 存在系统专有阻抗，无法直接跨端接入:\n${errorMsg}`)
  }

  // 1.5 源码级安全审计（检查源码是否包含 eval、动态混淆等高危语法）
  if (!options.skipSecurityScan) {
    function checkSourceFiles(dir) {
      if (!fs.existsSync(dir)) return
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (['node_modules', '.git', 'dist'].includes(entry.name)) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          checkSourceFiles(full)
        } else if (/\.(tsx|ts|jsx|js|mjs)$/i.test(entry.name)) {
          const content = fs.readFileSync(full, 'utf8')
          if (/\beval\s*\(|new\s+Function\s*\(|_\s*0x[a-f0-9]{4,}/i.test(content)) {
            throw new Error(`扩展源码 "${entry.name}" 触发安全红线: 检测到 eval / new Function 动态代码执行或混淆`)
          }
        }
      }
    }
    checkSourceFiles(path.join(absExtDir, 'src'))
  }

  // 2. 准备输出目录
  const outDir = path.resolve(options.outDir || path.join(rootDir, 'dist/plugins', authorName, extName))
  const outDist = path.join(outDir, 'dist')
  fs.mkdirSync(outDist, { recursive: true })

  // 3. 解析 commands
  const commands = Array.isArray(manifest.commands) ? manifest.commands : []
  if (commands.length === 0) {
    throw new Error(`扩展 ${extName} 未声明任何可执行 commands`)
  }

  const esbuild = await getEsbuild()
  const raycastCompatDist = path.join(rootDir, 'packages/raycast-compat/dist/index.js')
  const raycastUtilsDist = path.join(rootDir, 'packages/raycast-compat/dist/utils/index.js')

  const ztoolsFeatures = []

  // 4. 逐个编译 commands 为标准 Bundle
  for (const cmd of commands) {
    const cmdName = cmd.name
    const cmdTitle = cmd.title || cmdName
    const cmdMode = cmd.mode || 'view'

    // 寻找入口文件
    const possibleEntries = [
      path.join(absExtDir, `src/${cmdName}.tsx`),
      path.join(absExtDir, `src/${cmdName}.ts`),
      path.join(absExtDir, `src/${cmdName}.jsx`),
      path.join(absExtDir, `src/${cmdName}.js`),
      path.join(absExtDir, `src/${cmdName}/index.tsx`),
      path.join(absExtDir, `src/${cmdName}/index.ts`),
      path.join(absExtDir, 'src/index.tsx'),
      path.join(absExtDir, 'src/index.ts')
    ]

    let entryPath = possibleEntries.find(p => fs.existsSync(p))
    if (!entryPath) {
      console.warn(`⚠️ 命令 "${cmdName}" 未找到有效入口文件，已跳过。`)
      continue
    }

    const bundleFileName = `${cmdName}.bundle.js`
    const bundleOutputPath = path.join(outDist, bundleFileName)

    // 执行 esbuild 打包编译
    const buildResult = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      outfile: bundleOutputPath,
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      minify: options.minify ?? false,
      sourcemap: false,
      jsx: 'transform',
      jsxFactory: 'React.createElement',
      jsxFragment: 'React.Fragment',
      banner: {
        js: `// ZTools Auto-Generated Bundle from Raycast Extension: ${extName}\n` +
            `import React from "@raycast/api";\n`
      },
      plugins: [
        {
          name: 'raycast-compat-resolver',
          setup(build) {
            // 将 @raycast/api 外部化为裸模块名，通过 NODE_PATH 解析宿主自带 API
            build.onResolve({ filter: /^@raycast\/api$/ }, () => {
              return { path: '@raycast/api', external: true }
            })
            // 将 @raycast/utils 外部化为裸模块名
            build.onResolve({ filter: /^@raycast\/utils$/ }, () => {
              return { path: '@raycast/utils', external: true }
            })
            // 将 react / react-dom 外部化为指向 @raycast/api 导出
            build.onResolve({ filter: /^react(\/.*)?$/ }, () => {
              return { path: '@raycast/api', external: true }
            })
            // 拦截外部 Node 原生模块
            build.onResolve({ filter: /^(net|child_process|fs|path)$/ }, (args) => {
              return { path: args.path, external: true }
            })
          }
        }
      ]
    })

    if (buildResult.errors && buildResult.errors.length > 0) {
      throw new Error(`编译命令 "${cmdName}" 失败: ${JSON.stringify(buildResult.errors)}`)
    }

    ztoolsFeatures.push({
      code: cmdName,
      name: cmdTitle,
      description: cmd.description || '',
      type: cmdMode === 'view' ? 'declarative' : 'background',
      entry: `dist/${bundleFileName}`,
      arguments: cmd.arguments || [],
      preferences: cmd.preferences || []
    })

    console.log(`  ✓ 成功编译 command [${cmdName}] -> dist/${bundleFileName}`)
  }

  // 5. 复制图标与静态资产
  const iconCandidates = [manifest.icon, 'icon.png', 'extension-icon.png', 'assets/icon.png'].filter(Boolean)
  let copiedIcon = null
  for (const iconName of iconCandidates) {
    const srcIcon = path.join(absExtDir, iconName)
    if (fs.existsSync(srcIcon)) {
      const destIcon = path.join(outDir, path.basename(iconName))
      fs.copyFileSync(srcIcon, destIcon)
      copiedIcon = path.basename(iconName)
      break
    }
  }

  if (fs.existsSync(path.join(absExtDir, 'assets'))) {
    const destAssets = path.join(outDir, 'assets')
    fs.mkdirSync(destAssets, { recursive: true })
    fs.cpSync(path.join(absExtDir, 'assets'), destAssets, { recursive: true })
  }

  // 6. 生成 ZTools 标准 plugin.json
  const pluginManifest = {
    id: `raycast.${extName}`,
    name: title,
    version,
    description,
    author: {
      name: authorName,
      origin: 'raycast-extension'
    },
    category: (manifest.categories && manifest.categories[0]) || 'tools',
    logo: copiedIcon || 'icon.png',
    type: 'declarative',
    runtime: 'raycast-compat',
    features: ztoolsFeatures,
    preferences: manifest.preferences || []
  }

  fs.writeFileSync(path.join(outDir, 'plugin.json'), JSON.stringify(pluginManifest, null, 2), 'utf8')
  console.log(`✨ 成功输出 ZTools 插件清单: ${path.join(outDir, 'plugin.json')}\n`)

  return {
    success: true,
    extName,
    title,
    author: authorName,
    outDir,
    features: ztoolsFeatures,
    pluginManifest
  }
}

// 支持 CLI 独立执行
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const targetDir = process.argv[2]
  if (!targetDir) {
    console.log('用法: node scripts/ingest-raycast-extension.mjs <raycast-extension-dir> [--out-dir <dir>]')
    process.exit(1)
  }
  ingestRaycastExtension(targetDir)
    .then(res => {
      console.log(`🎉 扩展接入成功: ${res.title}`)
    })
    .catch(err => {
      console.error(`❌ 接入失败: ${err.message}`)
      process.exit(1)
    })
}
