import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import fs from 'node:fs'
import path from 'node:path'
import { createScopedLocalStorage } from '@/utils/pluginStorage'
import { callHostMethod, getHostMethods } from '@/declarative/hostMethods'
import {
  BUNDLED_PLUGIN_IDS,
  isBundledPlugin,
  readBundledPluginFile,
  getBundledPluginEntries,
  resolveBundledReplacement,
  resolveBundledReplacementFeature,
  BUNDLED_PLUGIN_REPLACEMENTS
} from '@/utils/bundledPlugins'
import { isPluginVisible } from '@/utils/pluginVisibility'
import { getOfficialPlugin, getOfficialPluginsList } from '@/utils/officialPlugins'
import { resolvePluginGlyph, isGlyph } from '@/utils/brandIcons'
import { loadInstalledDeclarativePlugin } from '@/utils/declarativePluginLoader'
import bundledConfig from '@/config/bundledPlugins.generated.js'
import DetailRenderer from '@/declarative/components/DetailRenderer.vue'

/**
 * 内存版宿主插件存储：行为与主进程 DatabaseService 一致（按 plugin_id 分库，缺键返回 DATABASE_KEY_NOT_FOUND）
 */
function createFakeHostDb() {
  const dbs = new Map()
  const calls = []
  const store = (id) => {
    if (!dbs.has(id)) dbs.set(id, new Map())
    return dbs.get(id)
  }
  const notFound = () => Object.assign(new Error('Key not found'), { code: 'DATABASE_KEY_NOT_FOUND' })
  const call = vi.fn(async (method, params) => {
    calls.push([method, params])
    const db = store(params.plugin_id)
    switch (method) {
      case 'db_put':
        db.set(params.key, params.value)
        return { success: true, data: 'OK' }
      case 'db_compare_and_set': {
        const matches = (db.get(params.key) ?? null) === params.expectedValue
        if (matches) db.set(params.key, params.value)
        return { success: true, data: matches }
      }
      case 'db_get':
        if (!db.has(params.key)) throw notFound()
        return { success: true, data: db.get(params.key) }
      case 'db_delete':
        db.delete(params.key)
        return { success: true, data: 'OK' }
      case 'db_query':
        return {
          success: true,
          data: [...db.entries()].filter(([k]) => k.startsWith(params.prefix)).map(([key, value]) => ({ key, value }))
        }
      default:
        throw new Error(`unexpected ${method}`)
    }
  })
  return { call, dbs, calls }
}

