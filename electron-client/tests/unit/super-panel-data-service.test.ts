import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { getLocaleSetting, setLocale } from '../../src/main/i18n/index.js'
import { SuperPanelDataService } from '../../src/main/super-panel/data-service.js'

test('persists plugin pins via togglePin and ignores residual local_apps.json on disk', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  // 即使磁盘残留历史 local_apps.json，getData 也不再读取或混入 items
  await fs.writeFile(path.join(root, 'local_apps.json'), JSON.stringify({
    apps: [{
      id: 'localapp:1234ABCD',
      name: 'Legacy Local App',
      exePath: process.execPath,
      arguments: '',
      panelEnabled: true,
      useCount: 5,
      lastUsedAt: '2026-01-01T00:00:00.000Z'
    }]
  }), 'utf8')

  let configuration = JSON.stringify({ defaultTab: 'all' })
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
    async () => ''
  )

  assert.equal(await service.togglePin('plugin.test', 'plugin'), true)
  const data = await service.getData()
  assert.deepEqual(Object.keys(data).sort(), ['items', 'pinnedEntries', 'success'])
  assert.equal(data.items.length, 1)
  assert.equal(data.items[0]?.id, 'plugin.test')
  assert.equal(data.items[0]?.type, 'plugin')
  assert.equal(data.items[0]?.pinned, true)
  assert.deepEqual(
    data.pinnedEntries.map((item) => item.entry),
    [{ kind: 'plugin', pluginId: 'plugin.test' }]
  )
})

