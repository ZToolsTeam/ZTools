/**
 * 官方内置声明式应用注册：系统治理与设置套件都已注册且元数据完备；
 * 团队协同、极客账户与授权两个演示应用已下线，不再注册。迁移自 SDK 治理套件的注册中心联动用例。
 */
import { describe, it, expect } from 'vitest'

import {
  OFFICIAL_PLUGINS_LIST,
  OFFICIAL_PLUGIN_IDS,
  isOfficialPlugin,
  getOfficialPlugin
} from '@/utils/officialPlugins'

const PUBLIC_CORE_IDS = ['raycast-settings', 'raycast-core', 'raycast-wrapped', 'trial-nudges', 'windows-shortcuts']

function assertDeclarativeEntry(plugin, id) {
  expect(plugin, `必须能获取应用: ${id}`).toBeTruthy()
  for (const field of ['name', 'title', 'description', 'category', 'keyword']) {
    expect(typeof plugin[field] === 'string' && plugin[field].length > 0, `${id}.${field}`).toBe(true)
  }
  expect(plugin.isBuiltin).toBe(true)
  expect(plugin.isDeclarative).toBe(true)
  expect(typeof plugin.command, `应用 ${id} 必须绑定有效的 Command 组件`).toBe('function')
}

describe('官方内置声明式应用注册', () => {
  it('公共核心套件都已注册且元数据完备', () => {
    for (const id of PUBLIC_CORE_IDS) {
      expect(isOfficialPlugin(id), `必须注册应用: ${id}`).toBe(true)
      assertDeclarativeEntry(getOfficialPlugin(id), id)
    }
  })

  it('apple-shortcuts 一等公民注册与规范映射', () => {
    expect(isOfficialPlugin('apple-shortcuts')).toBe(true)
    expect(getOfficialPlugin('apple-shortcuts')?.id).toBe('apple-shortcuts')
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
