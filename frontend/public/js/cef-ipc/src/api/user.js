// ============================================================
// User API - 用户操作
// 职责: 封装用户相关的业务逻辑
// ============================================================

class UserAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 获取当前用户信息
   * @returns {Promise<Object>} { loggedIn, user, token }
   *   - loggedIn: 是否已登录
   *   - user: 用户信息对象 { user_id, username, email, last_login_at }
   *   - token: 访问令牌
   */
  async getInfo() {
    const r = await this.transport.call('user_get_info')
    return {
      loggedIn: r?.logged_in || false,
      user: r?.user || null,
      token: r?.token || null,
      refreshToken: r?.refresh_token || null
    }
  }

  /**
   * 设置用户Token（登录成功后调用）
   * @param {Object} params
   * @param {string} params.token - 访问令牌
   * @param {string} params.userId - 用户ID
   * @param {string} params.username - 用户名
   * @param {string} params.email - 邮箱
   * @param {string} params.expiresAt - 过期时间（ISO字符串）
   * @returns {Promise<boolean>}
   */
  async setToken({
    token,
    refreshToken,
    refresh_token,
    userId,
    username,
    email,
    expiresAt
  }) {
    const r = await this.transport.call('user_set_token', {
      token,
      refresh_token: refreshToken || refresh_token || '',
      user_id: userId,
      username,
      email,
      expires_at: expiresAt
    })
    return r?.success === true
  }

  /**
   * 退出登录
   * @returns {Promise<boolean>}
   */
  async logout() {
    const r = await this.transport.call('user_logout')
    return r?.success === true
  }

  /**
   * 检查是否已登录（便捷方法）
   * @returns {Promise<boolean>}
   */
  async isLoggedIn() {
    const info = await this.getInfo()
    return info.loggedIn
  }

  /**
   * 获取当前Token（便捷方法）
   * @returns {Promise<string|null>}
   */
  async getToken() {
    const info = await this.getInfo()
    return info.token
  }

  async getRefreshToken() {
    const info = await this.getInfo()
    return info.refreshToken
  }
}

export default UserAPI
