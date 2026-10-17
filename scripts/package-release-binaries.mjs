#!/usr/bin/env node

/**
 * package-release-binaries.mjs
 * ZTools 发行版 Windows + macOS 双平台三包一键打包与 GitHub Releases 自动化发布脚本
 *
 * 核心铁律（Cross-Platform Tri-Binary Release Rule）：
 *   每次打包或上传 GitHub Releases 时，必须同时发布 Windows 与 macOS 双端全量安装包（缺一不可）：
 *   1. Windows EXE 离线安装包：ZTools-<version>-win32-x64.exe (+ .sha256)
 *   2. Windows ZIP 免安装便携包：ZTools-<version>-win32-x64-portable.zip (+ .sha256)
 *   3. macOS Universal DMG 通用安装包：ZTools-<version>-darwin-universal.dmg (+ .sha256，通过 GitHub Actions 云端 Mac 节点自动编译并挂载至同一 Release)
 *
 * 用法：
 *   node scripts/package-release-binaries.mjs [选项]
 *
 * 选项：
 *   --rebuild-app         重新完整编译并打包 Electron ZTools-win32-x64 应用目录（默认复用已有应用目录并注入最新安装器）
 *   --skip-delphi         跳过 Delphi 安装器/卸载器重编译（直接使用现有的 ZToolsSetup.exe / ZToolsUninstall.exe）
 *   --skip-mac            仅上传 Windows 双包，跳过自动触发云端 macOS Universal DMG 构建
 *   --upload, --publish   打包校验完成后，自动上传 Windows 双包至 GitHub Releases 并联动触发云端 macOS DMG 编译挂载
 *   --tag <tag>           指定 GitHub Release 标签（默认: v<version>）
 *   --repo <owner/repo>   指定目标 GitHub 仓库（默认: codingmuse/ZTools）
 *   --notes <text>        指定 GitHub Release 发布说明
 *   --dry-run             演练模式：执行校验并打印将要执行的打包/上传动作，不实际发起远端上传
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getWindowsArtifactRoot,
  getWindowsInstallerFileName,
  getWindowsPortableZipFileName,
  WINDOWS_TARGET
} from '../electron-client/scripts/windows-package-contract.mjs'
import { triggerRemoteMacBuild } from './build-macos-remote.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(__dirname, '..')
export const ELECTRON_CLIENT_DIR = path.join(ROOT_DIR, 'electron-client')
export const INSTALLER_DIR = path.join(ROOT_DIR, 'installer')
export const DEFAULT_GITHUB_REPO = 'codingmuse/ZTools'

export function assertFourPartVersion(version) {
  const str = String(version ?? '').trim()
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(str)) {
    throw new Error(
      `FOUR_PART_VERSION_REQUIRED: 版本号必须为四段式纯数字格式（例如 1.1.8.0），当前值: "${str}"（ZToolsService CMake 强制要求四段式版本号）`
    )
  }
  return str
}

export function incrementFourPartVersion(version) {
  const valid = assertFourPartVersion(version)
  const parts = valid.split('.').map(Number)
  parts[3] += 1
  return parts.join('.')
}

export function syncAllPackageVersions(newVersion, rootDir = ROOT_DIR) {
  const valid = assertFourPartVersion(newVersion)
  const targets = [
    path.join(rootDir, 'package.json'),
    path.join(rootDir, 'electron-client', 'package.json'),
    path.join(rootDir, 'electron-client', 'package-lock.json'),
    path.join(rootDir, 'frontend', 'package.json'),
    path.join(rootDir, 'frontend', 'package-lock.json')
  ]
  for (const filePath of targets) {
    if (!fs.existsSync(filePath)) continue
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    data.version = valid
    if (data.packages && data.packages['']) {
      data.packages[''].version = valid
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
  }
  return valid
}

export function parseReleaseCliArgs(argv = process.argv.slice(2)) {
  const options = {
    rebuildApp: false,
    skipDelphi: false,
    skipMac: false,
    upload: false,
    dryRun: false,
    bump: false,
    newVersion: '',
    tag: '',
    repo: DEFAULT_GITHUB_REPO,
    notes: ''
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--rebuild-app') {
      options.rebuildApp = true
    } else if (arg === '--skip-delphi') {
      options.skipDelphi = true
    } else if (arg === '--skip-mac') {
      options.skipMac = true
    } else if (arg === '--upload' || arg === '--publish') {
      options.upload = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--bump') {
      options.bump = true
      options.rebuildApp = true
    } else if (arg === '--new-version') {
      const val = argv[++i]
      options.newVersion = assertFourPartVersion(val)
      options.rebuildApp = true
    } else if (arg === '--tag') {
      const val = argv[++i]
      if (!val || val.startsWith('-')) {
        throw new Error('--tag 参数必须指定有效的版本号标签（例如 v1.1.7.1）')
      }
      options.tag = val.trim()
    } else if (arg === '--repo') {
      const val = argv[++i]
      if (!val || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(val.trim())) {
        throw new Error(`--repo 参数格式无效（需为 owner/repo 格式）: ${val ?? ''}`)
      }
      options.repo = val.trim()
    } else if (arg === '--notes') {
      const val = argv[++i]
      if (val === undefined) {
        throw new Error('--notes 参数缺少文本内容')
      }
      options.notes = val
    } else {
      throw new Error(`未知的命令行参数: ${arg}`)
    }
  }

  return options
}

export function computeSha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function resolveExpectedReleaseArtifacts({
  clientRoot = ELECTRON_CLIENT_DIR,
  artifactVersion
}) {
  if (!artifactVersion || typeof artifactVersion !== 'string' || !artifactVersion.trim()) {
    throw new Error('artifactVersion 不能为空')
  }
  const version = artifactVersion.trim()
  const artifactRoot = getWindowsArtifactRoot(clientRoot, version)
  const applicationRoot = path.join(artifactRoot, WINDOWS_TARGET.applicationDirectory)
  const installerName = getWindowsInstallerFileName(version)
  const portableZipName = getWindowsPortableZipFileName(version)
  const installerPath = path.join(artifactRoot, installerName)
  const installerChecksumPath = `${installerPath}.sha256`
  const portableZipPath = path.join(artifactRoot, portableZipName)
  const portableZipChecksumPath = `${portableZipPath}.sha256`

  return {
    version,
    artifactRoot,
    applicationRoot,
    installerName,
    installerPath,
    installerChecksumPath,
    portableZipName,
    portableZipPath,
    portableZipChecksumPath
  }
}

/**
 * 严格校验 EXE 安装包与 ZIP 免安装便携包是否双包齐全、非空且 SHA-256 校验一致。
 * 任何一项缺失或篡改均立即抛出明确错误，严禁残缺上传。
 */
