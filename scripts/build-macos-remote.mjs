#!/usr/bin/env node

/**
 * build-macos-remote.mjs
 * Windows / 跨平台遥控云端 GitHub Actions (macos-latest) 编译 macOS Universal DMG 安装包工具
 *
 * 核心能力：
 * 1. 自动探测本机 GitHub CLI (`gh`) 路径并校验登录状态；
 * 2. 自动解析 package.json 版本号并派生符合 Apple CFBundleShortVersionString / CFBundleVersion 规范的三段式版本；
 * 3. 一键触发 `codingmuse/ZTools` 仓库上的 `build-macos-dmg.yml` 云端 Apple Silicon 构建节点；
 * 4. 支持 `--watch` 实时流式查看云端 Mac 编译进度，支持 `--download` 在编译完成后自动把 `.dmg` 与 `.sha256` 拉回本地 `dist/macos/` 目录。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(__dirname, '..')
export const DEFAULT_REPO = 'codingmuse/ZTools'
export const DEFAULT_WORKFLOW = 'build-macos-dmg.yml'
export const DEFAULT_BUNDLE_ID = 'cn.ztools.app'
export const DEFAULT_MINIMUM_OS = '13.0'

/**
 * 将任意版本字符串（如 "1.1.7.1" 或 "1.0.5"）转换为符合 macOS Info.plist 规范的 shortVersion 与 buildVersion
 * @param {string} rawVersion
 * @returns {{ rawVersion: string, shortVersion: string, buildVersion: string, tag: string }}
 */
export function resolveMacosBundleVersions(rawVersion) {
  if (typeof rawVersion !== 'string' || !rawVersion.trim()) {
    throw new Error('INVALID_PACKAGE_VERSION: 版本号不能为空')
  }
  const clean = rawVersion.trim().replace(/^v/i, '')
  const nums = clean.split(/[^0-9]+/).filter(Boolean)
  if (nums.length < 3 || nums.some((n) => !Number.isSafeInteger(Number(n)))) {
    throw new Error(`INVALID_PACKAGE_VERSION: 版本号必须至少包含 3 段非负整数 (${rawVersion})`)
  }
  const shortVersion = `${Number(nums[0])}.${Number(nums[1])}.${Number(nums[2])}`
  const buildVersion =
    nums.length >= 4
      ? `${Number(nums[0])}.${Number(nums[1])}.${Number(nums[3])}`
      : shortVersion
  return {
    rawVersion: clean,
    shortVersion,
    buildVersion,
    tag: `v${clean}`
  }
}

/**
 * 自动探测本机 GitHub CLI (`gh`) 可执行文件
 */
export function locateGhExecutable({
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  runner = spawnSync
} = {}) {
  if (env.GH_PATH && existsSync(env.GH_PATH)) {
    return env.GH_PATH
  }

  const probeCmd = platform === 'win32' ? 'where.exe' : 'which'
  const probe = runner(probeCmd, ['gh'], { encoding: 'utf8', shell: false })
  if (probe.status === 0 && probe.stdout) {
    const firstLine = probe.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean)
    if (firstLine && existsSync(firstLine)) {
      return firstLine
    }
  }

  if (platform === 'win32') {
    const candidates = [
      path.join(env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'bin', 'gh.exe'),
      'C:\\Program Files\\GitHub CLI\\gh.exe',
      'C:\\Program Files (x86)\\GitHub CLI\\gh.exe'
    ]
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) {
        return candidate
      }
    }
  }

  throw new Error('GH_CLI_NOT_FOUND: 未找到 GitHub CLI (gh)，请先安装 GitHub CLI 或设置 GH_PATH 环境变量')
}

/**
 * 解析命令行参数
 */
export function parseRemoteMacBuildArgs(argv = []) {
  const options = {
    repo: DEFAULT_REPO,
    workflow: DEFAULT_WORKFLOW,
    ref: 'main',
    bundleId: DEFAULT_BUNDLE_ID,
    minimumOs: DEFAULT_MINIMUM_OS,
    uploadToRelease: true,
    watch: false,
    download: false,
    outputDir: path.join(ROOT_DIR, 'dist', 'macos'),
    dryRun: false
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--watch') {
      options.watch = true
    } else if (arg === '--download') {
      options.download = true
      options.watch = true
    } else if (arg === '--no-release') {
      options.uploadToRelease = false
    } else if (arg === '--repo' && argv[i + 1]) {
      options.repo = argv[++i]
    } else if (arg === '--ref' && argv[i + 1]) {
      options.ref = argv[++i]
    } else if (arg === '--bundle-id' && argv[i + 1]) {
      options.bundleId = argv[++i]
    } else if (arg === '--minimum-os' && argv[i + 1]) {
      options.minimumOs = argv[++i]
    } else if (arg === '--output-dir' && argv[i + 1]) {
      options.outputDir = path.resolve(argv[++i])
    } else {
      throw new Error(`UNKNOWN_ARGUMENT: 不支持的参数 ${arg}`)
    }
  }

  return options
}

/**
 * 触发云端 GitHub Actions macOS Universal DMG 构建
 */
