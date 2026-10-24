/**
 * Process API - 进程管理
 * 进程列表、启动、终止、监控
 */
function parseWindowsArguments(source) {
  const args = []
  let index = 0
  while (index < source.length) {
    while (source[index] === ' ' || source[index] === '\t') index += 1
    if (index >= source.length) break
    let argument = ''
    let quoted = false
    while (index < source.length && (quoted || (source[index] !== ' ' && source[index] !== '\t'))) {
      let slashCount = 0
      while (source[index] === '\\') {
        slashCount += 1
        index += 1
      }
      if (source[index] === '"') {
        argument += '\\'.repeat(Math.floor(slashCount / 2))
        if (slashCount % 2 === 1) {
          argument += '"'
          index += 1
        } else if (quoted && source[index + 1] === '"') {
          argument += '"'
          index += 2
        } else {
          quoted = !quoted
          index += 1
        }
      } else {
        argument += '\\'.repeat(slashCount)
        if (index < source.length) {
          argument += source[index]
          index += 1
        }
      }
    }
    if (quoted) throw new Error('Process arguments contain an unclosed quote')
    args.push(argument)
  }
  return args
}

class ProcessAPI {
  constructor(transport) {
    this.transport = transport
  }

  /**
   * 获取进程列表
   * @returns {Promise<Array<{pid: number, name: string, path: string, cpuUsage: number, memoryUsage: number}>>}
   */
  async listPorts() {
    const response = await this.transport.call('process_list_ports', {}, { timeout: 15000 })
    const failed = () => Object.assign(new Error('端口列表响应无效'), { code: 'PROCESS_ERROR' })
    if (!response || response.success !== true || !Array.isArray(response.data) || response.data.length > 20000 || !['darwin-netstat', 'darwin-lsof', 'windows-netstat'].includes(response.source) || !['all-sockets', 'visible-processes'].includes(response.visibility) || typeof response.queriedAt !== 'string' || !Number.isFinite(Date.parse(response.queriedAt))) throw failed()
    const rows = response.data.map(row => {
      if (!row || !['TCP', 'UDP'].includes(row.protocol) || typeof row.localAddress !== 'string' || row.localAddress.length > 128 || !Number.isSafeInteger(row.localPort) || row.localPort < 1 || row.localPort > 65535 || typeof row.remoteAddress !== 'string' || row.remoteAddress.length > 128 || !(row.remotePort === null || Number.isSafeInteger(row.remotePort) && row.remotePort >= 1 && row.remotePort <= 65535) || typeof row.state !== 'string' || !/^[A-Z0-9_]{1,32}$/.test(row.state) || !Number.isSafeInteger(row.pid) || row.pid < 0 || row.pid > 0xffffffff || typeof row.processName !== 'string' || row.processName.length > 512 || typeof row.fieldAvailability?.processName !== 'boolean' || row.fieldAvailability.processPath !== false || row.fieldAvailability.startTime !== false) throw failed()
      return Object.freeze({ protocol: row.protocol, localAddress: row.localAddress, localPort: row.localPort, remoteAddress: row.remoteAddress, remotePort: row.remotePort, state: row.state, pid: row.pid, processName: row.processName, fieldAvailability: Object.freeze({ ...row.fieldAvailability }) })
    })
    return Object.freeze({ connections: Object.freeze(rows), source: response.source, visibility: response.visibility, queriedAt: response.queriedAt })
  }
  async list() {
    const response = await this.transport.call('process_list', {})
    if (!response || response.success !== true || !Array.isArray(response.data) || response.data.length > 10000) {
      throw Object.assign(new Error('进程列表响应无效'), { code: 'PROCESS_ERROR' })
    }
    return response.data
  }

  /**
   * 获取进程信息
   * @param {number} pid - 进程ID
   * @returns {Promise<{pid: number, cpuUsage: number, memoryUsage: number}>}
   */
  async getInfo(pid) {
    return await this.transport.call('process_info', { pid })
  }

  /**
   * 检查进程是否存在
   * @param {string|number} nameOrPid - 进程名称或ID
   * @returns {Promise<{exists: boolean}>}
   */
  async exists(nameOrPid) {
    return await this.transport.call('process_exists', {
      nameOrPid: nameOrPid.toString()
    })
  }

  /**
   * 查找进程
   * @param {string} name - 进程名称(支持模糊匹配)
   * @returns {Promise<Array<{pid: number, name: string}>>}
   */
  async find(name) {
    const response = await this.transport.call('process_find', { name })
    return response?.data || []
  }

  /**
   * 启动进程
   * @param {string} path - 可执行文件路径
   * @param {string|Array<string>} [args] - 命令行参数
   * @param {Object} [options] - 启动选项
   * @param {string} [options.workingDir] - 工作目录
   * @param {boolean} [options.show=true] - 是否显示窗口
   * @returns {Promise<{pid: number}>} 进程ID
   */
  async start(path, args = '', options = {}) {
    const { workingDir = '', show = true } = options
    if (!Array.isArray(args) && typeof args !== 'string') {
      throw new TypeError('Process arguments must be a string or string array')
    }
    if (Array.isArray(args) && args.some((item) => typeof item !== 'string')) {
      throw new TypeError('Process arguments must only contain strings')
    }
    const electronArgs = Array.isArray(args) ? [...args] : parseWindowsArguments(args)
    const nativeArgs = Array.isArray(args) ? args.join(' ') : args

    return await this.transport.call('process_start', {
      path,
      args: this.transport.isElectronEnvironment() ? electronArgs : nativeArgs,
      workingDir,
      show
    })
  }

  /**
   * 终止进程
   * @param {number} pid - 进程ID
   * @param {boolean} [force=false] - 是否强制终止
   * @returns {Promise<void>}
   */
  async kill(pid, force = false) {
    return await this.transport.call('process_kill', { pid, force })
  }

  /**
   * 按名称终止进程
   * @param {string} name - 进程名称
   * @param {boolean} [force=false] - 是否强制终止
   * @returns {Promise<void>}
   */
  async killByName(name, force = false) {
    return await this.transport.call('process_kill_by_name', { name, force })
  }

  /**
   * 等待进程结束
   * @param {number} pid - 进程ID
   * @param {number} [timeout=0] - 超时时间(毫秒),0表示无限等待
   * @returns {Promise<{exitCode: number}>} 退出码
   */
  async wait(pid, timeout = 0) {
    const transportTimeout = timeout === 0 ? Infinity : Math.min(timeout + 1000, 120000)
    return await this.transport.call('process_wait', { pid, timeout }, { timeout: transportTimeout })
  }

  /**
   * 获取进程窗口句柄
   * @param {number} pid - 进程ID
   * @returns {Promise<{handle: number}>}
   */
  async getWindow(pid) {
    return await this.transport.call('process_get_window', { pid })
  }

  /**
   * 预留的FFmpeg执行入口；任务终态/进度/取消合同尚未接入。
   * @param {Array<string>} args - FFmpeg运行参数(数组)
   * @param {Function} [onProgress] - 处理进度中的回调函数 (progress) => void
   * @returns {Promise<void>} 当前明确拒绝NOT_SUPPORTED，不启动任务。
   */
  async runFFmpeg(args, onProgress) {
    const error = new Error('FFmpeg任务的进度、完成与取消能力尚未接入')
    error.code = 'NOT_SUPPORTED'
    throw error
  }
}

// 导出类(不导出单例,由client.js实例化)
export default ProcessAPI
