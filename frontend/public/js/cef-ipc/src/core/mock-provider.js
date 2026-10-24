// ============================================================
// Mock Provider - 智能 Mock 数据提供者
// 职责: 根据方法名自动生成合理的 Mock 响应
// ============================================================

class MockProvider {
  constructor() {
    // Mock 数据缓存（模拟持久化状态）
    this._cache = new Map()
    // Mock 文件对象缓存（用于文件对话框选择的文件）
    this._mockFiles = new Map()
    // Mock数据统一存放目录（仅浏览器预览用的示例路径，不对应任何真实目录）
    this._mockDataPath = 'C:\\ZTools\\MockData'
    this._initCache()
  }

  /**
   * 初始化缓存
   */
  _initCache() {
    // 从 localStorage 恢复缓存
    try {
      const cached = localStorage.getItem('ztools_mock_cache')
      if (cached) {
        const data = JSON.parse(cached)
        this._cache = new Map(Object.entries(data))
      }
    } catch (e) {}
  }

  /**
   * 保存缓存到 localStorage
   */
  _saveCache() {
    try {
      const data = Object.fromEntries(this._cache.entries())
      localStorage.setItem('ztools_mock_cache', JSON.stringify(data))
    } catch (e) {}
  }

  /**
   * 生成 Mock 响应
   * @param {string} method - 方法名
   * @param {object} params - 参数
   * @returns {object} Mock 响应
   */
  generate(method, params) {
    if (method === 'db_put_secure' || method === 'db_get_secure' || method.startsWith('credential_v1_')) {
      console.log('[mock-provider] 生成 Mock 响应:', method)
    } else {
      console.log('[mock-provider] 生成 Mock 响应:', method, params)
    }

    // 1. 特殊方法处理（优先级最高）
    const specialHandler = this._getSpecialHandler(method)
    if (specialHandler) {
      return specialHandler.call(this, params)
    }

    // 2. 根据方法前缀分类处理
    const prefix = method.split('_')[0]

    switch (prefix) {
      case 'filesystem':
      case 'fs':
        return this._mockFileSystem(method, params)

      case 'db':
        return this._mockDatabase(method, params)

      case 'credential':
        return this._mockDatabase(method, params)

      case 'system':
      case 'app':
        return this._mockSystem(method, params)

      case 'window':
        return this._mockWindow(method, params)

      case 'plugin':
        return this._mockPlugin(method, params)

      case 'settings':
        return this._mockSettings(method, params)

      case 'clipboard':
        return this._mockClipboard(method, params)

      case 'screen':
        return this._mockScreen(method, params)

      case 'shell':
        return this._mockShell(method, params)

      case 'network':
        return this._mockNetwork(method, params)

      case 'process':
        return this._mockProcess(method, params)

      case 'ocr':
        return this._mockOCR(method, params)

      case 'dllplugin':
        return this._mockDLLPlugin(method, params)

      case 'image':
        return this._mockImage(method, params)

      default:
        return this._mockDefault(method, params)
    }
  }

  /**
   * 获取特殊方法处理器
   */
  _getSpecialHandler(method) {
    const specialHandlers = {
      app_ready: () => ({ success: true, message: 'Mock environment ready' })
    }
    return specialHandlers[method]
  }

