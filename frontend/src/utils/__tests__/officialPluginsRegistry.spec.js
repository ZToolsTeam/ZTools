/**
 * 历史官方应用元数据注册表校验：
 * 客户端已彻底移除旧内置示例实现，仅保留纯元数据（不含 command）供可见性屏蔽与保留名校验；
 * 团队协同、极客账户与授权两个演示应用已下线，不再注册。
 */
import { describe, it, expect } from 'vitest'

import {
  OFFICIAL_PLUGINS_MAP,
  OFFICIAL_PLUGINS_LIST,
  OFFICIAL_PLUGIN_IDS,
  isOfficialPlugin,
  getOfficialPlugin,
  getOfficialPluginsList
} from '@/utils/officialPlugins'

const PUBLIC_CORE_IDS = ['raycast-settings', 'raycast-core', 'raycast-wrapped', 'trial-nudges', 'windows-shortcuts']

function assertMetadataOnlyEntry(plugin, id) {
  expect(plugin, `历史元数据表必须包含应用: ${id}`).toBeTruthy()
  for (const field of ['name', 'title', 'description', 'category', 'keyword']) {
    expect(typeof plugin[field] === 'string' && plugin[field].length > 0, `${id}.${field}`).toBe(true)
  }
  expect(plugin.isBuiltin).toBe(true)
  expect(plugin.isDeclarative).toBe(true)
  expect(plugin.command, `应用 ${id} 不得再绑定旧示例 Command 函数`).toBeUndefined()
}

describe('历史官方应用元数据注册表', () => {
  it('历史核心套件元数据完整，但不再绑定旧示例实现且 getOfficialPlugin/getOfficialPluginsList 返回空', () => {
    expect(getOfficialPluginsList()).toEqual([])
    for (const id of PUBLIC_CORE_IDS) {
      expect(isOfficialPlugin(id), `必须识别历史官方 ID: ${id}`).toBe(true)
      assertMetadataOnlyEntry(OFFICIAL_PLUGINS_MAP[id], id)
      expect(getOfficialPlugin(id), `不再返回旧示例实现: ${id}`).toBeUndefined()
    }
    for (const plugin of OFFICIAL_PLUGINS_LIST) {
      expect(plugin.command, `${plugin.pluginId} 不得包含 command 字段`).toBeUndefined()
    }
  })

  it('apple-shortcuts 元数据保留且不返回旧示例实现', () => {
    expect(isOfficialPlugin('apple-shortcuts')).toBe(true)
    expect(OFFICIAL_PLUGINS_MAP['apple-shortcuts']?.id).toBe('apple-shortcuts')
    expect(getOfficialPlugin('apple-shortcuts')).toBeUndefined()
  })

  it('已下线的团队协同与极客账户演示应用不再注册，「更新与版本公告」之后紧跟数据大盘', () => {
    const retired = /团队协同|商业协同|极客账户|Organizations|\(Account\)/
    for (const plugin of OFFICIAL_PLUGINS_LIST) {
      expect(retired.test(`${plugin.name} ${plugin.title}`), plugin.pluginId).toBe(false)
    }
    expect(Object.keys(OFFICIAL_PLUGIN_IDS).filter((key) => /ACCOUNT|ORGANIZATION/.test(key))).toEqual([])
    const order = OFFICIAL_PLUGINS_LIST.map((p) => p.pluginId)
    expect(order[order.indexOf('raycast-core') + 1]).toBe('raycast-wrapped')
  })

  it('非法输入不抛错', () => {
    for (const bad of [null, undefined, '', 42, {}, '  ', '__proto__', 'constructor']) {
      expect(isOfficialPlugin(bad)).toBe(false)
      expect(getOfficialPlugin(bad)).toBeUndefined()
    }
  })
})