describe('插件存储 createScopedLocalStorage', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('读写删、列出与清空在宿主存储里闭环，值保持 JSON 结构', async () => {
    const host = createFakeHostDb()
    const ls = createScopedLocalStorage('todo', host.call)
    expect(await ls.getItem('items')).toBeUndefined()
    await ls.setItem('items', [{ id: 'a', title: '买牛奶' }])
    await ls.setItem('count', 3)
    expect(await ls.getItem('items')).toEqual([{ id: 'a', title: '买牛奶' }])
    expect(await ls.allItems()).toEqual({ items: [{ id: 'a', title: '买牛奶' }], count: 3 })
    await ls.removeItem('count')
    expect(await ls.getItem('count')).toBeUndefined()
    await ls.clear()
    expect(await ls.allItems()).toEqual({})
    // 所有写入都带插件命名空间与 ls: 前缀
    for (const [, params] of host.calls) {
      expect(params.plugin_id).toBe('todo')
      if (params.key) expect(params.key.startsWith('ls:')).toBe(true)
    }
  })

  it('不同插件的数据互相隔离，同名 key 不会串', async () => {
    const host = createFakeHostDb()
    const a = createScopedLocalStorage('memo', host.call)
    const b = createScopedLocalStorage('todo', host.call)
    await a.setItem('items', ['memo'])
    await b.setItem('items', ['todo'])
    expect(await a.getItem('items')).toEqual(['memo'])
    expect(await b.getItem('items')).toEqual(['todo'])
    await a.clear()
    expect(await b.getItem('items')).toEqual(['todo'])
  })

  it('[迁移] 宿主存储为空时读取旧版浏览器缓存，并写入宿主存储；旧值保留', async () => {
    const host = createFakeHostDb()
    localStorage.setItem('raycast_ztools_qr_history', JSON.stringify([{ id: 'q1' }]))
    const ls = createScopedLocalStorage('qr-code', host.call)
    expect(await ls.getItem('ztools_qr_history')).toEqual([{ id: 'q1' }])
    expect(host.dbs.get('qr-code').get('ls:ztools_qr_history')).toBe(JSON.stringify([{ id: 'q1' }]))
    expect(localStorage.getItem('raycast_ztools_qr_history')).not.toBeNull()
  })

  it('[故障注入] 宿主读取失败（非缺键）必须抛错，不能当作「没有数据」返回 undefined', async () => {
    const call = vi.fn(async () => {
      throw Object.assign(new Error('LevelDB 已损坏'), { code: 'DATA_CORRUPT' })
    })
    const ls = createScopedLocalStorage('todo', call)
    await expect(ls.getItem('items')).rejects.toMatchObject({ code: 'DATA_CORRUPT' })
  })

  it('[故障注入] 宿主写入失败时 setItem 抛错，调用方可以据此保持界面不变', async () => {
    const call = vi.fn(async () => {
      throw Object.assign(new Error('磁盘已满'), { code: 'FILE_ERROR' })
    })
    const ls = createScopedLocalStorage('todo', call)
    await expect(ls.setItem('items', [1])).rejects.toMatchObject({ code: 'FILE_ERROR' })
  })

  it('[数据损坏] 存储里的值不是 JSON 时按原始字符串返回，不抛错', async () => {
    const host = createFakeHostDb()
    host.dbs.set('memo', new Map([['ls:items', '{broken']]))
    const ls = createScopedLocalStorage('memo', host.call)
    expect(await ls.getItem('items')).toBe('{broken')
  })

  it('[边界] 非法 key、超大值、非法插件 ID 都被拒绝', async () => {
    const host = createFakeHostDb()
    const ls = createScopedLocalStorage('memo', host.call)
    await expect(ls.getItem('')).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' })
    await expect(ls.setItem('x'.repeat(201), 1)).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' })
    await expect(ls.setItem('big', 'x'.repeat(4 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'STORAGE_VALUE_TOO_LARGE' })
    expect(host.call).not.toHaveBeenCalled()
    expect(() => createScopedLocalStorage('../etc', host.call)).toThrow()
    expect(() => createScopedLocalStorage('', host.call)).toThrow()
  })

  it('[并发] 20 次交错读写全部落到同一份数据，最后一次写入生效', async () => {
    const host = createFakeHostDb()
    const ls = createScopedLocalStorage('todo', host.call)
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? ls.getItem('n') : ls.setItem('n', i))))
    await ls.setItem('n', 'final')
    expect(await ls.getItem('n')).toBe('final')
  })
})

describe('宿主 IPC 调用 hostMethods', () => {
  afterEach(() => {
    delete window.__ztoolsElectron
  })

  it('按 { messageId, params } 调用并解开 { success, data } 信封', async () => {
    const fn = vi.fn(async (req) => ({ messageId: req.messageId, success: true, data: { text: 'hi' } }))
    window.__ztoolsElectron = { transport: { methods: { clipboard_read_text: fn } } }
    expect(await callHostMethod('clipboard_read_text', { a: 1 })).toEqual({ text: 'hi' })
    const req = fn.mock.calls[0][0]
    expect(req.params).toEqual({ a: 1 })
    expect(req.messageId).toMatch(/^[A-Za-z0-9:_-]{1,128}$/)
  })

  it('[故障注入] 宿主返回失败信封时抛出带 code 的错误', async () => {
    window.__ztoolsElectron = {
      transport: { methods: { db_get: async () => ({ success: false, error: { code: 'DATABASE_KEY_NOT_FOUND', message: 'Key not found' } }) } }
    }
    await expect(callHostMethod('db_get', {})).rejects.toMatchObject({ code: 'DATABASE_KEY_NOT_FOUND' })
  })

  it('[故障注入] 宿主返回畸形结果或缺少方法时明确报错；无宿主时 getHostMethods 返回 null', async () => {
    window.__ztoolsElectron = { transport: { methods: { bad: async () => 'garbage' } } }
    await expect(callHostMethod('bad')).rejects.toMatchObject({ code: 'HOST_RESPONSE_INVALID' })
    await expect(callHostMethod('missing')).rejects.toMatchObject({ code: 'HOST_METHOD_UNAVAILABLE' })
    expect(getHostMethods().missing).toBeUndefined()
    delete window.__ztoolsElectron
    expect(getHostMethods()).toBeNull()
  })
})