export function verifyDualReleaseArtifacts(artifacts) {
  if (!artifacts || typeof artifacts !== 'object') {
    throw new Error('产物描述对象不能为空')
  }

  const requiredFiles = [
    [artifacts.installerPath, 'EXE 离线安装包'],
    [artifacts.installerChecksumPath, 'EXE 离线安装包 SHA-256 校验文件'],
    [artifacts.portableZipPath, 'ZIP 免安装便携包'],
    [artifacts.portableZipChecksumPath, 'ZIP 免安装便携包 SHA-256 校验文件']
  ]

  for (const [filePath, label] of requiredFiles) {
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`违反双包发布规范：缺少 ${label} (${filePath ?? 'undefined'})`)
    }
    const size = fs.statSync(filePath).size
    if (size <= 0) {
      throw new Error(`产物文件为空 (0 字节): ${label} (${filePath})`)
    }
  }

  // 校验 PE MZ 魔数 (EXE 安装包) 与 ZIP PK 魔数 (ZIP 免安装包)
  const exeHeader = fs.readFileSync(artifacts.installerPath).subarray(0, 2)
  if (exeHeader.toString('ascii') !== 'MZ') {
    throw new Error(`EXE 离线安装包文件头非法（非有效 Win32 PE 可执行文件）: ${artifacts.installerPath}`)
  }

  const zipHeader = fs.readFileSync(artifacts.portableZipPath).subarray(0, 2)
  if (zipHeader.toString('ascii') !== 'PK') {
    throw new Error(`ZIP 免安装便携包文件头非法（非有效 ZIP 归档文件）: ${artifacts.portableZipPath}`)
  }

  // 校验 SHA-256 摘要一致性
  const actualExeSha256 = computeSha256(artifacts.installerPath)
  const expectedExeChecksumLine = `${actualExeSha256}  ${artifacts.installerName}`
  const recordedExeChecksumLine = fs.readFileSync(artifacts.installerChecksumPath, 'utf8').trim()
  if (recordedExeChecksumLine !== expectedExeChecksumLine) {
    throw new Error(
      `EXE 离线安装包 SHA-256 校验不匹配：记录值 "${recordedExeChecksumLine}" != 实际值 "${expectedExeChecksumLine}"`
    )
  }

  const actualZipSha256 = computeSha256(artifacts.portableZipPath)
  const expectedZipChecksumLine = `${actualZipSha256}  ${artifacts.portableZipName}`
  const recordedZipChecksumLine = fs.readFileSync(artifacts.portableZipChecksumPath, 'utf8').trim()
  if (recordedZipChecksumLine !== expectedZipChecksumLine) {
    throw new Error(
      `ZIP 免安装便携包 SHA-256 校验不匹配：记录值 "${recordedZipChecksumLine}" != 实际值 "${expectedZipChecksumLine}"`
    )
  }

  return {
    installerSize: fs.statSync(artifacts.installerPath).size,
    installerSha256: actualExeSha256,
    portableZipSize: fs.statSync(artifacts.portableZipPath).size,
    portableZipSha256: actualZipSha256
  }
}

