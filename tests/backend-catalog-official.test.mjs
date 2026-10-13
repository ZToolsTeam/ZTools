/**
 * tests/backend-catalog-official.test.mjs
 * 
 * ZTools 阶段二：后端 API 改造（自营与社区双轨 Catalog 接口 & 下架熔断）自动化集成与混沌抗毁测试套件
 * 
 * 遵守 AGENTS.md 规范与测试规范：
 * 1. 默认包含集成测试 (Integration Tests by Default)：
 *    - 验证真实调用链路：发起 HTTP 请求 -> 路由校验 -> 服务层业务逻辑 -> 联表数据聚合 -> 视图描述符输出
 *    - 输出严格对齐 packages/ztools-plugins-spec 的 validateStoreCatalog 规范
 * 2. 严禁仅写 Happy Path (Beyond Happy Path)：
 *    - 正常链路：type=official / community / all、自营置顶、官方 CDN 强制转换、版本兼容性匹配
 *    - 破坏性异常：SQL 注入参数拦截、超长字符串防御、畸形 app_version 拦截、已下架插件 403 熔断、不存在 pluginId 404 校验
 */

import { register } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

// 1. 注册 Node 原生 ESM TypeScript 加载器
register('./ts-loader.mjs', import.meta.url)

// 2. 注入测试环境变量
process.env.JWT_SECRET = 'ztools-test-jwt-secret-key-2026-very-secure'
process.env.DB_HOST = '127.0.0.1'
process.env.DB_DATABASE = 'ztools'

// 3. 加载 spec 校验器与待测后端模块
const { validateStoreCatalog, validateCatalogPluginItem } = await import('../packages/ztools-plugins-spec/src/validator.js')
const { setDatabase, pool } = await import('../backend/src/db/index.ts')
const { default: pluginsRouter } = await import('../backend/src/routes/plugins.ts')
const { Hono } = await import('../backend/node_modules/hono/dist/index.js')

// ============================================================================
// 数据库层仿真集成（模拟 plugins, plugin_versions, plugin_categories 关系表）
// ============================================================================

const sampleCategories = [
  { id: 1, name: '系统工具', slug: 'system' },
  { id: 2, name: '效率工具', slug: 'productivity' },
  { id: 3, name: '开发工具', slug: 'dev' }
]