  /**
   * Mock 文件系统 API
   */
  _mockFileSystem(method, params) {
    const handlers = {
      filesystem_read_file: async () => {
        // 如果有 _mockFile 对象（从文件对话框选择的），读取真实内容
        if (params._mockFile) {
          try {
            const content = await params._mockFile.text()
            return {
              success: true,
              content: content
            }
          } catch (e) {
            console.error('[Mock] 读取文件失败:', e)
          }
        }

        // 否则返回模拟内容
        return {
          success: true,
          content: btoa('这是 Mock 文件内容\nMock file content'),
          encoding: 'base64'
        }
      },
      filesystem_write_file: () => {
        // 在浏览器环境下，使用下载 API
        if (params._mockBrowserDownload && params.content) {
          const blob = new Blob([params.content], {
            type: params.filePath?.endsWith('.json')
              ? 'application/json'
              : 'text/plain'
          })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = params.filePath?.split(/[/\\]/).pop() || 'download.txt'
          a.click()
          URL.revokeObjectURL(url)
          console.log('[Mock 文件写入] 已触发下载:', a.download)
        }
        return { success: true }
      },
      filesystem_write_file_start: () => ({ success: true }),
      filesystem_write_file_chunk: () => ({ success: true }),
      filesystem_write_file_end: () => ({ success: true, finalSize: 1024 }),
      filesystem_file_exists: () => ({ success: true, exists: true }),
      filesystem_directory_exists: () => ({ success: true, exists: true }),
      filesystem_get_file_size: () => ({ success: true, size: 1024 }),
      filesystem_get_current_directory: () => ({
        success: true,
        path: this._mockDataPath
      }),
      filesystem_get_directory_contents: () => ({
        success: true,
        files: ['mock-file1.txt', 'mock-file2.txt', 'mock-folder']
      }),
      filesystem_get_file_name: () => ({
        success: true,
        name: params.path ? params.path.split(/[/\\]/).pop() : 'mock-file.txt'
      }),
      filesystem_get_extension: () => ({
        success: true,
        extension: '.txt'
      }),
      filesystem_get_parent_directory: () => ({
        success: true,
        path: this._mockDataPath.split('\\').slice(0, -1).join('\\')
      }),
      filesystem_copy_file: () => ({ success: true }),
      filesystem_move_file: () => ({ success: true }),
      filesystem_delete_file: () => ({ success: true }),
      filesystem_create_directory: () => ({ success: true }),
      filesystem_delete_directory: () => ({ success: true }),
      filesystem_find_files: () => ({
        success: true,
        files: ['file1.txt', 'file2.doc']
      }),
      filesystem_get_full_path: () => ({
        success: true,
        path: `${this._mockDataPath}\\${params.path || 'path'}`
      }),
      filesystem_combine_path: () => ({
        success: true,
        path: `${params.path1}\\${params.path2}`
      }),
      filesystem_read_file_chunk: () => ({
        success: true,
        content: btoa('Mock chunk content'),
        encoding: 'base64',
        chunkIndex: params.chunkIndex || 0,
        isLast: params.chunkIndex >= 10
      }),
      filesystem_set_current_directory: () => {
        this._cache.set('current_directory', params.path)
        return { success: true }
      },
      filesystem_find_directories: () => ({
        success: true,
        files: ['mock-dir1', 'mock-dir2']
      })
    }

    const handler = handlers[method]
    return handler ? handler() : this._mockDefault(method, params)
  }

  /**
   * Mock 数据库 API - 完整实现（使用 localStorage）
   */
  _mockDatabase(method, params) {
    const handlers = {
      // 获取值
      db_get: () => {
        const value = this._dbGet(params.plugin_id, params.key)
        return {
          success: true,
          value: value
        }
      },

      // 设置值
      db_put: () => {
        const success = this._dbPut(params.plugin_id, params.key, params.value)
        return {
          success: success
        }
      },

      // 删除值
      db_delete: () => {
        const success = this._dbDelete(params.plugin_id, params.key)
        return {
          success: success
        }
      },

      // 查询（获取所有文档）
      db_query: () => {
        const data = this._dbQuery(
          params.plugin_id,
          params.prefix || '',
          params.limit || 0
        )
        return {
          success: true,
          data: data
        }
      },

      // 批量操作
      db_batch: () => {
        const success = this._dbBatch(params.plugin_id, params.operations)
        return {
          success: success
        }
      },

      // 存储加密数据
      db_put_secure: () => ({
        success: false,
        error: { code: 'NOT_SUPPORTED', message: 'Mock 环境不支持安全凭据存储' }
      }),

      // 读取加密数据
      db_get_secure: () => ({
        success: false,
        error: { code: 'NOT_SUPPORTED', message: 'Mock 环境不支持安全凭据存储' }
      }),

      // Credentials are never written to browser/mock storage.
      credential_v1_status: () => ({
        success: true,
        data: { status: 'unavailable', reason: 'encryption-unavailable' }
      }),
      credential_v1_set: () => ({
        success: false,
        error: { code: 'NOT_SUPPORTED', message: 'Mock 环境不支持安全凭据存储' }
      }),
      credential_v1_get: () => ({
        success: false,
        error: { code: 'NOT_SUPPORTED', message: 'Mock 环境不支持安全凭据存储' }
      }),
      credential_v1_delete: () => ({
        success: false,
        error: { code: 'NOT_SUPPORTED', message: 'Mock 环境不支持安全凭据存储' }
      })
    }

    const handler = handlers[method]
    if (handler) {
      return handler()
    }

    return {
      success: false,
      error: `Unknown database method: ${method}`
    }
  }

