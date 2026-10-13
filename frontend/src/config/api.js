/**
 * API 配置
 *
 * 集中管理所有 API 相关的配置
 */

// API 基础地址
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:8001/api'

// 生产环境 API 地址
export const API_PRODUCTION_URL = 'https://api.ztools.cn/api'

// 请求超时时间（毫秒）
export const API_TIMEOUT = 10000

// API 版本
export const API_VERSION = '1.0.0'

// 每分钟最大请求次数
export const API_RATE_LIMIT = 60

// 分页配置
export const PAGINATION = {
  DEFAULT_PAGE_SIZE: 15,
  MAX_PAGE_SIZE: 100,
  PLUGIN_PAGE_SIZE: 15,
  FEATURE_REQUEST_PAGE_SIZE: 10,
  LIBRARY_PAGE_SIZE: 15
}

// 缓存配置（分钟）
export const CACHE_DURATION = {
  PLUGIN_LIST: 5,
  PLUGIN_DETAIL: 10,
  STATISTICS: 30
}

// Token 配置
export const TOKEN_CONFIG = {
  STORAGE_KEY: 'auth_token',
  EXPIRY_DAYS: 365 // Token 有效期（天）
}

// 环境判断
export const isDevelopment = import.meta.env.DEV
export const isProduction = import.meta.env.PROD

// 当前使用的 API 地址
export const currentApiUrl = isDevelopment ? API_BASE_URL : API_PRODUCTION_URL