describe('内置插件与可见性', () => {
  it('内置插件清单与 public/bundled-plugins 一致，每个插件的入口文件与子模块都存在且未被 .gitignore 忽略', () => {
    const entries = getBundledPluginEntries()
    expect(entries.map((e) => e.pluginId).sort()).toEqual([...BUNDLED_PLUGIN_IDS].sort())
    const indexJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'public/bundled-plugins/index.json'), 'utf8')
    )
    for (const id of BUNDLED_PLUGIN_IDS) {
      expect(fs.existsSync(path.join(process.cwd(), 'public/bundled-plugins', id, 'dist/index.js'))).toBe(true)
      const indexed = indexJson.plugins.find((p) => p.id === id)
      expect(indexed, `index.json 缺少 ${id}`).toBeTruthy()
      for (const rel of indexed.files) {
        const filePath = path.join(process.cwd(), 'public/bundled-plugins', id, rel)
        expect(fs.existsSync(filePath), `缺少内置插件文件 ${id}/${rel}`).toBe(true)
        expect(fs.statSync(filePath).size, `内置插件文件为空 ${id}/${rel}`).toBeGreaterThan(0)
      }
    }
    // 防回归：.gitignore 不能再用无前导斜杠的裸 dist/ 把 public/bundled-plugins/*/dist/ 吞掉
    const gitignore = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8')
    expect(gitignore).toMatch(/^\/dist\/$/m)
    expect(gitignore).not.toMatch(/^dist\/$/m)

    // 每次返回新数组，调用方修改不会污染清单
    entries[0].name = '被改掉'
    expect(getBundledPluginEntries()[0].name).not.toBe('被改掉')
  })

  it('[集成] 全部 11 款内置插件（含 json-format）通过真实 readBundledPluginFile 链路完整加载入口与相对子模块', async () => {
    vi.stubGlobal('fetch', async (url) => {
      const match = String(url).match(/bundled-plugins\/([^?#]+)$/)
      if (!match) return { ok: false, status: 404, text: async () => 'Not Found' }
      const rel = match[1].split('/').map(decodeURIComponent).join('/')
      const diskPath = path.join(process.cwd(), 'public/bundled-plugins', rel)
      if (!fs.existsSync(diskPath)) {
        return { ok: false, status: 404, text: async () => 'Not Found' }
      }
      const content = fs.readFileSync(diskPath, 'utf8')
      return { ok: true, status: 200, text: async () => content }
    })
    try {
      for (const id of BUNDLED_PLUGIN_IDS) {
        const loaded = await loadInstalledDeclarativePlugin(id)
        expect(loaded.id).toBe(id)
        expect(typeof loaded.command).toBe('function')
      }
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('[异常与故障注入] 内置插件入口或子模块返回 HTTP 404 / 500 时，抛出带状态码与 PLUGIN_RESOURCE_NOT_FOUND 的明确错误', async () => {
    // 场景 1: plugin.json 正常，但 dist/index.js 返回 404（复现截图故障）
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).endsWith('/plugin.json')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 'json-format', name: 'JSON 格式化', entry: 'dist/index.js' })
        }
      }
      return { ok: false, status: 404, text: async () => 'Not Found' }
    })
    try {
      await expect(loadInstalledDeclarativePlugin('json-format')).rejects.toMatchObject({
        code: 'PLUGIN_RESOURCE_NOT_FOUND',
        status: 404,
        message: '无法加载内置插件资源 [json-format/dist/index.js]: HTTP 404'
      })
    } finally {
      vi.unstubAllGlobals()
    }

    // 场景 2: 入口 dist/index.js 正常，但依赖的相对子模块 ./logic.js 返回 500
    vi.stubGlobal('fetch', async (url) => {
      if (String(url).endsWith('/plugin.json')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 'json-format', name: 'JSON 格式化', entry: 'dist/index.js' })
        }
      }
      if (String(url).endsWith('/dist/index.js')) {
        return {
          ok: true,
          status: 200,
          text: async () => 'import { format } from "./logic.js"; export default function Cmd() { return format(); }'
        }
      }
      return { ok: false, status: 500, text: async () => 'Internal Error' }
    })
    try {
      await expect(loadInstalledDeclarativePlugin('json-format')).rejects.toMatchObject({
        code: 'PLUGIN_RESOURCE_NOT_FOUND',
        status: 500,
        message: '无法加载内置插件资源 [json-format/dist/logic.js]: HTTP 500'
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('可见性：内置插件与插件市场分发的官方插件可见；草稿、旧内置实现、官方作者的其他插件隐藏；社区插件可见', () => {
    for (const id of BUNDLED_PLUGIN_IDS) expect(isPluginVisible(id)).toBe(true)
    expect(isPluginVisible({ pluginId: 'JSON-FORMAT' })).toBe(true)
    // plugins 仓库里非草稿的官方插件走插件市场分发，安装后要能看到（同名的旧示例实现不再挡住它们）
    expect(bundledConfig.storeOfficialIds.length).toBeGreaterThan(0)
    for (const id of bundledConfig.storeOfficialIds) {
      expect(isPluginVisible(id)).toBe(true)
      expect(isPluginVisible({ pluginId: id, author: 'ZTools Team' })).toBe(true)
    }
    for (const id of ['kill-process', 'screen-color-picker', 'cleaner', 'shredder']) expect(isPluginVisible(id)).toBe(true)
    // 只存在于旧示例实现里的插件继续隐藏
    expect(isPluginVisible('clipboard-history')).toBe(false)
    // 草稿与已下架（plugin.json 写了 draft 或 revoked）一律隐藏，且与插件市场分发两份名单不能重叠
    for (const id of bundledConfig.unreleasedOfficialIds) {
      expect(isPluginVisible(id)).toBe(false)
      expect(bundledConfig.storeOfficialIds).not.toContain(id)
    }
    expect(isPluginVisible({ pluginId: 'new-official-thing', author: 'ZTools Team' })).toBe(false)
    expect(isPluginVisible({ pluginId: 'community-tool', author: 'Indie Dev' })).toBe(true)
    for (const bad of [null, undefined, '', '   ', {}]) expect(isPluginVisible(bad)).toBe(false)
  })

  // 需要插件源码目录；单独克隆客户端仓库时跳过
  const pluginsRoot = path.resolve(__dirname, '../../../../plugins')
  it.skipIf(!fs.existsSync(pluginsRoot))('[集成] plugins 仓库里已下架（revoked）的官方插件归入隐藏名单，不会当成插件市场插件显示', () => {
    const revoked = fs.readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(pluginsRoot, d.name, 'plugin.json')))
      .map((d) => JSON.parse(fs.readFileSync(path.join(pluginsRoot, d.name, 'plugin.json'), 'utf8')))
      .filter((m) => m.revoked === true)
    for (const manifest of revoked) {
      expect(bundledConfig.unreleasedOfficialIds, manifest.id).toContain(manifest.id)
      expect(bundledConfig.storeOfficialIds, manifest.id).not.toContain(manifest.id)
      expect(isPluginVisible({ pluginId: manifest.id, author: 'ZTools Team' }), manifest.id).toBe(false)
    }
  })

  it('插件市场分发的官方插件不再落到同名的旧示例实现：打开时从安装目录加载，也不会被当成预装插件列出', () => {
    const listed = new Set(getOfficialPluginsList().map((p) => String(p.pluginId).toLowerCase()))
    for (const id of bundledConfig.storeOfficialIds) {
      expect(getOfficialPlugin(id)).toBeUndefined()
      expect(getOfficialPlugin(id.toUpperCase())).toBeUndefined()
      expect(listed.has(id)).toBe(false)
    }
    // 别名指向旧实现的插件（clipboard-manager → 旧 clipboard-history）同样以真实插件为准
    expect(getOfficialPlugin('clipboard-manager')).toBeUndefined()
  })

  it('[对抗] 读取内置插件文件时拒绝路径穿越与非内置插件 ID，且不发起请求', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    for (const rel of ['../index.json', 'dist/../../x', '/etc/passwd', 'dist//index.js', '', 'dist\\..\\x', 'C:/x', 'file://x', './plugin.json']) {
      await expect(readBundledPluginFile('json-format', rel)).rejects.toMatchObject({ code: 'PATH_TRAVERSAL_BLOCKED' })
    }
    await expect(readBundledPluginFile('cleaner', 'plugin.json')).rejects.toMatchObject({ code: 'PLUGIN_RESOURCE_NOT_FOUND' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(isBundledPlugin('../json-format')).toBe(false)
    vi.unstubAllGlobals()
  })
})

