import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SuperPanelDataService } from '../../src/main/super-panel/data-service.js'
import type { MacApplicationBundle } from '../../src/main/platform/macos/local-application.js'

// 这些用例依赖 Windows 路径语义（C:\\ / E:\\）或 Windows 宿主能力（DLL、进程启动、更新安装链、本地 .exe 软件），
// 在其他平台上功能代码按设计会拒绝执行，因此只在 Windows 宿主运行；Windows CI 上照常覆盖。
const windowsOnly = { skip: process.platform === 'win32' ? false : '依赖 Windows 路径或宿主能力，仅在 Windows 上运行' }


function expectedWindowsLocalAppId(executable: string): string {
  const source = `${executable.trim().replaceAll('/', '\\').toLowerCase()}|`
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `localapp:${hash.toString(16).toUpperCase().padStart(8, '0')}`
}

function createMacService(
  root: string,
  inspectMacApplicationBundle: (selectedPath: string, signal?: AbortSignal) => Promise<MacApplicationBundle>,
  opened: string[],
  openPathResult = ''
): SuperPanelDataService {
  let configuration = JSON.stringify({ pinnedLocalApps: [] })
  return new SuperPanelDataService(
    root,
    {
      get: async () => configuration,
      set: async (_fileName, _pathValue, value) => { configuration = value }
    },
    async () => ({ success: true, data: [] }),
    async (fullPath) => {
      opened.push(fullPath)
      return openPathResult
    },
    { platform: 'darwin', inspectMacApplicationBundle }
  )
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readLocalApps(root: string): Promise<{ apps: unknown[] }> {
  const source = await fs.readFile(path.join(root, 'local_apps.json'), 'utf8')
  return JSON.parse(source.replace(/^\uFEFF/, '')) as { apps: unknown[] }
}

test('persists Delphi-compatible panel pins and local app usage', windowsOnly, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  let configuration = JSON.stringify({
    defaultTab: 'all',
    pinnedLocalApps: []
  })
  const opened: string[] = []
  const service = new SuperPanelDataService(
    root,
    {
      get: async () => configuration,
      set: async (_fileName, _pathValue, value) => { configuration = value }
    },
    async () => ({
      success: true,
      data: [{
        id: 'plugin.test',
        name: 'Test Plugin',
        description: 'Plugin description',
        keywords: ['test'],
        enabled: true
      }]
    }),
    async (fullPath) => {
      opened.push(fullPath)
      return ''
    }
  )

  assert.equal(await service.addLocalApps([process.execPath]), 1)
  const [localApp] = await service.getPanelLocalApps()
  assert.ok(localApp)
  assert.equal(localApp.id, expectedWindowsLocalAppId(await fs.realpath(process.execPath)))

  assert.equal(await service.togglePin('plugin.test', 'plugin'), true)
  assert.equal(await service.togglePin(localApp.id, 'local'), true)
  const data = await service.getData()
  assert.equal(data.defaultTab, 'all')
  assert.equal(data.items.find((item) => item.id === 'plugin.test')?.pinned, true)
  assert.equal(data.items.find((item) => item.id === localApp.id)?.pinned, true)

  await service.launchLocalApp(localApp.id)
  assert.deepEqual(opened, [await fs.realpath(process.execPath)])
  const localDocument = JSON.parse(await fs.readFile(path.join(root, 'local_apps.json'), 'utf8').then(
    (source) => source.replace(/^\uFEFF/, '')
  )) as { apps: Array<{ useCount: number; lastUsedAt: string }> }
  assert.equal(localDocument.apps[0]?.useCount, 1)
  assert.notEqual(localDocument.apps[0]?.lastUsedAt, '')
})