  /**
   * 生成 localStorage 的 key（带插件ID命名空间）
   */
  _getDbKey(pluginId, key) {
    return `ztools_db_${pluginId}_${key}`
  }

  /**
   * 从 localStorage 获取值
   */
  _dbGet(pluginId, key) {
    try {
      const storageKey = this._getDbKey(pluginId, key)
      const value = localStorage.getItem(storageKey)
      if (value === null) {
        return null
      }
      // 尝试解析 JSON
      try {
        return JSON.parse(value)
      } catch {
        // 如果不是 JSON，直接返回字符串
        return value
      }
    } catch (e) {
      console.error('[Mock DB] 读取失败:', e)
      return null
    }
  }

  /**
   * 保存值到 localStorage
   */
  _dbPut(pluginId, key, value) {
    try {
      const storageKey = this._getDbKey(pluginId, key)
      // 如果是对象，序列化为 JSON；否则直接存储
      const storageValue =
        typeof value === 'string' ? value : JSON.stringify(value)
      localStorage.setItem(storageKey, storageValue)
      return true
    } catch (e) {
      console.error('[Mock DB] 写入失败:', e)
      return false
    }
  }

  /**
   * 从 localStorage 删除值
   */
  _dbDelete(pluginId, key) {
    try {
      const storageKey = this._getDbKey(pluginId, key)
      localStorage.removeItem(storageKey)
      return true
    } catch (e) {
      console.error('[Mock DB] 删除失败:', e)
      return false
    }
  }

