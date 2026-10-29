import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { normalizeCatalogScreenshots, isSafeCatalogScreenshotUrl, MAX_PLUGIN_SCREENSHOTS } from '@/utils/pluginScreenshots'
import { getBundledPluginScreenshots } from '@/utils/bundledPlugins'
import { StoreCatalogManager } from '@/utils/storeCatalogManager'
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
