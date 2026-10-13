/**
 * Shell API - Shell 操作
 * 提供 Shell 操作功能，类似 uTools API
 */
class ShellAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 打开文件或目录
   * @param {string} fullPath - 完整路径
   * @returns {Promise<boolean>}
   */
  async openPath(fullPath) {
    const r = await this.transport.call('shell_open_path', { fullPath })
    return r && r.success === true
  }

  /**
   * 将文件移到回收站
   * @param {string} fullPath - 完整路径
   * @returns {Promise<boolean>}
   */
  async trashItem(fullPath) {
    const r = await this.transport.call('shell_trash_item', { fullPath })
    return r && r.success === true
  }

  /**
   * 在文件管理器中显示文件
   * @param {string} fullPath - 完整路径
   * @returns {Promise<boolean>}
   */
  async showItemInFolder(fullPath) {
    const r = await this.transport.call('shell_show_item_in_folder', {
      fullPath
    })
    return r && r.success === true
  }

  /**
   * 使用默认浏览器打开 URL
   * @param {string} url - URL 地址
   * @returns {Promise<boolean>}
   */
  async openExternal(url) {
    const r = await this.transport.call('shell_open_external', { url })
    return r && r.success === true
  }

  /**
   * 播放系统提示音
   * @returns {Promise<boolean>}
   */
  async beep() {
    const r = await this.transport.call('shell_beep', {})
    return r && r.success === true
  }

  /**
   * 执行 shell 命令
   * @param {string} command - 要执行的命令
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
   */
  async exec(command) {
    const r = await this.transport.call('shell_exec', { command })
    if (r && r.success) {
      return {
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        exitCode: r.exitCode || 0
      }
    }
    throw new Error(r?.error || 'Shell exec failed')
  }
}

export default ShellAPI
