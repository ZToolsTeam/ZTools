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
  getBundledPluginEntries
} from '@/utils/bundledPlugins'
import { isPluginVisible } from '@/utils/pluginVisibility'
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
  it('内置插件清单与 public/bundled-plugins 一致，每个插件的入口文件都存在', () => {
    const entries = getBundledPluginEntries()
    expect(entries.map((e) => e.pluginId).sort()).toEqual([...BUNDLED_PLUGIN_IDS].sort())
    for (const id of BUNDLED_PLUGIN_IDS) {
      expect(fs.existsSync(path.join(process.cwd(), 'public/bundled-plugins', id, 'dist/index.js'))).toBe(true)
    }
    // 每次返回新数组，调用方修改不会污染清单
    entries[0].name = '被改掉'
    expect(getBundledPluginEntries()[0].name).not.toBe('被改掉')
  })

  it('可见性：内置插件可见；旧内置实现、未完成官方插件、官方作者的其他插件隐藏；社区插件可见', () => {
    for (const id of BUNDLED_PLUGIN_IDS) expect(isPluginVisible(id)).toBe(true)
    expect(isPluginVisible({ pluginId: 'JSON-FORMAT' })).toBe(true)
    for (const id of ['kill-process', 'clipboard-history', 'screen-color-picker', 'cleaner', 'wechat-multi']) {
      expect(isPluginVisible(id)).toBe(false)
    }
    for (const id of bundledConfig.unreleasedOfficialIds) expect(isPluginVisible(id)).toBe(false)
    expect(isPluginVisible({ pluginId: 'new-official-thing', author: 'ZTools Team' })).toBe(false)
    expect(isPluginVisible({ pluginId: 'community-tool', author: 'Indie Dev' })).toBe(true)
    for (const bad of [null, undefined, '', '   ', {}]) expect(isPluginVisible(bad)).toBe(false)
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
