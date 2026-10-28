import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { showDesktopNotification } from '../../src/main/platform/desktop-notification.js'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { FileSystemService } from '../../src/main/services/file-system-service.js'
import {
  createSystemBrowserUrlAdapter,
  createSystemPowerAdapter,
  parseBrowserWindowTitle,
  readSystemBatteryStatus,
  resolveSystemVolumePath,
  SystemService,
  type SystemAdapter,
  type SystemBrowserUrlAdapter,
  type SystemPowerAction,
  type SystemPowerAdapter
} from '../../src/main/services/system-service.js'
import type { WindowRegistry } from '../../src/main/windows/window-registry.js'

const mainCaller: CallerIdentity = { type: 'main', webContentsId: 1 }
const pluginCaller: CallerIdentity = {
  type: 'plugin',
  webContentsId: 2,
  pluginId: 'plugin.test'
}

test('system service exposes compatible queries and cleans caller-owned blockers', async () => {
  assert.equal(resolveSystemVolumePath('win32', undefined, 'D:'), 'D:\\')
  assert.equal(resolveSystemVolumePath('win32', 'C:\\'), 'C:\\')
  assert.equal(resolveSystemVolumePath('darwin'), '/')
  assert.equal(resolveSystemVolumePath('darwin', '/Volumes/External Disk'), '/Volumes/External Disk')
  assert.throws(
    () => resolveSystemVolumePath('darwin', 'C:\\'),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )
  assert.throws(
    () => resolveSystemVolumePath('win32', '/'),
    (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
  )

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-system-'))
  const removedListeners = new Set<(webContentsId: number) => void>()
  const registry = {
    onRemoved(listener: (webContentsId: number) => void) {
      removedListeners.add(listener)
      return () => removedListeners.delete(listener)
    }
  } as unknown as WindowRegistry
  const files = new FileSystemService(registry, path.join(root, 'Cache'))
  const blockerStarts: number[] = []
  const blockerStops: number[] = []
  const notifications: string[] = []
  const powerActions: Array<{
    action: SystemPowerAction
    options: { force?: boolean; timeout?: number }
  }> = []
  let darkMode = false
  const adapter: SystemAdapter = {
    appName: 'ZTools',
    appVersion: '1.1.7.1',
    isDev: true,
    getProductVersion: () => '15.0.1',
    paths: {
      app: root,
      home: root,
      appData: root,
      userData: root,
      desktop: root,
      documents: root,
      downloads: root,
      music: root,
      pictures: root,
      videos: root
    },
    isDarkMode: () => darkMode,
    setDarkMode: (enabled) => { darkMode = enabled },
    async showNotification(params) { notifications.push(params.message) },
    async getFileIcon() { return 'data:image/png;base64,AA==' },
    async getNativeId() { return '0446386f' },
    async getBatteryStatus() {
      return { percent: 42, isCharging: true, timeRemaining: 3600 }
    },
    startPreventSleep() {
      blockerStarts.push(7)
      return 7
    },
    stopPreventSleep(id) { blockerStops.push(id) }
  }
  const power: SystemPowerAdapter = {
    async execute(action, options) {
      powerActions.push({ action, options })
    }
  }
  const browser: SystemBrowserUrlAdapter = {
    async read() {
      return { url: 'https://example.test/page', browser: 'Chrome' }
    }
  }
  const service = new SystemService(files, registry, adapter, process.platform, power, browser)
  const macService = new SystemService(files, registry, adapter, 'darwin')

  try {
    const macInfo = await macService.getInfo(mainCaller)
    assert.equal(macInfo.platform, 'macos')
    assert.equal(macInfo.osName, 'macOS')
    assert.equal(macInfo.osVersion, '15.0.1')
    assert.equal(Object.hasOwn(macInfo, 'windowsFamily'), false)
    assert.equal(Object.hasOwn(macInfo, 'windowsRelease'), false)
    assert.equal(Object.hasOwn(macInfo, 'osMajor'), false)
    assert.equal(typeof macInfo.kernelRelease, 'string')
    adapter.getProductVersion = () => 'Darwin Kernel Version 24.0.0'
    assert.equal((await macService.getInfo(mainCaller)).osVersion, 'unknown')
    adapter.getProductVersion = () => '15.0.1'

    assert.deepEqual(service.getAppName(), { success: true, appName: 'ZTools' })
    assert.deepEqual(service.getAppVersion(), { success: true, appVersion: '1.1.7.1' })
    assert.deepEqual(await service.getNativeId(), { success: true, nativeId: '0446386F' })
    assert.deepEqual(await service.getBatteryStatus(), {
      success: true,
      percent: 42,
      isCharging: true,
      timeRemaining: 3600
    })
    assert.equal((await service.getInfo(mainCaller)).cachePath, await files.getScopedCachePath(mainCaller))
    assert.equal((await service.getPath({ name: 'temp' }, mainCaller)).path.includes('Temp'), true)
    assert.notEqual(
      (await service.getPath({ name: 'cache' }, mainCaller)).path,
      (await service.getPath({ name: 'cache' }, pluginCaller)).path
    )
    assert.deepEqual(service.setDarkMode(true), { success: true, dark: true })
    assert.equal((await service.getInfo(mainCaller)).darkMode, true)
    await service.notify({ title: 'Test', message: 'message', modal: false }, mainCaller)
    assert.deepEqual(notifications, ['message'])
    const notification = Object.assign(new EventEmitter(), { show() {}, close() {} })
    adapter.showNotification = params => showDesktopNotification(params.title || 'ZTools', params.message, {
      isSupported: () => true, create: () => notification
    })
    let delivered = false
    const pendingNotice = service.notify({ title: '通知测试', message: '等待系统确认', modal: false }, mainCaller).then(result => {
      delivered = true
      return result
    })
    await Promise.resolve()
    assert.equal(delivered, false)
    notification.emit('failed', {}, '系统拒绝通知')
    await assert.rejects(pendingNotice, { code: errorCodes.nativeHostError })
    assert.equal(delivered, false)
    assert.deepEqual(notification.eventNames(), [])
    assert.deepEqual(await service.readCurrentBrowserUrl(), {
      success: true,
      url: 'https://example.test/page',
      browser: 'Chrome'
    })
    assert.deepEqual(await service.shutdown({ force: true, timeout: 12 }), {
      success: true,
      action: 'shutdown'
    })
    assert.deepEqual(await service.restart({ force: false }), {
      success: true,
      action: 'restart'
    })
    assert.deepEqual(await service.logout({ force: true }), {
      success: true,
      action: 'logout'
    })
    assert.deepEqual(await service.lock(), { success: true, action: 'lock' })
    assert.deepEqual(await service.sleep(), { success: true, action: 'sleep' })
    assert.deepEqual(await service.hibernate(), { success: true, action: 'hibernate' })
    assert.deepEqual(powerActions, [
      { action: 'shutdown', options: { force: true, timeout: 12 } },
      { action: 'restart', options: { force: false } },
      { action: 'logout', options: { force: true } },
      { action: 'lock', options: {} },
      { action: 'sleep', options: {} },
      { action: 'hibernate', options: {} }
    ])

    const selected = path.join(root, 'selected.txt')
    await fs.writeFile(selected, 'selected')
    await files.grantOpenPath(selected, mainCaller)
    assert.equal((await service.getFileIcon({ filePath: selected }, mainCaller)).icon, 'data:image/png;base64,AA==')

    assert.equal(Number(service.getCpuUsage().data.total) >= 0, true)
    assert.equal(Number(((await service.getMemoryUsage()).data as Record<string, unknown>).total) > 0, true)
    assert.throws(
      () => service.getNetworkStats(),
      (error) => error instanceof ZToolsError &&
        error.code === errorCodes.notSupported &&
        error.message === '网络流量统计尚未实现'
    )
    if (process.platform === 'win32') {
      const defaultDisk = await service.getDiskUsage({})
      assert.equal(Number((defaultDisk.data as Record<string, unknown>).total) > 0, true)
      const disk = await service.getDiskUsage({ drive: 'C:\\' })
      const diskData = disk.data as Record<string, unknown>
      assert.equal(Number(diskData.total) > 0, true)
      assert.equal(Number(diskData.free) >= 0, true)
    }

    service.setPreventSleep({ enable: true }, mainCaller)
    service.setPreventSleep({ enable: true }, pluginCaller)
    assert.deepEqual(blockerStarts, [7])
    service.setPreventSleep({ enable: false }, mainCaller)
    assert.deepEqual(blockerStops, [])
    for (const listener of removedListeners) listener(pluginCaller.webContentsId)
    assert.deepEqual(blockerStops, [7])
  } finally {
    macService.stop()
    service.stop()
    files.stop()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('native battery reader preserves the legacy unknown-value contract', async () => {
  const status = await readSystemBatteryStatus()
  assert.equal(Number.isInteger(status.percent), true)
  assert.equal(status.percent === 255 || (status.percent >= 0 && status.percent <= 100), true)
  assert.equal(typeof status.isCharging, 'boolean')
  assert.equal(Number.isSafeInteger(status.timeRemaining), true)
  assert.equal(status.timeRemaining >= -1, true)
})

test('system power adapter uses fixed Windows commands and rejects other platforms', async () => {
  const calls: Array<{ executable: string; args: string[] }> = []
  const adapter = createSystemPowerAdapter({
    async run(executable, args) {
      calls.push({ executable, args: [...args] })
    }
  }, 'win32')

  await adapter.execute('shutdown', { force: true, timeout: 30 })
  await adapter.execute('restart', { force: false })
  await adapter.execute('logout', { force: true })
  await adapter.execute('lock', {})
  await adapter.execute('sleep', {})
  await adapter.execute('hibernate', {})

  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  assert.deepEqual(calls, [
    {
      executable: path.win32.join(systemRoot, 'System32', 'shutdown.exe'),
      args: ['/s', '/f', '/t', '30']
    },
    {
      executable: path.win32.join(systemRoot, 'System32', 'shutdown.exe'),
      args: ['/r', '/t', '0']
    },
    {
      executable: path.win32.join(systemRoot, 'System32', 'shutdown.exe'),
      args: ['/l', '/f']
    },
    {
      executable: path.win32.join(systemRoot, 'System32', 'rundll32.exe'),
      args: ['user32.dll,LockWorkStation']
    },
    {
      executable: path.win32.join(systemRoot, 'System32', 'rundll32.exe'),
      args: ['powrprof.dll,SetSuspendState', '0', '0', '0']
    },
    {
      executable: path.win32.join(systemRoot, 'System32', 'rundll32.exe'),
      args: ['powrprof.dll,SetSuspendState', '1', '0', '0']
    }
  ])

  let called = false
  const unsupported = createSystemPowerAdapter({
    async run() { called = true }
  }, 'linux')
  await assert.rejects(
    unsupported.execute('lock', {}),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'NOT_SUPPORTED'
  )
  assert.equal(called, false)
})

test('browser URL adapter preserves the legacy title parsing contract', async () => {
  assert.deepEqual(parseBrowserWindowTitle('Docs - Google Chrome https://example.test/docs'), {
    url: 'https://example.test/docs',
    browser: 'Chrome'
  })
  assert.deepEqual(parseBrowserWindowTitle('Example — Firefox http://localhost:3000/'), {
    url: 'http://localhost:3000/',
    browser: 'Firefox'
  })
  assert.deepEqual(parseBrowserWindowTitle('Terminal - no browser URL'), {
    url: '',
    browser: ''
  })

  const adapter = createSystemBrowserUrlAdapter({
    async readTitle() {
      return 'Settings - Microsoft Edge https://example.test/settings'
    }
  }, 'win32')
  assert.deepEqual(await adapter.read(), {
    url: 'https://example.test/settings',
    browser: 'Edge'
  })

  let called = false
  const unsupported = createSystemBrowserUrlAdapter({
    async readTitle() { called = true; return 'ignored' }
  }, 'linux')
  assert.deepEqual(await unsupported.read(), { url: '', browser: '' })
  assert.equal(called, false)
})
