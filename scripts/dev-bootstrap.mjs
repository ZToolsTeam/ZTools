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
    if (
      key === 'INIT_CWD' ||
      key === 'npm_package_json' ||
      key === 'npm_config_local_prefix' ||
      key === 'npm_lifecycle_event' ||
      key === 'npm_lifecycle_script'
    ) {
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
      let code = runNpm(['install', '--no-audit', '--no-fund', '--workspaces=false'], sub.dir, {
        env,
        platform,
        runner
      })
      if (code !== 0) {
        log(`⚠️ [bootstrap] ${sub.name} 首次安装遇到跨平台锁文件冲突，正在清理 package-lock.json 并自动重试...`)
        try {
          fs.rmSync(path.join(sub.dir, 'package-lock.json'), { force: true })
          fs.rmSync(path.join(sub.dir, 'node_modules'), { recursive: true, force: true })
        } catch {
          // 忽略清理异常
        }
        code = runNpm(
          ['install', '--no-package-lock', '--no-audit', '--no-fund', '--workspaces=false'],
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

  return { installed }
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
  warn = console.warn
} = {}) {
  ensureSubprojectDependencies({ rootDir, runner, env, platform, log })

  const clientDir = path.join(rootDir, 'electron-client')

  if (platform === 'darwin') {
    log('🍎 [dev] 检测到 macOS 环境，正在构建并启动 ZTools Electron (Darwin)...')
    const status = runNpm(['run', 'start:mac'], clientDir, { env, platform, runner })
    if (status !== 0) {
      throw new Error(`macOS 开发环境启动失败（退出码 ${status}）`)
    }
    return { platform, status }
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
  }

  log('⚡ [dev] 正在构建 Frontend 与 Electron TypeScript 主进程...')
  const buildStatus = runNpm(['run', 'build'], clientDir, { env, platform, runner })
  if (buildStatus !== 0) {
    throw new Error(`项目构建失败（退出码 ${buildStatus}）`)
  }

  log('🚀 [dev] 正在启动 ZTools 客户端...')
  const startStatus = runNpm(['exec', '--', 'electron', '.'], clientDir, { env, platform, runner })
  if (startStatus !== 0) {
    throw new Error(`Electron 启动退出（退出码 ${startStatus}）`)
  }
  return { platform, status: startStatus }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase()

if (isMainModule) {
  const args = process.argv.slice(2)
  const installOnly = args.includes('--install-only')
  try {
    if (installOnly) {
      ensureSubprojectDependencies()
    } else {
      startCrossPlatformDev()
    }
  } catch (err) {
    console.error(`❌ [bootstrap] ${err.message}`)
    process.exit(1)
  }
}
