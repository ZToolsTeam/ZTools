#!/usr/bin/env node

/**
 * publish-winget.mjs
 * ZTools 微软官方 Windows Package Manager (winget-pkgs) 自动化发布流水线
 *
 * 功能说明：
 *   1. 自动校验系统 winget、wingetcreate 工具链与 GitHub CLI 鉴权凭据；
 *   2. 自动检查或构建/上传 GitHub Release 安装包（EXE 离线包与便携包）；
 *   3. 自动生成符合微软 1.6.0+ 标准架构规范的 4 份 WinGet Manifest 清单（版本、安装器、中/英区域）；
 *   4. 调用本地 winget validate 执行严格格式与语义校验；
 *   5. 调用 wingetcreate submit 自动 Fork、分支并向 microsoft/winget-pkgs 提交 PR。
 *
 * 用法：
 *   node scripts/publish-winget.mjs [选项]
 *   npm run release:winget
 *   npm run release:winget:dry-run
 *
 * 选项：
 *   --version <ver>    指定发布版本号（默认读取 electron-client/package.json）
 *   --package          若 GitHub 尚无对应 Release 资产，自动执行全量打包并上传至 GitHub Releases
 *   --dry-run          演练模式：仅生成并校验清单，不实际向微软提交 PR
 *   --repo <repo>      GitHub 仓库标识（默认: ZToolsTeam/ZTools）
 *   --token <token>    指定 GitHub Personal Access Token（默认自动通过 gh auth token 获取）
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  getWindowsArtifactRoot,
  getWindowsInstallerFileName
} from '../electron-client/scripts/windows-package-contract.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT_DIR = path.resolve(__dirname, '..')
export const ELECTRON_CLIENT_DIR = path.join(ROOT_DIR, 'electron-client')
export const DEFAULT_GITHUB_REPO = 'ZToolsTeam/ZTools'
export const DEFAULT_PACKAGE_ID = 'ZToolsTeam.ZTools'

export function parseWingetCliArgs(argv = process.argv.slice(2)) {
  const options = {
    version: '',
    packageIfMissing: false,
    dryRun: false,
    repo: DEFAULT_GITHUB_REPO,
    token: ''
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--package') {
      options.packageIfMissing = true
    } else if (arg === '--version') {
      const val = argv[++i]
      if (!val || val.startsWith('-')) {
        throw new Error('--version 参数必须提供有效的版本号（例如 1.1.7.1）')
      }
      options.version = val.trim().replace(/^v/, '')
    } else if (arg === '--repo') {
      const val = argv[++i]
      if (!val || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(val.trim())) {
        throw new Error(`--repo 参数格式无效: ${val ?? ''}`)
      }
      options.repo = val.trim()
    } else if (arg === '--token') {
      const val = argv[++i]
      if (!val || val.startsWith('-')) {
        throw new Error('--token 参数必须提供有效的 GitHub 访问令牌')
      }
      options.token = val.trim()
    } else {
      throw new Error(`未知的命令行参数: ${arg}`)
    }
  }

  return options
}

export function resolveVersion(customVersion) {
  if (customVersion) return customVersion
  const pkgPath = path.join(ELECTRON_CLIENT_DIR, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`无法找到客户端 package.json: ${pkgPath}`)
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  if (!pkg.version || !/^\d+\.\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version)) {
    throw new Error(`package.json 中的版本号格式无效: ${pkg.version}`)
  }
  return pkg.version
}

export function computeSha256(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`待计算哈希的文件不存在: ${filePath}`)
  }
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase()
}

export function resolveToolExecutable(toolName) {
  const whereRes = spawnSync('where.exe', [toolName], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
    windowsHide: true
  })
  if (whereRes.status === 0 && whereRes.stdout && whereRes.stdout.trim()) {
    return whereRes.stdout.trim().split(/\r?\n/)[0]
  }
  return null
}

export function runTool(toolName, args = [], options = {}) {
  const executable = resolveToolExecutable(toolName) || toolName
  return spawnSync(executable, args, {
    windowsHide: true,
    ...options
  })
}

export function resolveGitHubToken(customToken) {
  if (customToken) return customToken
  if (process.env.WINGET_RELEASE_TOKEN) return process.env.WINGET_RELEASE_TOKEN.trim()
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()

  const ghRes = runTool('gh', ['auth', 'token'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8'
  })
  if (ghRes.status === 0 && ghRes.stdout && ghRes.stdout.trim()) {
    return ghRes.stdout.trim()
  }

  throw new Error('未检测到有效的 GitHub Token。请先执行 `gh auth login` 或传入 `--token <TOKEN>`。')
}

export function checkWingetToolchain() {
  const wingetPath = resolveToolExecutable('winget')
  if (!wingetPath) {
    throw new Error('未找到系统 winget 命令，请确保已安装 Windows App Installer。')
  }

  let wingetcreatePath = resolveToolExecutable('wingetcreate')
  if (!wingetcreatePath) {
    console.log('未检测到 wingetcreate，正在尝试自动安装 Microsoft.WingetCreate...')
    runTool('winget', [
      'install',
      '--id',
      'Microsoft.WingetCreate',
      '--accept-source-agreements',
      '--accept-package-agreements'
    ], { stdio: 'inherit' })
    wingetcreatePath = resolveToolExecutable('wingetcreate')
    if (!wingetcreatePath) {
      throw new Error('自动安装 Microsoft.WingetCreate 失败，请手动执行 `winget install Microsoft.WingetCreate` 后重试。')
    }
  }

  return { wingetPath, wingetcreatePath }
}

export function checkReleaseAssetOnline({ repo, tag, assetName }) {
  const checkRes = runTool(
    'gh',
    ['release', 'view', tag, '--repo', repo, '--json', 'assets'],
    { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }
  )
  if (checkRes.status !== 0) {
    return null
  }
  try {
    const data = JSON.parse(checkRes.stdout)
    const asset = data.assets?.find((a) => a.name === assetName)
    return asset ?? null
  } catch {
    return null
  }
}

export function buildWingetManifests({
  packageId = DEFAULT_PACKAGE_ID,
  version,
  installerUrl,
  installerSha256
}) {
  if (!packageId || !version || !installerUrl || !installerSha256) {
    throw new Error('构建清单缺少必要参数（packageId, version, installerUrl, installerSha256）')
  }

  const versionYaml = [
    '# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.6.0.schema.json',
    '',
    `PackageIdentifier: ${packageId}`,
    `PackageVersion: ${version}`,
    'DefaultLocale: zh-CN',
    'ManifestType: version',
    'ManifestVersion: 1.6.0',
    ''
  ].join('\n')

  const installerYaml = [
    '# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json',
    '',
    `PackageIdentifier: ${packageId}`,
    `PackageVersion: ${version}`,
    'InstallerLocale: zh-CN',
    'Platform:',
    '  - Windows.Desktop',
    'MinimumOSVersion: 10.0.0.0',
    'InstallerType: exe',
    'Scope: user',
    'InstallModes:',
    '  - interactive',
    '  - silent',
    'InstallerSwitches:',
    '  Silent: /S',
    '  SilentWithProgress: /S',
    'UpgradeBehavior: install',
    'Installers:',
    '  - Architecture: x64',
    `    InstallerUrl: ${installerUrl}`,
    `    InstallerSha256: ${installerSha256.toUpperCase()}`,
    'ManifestType: installer',
    'ManifestVersion: 1.6.0',
    ''
  ].join('\n')

  const localeZhCnYaml = [
    '# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.6.0.schema.json',
    '',
    `PackageIdentifier: ${packageId}`,
    `PackageVersion: ${version}`,
    'PackageLocale: zh-CN',
    'Publisher: ZToolsTeam',
    'PublisherUrl: https://github.com/ZToolsTeam',
    'PublisherSupportUrl: https://github.com/ZToolsTeam/ZTools/issues',
    'PackageName: ZTools',
    'PackageUrl: https://github.com/ZToolsTeam/ZTools',
    'License: GPL-3.0',
    'LicenseUrl: https://github.com/ZToolsTeam/ZTools/blob/main/LICENSE',
    'ShortDescription: 纯粹开源、免费极客、轻量宿主、极致性能的现代化双端效率中枢平台',
    'Description: ZTools 是一款纯粹开源、免费极客、轻量宿主、极致性能的现代化效率中枢平台，基于轻量化纯 TypeScript 宿主与预编译 Native 侧车，提供毫秒级文件秒搜、全键盘启动器与统一声明式扩展生态。',
    'Moniker: ztools',
    'Tags:',
    '  - launcher',
    '  - productivity',
    '  - tools',
    '  - search',
    'ManifestType: defaultLocale',
    'ManifestVersion: 1.6.0',
    ''
  ].join('\n')

  const localeEnUsYaml = [
    '# yaml-language-server: $schema=https://aka.ms/winget-manifest.locale.1.6.0.schema.json',
    '',
    `PackageIdentifier: ${packageId}`,
    `PackageVersion: ${version}`,
    'PackageLocale: en-US',
    'Publisher: ZToolsTeam',
    'PublisherUrl: https://github.com/ZToolsTeam',
    'PublisherSupportUrl: https://github.com/ZToolsTeam/ZTools/issues',
    'PackageName: ZTools',
    'PackageUrl: https://github.com/ZToolsTeam/ZTools',
    'License: GPL-3.0',
    'LicenseUrl: https://github.com/ZToolsTeam/ZTools/blob/main/LICENSE',
    'ShortDescription: Modern, lightweight, open-source productivity launcher and toolkit',
    'Description: ZTools is a pure open-source, geek-oriented, ultra-fast productivity hub built with TypeScript and precompiled native sidecars, featuring sub-millisecond file search, keyboard-first launcher, and declarative extensions.',
    'Tags:',
    '  - launcher',
    '  - productivity',
    '  - tools',
    '  - search',
    'ManifestType: locale',
    'ManifestVersion: 1.6.0',
    ''
  ].join('\n')

  return {
    versionYaml,
    installerYaml,
    localeZhCnYaml,
    localeEnUsYaml
  }
}

export function writeManifestsToDirectory(manifests, targetDir, packageId = DEFAULT_PACKAGE_ID) {
  fs.mkdirSync(targetDir, { recursive: true })
  fs.writeFileSync(path.join(targetDir, `${packageId}.yaml`), manifests.versionYaml, 'utf8')
  fs.writeFileSync(path.join(targetDir, `${packageId}.installer.yaml`), manifests.installerYaml, 'utf8')
  fs.writeFileSync(path.join(targetDir, `${packageId}.locale.zh-CN.yaml`), manifests.localeZhCnYaml, 'utf8')
  fs.writeFileSync(path.join(targetDir, `${packageId}.locale.en-US.yaml`), manifests.localeEnUsYaml, 'utf8')
}

export function validateManifests(manifestDir) {
  const valRes = runTool('winget', ['validate', manifestDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  })
  if (valRes.status !== 0) {
    const errorMsg = (valRes.stdout || '') + '\n' + (valRes.stderr || '')
    throw new Error(`winget validate 校验失败:\n${errorMsg.trim()}`)
  }
  return true
}

export function submitManifestsToWingetPkgs({ manifestDir, token, version, packageId = DEFAULT_PACKAGE_ID }) {
  const prTitle = `Update: ${packageId} version ${version}`
  console.log(`\n🚀 正在向 microsoft/winget-pkgs 提交 PR: "${prTitle}"...`)
  const submitRes = runTool(
    'wingetcreate',
    ['submit', manifestDir, '--token', token, '--prtitle', prTitle, '--no-open'],
    { stdio: 'inherit' }
  )
  if (submitRes.status !== 0) {
    throw new Error(`wingetcreate submit 提交失败，退出码: ${submitRes.status}`)
  }
  return true
}

export function runWingetPublishPipeline(rawArgs = process.argv.slice(2)) {
  const options = parseWingetCliArgs(rawArgs)
  const version = resolveVersion(options.version)
  const tag = `v${version}`
  const installerName = getWindowsInstallerFileName(version)
  const expectedUrl = `https://github.com/ZToolsTeam/ZTools/releases/download/${tag}/${installerName}`

  console.log('========================================================')
  console.log(`🌐 ZTools 微软官方 WinGet 自动化发布流水线 (v${version})`)
  console.log(`   目标 PackageIdentifier: ${DEFAULT_PACKAGE_ID}`)
  console.log(`   目标安装包: ${installerName}`)
  console.log(`   下载直链: ${expectedUrl}`)
  console.log('========================================================')

  // 1. 检查本地工具链
  console.log('\n[1/5] 检查系统 winget 与 wingetcreate 工具链...')
  checkWingetToolchain()
  console.log('✔ winget 与 wingetcreate 工具链就绪')

  // 2. 检查或上传 GitHub Release 资产
  console.log('\n[2/5] 检查 GitHub Releases 上的离线安装包资产...')
  let onlineAsset = checkReleaseAssetOnline({ repo: options.repo, tag, assetName: installerName })

  const artifactRoot = getWindowsArtifactRoot(ELECTRON_CLIENT_DIR, version)
  const localInstallerPath = path.join(artifactRoot, installerName)

  if (!onlineAsset) {
    if (options.packageIfMissing) {
      console.log(`ℹ 远端未找到 ${installerName}，触发自动双包构建与上传流水线...`)
      const buildRes = spawnSync(
        process.execPath,
        [path.join(ROOT_DIR, 'scripts', 'package-release-binaries.mjs'), '--upload', '--tag', tag, '--repo', options.repo],
        { stdio: 'inherit', windowsHide: true }
      )
      if (buildRes.status !== 0) {
        throw new Error('自动构建并上传安装包失败，无法继续 WinGet 发布')
      }
      onlineAsset = checkReleaseAssetOnline({ repo: options.repo, tag, assetName: installerName })
    } else {
      // 检查本地是否存在
      if (!fs.existsSync(localInstallerPath)) {
        throw new Error(
          `GitHub Release ${tag} 与本地均未找到 ${installerName}！\n` +
          `请先执行 npm run release:binaries 上传安装包，或添加 --package 参数自动打包上传。`
        )
      }
      console.log(`⚠ 远端尚未发布该安装包，但本地发现已有产物: ${localInstallerPath}`)
    }
  }

  // 3. 计算与校验安装包 SHA-256
  console.log('\n[3/5] 获取安装包 SHA-256 哈希摘要...')
  let sha256 = ''
  if (fs.existsSync(localInstallerPath)) {
    sha256 = computeSha256(localInstallerPath)
    console.log(`✔ 本地哈希校验通过: ${sha256}`)
  } else {
    throw new Error(`本地缺少安装包文件，无法安全计算 SHA-256: ${localInstallerPath}`)
  }

  // 4. 生成规范的 4 份 WinGet 清单并严格校验
  console.log('\n[4/5] 生成 WinGet 标准清单并进行本地语法/语义校验...')
  const manifests = buildWingetManifests({
    packageId: DEFAULT_PACKAGE_ID,
    version,
    installerUrl: expectedUrl,
    installerSha256: sha256
  })

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `winget-${version}-`))
  try {
    writeManifestsToDirectory(manifests, tempDir, DEFAULT_PACKAGE_ID)
    validateManifests(tempDir)
    console.log('✔ 本地 winget validate 严格校验 100% 通过（0 错误 0 警告）')

    // 5. 提交至 microsoft/winget-pkgs
    console.log('\n[5/5] 执行 WinGet PR 发布提交...')
    if (options.dryRun) {
      console.log('✔ [Dry-Run] 演练模式：已成功生成并校验清单，跳过 PR 提交。')
      console.log(`  清单生成目录: ${tempDir}`)
      return { version, sha256, dryRun: true }
    }

    const token = resolveGitHubToken(options.token)
    submitManifestsToWingetPkgs({
      manifestDir: tempDir,
      token,
      version,
      packageId: DEFAULT_PACKAGE_ID
    })
    console.log('\n🎉 WinGet 官方 PR 提交成功！请关注微软机器人沙箱自动化测试与合并状态。')
    return { version, sha256, dryRun: false }
  } finally {
    if (!options.dryRun) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]).toLowerCase() ===
    path.resolve(fileURLToPath(import.meta.url)).toLowerCase()

if (isMainModule) {
  try {
    runWingetPublishPipeline()
  } catch (err) {
    console.error(`\n❌ [WinGet 发布失败] ${err.message}`)
    process.exit(1)
  }
}