test('stores case-sensitive Mac app bundle records and launches only after identity revalidation', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-mac-app-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const unknownEntry = { preserved: true, type: 'future-local-app' }
  const legacyWindowsEntry = {
    id: 'localapp:1234ABCD',
    name: 'Legacy Windows App',
    exePath: 'C:\\Apps\\Legacy.exe',
    arguments: '',
    panelEnabled: true
  }
  await fs.writeFile(path.join(root, 'local_apps.json'), JSON.stringify({
    apps: [null, unknownEntry, legacyWindowsEntry]
  }), 'utf8')
  const inspected: string[] = []
  const opened: string[] = []
  const inspector = async (selectedPath: string): Promise<MacApplicationBundle> => {
    inspected.push(selectedPath)
    return {
      appPath: selectedPath,
      bundleIdentifier: 'com.example.CaseApp',
      executableName: 'CaseApp'
    }
  }
  const service = createMacService(root, inspector, opened)
  const upperPath = '/Applications/CaseApp.app'
  const lowerPath = '/Applications/caseapp.app'

  assert.equal(await service.addLocalApps([upperPath, lowerPath]), 2)
  const apps = await service.getData()
  const upperItem = apps.items.find((item) => item.name === 'CaseApp')
  const lowerItem = apps.items.find((item) => item.name === 'caseapp')
  assert.ok(upperItem)
  assert.ok(lowerItem)
  assert.match(upperItem.id, /^localapp:mac:[A-F0-9]{64}$/)
  assert.match(lowerItem.id, /^localapp:mac:[A-F0-9]{64}$/)
  assert.notEqual(upperItem.id, lowerItem.id)
  assert.equal(upperItem.description, upperPath)
  assert.deepEqual(await service.getPanelLocalApps(), [])
  assert.equal(await service.togglePin(upperItem.id, 'local'), true)
  assert.equal((await service.getData()).items.find((item) => item.id === upperItem.id)?.pinned, true)

  await service.launchLocalApp(upperItem.id)
  assert.deepEqual(inspected, [upperPath, lowerPath, upperPath])
  assert.deepEqual(opened, [upperPath])

  const stored = await readLocalApps(root)
  assert.equal(stored.apps[0], null)
  assert.deepEqual(stored.apps[1], unknownEntry)
  assert.deepEqual(stored.apps[2], legacyWindowsEntry)
  const storedUpperValue = stored.apps.find((item) => isRecord(item) && item.appPath === upperPath)
  if (!isRecord(storedUpperValue)) throw new Error('Mac app bundle record was not persisted')
  const storedUpper = storedUpperValue
  assert.equal(storedUpper.type, 'mac-app-bundle')
  assert.equal(storedUpper.bundleIdentifier, 'com.example.CaseApp')
  assert.equal('exePath' in storedUpper, false)
  assert.equal('arguments' in storedUpper, false)
  assert.equal(storedUpper.useCount, 1)
  assert.equal(storedUpper.lastUsedAt === '', false)
})

test('does not launch or count a Mac app when its stored bundle identity has changed', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-mac-identity-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const opened: string[] = []
  let inspections = 0
  const inspector = async (selectedPath: string): Promise<MacApplicationBundle> => {
    inspections += 1
    return {
      appPath: selectedPath,
      bundleIdentifier: inspections === 1 ? 'com.example.Before' : 'com.example.After',
      executableName: 'App'
    }
  }
  const service = createMacService(root, inspector, opened)
  const appPath = '/Applications/Changed.app'
  assert.equal(await service.addLocalApps([appPath]), 1)
  const app = (await service.getData()).items.find((item) => item.name === 'Changed')
  assert.ok(app)

  await assert.rejects(service.launchLocalApp(app.id), /身份已变化/)
  assert.deepEqual(opened, [])
  const storedApp = (await readLocalApps(root)).apps[0] as Record<string, unknown> | undefined
  assert.equal(storedApp?.useCount, 0)
})

test('stopping during a delayed Mac app selection prevents persistence', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-mac-stop-add-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const inspectionStarted = deferred<void>()
  const inspectionResult = deferred<MacApplicationBundle>()
  const service = createMacService(root, (_selectedPath, signal) => {
    assert.ok(signal)
    inspectionStarted.resolve()
    return inspectionResult.promise
  }, [])
  const addOperation = service.addLocalApps(['/Applications/Delayed.app'])

  await inspectionStarted.promise
  service.stop()
  inspectionResult.resolve({
    appPath: '/Applications/Delayed.app',
    bundleIdentifier: 'com.example.Delayed',
    executableName: 'Delayed'
  })

  await assert.rejects(addOperation, /数据服务已停止/)
  await assert.rejects(fs.access(path.join(root, 'local_apps.json')))
})

