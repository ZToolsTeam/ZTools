import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  buildDevElectronArgs,
  formatWindowsArgList,
  launchDetachedOnWindowsDefaultDesktop,
  shouldRebuildProject,
  startCrossPlatformDev
} from '../scripts/dev-bootstrap.mjs'
import {
  buildDevNativePluginManifest,
  ensureDevCommonLibsKeyPair,
  findLocalCommonLibsSourceDir,
  loadLocalNativePluginSpecs,
  resetDevSandbox,
  resolveDevSandboxPaths,
  syncDevCommonLibs,
  syncDevPlugins
} from '../scripts/dev-sandbox-sync.mjs'
import {
  generateNativeTrustKeyPair,
  verifyPluginDirectory
} from '../scripts/sign-native-trust.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const clientRequire = createRequire(path.join(REPO_ROOT, 'electron-client', 'package.json'))

function loadCompiledElectronModule(relOutPath) {
  const fullPath = path.join(REPO_ROOT, 'electron-client', 'out', relOutPath)
  assert.ok(fs.existsSync(fullPath), `缺少已编译产物，请先编译 electron-client: ${fullPath}`)
  return clientRequire(fullPath)
}

function createMinimalPlugin(rootDir, id, manifestPatch = {}, entryCode = 'module.exports = () => null') {
  const dir = path.join(rootDir, id)
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true })
  const manifest = {
    id,
    name: `Plugin ${id}`,
    version: '1.0.0',
    entry: 'dist/index.js',
    icon: 'icon.svg',
    targets: [
      { id: 'windows-electron-any', platform: 'windows', runtime: 'electron', arch: 'any' },
      { id: 'macos-electron-any', platform: 'macos', runtime: 'electron', arch: 'any' }
    ],
    nativeComponents: [],
    ...manifestPatch
  }
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8')
  fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg/>', 'utf8')
  fs.writeFileSync(path.join(dir, 'dist', 'index.js'), entryCode, 'utf8')
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), '// source should not be copied', 'utf8')
  fs.writeFileSync(path.join(dir, 'tests', 'index.test.mjs'), '// test should not be copied', 'utf8')
  return dir
}