const samplePlugins = [
  {
    id: 1,
    plugin_id: 'calculator',
    name: '计算器',
    pinyin: 'JISUANQI',
    description: '极速数学与时区计算',
    category_id: 1,
    sort_order: 100,
    author: 'ztools',
    icon: 'icon.png',
    cdn_download_url: 'https://cdn.ztools.cn/plugins-zip/zips/calculator-1.0.0.zip',
    status: 'active',
    rating: 5,
    download_count: 5000,
    version: '2.0.0',
    file_size: 204800,
    keywords: ['calc', 'math', '计算'],
    is_official: true,
    revoked: false,
    revoked_reason: null
  },
  {
    id: 2,
    plugin_id: 'clipboard-history',
    name: '剪贴板历史',
    pinyin: 'JIANTIEBANLISHI',
    description: '剪贴板增强管理',
    category_id: 2,
    sort_order: 90,
    author: 'ztools',
    icon: 'icon.png',
    cdn_download_url: 'https://cdn.ztools.cn/plugins-zip/zips/clipboard-history-1.2.0.zip',
    status: 'active',
    rating: 5,
    download_count: 8000,
    version: '1.2.0',
    file_size: 307200,
    keywords: ['clipboard', 'copy', 'paste'],
    is_official: true,
    revoked: false,
    revoked_reason: null
  },
  {
    id: 3,
    plugin_id: 'json-viewer',
    name: 'JSON 格式化工具',
    pinyin: 'JSONGESHIHUA',
    description: '开发者 JSON 解析与美化',
    category_id: 3,
    sort_order: 50,
    author: 'community-geek',
    icon: 'icon.png',
    cdn_download_url: null,
    status: 'active',
    rating: 4,
    download_count: 1200,
    version: '1.0.1',
    file_size: 51200,
    keywords: ['json', 'format', 'dev'],
    is_official: false,
    revoked: false,
    revoked_reason: null
  },
  {
    id: 4,
    plugin_id: 'color-picker',
    name: '屏幕取色器',
    pinyin: 'PINGMUQUSEQI',
    description: '像素级快速吸色',
    category_id: 1,
    sort_order: 40,
    author: 'pixel-dev',
    icon: 'icon.png',
    cdn_download_url: null,
    status: 'active',
    rating: 4,
    download_count: 800,
    version: '1.5.0',
    file_size: 64000,
    keywords: ['color', 'picker'],
    is_official: false,
    revoked: false,
    revoked_reason: null
  },
  {
    id: 5,
    plugin_id: 'malicious-miner',
    name: '恶意测试工具',
    pinyin: 'EYICESHIGONGJU',
    description: '暗藏高危挖矿脚本',
    category_id: 1,
    sort_order: 0,
    author: 'bad-hacker',
    icon: 'icon.png',
    cdn_download_url: null,
    status: 'inactive',
    rating: 1,
    download_count: 10,
    version: '0.9.0',
    file_size: 1024,
    keywords: ['miner'],
    is_official: false,
    revoked: true,
    revoked_reason: '存在原型链逃逸与未声明网络挖矿行为，已被官方永久下架'
  },
  {
    id: 6,
    plugin_id: 'ai-future-suite',
    name: '未来 AI 助理',
    pinyin: 'WEILAIAIZHULI',
    description: '前沿 AI 实验套件（需要高版本宿主）',
    category_id: 2,
    sort_order: 85,
    author: 'ztools',
    icon: 'icon.png',
    cdn_download_url: 'https://cdn.ztools.cn/plugins-zip/zips/ai-future-suite-3.0.0.zip',
    status: 'active',
    rating: 5,
    download_count: 300,
    version: '3.0.0',
    file_size: 500000,
    keywords: ['ai', 'future'],
    is_official: true,
    revoked: false,
    revoked_reason: null
  }
]

const sampleVersions = [
  {
    id: 101,
    plugin_id: 1,
    version: '1.0.0',
    download_url: 'https://custom.mirror.com/calculator-1.0.0.zip',
    size: 102400,
    checksum: 'a'.repeat(64),
    sha256: 'a'.repeat(64),
    platform: 'windows',
    min_app_version: '1.0.0',
    min_web_version: '1.0.0',
    release_date: '2026-01-01'
  },
  {
    id: 102,
    plugin_id: 1,
    version: '2.0.0',
    download_url: 'https://custom.mirror.com/calculator-2.0.0.zip',
    size: 204800,
    checksum: 'a'.repeat(64),
    sha256: 'a'.repeat(64),
    platform: 'windows',
    min_app_version: '2.0.0',
    min_web_version: '1.0.0',
    release_date: '2026-06-01'
  },
  {
    id: 201,
    plugin_id: 2,
    version: '1.2.0',
    download_url: 'https://custom.mirror.com/clipboard-history-1.2.0.zip',
    size: 307200,
    checksum: 'b'.repeat(64),
    sha256: 'b'.repeat(64),
    platform: 'windows',
    min_app_version: '1.0.0',
    min_web_version: '1.0.0',
    release_date: '2026-02-01'
  },
  {
    id: 301,
    plugin_id: 3,
    version: '1.0.1',
    download_url: 'https://cdn.community.org/plugins/json-viewer-1.0.1.zip',
    size: 51200,
    checksum: 'c'.repeat(64),
    sha256: 'c'.repeat(64),
    platform: 'windows',
    min_app_version: '1.0.0',
    min_web_version: '1.0.0',
    release_date: '2026-03-01'
  },
  {
    id: 401,
    plugin_id: 4,
    version: '1.5.0',
    download_url: 'https://cdn.community.org/plugins/color-picker-1.5.0.zip',
    size: 64000,
    checksum: 'd'.repeat(64),
    sha256: 'd'.repeat(64),
    platform: 'windows',
    min_app_version: '1.5.0',
    min_web_version: '1.0.0',
    release_date: '2026-04-01'
  },
  {
    id: 501,
    plugin_id: 5,
    version: '0.9.0',
    download_url: 'https://evil.org/miner-0.9.0.zip',
    size: 1024,
    checksum: 'e'.repeat(64),
    sha256: 'e'.repeat(64),
    platform: 'windows',
    min_app_version: '1.0.0',
    min_web_version: '1.0.0',
    release_date: '2026-01-01'
  },
  {
    id: 601,
    plugin_id: 6,
    version: '3.0.0',
    download_url: 'https://cdn.ztools.cn/plugins-zip/zips/ai-future-suite-3.0.0.zip',
    size: 500000,
    checksum: 'f'.repeat(64),
    sha256: 'f'.repeat(64),
    platform: 'windows',
    min_app_version: '3.0.0',
    min_web_version: '1.0.0',
    release_date: '2026-05-01'
  }
]

