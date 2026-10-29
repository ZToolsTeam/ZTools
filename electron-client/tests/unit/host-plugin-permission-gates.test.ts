import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { isBuiltinPluginFallbackAllowed, isProcessMonitorFallbackAllowed } from '../../src/main/ipc/router.js'
import { BuiltinPluginHostService, normalizePluginName } from '../../src/main/services/builtin-plugin-host-service.js'

const srcRoot = path.resolve(__dirname, '../../../src')
const readSource = (file: string) => fs.readFileSync(path.join(srcRoot, file), 'utf8')

const host: CallerIdentity = { type: 'main', webContentsId: 1 }
const declarative = (pluginId: string): CallerIdentity => ({
  type: 'main',
  webContentsId: 1,
  attributedPlugin: { pluginId, sessionId: `s-${pluginId}`, permissions: new Set(), source: 'installed' }
})
const pluginWindow = (pluginId: string): CallerIdentity => ({ type: 'plugin', webContentsId: 7, pluginId, pluginInstanceId: 'i1' })

test('dllplugin_call 兜底：宿主与受信任内置插件可调用任意宿主处理器', () => {
  assert.equal(isBuiltinPluginFallbackAllowed(host, 'ShredderPlugin', normalizePluginName), true)
  assert.equal(isBuiltinPluginFallbackAllowed(pluginWindow('internal-settings'), 'HostsSwitcherPlugin', normalizePluginName), true)
})

test('dllplugin_call 兜底：插件只能调用自己对应的处理器，别名与大小写按规范名比较', () => {
  assert.equal(isBuiltinPluginFallbackAllowed(declarative('hosts-switcher'), 'HostsSwitcherPlugin', normalizePluginName), true)
  assert.equal(isBuiltinPluginFallbackAllowed(declarative('hosts-switcher'), 'hostsswitcherplugin', normalizePluginName), true)
  assert.equal(isBuiltinPluginFallbackAllowed(pluginWindow('shredder'), 'ShredderPlugin', normalizePluginName), true)
  assert.equal(isBuiltinPluginFallbackAllowed(pluginWindow('system-tools'), 'SystemActionsPlugin', normalizePluginName), true)
})

test('SQLite 查看器仅允许自身会话，失效会话与其他插件不能借同名公共 DLL 越权', () => {
  for (const caller of [declarative('sqlite-plugin'), pluginWindow('sqlite-plugin')]) {
    assert.equal(isBuiltinPluginFallbackAllowed(caller, 'SqlitePlugin', normalizePluginName), true)
  }
  for (const caller of [declarative('caffeine'), pluginWindow('community-tool'), { type: 'main' as const, webContentsId: 1, stalePluginSession: true as const }]) {
    assert.equal(isBuiltinPluginFallbackAllowed(caller, 'SqlitePlugin', normalizePluginName), false)
  }
})

test('[越权] dllplugin_call 兜底：跨插件调用、未登记插件、失效会话与未归属插件窗口一律拒绝', () => {
  // 防休眠插件不能借兜底粉碎文件、改 hosts 或解锁结束进程
  for (const target of ['ShredderPlugin', 'HostsSwitcherPlugin', 'FileUnlockPlugin']) {
    assert.equal(isBuiltinPluginFallbackAllowed(declarative('caffeine'), target, normalizePluginName), false, target)
    assert.equal(isBuiltinPluginFallbackAllowed(pluginWindow('mover'), target, normalizePluginName), false, target)
  }
  // 不在宿主内置名单里的社区插件
  assert.equal(isBuiltinPluginFallbackAllowed(declarative('community-tool'), 'ShredderPlugin', normalizePluginName), false)
  // 带了失效会话令牌的主窗口调用：来自插件代码，不能当作宿主自身
  const stale: CallerIdentity = { type: 'main', webContentsId: 1, stalePluginSession: true }
  assert.equal(isBuiltinPluginFallbackAllowed(stale, 'ShredderPlugin', normalizePluginName), false)
  // 伪造 internal 前缀但未登记
  assert.equal(isBuiltinPluginFallbackAllowed(pluginWindow('internal-evil'), 'ShredderPlugin', normalizePluginName), false)
  // 目标不是宿主内置处理器
  assert.equal(isBuiltinPluginFallbackAllowed(declarative('hosts-switcher'), 'UnknownPlugin', normalizePluginName), false)
})