  /**
   * 查询所有匹配的键值对
   */
  _dbQuery(pluginId, prefix, limit) {
    const results = []
    const prefixKey = this._getDbKey(pluginId, prefix)

    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith(prefixKey)) {
          const value = localStorage.getItem(key)
          // 提取实际的 key（去掉 ztools_db_{pluginId}_ 前缀）
          const actualKey = key.substring(this._getDbKey(pluginId, '').length)

          results.push({
            key: actualKey,
            value: value
          })

          // 如果有限制，检查是否达到限制
          if (limit > 0 && results.length >= limit) {
            break
          }
        }
      }
    } catch (e) {
      console.error('[Mock DB] 查询失败:', e)
    }

    return results
  }

  /**
   * 批量操作
   */
  _dbBatch(pluginId, operations) {
    try {
      for (const op of operations) {
        if (op.op === 'put') {
          this._dbPut(pluginId, op.key, op.value)
        } else if (op.op === 'delete') {
          this._dbDelete(pluginId, op.key)
        }
      }
      return true
    } catch (e) {
      console.error('[Mock DB] 批量操作失败:', e)
      return false
    }
  }

  /**
   * Mock 系统 API
   */
  _mockSystem(method, params) {
    const handlers = {
      system_notify: () => {
        console.log(`[Mock 通知] ${params.title}: ${params.message}`)
        return { success: true }
      },
      app_system_info: () => ({
        success: true,
        os: 'Windows 10 (Mock)',
        version: '1.0.0-mock',
        platform: 'x64'
      }),
      system_get_native_id: () => ({
        success: true,
        nativeId: 'mock-native-id-12345'
      }),
      system_get_app_name: () => ({
        success: true,
        appName: 'ZTools (Mock)'
      }),
      system_get_app_version: () => ({
        success: true,
        appVersion: '1.0.0-mock'
      }),
      system_get_path: () => ({
        success: true,
        path: `${this._mockDataPath}\\${params.name || 'path'}`
      }),
      system_get_platform: () => ({
        success: true,
        platform: 'unknown',
        isWindows: false,
        isMacOS: false,
        isLinux: false
      }),
      system_set_dark_mode: () => {
        console.log('[Mock] 设置暗黑模式:', params.dark)
        return { success: true }
      },
      system_get_file_icon: () => ({
        success: true,
        icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      }),
      system_read_current_folder: () => ({
        success: true,
        path: `${this._mockDataPath}\\CurrentFolder`
      }),
      system_read_current_browser_url: () => ({
        success: true,
        url: window.location.href,
        browser: 'Mock Browser'
      }),
      system_is_dev: () => ({
        success: true,
        isDev:
          window.location.hostname === 'localhost' ||
          window.location.hostname === '127.0.0.1'
      }),
      system_shutdown: () => {
        console.warn('[Mock] 关机操作已模拟（无实际效果）')
        return { success: true }
      },
      system_restart: () => {
        console.warn('[Mock] 重启操作已模拟（无实际效果）')
        return { success: true }
      },
      system_logout: () => {
        console.warn('[Mock] 注销操作已模拟（无实际效果）')
        return { success: true }
      },
      system_lock: () => {
        console.warn('[Mock] 锁定屏幕已模拟（无实际效果）')
        return { success: true }
      },
      system_sleep: () => {
        console.warn('[Mock] 睡眠操作已模拟（无实际效果）')
        return { success: true }
      },
      system_hibernate: () => {
        console.warn('[Mock] 休眠操作已模拟（无实际效果）')
        return { success: true }
      },
      system_prevent_sleep: () => {
        console.warn('[Mock] 防止休眠操作已模拟：', params.enable)
        return { success: true, enabled: params.enable }
      }
    }

    const handler = handlers[method]
    if (handler) return handler()

    // 电源管理、热键、键鼠模拟等操作类 API
    if (method.startsWith('system_')) {
      console.warn(`[Mock] ${method} - 操作已模拟，但无实际效果`)
      return { success: true }
    }

    return this._mockDefault(method, params)
  }

  /**
   * Mock 窗口 API
   */
  _mockWindow(method, params) {
    const handlers = {
      window_open: () => {
        console.log('[Mock] 打开窗口:', params.url)
        if (params.url) {
          window.open(params.url, '_blank')
        }
        return { success: true }
      },
      window_close: () => {
        console.log('[Mock] 关闭窗口已模拟')
        return { success: true }
      },
      window_minimize: () => {
        console.log('[Mock] 最小化窗口已模拟')
        return { success: true }
      },
      window_maximize: () => {
        console.log('[Mock] 最大化窗口已模拟')
        return { success: true }
      },
      window_fullscreen_toggle: () => {
        console.log('[Mock] 切换全屏已模拟')
        return { success: true }
      },
      window_drag: () => {
        console.log('[Mock] 拖动窗口已模拟')
        return { success: true }
      },
      window_get_bounds: () => ({
        success: true,
        x: 100,
        y: 100,
        width: 1200,
        height: 800
      }),
      window_show_open_dialog: () => {
        // 在浏览器环境下，使用文件选择对话框
        return new Promise((resolve) => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = params.filters?.includes('json')
            ? '.json'
            : params.filters?.includes('image')
              ? 'image/*'
              : '*'

          input.onchange = (e) => {
            const file = e.target.files?.[0]
            if (file) {
              // 模拟文件路径（统一使用MockData目录）
              const mockPath = `${this._mockDataPath}\\${file.name}`
              console.log('[Mock 文件对话框] 已选择:', mockPath)

              // 将文件对象存储到缓存中，供后续 API 调用使用
              this._mockFiles.set(mockPath, file)

              resolve({
                canceled: false,
                filePath: mockPath,
                _mockFile: file // 保存真实文件对象，供后续使用
              })
            } else {
              resolve({ canceled: true })
            }
          }

          input.oncancel = () => {
            resolve({ canceled: true })
          }

          input.click()
        })
      },
      window_show_save_dialog: () => {
        // 在浏览器环境下，返回模拟路径（统一使用MockData目录）
        console.log('[Mock 保存对话框]', params)
        const fileName =
          params.defaultName ||
          (params.defaultPath
            ? params.defaultPath.split(/[/\\]/).pop()
            : 'saved-file.txt')
        return {
          canceled: false,
          filePath: `${this._mockDataPath}\\${fileName}`,
          _mockBrowserDownload: true // 标记需要使用浏览器下载
        }
      },
      window_show_select_folder_dialog: () => {
        // 在浏览器环境下，返回模拟文件夹路径
        console.log('[Mock 选择文件夹对话框]', params)
        const folderName = params.defaultPath
          ? params.defaultPath.split(/[/\\]/).pop()
          : 'selected-folder'
        return {
          canceled: false,
          folderPath: `${this._mockDataPath}\\${folderName}`
        }
      },
      window_hide: () => {
        console.log('[Mock] 窗口隐藏已模拟')
        return { success: true }
      },
      window_show: () => {
        console.log('[Mock] 显示窗口已模拟')
        return { success: true }
      },
      pluginwin_hide: () => {
        console.log('[Mock] 隐藏插件窗口已模拟')
        return { success: true }
      },
      pluginwin_show: () => {
        console.log('[Mock] 显示插件窗口已模拟')
        return { success: true }
      },
      pluginwin_minimize: () => {
        console.log('[Mock] 最小化插件窗口已模拟')
        return { success: true }
      },
      pluginwin_restore: () => {
        console.log('[Mock] 恢复插件窗口已模拟')
        return { success: true }
      },
      window_set_height: () => {
        console.log('[Mock] 设置窗口高度:', params.height)
        return { success: true }
      },
      window_out_plugin: () => {
        console.log('[Mock] 退出插件模式已模拟')
        return { success: true }
      },
      window_redirect: () => {
        console.log('[Mock] 跳转到:', params.url)
        if (params.url) {
          window.location.href = params.url
        }
        return { success: true }
      },
      window_set_size: () => {
        console.log('[Mock] 设置窗口大小:', params.width, params.height)
        return { success: true }
      },
      window_set_opacity: () => {
        console.log('[Mock] 设置窗口透明度:', params.opacity)
        return { success: true }
      },
      window_set_always_on_top: () => {
        console.log('[Mock] 设置窗口置顶:', params.alwaysOnTop)
        return { success: true }
      },
      window_show_tooltip: () => {
        console.log('[Mock] 显示原生 Tooltip:', params.text)
        return { success: true }
      },
      window_hide_tooltip: () => {
        console.log('[Mock] 隐藏原生 Tooltip')
        return { success: true }
      }
    }

    const handler = handlers[method]
    if (handler) return handler()

    // 其他窗口操作
    console.warn(`[Mock] ${method} - 窗口操作已模拟`)
    return { success: true }
  }

  /**
   * Mock 插件 API
   */
  _mockPlugin(method, params) {
    const handlers = {
      plugin_list_get: () => ({
        success: true,
        plugins: [
          { id: 'mock-plugin-1', name: 'Mock Plugin 1', enabled: true },
          { id: 'mock-plugin-2', name: 'Mock Plugin 2', enabled: false }
        ]
      }),
      plugin_create_shortcut: () => {
        console.log('[Mock] 创建桌面快捷方式:', params.pluginId)
        return { success: true, message: '快捷方式已创建 (Mock)' }
      }
    }

    const handler = handlers[method]
    return handler ? handler() : { success: true }
  }

  /**
   * Mock 设置 API
   */
  _mockSettings(method, params) {
    const cacheKey = `settings_${params.key}`

    if (method === 'settings_get') {
      return {
        success: true,
        value: this._cache.get(cacheKey) || null
      }
    }

    if (method === 'settings_set') {
      this._cache.set(cacheKey, params.value)
      this._saveCache()
      return { success: true }
    }

    // Config API
    if (method === 'config_get') {
      const configKey = `config_${params.file}_${params.path}`
      return {
        success: true,
        value: this._cache.get(configKey) || params.default || ''
      }
    }

    if (method === 'config_set') {
      const configKey = `config_${params.file}_${params.path}`
      this._cache.set(configKey, params.value)
      this._saveCache()
      return { success: true }
    }

    return { success: true }
  }

  /**
   * Mock 剪贴板 API
   */
  _mockClipboard(method, params) {
    const handlers = {
      clipboard_read_text: () => ({
        success: true,
        text: this._cache.get('clipboard_text') || 'Mock clipboard text'
      }),
      clipboard_copy_text: async () => {
        // 在浏览器环境下使用真实的剪贴板 API
        this._cache.set('clipboard_text', params.text)
        console.log('[Mock 剪贴板] 已复制:', params.text)

        // 尝试使用浏览器剪贴板 API
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(params.text)
          }
        } catch (e) {
          console.warn('[Mock] 浏览器剪贴板 API 不可用:', e)
        }

        return { success: true }
      },
      clipboard_copy_image: () => {
        this._cache.set('clipboard_image', params.image)
        console.log('[Mock 剪贴板] 已复制图片')
        return { success: true }
      },
      clipboard_copy_file: () => {
        console.log('[Mock 剪贴板] 已复制文件:', params.filePath)
        return { success: true }
      },
      clipboard_copy_files: () => {
        const filePaths = params.filePaths || []
        console.log('[Mock 剪贴板] 已复制文件列表:', filePaths)
        return { success: true, count: filePaths.length }
      },
      clipboard_read_image: () => {
        const cachedImage = this._cache.get('clipboard_image')
        // 模拟大图片：如果Base64长度超过阈值，返回临时文件
        const mockBase64Size = cachedImage ? cachedImage.length : 100
        const MAX_SIZE = 2 * 1024 * 1024 // 2MB

        if (mockBase64Size > MAX_SIZE) {
          // 大图片：返回临时文件（统一使用MockData目录）
          return {
            success: true,
            useTempFile: true,
            tempFile: `${this._mockDataPath}\\clipboard\\clip_mock.png`,
            size: mockBase64Size,
            width: 1920,
            height: 1080
          }
        } else {
          // 小图片：返回Base64
          return {
            success: true,
            useTempFile: false,
            image:
              cachedImage ||
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
          }
        }
      },
      clipboard_read_files: () => ({
        success: true,
        files: []
      }),
      clipboard_hide_and_paste_text: () => {
        console.log('[Mock] 隐藏窗口并粘贴文本:', params.text)
        return { success: true }
      },
      clipboard_hide_and_paste_image: () => {
        console.log('[Mock] 隐藏窗口并粘贴图片')
        return { success: true }
      },
      clipboard_hide_and_paste_file: () => {
        console.log('[Mock] 隐藏窗口并粘贴文件:', params.filePath)
        return { success: true }
      },
      clipboard_hide_and_type: () => {
        console.log('[Mock] 隐藏窗口并输入文本:', params.text)
        return { success: true }
      },
      clipboard_clear: () => {
        this._cache.delete('clipboard_text')
        this._cache.delete('clipboard_image')
        console.log('[Mock 剪贴板] 已清空')
        return { success: true }
      }
    }

    const handler = handlers[method]
    if (handler) return handler()

    console.warn(`[Mock] ${method} - 剪贴板操作已模拟`)
    return { success: true }
  }

  /**
   * Mock 屏幕 API
   */
  _mockScreen(method, params) {
    const handlers = {
      screen_capture: () => ({
        success: true,
        // 1x1 透明 PNG
        image:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      }),
      screen_get_cursor_pos: () => ({
        success: true,
        x: 500,
        y: 300
      }),
      screen_get_primary_display: () => ({
        success: true,
        display: {
          id: 0,
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 }
        }
      }),
      screen_get_all_displays: () => ({
        success: true,
        displays: [
          {
            id: 0,
            bounds: { x: 0, y: 0, width: 1920, height: 1080 }
          }
        ]
      })
    }

    const handler = handlers[method]
    return handler ? handler() : { success: true }
  }

  /**
   * Mock Shell API
   */
  _mockShell(method, params) {
    const handlers = {
      shell_exec: () => ({
        success: true,
        stdout: 'Mock command output',
        stderr: '',
        exitCode: 0
      })
    }

    const handler = handlers[method]
    if (handler) return handler()

    console.warn(`[Mock] ${method} - Shell 操作已模拟`)
    return { success: true }
  }

  /**
   * Mock 网络 API
   */
  _mockNetwork(method, params) {
    const handlers = {
      network_http_request: () => ({
        success: true,
        data: {
          statusCode: 200,
          statusText: 'OK',
          body: JSON.stringify({ mock: true, message: 'Mock HTTP response' })
        }
      }),
      network_http_download: () => ({
        success: true,
        path: params.savePath || `${this._mockDataPath}\\downloaded-file.dat`,
        size: 1024
      }),
      network_http_upload: () => ({
        success: true,
        statusCode: 200,
        statusText: 'OK',
        body: JSON.stringify({ mock: true, message: 'Mock upload response' })
      }),
      network_get_cookie: () => [],
      network_set_cookie: () => {
        console.log('[Mock] 设置 Cookie:', params)
        return { success: true }
      },
      network_clear_cookies: () => {
        console.log('[Mock] 清空 Cookies')
        return { success: true }
      },
      network_set_proxy: () => {
        console.log('[Mock] 设置代理:', params)
        return { success: true }
      }
    }

    const handler = handlers[method]
    if (handler) return handler()

    return { success: true }
  }

  /**
   * Mock 进程 API
   */
  _mockProcess(method, params) {
    const handlers = {
      process_list: () => ({
        success: true,
        processes: [
          { pid: 1234, name: 'mock-process.exe', cpuUsage: 5, memoryUsage: 100 }
        ]
      }),
      process_info: () => ({
        success: true,
        pid: params.pid,
        cpuUsage: 5,
        memoryUsage: 100
      }),
      process_exists: () => ({
        success: true,
        exists: true
      }),
      process_find: () => ({
        success: true,
        processes: [{ pid: 1234, name: params.name || 'mock-process.exe' }]
      }),
      process_start: () => ({
        success: true,
        pid: Math.floor(Math.random() * 10000)
      }),
      process_kill: () => {
        console.log('[Mock] 终止进程:', params.pid)
        return { success: true }
      },
      process_kill_by_name: () => {
        console.log('[Mock] 按名称终止进程:', params.name)
        return { success: true }
      },
      process_wait: () => {
        console.log('[Mock] 等待进程:', params.pid)
        return { success: true }
      },
      process_get_window: () => ({
        success: true,
        hwnd: 0x12345678,
        title: 'Mock Window',
        className: 'MockClass'
      }),
      process_run_ffmpeg: () => ({
        success: true,
        taskId: 'mock-ffmpeg-task-' + Date.now()
      })
    }

    const handler = handlers[method]
    return handler ? handler() : { success: true }
  }

  /**
   * Mock OCR API
   */
  _mockOCR(method, params) {
    return {
      success: true,
      text: 'Mock OCR 识别结果\nMock OCR text result',
      blocks: [{ text: 'Mock OCR', x: 10, y: 10, width: 100, height: 30 }]
    }
  }

  /**
   * Mock DLL Plugin API
   */
  _mockDLLPlugin(method, params) {
    const handlers = {
      dllplugin_list: () => ({
        success: true,
        plugins: []
      }),
      dllplugin_call: () => ({
        success: false,
        error: 'DLL 插件在 Mock 环境下不可用，请在 ZTools 应用中运行'
      }),
      dllplugin_call_async: () => ({
        success: false,
        error: 'DLL 插件在 Mock 环境下不可用，请在 ZTools 应用中运行'
      }),
      dllplugin_query_task: () => ({
        success: true,
        status: 'completed',
        progress: 100,
        result: { mock: true }
      }),
      dllplugin_cancel_task: () => {
        console.log('[Mock] 取消 DLL 插件任务:', params.taskId)
        return { success: true }
      },
      dllplugin_clear_callback_task: () => {
        return { success: true, removed: true }
      }
    }

    const handler = handlers[method]
    return handler
      ? handler()
      : {
          success: false,
          error: `DLL Plugin method ${method} not available in mock environment`
        }
  }

  /**
   * Mock 图像处理 API
   */
  _mockImage(method, params) {
    const handlers = {
      image_decode_qr: async () => {
        // 尝试真实识别二维码（如果可能）
        console.log('[Mock 图像] 二维码识别:', params)

        const imagePath = params.input || params.image || params
        let decodedText = null

        // 如果是 data URL，尝试使用 Canvas API 和 jsQR 识别
        if (typeof imagePath === 'string' && imagePath.startsWith('data:')) {
          try {
            // 尝试使用全局 jsQR（如果可用）
            if (typeof window !== 'undefined' && window.jsQR) {
              decodedText = await this._decodeQRFromDataURL(
                imagePath,
                window.jsQR
              )
            }
          } catch (e) {
            console.warn('[Mock] 二维码识别失败，使用 Mock 数据:', e)
          }
        }

        // 如果是文件路径（Mock 环境），尝试从缓存中获取文件对象并识别
        if (
          !decodedText &&
          typeof imagePath === 'string' &&
          imagePath.startsWith(this._mockDataPath)
        ) {
          // 从缓存中获取文件对象
          const mockFile = this._mockFiles.get(imagePath) || params._mockFile
          if (mockFile) {
            try {
              const dataUrl = await this._fileToDataURL(mockFile)
              if (typeof window !== 'undefined' && window.jsQR) {
                decodedText = await this._decodeQRFromDataURL(
                  dataUrl,
                  window.jsQR
                )
              }
            } catch (e) {
              console.warn('[Mock] 从文件识别二维码失败:', e)
            }
          }
        }

        // 返回结果（格式与真实 API 一致：{text, format}）
        // 注意：dllplugin.call 的 Mock 处理会包装为 {success: true, result: {...}} 格式
        // 但这里返回的是 DLL 插件期望的格式
        return JSON.stringify({
          text:
            decodedText ||
            'otpauth://totp/MockAccount?secret=JBSWY3DPEHPK3PXP&issuer=MockIssuer',
          format: 'QR_CODE'
        })
      },
      image_encode_qr: () => ({
        success: true,
        image:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      }),
      image_resize: () => ({
        success: true,
        image: params.image
      })
    }

    const handler = handlers[method]
    if (handler) {
      const result = handler()
      // 如果是 Promise，返回 Promise，否则直接返回
      return result instanceof Promise ? result : Promise.resolve(result)
    }

    console.warn(`[Mock] ${method} - 图像操作已模拟`)
    return { success: true }
  }

  /**
   * 从 data URL 解码二维码
   */
  async _decodeQRFromDataURL(dataUrl, jsQR) {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas')
          canvas.width = img.width
          canvas.height = img.height
          const ctx = canvas.getContext('2d')
          ctx.drawImage(img, 0, 0)

          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
          })

          if (code && code.data) {
            resolve(code.data)
          } else {
            resolve(null)
          }
        } catch (e) {
          console.error('[Mock] 二维码识别错误:', e)
          resolve(null)
        }
      }
      img.onerror = () => {
        resolve(null)
      }
      img.src = dataUrl
    })
  }

  /**
   * 将文件转换为 data URL
   */
  _fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = (e) => resolve(e.target.result)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  /**
   * 默认 Mock 响应
   */
  _mockDefault(method, params) {
    console.warn(`[Mock] 未找到 ${method} 的专用 Mock 处理器，返回通用响应`)
    return {
      success: true,
      mock: true,
      method,
      params,
      message: `Mock response for ${method}`
    }
  }
}

export default MockProvider
