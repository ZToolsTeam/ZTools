/**
 * 依赖库管理 API
 *
 * 对接 Backend 的依赖库相关接口
 */

import http from '../utils/http'

/**
 * 获取依赖库列表
 * @param {Object} params - 查询参数
 * @param {string} params.search - 搜索关键词
 * @param {string} params.category - 分类筛选：ocr/video/image/audio/system
 * @param {number} params.per_page - 每页数量（默认：15）
 * @param {number} params.page - 页码（默认：1）
 * @returns {Promise<Object>} { data, current_page, per_page, total, last_page }
 */
export async function getLibraries(params = {}) {
  const response = await http.get('/api/libraries', { params })

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '获取依赖库列表失败')
}

/**
 * 获取依赖库详情（包含下载地址）
 * @param {string} libraryId - 依赖库标识符
 * @param {Object} params - 查询参数
 * @param {string} params.version - 版本号（默认最新版）
 * @param {string} params.platform - 平台：windows/macos/linux（默认：windows）
 * @param {string} params.arch - 架构：x86/x64/arm64（默认：x64）
 * @returns {Promise<Object>} 依赖库详情
 */
export async function getLibraryDetail(libraryId, params = {}) {
  const response = await http.get(`/api/libraries/${libraryId}`, { params })

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '获取依赖库详情失败')
}

/**
 * 批量获取依赖库信息
 * @param {Object} data - 请求数据
 * @param {Array<string>} data.ids - 依赖库标识符数组
 * @param {string} data.platform - 平台：windows/macos/linux（默认：windows）
 * @param {string} data.arch - 架构：x86/x64/arm64（默认：x64）
 * @returns {Promise<Array>} 依赖库列表
 */
export async function batchGetLibraries(data) {
  const response = await http.post('/api/libraries/batch', data)

  if (response.success) {
    return response.data || []
  }

  throw new Error(response.message || '批量获取依赖库失败')
}

/**
 * 检查依赖库兼容性
 * @param {Object} data - 请求数据
 * @param {string} data.library_id - 依赖库标识符
 * @param {string} data.version - 版本要求（如：">=2.0.0 <3.0.0"）
 * @param {string} data.platform - 平台：windows/macos/linux（默认：windows）
 * @param {string} data.arch - 架构：x86/x64/arm64（默认：x64）
 * @returns {Promise<Object>} { compatible, recommended_version, available_versions }
 */
export async function checkLibraryCompatibility(data) {
  const response = await http.post('/api/libraries/check-compatibility', data)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '检查兼容性失败')
}

/**
 * 获取依赖库更新信息
 * @param {string} libraryId - 依赖库标识符
 * @param {string} currentVersion - 当前安装的版本
 * @returns {Promise<Object>} { hasUpdate, latestVersion, currentVersion, updateInfo }
 */
export async function getLibraryUpdates(libraryId, currentVersion) {
  const response = await http.get(`/api/libraries/${libraryId}/updates`, {
    params: { current_version: currentVersion }
  })

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '获取更新信息失败')
}
