import { describe, it, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import {
  normalizeCatalogScreenshots,
  normalizeCatalogI18nScreenshots,
  isSafeCatalogScreenshotUrl,
  MAX_PLUGIN_SCREENSHOTS
} from '@/utils/pluginScreenshots'
import { getBundledPluginScreenshots, normalizeBundledPluginI18n } from '@/utils/bundledPlugins'
import { getLocalizedPluginScreenshots } from '@/utils/pluginI18n'
import { StoreCatalogManager } from '@/utils/storeCatalogManager'
import { getCurrentLocale, setI18nLocale } from '@/i18n'
import PluginScreenshots from '@/pages/details-components/PluginScreenshots.vue'

const CDN = 'https://cdn.ztools.cn/plugins-v2/official/demo/screenshots/1.0.1'
const shot = (n, extra = {}) => ({ url: `${CDN}/0${n}-abcdef12.png`, title: `界面 ${n}`, width: 1280, height: 800, ...extra })

describe('插件市场目录条目的截图', () => {
  it('合法条目原样保留 url / title / 宽高', () => {
    expect(normalizeCatalogScreenshots([shot(1)])).toEqual([shot(1)])
  })

  it('不合法的地址被丢弃：http、javascript:、data:、file:、相对路径、带引号或空白', () => {
    const bad = [
      'http://cdn.ztools.cn/a.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'file:///etc/passwd',
      'screenshots/01.png',
      '//cdn.ztools.cn/a.png',
      'https://cdn.ztools.cn/a".png',
      'https://cdn.ztools.cn/a b.png',
      '',
      null
    ]
    for (const url of bad) expect(isSafeCatalogScreenshotUrl(url)).toBe(false)
    expect(normalizeCatalogScreenshots(bad.map((url) => ({ url, title: 'x' })))).toEqual([])
  })

  it('格式不对的条目丢弃，宽高非法时置空，最多保留 5 张', () => {
    const list = normalizeCatalogScreenshots([null, 'https://cdn.ztools.cn/a.png', { title: '没有地址' }, shot(1, { width: -1, height: '800', title: 3 }), ...[2, 3, 4, 5, 6, 7].map((n) => shot(n))])
    expect(list).toHaveLength(MAX_PLUGIN_SCREENSHOTS)
    expect(list[0]).toEqual({ url: shot(1).url, title: '', width: undefined, height: 800 })
    expect(normalizeCatalogScreenshots(undefined)).toEqual([])
    expect(normalizeCatalogScreenshots('https://cdn.ztools.cn/a.png')).toEqual([])
  })

  it('目录同步：市场插件带上整理后的截图；与内置插件同 ID 时只用内置副本，不用网络地址', async () => {
    const localShots = [{ url: 'http://localhost/bundled-plugins/memo/screenshots/01.png', title: '本地' }]
    const manager = new StoreCatalogManager({
      apiBaseUrl: '',
      fetchRemote: async () => ({
        plugins: [
          { id: 'demo', name: '示例', version: '1.0.1', screenshots: [shot(1), { url: 'javascript:alert(1)', title: '坏的' }] },
          { id: 'memo', name: '备忘录', version: '9.9.9', screenshots: [shot(2)] },
          { id: 'plain', name: '无截图', version: '1.0.0' }
        ]
      }),
      getOfficialList: () => [{ id: 'memo', pluginId: 'memo', name: '备忘录', isBuiltin: true, screenshots: localShots }, { id: 'todo', pluginId: 'todo', name: '待办', isBuiltin: true }]
    })
    const { catalog } = await manager.ensureCatalog(true)
    const byId = Object.fromEntries(catalog.map((p) => [p.pluginId, p]))
    expect(byId.demo.screenshots).toEqual([shot(1)])
    expect(byId.memo.screenshots).toEqual(localShots)
    expect(byId.plain.screenshots).toEqual([])
    // 内置插件没有截图：不显示，也不从目录里拿
    expect(byId.todo.screenshots).toBeUndefined()
    expect((await manager.getDetails('demo')).screenshots).toEqual([shot(1)])
  })
})

describe('内置插件截图', () => {
  it('从随客户端分发的 bundled-plugins/<id>/ 读取，不合法路径丢弃', () => {
    const list = getBundledPluginScreenshots({
      id: 'memo',
      screenshots: [
        { path: 'screenshots/01.png', title: '主界面', width: 1280, height: 800 },
        { path: '../secret.png' },
        { path: 'screenshots/02.jpg' },
        { path: '/abs/screenshots/03.png' },
        { path: 'https://evil.example/screenshots/04.png' }
      ]
    })
    expect(list).toHaveLength(1)
    expect(list[0].url).toMatch(/bundled-plugins\/memo\/screenshots\/01\.png$/)
    expect(list[0].url.startsWith('https://')).toBe(false)
    expect(list[0]).toMatchObject({ title: '主界面', width: 1280, height: 800 })
    expect(getBundledPluginScreenshots({ id: 'memo' })).toEqual([])
  })

  it('normalizeBundledPluginI18n 将 i18n[locale].screenshots[].file 归一化为本地静态资源 URL 并过滤非法路径', () => {
    const normalized = normalizeBundledPluginI18n({
      id: 'memo',
      i18n: {
        'en-US': {
          name: 'Memo',
          screenshots: [
            { file: 'screenshots/en-US/01.png', title: 'Main View', width: 1280, height: 800 },
            { file: '../leak.png', title: 'Evil' },
            { file: 'https://cdn.example.com/en.png', title: 'Remote' }
          ]
        },
        'zh-CN': {
          name: '备忘录',
          screenshots: [{ file: '../invalid.png' }]
        },
        __proto__: { polluted: true }
      }
    })
    expect(normalized['en-US'].name).toBe('Memo')
    expect(normalized['en-US'].screenshots).toHaveLength(1)
    expect(normalized['en-US'].screenshots[0].url).toMatch(/bundled-plugins\/memo\/screenshots\/en-US\/01\.png$/)
    expect(normalized['en-US'].screenshots[0]).toMatchObject({ title: 'Main View', width: 1280, height: 800 })
    // 全部非法时删除 screenshots 键，避免裸 file 泄漏
    expect(normalized['zh-CN'].screenshots).toBeUndefined()
    expect(({}).polluted).toBeUndefined()
  })
})

describe('多语言截图消费与市场目录归一化', () => {
  const originalLocale = getCurrentLocale()

  afterEach(() => {
    setI18nLocale(originalLocale)
  })

  it('getLocalizedPluginScreenshots 按生效 locale 返回对应截图，兼容未归一化键且防第三语种误判', () => {
    const zhShots = [{ url: `${CDN}/01-zh.png`, title: '中文主界面' }]
    const enShots = [{ url: `${CDN}/01-en.png`, title: 'English Main View' }]
    const plugin = {
      id: 'demo',
      screenshots: zhShots,
      i18n: {
        'en-US': { screenshots: enShots }
      }
    }

    setI18nLocale('en-US')
    expect(getLocalizedPluginScreenshots(plugin)).toEqual(enShots)

    setI18nLocale('zh-CN')
    expect(getLocalizedPluginScreenshots(plugin)).toEqual(zhShots)

    // 兼容未归一化语种键（如 en / zh_Hans），且不误把 ja-JP 当 en-US
    const aliasPlugin = {
      id: 'alias-demo',
      screenshots: zhShots,
      i18n: {
        'ja-JP': { screenshots: [{ url: `${CDN}/01-ja.png`, title: '日本語' }] },
        en: { screenshots: enShots }
      }
    }
    expect(getLocalizedPluginScreenshots(aliasPlugin, 'en-US')).toEqual(enShots)

    const thirdLocaleOnly = {
      id: 'third-only',
      screenshots: zhShots,
      i18n: {
        'ja-JP': { screenshots: [{ url: `${CDN}/01-ja.png`, title: '日本語' }] }
      }
    }
    expect(getLocalizedPluginScreenshots(thirdLocaleOnly, 'en-US')).toEqual(zhShots)

    // 当前语种截图无效或为空时回退顶层 screenshots；无顶层时返回 []
    expect(
      getLocalizedPluginScreenshots(
        { id: 'bad', screenshots: zhShots, i18n: { 'en-US': { screenshots: [{ file: 'screenshots/en-US/01.png' }] } } },
        'en-US'
      )
    ).toEqual(zhShots)
    expect(getLocalizedPluginScreenshots(null, 'en-US')).toEqual([])
  })

  it('StoreCatalogManager 归一化市场目录 i18n[locale].screenshots（含可信基准相对路径兜底），且内置插件不混入远程图', async () => {
    const localEnShots = [{ url: 'http://localhost/bundled-plugins/memo/screenshots/en-US/01.png', title: 'Local EN' }]
    const remoteEnShot = { url: `${CDN}/en-US/01-abcdef12.png`, title: 'Remote EN', width: 1280, height: 800 }

    const manager = new StoreCatalogManager({
      apiBaseUrl: '',
      fetchRemote: async () => ({
        plugins: [
          {
            id: 'demo',
            name: '示例',
            version: '1.0.1',
            icon: 'https://cdn.ztools.cn/plugins-v2/official/demo/icon.svg',
            screenshots: [shot(1)],
            i18n: {
              'en-US': {
                name: 'Demo',
                screenshots: [
                  remoteEnShot,
                  { file: 'screenshots/en-US/02.png', title: 'Relative EN' },
                  { file: '../secret.png', title: 'Bad Traversal' },
                  { url: 'javascript:alert(1)', title: 'Bad Proto' }
                ]
              }
            }
          },
          {
            id: 'memo',
            name: '备忘录',
            version: '1.0.0',
            screenshots: [shot(2)],
            i18n: {
              'en-US': {
                name: 'Remote Memo',
                screenshots: [remoteEnShot]
              }
            }
          },
          {
            id: 'todo',
            name: '待办',
            version: '1.0.0',
            i18n: {
              'en-US': {
                name: 'Remote Todo',
                screenshots: [remoteEnShot]
              }
            }
          }
        ]
      }),
      getOfficialList: () => [
        {
          id: 'memo',
          pluginId: 'memo',
          name: '备忘录',
          isBuiltin: true,
          screenshots: [{ url: 'http://localhost/bundled-plugins/memo/screenshots/01.png', title: '本地' }],
          i18n: { 'en-US': { name: 'Memo', screenshots: localEnShots } }
        },
        {
          id: 'todo',
          pluginId: 'todo',
          name: '待办',
          isBuiltin: true,
          screenshots: [],
          i18n: { 'en-US': { name: 'Todo' } }
        }
      ]
    })

    const { catalog } = await manager.ensureCatalog(true)
    const byId = Object.fromEntries(catalog.map((p) => [p.pluginId, p]))

    // 市场插件：保留 https 截图并将合法相对路径基于可信 https 目录解析为 https URL，丢弃非法项
    expect(byId.demo.i18n['en-US'].screenshots).toEqual([
      remoteEnShot,
      {
        url: 'https://cdn.ztools.cn/plugins-v2/official/demo/screenshots/en-US/02.png',
        title: 'Relative EN',
        width: undefined,
        height: undefined
      }
    ])

    // 内置插件 memo：仅使用本地多语言截图副本
    expect(byId.memo.i18n['en-US'].screenshots).toEqual(localEnShots)
    // 内置插件 todo：本地无多语言截图时，绝不混入远程网络截图
    expect(byId.todo.i18n['en-US'].screenshots).toBeUndefined()

    // 无可信 https 基准时，裸相对路径被剔除
    expect(
      normalizeCatalogI18nScreenshots({
        'en-US': { name: 'Raw', screenshots: [{ file: 'screenshots/en-US/01.png', title: 'Local' }] }
      })
    ).toEqual({ 'en-US': { name: 'Raw' } })
  })
})

describe('详情页截图区', () => {
  it('有截图时按顺序显示图片与说明，并带上宽高', () => {
    const wrapper = mount(PluginScreenshots, { props: { screenshots: [shot(1), shot(2, { title: '' })] } })
    const imgs = wrapper.findAll('.screenshot-image')
    expect(imgs).toHaveLength(2)
    expect(imgs[0].attributes('src')).toBe(shot(1).url)
    expect(imgs[0].attributes('width')).toBe('1280')
    expect(imgs[0].attributes('height')).toBe('800')
    expect(wrapper.findAll('.screenshot-title').map((n) => n.text())).toEqual(['界面 1'])
    expect(imgs[1].attributes('alt')).toBe('截图 2')
  })

  it('没有截图时整个区块不渲染', () => {
    expect(mount(PluginScreenshots, { props: { screenshots: [] } }).find('.screenshots-section').exists()).toBe(false)
  })
})
