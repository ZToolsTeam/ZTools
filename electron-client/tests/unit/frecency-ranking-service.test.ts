import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  calculateFrecencyScore,
  calculateUsageWeight,
  FrecencyRankingService,
  FRECENCY_WEIGHTS,
  ONE_DAY_MS,
  ONE_HOUR_MS,
  ONE_MONTH_MS,
  ONE_WEEK_MS
} from '../../src/main/services/frecency-ranking-service.js'

test('calculateUsageWeight: 正确根据不同时间区间衰减权重分', () => {
  const now = 100_000_000

  // 1 小时内：权重 100
  assert.equal(calculateUsageWeight(now - 1000, now), FRECENCY_WEIGHTS.ONE_HOUR)
  assert.equal(calculateUsageWeight(now - ONE_HOUR_MS, now), FRECENCY_WEIGHTS.ONE_HOUR)

  // 24 小时内：权重 70
  assert.equal(calculateUsageWeight(now - ONE_HOUR_MS - 1, now), FRECENCY_WEIGHTS.ONE_DAY)
  assert.equal(calculateUsageWeight(now - ONE_DAY_MS, now), FRECENCY_WEIGHTS.ONE_DAY)

  // 7 天内：权重 30
  assert.equal(calculateUsageWeight(now - ONE_DAY_MS - 1, now), FRECENCY_WEIGHTS.ONE_WEEK)
  assert.equal(calculateUsageWeight(now - ONE_WEEK_MS, now), FRECENCY_WEIGHTS.ONE_WEEK)

  // 30 天内：权重 10
  assert.equal(calculateUsageWeight(now - ONE_WEEK_MS - 1, now), FRECENCY_WEIGHTS.ONE_MONTH)
  assert.equal(calculateUsageWeight(now - ONE_MONTH_MS, now), FRECENCY_WEIGHTS.ONE_MONTH)

  // 超过 30 天：权重 1
  assert.equal(calculateUsageWeight(now - ONE_MONTH_MS - 1000, now), FRECENCY_WEIGHTS.OLDER)
})

test('calculateUsageWeight: 时间戳回拨保护 (未来时间戳 clamp 为当前时间，不产生负权重或 NaN)', () => {
  const now = 100_000_000
  // 系统时钟被向后修改，导致出现未来时间戳
  const futureTs = now + 999_999
  const weight = calculateUsageWeight(futureTs, now)
  assert.equal(weight, FRECENCY_WEIGHTS.ONE_HOUR)
})

test('Frecency 正常业务流：高频使用命令快速跃升至首位，长期不使用平滑衰减下沉', () => {
  let currentTime = 1_000_000_000
  const service = new FrecencyRankingService({
    nowProvider: () => currentTime
  })

  // 模拟三个命令：cmd-a, cmd-b, cmd-c
  const items = [
    { id: 'cmd-a', name: '常用命令 A' },
    { id: 'cmd-b', name: '次常命令 B' },
    { id: 'cmd-c', name: '冷门命令 C' }
  ]

  // 初始时未记录调用，保持原次序
  let ranked = service.rankItems(items, (item) => item.id)
  assert.deepEqual(ranked.map((x) => x.id), ['cmd-a', 'cmd-b', 'cmd-c'])

  // cmd-c 在 20 天前被调用 1 次
  const twentyDaysAgo = currentTime - 20 * ONE_DAY_MS
  service.recordUsage('cmd-c', twentyDaysAgo)

  // cmd-b 在 2 小时前被调用 1 次
  const twoHoursAgo = currentTime - 2 * ONE_HOUR_MS
  service.recordUsage('cmd-b', twoHoursAgo)

  // cmd-a 在当前被高频调用 5 次
  for (let i = 0; i < 5; i++) {
    service.recordUsage('cmd-a', currentTime)
  }

  // 验证当前排序：cmd-a 跃升第一位 (5 * 100 = 500)，cmd-b 第二位 (70)，cmd-c 第三位 (10)
  ranked = service.rankItems(items, (item) => item.id)
  assert.deepEqual(ranked.map((x) => x.id), ['cmd-a', 'cmd-b', 'cmd-c'])
  assert.ok(service.getScore('cmd-a', currentTime) > service.getScore('cmd-b', currentTime))
  assert.ok(service.getScore('cmd-b', currentTime) > service.getScore('cmd-c', currentTime))

  // 时间推进 40 天：cmd-a 的所有调用全部衰减为超过 30 天的老调用
  currentTime += 40 * ONE_DAY_MS

  // 此时 cmd-c 被最新触发 1 次
  service.recordUsage('cmd-c', currentTime)

  // 验证 cmd-c 凭借新鲜度 (100 分) 立即反超沉寂已久的 cmd-a (5 分) 与 cmd-b (1 分)
  ranked = service.rankItems(items, (item) => item.id)
  assert.equal(ranked[0]?.id, 'cmd-c')
  assert.equal(ranked[1]?.id, 'cmd-a')
  assert.equal(ranked[2]?.id, 'cmd-b')
})

