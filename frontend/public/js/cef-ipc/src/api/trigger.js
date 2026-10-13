/**
 * Trigger API - 触发器与全局热键
 */
class TriggerAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 注册触发器 (如全局热键)
   * @param {Object} config - 触发器配置
   * @param {string} config.id - 触发器唯一ID
   * @param {string} config.pluginId - 所属插件ID
   * @param {string} config.type - 触发器类型: 'hotkey', 'timer', 'hook', 'clipboard', 'network'
   * @param {boolean} config.enabled - 是否启用
   * @param {Object} config.config - 触发器配置内容，如 { key: 'Ctrl+Alt+T' }
   * @param {Object} config.action - 触发动作配置
   * @param {string} config.action.mode - 执行模式: 'builtin', 'dll', 'script', 'window'；内置的 launch_local_app 仅接受面板本地软件 ID
   * @param {string} config.action.target - 执行目标 (函数名/DLL名/脚本/窗口ID)
   * @param {Object} config.action.params - 执行参数
   * @returns {Promise<Object>} { success: boolean, triggerId: string }
   * @example
   * await trigger.register({
   *   id: 'global_wake_hotkey',
   *   pluginId: 'system',
   *   type: 'hotkey',
   *   enabled: true,
   *   config: { key: 'Ctrl+Shift+Z' },
   *   action: {
   *     mode: 'builtin',
   *     target: 'toggle_main_window',
   *     params: {}
   *   }
   * })
   */
  async register(config) {
    return await this.transport.call('trigger_register', config)
  }

  /**
   * 注销触发器
   * @param {string} triggerId - 触发器ID
   * @returns {Promise<Object>}
   */
  async unregister(triggerId) {
    return await this.transport.call('trigger_unregister', { triggerId })
  }

  /**
   * 列出所有触发器
   * @param {string} [pluginId] - 可选，按插件过滤
   * @returns {Promise<Array>} 每项的 enabled 表示用户期望状态，effectiveEnabled 表示快捷键是否已由宿主注册生效
   */
  async list(pluginId = '') {
    return await this.transport.call('trigger_list', { pluginId })
  }

  /**
   * 设置触发器启用状态
   * @param {string} triggerId
   * @param {boolean} enabled
   * @returns {Promise<Object>}
   */
  async setEnabled(triggerId, enabled) {
    return await this.transport.call('trigger_set_enabled', {
      triggerId,
      enabled: !!enabled
    })
  }

  /**
   * 检测快捷键冲突
   * @param {string} key - 快捷键字符串，如 'Ctrl+Shift+A'
   * @param {string} pluginId - 当前插件ID（排除自身）
   * @returns {Promise<Object>} { hasConflict: boolean, conflicts: Array<{pluginId, pluginName, triggerId, key}> }
   */
  async checkConflict(key, pluginId = '') {
    return await this.transport.call('trigger_check_conflict', { key, pluginId })
  }

}

export default TriggerAPI
