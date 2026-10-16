import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  parseWingetCliArgs,
  buildWingetManifests,
  writeManifestsToDirectory,
  validateManifests,
  computeSha256,
  resolveToolExecutable,
  checkWingetToolchain
} from '../scripts/publish-winget.mjs'

test('Winget发布工具套件 - CLI 参数解析与异常边界测试', () => {
  // 1. 正常参数解析
  const opts = parseWingetCliArgs([
    '--version', 'v2.0.0',
    '--dry-run',
    '--package',
    '--repo', 'codingmuse/ZTools',
    '--token', 'ghp_testtoken123'
  ])
  assert.equal(opts.version, '2.0.0', '应当自动剥除开头的 v 前缀')
  assert.equal(opts.dryRun, true)
  assert.equal(opts.packageIfMissing, true)
  assert.equal(opts.repo, 'codingmuse/ZTools')
  assert.equal(opts.token, 'ghp_testtoken123')

  // 2. 异常边界：非法 repo 格式拦截
  assert.throws(
    () => parseWingetCliArgs(['--repo', 'invalid-repo-without-slash']),
    /--repo 参数格式无效/,
    '必须拒绝非 owner/repo 格式的仓库参数'
  )

  // 3. 异常边界：缺失必要参数值拦截
  assert.throws(
    () => parseWingetCliArgs(['--version']),
    /--version 参数必须提供有效的版本号/,
    '未提供版本号时必须抛错'
  )
  assert.throws(
    () => parseWingetCliArgs(['--token']),
    /--token 参数必须提供有效的 GitHub 访问令牌/,
    '未提供 token 时必须抛错'
  )

  // 4. 异常边界：未知参数拦截
  assert.throws(
    () => parseWingetCliArgs(['--unknown-flag']),
    /未知的命令行参数/,
    '未知参数必须直接阻断'
  )
})

test('Winget发布工具套件 - Manifest 清单构建与严格模式契约测试', () => {
  const manifests = buildWingetManifests({
    packageId: 'codingmuse.ZTools',
    version: '1.2.3.4',
    installerUrl: 'https://github.com/codingmuse/ZTools/releases/download/v1.2.3.4/ZTools-1.2.3.4-win32-x64.exe',
    installerSha256: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
  })

  // 1. 校验版本清单
  assert.match(manifests.versionYaml, /PackageIdentifier: codingmuse\.ZTools/)
  assert.match(manifests.versionYaml, /PackageVersion: 1\.2\.3\.4/)
  assert.match(manifests.versionYaml, /DefaultLocale: zh-CN/)
  assert.match(manifests.versionYaml, /ManifestType: version/)

  // 2. 校验安装器清单（静默安装与作用域契约）
  assert.match(manifests.installerYaml, /InstallerType: exe/)
  assert.match(manifests.installerYaml, /Scope: user/)
  assert.match(manifests.installerYaml, /Silent: \/S/)
  assert.match(manifests.installerYaml, /Architecture: x64/)
  assert.match(manifests.installerYaml, /ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890/, 'SHA256 必须转为全大写以符合规范')

  // 3. 校验中文区域清单
  assert.match(manifests.localeZhCnYaml, /ManifestType: defaultLocale/)
  assert.match(manifests.localeZhCnYaml, /Moniker: ztools/)
  assert.match(manifests.localeZhCnYaml, /PackageLocale: zh-CN/)
  assert.match(manifests.localeZhCnYaml, /License: GPL-3\.0/)

  // 4. 校验英文区域清单（确保不存在 Moniker 违规字段）
  assert.match(manifests.localeEnUsYaml, /ManifestType: locale/)
  assert.match(manifests.localeEnUsYaml, /PackageLocale: en-US/)
  assert.doesNotMatch(manifests.localeEnUsYaml, /Moniker:/, '非 defaultLocale 清单严禁包含 Moniker 字段')

  // 5. 异常注入：缺失必填参数时阻断
  assert.throws(
    () => buildWingetManifests({ version: '', installerUrl: '', installerSha256: '' }),
    /构建清单缺少必要参数/,
    '空参数必须阻断'
  )
})

test('Winget发布工具套件 - 端到端清单写入与本地 winget validate 真实验证闭环', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winget-e2e-test-'))
  try {
    const manifests = buildWingetManifests({
      packageId: 'codingmuse.ZTools',
      version: '1.1.7.1',
      installerUrl: 'https://github.com/codingmuse/ZTools/releases/download/v1.1.7.1/ZTools-1.1.7.1-win32-x64.exe',
      installerSha256: '1AE921AB53885DE54CDBD310F80B4D4F3156D30365AC95CEBB1D5F6D1AD8B249'
    })

    writeManifestsToDirectory(manifests, tempDir, 'codingmuse.ZTools')

    assert.ok(fs.existsSync(path.join(tempDir, 'codingmuse.ZTools.yaml')))
    assert.ok(fs.existsSync(path.join(tempDir, 'codingmuse.ZTools.installer.yaml')))
    assert.ok(fs.existsSync(path.join(tempDir, 'codingmuse.ZTools.locale.zh-CN.yaml')))
    assert.ok(fs.existsSync(path.join(tempDir, 'codingmuse.ZTools.locale.en-US.yaml')))

    // 调用真实本地 winget validate 执行校验
    const isValid = validateManifests(tempDir)
    assert.equal(isValid, true, '真实生成的完整清单必须通过 winget validate 零错误零警告校验')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('Winget发布工具套件 - 破坏性混沌测试（注入畸形清单必须被 validate 拦截）', () => {
  const chaosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'winget-chaos-test-'))
  try {
    // 注入非法的 InstallerType
    const brokenInstallerYaml = [
      '# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.6.0.schema.json',
      'PackageIdentifier: codingmuse.ZTools',
      'PackageVersion: 1.1.7.1',
      'InstallerLocale: zh-CN',
      'Platform:',
      '  - Windows.Desktop',
      'MinimumOSVersion: 10.0.0.0',
      'InstallerType: completely-invalid-installer-type-xyz',
      'Installers:',
      '  - Architecture: x64',
      '    InstallerUrl: https://github.com/codingmuse/ZTools/releases/download/v1.1.7.1/ZTools-1.1.7.1-win32-x64.exe',
      '    InstallerSha256: 1AE921AB53885DE54CDBD310F80B4D4F3156D30365AC95CEBB1D5F6D1AD8B249',
      'ManifestType: installer',
      'ManifestVersion: 1.6.0'
    ].join('\n')

    fs.writeFileSync(path.join(chaosDir, 'codingmuse.ZTools.installer.yaml'), brokenInstallerYaml, 'utf8')

    assert.throws(
      () => validateManifests(chaosDir),
      /winget validate 校验失败/,
      '畸形 Manifest 必须被严格校验拦截并抛出描述性异常'
    )
  } finally {
    fs.rmSync(chaosDir, { recursive: true, force: true })
  }
})

test('Winget发布工具套件 - 工具链检测与文件 SHA256 异常边界测试', () => {
  // 1. 工具链检查必须成功解析真实路径
  const toolchain = checkWingetToolchain()
  assert.ok(toolchain.wingetPath && toolchain.wingetPath.endsWith('.exe'))
  assert.ok(toolchain.wingetcreatePath && toolchain.wingetcreatePath.endsWith('.exe'))

  // 2. 异常边界：计算不存在文件的 SHA-256
  assert.throws(
    () => computeSha256('path/to/non-existent-file-xyz.bin'),
    /待计算哈希的文件不存在/,
    '计算不存在的文件哈希必须明确拦截'
  )
})
