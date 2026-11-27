import { afterEach, describe, expect, it } from 'vitest'
import {
  isDevAllowedDraftPlugin,
  isDevLocalPlugin,
  isPluginVisible,
  setDevAllowedDraftPluginIds,
  setDevLocalPluginIds
} from '../pluginVisibility.js'

const SEVEN_DRAFT_PLUGINS = [
  'ai-image',
  'ai-video',
  'batch-video',
  'data-recovery',
  'multi-download',
  'pdf',
  'wechat-multi'
]

describe('dev 模式草稿插件可见性与本地覆盖标记', () => {
  afterEach(() => {
    setDevAllowedDraftPluginIds([])
    setDevLocalPluginIds([])
  })

  it('默认（生产态）全部 7 款草稿插件均保持隐藏，且不可信对象伪造字段无法绕过', () => {
    for (const id of SEVEN_DRAFT_PLUGINS) {
      expect(isDevAllowedDraftPlugin(id)).toBe(false)
      expect(isDevAllowedDraftPlugin({ pluginId: id, devDraftAllowed: true })).toBe(false)
      expect(isPluginVisible(id)).toBe(false)
      expect(isPluginVisible({ pluginId: id, devDraftAllowed: true })).toBe(false)
    }
  })

  it('dev 模式由宿主登记 devDraftAllowed 后，全部 7 款草稿插件放行可见，且已下架 revoked 仍被拦截', () => {
    setDevAllowedDraftPluginIds(SEVEN_DRAFT_PLUGINS)
    for (const id of SEVEN_DRAFT_PLUGINS) {
      expect(isDevAllowedDraftPlugin(id)).toBe(true)
      expect(isPluginVisible(id)).toBe(true)
    }
    // 显式携带 revoked=true 的对象不得放行
    expect(isDevAllowedDraftPlugin({ pluginId: 'pdf', revoked: true })).toBe(false)
    expect(isPluginVisible({ pluginId: 'hosts', devDraftAllowed: true, revoked: true })).toBe(false)
  })

  it('devLocalInstalled 仅采信宿主登记集合，拒绝不可信对象属性伪造', () => {
    expect(isDevLocalPlugin('calculator')).toBe(false)
    expect(isDevLocalPlugin({ pluginId: 'calculator', devLocalInstalled: true })).toBe(false)
    setDevLocalPluginIds(['calculator', 'json-format'])
    expect(isDevLocalPlugin('calculator')).toBe(true)
    expect(isDevLocalPlugin({ pluginId: 'json-format' })).toBe(true)
    expect(isDevLocalPlugin({ pluginId: 'json-format', revoked: true })).toBe(false)
  })
})
