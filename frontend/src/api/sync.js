/**
 * 云端同步 API
 *
 * 对接 Backend 的用户数据同步接口
 */

import http from '../utils/http'

/**
 * 拉取云端同步数据
 * @returns {Promise<Object>} { plugin_list, plugin_order, pinned_list, favorites, updated_at }
 */
export async function getSyncData() {
  const response = await http.get('/api/user/sync')
  if (response.success) {
    return response.data
  }
  throw new Error(response.message || '获取同步数据失败')
}

/**
 * 推送本地数据到云端
 * @param {Object} data - 同步数据（支持部分更新）
 * @param {string[]} [data.plugin_list] - 当前安装的插件列表
 * @param {string[]} [data.plugin_order] - 插件排序
 * @param {string[]} [data.pinned_list] - 固定列表
 * @param {string[]} [data.favorites] - 收藏列表
 * @param {string|null} [data.last_updated_at] - 上次同步时间（乐观锁）
 * @returns {Promise<Object>} 更新后的同步数据
 */
export async function pushSyncData(data) {
  try {
    const response = await http.put('/api/user/sync', data)
    if (response.success) {
      return { success: true, data: response.data }
    }
    return { success: false, message: response.message }
  } catch (err) {
    // 409 冲突：返回服务端最新数据
    if (err.status === 409) {
      return {
        success: false,
        conflict: true,
        data: err.data?.data || null,
        message: '数据冲突'
      }
    }
    throw err
  }
}
