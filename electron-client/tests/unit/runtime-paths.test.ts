import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { RuntimeLock } from '../../src/main/runtime/runtime-lock.js'
import {
  resolveRuntimePaths,
  runtimePathsForBusinessDataRoot
} from '../../src/main/runtime/runtime-paths.js'
import { PluginInstallService } from '../../src/main/services/plugin-install-service.js'

// 这些用例依赖 Windows 路径语义（C:\\ / E:\\）或 Windows 宿主能力（DLL、进程启动、更新安装链、本地 .exe 软件），
// 在其他平台上功能代码按设计会拒绝执行，因此只在 Windows 宿主运行；Windows CI 上照常覆盖。
const windowsOnly = { skip: process.platform === 'win32' ? false : '依赖 Windows 路径或宿主能力，仅在 Windows 上运行' }


test('production paths keep the business data root on DataV2 and isolate runtime state from legacy Data', windowsOnly, () => {
  const paths = resolveRuntimePaths({
    mode: 'production',
    appDataRoot: 'C:\\Users\\tester\\AppData\\Roaming',
    installRoot: 'D:\\Apps\\ZTools',
    ownerId: 'S-1-5-21-test'
  })
  assert.equal(paths.businessDataRoot, 'C:\\Users\\tester\\AppData\\Roaming\\ZTools\\DataV2')
  assert.notEqual(paths.businessDataRoot, 'C:\\Users\\tester\\AppData\\Roaming\\ZTools\\Data')
  assert.equal(paths.browserProfileRoot, 'C:\\Users\\tester\\AppData\\Roaming\\ZTools\\ElectronProfile')
  assert.equal(paths.ownerId, 'S-1-5-21-test')
  assert.notEqual(paths.cacheRoot, paths.businessDataRoot)
  assert.notEqual(paths.backupRoot, paths.businessDataRoot)
})

test('production paths honor an explicit isolated business data root', windowsOnly, () => {
  const paths = resolveRuntimePaths({
    mode: 'production',
    appDataRoot: 'C:\\Users\\tester\\AppData\\Roaming',
    installRoot: 'D:\\Apps\\ZTools',
    productRoot: 'E:\\isolated\\ZTools',
    businessDataRoot: 'E:\\isolated\\ZTools\\Data',
    ownerId: 'test-owner'
  })
  assert.equal(paths.businessDataRoot, 'E:\\isolated\\ZTools\\Data')
  assert.equal(paths.browserProfileRoot, 'E:\\isolated\\ZTools\\ElectronProfile')
  assert.equal(paths.transactionRoot, 'E:\\isolated\\ZTools\\Migration\\Transactions')
  assert.equal(paths.logRoot, 'E:\\isolated\\ZTools\\Logs')
})

test('development and test paths cannot fall back to the production data root', windowsOnly, () => {
  const production = resolveRuntimePaths({
    mode: 'production',
    appDataRoot: 'C:\\Users\\tester\\AppData\\Roaming',
    installRoot: 'D:\\Apps\\ZTools',
    ownerId: 'test'
  })
  const development = resolveRuntimePaths({
    mode: 'development',
    appDataRoot: 'C:\\Users\\tester\\AppData\\Roaming',
    userDataRoot: 'C:\\Users\\tester\\AppData\\Roaming\\ZTools-Electron',
    installRoot: 'D:\\src\\ztools-electron',
    ownerId: 'test'
  })
  const testRoot = runtimePathsForBusinessDataRoot('C:\\fixtures\\ztools\\Data')
  assert.notEqual(development.businessDataRoot, production.businessDataRoot)
  assert.equal(development.mode, 'development')
  assert.equal(testRoot.mode, 'test')
  assert.equal(testRoot.businessDataRoot, 'C:\\fixtures\\ztools\\Data')
})

