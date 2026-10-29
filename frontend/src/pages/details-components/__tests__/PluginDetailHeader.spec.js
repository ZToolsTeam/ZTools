import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'

import PluginDetailHeader from '../PluginDetailHeader.vue'
import { formatBytes } from '@/utils/formatBytes'

const t = (platform) => ({ id: `${platform}-electron-any`, platform, runtime: 'electron', arch: 'any' })
const mountHeader = (plugin, props = {}) =>
  mount(PluginDetailHeader, { props: { plugin, ...props }, global: { stubs: { PluginActions: true, RcSquircle: true } } })
const metaTexts = (wrapper) => wrapper.findAll('.plugin-meta li').map((li) => li.text())

describe('插件详情头部元信息', () => {
  it('内置插件：开发者 · 版本 · 分类 · 大小 · 随客户端内置，平台用两个系统标志', () => {
    const wrapper = mountHeader({
      pluginId: 'memo', name: '便签', author: 'ZTools Team', version: '1.0.7', category: '办公效率',
      size: 31595, builtin: true, targets: [t('windows'), t('macos')]
    })
    expect(metaTexts(wrapper).slice(0, 5)).toEqual(['ZTools Team', 'v1.0.7', '办公效率', '31 KB', '随客户端内置'])
    const logos = wrapper.find('.meta-platform .platform-logos')
    expect(logos.attributes('aria-label')).toBe('支持 Windows 和 macOS')
    expect(logos.findAll('svg')).toHaveLength(2)
    // 不再出现重复的分类标签、「已安装」标签、统计卡片与「跨平台」文字
    expect(wrapper.find('.plugin-tags').exists()).toBe(false)
    expect(wrapper.find('.stats-grid').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/已安装|跨平台|未知|N\/A/)
  })

  it('缺少的数据直接不显示，不编造「未知」或默认满分', () => {
    const wrapper = mountHeader({ pluginId: 'x', name: 'X', version: '1.0.0', rating: 0, downloads: 0 })
    expect(metaTexts(wrapper)).toEqual(['v1.0.0'])
    expect(wrapper.find('.meta-rating').exists()).toBe(false)
    expect(wrapper.find('.meta-platform').exists()).toBe(false)
  })

  it('市场插件：显示安装包大小、安装次数；插件目录里的旧 rating 字段不再当作评分显示', () => {
    const wrapper = mountHeader({
      pluginId: 'y', name: 'Y', version: '2.1.0', size: 3 * 1024 * 1024, downloads: 12345, rating: 4.56, targets: [t('macos')]
    })
    const texts = metaTexts(wrapper)
    expect(texts).toContain('3.0 MB')
    expect(texts).toContain('12,345 次安装')
    expect(wrapper.find('.meta-rating').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('4.6')
    expect(wrapper.find('.platform-logos').attributes('aria-label')).toBe('仅支持 macOS')
  })

  it('真实评分汇总：人数足够显示「4.6（23 人评分）」，人数不足显示「评分人数不足」，没有汇总不显示', () => {
    const plugin = { pluginId: 'y', name: 'Y', version: '2.1.0' }
    const rated = mountHeader(plugin, { ratingSummary: { average: 4.56, count: 23 } })
    expect(rated.find('.meta-rating').text()).toBe('4.6（23 人评分）')
    expect(rated.find('.meta-rating .meta-star').exists()).toBe(true)

    for (const summary of [{ average: null, count: 2 }, { average: null, count: 0 }]) {
      const few = mountHeader(plugin, { ratingSummary: summary })
      expect(few.find('.meta-rating').text()).toBe('评分人数不足')
      expect(few.find('.meta-rating .meta-star').exists()).toBe(false)
    }

    // 畸形数据不编造分数
    for (const summary of [{ average: 'x', count: 3 }, { average: 9, count: 3 }, { average: -1, count: 3 }]) {
      expect(mountHeader(plugin, { ratingSummary: summary }).find('.meta-rating').text()).toBe('评分人数不足')
    }
    expect(mountHeader(plugin, { ratingSummary: null }).find('.meta-rating').exists()).toBe(false)
    expect(mountHeader(plugin).find('.meta-rating').exists()).toBe(false)
  })

  it('只显示需要留意的状态：已下架、有新版本、需升级客户端', () => {
    expect(mountHeader({ pluginId: 'a', name: 'A' }, { isRevoked: true }).find('.status-tag.tone-error').text()).toBe('已下架')
    expect(mountHeader({ pluginId: 'a', name: 'A' }, { hasUpdate: true }).find('.status-tag.tone-accent').text()).toBe('有新版本')
    expect(mountHeader({ pluginId: 'a', name: 'A' }, { updateInfo: { incompatible: true } }).find('.status-tag.tone-warning').text()).toBe('需升级客户端')
    expect(mountHeader({ pluginId: 'a', name: 'A' }, { isInstalled: true }).find('.status-tag').exists()).toBe(false)
  })
})

describe('formatBytes', () => {
  it.each([
    [512, '512 B'], [31595, '31 KB'], [3 * 1024 * 1024, '3.0 MB'], ['2048', '2 KB'], ['1.2 MB', '1.2 MB'],
    [0, ''], [-1, ''], [NaN, ''], [null, ''], [undefined, ''], ['', '']
  ])('%s → %s', (input, expected) => {
    expect(formatBytes(input)).toBe(expected)
  })
})
