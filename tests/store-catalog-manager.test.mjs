import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  StoreCatalogManager,
  normalizePluginId,
  matchPlugin
} from '../frontend/src/utils/storeCatalogManager.js'

describe('StoreCatalogManager 本地优先商店数据层 (Beyond Happy Path & Chaos Testing)', () => {
  const sampleOfficialList = [
    {
      pluginId: 'calculator',
      name: '计算器',
      title: '极速数学与时区计算',
      description: '自然语言换算与公式计算',
      category: '系统工具',
      keywords: ['calc', 'math', '计算'],
      version: '1.0.0'
    },
    {
      pluginId: 'clipboard-history',
      name: '剪贴板历史',
      title: '剪贴板增强管理器',
      description: '支持搜索历史剪贴板内容与失焦回贴',
      category: '办公效率',
      keywords: ['copy', 'paste', 'clipboard'],
      version: '1.0.0'
    }
  ]

  describe('1. 基础检索与规范化', () => {
    it('normalizePluginId 应该容忍各种输入形式', () => {
      assert.equal(normalizePluginId('app-id'), 'app-id')
      assert.equal(normalizePluginId({ pluginId: 'app-1' }), 'app-1')
      assert.equal(normalizePluginId({ id: 'app-2' }), 'app-2')
      assert.equal(normalizePluginId(null), '')
      assert.equal(normalizePluginId(undefined), '')
      assert.equal(normalizePluginId(123), '123')
    })

    it('matchPlugin 应该支持多字段模糊匹配与中文匹配', () => {
      const p = {
        pluginId: 'my-json-formatter',
        name: 'JSON 格式化工具',
        title: 'Developer JSON Parser',
        description: '一键美化与压缩 JSON 数据',
        author: 'GeekDev',
        keywords: ['devtools', 'format']
      }
      assert.equal(matchPlugin(p, 'json'), true)
      assert.equal(matchPlugin(p, '格式化'), true)
      assert.equal(matchPlugin(p, 'GeekDev'), true)
      assert.equal(matchPlugin(p, 'devtools'), true)
      assert.equal(matchPlugin(p, 'non-existent'), false)
      assert.equal(matchPlugin(p, ''), true)
      assert.equal(matchPlugin(p, '   '), true)
    })
  })

  describe('2. 正常链路与缓存管理 (Happy Path)', () => {
    it('首次从远程拉取 -> 写入本地快照 -> 内存缓存命中', async () => {
      let remoteFetchCount = 0
      let savedSnapshot = null

      const remotePlugins = [
        {
          id: 'custom-tool',
          name: '自定义脚本',
          category: '系统工具',
          downloads: 1500,
          version: '1.1.0'
        }
      ]

      const manager = new StoreCatalogManager({
        fetchRemote: async () => {
          remoteFetchCount++
          return { list: remotePlugins }
        },
        saveLocalSnapshot: async (data) => {
          savedSnapshot = data
        },
        getOfficialList: () => sampleOfficialList,
        ttlMs: 5000
      })

      // 首次加载：触发远程
      const r1 = await manager.ensureCatalog()
      assert.equal(r1.source, 'remote')
      assert.equal(remoteFetchCount, 1)
      assert.ok(savedSnapshot !== null, '成功拉取后应触发本地快照保存')

      // 再次加载未过期：命中内存
      const r2 = await manager.ensureCatalog()
      assert.equal(r2.source, 'memory')
      assert.equal(remoteFetchCount, 1, '未过期时不应再次请求远程')

      // 本地极速查询 (SLA < 10ms)
      const t0 = performance.now()
      const queryResult = await manager.query({ keyword: '计算器', pageSize: 10 })
      const elapsed = performance.now() - t0
      assert.ok(elapsed < 10, `查询耗时 ${elapsed.toFixed(3)}ms 需严格低于 10ms`)
      assert.equal(queryResult.list.length, 1)
      assert.equal(queryResult.list[0].pluginId, 'calculator')
    })
  })

  describe('3. 故障注入与容灾降级 (Fault Injection & Chaos Testing)', () => {
    it('远程 500/网络超时 -> 自动平滑降级至本地持久化快照', async () => {
      const persistedSnapshot = [
        {
          id: 'cached-app-1',
          name: '离线缓存应用',
          version: '2.0.0',
          category: '办公效率'
        }
      ]

      const manager = new StoreCatalogManager({
        fetchRemote: async () => {
          throw new Error('HTTP 502 Bad Gateway / Network Timeout')
        },
        getLocalSnapshot: async () => persistedSnapshot,
        getOfficialList: () => sampleOfficialList
      })

      const res = await manager.ensureCatalog()
      assert.equal(res.isFallback, true)
      assert.equal(res.source, 'local_snapshot')

      // 能够正常查出本地快照的内容
      const query = await manager.query({ keyword: '离线缓存' })
      assert.equal(query.total, 1)
      assert.equal(query.list[0].id, 'cached-app-1')
    })

    it('远程故障且无本地快照 -> 优雅兜底至内置官方标杆应用 (零崩溃保证)', async () => {
      const manager = new StoreCatalogManager({
        fetchRemote: async () => {
          throw new Error('ECONNREFUSED 127.0.0.1:3000')
        },
        getLocalSnapshot: async () => null,
        getOfficialList: () => sampleOfficialList
      })

      const res = await manager.ensureCatalog()
      assert.equal(res.isFallback, true)
      assert.equal(res.source, 'official_builtin')

      const query = await manager.query()
      assert.ok(query.total >= 2, '官方内置标杆应用应全量在线')
      assert.ok(query.list.some((p) => p.pluginId === 'calculator'))
    })

    it('远程返回空对象或畸形数据 -> 安全回退', async () => {
      const manager = new StoreCatalogManager({
        fetchRemote: async () => ({ unexpected: true }), // 畸形无 list 字段
        getLocalSnapshot: async () => null,
        getOfficialList: () => sampleOfficialList
      })

      const res = await manager.ensureCatalog()
      assert.equal(res.isFallback, true)
      assert.ok(res.catalog.length >= 2)
    })
  })

  describe('4. 安全下架熔断器 (Kill-Switch Real-time Revocation)', () => {
    it('拉取到 revoked: true 时，能正确建立下架字典并提供下架原因', async () => {
      const remoteData = [
        {
          id: 'vulnerable-ext',
          name: '存在漏洞的应用',
          version: '1.0.0',
          revoked: true,
          revoked_reason: 'CVE-2026-9999 原型链污染高危漏洞，已被官方封禁'
        },
        {
          id: 'normal-ext',
          name: '健康应用',
          version: '1.0.0',
          revoked: false
        }
      ]

      const manager = new StoreCatalogManager({
        fetchRemote: async () => ({ list: remoteData }),
        getOfficialList: () => []
      })

      await manager.ensureCatalog()
      const revocations = manager.getRevocations()

      assert.equal(revocations['vulnerable-ext']?.revoked, true)
      assert.ok(revocations['vulnerable-ext']?.reason.includes('CVE-2026-9999'))
      assert.equal(revocations['normal-ext'], undefined)
    })
  })

  describe('5. 并发防重与分页极值边界测试', () => {
    it('高频并发调用 ensureCatalog() 必须复用单一 in-flight Promise', async () => {
      let callCount = 0
      const manager = new StoreCatalogManager({
        fetchRemote: async () => {
          callCount++
          await new Promise((r) => setTimeout(r, 30))
          return { list: [{ id: 'app-concurrent', name: '并发测试' }] }
        },
        getOfficialList: () => []
      })

      // 同时并发发起 5 次请求
      const results = await Promise.all([
        manager.ensureCatalog(),
        manager.ensureCatalog(),
        manager.ensureCatalog(),
        manager.ensureCatalog(),
        manager.ensureCatalog()
      ])

      assert.equal(callCount, 1, '5 次并发应当合并为 1 次网络请求')
      for (const r of results) {
        assert.equal(r.catalog[0].id, 'app-concurrent')
      }
    })

    it('分页越界、负数页码与空筛选正常自愈', async () => {
      const manager = new StoreCatalogManager({
        fetchRemote: async () => ({ list: sampleOfficialList }),
        getOfficialList: () => []
      })

      // 请求第 999 页
      const p999 = await manager.query({ page: 999, pageSize: 10 })
      assert.equal(p999.list.length, 0)
      assert.equal(p999.total, 2)
      assert.equal(p999.page, 999)

      // 请求第 0 页或负数页（自动修正为 1）
      const p0 = await manager.query({ page: -1, pageSize: -10 })
      assert.equal(p0.page, 1)
      assert.equal(p0.pageSize, 20)
      assert.equal(p0.list.length, 2)
    })
  })
})
