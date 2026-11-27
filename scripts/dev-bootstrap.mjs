#!/usr/bin/env node

/**
 * dev-bootstrap.mjs
 * ZTools 跨平台（Windows / macOS）零门槛依赖安装与一键启动引导器
 *
 * 解决外部开发者克隆开源仓库后的 3 个痛点：
 * 1. 根目录执行 `npm install` 时，自动通过 postinstall 检查并补齐 `frontend` 与 `electron-client` 的依赖；
 * 2. 根目录执行 `npm run dev` 时，自动识别当前操作系统（Windows / macOS）：
 *    - macOS: 自动调用 `start:mac` 构建并拉起 Electron；
 *    - Windows: 自动检测本机是否具备 CMake + VS C++ 编译环境；若无 C++ 环境（或编译可选 32 位 NativeHost32 失败），
 *      自动降级跳过 C++ 编译，直接编译 TypeScript + Vue 前端并启动 Electron 宿主。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureDist } from '../packages/declarative-ui/scripts/ensure-dist.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(__dirname, '..')
export const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend')
export const CLIENT_DIR = path.join(ROOT_DIR, 'electron-client')

export function resolveNpmRunner(env = process.env, platform = process.platform) {
  const npmExecPath = env.npm_execpath
  if (npmExecPath && fs.existsSync(npmExecPath)) {
    return {
      command: process.execPath,
      baseArgs: [npmExecPath],
      shell: false
    }
  }
  const npmBin = platform === 'win32' ? 'npm.cmd' : 'npm'
  return {
    command: npmBin,
    baseArgs: [],
    shell: platform === 'win32'
  }
}

export function sanitizeSubprojectEnv(env = process.env, cwd = '') {
  const cleaned = { ...env }
  for (const key of Object.keys(cleaned)) {
    if (key === 'npm_execpath') continue
    if (key === 'INIT_CWD' || key.startsWith('npm_')) {
      delete cleaned[key]
    }
  }
  if (cwd) {
    cleaned.INIT_CWD = cwd
  }
  return cleaned
}

export function runNpm(args, cwd, { env = process.env, platform = process.platform, runner = spawnSync } = {}) {
  const { command, baseArgs, shell } = resolveNpmRunner(env, platform)
  const subEnv = sanitizeSubprojectEnv(env, cwd)
  const result = runner(command, [...baseArgs, ...args], {
    cwd,
    env: subEnv,
    stdio: 'inherit',
    shell
  })
  if (result.error) throw result.error
  return result.status ?? 1
}

/**
 * 检查子目录依赖是否已安装，若缺失则自动执行 npm install
 */
