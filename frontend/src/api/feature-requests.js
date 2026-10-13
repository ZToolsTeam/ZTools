/**
 * 需求墙 API
 *
 * 对接 Backend 的需求墙相关接口
 */

import http from '../utils/http'

/**
 * 获取需求列表
 * @param {Object} params - 查询参数
 * @param {string} params.status - 状态筛选：pending/in_progress/completed/rejected
 * @param {string} params.sort - 排序字段：created_at/votes/latest_reply（默认：created_at）
 * @param {string} params.direction - 排序方向：asc/desc（默认：desc）
 * @param {number} params.per_page - 每页数量（默认：10）
 * @param {number} params.page - 页码（默认：1）
 * @returns {Promise<Object>} { data, current_page, per_page, total, last_page }
 */
export async function getFeatureRequests(params = {}) {
  const response = await http.get('/api/feature-requests', { params })

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '获取需求列表失败')
}

/**
 * 获取需求详情
 * @param {number} id - 需求 ID
 * @returns {Promise<Object>} 需求详情
 */
export async function getFeatureRequestDetail(id) {
  const response = await http.get(`/api/feature-requests/${id}`)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '获取需求详情失败')
}

/**
 * 提交需求（需要认证）
 * @param {Object} data - 需求数据
 * @param {string} data.title - 需求标题（最大 255 字符）
 * @param {string} data.description - 需求描述
 * @returns {Promise<Object>} 创建的需求对象
 */
export async function createFeatureRequest(data) {
  const response = await http.post('/api/feature-requests', data)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '提交需求失败')
}

/**
 * 为需求投票（需要认证）
 * @param {number} id - 需求 ID
 * @returns {Promise<Object>} { id, votes, is_voted }
 */
export async function voteFeatureRequest(id) {
  const response = await http.post(`/api/feature-requests/${id}/vote`)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '投票失败')
}

/**
 * 取消投票（需要认证）
 * @param {number} id - 需求 ID
 * @returns {Promise<Object>} { id, votes, is_voted }
 */
export async function unvoteFeatureRequest(id) {
  const response = await http.delete(`/api/feature-requests/${id}/vote`)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '取消投票失败')
}

/**
 * 获取需求评论
 * @param {number} id - 需求 ID
 * @returns {Promise<Array>} 评论列表
 */
export async function getFeatureRequestComments(id) {
  const response = await http.get(`/api/feature-requests/${id}/comments`)

  if (response.success) {
    return response.data || []
  }

  throw new Error(response.message || '获取评论失败')
}

/**
 * 发表评论（需要认证）
 * @param {number} id - 需求 ID
 * @param {Object} data - 评论数据
 * @param {string} data.content - 评论内容
 * @param {number} data.parent_id - 父评论 ID（回复评论时使用）
 * @returns {Promise<Object>} 创建的评论对象
 */
export async function createFeatureRequestComment(id, data) {
  const response = await http.post(`/api/feature-requests/${id}/comments`, data)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '发表评论失败')
}
