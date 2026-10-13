// 统一 API 出口：封装两套实现
// 1. HTTP API - Backend 服务接口（直接从子模块导出）
// 2. Native API - Delphi 原生功能（窗口、系统、本地插件等）

// ============ HTTP API - 直接从子模块导出 ============

// 用户认证相关
export {
  wechatLogin,
  wechatAppLogin,
  deviceLogin,
  refreshToken,
  logout,
  getCurrentUser,
  updateUser,
  uploadAvatar,
  isAuthenticated,
  getToken
} from './auth'

// 插件市场相关
export {
  getCategories,
  getMarketPlugins,
  getPluginDetails,
  getPluginDownloadUrl,
  getDownloadSign,
  isPluginVersionIncompatibleError,
  getPluginVersionIncompatibleMessage,
  getPluginComments,
  postPluginComment
} from './plugins'

// 需求墙相关
export {
  getFeatureRequests,
  getFeatureRequestDetail,
  createFeatureRequest,
  voteFeatureRequest,
  unvoteFeatureRequest,
  getFeatureRequestComments,
  createFeatureRequestComment
} from './feature-requests'

// 依赖库管理相关
export {
  getLibraries,
  getLibraryDetail,
  batchGetLibraries,
  checkLibraryCompatibility,
  getLibraryUpdates
} from './libraries'

// 更新检查相关
export { checkAppUpdate, checkPluginUpdate, batchCheckPlugins } from './update'

// 统计分析相关
export { getStatistics, getDashboardStats, reportOnline } from './statistics'

// 云端同步相关
export { getSyncData, pushSyncData } from './sync'

// 导出配置
export * from '../config/api'

// ============ Native API - 从 native.js 导出 ============
export {
  isNative,
  openPlugin,
  getLocalPlugins,
  getFavorites,
  setFavorites,
  getAutostart,
  setAutostart,
  getHotkey,
  setHotkey,
  getMinimizeToTray,
  setMinimizeToTray,
  getCloseConfirm,
  setCloseConfirm,
  downloadAppUpdate,
  downloadPluginUpdate,
  getDllPluginList,
  callDllPlugin,
  installPluginNative,
  uninstallPluginNative,
  createShortcut,
  storageGet,
  storageSet,
  storageDelete,
  systemNotify,
  sys,
  win,
  window,
  fs,
  db
} from './native'

// ============ 工具函数导出 ============

export function slicePage(list, page, pageSize) {
  const start = Math.max(0, (page - 1) * pageSize)
  return list.slice(start, start + pageSize)
}
