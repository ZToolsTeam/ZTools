import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CURRENT_PINNED_SCHEMA_VERSION,
  decodeSuperPanelConfig,
  parsePinnedEntry,
  parseSuperPanelConfig,
  resolvePinKey,
  type PinnedEntry
} from '../../src/main/super-panel/config.js'

test('历史配置残留 kind: local-app、pinnedLocalApps 与旧超级面板字段时安全忽略，并完整保留 5 类合法固定项', () => {
  const config = parseSuperPanelConfig({
    enabled: true,
    keyboardHotkey: { enabled: true, modifiers: ['ctrl', 'Alt'], key: 'X' },
    mouseHotkey: { enabled: true, button: 'forward_press', longPressMs: 275 },
    panelPosition: 'cursor',
    panelSize: 'large',
    shortcuts: [{ prefix: '/br', pluginId: 'batch-rename' }],
    pinnedLocalApps: [
      'localapp:1234ABCD',
      'localapp:mac:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF'
    ],
    pinnedEntries: [
      { kind: 'plugin', pluginId: 'json.format' },
      { kind: 'local-app', appId: 'localapp:1234ABCD' },
      { kind: 'plugin-feature', pluginId: 'json.format', featureCode: 'pretty' },
      { kind: 'local-app', appId: 'localapp:mac:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF' },
      { kind: 'builtin', commandKey: 'system:lock' },
      { kind: 'system-tool', toolId: 'this_pc' },
      { kind: 'file', path: 'C:\\Tools\\GreenApp.exe', name: 'GreenApp.exe', isDir: false, isApplication: true }
    ]
  }, 'win32')
  // 旧字段（热键、位置、尺寸、快捷前缀、pinnedLocalApps）与 local-app 条目均被安全忽略，其余 5 类合法固定项原样保留
  assert.deepEqual(config, {
    pinnedSchemaVersion: 0,
    pinnedEntries: [
      { kind: 'plugin', pluginId: 'json.format' },
      { kind: 'plugin-feature', pluginId: 'json.format', featureCode: 'pretty' },
      { kind: 'builtin', commandKey: 'system:lock' },
      { kind: 'system-tool', toolId: 'this_pc' },
      { kind: 'file', path: 'C:\\Tools\\GreenApp.exe', name: 'GreenApp.exe', isDir: false, isApplication: true }
    ]
  })
})

test('pinnedEntries 缺失、类型错误或配置损坏时安全回退', () => {
  const empty = { pinnedSchemaVersion: 0, pinnedEntries: [] }
  assert.deepEqual(parseSuperPanelConfig(undefined), empty)
  assert.deepEqual(parseSuperPanelConfig([]), empty)
  assert.deepEqual(parseSuperPanelConfig({ pinnedLocalApps: 'localapp:1234ABCD', pinnedEntries: 'bad' }), empty)
  assert.deepEqual(parseSuperPanelConfig({ pinnedSchemaVersion: -1 }), empty)
  assert.deepEqual(parseSuperPanelConfig({ pinnedSchemaVersion: '2' }), empty)
  assert.deepEqual(decodeSuperPanelConfig('{broken'), empty)
  assert.deepEqual(decodeSuperPanelConfig('{}'), empty)
  assert.deepEqual(
    decodeSuperPanelConfig(JSON.stringify({ pinnedLocalApps: ['localapp:abcd1234'] })),
    empty
  )
})

