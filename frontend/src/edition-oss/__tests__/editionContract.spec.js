/**
 * @edition 接口契约：开源版与官方版必须导出同一套名字与类型，公共代码才能无差别使用。
 * 开源版直接导入本目录校验；当前构建实际使用的版本经 @edition 别名动态加载（带有官方版扩展时是官方版，开源仓库是开源版），
 * 两边用同一套断言比对。公共代码不能直接写闭源组件目录的路径（开源导出会拦截），所以这里也只通过别名加载。
 */
import { describe, it, expect, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import * as oss from '../index.js'

const EXPECTED_EXPORTS = {
  EDITION: 'string',
  isOnline: 'boolean',
  rootRoutes: 'array',
  layoutRoutes: 'array',
  preloadRouteLoaders: 'array',
  headerExtraComponents: 'array',
  layoutExtraComponents: 'array',
  feedbackEntry: 'object',
  useFeedbackIndicator: 'function',
  pluginDetailTabs: 'array',
  auth: 'object',
  useUserStore: 'function',
  onAuthRequired: 'function',
  track: 'function',
  setTrackingWebVersion: 'function',
  onAppStart: 'function',
  cloudSync: 'object',
  marketBackend: 'object|null'
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function assertContract(mod) {
  expect(Object.keys(mod).sort()).toEqual(Object.keys(EXPECTED_EXPORTS).sort())
  for (const [name, expected] of Object.entries(EXPECTED_EXPORTS)) {
    expect(expected.split('|'), `${name} 的类型`).toContain(typeOf(mod[name]))
  }
  // 反馈入口二选一：要么站内路由，要么外部链接
  const entry = mod.feedbackEntry
  expect(typeof entry.title).toBe('string')
  expect(Boolean(entry.routeName) !== Boolean(entry.externalUrl)).toBe(true)
  expect(typeof mod.auth.isAuthenticated).toBe('function')
  expect(typeof mod.auth.ensureCanInstall).toBe('function')
  // 云同步：公共代码直接调用，两边都必须提供同样的方法
  expect(typeof mod.cloudSync.enabled).toBe('boolean')
  for (const name of ['pullFavorites', 'pullHomeLayout', 'push']) {
    expect(typeof mod.cloudSync[name], `cloudSync.${name}`).toBe('function')
  }
  for (const tab of mod.pluginDetailTabs) {
    expect(typeof tab.key).toBe('string')
    expect(typeof tab.label).toBe('string')
    expect(typeof tab.props).toBe('function')
    expect(tab.component).toBeTruthy()
  }
  // 附加路由与组件都是只读列表，公共代码不能改动版本提供的内容
  for (const name of ['rootRoutes', 'layoutRoutes', 'preloadRouteLoaders', 'headerExtraComponents', 'layoutExtraComponents', 'pluginDetailTabs']) {
    expect(Object.isFrozen(mod[name]), `${name} 只读`).toBe(true)
  }
  // 市场后台要么没有，要么提供公共插件市场与更新入口转交的全部方法
  if (mod.marketBackend) {
    for (const name of ['getCategories', 'getMarketPlugins', 'getPluginDetails', 'getDownloadSign', 'checkPluginUpdate', 'batchCheckPlugins']) {
      expect(typeof mod.marketBackend[name], `marketBackend.${name}`).toBe('function')
    }
  }
}

describe('@edition 接口契约', () => {
  it('开源版导出完整，且默认离线：不提供后台、云同步、附加页面与附加 Tab', async () => {
    assertContract(oss)
    expect(oss.EDITION).toBe('oss')
    expect(oss.isOnline).toBe(false)
    expect(oss.marketBackend).toBe(null)
    expect(oss.cloudSync.enabled).toBe(false)
    expect(oss.rootRoutes).toHaveLength(0)
    expect(oss.layoutRoutes).toHaveLength(0)
    expect(oss.pluginDetailTabs).toHaveLength(0)
    expect(oss.headerExtraComponents).toHaveLength(0)
    expect(oss.layoutExtraComponents).toHaveLength(0)
    expect(await oss.auth.isAuthenticated()).toBe(false)
    expect(await oss.auth.ensureCanInstall()).toBe(true)
    expect(oss.onAppStart()).toBeUndefined()
    expect(oss.feedbackEntry.externalUrl).toBe('https://github.com/ZToolsTeam/ZTools/issues')
    expect(oss.useFeedbackIndicator().hasUnread.value).toBe(false)
  })

  it('[故障] 开源版的登录、统计与云同步钩子全部为空操作：不碰 window.ztools，不抛错', async () => {
    const report = vi.fn()
    const setWebVersion = vi.fn()
    const isLoggedIn = vi.fn().mockResolvedValue(true)
    window.ztools = { analytics: { report, setWebVersion }, user: { isLoggedIn } }
    try {
      // 需要登录的错误也不处理，交给调用方按普通错误提示
      for (const err of [{ status: 401 }, { need_login: true }, new Error('x'), null, undefined]) {
        expect(oss.onAuthRequired(err)).toBe(false)
        expect(oss.onAuthRequired(err, { message: 'm', level: 'error' })).toBe(false)
      }
      expect(oss.track('page_view', '', { page: 'x' })).toBeUndefined()
      expect(oss.setTrackingWebVersion('1.0.0')).toBeUndefined()

      const pluginsStore = { replaceFavorites: vi.fn(), pushToCloud: vi.fn(), installedPlugins: [], favorites: new Set() }
      await expect(oss.cloudSync.pullFavorites(pluginsStore)).resolves.toBeUndefined()
      await expect(oss.cloudSync.pullHomeLayout({ pluginsStore })).resolves.toBeUndefined()
      await expect(oss.cloudSync.push({ favorites: ['a'] })).resolves.toBeUndefined()

      expect(report).not.toHaveBeenCalled()
      expect(setWebVersion).not.toHaveBeenCalled()
      expect(isLoggedIn).not.toHaveBeenCalled()
      expect(pluginsStore.replaceFavorites).not.toHaveBeenCalled()
      expect(pluginsStore.pushToCloud).not.toHaveBeenCalled()
    } finally {
      delete window.ztools
    }
  })

  it('开源版用户状态始终未登录，外部强行写入登录态也不生效', async () => {
    setActivePinia(createPinia())
    const store = oss.useUserStore()
    expect(store.isLoggedIn).toBe(false)
    expect(store.isGuest).toBe(true)
    store.setLoginStatus(true, { id: 1, nickname: 'x' })
    expect(store.isLoggedIn).toBe(false)
    expect(store.userInfo).toBe(null)
    await store.checkLoginStatus()
    expect(store.isCheckingAuth).toBe(false)
    // 成对的监听方法可重复调用，不抛错
    store.initEventListeners()
    store.initEventListeners()
    store.cleanupEventListeners()
    store.cleanupEventListeners()
    await expect(store.logout()).resolves.toBeUndefined()
  })

  it('当前构建使用的版本（@edition）与开源版导出同一套接口', async () => {
    // 动态加载：官方版入口只在这条用例里加载，不影响上面只测开源版的用例
    const current = await import('@edition')
    assertContract(current)
    expect(['oss', 'commercial']).toContain(current.EDITION)
    expect(Object.keys(current).sort()).toEqual(Object.keys(oss).sort())
  })
})
