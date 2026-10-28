import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { OFFICIAL_PLUGINS_MAP, OFFICIAL_PLUGIN_ALIASES } from '../officialPlugins.js'
import { isPluginVisible } from '../pluginVisibility.js'
import { BUNDLED_PLUGIN_REPLACEMENTS } from '../bundledPlugins.js'
import bundledConfig from '../../config/bundledPlugins.json'

const RESERVED_FILE = path.resolve(__dirname, '../../../../packages/ztools-plugins-spec/reserved-ids.json')

// 官方插件标了草稿或下架时对所有人隐藏，原因是还没做完或已下线，不属于内置功能占用
const UNRELEASED = new Set((bundledConfig.unreleasedOfficialIds || []).map((s) => String(s).toLowerCase()))

function hiddenBuiltinIds() {
  // 已合并进内置插件的旧 ID（如 notes → memo）对所有作者隐藏并重定向，同样要占住名额
  const ids = [
    ...new Set([...Object.keys(OFFICIAL_PLUGINS_MAP), ...Object.keys(OFFICIAL_PLUGIN_ALIASES), ...Object.keys(BUNDLED_PLUGIN_REPLACEMENTS)])
  ].map((s) => s.toLowerCase())
  return ids.filter((id) => !UNRELEASED.has(id) && !isPluginVisible({ id, author: 'community-dev' }))
}

// 名单里可以多出已下线内置应用的 ID（如团队协同、极客账户演示）：继续保留名额防止社区插件抢注旧 ID，
// 但客户端已不再注册这些应用，所以它们不隐藏
function retiredReservedIds(recorded) {
  const hidden = new Set(hiddenBuiltinIds())
  return recorded.filter((id) => !hidden.has(id) && !UNRELEASED.has(id))
}

// 插件规范里的保留 ID 名单必须和客户端实际会隐藏的 ID 完全一致，否则社区插件会“通过校验却在客户端看不到”
describe('插件保留 ID 名单与客户端隐藏规则一致', () => {
  it('reserved-ids.json 包含客户端对普通作者隐藏的全部内置功能 ID，多出的只能是已下线应用', () => {
    const recorded = JSON.parse(fs.readFileSync(RESERVED_FILE, 'utf8')).ids
    const hidden = hiddenBuiltinIds()
    for (const id of hidden) expect(recorded, id).toContain(id)
    for (const id of retiredReservedIds(recorded)) {
      expect(Object.hasOwn(OFFICIAL_PLUGINS_MAP, id), `${id} 已下线，不应再注册`).toBe(false)
      expect(Object.hasOwn(OFFICIAL_PLUGIN_ALIASES, id), `${id} 已下线，不应再有别名`).toBe(false)
    }
    expect(recorded).toEqual([...new Set(recorded)].sort())
  })

  it('[破坏性] 名单里的每个 ID 都确实会被隐藏，名单外的普通 ID 不会', () => {
    const recorded = JSON.parse(fs.readFileSync(RESERVED_FILE, 'utf8')).ids
    const retired = new Set(retiredReservedIds(recorded))
    for (const id of recorded) {
      // 已下线应用的 ID 只保留名额，客户端不隐藏
      const expectHidden = !retired.has(id)
      expect(isPluginVisible({ id, author: 'community-dev' }), id).toBe(!expectHidden)
    }
    expect(isPluginVisible({ id: 'my-community-tool', author: 'community-dev' })).toBe(true)
    // 原型链上的名字不能被当成内置实现而误隐藏
    expect(isPluginVisible({ id: 'constructor', author: 'community-dev' })).toBe(true)
    expect(isPluginVisible({ id: '__proto__', author: 'community-dev' })).toBe(true)
  })
})