test('5 类 PinnedEntry 合法解析、剥离未知字段与 local-app / 畸形输入拒绝', () => {
  const validWin: Array<[Record<string, unknown>, PinnedEntry]> = [
    [{ kind: 'plugin', pluginId: 'json.format-1', extra: 'drop' }, { kind: 'plugin', pluginId: 'json.format-1' }],
    [
      { kind: 'plugin-feature', pluginId: 'json.format', featureCode: 'format-json:main' },
      { kind: 'plugin-feature', pluginId: 'json.format', featureCode: 'format-json:main' }
    ],
    [{ kind: 'builtin', commandKey: 'system:settings.open' }, { kind: 'builtin', commandKey: 'system:settings.open' }],
    [{ kind: 'system-tool', toolId: 'this_pc' }, { kind: 'system-tool', toolId: 'this_pc' }],
    [
      { kind: 'file', path: 'C:\\Apps\\Tool.exe', name: 'Tool.exe', isDir: false, isApplication: true, injected: 1 },
      { kind: 'file', path: 'C:\\Apps\\Tool.exe', name: 'Tool.exe', isDir: false, isApplication: true }
    ]
  ]
  for (const [input, expected] of validWin) {
    assert.deepEqual(parsePinnedEntry(input, 'win32'), expected)
  }

  assert.deepEqual(
    parsePinnedEntry({ kind: 'file', path: '/Applications/App.app', name: 'App', isDir: true, isApplication: true }, 'darwin'),
    { kind: 'file', path: '/Applications/App.app', name: 'App', isDir: true, isApplication: true }
  )

  const malformed: Array<{ entry: unknown; platform?: NodeJS.Platform }> = [
    { entry: null },
    { entry: [] },
    { entry: { kind: 'instant-calc', expr: '1+1' } },
    { entry: { kind: 'local-app', appId: 'localapp:AABBCCDD' } },
    { entry: { kind: 'local-app', appId: 'localapp:mac:0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF' } },
    { entry: { kind: 'plugin', pluginId: '' } },
    { entry: { kind: 'plugin', pluginId: '.hidden' } },
    { entry: { kind: 'plugin', pluginId: '../escape' } },
    { entry: { kind: 'plugin', pluginId: 'a'.repeat(129) } },
    { entry: { kind: 'plugin-feature', pluginId: 'ok', featureCode: '' } },
    { entry: { kind: 'plugin-feature', pluginId: 'ok', featureCode: 'bad\0code' } },
    { entry: { kind: 'plugin-feature', pluginId: 'ok', featureCode: 'f'.repeat(129) } },
    { entry: { kind: 'builtin', commandKey: '' } },
    { entry: { kind: 'builtin', commandKey: 'bad key' } },
    { entry: { kind: 'builtin', commandKey: ':lead' } },
    { entry: { kind: 'builtin', commandKey: 'k'.repeat(129) } },
    { entry: { kind: 'system-tool', toolId: 'system-tool:this_pc' } },
    { entry: { kind: 'system-tool', toolId: 't'.repeat(65) } },
    { entry: { kind: 'file', path: 'relative\\file.txt', name: 'file.txt', isDir: false, isApplication: false }, platform: 'win32' },
    { entry: { kind: 'file', path: 'C:\\bad.txt', name: 'bad.txt', isDir: false, isApplication: false }, platform: 'darwin' },
    { entry: { kind: 'file', path: '/tmp/bad\0.txt', name: 'bad.txt', isDir: false, isApplication: false }, platform: 'darwin' },
    { entry: { kind: 'file', path: `/${'a'.repeat(32768)}`, name: 'a', isDir: false, isApplication: false }, platform: 'darwin' },
    { entry: { kind: 'file', path: '/tmp/ok.txt', name: '', isDir: false, isApplication: false }, platform: 'darwin' },
    { entry: { kind: 'file', path: '/tmp/ok.txt', name: 'n\0', isDir: false, isApplication: false }, platform: 'darwin' },
    { entry: { kind: 'file', path: '/tmp/ok.txt', name: 'n'.repeat(513), isDir: false, isApplication: false }, platform: 'darwin' },
    { entry: { kind: 'file', path: '/tmp/ok.txt', name: 'ok.txt', isDir: 'true', isApplication: false }, platform: 'darwin' },
    { entry: { kind: 'file', path: '/tmp/ok.txt', name: 'ok.txt', isDir: false, isApplication: 0 }, platform: 'darwin' }
  ]
  for (const { entry, platform } of malformed) {
    assert.equal(parsePinnedEntry(entry, platform ?? 'win32'), null, JSON.stringify(entry))
  }
})