function getTableName(tbl) {
  if (!tbl) return ''
  if (typeof tbl === 'string') return tbl
  return (
    tbl[Symbol.for('drizzle:Name')] ||
    tbl[Symbol.for('drizzle:OriginalName')] ||
    tbl[Symbol.for('drizzle:BaseName')] ||
    ''
  )
}

function unwrapVal(val) {
  if (Array.isArray(val)) {
    return val.map(unwrapVal)
  }
  if (val && typeof val === 'object' && 'value' in val) {
    return unwrapVal(val.value)
  }
  return val
}

// 递归条件求值器
function evaluateCondition(item, clause) {
  if (!clause) return true
  if (clause.queryChunks) {
    const chunks = clause.queryChunks
    if (chunks.length === 3 && chunks[0]?.value?.[0] === '(' && chunks[2]?.value?.[0] === ')') {
      return evaluateCondition(item, chunks[1])
    }
    let op = null
    const subs = []
    for (const ch of chunks) {
      if (ch?.value && (ch.value[0] === ' and ' || ch.value[0] === ' or ')) {
        op = ch.value[0].trim()
      } else if (ch && typeof ch === 'object' && 'queryChunks' in ch) {
        subs.push(ch)
      }
    }
    if (op === 'and') return subs.every((c) => evaluateCondition(item, c))
    if (op === 'or') return subs.some((c) => evaluateCondition(item, c))

    let col = null
    let comp = null
    let rawVal = undefined
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i]
      if (ch?.name && typeof ch.name === 'string') col = ch.name
      if (ch?.value && typeof ch.value[0] === 'string') {
        const s = ch.value[0].trim().toLowerCase()
        if (['=', 'in', 'like', '<>', '!=', 'is null', 'is not null'].includes(s)) comp = s
      }
      if (col && comp && rawVal === undefined && i + 1 < chunks.length) {
        rawVal = chunks[i + 1]
      }
    }
    if (col) {
      const itemVal = item[col]
      const val = unwrapVal(rawVal)
      if (comp === '=') {
        if (typeof val === 'boolean') return Boolean(itemVal) === val
        return String(itemVal) === String(val)
      }
      if (comp === '<>' || comp === '!=') {
        if (typeof val === 'boolean') return Boolean(itemVal) !== val
        return String(itemVal) !== String(val)
      }
      if (comp === 'in') {
        const arr = Array.isArray(val) ? val : []
        return arr.map(String).includes(String(itemVal))
      }
      if (comp === 'like') {
        const strVal = String(val ?? '').replace(/%/g, '.*')
        const regex = new RegExp(`^${strVal}$`, 'i')
        return regex.test(String(itemVal ?? ''))
      }
      if (comp === 'is null') return itemVal === null || itemVal === undefined
      if (comp === 'is not null') return itemVal !== null && itemVal !== undefined
    }
  }
  return true
}

