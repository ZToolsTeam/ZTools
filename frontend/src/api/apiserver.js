// 统一 API 出口：
// 1. 插件市场与更新 - 读取 CDN 静态插件目录
// 2. Native API - 宿主原生功能（窗口、系统、本地插件等）
// 账号、反馈、云同步等在线服务属于官方版，由 @edition 提供，不从这里导出

// ============ 插件市场与更新（官方版与开源版共用 CDN 静态插件目录） ============

// 插件市场相关
export {
  getCategories,
  getMarketPlugins,
  getPluginDetails,
  getDownloadSign,
  isPluginVersionIncompatibleError,
  getPluginVersionIncompatibleMessage
} from './plugins'

// 更新检查相关
export { checkPluginUpdate, batchCheckPlugins, downloadPluginUpdate } from './update'

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
