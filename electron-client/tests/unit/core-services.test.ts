import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { ConfigService } from '../../src/main/services/config-service.js'
import { createCoreServices, readWebVersion } from '../../src/main/services/core-services.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'
import type { MainEdition } from '../../src/main/edition-types.js'
import type { UpdateCheckRequest } from '../../src/main/services/update-service.js'

function runtimeRoot(name: string): string {
  return path.resolve('out-test', 'runtime-data', `${process.pid}-${Date.now()}-${name}`)
}

function createStore(root: string): JsonFileStore {
  return new JsonFileStore(root, ConfigService.allowedStoreFiles)
}

test('renderer version is read from the built web root with a stable fallback', async () => {
  const root = runtimeRoot('web-version')
  await fs.mkdir(root, { recursive: true })
  try {
    await fs.writeFile(path.join(root, 'version.json'), '{"version":"1.1.7.1"}', 'utf8')
    assert.equal(await readWebVersion(root), '1.1.7.1')
    await fs.writeFile(path.join(root, 'version.json'), '{"version":"invalid"}', 'utf8')
    assert.equal(await readWebVersion(root), '0')
    await fs.rm(path.join(root, 'version.json'))
    assert.equal(await readWebVersion(root), '0')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config service preserves Delphi grouped JSON and serializes concurrent writes', async () => {
  const root = runtimeRoot('config')
  const config = new ConfigService(createStore(root))
  await config.set('user_settings.json', 'super_panel', '{"enabled":true}', false)
  await Promise.all(
    Array.from({ length: 12 }, (_value, index) =>
      config.set('user_settings.json', `batch.item_${index}`, String(index), true)
    )
  )
  assert.deepEqual(JSON.parse(await config.get('user_settings.json', 'super_panel', '')), {
    enabled: true
  })
  assert.equal(await config.get('user_settings.json', 'batch.item_11', ''), '11')
  const persistedSource = await fs.readFile(path.join(root, 'user_settings.json'), 'utf8')
  assert.equal(persistedSource.startsWith('\uFEFF'), true)
  const persisted = JSON.parse(persistedSource.slice(1))
  assert.equal(persisted._sync.batch, true)
  assert.equal(Object.keys(persisted.batch).length, 12)
})

test('independent JsonFileStore instances serialize writes to the same legacy file', async () => {
  const root = runtimeRoot('shared-store-queue')
  const first = createStore(root)
  const second = createStore(root)
  try {
    await Promise.all(
      Array.from({ length: 16 }, (_value, index) => {
        const store = index % 2 === 0 ? first : second
        return store.update('user_settings.json', (document) => {
          const batch = typeof document.batch === 'object' && document.batch !== null && !Array.isArray(document.batch)
            ? document.batch as Record<string, unknown>
            : {}
          batch[`item_${index}`] = index
          document.batch = batch
        })
      })
    )
    const persisted = JSON.parse((await fs.readFile(path.join(root, 'user_settings.json'), 'utf8')).slice(1)) as Record<string, unknown>
    assert.equal(Object.keys(persisted.batch as Record<string, unknown>).length, 16)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('config service allows page-local settings, maps ungrouped settings, and rejects private files', async () => {
  const config = new ConfigService(createStore(runtimeRoot('settings')))
  assert.equal(await config.setSetting('closeConfirm', false), 'false')
  assert.equal(await config.getSetting('closeConfirm'), 'false')

  await config.set('my_page_settings.json', 'my-page.pinned', '["plugin-1"]', false)
  await config.set('my_page_settings.json', 'my-page.recent-order', '["plugin-2","plugin-1"]', false)
  assert.deepEqual(
    JSON.parse(await config.get('my_page_settings.json', 'my-page.pinned', '[]')),
    ['plugin-1']
  )
  assert.deepEqual(
    JSON.parse(await config.get('my_page_settings.json', 'my-page.recent-order', '[]')),
    ['plugin-2', 'plugin-1']
  )

  // 宿主私有文件不对渲染层的 config_get 开放
  await assert.rejects(
    config.get('app_config.json', 'cef.windowWidth', ''),
    (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
  )
})

test('corrupt JSON is reported and never replaced with an empty document', async () => {
  const root = runtimeRoot('corrupt')
  await fs.mkdir(root, { recursive: true })
  const file = path.join(root, 'user_settings.json')
  await fs.writeFile(file, '{broken', 'utf8')
  const config = new ConfigService(createStore(root))
  await assert.rejects(
    config.get('user_settings.json', 'ui.theme', 'light'),
    (error) => error instanceof ZToolsError && error.code === errorCodes.dataCorrupt
  )
  assert.equal(await fs.readFile(file, 'utf8'), '{broken')
})

test('config service accepts UTF-8 BOM written by Delphi TEncoding.UTF8', async () => {
  const root = runtimeRoot('bom')
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(
    path.join(root, 'user_settings.json'),
    '\uFEFF{"ui":{"theme":"dark"}}',
    'utf8'
  )
  const config = new ConfigService(createStore(root))
  assert.equal(await config.get('user_settings.json', 'ui.theme', 'light'), 'dark')
})

test('main window size uses the private app config without exposing that file to renderers', async () => {
  const root = runtimeRoot('main-window-size')
  const store = createStore(root)
  const config = new ConfigService(store)
  try {
    assert.equal(await config.getMainWindowSize(), undefined)
    await store.replace('app_config.json', { legacy: { keep: true }, cef: { windowHeight: 720 } })
    await config.setMainWindowSize(1280, 720)
    assert.deepEqual(await config.getMainWindowSize(), { width: 1280, height: 720 })
    const persisted = JSON.parse((await fs.readFile(path.join(root, 'app_config.json'), 'utf8')).slice(1)) as Record<string, unknown>
    assert.deepEqual(persisted.legacy, { keep: true })
    await assert.rejects(
      config.get('app_config.json', 'cef.windowWidth', ''),
      (error) => error instanceof ZToolsError && error.code === errorCodes.permissionDenied
    )
    assert.throws(
      () => config.setMainWindowSize(100, 100),
      (error) => error instanceof ZToolsError && error.code === errorCodes.invalidRequest
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('JsonFileStore caches reads via stat validation, isolates mutations, invalidates on external edits, and writes compact catalog_snapshot.json', async () => {
  const root = runtimeRoot('json-store-cache')
  const store = createStore(root)
  const config = new ConfigService(store)
  try {
    await store.replace('user_settings.json', { ui: { theme: 'dark' } })

    // 首次写完即已命中内存缓存：连续读取不应再次 fs.open
    let openCalls = 0
    const originalOpen = fs.open
    fs.open = (async (...args: Parameters<typeof fs.open>) => {
      openCalls += 1
      return originalOpen(...args)
    }) as typeof fs.open
    try {
      const first = await store.read('user_settings.json')
      ;(first.ui as Record<string, unknown>).theme = 'mutated-by-caller'
      const second = await store.read('user_settings.json')
      assert.equal((second.ui as Record<string, unknown>).theme, 'dark', '返回克隆必须隔离调用方修改')
      assert.equal(openCalls, 0, 'stat 命中缓存时不得重新打开文件')

      // 并发读取应全部直接命中缓存
      const concurrent = await Promise.all(
        Array.from({ length: 6 }, () => store.read('user_settings.json'))
      )
      assert.equal(concurrent.length, 6)
      assert.equal(openCalls, 0)
    } finally {
      fs.open = originalOpen
    }

    // 外部覆盖磁盘文件（改变大小/时间）后自动失效并重载最新内容
    const settingsPath = path.join(root, 'user_settings.json')
    await fs.writeFile(settingsPath, '\uFEFF{"ui":{"theme":"light","extra":"external"}}\n', 'utf8')
    const reloaded = await store.read('user_settings.json')
    assert.equal((reloaded.ui as Record<string, unknown>).theme, 'light')
    assert.equal((reloaded.ui as Record<string, unknown>).extra, 'external')

    // 文件被删除后清除缓存并返回空对象
    await fs.rm(settingsPath)
    assert.deepEqual(await store.read('user_settings.json'), {})

    // catalog_snapshot.json 允许通过 ConfigService 读写，并以紧凑 JSON 写入，而 user_settings.json 保持缩进格式
    await config.set('catalog_snapshot.json', 'market.items', '[{"id":"a"},{"id":"b"}]', false)
    assert.deepEqual(
      JSON.parse(await config.get('catalog_snapshot.json', 'market.items', '[]')),
      [{ id: 'a' }, { id: 'b' }]
    )
    const snapshotRaw = await fs.readFile(path.join(root, 'catalog_snapshot.json'), 'utf8')
    assert.equal(snapshotRaw.startsWith('\uFEFF'), true)
    assert.equal(snapshotRaw.includes('\n  '), false, 'catalog_snapshot.json 必须采用紧凑 JSON 格式')

    await config.set('user_settings.json', 'ui.theme', 'dark', true)
    const userRaw = await fs.readFile(path.join(root, 'user_settings.json'), 'utf8')
    assert.equal(userRaw.includes('\n  '), true, '普通配置文件应保持人类可读缩进格式')

    // setMainWindowSize 在尺寸未变化时应跳过磁盘重写
    await config.setMainWindowSize(1280, 720)
    let writeFileCalls = 0
    const originalWriteFile = fs.writeFile
    fs.writeFile = (async (...args: Parameters<typeof fs.writeFile>) => {
      writeFileCalls += 1
      return originalWriteFile(...args)
    }) as typeof fs.writeFile
    try {
      await config.setMainWindowSize(1280, 720)
      assert.equal(writeFileCalls, 0, '宽高未变化时 setMainWindowSize 不得重复写盘')
      await config.setMainWindowSize(1360, 768)
      assert.equal(writeFileCalls, 1, '宽高变化时应落盘一次')
    } finally {
      fs.writeFile = originalWriteFile
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('createCoreServices 将归一化原生架构透传给 UpdateService（覆盖 Windows WOW64 与 macOS Rosetta）', async () => {
  const scenarios = [
    {
      name: 'Windows WOW64',
      runtimeOptions: {
        platform: 'win32' as const,
        processArch: 'ia32',
        runningUnderARM64Translation: null,
        processorArchitecture: 'x86',
        processorArchitew6432: 'AMD64'
      },
      expectedPlatform: 'windows',
      expectedArch: 'x64'
    },
    {
      name: 'macOS Rosetta',
      runtimeOptions: {
        platform: 'darwin' as const,
        processArch: 'x64',
        runningUnderARM64Translation: true,
        processorArchitecture: undefined,
        processorArchitew6432: undefined
      },
      expectedPlatform: 'macos',
      expectedArch: 'arm64'
    }
  ]

  for (const scenario of scenarios) {
    const root = runtimeRoot(`core-update-arch-${scenario.expectedPlatform}`)
    const captured: UpdateCheckRequest[] = []
    const stubEdition: MainEdition = {
      id: 'oss',
      storeFiles: [],
      createServices: () => ({
        user: {
          getInfo: async () => ({ success: true, logged_in: false }),
          setToken: async () => false,
          logout: async () => {}
        },
        analytics: {
          report: () => {},
          reportHost: () => {},
          reportPluginOpened: () => {},
          reportLaunch: () => {},
          reportStartup: () => {},
          stop: () => {}
        },
        updateSource: {
          async fetchLatest(request) {
            captured.push(request)
            return { app: null, web: null }
          }
        },
        libraryMetadata: {
          resolve: async () => {
            throw new ZToolsError(errorCodes.notSupported, 'not supported in test')
          }
        }
      })
    }

    const core = createCoreServices(
      root,
      '1.2.3.4',
      '1.2.3.4',
      null,
      null,
      null,
      null,
      stubEdition,
      undefined,
      scenario.runtimeOptions
    )
    try {
      await core.update.check({ source: 'startup' })
      assert.equal(captured.length, 1, scenario.name)
      assert.equal(captured[0]!.platform, scenario.expectedPlatform, scenario.name)
      assert.equal(captured[0]!.arch, scenario.expectedArch, scenario.name)
    } finally {
      await core.stop()
      await fs.rm(root, { recursive: true, force: true })
    }
  }
})