const mockDb = {
  select(fields) {
    let sourceTable = 'plugins'
    let currentClause = null
    let currentLimit = null

    const queryObj = {
      from(tbl) {
        const name = getTableName(tbl)
        if (name.includes('version')) {
          sourceTable = 'plugin_versions'
        } else if (name.includes('categor')) {
          sourceTable = 'plugin_categories'
        } else if (name.includes('comment')) {
          sourceTable = 'plugin_comments'
        } else if (name.includes('screenshot') || name.includes('feature') || name.includes('changelog')) {
          sourceTable = 'empty'
        } else {
          sourceTable = 'plugins'
        }
        return this
      },
      where(clause) {
        currentClause = clause
        return this
      },
      orderBy(...orders) {
        return this
      },
      limit(n) {
        currentLimit = n
        return this
      },
      then(resolve, reject) {
        try {
          if (sourceTable === 'plugin_comments') {
            return resolve([{ count: 0 }])
          }
          if (sourceTable === 'empty') {
            return resolve([])
          }
          if (sourceTable === 'plugin_categories') {
            let rows = [...sampleCategories]
            if (currentClause) {
              rows = rows.filter((r) => evaluateCondition(r, currentClause))
            }
            return resolve(rows)
          }

          let rows = sourceTable === 'plugin_versions'
            ? [...sampleVersions]
            : [...samplePlugins]

          if (currentClause) {
            rows = rows.filter((r) => evaluateCondition(r, currentClause))
          }

          // 补充分类名称
          if (sourceTable === 'plugins') {
            rows = rows.map((p) => {
              const cat = sampleCategories.find((c) => c.id === p.category_id)
              return { ...p, category: cat?.name || '默认分类' }
            })
          }

          if (currentLimit !== null) {
            rows = rows.slice(0, currentLimit)
          }

          resolve(rows)
        } catch (err) {
          reject(err)
        }
      }
    }
    return queryObj
  }
}

// 注入模拟数据库
setDatabase(mockDb)

// 挂载待测 Hono 应用
const app = new Hono()
app.route('/api/plugins', pluginsRouter)

// ============================================================================
// 测试主体
// ============================================================================