test('stopping during Mac bundle revalidation prevents opening and usage updates', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-mac-stop-launch-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const inspectionStarted = deferred<void>()
  const launchInspection = deferred<MacApplicationBundle>()
  let inspectionCount = 0
  const opened: string[] = []
  const appPath = '/Applications/DelayedLaunch.app'
  const service = createMacService(root, (selectedPath) => {
    inspectionCount += 1
    if (inspectionCount === 1) {
      return Promise.resolve({
        appPath: selectedPath,
        bundleIdentifier: 'com.example.DelayedLaunch',
        executableName: 'DelayedLaunch'
      })
    }
    inspectionStarted.resolve()
    return launchInspection.promise
  }, opened)

  assert.equal(await service.addLocalApps([appPath]), 1)
  const app = (await service.getData()).items.find((item) => item.name === 'DelayedLaunch')
  assert.ok(app)
  const launchOperation = service.launchLocalApp(app.id)
  await inspectionStarted.promise
  service.stop()
  launchInspection.resolve({
    appPath,
    bundleIdentifier: 'com.example.DelayedLaunch',
    executableName: 'DelayedLaunch'
  })

  await assert.rejects(launchOperation, /数据服务已停止/)
  assert.deepEqual(opened, [])
  const storedApp = (await readLocalApps(root)).apps.find((item) => isRecord(item) && item.appPath === appPath)
  assert.equal((storedApp as Record<string, unknown> | undefined)?.useCount, 0)
  assert.equal((storedApp as Record<string, unknown> | undefined)?.lastUsedAt, '')
})

test('refuses a Mac ID collision when its canonical path points at another bundle', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-mac-collision-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const appPath = '/Applications/Selected.app'
  const id = `localapp:mac:${createHash('sha256').update(`mac-app-bundle\0${appPath}`, 'utf8').digest('hex').toUpperCase()}`
  const existing = {
    id,
    type: 'mac-app-bundle',
    appPath: '/Applications/Different.app',
    bundleIdentifier: 'com.example.Different',
    name: 'Different',
    panelEnabled: true
  }
  await fs.writeFile(path.join(root, 'local_apps.json'), JSON.stringify({ apps: [existing] }), 'utf8')
  const service = createMacService(root, async (selectedPath) => ({
    appPath: selectedPath,
    bundleIdentifier: 'com.example.Selected',
    executableName: 'Selected'
  }), [])

  await assert.rejects(service.addLocalApps([appPath]), /ID 冲突/)
  assert.deepEqual((await readLocalApps(root)).apps, [existing])
})

test('does not count a Mac app when LaunchServices reports an open error', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-mac-open-error-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const opened: string[] = []
  const appPath = '/Applications/Unavailable.app'
  const service = createMacService(root, async (selectedPath) => ({
    appPath: selectedPath,
    bundleIdentifier: 'com.example.Unavailable',
    executableName: 'Unavailable'
  }), opened, 'LaunchServices open failed')

  assert.equal(await service.addLocalApps([appPath]), 1)
  const app = (await service.getData()).items.find((item) => item.name === 'Unavailable')
  assert.ok(app)
  await assert.rejects(service.launchLocalApp(app.id), /LaunchServices open failed/)
  assert.deepEqual(opened, [appPath])
  const storedApp = (await readLocalApps(root)).apps.find((item) => isRecord(item) && item.appPath === appPath)
  assert.equal((storedApp as Record<string, unknown> | undefined)?.useCount, 0)

})

