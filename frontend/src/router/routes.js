/**
 * 路由常量配置
 * 统一管理路由名称，避免硬编码
 */

export const ROUTES = {
  // 主要页面
  HOME: { name: 'my' },
  LIST: { name: 'list' },
  DETAILS: { name: 'details' },

  // 功能页面（登录、个人中心、反馈建议属于官方版，路由名由 @edition 提供）
  DIAGNOSTICS: { name: 'diagnostics' },
  EVENTS: { name: 'events' },
  ADVANCED_SETTINGS: { name: 'advanced-settings' },
  ABOUT: { name: 'about' },
  DEVTOOLS: { name: 'devtools' },
  DECLARATIVE: { name: 'declarative' },
  POPOUT: { name: 'popout' }
}

/**
 * 路由工具函数
 */
export const routeUtils = {
  // 跳转到声明式应用页（支持携带状态快照与 feature 子命令查询参数）
  toDeclarative: (pluginId, query = {}) => ({
    ...ROUTES.DECLARATIVE,
    params: { pluginId },
    ...(query && Object.keys(query).length > 0 ? { query } : {})
  }),

  // 跳转到独立窗口声明式应用页
  toPopout: (pluginId, query = {}) => ({
    ...ROUTES.POPOUT,
    params: { pluginId },
    query
  }),

  // 跳转到列表页并搜索
  toListWithSearch: (query) => ({
    ...ROUTES.LIST,
    query: { q: query }
  }),

  // 跳转到插件详情
  toPluginDetails: (pluginId) => ({
    ...ROUTES.DETAILS,
    params: { pluginId }
  }),

  // 跳转到分类列表
  toListCategory: (category) => ({
    ...ROUTES.LIST,
    params: { category }
  })
}