describe('ZTools 扩展商店双轨 Catalog 与安全熔断测试套件 (Beyond Happy Path)', () => {

  after(async () => {
    try {
      await pool.end()
    } catch (_) {}
  })

  // --------------------------------------------------------------------------
  // Suite 1: 标准 Catalog 规范与输出格式 (packages/ztools-plugins-spec)
  // --------------------------------------------------------------------------
  describe('1. 标准 Catalog 接口输出规范与自营置顶 (type=all)', () => {
    it('Happy Case: 应该返回满足 packages/ztools-plugins-spec 的全量 Catalog 清单', async () => {
      const res = await app.request('/api/plugins/catalog')
      assert.equal(res.status, 200, '应返回 HTTP 200')

      const body = await res.json()
      assert.equal(body.version, 1, 'catalog version 必须为 1')
      assert.ok(typeof body.generatedAt === 'string', 'generatedAt 必须为有效 ISO 时间戳')
      assert.ok(Array.isArray(body.plugins), 'catalog.plugins 必须为数组')

      // 使用 packages/ztools-plugins-spec 进行结构强校验
      const validation = validateStoreCatalog(body)
      assert.equal(validation.valid, true, `Catalog 应完全符合 spec 规范: ${validation.errors.join('; ')}`)
      assert.ok(validation.totalValid >= 4, '应至少包含4个有效插件')
      assert.ok(validation.revokedCount >= 1, '应至少识别1个已下架插件')
    })

    it('自营插件在 type=all 时排序权重自动置顶', async () => {
      const res = await app.request('/api/plugins/catalog?type=all')
      assert.equal(res.status, 200)

      const body = await res.json()
      const pluginsList = body.plugins

      // 验证自营插件在前，社区插件在后
      let switchedToCommunity = false
      for (const p of pluginsList) {
        if (!p.is_official) {
          switchedToCommunity = true
        } else if (switchedToCommunity) {
          assert.fail(`自营插件 [${p.id}] 出现在社区插件之后，未能完成置顶排序`)
        }
      }
    })

    it('自营插件的 downloadUrl 必须强制输出为官方 CDN 规范路径', async () => {
      const res = await app.request('/api/plugins/catalog?type=official')
      assert.equal(res.status, 200)

      const body = await res.json()
      assert.ok(body.plugins.length > 0, '应包含自营插件')

      for (const p of body.plugins) {
        assert.equal(p.is_official, true, `插件 [${p.id}] 必须为自营插件`)
        assert.ok(
          p.downloadUrl.startsWith('https://cdn.ztools.cn/plugins-zip/zips/'),
          `自营插件 [${p.id}] 的 downloadUrl 必须为官方 CDN 地址，当前为: ${p.downloadUrl}`
        )
      }
    })

    it('联表查询自动提取并包含 sha256、size、platforms、minAppVersion', async () => {
      const res = await app.request('/api/plugins/catalog')
      const body = await res.json()

      const calc = body.plugins.find((p) => p.id === 'calculator')
      assert.ok(calc, '应包含计算器插件')
      assert.equal(calc.version, '2.0.0', '默认应匹配最新版本 2.0.0')
      assert.equal(calc.sha256, 'a'.repeat(64), 'sha256 必须为 64 位哈希')
      assert.equal(calc.size, 204800, 'size 应为版本体大小')
      assert.deepEqual(calc.platforms, ['windows'], 'platforms 应正确输出')
      assert.equal(calc.minAppVersion, '2.0.0', 'minAppVersion 应正确输出')
    })

    it('安全下架熔断字段必须正确包含 revoked 与 revokedReason', async () => {
      const res = await app.request('/api/plugins/catalog')
      const body = await res.json()

      const miner = body.plugins.find((p) => p.id === 'malicious-miner')
      assert.ok(miner, '应包含下架的恶意插件以同步状态机')
      assert.equal(miner.revoked, true, 'revoked 状态必须为 true')
      assert.ok(
        miner.revokedReason.includes('原型链逃逸'),
        `revokedReason 应包含具体下架原因: ${miner.revokedReason}`
      )
    })
  })

  // --------------------------------------------------------------------------
  // Suite 2: 双轨筛选与客户端版本协商 (type, category, search, app_version)
  // --------------------------------------------------------------------------
  describe('2. 双轨筛选与版本协商', () => {
    it('type=official 仅返回自营插件', async () => {
      const res = await app.request('/api/plugins/catalog?type=official')
      const body = await res.json()

      assert.ok(body.plugins.length > 0)
      for (const p of body.plugins) {
        assert.equal(p.is_official, true, `不应包含社区插件: ${p.id}`)
      }
      assert.ok(!body.plugins.some((p) => p.id === 'json-viewer'))
    })

    it('type=community 仅返回社区插件', async () => {
      const res = await app.request('/api/plugins/catalog?type=community')
      const body = await res.json()

      assert.ok(body.plugins.length > 0)
      for (const p of body.plugins) {
        assert.equal(p.is_official, false, `不应包含自营插件: ${p.id}`)
      }
      assert.ok(!body.plugins.some((p) => p.id === 'calculator'))
      assert.ok(body.plugins.some((p) => p.id === 'json-viewer'))
    })

    it('search 模糊搜索支持名称与拼音匹配', async () => {
      // 搜索中文名称
      const res1 = await app.request('/api/plugins/catalog?search=计算器')
      const body1 = await res1.json()
      assert.ok(body1.plugins.some((p) => p.id === 'calculator'))

      // 搜索拼音
      const res2 = await app.request('/api/plugins/catalog?search=JSON')
      const body2 = await res2.json()
      assert.ok(body2.plugins.some((p) => p.id === 'json-viewer'))
    })

    it('category 分类筛选准确生效', async () => {
      const res = await app.request('/api/plugins/catalog?category=系统工具')
      const body = await res.json()

      assert.ok(body.plugins.length > 0)
      for (const p of body.plugins) {
        assert.equal(p.category, '系统工具')
      }
    })

    it('app_version 客户端版本协商：过滤不兼容插件并选取最高兼容版本', async () => {
      // 模拟老客户端 app_version=1.0.0
      const resOld = await app.request('/api/plugins/catalog?app_version=1.0.0')
      const bodyOld = await resOld.json()

      // ai-future-suite 要求 min_app_version=3.0.0，在 1.0.0 客户端下应被完全过滤
      assert.ok(!bodyOld.plugins.some((p) => p.id === 'ai-future-suite'), '老版本客户端不应出现不兼容插件')

      // calculator 在 1.0.0 下应降级匹配 1.0.0 版本（而不是 2.0.0）
      const calcOld = bodyOld.plugins.find((p) => p.id === 'calculator')
      assert.ok(calcOld)
      assert.equal(calcOld.version, '1.0.0', '应协商出与 1.0.0 兼容的最高插件版本')
    })
  })

  // --------------------------------------------------------------------------
  // Suite 3: 插件下载与安全熔断拦截 (GET /api/plugins/:pluginId/download)
  // --------------------------------------------------------------------------
  describe('3. 插件下载与下架熔断 (GET /:pluginId/download)', () => {
    it('Happy Case: 正常插件下载输出 sha256 与标准 downloadUrl', async () => {
      const res = await app.request('/api/plugins/calculator/download')
      assert.equal(res.status, 200)

      const body = await res.json()
      assert.equal(body.success, true)
      assert.equal(body.data.pluginId, 'calculator')
      assert.equal(body.data.version, '1.0.0')
      assert.equal(body.data.sha256, 'a'.repeat(64))
      assert.ok(body.data.downloadUrl.startsWith('https://cdn.ztools.cn/plugins-zip/zips/calculator-1.0.0.zip'))
    })

    it('社区插件下载返回其标准 CDN/分发地址与 sha256', async () => {
      const res = await app.request('/api/plugins/json-viewer/download')
      assert.equal(res.status, 200)

      const body = await res.json()
      assert.equal(body.success, true)
      assert.equal(body.data.pluginId, 'json-viewer')
      assert.equal(body.data.sha256, 'c'.repeat(64))
      assert.equal(body.data.downloadUrl, 'https://cdn.community.org/plugins/json-viewer-1.0.1.zip')
    })

    it('安全下架熔断：已下架插件 (revoked: true) 下载强行阻断 403 Forbidden', async () => {
      const res = await app.request('/api/plugins/malicious-miner/download')
      assert.equal(res.status, 403, '已下架插件必须返回 403 Forbidden')

      const body = await res.json()
      assert.equal(body.success, false)
      assert.equal(body.code, 'PLUGIN_REVOKED')
      assert.ok(body.message.includes('官方安全下架'))
      assert.ok(body.errors.revokedReason.includes('原型链逃逸'))
    })

    it('指定版本下载正常响应', async () => {
      const res = await app.request('/api/plugins/calculator/download?version=2.0.0')
      assert.equal(res.status, 200)

      const body = await res.json()
      assert.equal(body.success, true)
      assert.equal(body.data.version, '2.0.0')
      assert.equal(body.data.sha256, 'a'.repeat(64))
      assert.ok(body.data.downloadUrl.startsWith('https://cdn.ztools.cn/plugins-zip/zips/calculator-2.0.0.zip'))
    })
  })

  // --------------------------------------------------------------------------
  // Suite 4: 破坏性混沌异常测试 (Chaos & Fault Injection)
  // --------------------------------------------------------------------------
  describe('4. 破坏性混沌异常与边界防御测试 (Beyond Happy Path)', () => {
    it('SQL 注入参数拦截防御：非法 type 参数被严格阻断 400', async () => {
      const injectionTypes = [
        "' OR '1'='1",
        "official; DROP TABLE plugins;--",
        "community' UNION SELECT * FROM users --",
        "unknown_type",
        "12345"
      ]

      for (const t of injectionTypes) {
        const res = await app.request(`/api/plugins/catalog?type=${encodeURIComponent(t)}`)
        assert.equal(res.status, 400, `注入或非法 type="${t}" 应返回 400`)
        const body = await res.json()
        assert.equal(body.success, false)
        assert.ok(body.message.includes('无效的 type 参数'))
      }
    })

    it('超长字符串防御：超过 100 字符的 search 关键词应被拦截 400', async () => {
      const hugeSearch = 'a'.repeat(101)
      const res = await app.request(`/api/plugins/catalog?search=${hugeSearch}`)
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.equal(body.success, false)
      assert.ok(body.message.includes('搜索关键词长度不能超过'))
    })

    it('超长分类名防御：超过 50 字符的 category 应被拦截 400', async () => {
      const hugeCat = 'c'.repeat(51)
      const res = await app.request(`/api/plugins/catalog?category=${hugeCat}`)
      assert.equal(res.status, 400)
      const body = await res.json()
      assert.equal(body.success, false)
      assert.ok(body.message.includes('分类名称长度不能超过'))
    })

    it('畸形 app_version 拦截防御：非数字版本号被严格阻断 400', async () => {
      const badVersions = [
        'not-semver',
        'v1.0.0',
        '1.2.3.4.5',
        '1.0',
        'latest',
        '<script>alert(1)</script>'
      ]

      for (const ver of badVersions) {
        const res = await app.request(`/api/plugins/catalog?app_version=${encodeURIComponent(ver)}`)
        assert.equal(res.status, 400, `畸形 app_version="${ver}" 应返回 400`)
        const body = await res.json()
        assert.equal(body.success, false)
        assert.ok(body.message.includes('三段或四段数字版本'))
      }
    })

    it('不存在 pluginId 404 校验', async () => {
      const res = await app.request('/api/plugins/non-existent-plugin-9999/download')
      assert.equal(res.status, 404)
      const body = await res.json()
      assert.equal(body.success, false)
      assert.ok(body.message.includes('插件不存在'))
    })

    it('非法 pluginId 格式防御：目录穿越或特殊符号被阻断 400', async () => {
      const badIds = [
        '../passwd',
        'plugin@name',
        'plugin/sub',
        'a'.repeat(65)
      ]

      for (const badId of badIds) {
        const res = await app.request(`/api/plugins/${encodeURIComponent(badId)}/download`)
        assert.equal(res.status, 400, `非法 pluginId="${badId}" 应返回 400`)
        const body = await res.json()
        assert.equal(body.success, false)
        assert.ok(body.message.includes('无效的插件ID'))
      }
    })

    it('客户端版本不满足插件要求时下载拦截：返回 426 Upgrade Required', async () => {
      const res = await app.request('/api/plugins/ai-future-suite/download?app_version=1.0.0')
      assert.equal(res.status, 426, '不满足版本要求的客户端下载应返回 426')

      const body = await res.json()
      assert.equal(body.success, false)
      assert.equal(body.code, 'PLUGIN_VERSION_INCOMPATIBLE')
      assert.ok(body.message.includes('升级客户端'))
    })
  })
})
