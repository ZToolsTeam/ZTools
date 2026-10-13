/**
 * 留言式反馈 API（App 1.0.4+ 使用）
 *
 * 对接 Backend 的 /api/feedback 接口，替代旧的需求墙 /api/feature-requests
 */

import http from '../utils/http'

/**
 * 获取反馈列表
 * @param {Object} params - 查询参数
 * @param {number} [params.page] - 页码（默认 1）
 * @param {number} [params.per_page] - 每页数量（默认 10）
 * @param {string} [params.search] - 搜索关键字
 * @param {string} [params.status] - 状态筛选：pending/reviewing/approved/rejected/developing/completed
 * @param {string} [params.sort] - 排序字段：created_at/likes/replies/hot（默认 created_at）
 * @param {'asc'|'desc'} [params.direction] - 排序方向（默认 desc）
 * @param {number} [params.user_id] - 只查某个用户的反馈
 * @returns {Promise<Object>} { data, current_page, per_page, total, last_page }
 */
export async function getFeedbackList(params = {}) {
  const response = await http.get('/api/feedback', { params })

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '获取反馈列表失败')
}

/**
 * 获取反馈详情
 * @param {number} id
 * @returns {Promise<Object>}
 */
export async function getFeedbackDetail(id) {
  const response = await http.get(`/api/feedback/${id}`)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '获取反馈详情失败')
}

/**
 * 创建主反馈（需认证）
 * @param {Object} data
 * @param {string} data.content - 反馈内容（1-5000 字符）
 * @param {string} [data.author] - 匿名显示名（可选）
 * @param {string} [data.contact] - 联系方式（可选，仅作者自己可见）
 * @param {string} [data.appversion] - 提交反馈时的 App 版本（自动获取）
 */
export async function createFeedback(data) {
  const payload = { ...data }

  try {
    const version = await window.ztools?.sys?.getCurrentVersion?.()
    if (version?.appVersion) {
      payload.appversion = version.appVersion
    }
  } catch (error) {
    console.warn('[feedback] 获取 App 版本失败，将继续提交反馈:', error)
  }

  const response = await http.post('/api/feedback', payload)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '提交反馈失败')
}

/**
 * 上传主反馈附件（仅图片/视频）
 * @param {File} file
 */
export async function uploadFeedbackAttachment(file) {
  const formData = new FormData()
  formData.append('file', file)

  const response = await http.post('/api/feedback/attachments', formData, {
    headers: {
      'Content-Type': 'multipart/form-data'
    }
  })

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '上传附件失败')
}

/**
 * 获取当前用户发布反馈的新回复提示
 */
export async function getUnreadFeedbackReplies() {
  const response = await http.get('/api/feedback/unread-replies')

  if (response.success) {
    return response.data || { count: 0, ids: [], hasUnread: false }
  }

  throw new Error(response.message || '获取反馈未读回复失败')
}

/**
 * 标记某条主反馈的回复为已读
 * @param {number} id
 */
export async function markFeedbackRepliesRead(id) {
  const response = await http.post(`/api/feedback/${id}/read-replies`)

  if (response.success) {
    return response.data || { count: 0, ids: [], hasUnread: false }
  }

  throw new Error(response.message || '标记反馈回复已读失败')
}

/**
 * 获取反馈回复树（树形结构，节点含 replies）
 * @param {number} id
 */
export async function getFeedbackReplies(id) {
  const response = await http.get(`/api/feedback/${id}/replies`)

  if (response.success) {
    return response.data || []
  }

  throw new Error(response.message || '获取回复失败')
}

/**
 * 添加回复（需认证）
 * @param {number} id - 主反馈 ID
 * @param {Object} data
 * @param {string} data.content
 * @param {number} [data.parentId] - 父回复 ID（回复回复时传）
 */
export async function addFeedbackReply(id, data) {
  const response = await http.post(`/api/feedback/${id}/replies`, data)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '回复失败')
}

/**
 * 点赞主反馈（需认证）
 */
export async function likeFeedback(id) {
  const response = await http.post(`/api/feedback/${id}/like`)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '点赞失败')
}

/**
 * 取消点赞主反馈（需认证）
 */
export async function unlikeFeedback(id) {
  const response = await http.delete(`/api/feedback/${id}/like`)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '取消点赞失败')
}

/**
 * 点赞回复（需认证）
 */
export async function likeFeedbackReply(id, replyId) {
  const response = await http.post(`/api/feedback/${id}/replies/${replyId}/like`)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '点赞失败')
}

/**
 * 取消点赞回复（需认证）
 */
export async function unlikeFeedbackReply(id, replyId) {
  const response = await http.delete(`/api/feedback/${id}/replies/${replyId}/like`)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '取消点赞失败')
}