export function resolveGhExecutable() {
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const defaultGhPath = path.join(localAppData, 'Programs', 'GitHub CLI', 'bin', 'gh.exe')
  if (localAppData && fs.existsSync(defaultGhPath)) {
    return defaultGhPath
  }
  return 'gh'
}

function runCommand(executable, args, cwd = ROOT_DIR) {
  const result = spawnSync(executable, args, {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
    shell: executable.endsWith('.bat') || executable.endsWith('.cmd')
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${path.basename(executable)} 执行失败（退出码 ${result.status ?? 'unknown'}）`)
  }
}

export function buildGitHubReleaseUploadPlan({
  artifacts,
  verification,
  tag,
  repo = DEFAULT_GITHUB_REPO,
  notes = ''
}) {
  const verified = verification ?? verifyDualReleaseArtifacts(artifacts)
  const releaseTag = tag || `v${artifacts.version}`
  if (!/^v?\d+\.\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.-]+)?$/.test(releaseTag)) {
    throw new Error(`非法 Release 标签格式: ${releaseTag}`)
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`非法 GitHub 仓库标识: ${repo}`)
  }

  const assets = [
    artifacts.installerPath,
    artifacts.installerChecksumPath,
    artifacts.portableZipPath,
    artifacts.portableZipChecksumPath
  ]

  const exeMb = (verified.installerSize / 1048576).toFixed(2)
  const zipMb = (verified.portableZipSize / 1048576).toFixed(2)
  const macDmgName = `ZTools-${artifacts.version}-darwin-universal.dmg`
  const releaseNotes =
    notes.trim() ||
    [
      `## ZTools ${releaseTag} 发行版下载（Windows & macOS 双端发布）`,
      '',
      '### 🪟 Windows 安装包与免安装包（Windows 10/11 x64）',
      `- **EXE 离线安装包**：\`${artifacts.installerName}\` (${exeMb} MB) — 推荐普通用户下载，内置极简 Direct2D GPU 安装向导、支持一键平滑升级与智能换盘`,
      `  - SHA-256: \`${verified.installerSha256}\``,
      `- **ZIP 免安装便携包**：\`${artifacts.portableZipName}\` (${zipMb} MB) — 推荐极客用户下载，解压即用`,
      `  - SHA-256: \`${verified.portableZipSha256}\``,
      '',
      '### 🍎 macOS 通用安装包（Apple Silicon M1–M4 & Intel Universal）',
      `- **DMG 通用磁盘镜像**：\`${macDmgName}\` — 原生双架构 Universal 应用包（含 \`${macDmgName}.sha256\` 校验文件），拖入 \`Applications\` 即可使用`
    ].join('\n')

  return {
    releaseTag,
    repo,
    assets,
    releaseNotes
  }
}

export function uploadDualArtifactsToGitHub({
  artifacts,
  tag,
  repo = DEFAULT_GITHUB_REPO,
  notes = '',
  dryRun = false,
  ghExecutable = resolveGhExecutable()
}) {
  const verification = verifyDualReleaseArtifacts(artifacts)
  const plan = buildGitHubReleaseUploadPlan({
    artifacts,
    verification,
    tag,
    repo,
    notes
  })

  if (dryRun) {
    console.log('\n[Dry-Run] 将向 GitHub Releases 上传以下双格式产物：')
    console.log(`  仓库: ${plan.repo}`)
    console.log(`  标签: ${plan.releaseTag}`)
    for (const asset of plan.assets) {
      console.log(`  - ${asset}`)
    }
    return { ...plan, uploaded: false, dryRun: true }
  }

  const checkResult = spawnSync(
    ghExecutable,
    ['release', 'view', plan.releaseTag, '--repo', plan.repo],
    { cwd: ROOT_DIR, stdio: 'ignore', windowsHide: true }
  )

  if (checkResult.status === 0) {
    console.log(`\n⏳ Release ${plan.releaseTag} 已存在，正在覆盖上传 EXE 安装包 + ZIP 免安装包并同步说明文案...`)
    runCommand(ghExecutable, [
      'release',
      'upload',
      plan.releaseTag,
      ...plan.assets,
      '--clobber',
      '--repo',
      plan.repo
    ])
    runCommand(ghExecutable, [
      'release',
      'edit',
      plan.releaseTag,
      '--title',
      `ZTools ${plan.releaseTag} - 纯粹开源效率中枢平台`,
      '--notes',
      plan.releaseNotes,
      '--latest',
      '--repo',
      plan.repo
    ])
  } else {
    console.log(`\n🚀 正在创建 Release ${plan.releaseTag} 并上传 EXE 安装包 + ZIP 免安装包...`)
    runCommand(ghExecutable, [
      'release',
      'create',
      plan.releaseTag,
      ...plan.assets,
      '--title',
      `ZTools ${plan.releaseTag} - 纯粹开源效率中枢平台`,
      '--notes',
      plan.releaseNotes,
      '--latest',
      '--repo',
      plan.repo
    ])
  }

  return { ...plan, uploaded: true, dryRun: false }
}

export function runReleasePackagingPipeline(rawArgs = process.argv.slice(2)) {
  const options = parseReleaseCliArgs(rawArgs)
  let clientPkg = JSON.parse(
    fs.readFileSync(path.join(ELECTRON_CLIENT_DIR, 'package.json'), 'utf8')
  )
  assertFourPartVersion(clientPkg.version)

  if (options.newVersion || options.bump) {
    const targetVer = options.newVersion || incrementFourPartVersion(clientPkg.version)
    if (!options.dryRun) {
      syncAllPackageVersions(targetVer, ROOT_DIR)
      clientPkg = JSON.parse(
        fs.readFileSync(path.join(ELECTRON_CLIENT_DIR, 'package.json'), 'utf8')
      )
      console.log(`🔼 [版本自增] 已将全工作区版本号同步升级为: ${clientPkg.version}`)
    } else {
      console.log(`[Dry-Run] 将把全工作区版本号从 ${clientPkg.version} 升级为 ${targetVer}`)
      clientPkg.version = targetVer
    }
  }

  const buildQualifier = process.env.ZTOOLS_BUILD_QUALIFIER ?? ''
  const artifactVersion = buildQualifier
    ? `${clientPkg.version}-${buildQualifier}`
    : clientPkg.version
  const artifacts = resolveExpectedReleaseArtifacts({
    clientRoot: ELECTRON_CLIENT_DIR,
    artifactVersion
  })

  console.log('========================================================')
  console.log(`📦 ZTools 商业发行版 Windows + macOS 三包构建流水线 (v${artifactVersion})`)
  console.log('   产物 1 (Windows EXE 安装包): ' + artifacts.installerName)
  console.log('   产物 2 (Windows ZIP 免安装): ' + artifacts.portableZipName)
  console.log(`   产物 3 (macOS Universal DMG): ZTools-${artifactVersion}-darwin-universal.dmg`)
  console.log('========================================================')

  // 步骤 1：编译 Delphi FMX 安装器与卸载器
  if (!options.skipDelphi && !options.dryRun) {
    const setupBat = path.join(INSTALLER_DIR, 'Setup', 'compile_setup.bat')
    const uninstBat = path.join(INSTALLER_DIR, 'Uninstall', 'compile_uninstall.bat')
    if (fs.existsSync(setupBat) && fs.existsSync(uninstBat)) {
      console.log('\n[1/4] 正在编译最新 Delphi FMX 安装器 (ZToolsSetup.exe) 与卸载器 (ZToolsUninstall.exe)...')
      runCommand('cmd.exe', ['/c', 'compile_setup.bat'], path.join(INSTALLER_DIR, 'Setup'))
      runCommand('cmd.exe', ['/c', 'compile_uninstall.bat'], path.join(INSTALLER_DIR, 'Uninstall'))
    }
  } else {
    console.log('\n[1/4] 跳过 Delphi 安装器重编译，使用现有二进制。')
  }

  // 步骤 2：检查或构建 Electron ZTools-win32-x64 应用目录
  const needBuildApp =
    options.rebuildApp ||
    !fs.existsSync(path.join(artifacts.applicationRoot, 'ZTools.exe'))

  if (needBuildApp && !options.dryRun) {
    if (fs.existsSync(artifacts.artifactRoot)) {
      console.log(`\n[清理] 移除旧的 staging 目录: ${artifacts.artifactRoot}`)
      fs.rmSync(artifacts.artifactRoot, { recursive: true, force: true })
    }
    console.log('\n[2/4] 正在构建 Electron win32-x64 应用程序包...')
    runCommand('npm.cmd', ['--prefix', 'electron-client', 'run', 'package:app:win32:x64'], ROOT_DIR)
  } else {
    console.log(`\n[2/4] 复用已就绪的 Electron 应用目录: ${artifacts.applicationRoot}`)
  }

  // 步骤 3：同时打包生成 EXE 离线安装包 + ZIP 免安装便携包
  if (!options.dryRun) {
    console.log('\n[3/4] 正在同步打包 EXE 离线安装包与 ZIP 免安装便携包...')
    runCommand(
      process.execPath,
      [path.join(ELECTRON_CLIENT_DIR, 'scripts', 'package-installer.mjs'), '--force'],
      ELECTRON_CLIENT_DIR
    )
  } else {
    console.log('\n[3/4] [Dry-Run] 将调用 package-installer.mjs --force 同时生成 EXE 与 ZIP。')
  }

  // 步骤 4：严格校验双包完整性与可选上传 GitHub Releases + 自动联动云端 macOS DMG 构建
  console.log('\n[4/4] 正在校验双格式产物完整性与 SHA-256 签名摘要...')
  const verification = verifyDualReleaseArtifacts(artifacts)
  console.log(`✔ EXE 离线安装包: ${artifacts.installerPath}`)
  console.log(`  大小: ${(verification.installerSize / 1048576).toFixed(2)} MB | SHA-256: ${verification.installerSha256}`)
  console.log(`✔ ZIP 免安装便携包: ${artifacts.portableZipPath}`)
  console.log(`  大小: ${(verification.portableZipSize / 1048576).toFixed(2)} MB | SHA-256: ${verification.portableZipSha256}`)

  let macBuildPlan = null
  if (options.upload) {
    uploadDualArtifactsToGitHub({
      artifacts,
      tag: options.tag,
      repo: options.repo,
      notes: options.notes,
      dryRun: options.dryRun
    })

    if (!options.skipMac) {
      console.log('\n🍎 [5/5] 正在自动联动触发 GitHub Actions 云端 macOS Universal DMG 构建与挂载...')
      const macArgs = ['--repo', options.repo]
      if (options.dryRun) macArgs.push('--dry-run')
      macBuildPlan = triggerRemoteMacBuild(macArgs)
    }
  }

  return {
    artifacts,
    verification,
    macBuildPlan
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase()

if (isMainModule) {
  try {
    runReleasePackagingPipeline()
  } catch (err) {
    console.error(`\n❌ [打包/发布失败] ${err.message}`)
    process.exit(1)
  }
}