test('orders plugin recents by last-used time', async (context) => {
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

  const service = new SuperPanelDataService(
    root,
    {
      get: async () => JSON.stringify({
        defaultTab: 'all',
        maxRecentCount: 5
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
})

test('最近使用插件固定最多 10 条，忽略旧配置中的 maxRecentCount', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-recent-limit-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const ids = Array.from({ length: 12 }, (_, index) => `plugin.recent${String(index).padStart(2, '0')}`)
  // 越靠后的插件最后使用时间越新
  await fs.writeFile(path.join(root, 'plugin_state.json'), JSON.stringify(Object.fromEntries(ids.map((id, index) => [
    id,
    { enabled: true, use_count: 1, last_used_at: `2024-01-${String(index + 1).padStart(2, '0')} 00:00:00` }
  ]))), 'utf8')
  const service = new SuperPanelDataService(
    root,
    {
      get: async () => JSON.stringify({ maxRecentCount: 3 }),
      set: async () => undefined
    },
    async () => ({ success: true, data: ids.map((id) => ({ id, name: id, enabled: true })) }),
    async () => ''
  )

  const plugins = (await service.getData()).items.filter((item) => item.type === 'plugin')
  assert.deepEqual(plugins.map((item) => item.id), [...ids].reverse().slice(0, 10))
})

test('adds validated legacy system tools with searchable category aliases', async (context) => {
  const previousLocale = getLocaleSetting()
  context.after(() => { setLocale(previousLocale) })
  setLocale('zh-CN')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-system-tools-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const service = new SuperPanelDataService(
    root,
    {
      get: async () => JSON.stringify({ defaultTab: 'system_tools' }),
      set: async () => undefined
    },
    async () => ({ success: true, data: [] }),
    async () => '',
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

test('v1 迁移幂等性：合并 plugin_state.pinned 与合法已有条目，安全忽略残留 pinnedLocalApps / local-app 且并发仅写一次', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-migrate-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'plugin_state.json'), JSON.stringify({
    'plugin.alpha': { enabled: true, pinned: true },
    'plugin.beta': { enabled: true, pinned: false }
  }), 'utf8')

  let configuration = JSON.stringify({
    pinnedLocalApps: ['localapp:11223344'],
    pinnedEntries: [
      { kind: 'builtin', commandKey: 'system:lock' },
      { kind: 'local-app', appId: 'localapp:11223344' }
    ]
  })
  const setCalls: Array<{ fileName: string; key: string; syncEnabled: boolean; value: string }> = []
  const service = new SuperPanelDataService(
    root,
    {
      get: async () => configuration,
      set: async (fileName, key, value, syncEnabled) => {
        setCalls.push({ fileName, key, value, syncEnabled })
        configuration = value
      }
    },
    async () => ({
      success: true,
      data: [
        { id: 'plugin.alpha', name: 'Alpha', enabled: true },
        { id: 'plugin.beta', name: 'Beta', enabled: true }
      ]
    }),
    async () => ''
  )

  const [first, second] = await Promise.all([service.getData(), service.getData()])
  assert.equal(setCalls.length, 1, '并发读取未迁移配置时，在锁内二次检查后应仅执行一次写回')
  assert.equal(setCalls[0]?.fileName, 'user_settings.json')
  assert.equal(setCalls[0]?.key, 'super_panel')
  assert.equal(setCalls[0]?.syncEnabled, false)

  const persisted = JSON.parse(configuration) as {
    pinnedSchemaVersion: number
    pinnedLocalApps?: unknown
    pinnedEntries: unknown[]
  }
  assert.equal(persisted.pinnedSchemaVersion, 2)
  assert.equal('pinnedLocalApps' in persisted, false)
  assert.deepEqual(persisted.pinnedEntries, [
    { kind: 'plugin', pluginId: 'plugin.alpha' },
    { kind: 'builtin', commandKey: 'system:lock' }
  ])
  assert.deepEqual(first.pinnedEntries, second.pinnedEntries)

  // 再次调用 getData 不再触发写回
  await service.getData()
  assert.equal(setCalls.length, 1)
})

test('pinnedSchemaVersion === 2 时忽略残留 kind: local-app 与 pinnedLocalApps，并保留其余全部 5 类合法固定项', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-v2-ignore-legacy-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const sampleFile = path.join(root, 'GreenApp.exe')
  await fs.writeFile(sampleFile, 'exe-bytes', 'utf8')
  const realSampleFile = await fs.realpath(sampleFile)

  await fs.writeFile(path.join(root, 'plugin_state.json'), JSON.stringify({
    'plugin.legacy': { enabled: true, pinned: true },
    'plugin.active': { enabled: true, pinned: false }
  }), 'utf8')

  let writes = 0
  const configuration = JSON.stringify({
    pinnedSchemaVersion: 2,
    pinnedLocalApps: ['localapp:CAFEBABE'],
    pinnedEntries: [
      { kind: 'plugin', pluginId: 'plugin.active' },
      { kind: 'local-app', appId: 'localapp:CAFEBABE' },
      { kind: 'plugin-feature', pluginId: 'plugin.active', featureCode: 'run' },
      { kind: 'builtin', commandKey: 'system:lock' },
      { kind: 'system-tool', toolId: 'this_pc' },
      { kind: 'file', path: realSampleFile, name: 'GreenApp.exe', isDir: false, isApplication: true }
    ]
  })
  const service = new SuperPanelDataService(
    root,
    {
      get: async () => configuration,
      set: async () => { writes += 1 }
    },
    async () => ({
      success: true,
      data: [
        { id: 'plugin.legacy', name: 'Legacy', enabled: true },
        { id: 'plugin.active', name: 'Active', enabled: true }
      ]
    }),
    async () => ''
  )

  const data = await service.getData()
  assert.equal(writes, 0)
  assert.equal(data.items.find((item) => item.id === 'plugin.legacy')?.pinned, false)
  assert.equal(data.items.find((item) => item.id === 'plugin.active')?.pinned, true)
  assert.deepEqual(
    data.pinnedEntries.map((item) => item.entry.kind),
    ['plugin', 'plugin-feature', 'builtin', 'system-tool', 'file']
  )
})

test('setPin 支持 5 类固定末尾追加、幂等、plugin_state.pinned 同步、非法 local-app 拒绝与 50 次并发写入一致', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-setpin-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const sampleFile = path.join(root, 'doc.txt')
  await fs.writeFile(sampleFile, 'hello', 'utf8')

  let configuration = JSON.stringify({ pinnedSchemaVersion: 2, pinnedEntries: [] })
  let changeEvents = 0
  const service = new SuperPanelDataService(
    root,
    {
      get: async () => configuration,
      set: async (_fileName, _key, value) => { configuration = value }
    },
    async () => ({ success: true, data: [{ id: 'plug.one', name: 'Plug One', enabled: true }] }),
    async () => '',
    {
      resolveAuthorizedReadPath: async (rawPath) => fs.realpath(rawPath),
      onChanged: () => { changeEvents += 1 }
    }
  )

  // 已下线的 local-app 与 togglePin(..., 'local') 明确抛错拒绝
  await assert.rejects(
    service.setPin({ kind: 'local-app', appId: 'localapp:AABBCCDD' }, true),
    /固定项格式无效/
  )
  await assert.rejects(
    service.togglePin('localapp:AABBCCDD', 'local'),
    /不支持的项目类型/
  )

  const entries = [
    { kind: 'plugin', pluginId: 'plug.one' },
    { kind: 'plugin-feature', pluginId: 'plug.one', featureCode: 'feat-a' },
    { kind: 'builtin', commandKey: 'system:lock' },
    { kind: 'system-tool', toolId: 'this_pc' },
    { kind: 'file', path: sampleFile, name: 'doc.txt', isDir: false, isApplication: false }
  ] as const

  for (const entry of entries) {
    const res = await service.setPin(entry, true)
    assert.equal(res.pinned, true)
  }
  assert.equal(changeEvents, 5)

  // 重复固定首项应幂等且不改变其位置（不移动到末尾）
  const idempotent = await service.setPin(entries[0], true)
  assert.equal(idempotent.pinnedEntries.length, 5)
  assert.equal(idempotent.pinnedEntries[0]?.pinKey, 'plugin:plug.one')
  assert.equal(changeEvents, 5)

  // 降级兼容字段同步检查：plugin_state.pinned
  const pluginStateDoc = JSON.parse(
    (await fs.readFile(path.join(root, 'plugin_state.json'), 'utf8')).replace(/^\uFEFF/, '')
  ) as Record<string, { pinned?: boolean }>
  assert.equal(pluginStateDoc['plug.one']?.pinned, true)

  // 取消固定 plugin 同步清理旧字段防降级复活
  await service.setPin(entries[0], false)
  const pluginStateAfter = JSON.parse(
    (await fs.readFile(path.join(root, 'plugin_state.json'), 'utf8')).replace(/^\uFEFF/, '')
  ) as Record<string, { pinned?: boolean }>
  assert.equal(pluginStateAfter['plug.one']?.pinned, false)

  // 50 次并发 setPin 全部落在同一串行锁下，不丢失任何一次更新
  const concurrentInputs = Array.from({ length: 50 }, (_, index) => ({
    kind: 'builtin' as const,
    commandKey: `concurrent.cmd.${index}`
  }))
  await Promise.all(concurrentInputs.map((item) => service.setPin(item, true)))
  const afterConcurrent = await service.getData()
  for (const item of concurrentInputs) {
    assert.ok(
      afterConcurrent.pinnedEntries.some((resolved) => resolved.pinKey === `builtin:${item.commandKey}`),
      `缺失并发写入的条目: ${item.commandKey}`
    )
  }
})

test('reorderPins 合法重排与并发变化 stale 集合不一致拒绝', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-reorder-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  let configuration = JSON.stringify({
    pinnedSchemaVersion: 2,
    pinnedEntries: [
      { kind: 'builtin', commandKey: 'cmd.a' },
      { kind: 'builtin', commandKey: 'cmd.b' },
      { kind: 'system-tool', toolId: 'this_pc' }
    ]
  })
  let changeEvents = 0
  let writes = 0
  const service = new SuperPanelDataService(
    root,
    {
      get: async () => configuration,
      set: async (_fileName, _key, value) => {
        writes += 1
        configuration = value
      }
    },
    async () => ({ success: true, data: [] }),
    async () => '',
    { onChanged: () => { changeEvents += 1 } }
  )

  const reordered = await service.reorderPins(['system-tool:this_pc', 'builtin:cmd.b', 'builtin:cmd.a'])
  assert.equal(reordered.success, true)
  assert.deepEqual(
    reordered.pinnedEntries.map((item) => item.pinKey),
    ['system-tool:this_pc', 'builtin:cmd.b', 'builtin:cmd.a']
  )
  assert.equal(writes, 1)
  assert.equal(changeEvents, 1)

  // 集合不一致（少项或存在未知 key）返回 stale: true 且不写盘
  const staleMissing = await service.reorderPins(['system-tool:this_pc', 'builtin:cmd.b'])
  assert.equal(staleMissing.success, false)
  if (!staleMissing.success) {
    assert.equal(staleMissing.stale, true)
    assert.match(staleMissing.error, /已变化/)
  }
  const staleExtra = await service.reorderPins(['system-tool:this_pc', 'builtin:cmd.b', 'builtin:cmd.c'])
  assert.equal(staleExtra.success, false)
  assert.equal(writes, 1)

  // 重复或非数组入参直接抛错
  await assert.rejects(service.reorderPins(['builtin:cmd.a', 'builtin:cmd.a']), /重复/)
  await assert.rejects(service.reorderPins('invalid'), /无效/)
})