test('短别名（Aliases）特性：单字母别名精确命中强行置顶，优于模糊与高频项', () => {
  const now = 2_000_000_000
  const service = new FrecencyRankingService({ nowProvider: () => now })

  const items = [
    { id: 'translate', name: '在线多语言翻译', alias: 't' },
    { id: 'terminal', name: '终端命令行 Terminal', alias: 'term' },
    { id: 'text-editor', name: '高级文本编辑器 Text' }
  ]

  // 让 text-editor 拥有极高的历史调用分（1000次）
  for (let i = 0; i < 30; i++) {
    service.recordUsage('text-editor', now)
  }
  service.setAlias('translate', 't')

  // 用户输入单字母 "t"
  // 虽然 text-editor 和 terminal 包含或前缀匹配 "t"，且 text-editor Frecency 得分极高，
  // 但 translate 拥有精确匹配的单字母别名 "t"，必须具有绝对置顶优先级！
  const ranked = service.rankItems(
    items,
    {
      getId: (x) => x.id,
      getTitle: (x) => x.name,
      getAlias: (x) => x.alias
    },
    't'
  )

  assert.equal(ranked[0]?.id, 'translate', '单字母别名精确命中必须绝对置顶在第 1 位')
  assert.ok(ranked.length >= 2, '其他包含匹配项正常排在之后')
})

test('短别名特性：动态设置与不区分大小写匹配', () => {
  const service = new FrecencyRankingService()
  service.setAlias('calc', 'C')
  assert.equal(service.getAlias('calc'), 'c')

  const items = [{ id: 'calc', name: '极速计算器' }]
  const ranked = service.rankItems(
    items,
    { getId: (x) => x.id, getTitle: (x) => x.name },
    'c'
  )
  assert.equal(ranked.length, 1)
  assert.equal(ranked[0]?.id, 'calc')
})

test('极值与破坏性异常用例：时间戳回拨、十万次高频防溢出、空值与无效输入', () => {
  const now = 5_000_000
  const service = new FrecencyRankingService({ nowProvider: () => now })

  // 1. 空 ID、null、undefined 安全过滤
  assert.equal(service.recordUsage(''), false)
  assert.equal(service.recordUsage('   '), false)
  assert.equal(service.recordUsage(null as any), false)
  assert.equal(service.recordUsage(undefined as any), false)
  assert.equal(service.size, 0)

  // 2. 时间戳回拨（给入超大未来时间戳，如修改系统时钟到 2099 年）
  const futureTimestamp = now + 999_999_999
  const recorded = service.recordUsage('cmd-timewarp', futureTimestamp)
  assert.equal(recorded, true)
  const entry = service.getEntry('cmd-timewarp')
  assert.ok(entry !== undefined)
  assert.equal(entry?.lastUsedAt, now, '未来时间戳必须安全 clamp 为当前时间')
  assert.ok(Number.isFinite(service.getScore('cmd-timewarp', now)))

  // 3. 极大调用次数（十万次）防溢出与内存恒定保护
  for (let i = 0; i < 100_000; i++) {
    service.recordUsage('stress-test-item', now)
  }
  const stressEntry = service.getEntry('stress-test-item')
  assert.ok(stressEntry !== undefined)
  assert.equal(stressEntry?.totalCount, 100_000)
  // 滑动窗口最大保留 50 个时间戳，严防内存泄漏与溢出
  assert.equal(stressEntry?.recentTimestamps.length, 50)
  assert.ok(Number.isFinite(service.getScore('stress-test-item', now)))
})

