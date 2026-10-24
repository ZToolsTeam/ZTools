/**
 * 开源版能力入口（@edition 在开源仓库指向这里，见 vite.config.js / vitest.config.js）
 *
 * 公共代码只通过 @edition 使用与版本相关的能力。开源版默认离线：
 * 不连接任何官方后台，没有账号、端内反馈、插件留言评分、云同步与在线统计；
 * 插件市场、安装与更新只读取 CDN 静态插件目录（见 src/api/pluginCatalog.js）。
 * 官方发行版在同一套接口上提供这些在线能力。
 */
import { computed } from 'vue'

export { useUserStore } from './userStore.js'

/** 版本标识 */
export const EDITION = 'oss'

/** 是否连接官方在线服务 */
export const isOnline = false

/** 顶层附加路由（与主布局平级） */
export const rootRoutes = Object.freeze([])

/** 主布局内的附加子路由 */
export const layoutRoutes = Object.freeze([])

/** 空闲时预加载的附加页面 */
export const preloadRouteLoaders = Object.freeze([])

/** 顶栏右侧附加组件 */
export const headerExtraComponents = Object.freeze([])

/** 主布局挂载一次的全局附加组件 */
export const layoutExtraComponents = Object.freeze([])

/** 侧栏「反馈建议」入口：开源版在浏览器打开 GitHub Issues（routeName 与 externalUrl 二选一） */
export const feedbackEntry = Object.freeze({
  visible: true,
  title: '反馈建议',
  routeName: '',
  externalUrl: 'https://github.com/ZToolsTeam/ZTools/issues'
})

/** 侧栏反馈入口的未读提示：开源版没有端内反馈，始终没有未读 */
export function useFeedbackIndicator() {
  return { hasUnread: computed(() => false) }
}

/** 插件详情页「详情」之后的附加 Tab：开源版没有 */
export const pluginDetailTabs = Object.freeze([])

/** 账户相关：开源版没有账号，安装插件不需要登录 */
export const auth = Object.freeze({
  isAuthenticated: async () => false,
  /** 安装插件前的登录检查：返回 false 表示已提示登录、不要继续安装。开源版总是放行 */
  ensureCanInstall: async () => true
})

/**
 * 操作失败且错误表示「需要登录」时由版本处理：返回 true 表示已处理，调用方不再提示。
 * 开源版没有账号，总是返回 false，调用方按普通错误处理。
 * @param {unknown} _error 捕获到的错误
 * @param {{ action?: 'install', level?: 'warning' | 'error' }} [_options] 出错的操作与提示级别
 * @returns {boolean}
 */
export function onAuthRequired(_error, _options) {
  return false
}

/** 使用统计：开源版不上报任何数据 */
export function track() {}

/** 使用统计附带的界面层版本号：开源版不上报，忽略 */
export function setTrackingWebVersion() {}

/** 应用启动钩子：开源版什么都不做 */
export function onAppStart() {}

/**
 * 云同步：开源版不提供，全部为空操作，公共代码可直接调用
 * - pullFavorites(pluginsStore)：拉取云端收藏覆盖本地
 * - pullHomeLayout(ctx)：「我的」页面拉取云端固定与排序
 * - push(fields)：推送部分字段
 */
export const cloudSync = Object.freeze({
  enabled: false,
  pullFavorites: async () => {},
  pullHomeLayout: async () => {},
  push: async () => {}
})

/** 插件市场后台：开源版没有，只读 CDN 静态插件目录 */
export const marketBackend = null
