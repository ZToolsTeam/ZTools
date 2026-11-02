import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AutostartService, initializeDefaultAutostart } from '../../src/main/services/autostart-service.js'
import { ConfigService } from '../../src/main/services/config-service.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'
import { createMacosLoginItemAdapter } from '../../src/main/platform/macos/login-item.js'
import { readClosePreferences } from '../../src/main/windows/close-behavior.js'

async function createFixture(t: test.TestContext, platform: 'win32' | 'darwin' = 'win32') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-autostart-defaults-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = new ConfigService(new JsonFileStore(root, ConfigService.allowedStoreFiles))
  const system = { enabled: false, requiresApproval: false, ignoreEnable: false, failWrite: false, failRead: false }
  const writes: boolean[] = []
  const get = () => {
    if (system.failRead) throw new Error('读取失败')
    return system.enabled
  }
  const set = (enabled: boolean) => {
    writes.push(enabled)
    if (system.failWrite) throw new Error('写入失败')
    if (!enabled || !system.ignoreEnable) system.enabled = enabled
  }
  const windows = new AutostartService({
    platform: 'win32',
    executablePath: path.join(root, 'ZTools.exe'),
    adapter: {
      getLoginItemSettings: () => ({ openAtLogin: get() }),
      setLoginItemSettings: (settings) => set(settings.openAtLogin)
    }
  })
  const macos = createMacosLoginItemAdapter({
    platform: 'darwin',
    isPackaged: true,
    app: {
      getLoginItemSettings: () => ({
        openAtLogin: get(),
        wasOpenedAtLogin: false,
        status: system.requiresApproval ? 'requires-approval' : system.enabled ? 'enabled' : 'not-registered'
      }),
      setLoginItemSettings: (settings) => set(settings.openAtLogin)
    }
  })
  const loginItem = {
    getEnabled: () => platform === 'darwin' ? macos.get().openAtLogin : windows.get().enabled,
    setEnabled: (enabled: boolean) => {
      if (platform === 'darwin') macos.setEnabled(enabled)
      else windows.set(enabled)
    }
  }
  return { root, config, system, writes, loginItem, macos }
}

for (const platform of ['win32', 'darwin'] as const) {
  test(`${platform} 首次运行开启自启动并保留默认后台运行，后续系统关闭不被覆盖`, async (t) => {
    const { root, config, system, writes, loginItem } = await createFixture(t, platform)
    await initializeDefaultAutostart(root, config, loginItem)
    assert.equal(system.enabled, true)
    assert.equal(await config.getSetting('autostart'), 'true')
    assert.equal((await readClosePreferences(config)).minimizeToTray, true)
    system.enabled = false
    await initializeDefaultAutostart(root, config, loginItem)
    assert.equal(system.enabled, false)
    assert.deepEqual(writes, [true])
  })
}

for (const existing of ['{}', '{"system":{"autostart":false,"minimizeToTray":false}}', '{invalid']) {
  test(`已有配置不重新注册登录项：${existing}`, async (t) => {
    const { root, config, system, writes, loginItem } = await createFixture(t)
    const file = path.join(root, 'user_settings.json')
    await fs.writeFile(file, existing)
    system.failRead = true
    await initializeDefaultAutostart(root, config, loginItem)
    assert.deepEqual(writes, [])
    assert.equal(await fs.readFile(file, 'utf8'), existing)
  })
}

test('macOS 待系统批准的登录项保留真实状态', async (t) => {
  const { root, config, system, loginItem, macos } = await createFixture(t, 'darwin')
  system.requiresApproval = true
  await initializeDefaultAutostart(root, config, loginItem)
  assert.equal(macos.get().status, 'requires-approval')
  assert.equal(await config.getSetting('autostart'), 'true')
})

test('系统未确认开启时回滚且不写入配置，后续可重试', async (t) => {
  const { root, config, system, writes, loginItem } = await createFixture(t)
  system.ignoreEnable = true
  await assert.rejects(initializeDefaultAutostart(root, config, loginItem), { code: 'NOT_SUPPORTED' })
  assert.equal(system.enabled, false)
  assert.deepEqual(writes, [true, false])
  assert.equal(await config.getSetting('autostart'), '')
  system.ignoreEnable = false
  await initializeDefaultAutostart(root, config, loginItem)
  assert.equal(system.enabled, true)
})

test('读取系统状态失败时不修改登录项和配置', async (t) => {
  const { root, config, system, writes, loginItem } = await createFixture(t)
  system.failRead = true
  await assert.rejects(initializeDefaultAutostart(root, config, loginItem), /读取失败/)
  assert.deepEqual(writes, [])
  assert.equal(await config.getSetting('autostart'), '')
})

test('配置写入失败时恢复原登录项状态，不关闭原已启用的登录项', async (t) => {
  const { root, config, system, writes, loginItem } = await createFixture(t)
  const failingConfig = { async set() { throw new Error('配置写入失败') } }
  await assert.rejects(initializeDefaultAutostart(root, failingConfig, loginItem), /配置写入失败/)
  assert.equal(system.enabled, false)
  assert.deepEqual(writes, [true, false])
  system.enabled = true
  writes.length = 0
  await assert.rejects(initializeDefaultAutostart(root, failingConfig, loginItem), /配置写入失败/)
  assert.equal(system.enabled, true)
  assert.deepEqual(writes, [])
  assert.equal(await config.getSetting('autostart'), '')
})

test('登录项写入与回滚均失败时明确报告两个错误', async (t) => {
  const { root, config, system, writes, loginItem } = await createFixture(t)
  system.failWrite = true
  await assert.rejects(initializeDefaultAutostart(root, config, loginItem), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 2)
    return true
  })
  assert.deepEqual(writes, [true, false])
  assert.equal(await config.getSetting('autostart'), '')
})

test('配置路径访问异常不能视作首次运行', async (t) => {
  const { root, config, writes, loginItem } = await createFixture(t)
  const invalidRoot = path.join(root, 'not-a-directory')
  await fs.writeFile(invalidRoot, '')
  await assert.rejects(initializeDefaultAutostart(invalidRoot, config, loginItem), { code: 'ENOTDIR' })
  assert.deepEqual(writes, [])
})