test('file 类型存在性并发检查、绿色 .exe 应用图标 mtime 缓存与 openPinnedFile 处理', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-super-panel-files-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const appExe = path.join(root, 'MyApp.exe')
  const plainFile = path.join(root, 'notes.txt')
  const folder = path.join(root, 'workspace')
  const deletedFile = path.join(root, 'gone.txt')
  await fs.writeFile(appExe, 'exe-bytes', 'utf8')
  await fs.writeFile(plainFile, 'note', 'utf8')
  await fs.mkdir(folder)
  await fs.writeFile(deletedFile, 'gone', 'utf8')

  const realAppExe = await fs.realpath(appExe)
  const realPlainFile = await fs.realpath(plainFile)
  const realFolder = await fs.realpath(folder)
  const realDeletedFile = await fs.realpath(deletedFile)

  let configuration = JSON.stringify({
    pinnedSchemaVersion: 2,
    pinnedEntries: [
      { kind: 'file', path: realAppExe, name: 'MyApp.exe', isDir: false, isApplication: true },
      { kind: 'file', path: realPlainFile, name: 'notes.txt', isDir: false, isApplication: false },
      { kind: 'file', path: realFolder, name: 'workspace', isDir: true, isApplication: false },
      { kind: 'file', path: realDeletedFile, name: 'gone.txt', isDir: false, isApplication: true }
    ]
  })
  await fs.rm(realDeletedFile)

  const iconCalls: string[] = []
  const opened: string[] = []
  const revealed: string[] = []
  let iconSerial = 0
  const service = new SuperPanelDataService(
    root,
    {
      get: async () => configuration,
      set: async (_f, _k, value) => { configuration = value }
    },
    async () => ({ success: true, data: [] }),
    async (target) => { opened.push(target); return '' },
    {
      revealPath: (target) => { revealed.push(target) }
    },
    async (fullPath) => {
      iconCalls.push(fullPath)
      iconSerial += 1
      return `data:image/png;base64,${Buffer.from(String(iconSerial)).toString('base64')}`
    }
  )

  const first = await service.getData()
  assert.equal(first.pinnedEntries.length, 4)
  assert.equal(first.pinnedEntries[0]?.available, true)
  assert.match(first.pinnedEntries[0]?.iconUrl ?? '', /^data:image\/png;base64,/)
  assert.equal(first.pinnedEntries[1]?.available, true)
  assert.equal(first.pinnedEntries[1]?.iconUrl, undefined, '非应用文件不读取图标')
  assert.equal(first.pinnedEntries[2]?.available, true)
  assert.equal(first.pinnedEntries[3]?.available, false)
  assert.equal(first.pinnedEntries[3]?.iconUrl, undefined, '不可用应用不读取图标')
  assert.deepEqual(iconCalls, [realAppExe])

  // 第二次读取命中缓存
  const second = await service.getData()
  assert.equal(second.pinnedEntries[0]?.iconUrl, first.pinnedEntries[0]?.iconUrl)
  assert.deepEqual(iconCalls, [realAppExe])

  // 修改文件 mtime 后缓存失效并重新读取图标
  const nextMtime = new Date(Date.now() + 10_000)
  await fs.utimes(realAppExe, nextMtime, nextMtime)
  const third = await service.getData()
  assert.equal(iconCalls.length, 2)
  assert.notEqual(third.pinnedEntries[0]?.iconUrl, first.pinnedEntries[0]?.iconUrl)

  // openPinnedFile：正常打开绿色 .exe、普通文件及定位文件/目录
  const appPinKey = first.pinnedEntries[0]!.pinKey
  const plainPinKey = first.pinnedEntries[1]!.pinKey
  const folderPinKey = first.pinnedEntries[2]!.pinKey
  const deletedPinKey = first.pinnedEntries[3]!.pinKey

  await service.openPinnedFile(appPinKey, 'open')
  await service.openPinnedFile(plainPinKey, 'open')
  await service.openPinnedFile(plainPinKey, 'reveal')
  await service.openPinnedFile(folderPinKey, 'reveal')
  assert.deepEqual(opened, [realAppExe, realPlainFile, realFolder])
  assert.deepEqual(revealed, [realPlainFile])

  // 失效文件拒绝打开；未在白名单内的路径同样拒绝
  await assert.rejects(service.openPinnedFile(deletedPinKey, 'open'), /不存在或已失效/)
  await assert.rejects(service.openPinnedFile(`file:${path.join(root, 'unpinned.txt')}`, 'open'), /不存在或已失效/)
  await assert.rejects(service.openPinnedFile(appPinKey, 'unknown' as 'open'), /动作无效/)
})
