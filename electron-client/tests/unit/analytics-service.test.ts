import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { AnalyticsService } from '../../src/main/services/analytics-service.js'
import { ConfigService } from '../../src/main/services/config-service.js'
import { createCoreServices } from '../../src/main/services/core-services.js'
import { JsonFileStore } from '../../src/main/services/json-file-store.js'

function runtimeRoot(name: string): string {
  return path.resolve('out-test', 'runtime-data', `${process.pid}-${Date.now()}-${name}`)
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

test('analytics generates standard 36-char UUID and persists it across reloads', async () => {
  const root = runtimeRoot('analytics-uuid-persist')
  await fs.mkdir(root, { recursive: true })
  try {
    const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)
    const requests: Record<string, unknown>[] = []
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 200 })
    }) as typeof fetch

    // 第一次启动：无旧版注册表，无本地持久化配置
    const service1 = new AnalyticsService({
      appVersion: '1.1.7.1',
      webVersion: '1.0.0',
      store,
      fetchImpl,
      readRegistryMetadata: async () => ({ deviceCode: '', source: 'none' })
    })

    const deviceCode1 = await service1.getDeviceCode()
    assert.match(deviceCode1, UUID_REGEX, '生成的设备码必须为 36 位标准 UUID')

    // 触发上报并验证
    service1.report(
      { event: 'app_launch', plugin_id: 'test_plugin', web_version: '1.0.0' },
      { type: 'main', webContentsId: 1 }
    )

    // 等待异步上报
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.device_code, deviceCode1)
    assert.equal(requests[0]?.plugin_id, 'test_plugin')
    service1.stop()

    // 验证本地存储文件 app_config.json 中已成功持久化
    const savedConfig = await store.read('app_config.json')
    assert.equal(savedConfig.device_code, deviceCode1)

    // 第二次启动：重启服务，模拟新进程
    const service2 = new AnalyticsService({
      appVersion: '1.1.7.1',
      webVersion: '1.0.0',
      store,
      fetchImpl,
      readRegistryMetadata: async () => ({ deviceCode: 'SHOULD_NOT_BE_USED', source: 'registry' })
    })

    const deviceCode2 = await service2.getDeviceCode()
    assert.equal(deviceCode2, deviceCode1, '重启后必须复用本地持久化的 device_code，绝不重复生成')
    service2.stop()
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('analytics migrates legacy registry deviceCode to local storage on first run', async () => {
  const root = runtimeRoot('analytics-registry-migration')
  await fs.mkdir(root, { recursive: true })
  try {
    const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)
    const legacyGuid = 'legacy-registry-guid-998877'
    const legacySource = 'installer-source-promo'

    const service = new AnalyticsService({
      appVersion: '1.1.7.1',
      store,
      readRegistryMetadata: async () => ({ deviceCode: legacyGuid, source: legacySource })
    })

    const metadata = await service.getMetadata()
    assert.equal(metadata.deviceCode, legacyGuid, '必须兼容读取旧版注册表 GUID')
    assert.equal(metadata.source, legacySource, '必须兼容读取旧版注册表 source')

    // 验证迁移已写入本地存储
    const saved = await store.read('app_config.json')
    assert.equal(saved.device_code, legacyGuid, '注册表旧设备指纹已迁移并持久化到本地')
    assert.equal(saved.analytics_source, legacySource, '注册表来源已持久化到本地')
    service.stop()

    // 后续启动不再依赖注册表
    const serviceAfterMigration = new AnalyticsService({
      appVersion: '1.1.7.1',
      store,
      readRegistryMetadata: async () => {
        throw new Error('注册表查询失败或已被卸载')
      }
    })

    const migratedMetadata = await serviceAfterMigration.getMetadata()
    assert.equal(migratedMetadata.deviceCode, legacyGuid)
    assert.equal(migratedMetadata.source, legacySource)
    serviceAfterMigration.stop()
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('telemetry privacy switch: strictly prevents all network requests when disabled', async () => {
  let fetchCallCount = 0
  const fetchImpl = (async () => {
    fetchCallCount += 1
    return new Response(null, { status: 200 })
  }) as typeof fetch

  const service = new AnalyticsService({
    appVersion: '1.1.7.1',
    telemetryEnabled: false,
    fetchImpl,
    resolveMetadata: async () => ({ deviceCode: 'device-privacy-1', source: 'test' })
  })

  assert.equal(service.isTelemetryEnabled(), false)

  // 1. report 必须直接被静默丢弃
  service.report(
    { event: 'page_view', plugin_id: 'plugin-a', web_version: '1.0' },
    { type: 'main', webContentsId: 1 }
  )
  service.reportHost('app_launch', 'plugin-b', '1.0', { key: 'val' })

  // 2. reportPluginRecord 也必须直接被静默丢弃
  service.reportPluginRecord('active', 'plugin-a', 'token-123')
  service.reportPluginRecord('install', 'plugin-b', 'token-123')

  await new Promise((r) => setTimeout(r, 50))
  assert.equal(fetchCallCount, 0, '禁用 Telemetry 时，fetch 必须零调用')

  // 3. 动态恢复遥测开关
  service.setTelemetryEnabled(true)
  assert.equal(service.isTelemetryEnabled(), true)

  service.report(
    { event: 'page_view', plugin_id: 'plugin-a', web_version: '1.0' },
    { type: 'main', webContentsId: 1 }
  )

  await new Promise((r) => setTimeout(r, 50))
  assert.equal(fetchCallCount, 1, '启用 Telemetry 后，上报正常恢复')
  service.stop()
})

test('analytics supports user_id: included when authenticated, omitted when guest', async () => {
  const requests: Record<string, unknown>[] = []
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)))
    return new Response(null, { status: 200 })
  }) as typeof fetch

  let currentUserId: string | null = null

  const service = new AnalyticsService({
    appVersion: '1.1.7.1',
    fetchImpl,
    resolveMetadata: async () => ({ deviceCode: 'device-user-test', source: 'test' }),
    getUserId: async () => currentUserId
  })

  // 场景 A: 访客/未登录态上报（未显式传 user_id，getUserId 返回 null）
  service.report(
    { event: 'market_view', plugin_id: '', web_version: '1.0' },
    { type: 'main', webContentsId: 1 }
  )
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.user_id, undefined, '访客模式下 body 绝不包含 user_id')

  // 场景 B: 用户登录后，getUserId 动态解析到 user_id
  currentUserId = 'user_100293'
  service.report(
    { event: 'plugin_open', plugin_id: 'ocr', web_version: '1.0' },
    { type: 'main', webContentsId: 1 }
  )
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(requests.length, 2)
  assert.equal(requests[1]?.user_id, 'user_100293', '登录态下上报自动携带动态 user_id')

  // 场景 C: 参数显式覆盖 user_id
  service.report(
    { event: 'custom_event', plugin_id: 'tool', web_version: '1.0', user_id: 'explicit_override_456' },
    { type: 'main', webContentsId: 1 }
  )
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(requests.length, 3)
  assert.equal(requests[2]?.user_id, 'explicit_override_456', '显式传入 user_id 时优先采用')

  service.stop()
})

