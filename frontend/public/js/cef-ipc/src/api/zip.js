/**
 * Zip API - 压缩与解压功能
 * 封装 ZipPlugin.dll 提供压缩解压功能
 */
class ZipAPI {
  constructor(dllplugin, transport) {
    this.transport = transport
    this.dllplugin = dllplugin
    // 自动检测当前 JS 插件 ID
    this.jsPluginId =
      typeof window !== 'undefined' && window.__ztools_plugin_id
        ? window.__ztools_plugin_id
        : null
  }

  /**
   * 获取插件名称（自动回退查找）
   * 优先使用 JS 插件的专用 DLL，如果不存在则使用系统公共 DLL
   * @private
   */
  async _getPluginName() {
    // // 如果是 JS 插件（不是主窗口），先尝试 JS 专用 DLL
    // if (this.jsPluginId && this.jsPluginId !== 'main') {
    //   const jsPluginName = `${this.jsPluginId}::ZipPlugin`
    //   const exists = await this.dllplugin.exists(jsPluginName)
    //   if (exists) {
    //     return jsPluginName
    //   }
    // }
    // 回退到系统公共 DLL
    return 'ZipPlugin'
  }

  /**
   * 压缩文件或目录
   * @param {Object} options - 压缩选项
   * @param {string|string[]} options.sources - 源文件或目录路径（单个路径字符串或路径数组）
   * @param {string} options.output - 输出的压缩文件路径
   * @param {string} [options.format='zip'] - 压缩格式（默认zip）
   * @param {string} [options.password=''] - 压缩密码（可选）
   * @param {number} [options.level=6] - 压缩级别 0-9（0=不压缩，9=最大压缩）
   * @param {boolean} [options.storePaths=true] - 是否在压缩包中保留源文件路径
   * @param {Function} [options.onProgress] - 进度回调函数 (percent, message) => void
   * @returns {Promise<boolean>} 压缩是否成功
   *
   * @example
   * // 压缩单个文件
   * await zip.compress({
   *   sources: 'D:\\test\\file.txt',
   *   output: 'D:\\test\\output.zip'
   * })
   *
   * @example
   * // 压缩多个文件
   * await zip.compress({
   *   sources: ['D:\\test\\file1.txt', 'D:\\test\\file2.txt'],
   *   output: 'D:\\test\\output.zip',
   *   level: 9
   * })
   *
   * @example
   * // 压缩目录（带进度）
   * await zip.compress({
   *   sources: 'D:\\test\\folder',
   *   output: 'D:\\test\\output.zip',
   *   password: '123456',
   *   onProgress: (percent, message) => {
   *     console.log(`压缩进度: ${percent}% - ${message}`)
   *   }
   * })
   */
  async compress(options) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      const refs = new ReferenceFileSystemAPI(this.transport)
      refs._options(options, ['sources', 'output', 'format', 'password', 'level', 'storePaths', 'replace', 'signal'])
      if ((options.format !== undefined && options.format !== 'zip') || (options.password !== undefined && options.password !== '') || (options.storePaths !== undefined && typeof options.storePaths !== 'boolean')) throw refs._error('NOT_SUPPORTED', '当前引用provider只生成未加密ZIP')
      const sources = Array.isArray(options.sources) ? options.sources : [options.sources]
      if (!sources.length || sources.length > 64 || !Number.isInteger(options.level ?? 6) || (options.level ?? 6) < 0 || (options.level ?? 6) > 9 || (options.replace !== undefined && typeof options.replace !== 'boolean')) throw refs._error('INVALID_REQUEST', 'ZIP来源/压缩级别无效')
      const result = await refs._call('zip_compress', { fileGrantIds: sources.map(source => refs._reference(source, ['file', 'directory'], 'read')), saveGrantId: refs._reference(options.output, ['save'], 'write'), level: options.level ?? 6, replace: options.replace ?? false, storePaths: options.storePaths ?? true }, { signal: options.signal })
      if (result.status !== 'committed' || result.sourceCount !== sources.length || !Number.isSafeInteger(result.fileCount) || result.fileCount < 0 || result.fileCount > 1024 || !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 16 * 1024 * 1024) throw refs._error('FILE_WRITE_OUTCOME_UNKNOWN', 'ZIP保存结果未确认')
      return true
    }
    const {
      sources,
      output,
      format = 'zip',
      password = '',
      level = 6,
      storePaths = true,
      onProgress
    } = options

    if (!sources || !output) {
      throw new Error('sources 和 output 参数必填')
    }

    // 统一处理 sources 为字符串（多个路径用逗号分隔）
    const sourcesStr = Array.isArray(sources) ? sources.join(',') : sources

    const params = {
      sources: sourcesStr,
      output,
      format,
      password,
      level: Math.max(0, Math.min(9, level)), // 确保在0-9范围内
      storePaths: storePaths !== false
    }

    // 如果有进度回调，使用异步调用
    if (onProgress && typeof onProgress === 'function') {
      const pluginName = await this._getPluginName()
      const taskId = await this.dllplugin.callAsync(
        pluginName,
        'Compress',
        params
      )

      // 监听进度事件
      const progressHandler = (event) => {
        if (event.taskId === taskId) {
          onProgress(event.percent, event.message)
        }
      }

      this.dllplugin.on('progress', progressHandler)

      try {
        const result = await this.dllplugin.waitTask(taskId)
        this.dllplugin.off('progress', progressHandler)
        return result && result.result === true
      } catch (error) {
        this.dllplugin.off('progress', progressHandler)
        throw error
      }
    } else {
      // 无进度回调，使用同步调用
      const pluginName = await this._getPluginName()
      const result = await this.dllplugin.call(pluginName, 'Compress', params)
      return result && result.result === true
    }
  }

  /**
   * 解压文件
   * @param {Object} options - 解压选项
   * @param {string} options.archive - 压缩包文件路径
   * @param {string} options.output - 解压输出目录
   * @param {string} [options.password=''] - 解压密码（可选）
   * @param {Function} [options.onProgress] - 进度回调函数 (percent, message) => void
   * @returns {Promise<boolean>} 解压是否成功
   *
   * @example
   * // 解压文件
   * await zip.extract({
   *   archive: 'D:\\test\\archive.zip',
   *   output: 'D:\\test\\extracted'
   * })
   *
   * @example
   * // 解压加密文件（带进度）
   * await zip.extract({
   *   archive: 'D:\\test\\archive.zip',
   *   output: 'D:\\test\\extracted',
   *   password: '123456',
   *   onProgress: (percent, message) => {
   *     console.log(`解压进度: ${percent}% - ${message}`)
   *   }
   * })
   */
  async extract(options) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      const refs = new ReferenceFileSystemAPI(this.transport)
      refs._options(options, ['archive', 'output', 'password', 'replace', 'signal'])
      if ((options.password !== undefined && options.password !== '') || options.replace === true) throw refs._error('NOT_SUPPORTED', '引用解压仅支持未加密ZIP且不覆盖已有文件')
      const result = await refs._call('zip_extract', { fileGrantId: refs._reference(options.archive, ['file'], 'read'), directoryGrantId: refs._reference(options.output, ['directory'], 'write') }, { signal: options.signal })
      if (!['committed', 'partial'].includes(result.status) || !Array.isArray(result.completed) || !Array.isArray(result.createdDirectories) || result.completed.length > 1024 || result.createdDirectories.length > 65536 || [...result.completed, ...result.createdDirectories].some(name => typeof name !== 'string')) throw refs._error('FILE_WRITE_OUTCOME_UNKNOWN', '解压结果未确认')
      if (result.status === 'partial') throw Object.assign(refs._error(result.error?.code || 'FILE_ERROR', result.error?.message || '解压部分完成'), { completed: result.completed, createdDirectories: result.createdDirectories, uncertain: result.uncertain })
      return true
    }
    const { archive, output, password = '', onProgress } = options

    if (!archive || !output) {
      throw new Error('archive 和 output 参数必填')
    }

    const params = {
      archive,
      output,
      password
    }

    // 如果有进度回调，使用异步调用
    if (onProgress && typeof onProgress === 'function') {
      const pluginName = await this._getPluginName()
      const taskId = await this.dllplugin.callAsync(
        pluginName,
        'Extract',
        params
      )

      // 监听进度事件
      const progressHandler = (event) => {
        if (event.taskId === taskId) {
          onProgress(event.percent, event.message)
        }
      }

      this.dllplugin.on('progress', progressHandler)

      try {
        const result = await this.dllplugin.waitTask(taskId)
        this.dllplugin.off('progress', progressHandler)
        return result && result.result === true
      } catch (error) {
        this.dllplugin.off('progress', progressHandler)
        throw error
      }
    } else {
      // 无进度回调，使用同步调用
      const pluginName = await this._getPluginName()
      const result = await this.dllplugin.call(pluginName, 'Extract', params)
      return result && result.result === true
    }
  }

  /**
   * 列出压缩包内容
   * @param {string} archive - 压缩包文件路径
   * @returns {Promise<Array>} 文件列表
   *
   * @example
   * const files = await zip.list('D:\\test\\archive.zip')
   * // 返回: [
   * //   { name: 'file1.txt', size: 1024, isDirectory: false },
   * //   { name: 'file2.txt', size: 2048, isDirectory: false }
   * // ]
   */
  async list(archive, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      const refs = new ReferenceFileSystemAPI(this.transport)
      refs._options(options, ['signal'])
      const result = await refs._call('zip_list', { fileGrantId: refs._reference(archive, ['file'], 'read') }, options)
      if (!Array.isArray(result.files) || result.files.length > 1024 || result.files.some(file => !file || typeof file.name !== 'string' || typeof file.isDirectory !== 'boolean' || !Number.isSafeInteger(file.size) || file.size < 0)) throw refs._error('FILE_ERROR', 'ZIP列表响应无效')
      return result.files
    }
    if (Object.keys(options).length) throw Object.assign(new Error('当前ZIP合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
    if (!archive) {
      throw new Error('archive 参数必填')
    }

    const pluginName = await this._getPluginName()
    const result = await this.dllplugin.call(pluginName, 'List', {
      archive
    })

    return result.files || []
  }

  /**
   * 测试压缩包完整性
   * @param {string} archive - 压缩包文件路径
   * @returns {Promise<boolean>} 压缩包是否完整
   *
   * @example
   * const isValid = await zip.test('D:\\test\\archive.zip')
   * if (isValid) {
   *   console.log('压缩包完整')
   * } else {
   *   console.log('压缩包已损坏')
   * }
   */
  async test(archive, options = {}) {
    if (window.__ztoolsElectron?.contractVersion === 2) {
      const refs = new ReferenceFileSystemAPI(this.transport)
      refs._options(options, ['signal'])
      const result = await refs._call('zip_test', { fileGrantId: refs._reference(archive, ['file'], 'read') }, options)
      if (typeof result.valid !== 'boolean') throw refs._error('FILE_ERROR', 'ZIP校验响应无效')
      return result.valid
    }
    if (Object.keys(options).length) throw Object.assign(new Error('当前ZIP合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
    if (!archive) {
      throw new Error('archive 参数必填')
    }

    const pluginName = await this._getPluginName()
    const result = await this.dllplugin.call(pluginName, 'Test', {
      archive
    })

    return result && result.result === true
  }

  /**
   * 检查 ZipPlugin 是否可用
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const pluginName = await this._getPluginName()
      return await this.dllplugin.exists(pluginName)
    } catch (error) {
      console.error('[zip] 检查插件可用性失败:', error)
      return false
    }
  }

  /**
   * 获取插件信息
   * @returns {Promise<Object|null>} 插件信息
   */
  async getPluginInfo() {
    try {
      const pluginName = await this._getPluginName()
      return await this.dllplugin.getInfo(pluginName)
    } catch (error) {
      console.error('[zip] 获取插件信息失败:', error)
      return null
    }
  }
}
