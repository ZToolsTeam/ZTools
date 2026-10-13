/**
 * 统计分析 API
 *
 * 对接 Backend 的统计相关接口
 */

import http from '../utils/http'

/**
 * 获取统计数据
 * @returns {Promise<Object>} 统计数据
 */
export async function getStatistics() {
  const response = await http.get('/api/stats')

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '获取统计数据失败')
}

/**
 * 获取仪表盘统计
 * @returns {Promise<Object>} 仪表盘统计数据
 */
export async function getDashboardStats() {
  const response = await http.get('/api/stats/dashboard')

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '获取仪表盘统计失败')
}

/**
 * 上报今日上线（无需登录，按 IP 去重，每天只记录一次）
 * @returns {Promise<boolean>}
 */
export async function reportOnline() {
  const response = await http.post('/api/stats/online', {})

  return response.success === true
}