test('orders plugin recents by last-used time and local apps by legacy usage order', windowsOnly, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-order-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'plugin_state.json'), JSON.stringify({
    'plugin.old': {
      enabled: true,
      use_count: 100,
      last_used_at: '2024-01-01 00:00:00'
    },
    'plugin.new': {
      enabled: true,
      use_count: 1,
      last_used_at: '2024-02-01 00:00:00'
    },
    'plugin.timestamp': {
      enabled: true,
      use_count: 0,
      last_used_at: '2024-03-01 00:00:00'
    },
    'plugin.count': {
      enabled: true,
      use_count: 999
    }
  }), 'utf8')
  await fs.writeFile(path.join(root, 'local_apps.json'), JSON.stringify({
    apps: [
      {
        id: 'localapp:AAAABBBB',
        name: 'Older',
        exePath: process.execPath,
        arguments: '',
        panelEnabled: true,
        useCount: 10,
        lastUsedAt: '2024-01-01 00:00:00'
      },
      {
        id: 'localapp:CCCCDDDD',
        name: 'Newer',
        exePath: process.execPath,
        arguments: '',
        panelEnabled: true,
        useCount: 10,
        lastUsedAt: '2024-02-01 00:00:00'
      },
      {
        id: 'localapp:EEEEFFFF',
        name: 'Unused',
        exePath: process.execPath,
        arguments: '',
        panelEnabled: true,
        useCount: 0,
        lastUsedAt: '2024-03-01 00:00:00'
      }
    ]
  }), 'utf8')

  const service = new SuperPanelDataService(
    root,
    {
      get: async () => JSON.stringify({
        defaultTab: 'all',
        maxRecentCount: 5,
        pinnedLocalApps: []
      }),
      set: async () => undefined
    },
    async () => ({
      success: true,
      data: [
        { id: 'plugin.old', name: 'Old plugin', enabled: true },
        { id: 'plugin.new', name: 'New plugin', enabled: true },
        { id: 'plugin.timestamp', name: 'Timestamp plugin', enabled: true },
        { id: 'plugin.count', name: 'Count-only plugin', enabled: true }
      ]
    }),
    async () => ''
  )

  const data = await service.getData()
  assert.deepEqual(
    data.items.filter((item) => item.type === 'plugin').map((item) => item.id),
    ['plugin.timestamp', 'plugin.new', 'plugin.old', 'plugin.count']
  )
  assert.equal(data.items.find((item) => item.id === 'plugin.timestamp')?.recent, true)
  assert.equal(data.items.find((item) => item.id === 'plugin.count')?.recent, false)
  assert.deepEqual(
    data.items.filter((item) => item.type === 'local').map((item) => item.id),
    ['localapp:CCCCDDDD', 'localapp:AAAABBBB', 'localapp:EEEEFFFF']
  )
})

test('launches legacy local app arguments without shell expansion', windowsOnly, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-args-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const workingDir = path.dirname(process.execPath)
  await fs.writeFile(path.join(root, 'local_apps.json'), JSON.stringify({
    apps: [{
      id: 'localapp:ABCDEF12',
      name: 'Argument app',
      exePath: process.execPath,
      arguments: '--profile "portable data" --flag=one',
      workingDir,
      panelEnabled: true,
      useCount: 0,
      lastUsedAt: ''
    }]
  }), 'utf8')
  const launches: Array<{ fullPath: string; args: readonly string[]; workingDir: string }> = []
  const service = new SuperPanelDataService(
    root,
    {
      get: async () => JSON.stringify({ defaultTab: 'all', pinnedLocalApps: [] }),
      set: async () => undefined
    },
    async () => ({ success: true, data: [] }),
    async () => {
      throw new Error('openPath should not handle local app arguments')
    },
    undefined,
    async (fullPath, args, launchWorkingDir) => {
      launches.push({ fullPath, args, workingDir: launchWorkingDir })
      return ''
    }
  )

  await service.launchLocalApp('localapp:ABCDEF12')
  assert.deepEqual(launches, [{
    fullPath: await fs.realpath(process.execPath),
    args: ['--profile', 'portable data', '--flag=one'],
    workingDir: await fs.realpath(workingDir)
  }])
  const localDocument = JSON.parse(await fs.readFile(path.join(root, 'local_apps.json'), 'utf8').then(
    (source) => source.replace(/^\uFEFF/, '')
  )) as { apps: Array<{ useCount: number; lastUsedAt: string }> }
  assert.equal(localDocument.apps[0]?.useCount, 1)
  assert.notEqual(localDocument.apps[0]?.lastUsedAt, '')

  await fs.writeFile(path.join(root, 'local_apps.json'), JSON.stringify({
    apps: [{
      id: 'localapp:ABCDEF12',
      name: 'Argument app',
      exePath: process.execPath,
      arguments: '--bad\u0000value',
      workingDir,
      panelEnabled: true,
      useCount: 1,
      lastUsedAt: localDocument.apps[0]?.lastUsedAt ?? ''
    }]
  }), 'utf8')
  await assert.rejects(
    service.launchLocalApp('localapp:ABCDEF12'),
    /本地软件参数无效/
  )
  assert.equal(launches.length, 1)
})