test('dllplugin_call 进程监控兜底：只放行宿主、受信任插件与使用进程监控能力的插件', () => {
  assert.equal(isProcessMonitorFallbackAllowed(host), true)
  assert.equal(isProcessMonitorFallbackAllowed(pluginWindow('internal-settings')), true)
  for (const id of ['process-monitor', 'kill-process', 'boost', 'flow-guard']) {
    assert.equal(isProcessMonitorFallbackAllowed(declarative(id)), true, id)
    assert.equal(isProcessMonitorFallbackAllowed(pluginWindow(id)), true, id)
  }
})

test('[越权] dllplugin_call 进程监控兜底：其他声明式插件、失效会话不能借兜底结束进程', () => {
  for (const id of ['caffeine', 'community-tool', 'hosts-switcher']) {
    assert.equal(isProcessMonitorFallbackAllowed(declarative(id)), false, id)
    assert.equal(isProcessMonitorFallbackAllowed(pluginWindow(id)), false, id)
  }
  assert.equal(isProcessMonitorFallbackAllowed({ type: 'main', webContentsId: 1, stalePluginSession: true }), false)
})

test('需要归属的系统能力在路由入口检查插件清单权限', () => {
  const router = readSource('main/ipc/router.ts')
  const expected: Record<string, string[]> = {
    environment_manager: ['system', 'fs'],
    hosts_manager: ['system', 'fs'],
    docker_manager: ['shell'],
    wifi_get_password: ['system'],
    wifi_get_profiles: ['system'],
    audio_set_default_device: ['audio'],
    audio_set_volume: ['audio'],
    audio_toggle_mute: ['audio'],
    dns_benchmark: ['network', 'system'],
    keyboard_lock: ['system'],
    hotkey_probe: ['system'],
    browser_bookmarks_scan: ['fs'],
    browser_bookmarks_cancel: ['fs']
  }
  for (const [method, permissions] of Object.entries(expected)) {
    const start = router.indexOf(`      async ${method}(`)
    assert.ok(start >= 0, `${method} 处理函数不存在`)
    const next = router.indexOf('\n      async ', start + 1)
    const body = router.slice(start, next < 0 ? undefined : next)
    for (const permission of permissions) {
      assert.ok(body.includes(`requirePluginPermission(caller, '${permission}', plugins)`), `${method} 缺少 ${permission} 权限检查`)
    }
  }
})

test('宿主处理器不再接受调用方指定的 hosts 路径、进程名与开机启动命令', () => {
  const network = readSource('main/services/host-plugins/network-host.ts')
  assert.equal(network.includes('params.customHostsPath'), false)
  const registry = readSource('main/services/host-plugins/system-registry-host.ts')
  assert.equal(registry.includes('params.liveProcessName'), false)
  assert.equal(registry.includes("String(params.command ?? params.path ?? '')"), false)
  assert.equal(registry.includes('let resolvedCmd = commandVal'), false)
})

test('[Windows] hosts 读取忽略调用方路径，只读取系统 hosts', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ztools-hosts-gate-'))
  const fake = path.join(dir, 'hosts')
  fs.writeFileSync(fake, '# ZTOOLS-FAKE-HOSTS-MARKER\n')
  try {
    const service = new BuiltinPluginHostService({ platform: 'win32' })
    const result = await service.handlePluginCall('HostsSwitcherPlugin', 'read', { customHostsPath: fake }) as Record<string, unknown>
    assert.notEqual(String(result.hostsPath).toLowerCase(), fake.toLowerCase())
    assert.equal(String(result.content ?? '').includes('ZTOOLS-FAKE-HOSTS-MARKER'), false)
    await service.stop()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