describe('L0/L1: dev 沙盒隔离参数解析、打包免疫与启动透传', () => {
  it('T0-1: 打包态 (isPackaged=true) 强制忽略全部 --dev-* 参数，严禁放行草稿或开发公钥', () => {
    const { parseDevRuntimeOptions } = loadCompiledElectronModule('main/runtime/dev-options.js')
    const opts = parseDevRuntimeOptions(
      [
        'ZTools.exe',
        '--data-root=D:\\Custom Data\\DataV2',
        '--dev-allow-drafts',
        '--dev-commonlibs-public-keys=D:\\evil\\keys.json'
      ],
      { isPackaged: true, cwd: REPO_ROOT }
    )

    assert.equal(opts.isDevIsolated, false)
    assert.equal(opts.devAllowDrafts, false)
    assert.equal(opts.devCommonLibsPublicKeysPath, undefined)
    assert.equal(opts.isolatedUserDataRoot, undefined)
    assert.equal(opts.requestedDataRoot, path.normalize('D:\\Custom Data\\DataV2'))
  })

  it('T0-2: 非打包开发态正确解析隔离路径、含空格路径、--dev-allow-drafts 与 --dev-exclude-drafts', () => {
    const { parseDevRuntimeOptions } = loadCompiledElectronModule('main/runtime/dev-options.js')
    const devBase = path.join(os.tmpdir(), 'ztools dev 沙盒', 'DataV2')
    const keyFile = path.join(os.tmpdir(), 'ztools dev 沙盒', 'DevTrust', 'keys.json')

    const enabled = parseDevRuntimeOptions(
      [
        'electron.exe',
        '.',
        `--data-root=${devBase}`,
        '--dev-allow-drafts',
        `--dev-commonlibs-public-keys=${keyFile}`
      ],
      { isPackaged: false, cwd: REPO_ROOT }
    )
    assert.equal(enabled.isDevIsolated, true)
    assert.equal(enabled.devAllowDrafts, true)
    assert.equal(enabled.requestedDataRoot, path.normalize(devBase))
    assert.equal(enabled.isolatedUserDataRoot, path.join(path.dirname(path.normalize(devBase)), 'UserData'))
    assert.equal(enabled.devCommonLibsPublicKeysPath, path.normalize(keyFile))

    const excluded = parseDevRuntimeOptions(
      ['electron.exe', '.', `--data-root=${devBase}`, '--dev-allow-drafts', '--dev-exclude-drafts'],
      { isPackaged: false, cwd: REPO_ROOT }
    )
    assert.equal(excluded.devAllowDrafts, false)
  })

  it('T0-3: .ztools-dev/ 数据变动不触发 shouldRebuildProject 误重编，且参数格式化安全转义空格', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-dev-rebuild-'))
    try {
      const mainOut = path.join(tmpRoot, 'electron-client', 'out', 'main')
      const preloadOut = path.join(tmpRoot, 'electron-client', 'out', 'preload')
      const webOut = path.join(tmpRoot, 'electron-client', 'out', 'assets', 'web')
      const devData = path.join(tmpRoot, '.ztools-dev', 'DataV2')
      fs.mkdirSync(mainOut, { recursive: true })
      fs.mkdirSync(preloadOut, { recursive: true })
      fs.mkdirSync(webOut, { recursive: true })
      fs.mkdirSync(devData, { recursive: true })

      fs.writeFileSync(path.join(mainOut, 'bootstrap.js'), '// built')
      fs.writeFileSync(path.join(webOut, 'index.html'), '<html></html>')
      fs.writeFileSync(path.join(preloadOut, 'main.js'), 'window.__ok = true')
      fs.writeFileSync(path.join(preloadOut, 'runtime-capability-prompt.js'), 'window.__ok = true')

      const future = new Date(Date.now() + 60_000)
      const runtimeDb = path.join(devData, 'clipboard_history.sqlite')
      fs.writeFileSync(runtimeDb, 'sqlite-bytes')
      fs.utimesSync(runtimeDb, future, future)

      assert.deepEqual(shouldRebuildProject(tmpRoot), { rebuild: false, reason: 'up-to-date' })

      const formatted = formatWindowsArgList(['.', '--data-root=E:\\My Repo\\.ztools-dev\\DataV2', '--dev-allow-drafts'])
      assert.equal(formatted, '. "--data-root=E:\\My Repo\\.ztools-dev\\DataV2" --dev-allow-drafts')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('T1-1: buildDevElectronArgs 与 Windows 桌面穿透 launchDetachedOnWindowsDefaultDesktop 正确透传隔离参数', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-dev-launch-'))
    try {
      const paths = resolveDevSandboxPaths(tmpRoot)
      ensureDevCommonLibsKeyPair(paths.devTrustRoot)

      const electronArgs = buildDevElectronArgs({ rootDir: tmpRoot, includeDrafts: true })
      assert.ok(electronArgs.includes(`--data-root=${paths.dataRoot}`))
      assert.ok(electronArgs.includes('--dev-allow-drafts'))
      assert.ok(electronArgs.includes(`--dev-commonlibs-public-keys=${paths.devPublicKeysPath}`))

      const clientDir = path.join(tmpRoot, 'electron-client')
      const electronExe = path.join(clientDir, 'node_modules', 'electron', 'dist', 'electron.exe')
      fs.mkdirSync(path.dirname(electronExe), { recursive: true })
      fs.writeFileSync(electronExe, 'mock')

      let capturedEnv = null
      const status = launchDetachedOnWindowsDefaultDesktop(clientDir, {
        electronArgs,
        runner: (_cmd, _args, opts) => {
          capturedEnv = opts.env
          return { status: 0 }
        }
      })
      assert.equal(status, 0)
      assert.ok(capturedEnv.ZTOOLS_ELECTRON_ARGS.includes(`--data-root=${paths.dataRoot}`))
      assert.ok(capturedEnv.ZTOOLS_ELECTRON_ARGS.includes('--dev-allow-drafts'))
      assert.ok(capturedEnv.ZTOOLS_ELECTRON_ARGS.includes('--dev-commonlibs-public-keys='))
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('T1-2: startCrossPlatformDev 同步触发 dev-sandbox-sync.mjs 并向 Electron 透传隔离参数', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-dev-cross-'))
    try {
      fs.mkdirSync(path.join(tmpRoot, 'scripts'), { recursive: true })
      fs.writeFileSync(path.join(tmpRoot, 'scripts', 'dev-sandbox-sync.mjs'), '// sync stub')
      fs.mkdirSync(path.join(tmpRoot, 'electron-client', 'node_modules', 'typescript', 'bin'), { recursive: true })
      fs.writeFileSync(path.join(tmpRoot, 'electron-client', 'package.json'), '{}')
      fs.writeFileSync(path.join(tmpRoot, 'electron-client', 'node_modules', 'typescript', 'bin', 'tsc'), '')
      fs.mkdirSync(path.join(tmpRoot, 'frontend', 'node_modules', 'vite', 'bin'), { recursive: true })
      fs.writeFileSync(path.join(tmpRoot, 'frontend', 'package.json'), '{}')
      fs.writeFileSync(path.join(tmpRoot, 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'), '')
      fs.mkdirSync(path.join(tmpRoot, 'packages', 'declarative-ui', 'dist'), { recursive: true })
      fs.writeFileSync(path.join(tmpRoot, 'packages', 'declarative-ui', 'package.json'), '{}')
      fs.writeFileSync(path.join(tmpRoot, 'packages', 'declarative-ui', 'dist', 'index.js'), '')
      fs.writeFileSync(path.join(tmpRoot, 'packages', 'declarative-ui', 'dist', 'index.d.ts'), '')
      fs.mkdirSync(path.join(tmpRoot, 'electron-client', 'out', 'main'), { recursive: true })
      fs.mkdirSync(path.join(tmpRoot, 'electron-client', 'out', 'preload'), { recursive: true })
      fs.mkdirSync(path.join(tmpRoot, 'electron-client', 'out', 'assets', 'web'), { recursive: true })
      fs.writeFileSync(path.join(tmpRoot, 'electron-client', 'out', 'main', 'bootstrap.js'), '')
      fs.writeFileSync(path.join(tmpRoot, 'electron-client', 'out', 'preload', 'main.js'), '')
      fs.writeFileSync(path.join(tmpRoot, 'electron-client', 'out', 'preload', 'runtime-capability-prompt.js'), '')
      fs.writeFileSync(path.join(tmpRoot, 'electron-client', 'out', 'assets', 'web', 'index.html'), '')

      const invocations = []
      const res = startCrossPlatformDev({
        rootDir: tmpRoot,
        platform: 'win32',
        env: {},
        log: () => {},
        warn: () => {},
        runner: (cmd, args) => {
          invocations.push({ cmd, args })
          return { status: 0 }
        }
      })

      assert.equal(res.status, 0)
      assert.ok(invocations.some((c) => c.args.some((a) => a.endsWith('dev-sandbox-sync.mjs'))))
      const electronCall = invocations.find((c) => c.args.includes('electron'))
      assert.ok(electronCall, '应调用 Electron 启动')
      assert.ok(electronCall.args.some((a) => a.startsWith('--data-root=') && a.includes('.ztools-dev')))
      assert.ok(electronCall.args.includes('--dev-allow-drafts'))
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

describe('L1: syncDevPlugins 增量同步与 resetDevSandbox 锁保护', () => {
  it('T1-3: 增量同步包含草稿插件、跳过 revoked/辅助目录/缺失入口、不复制 src/tests，且支持增量命中与清理', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-plugin-sync-'))
    try {
      const srcPlugins = path.join(tmpRoot, 'plugins')
      fs.mkdirSync(path.join(srcPlugins, 'scripts'), { recursive: true })
      fs.mkdirSync(path.join(srcPlugins, 'shared'), { recursive: true })
      createMinimalPlugin(srcPlugins, 'alpha-tool')
      createMinimalPlugin(srcPlugins, 'beta-draft', { draft: true })
      createMinimalPlugin(srcPlugins, 'gamma-revoked', { revoked: true })
      // 缺少 dist/index.js 的损坏插件
      fs.mkdirSync(path.join(srcPlugins, 'delta-broken'), { recursive: true })
      fs.writeFileSync(
        path.join(srcPlugins, 'delta-broken', 'plugin.json'),
        JSON.stringify({ id: 'delta-broken', name: 'Broken', version: '1.0.0', entry: 'dist/index.js' })
      )

      const first = syncDevPlugins({ rootDir: tmpRoot, log: () => {}, warn: () => {} })
      assert.equal(first.skipped, false)
      assert.equal(first.totalPlugins, 2)
      assert.equal(first.draftCount, 1)
      assert.equal(first.updatedPlugins, 2)
      assert.deepEqual(first.skippedRevoked, ['gamma-revoked'])
      assert.deepEqual(first.skippedMissingEntry, ['delta-broken'])

      const paths = resolveDevSandboxPaths(tmpRoot)
      assert.ok(fs.existsSync(path.join(paths.pluginsRoot, 'alpha-tool', 'dist', 'index.js')))
      assert.ok(fs.existsSync(path.join(paths.pluginsRoot, 'beta-draft', 'dist', 'index.js')))
      assert.equal(fs.existsSync(path.join(paths.pluginsRoot, 'alpha-tool', 'src')), false)
      assert.equal(fs.existsSync(path.join(paths.pluginsRoot, 'alpha-tool', 'tests')), false)
      assert.equal(fs.existsSync(path.join(paths.pluginsRoot, 'gamma-revoked')), false)
      assert.equal(fs.existsSync(path.join(paths.pluginsRoot, 'scripts')), false)

      // 二次同步无变化应完全命中缓存
      const second = syncDevPlugins({ rootDir: tmpRoot, log: () => {}, warn: () => {} })
      assert.equal(second.copiedFiles, 0)
      assert.equal(second.unchangedPlugins, 2)

      // 注入旧多余文件，修改源码 dist 触发增量更新并自动清理多余产物
      fs.writeFileSync(path.join(paths.pluginsRoot, 'alpha-tool', 'dist', 'stale.js'), '// stale')
      fs.writeFileSync(path.join(srcPlugins, 'alpha-tool', 'dist', 'index.js'), 'module.exports = () => "v2"')
      const third = syncDevPlugins({ rootDir: tmpRoot, log: () => {}, warn: () => {} })
      assert.equal(third.copiedFiles, 1)
      assert.equal(fs.existsSync(path.join(paths.pluginsRoot, 'alpha-tool', 'dist', 'stale.js')), false)
      assert.equal(
        fs.readFileSync(path.join(paths.pluginsRoot, 'alpha-tool', 'dist', 'index.js'), 'utf8'),
        'module.exports = () => "v2"'
      )
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('T1-4: resetDevSandbox 在存在存活 runtime.lock 进程时拒绝删除，进程退出后安全清空', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-dev-reset-'))
    try {
      const paths = resolveDevSandboxPaths(tmpRoot)
      fs.mkdirSync(path.dirname(paths.runtimeLockPath), { recursive: true })
      fs.writeFileSync(
        paths.runtimeLockPath,
        JSON.stringify({ schemaVersion: 1, pid: process.pid, ownerId: 'test', businessDataRoot: paths.dataRoot, acquiredAt: new Date().toISOString() })
      )

      assert.throws(
        () => resetDevSandbox({ rootDir: tmpRoot, log: () => {} }),
        /无法重置 \.ztools-dev\/：检测到开发测试版 ZTools 进程仍在运行/
      )
      assert.ok(fs.existsSync(paths.sandboxRoot))

      // 替换为无效死 PID 后应允许清理
      fs.writeFileSync(
        paths.runtimeLockPath,
        JSON.stringify({ schemaVersion: 1, pid: 999999, ownerId: 'test', businessDataRoot: paths.dataRoot, acquiredAt: new Date().toISOString() })
      )
      const res = resetDevSandbox({ rootDir: tmpRoot, log: () => {} })
      assert.equal(res.removed, true)
      assert.equal(fs.existsSync(paths.sandboxRoot), false)

      // 再次调用幂等返回 removed: false
      assert.equal(resetDevSandbox({ rootDir: tmpRoot, log: () => {} }).removed, false)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

describe('L2: 真实装配跨模块集成与混沌异常测试', () => {
  it('T2-1: 真实 PluginInstallService 契约验证草稿标记、生产屏蔽与真实卸载不伤源码', async () => {
    const { PluginInstallService } = loadCompiledElectronModule('main/services/plugin-install-service.js')
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-int-plugins-'))
    const events = { publishHostToMain: () => ({ success: true, delivered: 0 }) }

    try {
      const srcPlugins = path.join(tmpRoot, 'plugins')
      createMinimalPlugin(srcPlugins, 'json-format', { name: 'JSON 格式化' })
      // 故障注入：故意在不可信 plugin.json 中伪造 devDraftAllowed/devLocalInstalled 字段，验证生产态强制覆写为 false
      createMinimalPlugin(srcPlugins, 'pdf', {
        name: 'PDF 工具箱',
        draft: true,
        devDraftAllowed: true,
        devLocalInstalled: true
      })
      syncDevPlugins({ rootDir: tmpRoot, log: () => {}, warn: () => {} })

      const paths = resolveDevSandboxPaths(tmpRoot)

      // 1. 模拟生产/禁用草稿模式：即使 plugin.json 伪造保留字段也必须完全剥离，保持线上返回结构零多余字段
      const prodService = new PluginInstallService(paths.dataRoot, events, { allowDevDrafts: false })
      try {
        const listedProd = await prodService.list()
        const pdfProd = listedProd.data.find((p) => p.pluginId === 'pdf')
        assert.ok(pdfProd, 'DataV2/Plugins 中应存在同步后的 pdf 插件')
        assert.equal(Object.hasOwn(pdfProd, 'devDraftAllowed'), false)
        assert.equal(Object.hasOwn(pdfProd, 'devLocalInstalled'), false)
      } finally {
        await prodService.stop()
      }

      // 2. 模拟非打包 dev 模式：下发 devDraftAllowed 与 devLocalInstalled
      const devService = new PluginInstallService(paths.dataRoot, events, { allowDevDrafts: true })
      try {
        const listedDev = await devService.list()
        const pdfDev = listedDev.data.find((p) => p.pluginId === 'pdf')
        const jsonDev = listedDev.data.find((p) => p.pluginId === 'json-format')
        assert.equal(pdfDev.devDraftAllowed, true)
        assert.equal(pdfDev.devLocalInstalled, true)
        assert.equal(jsonDev.devDraftAllowed, false)
        assert.equal(jsonDev.devLocalInstalled, true)

        // 3. 真实卸载测试：模拟线上卸载流程，仅移除 DataV2/Plugins/pdf，仓库源码 plugins/pdf 毫发无损
        const uninstallRes = await devService.uninstall({ pluginId: 'pdf' })
        assert.equal(uninstallRes.success, true)
        assert.equal(fs.existsSync(path.join(paths.pluginsRoot, 'pdf')), false)
        assert.ok(fs.existsSync(path.join(srcPlugins, 'pdf', 'plugin.json')), '源码仓库 plugins/pdf 必须毫发无损')
      } finally {
        await devService.stop()
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('T2-2: 真实 CommonLibs 同步落盘 + CommonLibsManager 离线 ECDSA P-256 验签 + 真机执行 + 篡改拦截 + 清理闭环', async () => {
    const { CommonLibsManager } = loadCompiledElectronModule('main/tool-runtime/core/commonlibs-manager.js')
    const {
      loadCommonLibsTrustBundle,
      parseStrictCommonLibsJson,
      validateCommonLibsPublicKeysSchema
    } = loadCompiledElectronModule('main/tool-runtime/core/commonlibs-trust.js')

    const localCommonLibsSrc = findLocalCommonLibsSourceDir(REPO_ROOT)
    if (!localCommonLibsSrc || process.platform !== 'win32') {
      // 开源仓或非 Windows 平台无本机 win32 zip 资产时跳过真实二进制执行段，不阻断开源仓测试
      return
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-int-commonlibs-'))
    try {
      const paths = resolveDevSandboxPaths(tmpRoot)
      const sync1 = await syncDevCommonLibs({
        rootDir: tmpRoot,
        sourceCommonLibsDir: localCommonLibsSrc,
        destCommonLibsDir: paths.commonLibsRoot,
        devTrustRoot: paths.devTrustRoot,
        log: () => {},
        warn: () => {}
      })
      assert.equal(sync1.skipped, false)
      assert.ok(sync1.syncedTools.includes('media-toolkit-7.1.0'))
      assert.ok(sync1.syncedTools.includes('stream-downloader-2026.1.0'))
      assert.ok(fs.existsSync(sync1.publicKeysPath))

      // 二次同步命中缓存，零重复解压
      const sync2 = await syncDevCommonLibs({
        rootDir: tmpRoot,
        sourceCommonLibsDir: localCommonLibsSrc,
        destCommonLibsDir: paths.commonLibsRoot,
        devTrustRoot: paths.devTrustRoot,
        log: () => {},
        warn: () => {}
      })
      assert.equal(sync2.syncedTools.length, 0)
      assert.ok(sync2.cachedTools.includes('media-toolkit-7.1.0'))
      assert.ok(sync2.cachedTools.includes('stream-downloader-2026.1.0'))

      const resourcesDir = path.join(REPO_ROOT, 'electron-client', 'resources', 'commonlibs')

      // 1. 仅用生产内置公钥必须严格拒绝本地 dev 签名（安全边界验证）
      const prodOnlyManager = new CommonLibsManager({
        dataRoot: paths.dataRoot,
        resourcesDir,
        fetchImpl: async () => {
          throw new Error('离线验证严禁发起网络请求')
        }
      })
      assert.equal(await prodOnlyManager.isToolReadyOffline('media-toolkit-7.1.0', 'bin/ffprobe.exe'), false)

      // 2. 合并本地开发公钥后，完整通过离线 ECDSA P-256 验签与逐文件 SHA-256 校验（零网络请求）
      const extraKeys = validateCommonLibsPublicKeysSchema(
        parseStrictCommonLibsJson(fs.readFileSync(sync1.publicKeysPath, 'utf8'))
      )
      const mergedBundle = loadCommonLibsTrustBundle(resourcesDir, { extraPublicKeys: extraKeys })
      const devManager = new CommonLibsManager({
        dataRoot: paths.dataRoot,
        resourcesDir,
        trustBundle: mergedBundle,
        fetchImpl: async () => {
          throw new Error('离线验证严禁发起网络请求')
        }
      })

      assert.equal(await devManager.isToolReadyOffline('media-toolkit-7.1.0', 'bin/ffprobe.exe'), true)
      assert.equal(await devManager.isToolReadyOffline('stream-downloader-2026.1.0', 'bin/yt-dlp.exe'), true)

      const ffprobeResolved = await devManager.resolveExecutable('media-toolkit-7.1.0', 'bin/ffprobe.exe')
      const ytdlpResolved = await devManager.resolveExecutable('stream-downloader-2026.1.0', 'bin/yt-dlp.exe')

      // 3. 真实执行二进制验证可用性
      const ffprobeRun = spawnSync(ffprobeResolved.executablePath, ['-version'], { encoding: 'utf8', windowsHide: true })
      assert.equal(ffprobeRun.status, 0, `ffprobe 执行失败: ${ffprobeRun.stderr}`)
      assert.match(ffprobeRun.stdout, /ffprobe version/i)

      const ytdlpRun = spawnSync(ytdlpResolved.executablePath, ['--version'], { encoding: 'utf8', windowsHide: true })
      assert.equal(ytdlpRun.status, 0, `yt-dlp 执行失败: ${ytdlpRun.stderr}`)
      assert.ok(ytdlpRun.stdout.trim().length > 0)

      // 4. 清单枚举与破坏性篡改注入测试（篡改 1 字节必须 Fail-Fast 拦截）
      const inventory = await devManager.listInventory(new Map())
      assert.equal(inventory.items.length, 2)

      const originalBytes = fs.readFileSync(ffprobeResolved.executablePath)
      const tampered = Buffer.from(originalBytes)
      tampered[tampered.length - 1] ^= 0xff
      fs.writeFileSync(ffprobeResolved.executablePath, tampered)
      devManager.invalidateToolCache('media-toolkit-7.1.0')

      await assert.rejects(
        () => devManager.resolveExecutable('media-toolkit-7.1.0', 'bin/ffprobe.exe'),
        /tampered|mismatch|TRUST_VERIFICATION_FAILED/i
      )

      // 5. 手动清理（模拟清理后可走线上下载）
      const cleaned = await devManager.cleanManual({ toolId: 'media-toolkit-7.1.0' }, new Map())
      assert.deepEqual(cleaned.removedToolIds, ['media-toolkit-7.1.0'])
      assert.equal(fs.existsSync(path.join(paths.commonLibsRoot, 'media-toolkit-7.1.0')), false)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('T2-3: 本地原生 DLL 插件同步合包、ECDSA P-256 签发、缓存命中、缺私钥降级与关闭开关清理', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-native-sync-'))
    try {
      const srcPlugins = path.join(tmpRoot, 'plugins')
      createMinimalPlugin(srcPlugins, 'demo-native', {
        version: '2.1.0',
        draft: true,
        commonLibs: []
      })

      // 构造最小合法 Win32 x86 原生 DLL PE 缓冲区（含完整 DOS + COFF + Optional + 1 个合法节表）
      const buildFakeX86DllBuffer = (tagByte) => {
        const buf = Buffer.alloc(1024, 0)
        buf.writeUInt16LE(0x5a4d, 0) // MZ
        const peOffset = 0x80
        buf.writeUInt32LE(peOffset, 0x3c)
        buf.writeUInt32LE(0x00004550, peOffset) // PE\0\0
        buf.writeUInt16LE(0x014c, peOffset + 4) // IA32
        buf.writeUInt16LE(1, peOffset + 6) // 1 section
        buf.writeUInt16LE(224, peOffset + 20) // PE32 optional header size
        buf.writeUInt16LE(0x2002, peOffset + 22) // EXECUTABLE_IMAGE | DLL
        buf.writeUInt16LE(0x010b, peOffset + 24) // PE32 magic
        // Section header at peOffset + 24 + 224 = 0x178
        const secOff = peOffset + 24 + 224
        buf.write('.text', secOff, 'ascii')
        buf.writeUInt32LE(64, secOff + 16) // SizeOfRawData
        buf.writeUInt32LE(0x200, secOff + 20) // PointerToRawData
        buf[0x200] = tagByte
        return buf
      }

      const dllConfigDir = path.join(tmpRoot, 'DLLPlugins', 'demo-native')
      const dllOutputLibDir = path.join(tmpRoot, 'DLLPlugins', 'outputs', 'demo-native', 'lib')
      fs.mkdirSync(dllConfigDir, { recursive: true })
      fs.mkdirSync(dllOutputLibDir, { recursive: true })
      fs.writeFileSync(
        path.join(dllConfigDir, 'native-release.json'),
        JSON.stringify(
          {
            schemaVersion: 1,
            id: 'demo-native',
            authorDir: 'ztools-team',
            dllId: 'DemoNativePlugin',
            componentId: 'demo-native-plugin',
            dllEntry: 'lib/DemoNativePlugin.dll',
            requireAdmin: false,
            unpublished: true,
            functions: ['CheckTools', 'RunAction'],
            commonLibs: [],
            signedCommonLibs: ['stream-downloader-2026.1.0', 'media-toolkit-7.1.0'],
            payloadEntries: ['lib/HelperDep.dll'],
            assetEntries: ['lib/font.ttf'],
            roleOverrides: {}
          },
          null,
          2
        ),
        'utf8'
      )
      fs.writeFileSync(path.join(dllOutputLibDir, 'DemoNativePlugin.dll'), buildFakeX86DllBuffer(0x11))
      fs.writeFileSync(path.join(dllOutputLibDir, 'HelperDep.dll'), buildFakeX86DllBuffer(0x22))
      fs.writeFileSync(path.join(dllOutputLibDir, 'font.ttf'), Buffer.from('NOT-PE-FONT-DATA'))

      const specs = loadLocalNativePluginSpecs({ rootDir: tmpRoot, warn: () => {} })
      assert.equal(specs.size, 1)

      // 1. 缺私钥（模拟开源仓/未配置私钥环境）：优雅降级为纯声明式同步，不报错
      const warnings = []
      const noKeyRes = syncDevPlugins({
        rootDir: tmpRoot,
        platform: 'win32',
        env: {},
        log: () => {},
        warn: (msg) => warnings.push(msg)
      })
      assert.equal(noKeyRes.nativePlugins.length, 0)
      assert.equal(noKeyRes.skippedNativePlugins.length, 1)
      assert.equal(noKeyRes.skippedNativePlugins[0].reason, 'missing-private-key')
      assert.ok(warnings.some((w) => w.includes('未检测到本地原生插件签名私钥')))
      const paths = resolveDevSandboxPaths(tmpRoot)
      const sandboxPluginDir = path.join(paths.pluginsRoot, 'demo-native')
      assert.equal(fs.existsSync(path.join(sandboxPluginDir, 'native-trust.json')), false)

      // 2. 提供有效私钥后，首次同步自动合入 DLL/伴生资源、生成沙盒版 plugin.json（源码不变）并签发 native-trust
      const keyPair = generateNativeTrustKeyPair('dev-native-test-key', ['native'])
      const first = syncDevPlugins({
        rootDir: tmpRoot,
        platform: 'win32',
        nativePrivateKeyPem: keyPair.privateKeyPem,
        env: {},
        log: () => {},
        warn: () => {}
      })
      assert.deepEqual(first.nativePlugins, ['demo-native'])
      assert.deepEqual(first.updatedNativePlugins, ['demo-native'])
      assert.equal(first.cachedNativePlugins.length, 0)

      // 源码 plugin.json 必须毫发无损（仍无 dllloader）
      const rawSourceManifest = JSON.parse(fs.readFileSync(path.join(srcPlugins, 'demo-native', 'plugin.json'), 'utf8'))
      assert.equal(rawSourceManifest.dllloader, undefined)

      // 沙盒版 plugin.json 保留 draft 且包含同构 dllloader / nativeComponents（含 data 格式伴生资源）
      const sandboxManifest = JSON.parse(fs.readFileSync(path.join(sandboxPluginDir, 'plugin.json'), 'utf8'))
      assert.equal(sandboxManifest.draft, true)
      assert.equal(sandboxManifest.dllloader, 'lib/DemoNativePlugin.dll')
      assert.equal(sandboxManifest.minAppVersion, '1.3.0.0')
      assert.equal(sandboxManifest.nativeComponents.length, 1)
      assert.equal(sandboxManifest.nativeComponents[0].entry, 'lib/DemoNativePlugin.dll')
      assert.equal(sandboxManifest.nativeComponents[0].payloadFiles.length, 2)
      assert.ok(sandboxManifest.nativeComponents[0].payloadFiles.some((f) => f.entry === 'lib/font.ttf' && f.format === 'data'))

      // 使用与生产一致的离线验签器验证 native-trust.json / .sig 与 signedCommonLibs
      const verified = verifyPluginDirectory({
        pluginDir: sandboxPluginDir,
        publicKeys: [{ keyId: 'ztools-native-prod-2026a', publicKeyHex: keyPair.publicKeyHex, usages: ['native'] }],
        expectedPluginId: 'demo-native',
        expectedRequireAdmin: false
      })
      assert.deepEqual(verified.manifest.commonLibs, ['stream-downloader-2026.1.0', 'media-toolkit-7.1.0'])

      // 3. 二次同步零变更应完全命中原生签名缓存
      const second = syncDevPlugins({
        rootDir: tmpRoot,
        platform: 'win32',
        nativePrivateKeyPem: keyPair.privateKeyPem,
        env: {},
        log: () => {},
        warn: () => {}
      })
      assert.deepEqual(second.cachedNativePlugins, ['demo-native'])
      assert.equal(second.updatedNativePlugins.length, 0)
      assert.equal(second.copiedFiles, 0)

      // 4. 修改原生 DLL 后应自动重新复制并重签，且旧签名失效/新签名通过
      fs.writeFileSync(path.join(dllOutputLibDir, 'DemoNativePlugin.dll'), buildFakeX86DllBuffer(0x99))
      const future = new Date(Date.now() + 5_000)
      fs.utimesSync(path.join(dllOutputLibDir, 'DemoNativePlugin.dll'), future, future)
      const third = syncDevPlugins({
        rootDir: tmpRoot,
        platform: 'win32',
        nativePrivateKeyPem: keyPair.privateKeyPem,
        env: {},
        log: () => {},
        warn: () => {}
      })
      assert.deepEqual(third.updatedNativePlugins, ['demo-native'])
      verifyPluginDirectory({
        pluginDir: sandboxPluginDir,
        publicKeys: [{ keyId: 'ztools-native-prod-2026a', publicKeyHex: keyPair.publicKeyHex, usages: ['native'] }],
        expectedPluginId: 'demo-native',
        expectedRequireAdmin: false
      })

      // 5. 关闭 syncNativePlugins 后应自动清理残留原生 DLL 与签名，恢复纯声明式 plugin.json
      const disabled = syncDevPlugins({
        rootDir: tmpRoot,
        platform: 'win32',
        syncNativePlugins: false,
        log: () => {},
        warn: () => {}
      })
      assert.equal(disabled.nativePlugins.length, 0)
      assert.equal(fs.existsSync(path.join(sandboxPluginDir, 'native-trust.json')), false)
      assert.equal(fs.existsSync(path.join(sandboxPluginDir, 'native-trust.sig')), false)
      assert.equal(fs.existsSync(path.join(sandboxPluginDir, 'lib')), false)
      const restoredManifest = JSON.parse(fs.readFileSync(path.join(sandboxPluginDir, 'plugin.json'), 'utf8'))
      assert.equal(restoredManifest.dllloader, undefined)

      // 额外契约断言：buildDevNativePluginManifest 不污染输入对象
      const untouched = { id: 'x', version: '1.0.0', commonLibs: ['legacy-a'] }
      const built = buildDevNativePluginManifest(untouched, specs.get('demo-native'), {
        dllSha256: 'a'.repeat(64),
        payloadFiles: []
      })
      assert.equal(untouched.dllloader, undefined)
      assert.equal(built.dllloader, 'lib/DemoNativePlugin.dll')
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('T2-4: 真实仓库 video-downloader + batch-video 端到端原生同步、PluginInstallService 验签与 DllPluginService __commonLibs 注入闭环', async () => {
    const localCommonLibsSrc = findLocalCommonLibsSourceDir(REPO_ROOT)
    const privateKeysFile = path.join(REPO_ROOT, 'native-trust-private-keys.json')
    const videoDll = path.join(REPO_ROOT, 'DLLPlugins', 'outputs', 'video-downloader', 'lib', 'VideoDownloaderPlugin.dll')
    if (
      process.platform !== 'win32' ||
      !localCommonLibsSrc ||
      !fs.existsSync(privateKeysFile) ||
      !fs.existsSync(videoDll)
    ) {
      // 开源仓或非 Windows 环境无本地商业 DLL/私钥时优雅跳过
      return
    }

    const { PluginInstallService } = loadCompiledElectronModule('main/services/plugin-install-service.js')
    const { createWindowsNativeTrustInstallVerifier } = loadCompiledElectronModule('main/services/native-trust-verifier.js')
    const { DllPluginService } = loadCompiledElectronModule('main/services/dll-plugin-service.js')
    const { NativeMediaPathPolicy } = loadCompiledElectronModule('main/services/native-media-policy.js')
    const { NativeHostClient } = loadCompiledElectronModule('main/native-host/native-host-client.js')
    const { CommonLibsManager } = loadCompiledElectronModule('main/tool-runtime/core/commonlibs-manager.js')
    const {
      loadCommonLibsTrustBundle,
      parseStrictCommonLibsJson,
      validateCommonLibsPublicKeysSchema
    } = loadCompiledElectronModule('main/tool-runtime/core/commonlibs-trust.js')

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-int-video-native-'))
    try {
      const paths = resolveDevSandboxPaths(tmpRoot)
      const pluginRes = syncDevPlugins({
        rootDir: tmpRoot,
        sourcePluginsDir: path.join(REPO_ROOT, 'plugins'),
        destPluginsDir: paths.pluginsRoot,
        dllPluginsDir: path.join(REPO_ROOT, 'DLLPlugins'),
        dllOutputsDir: path.join(REPO_ROOT, 'DLLPlugins', 'outputs'),
        devTrustRoot: paths.devTrustRoot,
        nativeKeyFilePath: privateKeysFile,
        pluginFilter: ['video-downloader', 'batch-video'],
        platform: 'win32',
        log: () => {},
        warn: () => {}
      })
      assert.ok(pluginRes.nativePlugins.includes('video-downloader'))
      assert.ok(pluginRes.nativePlugins.includes('batch-video'))

      const commonRes = await syncDevCommonLibs({
        rootDir: tmpRoot,
        sourceCommonLibsDir: localCommonLibsSrc,
        destCommonLibsDir: paths.commonLibsRoot,
        devTrustRoot: paths.devTrustRoot,
        log: () => {},
        warn: () => {}
      })
      assert.equal(commonRes.skipped, false)

      const nativeTrustVerifier = createWindowsNativeTrustInstallVerifier(
        path.join(REPO_ROOT, 'electron-client', 'resources', 'native')
      )
      const events = { publishHostToMain: () => ({ success: true, delivered: 0 }) }
      const installService = new PluginInstallService(paths.dataRoot, events, {
        allowDevDrafts: true,
        nativeTrustVerifier
      })

      const commonLibsResourcesDir = path.join(REPO_ROOT, 'electron-client', 'resources', 'commonlibs')
      const extraKeys = validateCommonLibsPublicKeysSchema(
        parseStrictCommonLibsJson(fs.readFileSync(commonRes.publicKeysPath, 'utf8'))
      )
      const commonLibsManager = new CommonLibsManager({
        dataRoot: paths.dataRoot,
        resourcesDir: commonLibsResourcesDir,
        trustBundle: loadCommonLibsTrustBundle(commonLibsResourcesDir, { extraPublicKeys: extraKeys }),
        fetchImpl: async () => {
          throw new Error('已预置 CommonLibs 严禁联网下载')
        }
      })

      const nativeMediaPolicy = new NativeMediaPathPolicy({
        resolveAuthorizedPath: async (rawPath) => path.resolve(rawPath)
      })

      let capturedParams = null
      const fakeNativeHost = {
        onDllEvent: () => () => {},
        acquirePluginMaintenance: async () => () => {},
        callDll: async (_pluginId, _dllId, _funcName, params) => {
          capturedParams = params
          return { code: 0, result: JSON.stringify({ success: true, ytdlp: { available: true }, ffmpeg: { available: true } }) }
        }
      }
      const dllService = new DllPluginService(
        installService,
        fakeNativeHost,
        null,
        { publishHostToOwner: () => ({ success: true, delivered: 0 }) },
        undefined,
        {},
        nativeMediaPolicy,
        undefined,
        'win32',
        undefined,
        commonLibsManager
      )

      try {
        // 校验含非 PE 伴生资源（lib/msyh.ttf）的 batch-video 也能完整通过 exactLibrary 校验
        await installService.withPluginManifest('batch-video', async (manifest) => {
          assert.equal(manifest.dllloader, 'lib/BatchVideoPlugin.dll')
        })

        // 校验 video-downloader 通过官方生产公钥验签并正确提取 signedCommonLibs
        await installService.withPluginManifest('video-downloader', async (manifest, metadata) => {
          assert.equal(manifest.dllloader, 'lib/VideoDownloaderPlugin.dll')
          assert.deepEqual(metadata?.signedCommonLibs, ['stream-downloader-2026.1.0', 'media-toolkit-7.1.0'])
        })

        // 校验 DllPluginService 真实注入 __commonLibs 目录映射至原生 DLL 参数
        const callRes = await dllService.call(
          { plugin: 'VideoDownloaderPlugin', func: 'CheckTools', params: {} },
          { type: 'plugin', webContentsId: 1, pluginId: 'video-downloader', pluginInstanceId: 'inst-1' }
        )
        assert.equal(callRes.success, true)
        assert.ok(capturedParams && typeof capturedParams.__commonLibs === 'object')
        assert.equal(
          capturedParams.__commonLibs['stream-downloader-2026.1.0'],
          path.join(paths.commonLibsRoot, 'stream-downloader-2026.1.0')
        )
        assert.equal(
          capturedParams.__commonLibs['media-toolkit-7.1.0'],
          path.join(paths.commonLibsRoot, 'media-toolkit-7.1.0')
        )

        // 若本机已编译 ZToolsNativeHost32.exe，进一步走真实 32 位原生宿主 + VideoDownloaderPlugin.dll 实测 CheckTools
        const nativeHostExe = path.join(REPO_ROOT, 'electron-client', 'out', 'native', 'win32-ia32', 'ZToolsNativeHost32.exe')
        if (fs.existsSync(nativeHostExe)) {
          const realNativeHost = new NativeHostClient(nativeHostExe, {
            pluginRoot: paths.pluginsRoot,
            dataRoot: paths.dataRoot
          })
          const liveDllService = new DllPluginService(
            installService,
            realNativeHost,
            null,
            { publishHostToOwner: () => ({ success: true, delivered: 0 }) },
            undefined,
            {},
            nativeMediaPolicy,
            undefined,
            'win32',
            undefined,
            commonLibsManager
          )
          try {
            await realNativeHost.start()
            const liveRes = await liveDllService.call(
              { plugin: 'VideoDownloaderPlugin', func: 'CheckTools', params: {} },
              { type: 'plugin', webContentsId: 2, pluginId: 'video-downloader', pluginInstanceId: 'inst-live' }
            )
            assert.equal(liveRes.success, true, `真实 NativeHost32 调用失败: ${JSON.stringify(liveRes)}`)
            assert.equal(liveRes.data?.ytdlp?.available, true, `真实 CheckTools 未识别 yt-dlp: ${JSON.stringify(liveRes.data)}`)
            assert.equal(liveRes.data?.ffmpeg?.available, true, `真实 CheckTools 未识别 ffmpeg: ${JSON.stringify(liveRes.data)}`)
          } finally {
            await liveDllService.stop()
            await realNativeHost.stop()
          }
        }
      } finally {
        await dllService.stop()
        await installService.stop()
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
