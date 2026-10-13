/**
 * Privileged API - 特权操作
 * 提供需要管理员权限的操作
 */
class PrivilegedAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 写入注册表
   * @param {string} path - 注册表路径
   * @param {string} name - 键名
   * @param {string} value - 键值
   * @param {number} view - 视图 (32|64)
   * @returns {Promise<boolean>}
   */
  async regWrite(path, name, value, view = 64) {
    const r = await this.transport.call('builtin_reg_write', {
      path,
      name,
      value,
      view
    })
    return r && r.success === true
  }

  /**
   * 删除注册表项
   * @param {string} path - 注册表路径
   * @param {string} name - 键名
   * @param {number} view - 视图 (32|64)
   * @returns {Promise<boolean>}
   */
  async regDelete(path, name, view = 64) {
    const r = await this.transport.call('builtin_reg_delete', {
      path,
      name,
      view
    })
    return r && r.success === true
  }

  /**
   * 写入文件（绕过权限限制）
   * @param {string} path - 文件路径
   * @param {string} content - 内容
   * @returns {Promise<boolean>}
   */
  async fileWrite(path, content) {
    const r = await this.transport.call('builtin_file_write', {
      path,
      content
    })
    return r && r.success === true
  }

  /**
   * 重启资源管理器
   * @returns {Promise<boolean>}
   */
  async restartExplorer() {
    const r = await this.transport.call('builtin_restart_explorer', {})
    return r && r.success === true
  }

  /**
   * 执行提权命令
   * @param {string} cmd - 命令
   * @param {object} options - 选项
   * @returns {Promise<any>}
   */
  async execute(cmd, options = {}) {
    const r = await this.transport.call('privileged_execute', {
      cmd,
      ...options
    })
    if (r && r.success) {
      return r.data
    }
    throw new Error(r?.error || 'Privileged execute failed')
  }
}

export default PrivilegedAPI
