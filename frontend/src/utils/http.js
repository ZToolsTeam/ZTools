import axios from 'axios'

import { createOfflineError, isOfflineError, isOnline } from '../config/runtime-mode'

/**
 * HTTP 客户端配置
 *
 * 基于 axios，配置了：
 * - 统一的 baseURL
 * - 请求超时
 * - Token 认证
 * - 统一的响应处理和错误处理
 */

const http = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }
})

let refreshPromise = null

function isRefreshRequest(config) {
  return String(config?.url || '').includes('/api/auth/refresh')
}

async function getLocalAuthInfo() {
  if (!(window.ztools && window.ztools.user)) {
    return null
  }

  try {
    return await window.ztools.user.getInfo()
  } catch {
    return null
  }
}

async function saveRefreshedTokens(data, user) {
  const token = data?.access_token || data?.token
  const refreshToken = data?.refresh_token
  if (!token || !(window.ztools && window.ztools.user)) {
    return token
  }

  await window.ztools.user.setToken({
    token,
    refreshToken: refreshToken || '',
    userId: String(user?.id || user?.user_id || ''),
    username: user?.nickname || user?.username || '',
    email: user?.email || '',
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
  })

  return token
}

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const authInfo = await getLocalAuthInfo()
      const refreshToken = authInfo?.refreshToken || authInfo?.refresh_token
      if (!refreshToken) {
        throw new Error('Refresh Token 不存在')
      }

      const response = await axios.post(
        '/api/auth/refresh',
        { refresh_token: refreshToken },
        {
          baseURL: http.defaults.baseURL,
          timeout: http.defaults.timeout,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
          }
        }
      )

      if (!response.data?.success) {
        throw new Error(response.data?.message || '刷新 Token 失败')
      }

      return saveRefreshedTokens(response.data.data, authInfo?.user)
    })().finally(() => {
      refreshPromise = null
    })
  }

  return refreshPromise
}

// 请求拦截器：添加认证 Token（可选，不强制要求登录）
http.interceptors.request.use(
  async (config) => {
    // 单机模式：不发出任何后台请求
    if (!isOnline) {
      throw createOfflineError()
    }
    // 从原生宿主环境或 localStorage（Mock环境）获取 Token
    // 如果没有token也允许继续请求
    if (window.ztools && window.ztools.user) {
      try {
        const token = await window.ztools.user.getToken()
        if (token) {
          config.headers.Authorization = `Bearer ${token}`
        }
      } catch (err) {
        // 忽略错误，允许未登录访问
        console.debug('[http] 未登录状态，继续请求')
      }
    }
    return config
  },
  (error) => {
    console.error('请求错误:', error)
    return Promise.reject(error)
  }
)

// 响应拦截器：统一处理响应和错误
http.interceptors.response.use(
  (response) => {
    // 返回响应数据
    return response.data
  },
  async (error) => {
    if (isOfflineError(error)) {
      return Promise.reject(error)
    }
    // 处理错误响应
    if (error.response) {
      const { status, data } = error.response
      const originalRequest = error.config || {}

      if (
        status === 401 &&
        !originalRequest._retry &&
        !isRefreshRequest(originalRequest)
      ) {
        originalRequest._retry = true

        try {
          const token = await refreshAccessToken()
          if (token) {
            originalRequest.headers = originalRequest.headers || {}
            originalRequest.headers.Authorization = `Bearer ${token}`
            return http(originalRequest)
          }
        } catch (refreshError) {
          console.debug('Token刷新失败，需要重新登录')
        }
      }

      // 根据 HTTP 状态码处理错误
      switch (status) {
        case 401:
          // 未认证或 Token 无效（仅清除token，不强制跳转登录）
          console.debug('未登录或Token过期')
          // 清除后端 Token
          if (window.ztools && window.ztools.user) {
            window.ztools.user.logout().catch(() => {})
          }
          // 不自动跳转登录页，由组件根据需要引导用户登录
          break
        case 403:
          // 无权限
          console.warn('无权限访问')
          break
        case 404:
          // 资源不存在
          console.warn('请求的资源不存在')
          break
        case 422:
          // 验证失败
          console.warn('请求参数验证失败:', data.errors)
          break
        case 429:
          // 请求过于频繁
          console.warn('请求过于频繁，请稍后再试')
          break
        case 500:
          // 服务器错误
          console.error('服务器错误，请联系技术支持')
          break
        default:
          console.error(`请求失败 (${status}):`, data.message)
      }

      // 返回格式化的错误信息
      return Promise.reject({
        status,
        message: data.message || '请求失败',
        errors: data.errors || null,
        data: data
      })
    } else if (error.request) {
      // 请求已发送但没有收到响应
      console.error('网络错误，请检查网络连接')
      return Promise.reject({
        status: 0,
        message: '网络错误，请检查网络连接',
        errors: null
      })
    } else {
      // 请求配置出错
      console.error('请求配置错误:', error.message)
      return Promise.reject({
        status: -1,
        message: error.message || '请求配置错误',
        errors: null
      })
    }
  }
)

export default http
