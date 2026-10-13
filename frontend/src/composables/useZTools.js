/**
 * ZTools 组合式 API
 *
 * 提供统一的 ZTools API 访问接口
 * 直接使用 apiserver 中的实现，避免重复代码
 */

import {
  isNative,
  getMarketPlugins,
  getPluginDetails,
  openPlugin,
  getFavorites,
  setFavorites,
  storageGet,
  storageSet,
  storageDelete,
  systemNotify
} from '@/api/apiserver'

/**
 * 检测 ZTools 原生环境
 */
export function useZTools() {
  // 业务 API
  const api = {
    // 插件市场
    getMarketPlugins,
    getPluginDetails,
    openPlugin,

    // 收藏 - 使用 apiserver 统一实现
    getFavorites,
    setFavorites,

    // storage 直达
    storage: {
      get: storageGet,
      set: storageSet,
      delete: storageDelete
    },

    // system 直达
    system: {
      notify: systemNotify
    }
  }

  return { hasZTools: isNative, api }
}