test('uses a native data URL for local app icons without exposing file paths', windowsOnly, async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-icon-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'local_apps.json'), JSON.stringify({
    apps: [{
      id: 'localapp:1234ABCD',
      name: 'Icon app',
      exePath: process.execPath,
      iconPath: process.execPath,
      arguments: '',
      panelEnabled: true,
      useCount: 0,
      lastUsedAt: ''
    }]
  }), 'utf8')
  const iconPaths: string[] = []
  const service = new SuperPanelDataService(
    root,
    {
      get: async () => JSON.stringify({ defaultTab: 'all', pinnedLocalApps: [] }),
      set: async () => undefined
    },
    async () => ({ success: true, data: [] }),
    async () => '',
    undefined,
    undefined,
    async (fullPath) => {
      iconPaths.push(fullPath)
      return 'data:image/png;base64,AA=='
    }
  )

  const data = await service.getData()
  assert.equal(data.items.find((item) => item.id === 'localapp:1234ABCD')?.iconUrl, 'data:image/png;base64,AA==')
  assert.deepEqual(iconPaths, [await fs.realpath(process.execPath)])
})

test('adds validated legacy system tools with searchable category aliases', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-system-tools-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const service = new SuperPanelDataService(
    root,
    {
      get: async () => JSON.stringify({ defaultTab: 'system_tools', pinnedLocalApps: [] }),
      set: async () => undefined
    },
    async () => ({ success: true, data: [] }),
    async () => '',
    undefined,
    undefined,
    undefined,
    {
      listTargets: async () => ({
        success: true,
        os: { major: 10, minor: 0, build: 22631, isWindows11: true },
        targets: [
          {
            id: 'this_pc',
            name: '此电脑',
            category: 'core',
            description: '打开此电脑',
            iconSource: 'shell:MyComputerFolder'
          },
          {
            id: 'settings',
            name: 'Windows 设置',
            category: 'settings',
            description: '打开 Windows 设置主页',
            iconSource: 'ms-settings:'
          },
          {
            id: 'bad/id',
            name: '不应显示',
            category: 'core',
            description: '',
            iconSource: ''
          }
        ]
      }),
      openTarget: async () => ({
        success: true,
        target: 'this_pc',
        launcher: 'primary',
        osBuild: 22631
      }),
      getIcon: async (targetId) => targetId === 'this_pc'
        ? 'data:image/png;base64,AA=='
        : ''
    }
  )

  const data = await service.getData()
  assert.deepEqual(
    data.items.map((item) => item.id),
    ['system-tool:this_pc', 'system-tool:settings']
  )
  assert.equal(data.items[0]?.type, 'system_tool')
  assert.equal(data.items[0]?.target, 'this_pc')
  assert.equal(data.items[0]?.iconUrl, 'data:image/png;base64,AA==')
  assert.deepEqual(data.items[0]?.keywords, ['系统工具', '常用 核心', '我的电脑 计算机'])
  assert.deepEqual(data.items[1]?.keywords, ['系统工具', '设置 系统设置', '电脑设置 Windows设置 设置中心'])
})