test('容量边界与 LRU/LFU 混合修剪机制：超过 500 项时自动淘汰最冷门项', () => {
  const now = 10_000_000
  // 创建容量限制为 500 的服务实例
  const service = new FrecencyRankingService({
    maxItems: 500,
    nowProvider: () => now
  })

  // 1. 写入一条极其重要的热门命令
  service.recordUsage('vip-command', now)
  service.recordUsage('vip-command', now)

  // 2. 写入一条 60 天前的历史遗留冷门命令
  service.recordUsage('cold-abandoned-cmd', now - 60 * ONE_DAY_MS)

  // 3. 连续灌入 510 个一次性项目，触发超额淘汰
  for (let i = 0; i < 510; i++) {
    service.recordUsage(`bulk-cmd-${i}`, now - ONE_HOUR_MS)
  }

  // 验证当前总条目数被严格控制在 500 项以内
  assert.ok(service.size <= 500, `总条目数必须 <= 500，当前为 ${service.size}`)

  // 验证冷门命令已被成功淘汰，而高频 VIP 命令依然稳固存在
  assert.equal(service.getEntry('cold-abandoned-cmd'), undefined, '最冷门且久远未使用的条目应被优先淘汰')
  assert.ok(service.getEntry('vip-command') !== undefined, '高频 VIP 条目必须保留在 Top 500 中')
})

test('持久化与本地存储：数据落盘、防抖写入与损坏容错恢复', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-frecency-test-'))
  const storageFile = path.join(tempDir, 'frecency_ranking.json')

  try {
    const service1 = new FrecencyRankingService({
      storageFilePath: storageFile,
      debounceMs: 50
    })

    service1.recordUsage('tool-alpha')
    service1.recordUsage('tool-beta')
    service1.setAlias('tool-alpha', 'a')

    // 立即刷盘
    await service1.flush()

    // 检查文件确实存在且包含有效 JSON
    const content = await fs.readFile(storageFile, 'utf8')
    const parsed = JSON.parse(content)
    assert.equal(parsed.version, 1)
    assert.ok(parsed.entries['tool-alpha'] !== undefined)
    assert.equal(parsed.entries['tool-alpha'].alias, 'a')

    // 创建全新服务实例从磁盘加载
    const service2 = new FrecencyRankingService({ storageFilePath: storageFile })
    await service2.load()

    assert.equal(service2.getAlias('tool-alpha'), 'a')
    assert.equal(service2.getEntry('tool-beta')?.totalCount, 1)

    // 破坏性测试：损坏 JSON 文件后重新加载，不崩溃且自愈
    await fs.writeFile(storageFile, '{"broken_json": [{{{', 'utf8')
    const service3 = new FrecencyRankingService({ storageFilePath: storageFile })
    await service3.load() // 不应抛出未捕获异常
    assert.equal(service3.size, 0)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('独立全局快捷键注册与分发映射测试', () => {
  const service = new FrecencyRankingService()
  let actionExecuted = false

  // 注册全局快捷键
  const registered = service.registerShortcut('calc-cmd', 'Ctrl+Shift+C', () => {
    actionExecuted = true
  })
  assert.equal(registered, true)
  assert.equal(service.getShortcut('calc-cmd'), 'Ctrl+Shift+C')

  // 分发命中
  const dispatched = service.dispatchShortcut('ctrl+shift+c')
  assert.equal(dispatched, true)
  assert.equal(actionExecuted, true)
  // 分发时自动记录一次 Frecency 使用
  assert.equal(service.getEntry('calc-cmd')?.totalCount, 1)

  // 注销后无法分发
  actionExecuted = false
  service.unregisterShortcut('calc-cmd')
  assert.equal(service.dispatchShortcut('ctrl+shift+c'), false)
  assert.equal(actionExecuted, false)
})