export function ensureSubprojectDependencies({
  rootDir = ROOT_DIR,
  runner = spawnSync,
  env = process.env,
  platform = process.platform,
  log = console.log
} = {}) {
  const subprojects = [
    {
      name: 'electron-client',
      dir: path.join(rootDir, 'electron-client'),
      probe: path.join(rootDir, 'electron-client', 'node_modules', 'typescript', 'bin', 'tsc')
    },
    {
      name: 'frontend',
      dir: path.join(rootDir, 'frontend'),
      probe: path.join(rootDir, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js')
    }
  ]

  const installed = []
  for (const sub of subprojects) {
    if (!fs.existsSync(path.join(sub.dir, 'package.json'))) continue
    if (!fs.existsSync(sub.probe)) {
      log(`📦 [bootstrap] 检测到 ${sub.name} 尚未安装依赖，正在自动执行 npm install...`)
      let code = runNpm(
        ['install', '--legacy-peer-deps', '--no-audit', '--no-fund', '--workspaces=false'],
        sub.dir,
        {
          env,
          platform,
          runner
        }
      )
      if (code !== 0) {
        log(`⚠️ [bootstrap] ${sub.name} 首次安装遇到跨平台锁文件冲突，正在清理 package-lock.json 并自动重试...`)
        try {
          fs.rmSync(path.join(sub.dir, 'package-lock.json'), { force: true })
          fs.rmSync(path.join(sub.dir, 'node_modules'), { recursive: true, force: true })
        } catch {
          // 忽略清理异常
        }
        code = runNpm(
          ['install', '--legacy-peer-deps', '--no-package-lock', '--no-audit', '--no-fund', '--workspaces=false'],
          sub.dir,
          { env, platform, runner }
        )
      }
      if (code !== 0) {
        throw new Error(`${sub.name} 依赖安装失败（退出码 ${code}）`)
      }
      installed.push(sub.name)
    }
  }

  // 确保 @ztools/declarative-ui 的 dist 产物就绪
  ensureDist({
    root: path.join(rootDir, 'packages', 'declarative-ui'),
    repo: rootDir,
    run: runner,
    log
  })

  // 确保前端未纳入 Git 跟踪的内置插件生成配置就绪（供根级测试或外部脚本直接 import）
  const syncBundledScript = path.join(rootDir, 'frontend', 'scripts', 'sync-bundled-plugins.mjs')
  const generatedBundledConfig = path.join(rootDir, 'frontend', 'src', 'config', 'bundledPlugins.generated.js')
  if (fs.existsSync(syncBundledScript) && !fs.existsSync(generatedBundledConfig)) {
    const syncRes = runner(process.execPath, [syncBundledScript, '--ensure'], {
      cwd: path.join(rootDir, 'frontend'),
      env,
      stdio: 'inherit'
    })
    if (syncRes?.error) throw syncRes.error
    if ((syncRes?.status ?? 1) !== 0) {
      throw new Error(`生成内置插件索引配置失败（退出码 ${syncRes?.status ?? 1}）`)
    }
  }

  return { installed }
}

const IGNORED_SCAN_DIRS = new Set(['node_modules', 'dist', 'out', '.git', '__tests__', 'coverage', '.ztools-dev'])
const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/i
export const DEV_SANDBOX_DIR_NAME = '.ztools-dev'
export const DEV_DATA_DIR_NAME = 'DataV2'
export const DEV_TRUST_DIR_NAME = 'DevTrust'
export const DEV_COMMONLIBS_PUBLIC_KEYS_FILE = 'commonlibs-dev-public-keys.json'

/**
 * 组装开发测试版启动传给 Electron 的隔离参数：
 * - 默认将业务数据根定位至 <rootDir>/.ztools-dev/DataV2（与安装版 %APPDATA%\ZTools\DataV2 物理同构且彻底隔离）；
 * - 默认开启 --dev-allow-drafts（加载全部非下架插件含草稿插件），可通过 includeDrafts=false 关闭；
 * - 若 .ztools-dev/DevTrust/commonlibs-dev-public-keys.json 存在，附加开发公钥路径供非打包宿主合并验签。
 */
export function buildDevElectronArgs({
  rootDir = ROOT_DIR,
  includeDrafts = true,
  extraArgs = []
} = {}) {
  const normalizedExtra = Array.isArray(extraArgs) ? extraArgs.filter((a) => typeof a === 'string' && a.trim().length > 0) : []
  const hasExplicitDataRoot = normalizedExtra.some((a) => a.startsWith('--data-root='))
  const hasExplicitDraftFlag = normalizedExtra.includes('--dev-allow-drafts') || normalizedExtra.includes('--dev-exclude-drafts')
  const hasExplicitCommonLibsKeys = normalizedExtra.some((a) => a.startsWith('--dev-commonlibs-public-keys='))

  const sandboxRoot = path.join(path.resolve(rootDir), DEV_SANDBOX_DIR_NAME)
  const devDataRoot = path.join(sandboxRoot, DEV_DATA_DIR_NAME)
  const devPublicKeysPath = path.join(sandboxRoot, DEV_TRUST_DIR_NAME, DEV_COMMONLIBS_PUBLIC_KEYS_FILE)

  const args = []
  if (!hasExplicitDataRoot) {
    args.push(`--data-root=${devDataRoot}`)
  }
  if (!hasExplicitDraftFlag) {
    args.push(includeDrafts ? '--dev-allow-drafts' : '--dev-exclude-drafts')
  }
  if (!hasExplicitCommonLibsKeys && fs.existsSync(devPublicKeysPath)) {
    args.push(`--dev-commonlibs-public-keys=${devPublicKeysPath}`)
  }
  args.push(...normalizedExtra)
  return args
}

/** 将参数数组安全格式化为 Windows CreateProcess / ShellExecute 命令行参数串 */
export function formatWindowsArgList(args = []) {
  return args
    .map((arg) => {
      const value = String(arg)
      if (!/[\s"&|<>^()]/.test(value)) return value
      return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
    })
    .join(' ')
}

/**
 * 递归获取指定文件或目录中源码文件的最新修改时间戳（毫秒）
 */
export function getLatestSourceMtimeMs(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) return 0
  let stat
  try {
    stat = fs.statSync(targetPath)
  } catch {
    return 0
  }
  if (!stat.isDirectory()) {
    return TEST_FILE_PATTERN.test(path.basename(targetPath)) ? 0 : stat.mtimeMs
  }

  let maxMtime = 0
  let entries = []
  try {
    entries = fs.readdirSync(targetPath, { withFileTypes: true })
  } catch {
    return 0
  }

  for (const entry of entries) {
    if (IGNORED_SCAN_DIRS.has(entry.name)) continue
    const fullPath = path.join(targetPath, entry.name)
    if (entry.isDirectory()) {
      const subMtime = getLatestSourceMtimeMs(fullPath)
      if (subMtime > maxMtime) maxMtime = subMtime
    } else if (entry.isFile() && !TEST_FILE_PATTERN.test(entry.name)) {
      try {
        const fileStat = fs.statSync(fullPath)
        if (fileStat.mtimeMs > maxMtime) maxMtime = fileStat.mtimeMs
      } catch {
        // 忽略单个文件状态读取异常
      }
    }
  }
  return maxMtime
}

export function isSandboxPreloadBundled(preloadFile) {
  if (!preloadFile || !fs.existsSync(preloadFile)) return false
  try {
    const content = fs.readFileSync(preloadFile, 'utf8')
    // tsc 直接输出的未打包 CJS 会包含 require("../contracts/...") 等相对路径调用，在 Electron sandbox 下会报错
    return !/require\(\s*["']\.\.?\//.test(content)
  } catch {
    return false
  }
}

/**
 * 判断是否需要重新执行全量构建
 */
export function shouldRebuildProject(
  rootDir = ROOT_DIR,
  { forceBuild = false, noBuild = false } = {}
) {
  const clientDir = path.join(rootDir, 'electron-client')
  const mainArtifact = path.join(clientDir, 'out', 'main', 'bootstrap.js')
  const webArtifact = path.join(clientDir, 'out', 'assets', 'web', 'index.html')
  const preloadArtifact = path.join(clientDir, 'out', 'preload', 'main.js')
  const promptPreloadArtifact = path.join(clientDir, 'out', 'preload', 'runtime-capability-prompt.js')
  const artifactsExist = fs.existsSync(mainArtifact) && fs.existsSync(webArtifact)

  if (noBuild) {
    if (!artifactsExist) {
      throw new Error(
        '构建产物缺失（缺少 out/main/bootstrap.js 或 out/assets/web/index.html），无法使用 --no-build 跳过构建'
      )
    }
    return { rebuild: false, reason: 'no-build' }
  }

  if (forceBuild) {
    return { rebuild: true, reason: 'force-build' }
  }

  if (!artifactsExist) {
    return { rebuild: true, reason: 'missing-artifacts' }
  }

  if (!isSandboxPreloadBundled(preloadArtifact) || !isSandboxPreloadBundled(promptPreloadArtifact)) {
    return { rebuild: true, reason: 'unbundled-sandbox-preload' }
  }

  const webArtifactMtime = fs.statSync(webArtifact).mtimeMs
  const mainArtifactMtime = fs.statSync(mainArtifact).mtimeMs

  const frontendSourceMtime = Math.max(
    getLatestSourceMtimeMs(path.join(rootDir, 'frontend', 'src')),
    getLatestSourceMtimeMs(path.join(rootDir, 'frontend', 'public', 'js', 'cef-ipc', 'src')),
    getLatestSourceMtimeMs(path.join(rootDir, 'frontend', 'index.html')),
    getLatestSourceMtimeMs(path.join(rootDir, 'frontend', 'vite.config.js')),
    getLatestSourceMtimeMs(path.join(rootDir, 'packages', 'declarative-ui', 'src'))
  )

  if (frontendSourceMtime > webArtifactMtime) {
    return { rebuild: true, reason: 'frontend-source-modified' }
  }

  const mainSourceMtime = Math.max(
    getLatestSourceMtimeMs(path.join( clientDir, 'src')),
    getLatestSourceMtimeMs(path.join(clientDir, 'tsconfig.json'))
  )

  if (mainSourceMtime > mainArtifactMtime) {
    return { rebuild: true, reason: 'main-source-modified' }
  }

  return { rebuild: false, reason: 'up-to-date' }
}

/**
 * 构建成功后刷新核心锚点产物时间戳，确保增量构建水位线一致
 */
export function touchBuildArtifacts(rootDir = ROOT_DIR, now = new Date()) {
  const clientDir = path.join(rootDir, 'electron-client')
  const anchors = [
    path.join(clientDir, 'out', 'main', 'bootstrap.js'),
    path.join(clientDir, 'out', 'assets', 'web', 'index.html')
  ]
  for (const anchor of anchors) {
    if (fs.existsSync(anchor)) {
      try {
        fs.utimesSync(anchor, now, now)
      } catch {
        // 忽略时间戳更新异常
      }
    }
  }
}

/**
 * 判断是否需要通过 Windows 桌面宿主脱离沙盒隔离桌面（如 exebox-*）启动
 */
export function shouldUseWindowsDesktopEscape({
  platform = process.platform,
  env = process.env,
  detached = false,
  electronExe = ''
} = {}) {
  if (platform !== 'win32') return false
  if (!electronExe || !fs.existsSync(electronExe)) return false
  if (detached || env.ANTIGRAVITY_AGENT === '1' || env.ZTOOLS_DETACHED_LAUNCH === '1') {
    return true
  }
  if (typeof env.ZTOOLS_DESKTOP_NAME === 'string') {
    const normalized = env.ZTOOLS_DESKTOP_NAME.trim().toLowerCase()
    if (normalized !== '' && normalized !== 'default') {
      return true
    }
  }
  return false
}

/**
 * 通过驻留在 WinSta0\Default 的 explorer.exe 桌面宿主 (SWC_DESKTOP) 启动 Electron，
 * 彻底规避 AI 终端沙盒虚拟桌面 (exebox-*) 窗口不可见及 Job Object 退出强杀问题。
 */
export function launchDetachedOnWindowsDefaultDesktop(
  clientDir,
  { runner = spawnSync, env = process.env, rebuild = false, electronArgs = [] } = {}
) {
  const electronExe = path.join(clientDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (!fs.existsSync(electronExe)) {
    throw new Error(`未找到 Electron 可执行文件: ${electronExe}`)
  }

  const argString = formatWindowsArgList(['.', ...electronArgs])
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    "if ($env:ZTOOLS_REBUILD_RESTART -eq '1') {",
    "  Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" -ErrorAction SilentlyContinue |",
    "    Where-Object { $_.ExecutablePath -eq $env:ZTOOLS_ELECTRON_EXE } |",
    "    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "  Start-Sleep -Milliseconds 300",
    "}",
    "$shellWindows = New-Object -ComObject Shell.Application",
    "$hwnd = 0",
    "$desktopWin = $shellWindows.Windows().FindWindowSW(0, 0, 8, [ref]$hwnd, 1)",
    "if ($null -eq $desktopWin) {",
    "  throw '无法定位 Windows 桌面宿主 (SWC_DESKTOP)'",
    "}",
    "$desktopWin.Document.Application.ShellExecute($env:ZTOOLS_ELECTRON_EXE, $env:ZTOOLS_ELECTRON_ARGS, $env:ZTOOLS_CLIENT_DIR, 'open', 1)"
  ].join('\n')

  const result = runner(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psScript],
    {
      cwd: clientDir,
      env: {
        ...env,
        ZTOOLS_ELECTRON_EXE: electronExe,
        ZTOOLS_ELECTRON_ARGS: argString,
        ZTOOLS_CLIENT_DIR: clientDir,
        ZTOOLS_REBUILD_RESTART: rebuild ? '1' : '0'
      },
      stdio: 'inherit',
      shell: false
    }
  )
  if (result.error) throw result.error
  return result.status ?? 1
}

/**
 * 跨平台启动开发环境
 */
export function startCrossPlatformDev({
  rootDir = ROOT_DIR,
  platform = process.platform,
  env = process.env,
  runner = spawnSync,
  log = console.log,
  warn = console.warn,
  forceBuild = false,
  noBuild = false,
  detached = false,
  skipSync = false,
  includeDrafts = true,
  syncPlugins = true,
  syncNativePlugins = true,
  syncCommonLibs = true,
  pluginFilter = null,
  extraElectronArgs = []
} = {}) {
  ensureSubprojectDependencies({ rootDir, runner, env, platform, log })

  // 启动前幂等增量同步插件（plugins/ + 可选本地原生 DLL）与公共工具（DLLPlugins/CommonLibs）至 .ztools-dev/DataV2/
  const syncScript = path.join(rootDir, 'scripts', 'dev-sandbox-sync.mjs')
  if (!skipSync && fs.existsSync(syncScript)) {
    const syncCliArgs = [syncScript]
    if (!includeDrafts) syncCliArgs.push('--dev-exclude-drafts')
    if (!syncPlugins) syncCliArgs.push('--no-dev-plugins')
    if (!syncNativePlugins) syncCliArgs.push('--no-dev-native-plugins')
    if (!syncCommonLibs) syncCliArgs.push('--no-dev-commonlibs')
    if (Array.isArray(pluginFilter) && pluginFilter.length > 0) {
      syncCliArgs.push(`--dev-plugin-filter=${pluginFilter.join(',')}`)
    }
    const syncRes = runner(process.execPath, syncCliArgs, {
      cwd: rootDir,
      env,
      stdio: 'inherit',
      shell: false
    })
    if (syncRes?.error) throw syncRes.error
    if ((syncRes?.status ?? 1) !== 0) {
      throw new Error(`开发测试沙盒同步失败（退出码 ${syncRes?.status ?? 1}）`)
    }
  }

  const electronArgs = buildDevElectronArgs({
    rootDir,
    includeDrafts,
    extraArgs: extraElectronArgs
  })
  const clientDir = path.join(rootDir, 'electron-client')

  if (platform === 'darwin') {
    log('🍎 [dev] 检测到 macOS 环境，正在构建并启动 ZTools Electron (Darwin)...')
    const status = runNpm(['run', 'start:mac', '--', ...electronArgs], clientDir, { env, platform, runner })
    if (status !== 0) {
      throw new Error(`macOS 开发环境启动失败（退出码 ${status}）`)
    }
    return { platform, status, rebuilt: true, detached: false, electronArgs }
  }

  if (platform === 'win32') {
    // 尝试可选编译 NativeHost32（若用户电脑未安装 CMake / VS2022 C++ 工具链，则优雅跳过）
    const nativeExe = path.join(clientDir, 'out', 'native', 'win32-ia32', 'ZToolsNativeHost32.exe')
    const nativeCMakeLists = path.join(clientDir, 'native', 'CMakeLists.txt')
    if (fs.existsSync(nativeCMakeLists) && !fs.existsSync(nativeExe)) {
      log('🔧 [dev] 正在尝试构建可选的 32 位 NativeHost32 桥接组件...')
      const nativeStatus = runNpm(['run', 'build:native-host32'], clientDir, { env, platform, runner })
      if (nativeStatus !== 0) {
        warn(
          '⚠️ [dev] 本机未安装 CMake 或 Visual Studio 2022 C++ 编译环境，已自动跳过可选的 32 位 NativeHost32 编译（不影响现代声明式 UI 与内置/社区插件运行）。'
        )
      }
    }

    // 检查并增量编译 64 位原生侧车 (ztools-indexer & ztools-uiaccess)
    const indexerExe = path.join(clientDir, 'out', 'native', 'win32-x64', 'bin', 'ztools-indexer.exe')
    const uiaccessExe = path.join(clientDir, 'out', 'native', 'win32-x64', 'bin', 'ztools-uiaccess.exe')
    const sidecarSourceMtime = Math.max(
      getLatestSourceMtimeMs(path.join(clientDir, 'native', 'ztools-indexer')),
      getLatestSourceMtimeMs(path.join(clientDir, 'native', 'ztools-uiaccess')),
      getLatestSourceMtimeMs(path.join(clientDir, 'native', 'shared'))
    )
    const sidecarBinMtime =
      fs.existsSync(indexerExe) && fs.existsSync(uiaccessExe)
        ? Math.min(fs.statSync(indexerExe).mtimeMs, fs.statSync(uiaccessExe).mtimeMs)
        : 0
    if (sidecarSourceMtime > 0 && (sidecarBinMtime === 0 || sidecarSourceMtime > sidecarBinMtime)) {
      log('🔧 [dev] 正在构建原生侧车组件 (ztools-indexer & ztools-uiaccess)...')
      const sidecarStatus = runNpm(['run', 'build:native:sidecars'], clientDir, { env, platform, runner })
      if (sidecarStatus !== 0) {
        warn('⚠️ [dev] 原生侧车编译未完成，将自动使用内置降级模式运行。')
      }
    }
  }

  const buildDecision = shouldRebuildProject(rootDir, { forceBuild, noBuild })
  if (buildDecision.rebuild) {
    log(`⚡ [dev] 正在构建 Frontend 与 Electron TypeScript 主进程 (${buildDecision.reason})...`)
    const buildStatus = runNpm(['run', 'build'], clientDir, { env, platform, runner })
    if (buildStatus !== 0) {
      throw new Error(`项目构建失败（退出码 ${buildStatus}）`)
    }
    touchBuildArtifacts(rootDir)
  } else {
    log('⚡ [dev] 检测到构建产物已是最新，跳过重复编译（如需强制重编请加 --force-build）')
  }

  const electronExe = path.join(clientDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (shouldUseWindowsDesktopEscape({ platform, env, detached, electronExe })) {
    log('🚀 [dev] 检测到沙盒/分离启动环境，正在通过 Windows 交互式主桌面拉起 ZTools 客户端...')
    const escapeStatus = launchDetachedOnWindowsDefaultDesktop(clientDir, {
      runner,
      env,
      rebuild: buildDecision.rebuild,
      electronArgs
    })
    if (escapeStatus === 0) {
      log('✅ [dev] ZTools 客户端已在主桌面拉起')
      return { platform, status: 0, rebuilt: buildDecision.rebuild, detached: true, electronArgs }
    }
    warn(`⚠️ [dev] 主桌面穿透拉起返回非零状态（${escapeStatus}），自动回退到直接子进程启动...`)
  }

  log('🚀 [dev] 正在启动 ZTools 客户端...')
  const startStatus = runNpm(['exec', '--', 'electron', '.', ...electronArgs], clientDir, { env, platform, runner })
  if (startStatus !== 0) {
    throw new Error(`Electron 启动退出（退出码 ${startStatus}）`)
  }
  return { platform, status: startStatus, rebuilt: buildDecision.rebuild, detached: false, electronArgs }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase()

if (isMainModule) {
  const args = process.argv.slice(2)
  const installOnly = args.includes('--install-only')
  const forceBuild = args.includes('--force-build')
  const noBuild = args.includes('--no-build')
  const detached = args.includes('--detached')
  const skipSync = args.includes('--no-sync')
  const includeDrafts = !args.includes('--dev-exclude-drafts')
  const syncPlugins = !args.includes('--no-dev-plugins')
  const syncNativePlugins = !args.includes('--no-dev-native-plugins')
  const syncCommonLibs = !args.includes('--no-dev-commonlibs')
  const filterArg = args.find((item) => item.startsWith('--dev-plugin-filter='))
  const pluginFilter = filterArg
    ? filterArg.slice('--dev-plugin-filter='.length).split(',').map((s) => s.trim()).filter(Boolean)
    : null
  const bootstrapOnlyFlags = new Set([
    '--install-only',
    '--force-build',
    '--no-build',
    '--detached',
    '--no-sync',
    '--no-dev-plugins',
    '--no-dev-native-plugins',
    '--no-dev-commonlibs'
  ])
  const extraElectronArgs = args.filter(
    (item) => !bootstrapOnlyFlags.has(item) && !item.startsWith('--dev-plugin-filter=')
  )
  try {
    if (installOnly) {
      ensureSubprojectDependencies()
    } else {
      startCrossPlatformDev({
        forceBuild,
        noBuild,
        detached,
        skipSync,
        includeDrafts,
        syncPlugins,
        syncNativePlugins,
        syncCommonLibs,
        pluginFilter,
        extraElectronArgs
      })
    }
  } catch (err) {
    console.error(`❌ [bootstrap] ${err.message}`)
    process.exit(1)
  }
}

