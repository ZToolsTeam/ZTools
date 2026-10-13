/**
 * 用户认证 API
 *
 * 对接 Backend 的认证相关接口
 * 基于 Backend JWT Bearer 认证
 */

import http from '../utils/http'

function getAccessToken(data) {
  return data?.access_token || data?.token || ''
}

async function getLocalAuthInfo() {
  if (window.ztools && window.ztools.user) {
    try {
      return await window.ztools.user.getInfo()
    } catch (err) {
      console.warn('[auth] 获取本地登录信息失败:', err)
    }
  }
  return null
}

async function saveTokenToNative(data, user) {
  const token = getAccessToken(data)
  if (!token || !user || !(window.ztools && window.ztools.user)) {
    return
  }

  try {
    await window.ztools.user.setToken({
      token,
      refreshToken: data.refresh_token || '',
      userId: String(user.id || user.user_id || ''),
      username: user.nickname || user.username || '',
      email: user.email || '',
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
    })
  } catch (err) {
    console.warn('[auth] 保存 token 到后端失败:', err)
  }
}

/**
 * 微信网页端登录
 * @param {string} code - 微信授权码
 * @returns {Promise<Object>} { token, user }
 */
export async function wechatLogin(code) {
  const response = await http.post('/api/auth/wechat/login', { code })

  if (response.success) {
    const { user } = response.data
    const token = getAccessToken(response.data)
    await saveTokenToNative(response.data, user)

    return { token, user }
  }

  throw new Error(response.message || '微信登录失败')
}

/**
 * 微信应用端登录
 * @param {string} jsCode - 微信 JS Code
 * @returns {Promise<Object>} { token, user }
 */
export async function wechatAppLogin(jsCode) {
  const response = await http.post('/api/auth/wechat/app-login', {
    js_code: jsCode
  })

  if (response.success) {
    const { user } = response.data
    const token = getAccessToken(response.data)
    await saveTokenToNative(response.data, user)

    return { token, user }
  }

  throw new Error(response.message || '微信登录失败')
}

/**
 * 设备号登录（免扫码快速登录，供测试环境、内部工具、无头自动化使用）
 * @param {string} [deviceCode='ZTOOLS-TEST-DEVICE-0001'] - 设备码
 * @param {string} [nickname='AI测试专用设备号'] - 昵称（可选）
 * @returns {Promise<Object>} { token, user }
 */
export async function deviceLogin(
  deviceCode = 'ZTOOLS-TEST-DEVICE-0001',
  nickname = 'AI测试专用设备号'
) {
  const trimmedCode = (deviceCode || '').trim()
  if (!trimmedCode) {
    throw new Error('设备号不能为空')
  }

  const response = await http.post('/api/auth/device-login', {
    device_code: trimmedCode,
    nickname: nickname ? nickname.trim() : undefined
  })

  if (response.success) {
    const { user } = response.data
    const token = getAccessToken(response.data)
    await saveTokenToNative(response.data, user)

    return { token, user }
  }

  throw new Error(response.message || '设备号登录失败')
}

/**
 * 刷新 Token（需要认证）
 * @returns {Promise<string>} 新的 token
 */
export async function refreshToken() {
  const authInfo = await getLocalAuthInfo()
  const refreshToken = authInfo?.refreshToken || authInfo?.refresh_token
  if (!refreshToken) {
    throw new Error('Refresh Token 不存在')
  }

  const response = await http.post('/api/auth/refresh', {
    refresh_token: refreshToken
  })

  if (response.success) {
    const token = getAccessToken(response.data)
    await saveTokenToNative(response.data, authInfo?.user)

    return token
  }

  throw new Error(response.message || '刷新 Token 失败')
}

/**
 * 退出登录（需要认证）
 * @returns {Promise<boolean>}
 */
export async function logout() {
  try {
    const response = await http.post('/api/auth/logout')

    // 清除后端 token（CEF环境）或 localStorage（Mock环境）
    if (window.ztools && window.ztools.user) {
      try {
        await window.ztools.user.logout()
      } catch (err) {
        console.warn('[auth] 清除后端 token 失败:', err)
      }
    }

    return response.success
  } catch (error) {
    // 即使请求失败也清除 token
    if (window.ztools && window.ztools.user) {
      try {
        await window.ztools.user.logout()
      } catch (err) {}
    }
    throw error
  }
}

/**
 * 获取当前用户信息（需要认证）
 * @returns {Promise<Object>} 用户信息
 */
export async function getCurrentUser() {
  const response = await http.get('/api/auth/user')

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '获取用户信息失败')
}

/**
 * 更新用户信息（需要认证）
 * @param {Object} data - 用户信息
 * @param {string} data.nickname - 昵称
 * @param {string} data.avatar - 头像 URL
 * @param {string} data.gender - 性别：male/female/unknown
 * @returns {Promise<Object>} 更新后的用户信息
 */
export async function updateUser(data) {
  const response = await http.put('/api/auth/user', data)

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '更新用户信息失败')
}

/**
 * 上传用户头像（需要认证）
 * @param {File} file - 头像文件对象
 * @returns {Promise<Object>} { url, user }
 */
export async function uploadAvatar(file) {
  const formData = new FormData()
  formData.append('avatar', file)

  const response = await http.post('/api/auth/user/avatar', formData, {
    headers: {
      'Content-Type': 'multipart/form-data'
    }
  })

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '头像上传失败')
}

/**
 * 检查是否已登录
 * @returns {Promise<boolean>}
 */
export async function isAuthenticated() {
  // 从后端获取登录状态（CEF环境）或 localStorage（Mock环境）
  if (window.ztools && window.ztools.user) {
    try {
      return await window.ztools.user.isLoggedIn()
    } catch (err) {
      console.warn('[auth] 检查登录状态失败:', err)
      return false
    }
  }
  return false
}

/**
 * 获取当前 Token
 * @returns {Promise<string|null>}
 */
export async function getToken() {
  // 从 ztools.user 获取 token（统一接口，自动处理 CEF/Mock 环境）
  if (window.ztools && window.ztools.user) {
    try {
      return await window.ztools.user.getToken()
    } catch (err) {
      console.warn('[auth] 从后端获取 token 失败:', err)
      return null
    }
  }
  return null
}

/**
 * 生成扫码登录二维码
 * @returns {Promise<Object>} { scene_id, qrcode_url, expires_at }
 */
export async function generateQrcode() {
  const response = await http.post('/api/auth/qrcode/generate')

  if (response.success) {
    return response.data
  }

  throw new Error(response.message || '生成二维码失败')
}

/**
 * 检查二维码扫描状态
 * @param {string} sceneId - 场景ID
 * @returns {Promise<Object>} { status, token, user }
 */
export async function checkQrcodeStatus(sceneId) {
  const response = await http.post('/api/auth/qrcode/check', {
    scene_id: sceneId
  })

  if (response.success) {
    const result = response.data

    // 如果扫码成功并获得token，保存到 Delphi 后端（CEF环境）或 localStorage（Mock环境）
    if (result.status === 'confirmed' && getAccessToken(result) && result.user) {
      await saveTokenToNative(result, result.user)
    }

    return result
  }

  throw new Error(response.message || '检查二维码状态失败')
}