test('resolvePinKey 覆盖 5 类规则、Windows 盘符大小写归一与非根末尾斜杠规范化', () => {
  assert.equal(resolvePinKey({ kind: 'plugin', pluginId: 'JsonFormat' }), 'plugin:JsonFormat')
  assert.equal(
    resolvePinKey({ kind: 'plugin-feature', pluginId: 'JsonFormat', featureCode: 'pretty' }),
    'plugin-feature:JsonFormat:pretty'
  )
  assert.equal(resolvePinKey({ kind: 'builtin', commandKey: 'system:lock' }), 'builtin:system:lock')
  assert.equal(resolvePinKey({ kind: 'system-tool', toolId: 'this_pc' }), 'system-tool:this_pc')

  // Windows: 保留 C:\ 根斜杠，去除非根末尾 \ 与 /，全部转小写
  assert.equal(
    resolvePinKey({ kind: 'file', path: 'C:\\', name: 'C', isDir: true, isApplication: false }, 'win32'),
    'file:c:\\'
  )
  assert.equal(
    resolvePinKey({ kind: 'file', path: 'C:/', name: 'C', isDir: true, isApplication: false }, 'win32'),
    'file:c:\\'
  )
  assert.equal(
    resolvePinKey({ kind: 'file', path: 'D:\\Work\\Docs\\', name: 'Docs', isDir: true, isApplication: false }, 'win32'),
    'file:d:\\work\\docs'
  )
  assert.equal(
    resolvePinKey({ kind: 'file', path: 'd:/Work/Docs///', name: 'Docs', isDir: true, isApplication: false }, 'win32'),
    'file:d:\\work\\docs'
  )

  // 非 Windows: 保持大小写敏感，保留 / 根，去除非根末尾 /
  assert.equal(
    resolvePinKey({ kind: 'file', path: '/', name: '/', isDir: true, isApplication: false }, 'darwin'),
    'file:/'
  )
  assert.equal(
    resolvePinKey({ kind: 'file', path: '/Applications/CaseApp.app/', name: 'CaseApp', isDir: true, isApplication: true }, 'darwin'),
    'file:/Applications/CaseApp.app'
  )
  assert.notEqual(
    resolvePinKey({ kind: 'file', path: '/Applications/CaseApp.app', name: 'CaseApp', isDir: true, isApplication: true }, 'darwin'),
    resolvePinKey({ kind: 'file', path: '/Applications/caseapp.app', name: 'caseapp', isDir: true, isApplication: true }, 'darwin')
  )
})

test('pinnedEntries 按 pinKey 去重并最多解析 10000 条', () => {
  const entries = Array.from({ length: 10_050 }, (_, index) => ({
    kind: 'builtin',
    commandKey: `cmd.${index}`
  }))
  // 在最前面加入大小写/斜杠等价重复的 Windows 文件条目验证按 pinKey 去重
  const parsed = parseSuperPanelConfig({
    pinnedSchemaVersion: CURRENT_PINNED_SCHEMA_VERSION,
    pinnedEntries: [
      { kind: 'file', path: 'C:\\Temp\\Item\\', name: 'Item', isDir: true, isApplication: false },
      { kind: 'file', path: 'c:\\temp\\item', name: 'item', isDir: true, isApplication: false },
      ...entries
    ]
  }, 'win32')

  assert.equal(parsed.pinnedSchemaVersion, 2)
  assert.equal(parsed.pinnedEntries.length, 10_000)
  assert.deepEqual(parsed.pinnedEntries[0], {
    kind: 'file',
    path: 'C:\\Temp\\Item\\',
    name: 'Item',
    isDir: true,
    isApplication: false
  })
  assert.deepEqual(parsed.pinnedEntries[1], { kind: 'builtin', commandKey: 'cmd.0' })
})