test('fault injection & resilience: network errors, timeouts, and 5xx are handled silently without crashing', async () => {
  // 注入各种破坏性网络故障
  const failingScenarios: Array<{ name: string; impl: typeof fetch }> = [
    {
      name: 'Network TypeError (DNS resolution failure / offline)',
      impl: (async () => {
        throw new TypeError('fetch failed: getaddrinfo ENOTFOUND api.ztools.cn')
      }) as typeof fetch
    },
    {
      name: 'Network AbortError / Timeout',
      impl: (async () => {
        const err = new Error('The operation was aborted due to timeout')
        err.name = 'AbortError'
        throw err
      }) as typeof fetch
    },
    {
      name: 'HTTP 500 Internal Server Error',
      impl: (async () => new Response(JSON.stringify({ error: 'DB down' }), { status: 500 })) as typeof fetch
    },
    {
      name: 'HTTP 503 Service Unavailable',
      impl: (async () => new Response('Gateway timeout', { status: 503 })) as typeof fetch
    }
  ]

  for (const scenario of failingScenarios) {
    const service = new AnalyticsService({
      appVersion: '1.1.7.1',
      fetchImpl: scenario.impl,
      resolveMetadata: async () => ({ deviceCode: 'resilience-device', source: 'chaos' })
    })

    // report 和 reportPluginRecord 严禁向调用方抛出任何未捕获异常
    assert.doesNotThrow(() => {
      service.report(
        { event: 'chaos_test', plugin_id: 'p1', web_version: '1.0' },
        { type: 'main', webContentsId: 1 }
      )
    }, `在 ${scenario.name} 场景下 report 绝不能抛出异常`)

    assert.doesNotThrow(() => {
      service.reportPluginRecord('active', 'p1', 'token')
    }, `在 ${scenario.name} 场景下 reportPluginRecord 绝不能抛出异常`)

    await new Promise((r) => setTimeout(r, 50))
    service.stop()
  }
})