describe('声明式插件加载器', () => {
  const files = (code) => ({
    'plugin.json': JSON.stringify({ id: 'probe', name: '探针', entry: 'dist/index.js', permissions: [] }),
    'dist/index.js': code
  })
  const reader = (map) => async (_id, rel) => {
    if (!(rel in map)) throw Object.assign(new Error('404'), { code: 'PLUGIN_RESOURCE_NOT_FOUND' })
    return map[rel]
  }

  // 通过真实加载链路拿到插件里的 crypto 模块（featureCode 指向导出的函数）
  async function loadCryptoProbe() {
    const loaded = await loadInstalledDeclarativePlugin('probe', {
      featureCode: 'probe',
      readFile: reader(files(`
        const crypto = require('crypto')
        export function probe() { return crypto }
        export default function Cmd() { return null }
      `))
    })
    return loaded.command()
  }

  it('[集成] 插件里的 crypto.createHash / createHmac 与 Node 标准实现逐字节一致（MD5 / SHA-1 / SHA-256）', async () => {
    const nodeCrypto = await import('node:crypto')
    const crypto = await loadCryptoProbe()
    const inputs = ['', 'abc', '中文 emoji 😀', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000)]
    const keys = ['', 'key', 'k'.repeat(64), 'k'.repeat(65), 'k'.repeat(200)]
    for (const alg of ['md5', 'sha1', 'sha256', 'SHA256', 'sha-256', 'sha-1']) {
      const nodeAlg = alg.toLowerCase().replace('-', '')
      for (const text of inputs) {
        expect(crypto.createHash(alg).update(text).digest('hex'), `${alg}(${text.length})`).toBe(nodeCrypto.createHash(nodeAlg).update(text).digest('hex'))
        for (const key of keys) {
          expect(crypto.createHmac(alg, key).update(text).digest('hex')).toBe(nodeCrypto.createHmac(nodeAlg, key).update(text).digest('hex'))
        }
      }
      // 分多次 update 与一次性 update 结果相同；base64 输出一致
      expect(crypto.createHash(alg).update('ab').update('c').digest('base64')).toBe(nodeCrypto.createHash(nodeAlg).update('abc').digest('base64'))
    }
    expect(crypto.randomBytes(16).length).toBe(16)
    expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('[安全] 没有标准实现的算法直接报错，不再返回看似正常的错误结果', async () => {
    const crypto = await loadCryptoProbe()
    for (const alg of ['sha512', 'sha-512', 'sha384', 'whirlpool', '', undefined, null, '__proto__', 'constructor', 'toString']) {
      expect(() => crypto.createHash(alg)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_NODE_API' }))
      expect(() => crypto.createHmac(alg, 'k')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_NODE_API' }))
    }
    expect(() => crypto.createCipheriv('aes-256-cbc', 'k', 'iv')).toThrow(/crypto\.createCipheriv/)
    expect(() => crypto.createDecipheriv('aes-256-cbc', 'k', 'iv')).toThrow(/crypto\.createDecipheriv/)
    expect(() => crypto.randomBytes(-1)).toThrow(RangeError)
    expect(() => crypto.randomBytes(65537)).toThrow(RangeError)
  })

  it('每个插件拿到按自身 ID 隔离的 LocalStorage，而不是共享的浏览器缓存', async () => {
    const host = createFakeHostDb()
    window.__ztoolsElectron = {
      transport: {
        methods: new Proxy({}, {
          get: (_t, method) => async (req) => {
            try {
              return { success: true, data: await host.call(method, req.params) }
            } catch (err) {
              return { success: false, error: { code: err.code, message: err.message } }
            }
          }
        })
      }
    }
    const loaded = await loadInstalledDeclarativePlugin('probe', {
      featureCode: 'save',
      readFile: reader(files(`
        import { LocalStorage } from '@ztools/declarative-ui'
        export async function save() { await LocalStorage.setItem('k', { v: 1 }); return LocalStorage.getItem('k') }
        export default function Cmd() { return null }
      `))
    })
    expect(await loaded.command()).toEqual({ v: 1 })
    expect(host.dbs.get('probe').get('ls:k')).toBe(JSON.stringify({ v: 1 }))
    expect(localStorage.getItem('raycast_k')).toBeNull()
    delete window.__ztoolsElectron
  })

  // 两个插件使用同名 namespace 与 key：经真实加载链路拿到的 Cache 按插件 ID 隔离
  const cacheProbe = (id) => ({
    'plugin.json': JSON.stringify({ id, name: id, entry: 'dist/index.js', permissions: [] }),
    'dist/index.js': `
      import { Cache } from '@ztools/declarative-ui'
      const cache = new Cache({ namespace: 'shared' })
      export function write(v) { cache.set('token', v); return cache.get('token') }
      export function read() { return cache.get('token') ?? null }
      export function readDefault() { return new Cache().get('token') ?? null }
      export function readBase() { const Base = Object.getPrototypeOf(Cache); return new Base({ namespace: 'shared' }).get('token') ?? null }
      export default function Cmd() { return null }
    `
  })
  const loadCacheFeature = async (id, featureCode) =>
    (await loadInstalledDeclarativePlugin(id, { featureCode, readFile: reader(cacheProbe(id)) })).command

  it('[隔离] 每个插件拿到按自身 ID 隔离的 Cache，同名 namespace 与 key 读不到其他插件的数据', async () => {
    const writeA = await loadCacheFeature('cache-probe-a', 'write')
    const readA = await loadCacheFeature('cache-probe-a', 'read')
    const readB = await loadCacheFeature('cache-probe-b', 'read')
    const writeB = await loadCacheFeature('cache-probe-b', 'write')

    expect(writeA('secret-a')).toBe('secret-a')
    expect(readB()).toBeNull()
    expect(writeB('secret-b')).toBe('secret-b')
    // 同一插件重新加载（每次加载都重新执行模块）仍是自己的数据，没有被插件 B 覆盖
    expect(readA()).toBe('secret-a')
    expect(readB()).toBe('secret-b')
  })

  it('[对抗] 插件改用默认 namespace 或沿原型链取基类，也读不到其他插件的缓存', async () => {
    const writeA = await loadCacheFeature('cache-probe-c', 'write')
    writeA('secret-c')
    const readDefaultD = await loadCacheFeature('cache-probe-d', 'readDefault')
    const readBaseD = await loadCacheFeature('cache-probe-d', 'readBase')
    expect(readDefaultD()).toBeNull()
    expect(readBaseD()).toBeNull()
  })

  it('[安全] 渲染进程不提供 fs 模块：声明了 fs 权限也拒绝引入，并提示改用 window.ztools.fs', async () => {
    for (const code of [`const fs = require('fs')\nexport default function Cmd() { return fs }`, `import fs from 'node:fs'\nexport default function Cmd() { return fs }`]) {
      await expect(
        loadInstalledDeclarativePlugin('fs-probe', {
          readFile: reader({
            'plugin.json': JSON.stringify({ id: 'fs-probe', name: 'fs', entry: 'dist/index.js', permissions: ['fs'] }),
            'dist/index.js': code
          })
        })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED_MODULE_ACCESS', message: expect.stringContaining('window.ztools.fs') })
    }
  })
})

describe('[对抗] Markdown 渲染不允许通过图片或链接注入脚本', () => {
  const render = (markdown) => mount(DetailRenderer, { props: { descriptor: { type: 'Detail', props: { markdown } } } })

  it('图片与链接地址里的引号被转义，危险协议不生成标签', () => {
    const wrapper = render(
      '![x](data:image/png;base64,AAA" onerror="alert(1))\n\n[点我](javascript:alert(1))\n\n[正常](https://ztools.cn/?a="b")'
    )
    const html = wrapper.html()
    // 解析后的真实 DOM：图片只有 src/alt/class，没有被注入事件属性
    for (const img of wrapper.findAll('img')) {
      expect(Object.keys(img.attributes()).sort()).toEqual(['alt', 'class', 'src'])
    }
    expect(wrapper.findAll('a').map((a) => a.attributes('href'))).toEqual(['https://ztools.cn/?a="b"'])
    expect(html).not.toMatch(/href="javascript:/i)
    expect(html).toContain('href="https://ztools.cn/?a=&quot;b&quot;"')
    expect(html).toContain('rel="noopener noreferrer"')
  })

  it('合法的 data:image 与 https 图片正常显示', () => {
    const html = render('![色块](data:image/svg+xml;utf8,%3Csvg%3E%3C/svg%3E)').html()
    expect(html).toMatch(/<img[^>]*src="data:image\/svg\+xml/)
  })
})

describe('内置插件图标', () => {
  it('每个内置插件都有品牌线性图形，首页不用等图片加载（不会先显示占位再跳变）', () => {
    for (const id of BUNDLED_PLUGIN_IDS) {
      const glyph = resolvePluginGlyph(id)
      expect(isGlyph(glyph), `${id} 缺少图形`).toBe(true)
    }
  })

  it('不同插件不共用同一个图形，避免在首页上认错', () => {
    const glyphs = BUNDLED_PLUGIN_IDS.map((id) => resolvePluginGlyph(id))
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })

  it('[破坏性] 未登记或异常的插件 ID 不会得到图形', () => {
    for (const bad of ['', '   ', null, undefined, 'unknown-plugin', '__proto__', 'constructor']) {
      expect(resolvePluginGlyph(bad)).toBe('')
    }
  })
})

describe('重复插件只保留一个', () => {
  it('合并进来的旧插件解析到保留的内置插件，保留的一方必须是内置插件', () => {
    expect(resolveBundledReplacement('notes')).toBe('memo')
    expect(resolveBundledReplacement(' Notes ')).toBe('memo')
    for (const target of Object.values(BUNDLED_PLUGIN_REPLACEMENTS)) expect(isBundledPlugin(target)).toBe(true)
    // 被合并的旧插件 id 自身不能也是内置插件，否则两个都会显示
    for (const legacy of Object.keys(BUNDLED_PLUGIN_REPLACEMENTS)) expect(isBundledPlugin(legacy)).toBe(false)
  })

  it('[破坏性] 不在映射里的 id、空值、原型链属性原样返回，不会被误导到别的插件', () => {
    expect(resolveBundledReplacement('json-format')).toBe('json-format')
    expect(resolveBundledReplacement('')).toBe('')
    expect(resolveBundledReplacement(null)).toBe('')
    expect(resolveBundledReplacement(undefined)).toBe('')
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(resolveBundledReplacement(key)).toBe(key)
      expect(resolveBundledReplacementFeature(key)).toBe('')
    }
  })

  it('[集成] 旧插件重定向自动携带对应的默认子命令 featureCode，且显式传入的 featureCode 优先', () => {
    expect(resolveBundledReplacement('dictionary')).toBe('translator')
    expect(resolveBundledReplacementFeature('dictionary')).toBe('translate-dict')
    expect(resolveBundledReplacementFeature('dictionary', 'translate-business')).toBe('translate-business')
    expect(resolveBundledReplacement('batch-text-convert')).toBe('crypto-tool')
    expect(resolveBundledReplacementFeature('batch-text-convert')).toBe('codec-base64')
    expect(resolveBundledReplacement('chinese-number-converter')).toBe('calculator')
    expect(resolveBundledReplacementFeature('chinese-number-converter')).toBe('calc-rmb')
    expect(resolveBundledReplacement('world-clock')).toBe('timestamp')
    expect(resolveBundledReplacementFeature('world-clock')).toBe('tz-world')
  })

  it('[集成 + Beyond Happy Path] 子命令 featureCode 深链直达预设状态，且未知 featureCode 安全回退默认态不崩溃', async () => {
    vi.stubGlobal('fetch', async (url) => {
      const match = String(url).match(/bundled-plugins\/([^?#]+)$/)
      if (!match) return { ok: false, status: 404, text: async () => 'Not Found' }
      const rel = match[1].split('/').map(decodeURIComponent).join('/')
      const diskPath = path.join(process.cwd(), 'public/bundled-plugins', rel)
      if (!fs.existsSync(diskPath)) {
        return { ok: false, status: 404, text: async () => 'Not Found' }
      }
      const content = fs.readFileSync(diskPath, 'utf8')
      return { ok: true, status: 200, text: async () => content }
    })
    try {
      // 1. batch-image 带 preset-to-jpg 启动：首屏自动切到「转 JPG」预设
      const toJpgLoaded = await loadInstalledDeclarativePlugin('batch-image', {
        featureCode: 'preset-to-jpg'
      })
      expect(toJpgLoaded.featureCode).toBe('preset-to-jpg')
      expect(toJpgLoaded.title).toBe('PNG/WebP/BMP 批量转 JPG')
      const toJpgTree = toJpgLoaded.command()
      expect(toJpgTree.props.searchBarAccessory.props.value).toBe('preset-to-jpg')

      // 2. batch-image 传入未知/过期 featureCode：安全回退默认预设 preset-smart-lossless，不抛异常
      const unknownLoaded = await loadInstalledDeclarativePlugin('batch-image', {
        featureCode: 'non-existent-feature-999'
      })
      const fallbackTree = unknownLoaded.command()
      expect(fallbackTree.props.searchBarAccessory.props.value).toBe('preset-smart-lossless')

      // 2b. batch-image 带 preset-gov-limit 启动：自动映射并选中 preset-extreme-300k
      const govLoaded = await loadInstalledDeclarativePlugin('batch-image', {
        featureCode: 'preset-gov-limit'
      })
      expect(govLoaded.command().props.searchBarAccessory.props.value).toBe('preset-extreme-300k')

      // 3. invoice-assistant 带 invoice-travel 启动：自动切到「交通出行」过滤分组，右侧列表仅展示交通出行票据
      const travelLoaded = await loadInstalledDeclarativePlugin('invoice-assistant', {
        featureCode: 'invoice-travel'
      })
      const travelTree = travelLoaded.command()
      // 不在客户端里运行时不再显示示例发票，列表可以为空；有内容时只能是交通出行票据
      expect(
        travelTree.props.subList.items.every((item) =>
          JSON.stringify(item).includes('交通出行') || JSON.stringify(item).includes('滴滴') || JSON.stringify(item).includes('铁路')
        )
      ).toBe(true)

      // 4. translator 带 translate-naming 启动：深链能加载并保留子命令
      const namingLoaded = await loadInstalledDeclarativePlugin('translator', {
        featureCode: 'translate-naming'
      })
      expect(namingLoaded.featureCode).toBe('translate-naming')
      expect(() => namingLoaded.command()).not.toThrow()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