export function triggerRemoteMacBuild(
  rawArgs = [],
  {
    rootDir = ROOT_DIR,
    env = process.env,
    platform = process.platform,
    fsApi = fs,
    runner = spawnSync,
    log = console.log
  } = {}
) {
  const options = parseRemoteMacBuildArgs(rawArgs)
  const clientPkgPath = path.join(rootDir, 'electron-client', 'package.json')
  const rootPkgPath = path.join(rootDir, 'package.json')
  const pkgPath = fsApi.existsSync(clientPkgPath) ? clientPkgPath : rootPkgPath
  const pkg = JSON.parse(fsApi.readFileSync(pkgPath, 'utf8'))
  const versionInfo = resolveMacosBundleVersions(pkg.version)

  const triggerArgs = [
    'workflow',
    'run',
    options.workflow,
    '--repo',
    options.repo,
    '--ref',
    options.ref,
    '-f',
    `upload_to_release=${options.uploadToRelease ? 'true' : 'false'}`,
    '-f',
    `bundle_id=${options.bundleId}`,
    '-f',
    `minimum_os=${options.minimumOs}`
  ]

  if (options.dryRun) {
    log('🔍 [dry-run] 即将执行的云端 macOS DMG 编译任务参数：')
    const plan = {
      mode: 'dry-run',
      repo: options.repo,
      workflow: options.workflow,
      ref: options.ref,
      version: versionInfo.rawVersion,
      shortVersion: versionInfo.shortVersion,
      buildVersion: versionInfo.buildVersion,
      bundleId: options.bundleId,
      minimumOs: options.minimumOs,
      uploadToRelease: options.uploadToRelease,
      expectedArtifactName: `ZTools-${versionInfo.rawVersion}-darwin-universal`,
      expectedDmgFile: `ZTools-${versionInfo.rawVersion}-darwin-universal.dmg`,
      ghCommandArgs: triggerArgs
    }
    log(JSON.stringify(plan, null, 2))
    return plan
  }

  const ghBin = locateGhExecutable({ env, platform, existsSync: fsApi.existsSync, runner })

  log(`🚀 [macOS Cloud Builder] 正在通过 GitHub Actions (${options.repo}) 触发 macOS Universal DMG 构建...`)
  log(`   版本: ${versionInfo.rawVersion} (Short: ${versionInfo.shortVersion}, Build: ${versionInfo.buildVersion})`)
  const dispatchRes = runner(ghBin, triggerArgs, {
    cwd: rootDir,
    env,
    encoding: 'utf8',
    stdio: 'inherit',
    shell: false
  })
  if (dispatchRes.status !== 0) {
    throw new Error(`WORKFLOW_DISPATCH_FAILED: 触发 GitHub Actions 失败 (退出码 ${dispatchRes.status ?? 1})`)
  }

  log('✅ 已成功向 GitHub 云端 Mac 节点下发编译任务！')
  log(`🔗 查看构建进度: https://github.com/${options.repo}/actions/workflows/${options.workflow}`)

  if (options.watch) {
    log('⏳ 正在获取最新创建的 Workflow Run ID 并监听云端构建进度...')
    const listRes = runner(
      ghBin,
      [
        'run',
        'list',
        '--repo',
        options.repo,
        '--workflow',
        options.workflow,
        '--limit',
        '1',
        '--json',
        'databaseId,status,url'
      ],
      { cwd: rootDir, env, encoding: 'utf8', shell: false }
    )
    if (listRes.status !== 0 || !listRes.stdout) {
      throw new Error('WORKFLOW_RUN_LOOKUP_FAILED: 无法查询最新的 GitHub Actions 运行记录')
    }
    const runs = JSON.parse(listRes.stdout)
    const latestRun = Array.isArray(runs) ? runs[0] : null
    if (!latestRun?.databaseId) {
      throw new Error('WORKFLOW_RUN_NOT_FOUND: 未找到刚刚触发的构建记录')
    }

    const runId = String(latestRun.databaseId)
    const watchRes = runner(ghBin, ['run', 'watch', runId, '--repo', options.repo, '--exit-status'], {
      cwd: rootDir,
      env,
      stdio: 'inherit',
      shell: false
    })
    if (watchRes.status !== 0) {
      throw new Error(`WORKFLOW_EXECUTION_FAILED: 云端 macOS 编译失败 (Run ID: ${runId})`)
    }

    if (options.download) {
      fsApi.mkdirSync(options.outputDir, { recursive: true })
      const artifactName = `ZTools-${versionInfo.rawVersion}-darwin-universal`
      log(`📥 正在将云端构建产物 ${artifactName} 下载到本地目录: ${options.outputDir}`)
      const dlRes = runner(
        ghBin,
        [
          'run',
          'download',
          runId,
          '--repo',
          options.repo,
          '-n',
          artifactName,
          '-D',
          options.outputDir
        ],
        { cwd: rootDir, env, stdio: 'inherit', shell: false }
      )
      if (dlRes.status !== 0) {
        throw new Error(`ARTIFACT_DOWNLOAD_FAILED: 下载云端 DMG 产物失败 (Run ID: ${runId})`)
      }
      log(`🎉 macOS Universal DMG 安装包已下载至: ${path.join(options.outputDir, `ZTools-${versionInfo.rawVersion}-darwin-universal.dmg`)}`)
    }
  }

  return {
    mode: 'dispatched',
    repo: options.repo,
    workflow: options.workflow,
    version: versionInfo.rawVersion,
    shortVersion: versionInfo.shortVersion,
    buildVersion: versionInfo.buildVersion
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase()

if (isMainModule) {
  try {
    triggerRemoteMacBuild(process.argv.slice(2))
  } catch (err) {
    console.error(`❌ [macOS Cloud Builder] ${err.message}`)
    process.exit(1)
  }
}