test('end-to-end integration with CoreServices: user login state reflects in analytics payloads', async () => {
  const root = runtimeRoot('analytics-coreservices-e2e')
  await fs.mkdir(root, { recursive: true })
  try {
    const requests: Record<string, unknown>[] = []
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const core = createCoreServices(root, '1.1.7.1', '1.0.0')

    const waitForRequests = async (expected: number) => {
      for (let i = 0; i < 50; i++) {
        if (requests.length >= expected) return
        await new Promise((r) => setTimeout(r, 20))
      }
    }

    // 重新配置 analytics 的 fetchImpl，指向测试收集器
    const customAnalytics = new AnalyticsService({
      appVersion: core.appVersion,
      webVersion: core.webVersion,
      store: (core as any).config['store'],
      dataRoot: core.dataRoot,
      fetchImpl,
      readRegistryMetadata: async () => ({ deviceCode: 'e2e-device-1', source: 'e2e' }),
      getUserId: async () => {
        const info = await core.user.getInfo().catch(() => null)
        if (info && info.logged_in && info.user && typeof (info.user as Record<string, unknown>).user_id === 'string') {
          return (info.user as Record<string, unknown>).user_id as string
        }
        return null
      }
    })

    await customAnalytics.getMetadata()

    // 1. 初始未登录状态上报
    customAnalytics.report(
      { event: 'launch', plugin_id: '', web_version: '1.0.0' },
      { type: 'main', webContentsId: 1 }
    )
    await waitForRequests(1)
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.user_id, undefined, '未登录时不携带 user_id')

    // 2. 模拟用户登录
    await core.user.setToken({
      token: 'jwt-token-abc',
      refresh_token: 'refresh-xyz',
      user_id: 'usr_enterprise_8899',
      username: 'geek_coder'
    })

    // 3. 登录后上报
    customAnalytics.report(
      { event: 'plugin_open', plugin_id: 'dev_tools', web_version: '1.0.0' },
      { type: 'main', webContentsId: 1 }
    )
    await waitForRequests(2)
    assert.equal(requests.length, 2)
    assert.equal(requests[1]?.user_id, 'usr_enterprise_8899', '用户登录后端到端联动自动上报 user_id')

    // 4. 用户登出
    await core.user.logout()
    customAnalytics.report(
      { event: 'logout_done', plugin_id: '', web_version: '1.0.0' },
      { type: 'main', webContentsId: 1 }
    )
    await waitForRequests(3)
    assert.equal(requests.length, 3)
    assert.equal(requests[2]?.user_id, undefined, '登出后恢复访客模式，不携带 user_id')

    customAnalytics.stop()
    await core.stop()
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('concurrency & race condition: 50 concurrent getDeviceCode calls resolve to identical UUID without race conditions', async () => {
  const root = runtimeRoot('analytics-concurrency')
  await fs.mkdir(root, { recursive: true })
  try {
    const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)

    const service = new AnalyticsService({
      appVersion: '1.1.7.1',
      store,
      readRegistryMetadata: async () => {
        // 模拟轻微延迟以诱发竞态
        await new Promise((r) => setTimeout(r, 10))
        return { deviceCode: '', source: 'none' }
      }
    })

    // 并发触发 50 个获取设备码的请求
    const results = await Promise.all(
      Array.from({ length: 50 }, () => service.getDeviceCode())
    )

    const firstCode = results[0]
    assert.ok(firstCode, '首个设备码必须存在')
    assert.match(firstCode, UUID_REGEX, '设备码必须为合法 UUID')

    // 验证所有并发调用返回的设备码 100% 相同，绝不重复生成产生裂变
    for (let i = 1; i < results.length; i++) {
      assert.equal(results[i], firstCode, `并发调用 ${i} 必须获得完全一致的设备码`)
    }

    service.stop()
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})

test('self-healing: invalid or whitespace-only stored device_code automatically heals with new UUID', async () => {
  const root = runtimeRoot('analytics-healing')
  await fs.mkdir(root, { recursive: true })
  try {
    const store = new JsonFileStore(root, ConfigService.allowedStoreFiles)
    // 写入异常的空或纯空格 device_code
    await store.replace('app_config.json', { device_code: '   ', analytics_source: '' })

    const service = new AnalyticsService({
      appVersion: '1.1.7.1',
      store,
      readRegistryMetadata: async () => ({ deviceCode: '', source: 'none' })
    })

    const healedCode = await service.getDeviceCode()
    assert.match(healedCode, UUID_REGEX, '脏数据必须被自动纠正为合规 36 位标准 UUID')
    assert.notEqual(healedCode.trim(), '', '生成的 UUID 不能为空')

    // 验证本地存储已被覆盖自愈
    const saved = await store.read('app_config.json')
    assert.equal(saved.device_code, healedCode, '本地存储必须已被纠正后的 UUID 覆盖持久化')

    service.stop()
  } finally {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  }
})
