/**
 * 插件缓存作用域：加载器经宿主专用入口 @ztools/declarative-ui/host 为每个插件分配独立的 Cache 作用域
 *
 * - 插件 require('@ztools/declarative-ui') 拿不到 createCacheScope（宿主专用，不属于插件 SDK）；
 * - 两个插件用同一 namespace、同一 key 读写互不可见；同一插件重新加载后仍沿用自己的作用域；
 * - 对抗：插件直接 require 宿主专用入口会被沙箱拦截。
 */
import { describe, it, expect } from 'vitest'
import * as SDK from '@ztools/declarative-ui'
import { createCacheScope } from '@ztools/declarative-ui/host'
import { loadInstalledDeclarativePlugin } from '../declarativePluginLoader.js'

function pluginFiles(id, source) {
  return async (_pluginId, relPath) => {
    if (relPath === 'plugin.json') return JSON.stringify({ id, name: id, entry: 'dist/index.js', permissions: [] })
    if (relPath === 'dist/index.js') return source
    throw Object.assign(new Error(`missing ${relPath}`), { code: 'PLUGIN_RESOURCE_NOT_FOUND' })
  }
}

// 插件代码：默认导出的命令返回它从 SDK 看到的内容，并在共享 namespace 里写入/读取缓存
const PROBE_SOURCE = `
  const sdk = require('@ztools/declarative-ui')
  exports.default = function Probe(value) {
    const cache = new sdk.Cache({ namespace: 'shared' })
    const before = cache.get('token')
    if (value) cache.set('token', value)
    return { hasFactory: 'createCacheScope' in sdk, before, after: cache.get('token') }
  }
`

async function loadProbe(id, options = {}) {
  return loadInstalledDeclarativePlugin(id, { readFile: pluginFiles(id, PROBE_SOURCE), ...options })
}

describe('插件缓存作用域（宿主专用入口）', () => {
  it('包入口不导出 createCacheScope，宿主入口提供它', () => {
    expect('createCacheScope' in SDK).toBe(false)
    expect(typeof createCacheScope).toBe('function')
  })

  it('插件 SDK 里没有 createCacheScope；两个插件同名 namespace、同名 key 互不可见', async () => {
    const a = await loadProbe('cache-probe-a')
    const b = await loadProbe('cache-probe-b')

    const first = a.command('secret-a')
    expect(first.hasFactory).toBe(false)
    expect(first.after).toBe('secret-a')

    const other = b.command()
    expect(other.before).toBeUndefined()

    b.command('secret-b')
    expect(a.command().after).toBe('secret-a')
  })

  it('同一插件强制重新加载后仍读到本次运行里自己写入的缓存', async () => {
    const first = await loadProbe('cache-probe-reload')
    first.command('kept')
    const reloaded = await loadProbe('cache-probe-reload', { forceReload: true })
    expect(reloaded.command().before).toBe('kept')
  })

  it('[对抗] 插件直接 require 宿主专用入口被沙箱拦截', async () => {
    await expect(
      loadInstalledDeclarativePlugin('cache-probe-attacker', {
        readFile: pluginFiles('cache-probe-attacker', `
          const host = require('@ztools/declarative-ui/host')
          exports.default = function Attack() { return host.createCacheScope() }
        `)
      })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED_MODULE_ACCESS' })
  })
})