test('runtime lock blocks a second writer without creating business data', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-runtime-lock-'))
  const paths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'), 'test-owner')
  try {
    const lock = await RuntimeLock.acquire(paths)
    try {
      await assert.rejects(
        RuntimeLock.acquire(paths),
        (error) => error instanceof ZToolsError && error.code === errorCodes.databaseLocked
      )
      await assert.rejects(fs.access(paths.businessDataRoot))
      assert.equal(lock.record.businessDataRoot, paths.businessDataRoot)
    } finally {
      await lock.release()
    }
    const secondLock = await RuntimeLock.acquire(paths)
    await secondLock.release()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runtime lock recovers a legacy lock whose live PID was reused', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-reused-pid-'))
  const paths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'), 'test-owner')
  const lockPath = path.join(paths.transactionRoot, 'runtime.lock')
  const staleRecord = {
    schemaVersion: 1, pid: process.pid, ownerId: 'old-owner',
    businessDataRoot: paths.businessDataRoot, acquiredAt: '2000-01-01T00:00:00.000Z'
  }
  try {
    await fs.mkdir(paths.transactionRoot, { recursive: true })
    await fs.writeFile(lockPath, JSON.stringify(staleRecord))
    const lock = await RuntimeLock.acquire(paths)
    try {
      assert.equal(lock.record.ownerId, 'test-owner')
      const quarantined = (await fs.readdir(paths.transactionRoot)).filter((name) => name.startsWith('runtime.lock.stale-'))
      assert.equal(quarantined.length, 1)
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(paths.transactionRoot, quarantined[0]!), 'utf8')), staleRecord)
      await assert.rejects(RuntimeLock.acquire(paths),
        (error) => error instanceof ZToolsError && error.code === errorCodes.databaseLocked)
    } finally {
      await lock.release()
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('runtime lock preserves a live PID when acquisition time cannot be verified', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-unknown-lock-time-'))
  const paths = runtimePathsForBusinessDataRoot(path.join(root, 'Data'), 'test-owner')
  const lockPath = path.join(paths.transactionRoot, 'runtime.lock')
  const source = JSON.stringify({
    schemaVersion: 1, pid: process.pid, ownerId: 'test-owner',
    businessDataRoot: paths.businessDataRoot, acquiredAt: 'unknown'
  })
  try {
    await fs.mkdir(paths.transactionRoot, { recursive: true })
    await fs.writeFile(lockPath, source)
    await assert.rejects(RuntimeLock.acquire(paths),
      (error) => error instanceof ZToolsError && error.code === errorCodes.databaseLocked)
    assert.equal(await fs.readFile(lockPath, 'utf8'), source)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('production DataV2 completely isolates PluginInstallService from corrupted or incompatible plugins in legacy Data directory', async () => {
  const appDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-datav2-isolation-'))
  try {
    // 1. 构造旧版 Data 目录中的破坏性异常数据（畸形 JSON 插件、缺少 targets 的旧版不兼容插件、损坏的 plugin_state.json）
    const legacyDataRoot = path.join(appDataRoot, 'ZTools', 'Data')
    const legacyCorruptPluginDir = path.join(legacyDataRoot, 'Plugins', 'corrupt-legacy-plugin')
    const legacyIncompatiblePluginDir = path.join(legacyDataRoot, 'Plugins', 'incompatible-v1-plugin')
    await fs.mkdir(legacyCorruptPluginDir, { recursive: true })
    await fs.mkdir(legacyIncompatiblePluginDir, { recursive: true })
    await fs.writeFile(path.join(legacyCorruptPluginDir, 'plugin.json'), '{ invalid json !!!', 'utf8')
    await fs.writeFile(path.join(legacyIncompatiblePluginDir, 'plugin.json'), JSON.stringify({
      id: 'incompatible-v1-plugin',
      name: 'Old V1 Plugin',
      version: '1.0.0',
      entry: 'missing-index.html'
    }), 'utf8')
    await fs.writeFile(path.join(legacyDataRoot, 'plugin_state.json'), '<<<corrupted-state>>>', 'utf8')

    // 2. 通过生产模式 resolveRuntimePaths 解析路径，应当指向 DataV2
    const runtimePaths = resolveRuntimePaths({
      mode: 'production',
      appDataRoot,
      installRoot: path.join(appDataRoot, 'Install'),
      ownerId: 'test-owner'
    })
    assert.equal(runtimePaths.businessDataRoot, path.join(appDataRoot, 'ZTools', 'DataV2'))

    // 3. 启动 PluginInstallService，验证完全视为全新用户（零报错、不扫描旧 Data 目录）
    const publishedEvents: Array<{ type: string; payload: unknown }> = []
    const installService = new PluginInstallService(runtimePaths.businessDataRoot, {
      publishHostToMain(type, payload) {
        publishedEvents.push({ type, payload })
        return { success: true, delivered: 1 }
      }
    })

    try {
      const listResult = await installService.list()
      assert.equal(listResult.success, true)
      assert.deepEqual(listResult.data, [])
      // 断言绝未触发任何 plugin_manifest_invalid 异常事件
      assert.equal(publishedEvents.filter((e) => e.type === 'plugin_manifest_invalid').length, 0)

      // 断言尝试打开旧目录中的插件时，明确抛出 pluginNotFound 错误而非解析崩溃
      await assert.rejects(
        installService.withPluginManifest('corrupt-legacy-plugin', async () => 'should-not-run'),
        (error) => error instanceof ZToolsError && error.code === errorCodes.pluginNotFound
      )
    } finally {
      await installService.stop()
    }
  } finally {
    await fs.rm(appDataRoot, { recursive: true, force: true })
  }
})

