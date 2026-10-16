/**
 * ZTools API - 统一前端接口
 *
 * 这是一个自动生成的文件,请勿直接修改!
 * 如需修改,请编辑 src/ 目录下的源文件,然后重新运行 build.js
 *
 * 构建时间: 2026-10-15
 * 版本: 2.0.0
 *
 * 使用方法:
 *   <script src="sdk/ztools-api.js"></script>
 *   <script>
 *     // 全局变量 ztools 自动可用
 *     await ztools.fs.readFile('test.txt');
 *     await ztools.db.get('plugin-id', 'key');
 *     await ztools.sys.notify('标题', '内容');
 *   </script>
 */

(function() {
    "use strict";

    // ========================================
    // core/environment.js
    // ========================================

    /**
     * Environment - 环境检测与适配
     * 检测运行环境，提供环境适配
     */
    class Environment {
      constructor() {
        this.type = this._detectEnvironment()
      }

      /**
       * 获取 Electron preload 暴露的受控传输层。
       * @returns {object|null}
       */
      getElectronTransport() {
        try {
          if (typeof window === 'undefined') return null
          const transport = window.__ztoolsElectron?.transport
          return transport &&
            transport.methods &&
            typeof transport.methods === 'object'
            ? transport
            : null
        } catch {
          return null
        }
      }

      /**
       * 获取 CEF 注入的 V8 绑定。
       * @returns {object|null}
       */
      getCEFBridge() {
        try {
          if (typeof window === 'undefined') return null
          const bridge = window.ztools
          return bridge && typeof bridge._sendMessage === 'function' ? bridge : null
        } catch {
          return null
        }
      }

      /**
       * 检测运行环境
       * @returns {'electron'|'cef'|'browser'} 环境类型
       */
      _detectEnvironment() {
        // Electron preload 只暴露逐方法 transport，不暴露 ipcRenderer。
        if (this.getElectronTransport()) {
          return 'electron'
        }

        // 检查是否存在 V8 绑定的特征
        if (this.getCEFBridge()) {
          return 'cef'
        }
        return 'browser'
      }

      /**
       * 判断是否在 CEF 环境中
       */
      isCEF() {
        return this.type === 'cef'
      }

      /**
       * 判断是否在 Electron 环境中
       */
      isElectron() {
        return this.type === 'electron'
      }

      /**
       * 判断是否在浏览器环境中
       */
      isBrowser() {
        return this.type === 'browser'
      }

      /**
       * 获取环境信息
       */
      getInfo() {
        return {
          type: this.type,
          isElectron: this.isElectron(),
          isCEF: this.isCEF(),
          isBrowser: this.isBrowser(),
          userAgent: navigator.userAgent,
          platform: navigator.platform
        }
      }

      /**
       * 创建环境错误
       */
      createEnvironmentError(method) {
        const errorMessage = `环境错误: ${method} 需要在 ZTools 应用中运行。当前环境: ${this.type}`

        const error = new Error(errorMessage)
        error.code = 'ENVIRONMENT_ERROR'
        error.environment = this.type
        error.method = method

        return error
      }

      /**
       * 显示环境警告(仅在浏览器环境首次显示)
       */
      showEnvironmentWarning() {
        if (this.isBrowser() && !this._warningShown) {
          this._warningShown = true

          console.warn(`
    ╔════════════════════════════════════════════════════════════╗
    ║  ⚠️ 当前在浏览器环境中 - ZTools API 需要在 ZTools 应用中运行  ║
    ╠════════════════════════════════════════════════════════════╣
    ║  环境信息:                                                 ║
    ║  - 类型: ${this.type.padEnd(48)} ║
    ╚════════════════════════════════════════════════════════════╝
                `)
        }
      }
    }

    // 创建全局单例
    const environment = new Environment()

    // ========================================
    // core/native-tooltip.js
    // ========================================

    /**
     * 在 SDK 层统一接管 HTML title，通过宿主原生 HWND 显示 Tooltip。
     * 所有加载 ztools-api.js 的 CEF 页面与插件自动生效。
     */
    class NativeTooltipInterceptor {
      static TOOLTIP_ATTRIBUTE = 'data-system-tooltip'
      static SHOW_DELAY = 500

      constructor(windowApi, options = {}) {
        this.windowApi = windowApi
        this.window = options.windowObj || window
        this.document = options.documentObj || document
        this.activeTrigger = null
        this.observer = null
        this.showTimer = 0
        this.tooltipVisible = false
        this.started = false
        this.attached = false
        this.generatedAriaLabels = new WeakMap()

        this.handleReady = this.attach.bind(this)
        this.handleMutations = this.onMutations.bind(this)
        this.handleMouseOver = this.onMouseOver.bind(this)
        this.handleMouseOut = this.onMouseOut.bind(this)
        this.handleFocusIn = this.onFocusIn.bind(this)
        this.handleFocusOut = this.onFocusOut.bind(this)
        this.handleKeyDown = this.onKeyDown.bind(this)
        this.hideTooltip = this.hideTooltip.bind(this)
      }

      start() {
        if (this.started) return
        this.started = true
        if (this.document.readyState === 'loading') {
          this.document.addEventListener('DOMContentLoaded', this.handleReady, {
            once: true
          })
        } else {
          this.attach()
        }
      }

      attach() {
        if (this.attached || !this.document.body) return
        this.attached = true
        this.document.body.querySelectorAll('[title]').forEach((element) => {
          this.normalizeTitle(element)
        })

        this.observer = new this.window.MutationObserver(this.handleMutations)
        this.observeDocument()
        this.document.addEventListener('mouseover', this.handleMouseOver, true)
        this.document.addEventListener('mouseout', this.handleMouseOut, true)
        this.document.addEventListener('focusin', this.handleFocusIn, true)
        this.document.addEventListener('focusout', this.handleFocusOut, true)
        this.document.addEventListener('keydown', this.handleKeyDown, true)
        this.document.addEventListener('scroll', this.hideTooltip, true)
        this.window.addEventListener('resize', this.hideTooltip)
        this.window.addEventListener('blur', this.hideTooltip)
      }

      observeDocument() {
        this.observer?.observe(this.document.body, {
          attributes: true,
          attributeFilter: [
            'title',
            NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE
          ],
          childList: true,
          subtree: true
        })
      }

      callNative(method, ...args) {
        try {
          return Promise.resolve(this.windowApi?.[method]?.(...args))
        } catch (error) {
          return Promise.reject(error)
        }
      }

      syncAriaLabel(element, text) {
        const generatedLabel = this.generatedAriaLabels.get(element)
        const currentLabel = element.getAttribute('aria-label')

        if (generatedLabel && currentLabel !== generatedLabel) {
          this.generatedAriaLabels.delete(element)
        }
        if (!text) {
          if (generatedLabel && currentLabel === generatedLabel) {
            element.removeAttribute('aria-label')
          }
          this.generatedAriaLabels.delete(element)
          return
        }
        if (!currentLabel || this.generatedAriaLabels.has(element)) {
          element.setAttribute('aria-label', text)
          this.generatedAriaLabels.set(element, text)
        }
      }

      normalizeTitle(element) {
        if (!(element instanceof this.window.Element)) return
        const title = element.getAttribute('title')
        if (title === null) return

        const text = title.trim()
        if (text) {
          element.setAttribute(
            NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE,
            text
          )
        } else {
          element.removeAttribute(NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE)
        }
        this.syncAriaLabel(element, text)
        // 必须在 Chromium 开始创建其合成 Tooltip 窗口前移除 title。
        element.removeAttribute('title')
      }

      normalizeTree(root) {
        if (!(root instanceof this.window.Element)) return
        this.normalizeTitle(root)
        root.querySelectorAll('[title]').forEach((element) => {
          this.normalizeTitle(element)
        })
      }

      clearManagedTooltip(element) {
        element.removeAttribute(NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE)
        this.syncAriaLabel(element, '')
        if (element === this.activeTrigger) this.hideTooltip()
      }

      syncManagedTooltip(element) {
        const text =
          element
            .getAttribute(NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE)
            ?.trim() || ''
        this.syncAriaLabel(element, text)
        if (element !== this.activeTrigger) return
        if (!text) {
          this.hideTooltip()
        } else if (this.tooltipVisible) {
          this.callNative('showTooltip', text).catch((error) =>
            console.error('[ztools] 更新原生 Tooltip 失败:', error)
          )
        }
      }

      onMutations(mutations) {
        this.observer?.disconnect()
        const titleTargets = new Set()
        const tooltipTargets = new Set()
        const addedNodes = []

        for (const mutation of mutations) {
          if (mutation.type === 'attributes') {
            if (mutation.attributeName === 'title') {
              titleTargets.add(mutation.target)
            } else {
              tooltipTargets.add(mutation.target)
            }
          } else {
            mutation.addedNodes.forEach((node) => addedNodes.push(node))
          }
        }

        titleTargets.forEach((element) => {
          if (element.hasAttribute('title')) this.normalizeTitle(element)
          else this.clearManagedTooltip(element)
        })
        addedNodes.forEach((node) => this.normalizeTree(node))
        tooltipTargets.forEach((element) => this.syncManagedTooltip(element))
        this.observeDocument()
      }

      findTrigger(target) {
        if (!(target instanceof this.window.Element)) return null
        const attribute = NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE
        const element = target.closest(`[${attribute}], [title]`)
        if (!element) return null

        if (element.hasAttribute('title')) {
          this.observer?.disconnect()
          this.normalizeTitle(element)
          this.observer?.takeRecords()
          this.observeDocument()
        }
        return element.getAttribute(attribute)?.trim() ? element : null
      }

      scheduleTooltip(element) {
        this.hideTooltip()
        const attribute = NativeTooltipInterceptor.TOOLTIP_ATTRIBUTE
        if (!element.getAttribute(attribute)?.trim()) return

        this.activeTrigger = element
        this.showTimer = this.window.setTimeout(() => {
          this.showTimer = 0
          if (this.activeTrigger !== element || !element.isConnected) return

          const text = element.getAttribute(attribute)?.trim()
          if (!text) return
          this.tooltipVisible = true
          this.callNative('showTooltip', text).catch((error) => {
            this.tooltipVisible = false
            console.error('[ztools] 显示原生 Tooltip 失败:', error)
          })
        }, NativeTooltipInterceptor.SHOW_DELAY)
      }

      hideTooltip() {
        if (this.showTimer) {
          this.window.clearTimeout(this.showTimer)
          this.showTimer = 0
        }
        this.activeTrigger = null
        if (!this.tooltipVisible) return

        this.tooltipVisible = false
        this.callNative('hideTooltip').catch((error) =>
          console.error('[ztools] 隐藏原生 Tooltip 失败:', error)
        )
      }

      onMouseOver(event) {
        const element = this.findTrigger(event.target)
        if (element && element !== this.activeTrigger) {
          this.scheduleTooltip(element)
        }
      }

      onMouseOut(event) {
        if (!this.activeTrigger) return
        if (
          event.relatedTarget instanceof this.window.Node &&
          this.activeTrigger.contains(event.relatedTarget)
        ) {
          return
        }
        if (this.activeTrigger.contains(event.target)) this.hideTooltip()
      }

      onFocusIn(event) {
        const element = this.findTrigger(event.target)
        if (element) this.scheduleTooltip(element)
      }

      onFocusOut(event) {
        if (this.activeTrigger?.contains(event.target)) this.hideTooltip()
      }

      onKeyDown(event) {
        if (event.key === 'Escape') this.hideTooltip()
      }

      destroy() {
        this.document.removeEventListener('DOMContentLoaded', this.handleReady)
        this.observer?.disconnect()
        this.observer = null
        this.document.removeEventListener('mouseover', this.handleMouseOver, true)
        this.document.removeEventListener('mouseout', this.handleMouseOut, true)
        this.document.removeEventListener('focusin', this.handleFocusIn, true)
        this.document.removeEventListener('focusout', this.handleFocusOut, true)
        this.document.removeEventListener('keydown', this.handleKeyDown, true)
        this.document.removeEventListener('scroll', this.hideTooltip, true)
        this.window.removeEventListener('resize', this.hideTooltip)
        this.window.removeEventListener('blur', this.hideTooltip)
        this.hideTooltip()
        this.attached = false
        this.started = false
      }
    }

    // ========================================
    // core/mock-provider.js
    // ========================================

    class MockProvider {
      constructor() {
        // Mock 数据缓存（模拟持久化状态）
        this._cache = new Map()
        // Mock 文件对象缓存（用于文件对话框选择的文件）
        this._mockFiles = new Map()
        // Mock数据统一存放目录
        this._mockDataPath = 'E:\\csdwork3\\git\\ZTools\\bin\\MockData'
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

        // User API
        if (method === 'user_get_info') {
          const token = localStorage.getItem('auth_token')
          const refreshToken = localStorage.getItem('auth_refresh_token')
          const userStr = localStorage.getItem('user_info')

          if (!token) {
            return {
              success: true,
              logged_in: false,
              user: null,
              token: null,
              refresh_token: null
            }
          }

          return {
            success: true,
            logged_in: true,
            user: userStr ? JSON.parse(userStr) : null,
            token,
            refresh_token: refreshToken
          }
        }

        if (method === 'user_set_token') {
          localStorage.setItem('auth_token', params.token)
          if (params.refresh_token) {
            localStorage.setItem('auth_refresh_token', params.refresh_token)
          }
          localStorage.setItem(
            'user_info',
            JSON.stringify({
              user_id: params.user_id,
              username: params.username,
              email: params.email
            })
          )
          return { success: true }
        }

        if (method === 'user_logout') {
          localStorage.removeItem('auth_token')
          localStorage.removeItem('auth_refresh_token')
          localStorage.removeItem('user_info')
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

    // ========================================
    // core/transport.js
    // ========================================

    function shouldRedactParams(method) {
      return method === 'db_put_secure' || method === 'db_get_secure' || method === 'network_http_request' ||
        method.startsWith('credential_v1_')
    }

    const NETWORK_CANCELLATION_CONFIRMATION_MS = 30000

    /**
     * Transport - 通信传输层
     * 负责与 Delphi 端的 V8 绑定通信，提供 Promise 封装、超时处理、消息路由
     */
    class Transport {
      constructor(config = {}) {
        this.config = {
          debug: config.debug || false,
          timeout: config.timeout || 10000,
          gracefulDegradation: config.gracefulDegradation !== false, // 默认启用优雅降级
          ...config
        }

        this.pendingCalls = new Map()
        this.messageCallback = null
        this.callIdCounter = 0
        this.mockProvider = new MockProvider()

        this._setupDebug()
        this._checkEnvironment()
      }

      // ============ 调试工具 ============
      _setupDebug() {
        this._debug = this.config.debug
        try {
          if (
            window.localStorage &&
            window.localStorage.getItem('ZTOOLS_DEBUG') === '1'
          ) {
            this._debug = true
          }
        } catch (e) {}
      }

      _log(...args) {
        // if (this._debug) {
        //   try {
        //     console.debug('[ztools-transport]', ...args)
        //   } catch (e) {}
        // }
      }

      _withRequestId(error, messageId) {
        const requestId = typeof messageId === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(messageId)
          ? messageId
          : null
        if (!requestId) return error
        const target = error && (typeof error === 'object' || typeof error === 'function')
          ? error
          : new Error(String(error || '请求失败'))
        try {
          if (target.requestId === requestId) return target
          Object.defineProperty(target, 'requestId', {
            value: requestId,
            enumerable: false,
            configurable: false,
            writable: false
          })
          return target
        } catch {
          const wrapped = new Error(target instanceof Error ? target.message : String(target))
          if (typeof target.code === 'string') wrapped.code = target.code
          try { Object.defineProperty(wrapped, 'cause', { value: error, enumerable: false }) } catch (causeError) {}
          Object.defineProperty(wrapped, 'requestId', {
            value: requestId,
            enumerable: false,
            configurable: false,
            writable: false
          })
          return wrapped
        }
      }

      _toPublicError(error, context = {}) {
        const message =
          error instanceof Error ? error.message : String(error || '')

        if (/^Call timeout[:：]/i.test(message)) {
          console.error('[ztools-transport]', message, context)

          const publicError = new Error('超时失败')
          publicError.code = 'CALL_TIMEOUT'
          publicError.detail = message
          publicError.cause = error
          return publicError
        }

        return error
      }

      // ============ 环境检测 ============
      _checkEnvironment() {
        // 显示环境警告(仅首次)
        environment.showEnvironmentWarning()

        // 记录环境信息
        this._log('Environment:', environment.getInfo())
      }

      // ============ 核心通信方法 ============

      /**
       * 调用V8绑定方法
       * @param {string} method - 方法名
       * @param {object} params - 参数
       * @param {object} options - 选项 {timeout}
       * @returns {Promise<any>}
       */
      async call(method, params = {}, options = {}) {
        return new Promise((resolve, reject) => {
          const messageId = this._generateMessageId(method)
          const timeout = options.timeout ?? this.config.timeout
          const signal = options.signal
          const bridge = environment.getElectronTransport()
          const cancel = bridge?.cancellations?.[method]

          if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
              typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
            const error = new Error('IPC signal 无效')
            error.code = 'INVALID_REQUEST'
            reject(this._withRequestId(error, messageId))
            return
          }
          if (signal?.aborted) {
            const error = Object.assign(new Error('调用已取消'), { name: 'AbortError', code: 'CALLER_DESTROYED' })
            reject(this._withRequestId(error, messageId))
            return
          }
          if (signal && typeof cancel !== 'function') {
            const error = new Error('宿主没有此方法的受控取消入口')
            error.code = 'NOT_SUPPORTED'
            reject(this._withRequestId(error, messageId))
            return
          }

          this._log('call ->', method, shouldRedactParams(method) ? '[REDACTED]' : params, 'messageId:', messageId)

          let timeoutId = null
          let cancellationDeadlineId = null
          let settled = false
          let cancelRequested = false
          let abortListener
          const cleanup = () => {
            if (timeoutId) clearTimeout(timeoutId)
            if (cancellationDeadlineId) clearTimeout(cancellationDeadlineId)
            signal?.removeEventListener('abort', abortListener)
            this.pendingCalls.delete(messageId)
          }
          const settleResolve = value => {
            if (settled) return
            settled = true
            cleanup()
            resolve(value)
          }
          const settleReject = error => {
            if (settled) return
            settled = true
            cleanup()
            reject(this._withRequestId(error, messageId))
          }
          const requestCancel = (reason, publicError) => {
            if (settled || cancelRequested) return
            cancelRequested = true
            if (timeoutId) {
              clearTimeout(timeoutId)
              timeoutId = null
            }
            const cancellationUnconfirmed = () => Object.assign(
              new Error('取消请求未确认底层网络请求已结束'),
              { code: 'CANCELLATION_UNCONFIRMED' }
            )
            if (method === 'network_http_request') {
              cancellationDeadlineId = setTimeout(() => settleReject(cancellationUnconfirmed()), NETWORK_CANCELLATION_CONFIRMATION_MS)
            }
            Promise.resolve().then(() => cancel({ messageId, reason })).then(response => {
              if (!response || response.messageId !== messageId || response.success !== true) {
                throw cancellationUnconfirmed()
              }
            }).then(() => {
              if (!settled && method !== 'network_http_request') settleReject(publicError)
            }, error => {
              if (method === 'network_http_request') {
                // A failed cancellation ACK does not tell us whether the original request
                // has settled. Keep awaiting its response; the bounded deadline reports
                // unconfirmed only if that response never arrives.
                return
              } else if (error?.code) {
                settleReject(error)
              } else {
                settleReject(Object.assign(new Error('取消请求未获 Main 确认，原请求结果尚未确认'), {
                  code: 'CANCELLATION_UNCONFIRMED', cause: error
                }))
              }
            })
          }
          const onTimeout = () => {
            if (typeof cancel === 'function') {
              const timeoutError = Object.assign(new Error('屏幕权限申请已超时'), { code: 'REQUEST_TIMEOUT' })
              requestCancel('timeout', timeoutError)
              return
            }
            const timeoutError = new Error(`Call timeout: ${method}`)
            this._log('call timeout:', method)
            settleReject(this._toPublicError(timeoutError, { method, messageId, timeout }))
          }
          if (timeout !== Infinity && timeout > 0) timeoutId = setTimeout(onTimeout, timeout)
          abortListener = () => {
            const error = Object.assign(new Error('调用已取消'), { name: 'AbortError', code: 'CALLER_DESTROYED' })
            requestCancel('cancel', error)
          }
          signal?.addEventListener('abort', abortListener, { once: true })

          this.pendingCalls.set(messageId, {
            method,
            messageId,
            resolve: settleResolve,
            reject: settleReject,
            timeoutId,
            timeout,
            timestamp: Date.now()
          })

          try {
            this._executeCall(method, params, messageId, settleResolve, settleReject, timeoutId)
          } catch (error) {
            this._log('call error:', method, error)
            settleReject(this._toPublicError(error, { method, messageId }))
          }
        })
      }

      /**
       * 执行实际的V8绑定调用 - 统一通过消息机制
       */
      _executeCall(method, params, messageId, resolve, reject, timeoutId) {
        this._log(`_executeCall: ${method}`, shouldRedactParams(method) ? '[REDACTED]' : params)

        if (environment.isElectron()) {
          this._executeElectronCall(
            method,
            params,
            messageId,
            resolve,
            reject,
            timeoutId
          )
          return
        }

        // 检查V8绑定是否可用
        if (!window.ztools || typeof window.ztools._sendMessage !== 'function') {
          this._log(`V8 binding not available, using MockProvider for ${method}`)
          // 降级使用 MockProvider
          try {
            const mockResponse = this.mockProvider.generate(method, params)
            this._log(`MockProvider response for ${method}:`, shouldRedactParams(method) ? '[REDACTED]' : mockResponse)

            if (timeoutId) clearTimeout(timeoutId)
            this.pendingCalls.delete(messageId)

            // 如果返回的是 Promise, 等待完成后 resolve
            if (mockResponse instanceof Promise) {
              mockResponse.then(resolve).catch(reject)
            } else {
              resolve(mockResponse)
            }
            return
          } catch (mockError) {
            this._log('Mock generation error:', mockError)
          }

          if (timeoutId) clearTimeout(timeoutId)
          this.pendingCalls.delete(messageId)

          // 根据配置决定是否优雅降级
          if (this.config.gracefulDegradation) {
            const error = environment.createEnvironmentError(method)
            this._log('Environment error (graceful):', error.message)
            reject(error)
          } else {
            reject(
              new Error(
                'V8 binding not available: window.ztools._sendMessage is undefined'
              )
            )
          }
          return
        }

        try {
          // 将 messageId 添加到 params 中，让 Delphi 端使用这个 MessageId
          const paramsWithId = {
            ...params,
            _messageId: messageId
          }

          // 将 params 序列化为 JSON 字符串
          const paramsJson = JSON.stringify(paramsWithId)

          // 统一通过 _sendMessage 发送消息
          // V8Handler 会接收到 method 和 paramsJson,然后路由到对应的 Handler
          window.ztools._sendMessage(method, paramsJson)

          this._log('sent message:', method, shouldRedactParams(method) ? '[REDACTED]' : paramsJson)
        } catch (error) {
          if (timeoutId) clearTimeout(timeoutId)
          this.pendingCalls.delete(messageId)
          this._log('send message error:', method, error)
          reject(error)
        }
      }

      /**
       * 通过 Electron preload 的受控桥调用 main。
       */
      _executeElectronCall(
        method,
        params,
        messageId,
        resolve,
        reject,
        timeoutId
      ) {
        const bridge = environment.getElectronTransport()
        const methodCall = bridge?.methods?.[method]
        if (typeof methodCall !== 'function') {
          if (timeoutId) clearTimeout(timeoutId)
          this.pendingCalls.delete(messageId)
          const error = new Error(`Electron preload 未开放方法: ${method}`)
          error.code = 'METHOD_NOT_FOUND'
          reject(this._toPublicError(error, { method, messageId }))
          return
        }

        const timeout = this.pendingCalls.get(messageId)?.timeout
        const request = {
          messageId,
          params,
          ...(timeout === Infinity
            ? { timeoutMs: 'infinite' }
            : Number.isFinite(timeout) && timeout > 0
              ? { timeoutMs: timeout }
              : {})
        }

        Promise.resolve(methodCall(request))
          .then((response) => {
            if (timeoutId) clearTimeout(timeoutId)
            this.pendingCalls.delete(messageId)
            if (!response || response.messageId !== messageId) {
              throw new Error('Electron response messageId mismatch')
            }
            if (response.success === false) {
              const error = new Error(response.error?.message || 'Request failed')
              error.code = response.error?.code || 'REQUEST_FAILED'
              throw error
            }
            resolve(response.data)
          })
          .catch((error) => {
            if (timeoutId) clearTimeout(timeoutId)
            this.pendingCalls.delete(messageId)
            reject(this._toPublicError(error, { method, messageId }))
          })
      }

      /**
       * 生成唯一的 MessageId（与 Delphi 端格式一致）
       * 格式: js_timestamp_method
       */
      _generateMessageId(method) {
        // 使用时间戳 + 计数器确保唯一性
        return `js_${Date.now()}_${++this.callIdCounter}_${method}`
      }

      /**
       * 接收来自Delphi的消息
       */
      handleMessage(msgType, msgData) {
        // 解析响应数据
        let responseData = msgData
        if (typeof msgData === 'string') {
          try {
            responseData = JSON.parse(msgData)
          } catch (e) {
            // 如果不是JSON,保持原样
          }
        }

        const responseMessageId = responseData && typeof responseData === 'object'
          ? responseData._messageId
          : undefined
        const pendingMethod = typeof responseMessageId === 'string'
          ? this.pendingCalls.get(responseMessageId)?.method
          : undefined
        const logMethod = typeof pendingMethod === 'string' ? pendingMethod : msgType
        this._log('recv <-', msgType, shouldRedactParams(logMethod) ? '[REDACTED]' : msgData)

        // 通过 MessageId 精确匹配 pending call
        if (responseData && responseData._messageId) {
          const messageId = responseData._messageId
          const foundCall = this.pendingCalls.get(messageId)

          if (foundCall) {
            // 找到匹配的调用,清理并resolve/reject
            if (foundCall.timeoutId) clearTimeout(foundCall.timeoutId)
            this.pendingCalls.delete(messageId)

            if (responseData.success === false) {
              foundCall.reject(new Error(responseData.error || 'Request failed'))
            } else {
              foundCall.resolve(responseData)
            }
            this._log('call resolved:', msgType, 'messageId:', messageId)
            return
          } else {
            this._log('recv: messageId not found in pendingCalls:', messageId)
          }
        }

        // 没有 MessageId 或找不到匹配的调用,可能是主动推送的消息
        this._log('recv (no pending call):', msgType)
        if (this.messageCallback) {
          try {
            this.messageCallback(msgType, responseData)
          } catch (error) {
            this._log('messageCallback error:', error)
          }
        }
      }

      /**
       * 设置消息回调
       */
      setMessageCallback(callback) {
        this.messageCallback = callback

        // 注册到V8绑定
        if (
          window.ztools &&
          typeof window.ztools._setMessageCallback === 'function'
        ) {
          window.ztools._setMessageCallback((msgType, msgData) => {
            this.handleMessage(msgType, msgData)
          })
        }
      }

      /**
       * 获取待处理的调用数量
       */
      getPendingCallsCount() {
        return this.pendingCalls.size
      }

      /**
       * 清理所有待处理的调用
       */
      clearPendingCalls() {
        for (const [callId, call] of this.pendingCalls.entries()) {
          if (call.timeoutId) clearTimeout(call.timeoutId)
          call.reject(new Error('Transport cleared'))
        }
        this.pendingCalls.clear()
      }

      /**
       * 获取环境信息
       */
      getEnvironment() {
        return environment.getInfo()
      }

      /**
       * 获取 Electron preload 传输层，仅供 SDK 内部的平台差异适配使用。
       */
      getElectronTransport() {
        return environment.getElectronTransport()
      }

      /**
       * 检查是否在 CEF 环境中
       */
      isCEFEnvironment() {
        return environment.isCEF()
      }

      /**
       * 检查是否在 Electron 环境中
       */
      isElectronEnvironment() {
        return environment.isElectron()
      }

      /**
       * 销毁 Transport，清理所有资源
       */
      destroy() {
        this.clearPendingCalls()
        this.messageCallback = null
      }
    }

    // ========================================
    // core/reference-transport.js
    // ========================================

    /** SDK2 file calls wait for Main's authoritative cancellation/commit result. */
    class ReferenceTransport extends Transport {
      constructor(config = {}) {
        super(config)
        this.supportsAbortSignal = true
        this.referenceCalls = new Map()
        this.referenceDestroyed = false
        this.referenceCleanupMs = config.referenceCleanupMs ?? 30000
        if (!Number.isInteger(this.referenceCleanupMs) || this.referenceCleanupMs < 1 || this.referenceCleanupMs > 30000) {
          throw this._referenceError('INVALID_REQUEST', '取消等待上限无效')
        }
      }
      _referenceError(code, message) { const error = new Error(message); error.code = code; return error }
      _writeRecord(object, fields) {
        try {
          if (!object || typeof object !== 'object') return null
          const proto = Object.getPrototypeOf(object)
          const constructor = proto && Object.getOwnPropertyDescriptor(proto, 'constructor')?.value
          if (proto !== null && (Object.getPrototypeOf(proto) !== null ||
              typeof constructor !== 'function' || Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(Object))) return null
          const descriptors = Object.getOwnPropertyDescriptors(object), keys = Reflect.ownKeys(descriptors)
          if (keys.length !== fields.length || keys.some(key => !fields.includes(key) ||
              !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) return null
          return Object.fromEntries(fields.map(key => [key, descriptors[key].value]))
        } catch { return null }
      }
      // Only a correlated Main write receipt can establish commit; never an error or another method's data.
      _committedWriteReceipt(value) {
        const data = (object, fields) => this._writeRecord(object, fields)
        try {
          const fact = data(value, ['success', 'status', 'size', 'reference']) || data(value, ['success', 'status', 'size', 'issues'])
          if (!fact || fact.success !== true || !Number.isSafeInteger(fact.size) || fact.size < 0 || fact.size > 16 * 1024 * 1024) return null
          if (fact.status === 'committed' && Object.hasOwn(fact, 'reference')) {
            const ref = data(fact.reference, ['grantId', 'displayName', 'kind', 'operations', 'fileUrl'])
            const operation = ref && Object.getOwnPropertyDescriptor(ref.operations, '0')
            if (!ref || typeof ref.grantId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ref.grantId) ||
                typeof ref.displayName !== 'string' || ref.displayName.includes('\0') ||
                new TextEncoder().encode(ref.displayName).length > 4096 || ref.kind !== 'file' ||
                !Array.isArray(ref.operations) || ref.operations.length !== 1 ||
                operation?.enumerable !== true || !Object.hasOwn(operation, 'value') || operation.value !== 'read' ||
                Reflect.ownKeys(ref.operations).length !== 2 ||
                ref.fileUrl !== 'ztools://file/' + ref.grantId + '/' + encodeURIComponent(ref.displayName)) return null
            return Object.freeze({ success: true, status: 'committed', size: fact.size,
              reference: Object.freeze({ ...ref, operations: Object.freeze(['read']) }) })
          }
          if (fact.status !== 'committed-reference-unavailable' || !Array.isArray(fact.issues) ||
              fact.issues.length < 1 || fact.issues.length > 2) return null
          const issues = [], seen = new Set()
          for (let index = 0; index < fact.issues.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(fact.issues, String(index))
            const issue = descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') && data(descriptor.value, ['stage', 'code'])
            if (!issue || !['reference', 'release'].includes(issue.stage) || seen.has(issue.stage) ||
                (issue.stage === 'reference' && seen.has('release')) || !['PERMISSION_DENIED', 'FILE_ERROR'].includes(issue.code) ||
                (issue.stage === 'release' && issue.code !== 'FILE_ERROR')) return null
            seen.add(issue.stage); issues.push(Object.freeze(issue))
          }
          if (Reflect.ownKeys(fact.issues).length !== issues.length + 1) return null
          return Object.freeze({ success: true, status: fact.status, size: fact.size, issues: Object.freeze(issues) })
        } catch { return null }
      }
      _unavailableCommit(size, releaseFailed = false) {
        return Object.freeze({ success: true, status: 'committed-reference-unavailable', size,
          issues: Object.freeze([Object.freeze({ stage: 'reference', code: 'PERMISSION_DENIED' }),
            ...(releaseFailed ? [Object.freeze({ stage: 'release', code: 'FILE_ERROR' })] : [])]) })
      }
      call(method, params = {}, options = {}) {
        const host = window.__ztoolsElectron
        const cancel = host?.transport?.cancellations?.[method]
        if (host?.contractVersion !== 2 || typeof cancel !== 'function') {
          if (options.signal) return Promise.reject(this._referenceError('NOT_SUPPORTED', '宿主没有逐方法取消入口'))
          return super.call(method, params, options)
        }
        const invoke = host.transport.methods?.[method]
        const revoke = host.transport.methods?.filesystem_revoke
        const signal = options.signal
        const timeout = options.timeout ?? this.config.timeout
        const maximumTimeout = method === 'network_http_request' ? 300250 : 120000
        if (this.referenceDestroyed || signal?.aborted) return Promise.reject(this._referenceError('CALLER_DESTROYED', '文件请求已取消'))
        if (typeof invoke !== 'function' || (signal && (typeof signal.aborted !== 'boolean' ||
            typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) ||
            (timeout !== Infinity && (!Number.isInteger(timeout) || timeout < 1 || timeout > maximumTimeout))) {
          return Promise.reject(this._referenceError('INVALID_REQUEST', '文件传输选项无效'))
        }
        if (this.referenceCalls.size >= 64) return Promise.reject(this._referenceError('PERMISSION_DENIED', '文件请求超过上限'))
        const messageId = this._generateMessageId(method)
        const mutating = new Set(['filesystem_write_file', 'filesystem_write_cache', 'filesystem_delete_file',
          'filesystem_copy_file', 'filesystem_move_file', 'filesystem_create_directory', 'filesystem_delete_directory',
          'network_http_download', 'clipboard_copy_text', 'clipboard_copy_file', 'clipboard_copy_files', 'shell_trash_item',
          'clipboard_read_image', 'screen_capture', 'screen_capture_region']).has(method)
        return new Promise((resolve, reject) => {
          let requested = false, timer, deadline, settled = false, committedFact, cleanupPending = false, invocationFinished = false
          const releaseSlot = () => {
            if (invocationFinished && !cleanupPending) this.referenceCalls.delete(messageId)
          }
          const failure = () => this._referenceError(mutating ? 'FILE_WRITE_OUTCOME_UNKNOWN' : 'FILE_ERROR', '文件请求结束未确认')
          const cancellationUnconfirmed = () => this._referenceError('CANCELLATION_UNCONFIRMED', '取消请求未确认底层网络请求已结束')
          const pendingFailure = () => method === 'network_http_request' && requested ? cancellationUnconfirmed() : failure()
          const settle = (value, error) => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            if (deadline) clearTimeout(deadline)
            signal?.removeEventListener('abort', onAbort)
            error ? reject(this._withRequestId(error, messageId)) : resolve(value)
          }
          const requestCancel = (reason) => {
            if (requested || settled) return
            requested = true
            if (timer) clearTimeout(timer)
            deadline = setTimeout(() => committedFact
              ? settle(this._unavailableCommit(committedFact.size, true))
              : settle(undefined, method === 'network_http_request' ? cancellationUnconfirmed() : failure()), this.referenceCleanupMs)
            // A failed cancel send does not prove the original native operation stopped.
            Promise.resolve().then(() => cancel({ messageId, reason })).catch(() => undefined)
          }
          const onAbort = () => requestCancel('cancel')
          this.referenceCalls.set(messageId, { cancel: () => requestCancel('cancel') })
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted) onAbort()
          if (timeout !== Infinity) timer = setTimeout(() => requestCancel('timeout'), timeout)
          const request = { messageId, params, timeoutMs: timeout === Infinity ? 'infinite' : timeout }
          const revokeCommitted = async (fact) => {
            committedFact = fact
            if (typeof revoke !== 'function') return this._unavailableCommit(fact.size, true)
            const cleanupId = this._generateMessageId('filesystem_revoke')
            cleanupPending = true
            let cleanupTimer
            const cleanup = Promise.resolve().then(() => revoke({ messageId: cleanupId,
              params: { grantId: fact.reference.grantId }, timeoutMs: this.referenceCleanupMs })).then(response => {
              const outer = this._writeRecord(response, ['messageId', 'success', 'data'])
              return outer?.messageId === cleanupId && outer.success === true &&
                this._writeRecord(outer.data, ['success'])?.success === true
            }).catch(() => false).finally(() => { cleanupPending = false; releaseSlot() })
            const confirmed = await Promise.race([cleanup, new Promise(resolve => {
              cleanupTimer = setTimeout(() => resolve(false), this.referenceCleanupMs)
            })])
            clearTimeout(cleanupTimer)
            return this._unavailableCommit(fact.size, !confirmed)
          }
          Promise.resolve().then(() => invoke(request)).then(async response => {
            if (method === 'filesystem_write_file') response = this._writeRecord(response, ['messageId', 'success', 'data']) ||
              this._writeRecord(response, ['messageId', 'success', 'error'])
            if (!response || response.messageId !== messageId || typeof response.success !== 'boolean') throw pendingFailure()
            if (!response.success) {
              if (!response.error || typeof response.error.code !== 'string' || typeof response.error.message !== 'string') throw pendingFailure()
              throw this._referenceError(response.error.code, response.error.message)
            }
            if (method === 'filesystem_write_file') {
              const fact = this._committedWriteReceipt(response.data)
              if (fact) {
                if ((requested || settled) && fact.status === 'committed') settle(await revokeCommitted(fact))
                else settle(fact)
                return
              }
            }
            // Other methods retain their existing cancellation semantics.
            if (requested && method !== 'network_http_request') throw failure()
            settle(response.data)
          }).catch(error => settle(undefined, error?.code ? error : pendingFailure())).finally(() => {
            invocationFinished = true; releaseSlot()
          })
        })
      }
      getPendingCallsCount() { return super.getPendingCallsCount() + this.referenceCalls.size }
      clearPendingCalls() {
        for (const call of this.referenceCalls.values()) call.cancel()
        super.clearPendingCalls()
      }
      destroy() { this.referenceDestroyed = true; super.destroy() }
    }

    // ========================================
    // core/events.js
    // ========================================

    /**
     * Events - 事件系统
     * 事件订阅/发布、请求/响应模式、频道管理
     */
    class Events {
      constructor(transport) {
        this.transport = transport
        this.handlers = new Map()
        this.subscriptions = new Set()
        this.failedUnsubscriptions = new Set()
        this.subscriptionPromises = new Map()
        this.unsubscriptionPromises = new Map()
        this.legacyHandlers = new Map()
        this.confirmedHandlers = new Map()
        this.pendingConfirmedSubscriptions = new Map()
        this.pendingRequests = new Map()
        this.lifecycleVersion = 0
        this.destroyed = false
        this.destroyPromise = null
      }

      // ============ 内部工具方法 ============

      _ensureSet(key) {
        if (!this.handlers.has(key)) {
          this.handlers.set(key, new Set())
        }
        return this.handlers.get(key)
      }

      _buildEnvelope(type, payload, options = {}) {
        return {
          envelopeId: `env_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          version: 'v1',
          timestamp: Date.now(),
          type,
          scope: options.scope || 'system',
          channel: options.channel,
          source: { kind: 'page' },
          target: { broadcast: true },
          payload: payload == null ? {} : payload,
          ...options
        }
      }

      async _subscribeKey(key, lifecycleVersion = this.lifecycleVersion) {
        this._assertActiveLifecycle(lifecycleVersion)

        const pendingUnsubscribe = this.unsubscriptionPromises.get(key)
        if (pendingUnsubscribe) {
          await pendingUnsubscribe.catch(() => {})
          this._assertActiveLifecycle(lifecycleVersion)
        }

        if (this.subscriptions.has(key) && !this.failedUnsubscriptions.has(key)) {
          return { success: true, subscribed: false }
        }

        const pendingSubscribe = this.subscriptionPromises.get(key)
        if (pendingSubscribe) return pendingSubscribe

        let transportResult
        try {
          // Preserve the legacy on()/onChannel() timing: start the Main call in
          // the current turn, while still exposing an awaitable confirmation.
          transportResult = this.transport.call('event_subscribe', { key })
        } catch (error) {
          transportResult = Promise.reject(error)
        }
        let subscribePromise
        subscribePromise = Promise.resolve(transportResult)
          .then((result) => {
            this._requireSubscriptionSuccess('subscribe', result)
            this.subscriptions.add(key)
            this.failedUnsubscriptions.delete(key)
            return result
          })
          .finally(() => {
            if (this.subscriptionPromises.get(key) === subscribePromise) {
              this.subscriptionPromises.delete(key)
            }
          })
        this.subscriptionPromises.set(key, subscribePromise)
        return subscribePromise
      }

      _assertActiveLifecycle(lifecycleVersion) {
        if (this.destroyed || lifecycleVersion !== this.lifecycleVersion) {
          throw new Error('Events were cleared or destroyed before event subscription')
        }
      }

      _requireSubscriptionSuccess(operation, result) {
        if (result && result.success === true) return

        const error = new Error(`Main did not confirm event ${operation}`)
        error.code = operation === 'subscribe'
          ? 'EVENT_SUBSCRIPTION_NOT_CONFIRMED'
          : 'EVENT_UNSUBSCRIPTION_NOT_CONFIRMED'
        throw error
      }

      _hasLocalHandlers(key) {
        return (this.handlers.get(key)?.size || 0) > 0 ||
          (this.pendingConfirmedSubscriptions.get(key) || 0) > 0
      }

      async _unsubscribeKey(key, { onlyWhenIdle = false } = {}) {
        const pendingUnsubscribe = this.unsubscriptionPromises.get(key)
        if (pendingUnsubscribe) return pendingUnsubscribe

        const pendingSubscribe = this.subscriptionPromises.get(key)
        const performUnsubscribe = async () => {
            if (onlyWhenIdle && this._hasLocalHandlers(key)) {
              return { success: true, unsubscribed: false }
            }
            if (!this.subscriptions.has(key) && !this.failedUnsubscriptions.has(key)) {
              return { success: true, unsubscribed: false }
            }

            let result
            try {
              result = await this.transport.call('event_unsubscribe', { key })
              this._requireSubscriptionSuccess('unsubscribe', result)
            } catch (error) {
              this.failedUnsubscriptions.add(key)
              throw error
            }
            this.subscriptions.delete(key)
            this.failedUnsubscriptions.delete(key)
            return result
        }
        let unsubscribePromise
        unsubscribePromise = (pendingSubscribe
          ? Promise.resolve(pendingSubscribe).catch(() => {}).then(performUnsubscribe)
          : performUnsubscribe())
          .finally(() => {
            if (this.unsubscriptionPromises.get(key) === unsubscribePromise) {
              this.unsubscriptionPromises.delete(key)
            }
          })
        this.unsubscriptionPromises.set(key, unsubscribePromise)
        return unsubscribePromise
      }

      _ensureOwnerSet(ownerMap, key) {
        if (!ownerMap.has(key)) ownerMap.set(key, new Set())
        return ownerMap.get(key)
      }

      _ensureConfirmedHandlerMap(key) {
        if (!this.confirmedHandlers.has(key)) {
          this.confirmedHandlers.set(key, new Map())
        }
        return this.confirmedHandlers.get(key)
      }

      _changePendingConfirmedSubscriptions(key, delta) {
        const count = (this.pendingConfirmedSubscriptions.get(key) || 0) + delta
        if (count > 0) this.pendingConfirmedSubscriptions.set(key, count)
        else this.pendingConfirmedSubscriptions.delete(key)
      }

      _releaseConfirmedHandler(key, handler) {
        const confirmedHandlers = this.confirmedHandlers.get(key)
        const count = confirmedHandlers?.get(handler) || 0
        if (!count) return Promise.resolve()

        if (count > 1) {
          confirmedHandlers.set(handler, count - 1)
          return Promise.resolve()
        }

        confirmedHandlers.delete(handler)
        if (!confirmedHandlers.size) this.confirmedHandlers.delete(key)

        if (!this.legacyHandlers.get(key)?.has(handler)) {
          this.handlers.get(key)?.delete(handler)
        }

        const handlers = this.handlers.get(key)
        if (handlers?.size) return Promise.resolve()
        this.handlers.delete(key)
        return this._unsubscribeKey(key, { onlyWhenIdle: true }).then(() => undefined)
      }

      _cleanupSubscriptionKeys(keys, message) {
        return Promise.allSettled([...keys].map((key) => this._unsubscribeKey(key)))
          .then((results) => {
            const errors = results
              .filter((result) => result.status === 'rejected')
              .map((result) => result.reason)
            errors.forEach((error) => console.error(message, error))
            return { success: errors.length === 0, errors }
          })
      }

      _settlePendingRequest(requestId, result) {
        const entry = this.pendingRequests.get(requestId)
        if (!entry) return false

        this.pendingRequests.delete(requestId)
        clearTimeout(entry.timeoutId)
        entry.resolve(result)
        return true
      }

      _cancelPendingRequests() {
        for (const requestId of this.pendingRequests.keys()) {
          this._settlePendingRequest(requestId, { ok: false, code: 'CANCELLED' })
        }
      }

      // ============ 事件分发 ============

      /**
       * 分发事件信封
       * @param {object} envelope - 事件信封
       */
      dispatchEnvelope(envelope) {
        try {
          if (!envelope) return

          // Phase 1: 处理请求/响应
          if (envelope.replyTo != null) {
            if (this.pendingRequests.has(envelope.replyTo)) {
              const ack = envelope.payload != null ? envelope.payload : envelope
              this._settlePendingRequest(envelope.replyTo, ack)
            }
            return
          }

          // Phase 2: 分发到事件处理器
          const keys = []
          if (envelope.type) keys.push(envelope.type)
          if (envelope.channel) keys.push('channel:' + envelope.channel)

          keys.forEach((k) => {
            const set = this.handlers.get(k)
            if (set && set.size) {
              set.forEach((fn) => {
                try {
                  fn(envelope)
                } catch (e) {
                  console.error('[ztools-events] Handler error:', e)
                }
              })
            }
          })

          // Phase 3: 通配符处理器
          const anySet = this.handlers.get('*')
          if (anySet && anySet.size) {
            anySet.forEach((fn) => {
              try {
                fn(envelope)
              } catch (e) {
                console.error('[ztools-events] Wildcard handler error:', e)
              }
            })
          }
        } catch (e) {
          console.error('[ztools-events] Dispatch envelope error:', e)
        }
      }

      // ============ 事件订阅/发布 ============

      /**
       * 订阅事件
       * @param {string} eventType - 事件类型
       * @param {function} handler - 处理函数
       */
      on(eventType, handler) {
        const set = this._ensureSet(eventType)
        set.add(handler)
        this._ensureOwnerSet(this.legacyHandlers, eventType).add(handler)

        // 通知后端订阅（异步，不阻塞）
        this._subscribeKey(eventType).catch((e) => {
          // 忽略订阅错误，不影响事件系统的使用
          if (this.transport._debug) {
            console.warn(
              '[ztools-events] Subscribe error (non-critical):',
              e.message
            )
          }
        })
      }

      /**
       * 取消订阅事件
       * @param {string} eventType - 事件类型
       * @param {function} handler - 处理函数(可选,不传则清空所有)
       */
      off(eventType, handler) {
        const set = this.handlers.get(eventType)

        if (handler) {
          set?.delete(handler)
          const legacyHandlers = this.legacyHandlers.get(eventType)
          legacyHandlers?.delete(handler)
          if (legacyHandlers && !legacyHandlers.size) this.legacyHandlers.delete(eventType)

          const confirmedHandlers = this.confirmedHandlers.get(eventType)
          confirmedHandlers?.delete(handler)
          if (confirmedHandlers && !confirmedHandlers.size) this.confirmedHandlers.delete(eventType)
        } else {
          set?.clear()
          this.legacyHandlers.delete(eventType)
          this.confirmedHandlers.delete(eventType)
        }

        // 如果没有处理器了,通知后端取消订阅
        if (!set?.size) {
          this.handlers.delete(eventType)
          this._unsubscribeKey(eventType, { onlyWhenIdle: true }).catch((e) => {
            console.error('[ztools-events] Unsubscribe error:', e)
          })
        }
      }

      /**
       * 等待 Main 确认后再添加本地事件处理器。
       * @param {string} eventType - 事件类型
       * @param {function} handler - 处理函数
       * @returns {Promise<function(): Promise<void>>} 幂等的异步注销函数
       */
      async subscribeConfirmed(eventType, handler) {
        if (typeof eventType !== 'string' || !eventType) {
          throw new TypeError('eventType must be a non-empty string')
        }
        if (typeof handler !== 'function') {
          throw new TypeError('handler must be a function')
        }
        if (this.destroyed) {
          throw new Error('Events instance is destroyed')
        }

        const lifecycleVersion = this.lifecycleVersion
        this._changePendingConfirmedSubscriptions(eventType, 1)
        try {
          await this._subscribeKey(eventType, lifecycleVersion)
          if (lifecycleVersion !== this.lifecycleVersion || this.destroyed) {
            throw new Error('Events were cleared or destroyed before subscription was confirmed')
          }

          this._ensureSet(eventType).add(handler)
          const confirmedHandlers = this._ensureConfirmedHandlerMap(eventType)
          confirmedHandlers.set(handler, (confirmedHandlers.get(handler) || 0) + 1)

          let active = true
          return () => {
            if (!active) return Promise.resolve()
            active = false
            return this._releaseConfirmedHandler(eventType, handler)
          }
        } finally {
          this._changePendingConfirmedSubscriptions(eventType, -1)
        }
      }

      /**
       * 发送事件
       * @param {string} eventType - 事件类型
       * @param {any} payload - 事件数据
       * @param {object} options - 选项
       * @returns {Promise}
       */
      async emit(eventType, payload, options) {
        const envelope = this._buildEnvelope(eventType, payload, options)
        // 先在前端本地分发事件（同步）
        this.dispatchEnvelope(envelope)
        // 然后通知后端（异步）
        return await this.transport.call('event_publish', { envelope })
      }

      // ============ 频道订阅 ============

      /**
       * 订阅频道
       * @param {string} channel - 频道名
       * @returns {Promise}
       */
      async subscribe(channel) {
        return await this._subscribeKey('channel:' + channel)
      }

      /**
       * 取消订阅频道
       * @param {string} channel - 频道名
       * @returns {Promise}
       */
      async unsubscribe(channel) {
        return await this._unsubscribeKey('channel:' + channel)
      }

      /**
       * 订阅频道并绑定处理器
       * @param {string} channel - 频道名
       * @param {function} handler - 处理函数
       */
      onChannel(channel, handler) {
        this.on('channel:' + channel, handler)
      }

      /**
       * 取消频道订阅
       * @param {string} channel - 频道名
       * @param {function} handler - 处理函数
       */
      offChannel(channel, handler) {
        this.off('channel:' + channel, handler)
      }

      /**
       * 发布到频道
       * @param {string} channel - 频道名
       * @param {string} eventType - 事件类型
       * @param {any} payload - 事件数据
       * @param {object} options - 选项
       * @returns {Promise}
       */
      async publish(channel, eventType, payload, options) {
        const opt = { ...options, channel }
        return await this.emit(eventType, payload, opt)
      }

      // ============ 请求/响应模式 ============

      /**
       * 发送请求并等待响应
       * @param {string} eventType - 事件类型
       * @param {any} payload - 请求数据
       * @param {object} options - 选项 {timeout, ...}
       * @returns {Promise}
       */
      async request(eventType, payload, options = {}) {
        const envelope = this._buildEnvelope(eventType, payload, options)
        if (!envelope.correlationId) {
          envelope.correlationId = envelope.envelopeId
        }

        return new Promise((resolve) => {
          const timeoutMs = options.timeout || 10000
          const timeoutId = setTimeout(() => {
            this._settlePendingRequest(envelope.envelopeId, { ok: false, code: 'TIMEOUT' })
          }, timeoutMs)

          this.pendingRequests.set(envelope.envelopeId, {
            resolve,
            timeoutId
          })

          // 尝试发送请求
          this.transport.call('event_request', { envelope }).catch(() => {
            // 如果event_request不支持,降级为event_publish
            this.transport.call('event_publish', { envelope })
          })
        })
      }

      /**
       * 响应请求
       * @param {string} replyTo - 回复的envelopeId
       * @param {any} ackPayload - 响应数据
       * @param {object} options - 选项
       * @returns {Promise}
       */
      async respond(replyTo, ackPayload, options = {}) {
        const env = this._buildEnvelope(
          options.type || 'events.Ack',
          ackPayload || {},
          options
        )
        env.replyTo = replyTo
        return await this.transport.call('event_publish', { envelope: env })
      }

      // ============ 清理 ============

      /**
       * 清理所有事件处理器
       * @returns {Promise<{success: boolean, errors: unknown[]}>} 取消订阅结果
       */
      clear() {
        this.lifecycleVersion += 1
        const subscribedKeys = new Set([
          ...this.subscriptions,
          ...this.failedUnsubscriptions,
          ...this.subscriptionPromises.keys(),
          ...this.unsubscriptionPromises.keys()
        ])
        this.handlers.clear()
        this.legacyHandlers.clear()
        this.confirmedHandlers.clear()
        this.pendingConfirmedSubscriptions.clear()
        this._cancelPendingRequests()
        return this._cleanupSubscriptionKeys(subscribedKeys, '[ztools-events] Cleanup unsubscribe error:')
      }

      /**
       * 销毁
       * @returns {Promise<{success: boolean, errors: unknown[]}>} 清理结果
       */
      destroy() {
        if (this.destroyPromise) return this.destroyPromise

        this.lifecycleVersion += 1
        this.destroyed = true
        const subscribedKeys = new Set([
          ...this.subscriptions,
          ...this.failedUnsubscriptions,
          ...this.subscriptionPromises.keys(),
          ...this.unsubscriptionPromises.keys()
        ])
        this.handlers.clear()
        this.legacyHandlers.clear()
        this.confirmedHandlers.clear()
        this.pendingConfirmedSubscriptions.clear()
        this._cancelPendingRequests()
        this.destroyPromise = this._cleanupSubscriptionKeys(
          subscribedKeys,
          '[ztools-events] Destroy unsubscribe error:'
        )
        return this.destroyPromise
      }
    }

    // ========================================
    // api/fs.js
    // ========================================

    /**
     * FileSystem API - 文件系统操作
     * CEF 使用 V8 ArrayBuffer，Electron 使用受控异步 IPC。
     */
    const MAX_STREAM_FILE_BYTES = 4 * 1024 * 1024 * 1024

    function bytesToBase64(bytes) {
      const chunkSize = 24 * 1024
      const binaryChunks = []
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize)
        binaryChunks.push(String.fromCharCode(...chunk))
      }
      return btoa(binaryChunks.join(''))
    }

    function base64ToBytes(value) {
      const binary = atob(value)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }
      return bytes
    }

    function encodeContent(content) {
      if (typeof content === 'string') {
        return { encoding: 'utf8', content }
      }
      if (content instanceof ArrayBuffer) {
        return { encoding: 'base64', content: bytesToBase64(new Uint8Array(content)) }
      }
      if (content instanceof Uint8Array) {
        return { encoding: 'base64', content: bytesToBase64(content) }
      }
      throw new Error('Content must be string, ArrayBuffer, or Uint8Array')
    }

    function fileOperationError(action, error) {
      const wrapped = new Error(`${action}: ${error?.message || String(error)}`)
      if (error?.code) wrapped.code = error.code
      wrapped.cause = error
      return wrapped
    }

    function normalizeChunkSize(value, fallback) {
      const requested = Number.isInteger(value) ? value : fallback
      return Math.max(1, Math.min(2 * 1024 * 1024, requested))
    }

    function mergeByteChunks(chunks, totalSize) {
      const merged = new Uint8Array(totalSize)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      if (offset !== totalSize) throw new Error('Read file returned an incomplete stream')
      return merged
    }

    async function readElectronChunks(transport, method, baseParams, chunkSize, onProgress) {
      const chunks = []
      const size = normalizeChunkSize(chunkSize, 2 * 1024 * 1024)
      let offset = 0
      let totalSize
      while (totalSize === undefined || offset < totalSize) {
        const result = await transport.call(method, {
          ...baseParams,
          offset,
          length: size
        })
        if (
          !result?.success ||
          !Number.isSafeInteger(result.totalSize) ||
          result.totalSize < 0 ||
          result.totalSize > MAX_STREAM_FILE_BYTES ||
          !Number.isSafeInteger(result.size) ||
          typeof result.content !== 'string'
        ) {
          throw new Error('Read file chunk returned invalid data')
        }
        if (result.offset !== offset || result.size < 0 || result.size > size) {
          throw new Error('Read file chunk returned an invalid offset')
        }
        totalSize = result.totalSize
        const chunk = base64ToBytes(result.content)
        if (chunk.byteLength !== result.size || offset + chunk.byteLength > totalSize) {
          throw new Error('Read file chunk returned an invalid size')
        }
        if (chunk.byteLength > 0) chunks.push(chunk)
        offset += chunk.byteLength
        onProgress?.(offset, totalSize)
        if (chunk.byteLength === 0) break
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      if (totalSize === undefined) totalSize = 0
      return mergeByteChunks(chunks, totalSize)
    }

    async function writeElectronChunks(
      transport,
      methods,
      startParams,
      bytes,
      chunkSize,
      onProgress
    ) {
      const started = await transport.call(methods.start, {
        ...startParams,
        totalSize: bytes.byteLength
      })
      if (!started?.success || typeof started.handle !== 'string') {
        throw new Error('Write file stream could not be started')
      }
      const handle = started.handle
      try {
        if (
          started.totalSize !== undefined &&
          (!Number.isSafeInteger(started.totalSize) || started.totalSize !== bytes.byteLength)
        ) {
          throw new Error('Write file stream returned an invalid total size')
        }
        const size = normalizeChunkSize(chunkSize, 2 * 1024 * 1024)
        let offset = 0
        while (offset < bytes.byteLength) {
          const chunk = bytes.subarray(offset, Math.min(offset + size, bytes.byteLength))
          const result = await transport.call(methods.chunk, {
            handle,
            offset,
            content: bytesToBase64(chunk)
          })
          if (
            !result?.success ||
            result.written !== offset + chunk.byteLength ||
            (result.totalSize !== undefined &&
              (!Number.isSafeInteger(result.totalSize) || result.totalSize !== bytes.byteLength))
          ) {
            throw new Error('Write file chunk returned invalid data')
          }
          offset += chunk.byteLength
          onProgress?.(offset, bytes.byteLength)
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
        const finished = await transport.call(methods.end, { handle })
        if (
          !finished?.success ||
          finished.size !== bytes.byteLength ||
          (finished.totalSize !== undefined &&
            (!Number.isSafeInteger(finished.totalSize) || finished.totalSize !== bytes.byteLength))
        ) {
          throw new Error('Write file stream could not be committed')
        }
        if (bytes.byteLength === 0) onProgress?.(0, 0)
        return true
      } catch (error) {
        await transport.call(methods.cancel, { handle }).catch(() => undefined)
        throw error
      }
    }

    function contentToBytes(content) {
      if (typeof content === 'string') return new TextEncoder().encode(content)
      if (content instanceof ArrayBuffer) return new Uint8Array(content)
      if (content instanceof Uint8Array) return content
      throw new Error('Content must be string, ArrayBuffer, or Uint8Array')
    }

    class FileSystemAPI {
      constructor(transport) {
        this.transport = transport

        // 验证 V8 ArrayBuffer 方法是否可用
        this.useV8ArrayBuffer =
          typeof window._readFileArrayBuffer === 'function' &&
          typeof window._writeFileArrayBuffer === 'function' &&
          typeof window._readFileArrayBufferChunk === 'function' &&
          typeof window._getFileSize === 'function'

        if (!this.useV8ArrayBuffer) {
          // console.warn('[fs] V8 ArrayBuffer methods not available. Using transport fallback.')
        } else {
          // console.log('[fs] V8 ArrayBuffer 已启用（高性能零拷贝模式，支持大文件分块读取）')
        }
      }

      // ============ 文件操作 ============

      /**
       * 读取文件内容
       * 使用 V8 ArrayBuffer 直接传输（零拷贝）
       * 支持大文件分块读取和进度回调
       * @param {string} path - 文件路径
       * @param {object} options - 选项
       * @param {function} options.onProgress - 进度回调函数 (read, total) => void
       * @param {number} options.chunkSize - 分块大小（字节），默认 2MB，小于此大小的文件直接读取
       * @returns {Promise<string>} 文件内容（文本）
       */
      async readFile(path, options = {}) {
        try {
          const { onProgress, chunkSize = 2 * 1024 * 1024 } = options

          if (this.transport.isElectronEnvironment()) {
            const bytes = await readElectronChunks(
              this.transport,
              'filesystem_read_file_chunk',
              { path },
              chunkSize,
              onProgress
            )
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          }

          // 获取文件大小
          const fileSize = window._getFileSize(path)
          if (fileSize < 0) {
            throw new Error('File not found or cannot get file size')
          }

          // 小文件直接读取（性能优化）
          if (fileSize <= chunkSize) {
            const arrayBuffer = window._readFileArrayBuffer(path)
            if (onProgress) {
              onProgress(fileSize, fileSize)
            }
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
              arrayBuffer
            )
            return decoded
          }

          // 大文件分块读取
          const chunks = []
          let offset = 0
          const defaultChunkSize = 2 * 1024 * 1024 // 2MB per chunk

          while (offset < fileSize) {
            const currentChunkSize = Math.min(defaultChunkSize, fileSize - offset)
            const chunkBuffer = window._readFileArrayBufferChunk(
              path,
              offset,
              currentChunkSize
            )
            const chunk = new Uint8Array(chunkBuffer)
            chunks.push(chunk)
            offset += currentChunkSize

            // 报告进度
            if (onProgress) {
              onProgress(offset, fileSize)
            }

            // 让出控制权，避免阻塞主线程
            await new Promise((resolve) => setTimeout(resolve, 0))
          }

          // 合并所有块
          const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
          const merged = new Uint8Array(totalLength)
          let position = 0
          for (const chunk of chunks) {
            merged.set(chunk, position)
            position += chunk.length
          }

          // 解码为 UTF-8 文本
          const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
            merged.buffer
          )
          return decoded
        } catch (error) {
          throw fileOperationError('Read file failed', error)
        }
      }

      /**
       * 读取文件为二进制数据
       * 使用 V8 ArrayBuffer 直接传输（零拷贝）
       * 支持大文件分块读取和进度回调
       * 适合读取图片、音频、视频等二进制文件
       * @param {string} path - 文件路径
       * @param {object} options - 选项
       * @param {function} options.onProgress - 进度回调函数 (read, total) => void
       * @param {number} options.chunkSize - 分块大小（字节），默认 2MB，小于此大小的文件直接读取
       * @returns {Promise<Uint8Array>} 二进制数据
       */
      async readFileAsBinary(path, options = {}) {
        try {
          const { onProgress, chunkSize = 5 * 1024 * 1024 } = options

          if (this.transport.isElectronEnvironment()) {
            return await readElectronChunks(
              this.transport,
              'filesystem_read_file_chunk',
              { path },
              chunkSize,
              onProgress
            )
          }

          // 获取文件大小
          const fileSize = window._getFileSize(path)
          if (fileSize < 0) {
            throw new Error('File not found or cannot get file size')
          }

          // 小文件直接读取（性能优化）
          if (fileSize <= chunkSize) {
            const arrayBuffer = window._readFileArrayBuffer(path)
            if (onProgress) {
              onProgress(fileSize, fileSize)
            }
            return new Uint8Array(arrayBuffer)
          }

          // 大文件分块读取
          const chunks = []
          let offset = 0
          const defaultChunkSize = 5 * 1024 * 1024 // 2MB per chunk

          while (offset < fileSize) {
            const currentChunkSize = Math.min(defaultChunkSize, fileSize - offset)
            const chunkBuffer = window._readFileArrayBufferChunk(
              path,
              offset,
              currentChunkSize
            )
            const chunk = new Uint8Array(chunkBuffer)
            chunks.push(chunk)
            offset += currentChunkSize

            // 报告进度
            if (onProgress) {
              onProgress(offset, fileSize)
            }

            // 让出控制权，避免阻塞主线程
            await new Promise((resolve) => setTimeout(resolve, 0))
          }

          // 合并所有块
          const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
          const merged = new Uint8Array(totalLength)
          let position = 0
          for (const chunk of chunks) {
            merged.set(chunk, position)
            position += chunk.length
          }

          return merged
        } catch (error) {
          throw fileOperationError('Read file as binary failed', error)
        }
      }

      /**
       * 写入文件内容
       * 使用 V8 ArrayBuffer 直接传输（零拷贝）
       * 支持大文件分块写入和进度回调
       * @param {string} path - 文件路径
       * @param {string|ArrayBuffer|Uint8Array} content - 文件内容
       * @param {object} options - 选项
       * @param {function} options.onProgress - 进度回调函数 (written, total) => void
       * @param {number} options.chunkSize - 分块大小（字节），默认 2MB，小于此大小的文件直接写入
       * @returns {Promise<boolean>}
       */
      async writeFile(path, content, options = {}) {
        try {
          const { onProgress, chunkSize = 2 * 1024 * 1024 } = options

          if (this.transport.isElectronEnvironment()) {
            if (options.overwrite === false) {
              // The streaming start API currently has replace semantics only. Keep
              // no-overwrite writes on the host's atomic exclusive-write endpoint.
              const encoded = encodeContent(content)
              const result = await this.transport.call('filesystem_write_file', {
                path,
                ...encoded,
                overwrite: false
              })
              if (!result?.success || !Number.isSafeInteger(result.size)) {
                throw new Error('Write file returned invalid data')
              }
              onProgress?.(result.size, result.size)
              return true
            }

            return await writeElectronChunks(
              this.transport,
              {
                start: 'filesystem_write_file_start',
                chunk: 'filesystem_write_file_chunk',
                end: 'filesystem_write_file_end',
                cancel: 'filesystem_write_file_cancel'
              },
              { path },
              contentToBytes(content),
              chunkSize,
              onProgress
            )
          }

          if (options.overwrite === false) {
            const error = new Error('当前宿主不支持原子禁止覆盖写入')
            error.code = 'NOT_SUPPORTED'
            throw error
          }

          let uint8Array
          // 统一转换为 Uint8Array
          if (typeof content === 'string') {
            const encoder = new TextEncoder()
            uint8Array = encoder.encode(content)
          } else if (content instanceof ArrayBuffer) {
            uint8Array = new Uint8Array(content)
          } else if (content instanceof Uint8Array) {
            uint8Array = content
          } else {
            throw new Error('Content must be string, ArrayBuffer, or Uint8Array')
          }

          const totalSize = uint8Array.length

          // 小文件直接写入（性能优化）
          if (totalSize <= chunkSize) {
            // 方案A：传入普通 JS 数组 [0..255]，由 Delphi 端按字节写入
            const byteArray = Array.from(uint8Array)
            const success = window._writeFileArrayBuffer(path, byteArray)
            if (!success) {
              throw new Error('Write file returned false')
            }
            if (onProgress) {
              onProgress(totalSize, totalSize)
            }
            return true
          }

          // 大文件分块写入模拟进度（实际写入仍然一次性）
          const defaultChunkSize = 2 * 1024 * 1024 // 2MB per chunk
          let offset = 0

          while (offset < totalSize) {
            const currentChunkSize = Math.min(defaultChunkSize, totalSize - offset)
            offset += currentChunkSize

            if (onProgress) {
              onProgress(offset, totalSize)
            }

            // 让出控制权
            await new Promise((resolve) => setTimeout(resolve, 0))
          }

          // 实际写入（一次性）
          const byteArray = Array.from(uint8Array)
          const success = window._writeFileArrayBuffer(path, byteArray)
          if (!success) {
            throw new Error('Write file returned false')
          }

          return true
        } catch (error) {
          throw fileOperationError('Write file failed', error)
        }
      }

      // ============ Cache 目录封装 ============

      /**
       * 获取当前插件的 Cache 基础目录
       * 形如: bin\Cache\<pluginId>
       * @returns {Promise<string>}
       * @private
       */
      async _getCacheBaseDir() {
        if (this._cacheBaseDir) {
          return this._cacheBaseDir
        }

        try {
          const r = await this.transport.call('get_system_info', {})
          if (r && r.success) {
            let cacheRoot = r.cachePath || ''

            // 后端未显式提供 cachePath 时, 退化为 binPath + 'Cache\'
            if (!cacheRoot && r.binPath) {
              const bin = r.binPath
              const sep = bin.endsWith('\\') || bin.endsWith('/') ? '' : '\\'
              cacheRoot = `${bin}${sep}Cache\\`
            }

            if (!cacheRoot) {
              cacheRoot = 'Cache\\'
            }

            const pluginId = window.__ztools_plugin_id || 'main'
            const base =
              cacheRoot.endsWith('\\') || cacheRoot.endsWith('/')
                ? cacheRoot
                : `${cacheRoot}\\`
            this._cacheBaseDir = `${base}${pluginId}`
            return this._cacheBaseDir
          }
        } catch (e) {
          // 忽略错误, 走降级路径
        }

        // 最坏情况: 使用相对 Cache\<pluginId>
        const pluginId = window.__ztools_plugin_id || 'main'
        this._cacheBaseDir = `Cache\\${pluginId}`
        return this._cacheBaseDir
      }

      /**
       * 写入当前插件的 Cache 文件
       * 最终路径: bin\Cache\<pluginId>\relativePath
       * @param {string} relativePath - 相对于插件 Cache 根目录的路径
       * @param {string|ArrayBuffer|Uint8Array} content - 文件内容
       * @param {object} options - 透传给 writeFile 的参数
       */
      async writeCache(relativePath, content, options = {}) {
        if (this.transport.isElectronEnvironment()) {
          try {
            if (options.overwrite === false) {
              const error = new Error('当前宿主缓存写入接口不支持原子禁止覆盖')
              error.code = 'NOT_SUPPORTED'
              throw error
            }
            return await writeElectronChunks(
              this.transport,
              {
                start: 'filesystem_write_cache_start',
                chunk: 'filesystem_write_cache_chunk',
                end: 'filesystem_write_cache_end',
                cancel: 'filesystem_write_cache_cancel'
              },
              { relativePath },
              contentToBytes(content),
              options.chunkSize,
              options.onProgress
            )
          } catch (error) {
            throw fileOperationError('Write cache failed', error)
          }
        }

        const baseDir = await this._getCacheBaseDir()
        const rel = (relativePath || '')
          .trim()
          .replace(/[\\/]+/g, '\\')
          .replace(/^\\+/, '')

        const fullPath = rel ? `${baseDir}\\${rel}` : baseDir

        // 确保目录存在
        const lastSlash = fullPath.lastIndexOf('\\')
        if (lastSlash > 0) {
          const dir = fullPath.slice(0, lastSlash)
          try {
            const exists = await this.directoryExists(dir)
            if (!exists) {
              await this.createDirectory(dir)
            }
          } catch (_) {
            // 目录检查失败时交由后续写入报错
          }
        }

        return this.writeFile(fullPath, content, options)
      }

      /**
       * 读取当前插件的 Cache 文件
       * @param {string} relativePath - 相对于插件 Cache 根目录的路径
       * @param {object} options - 同 readFile
       * @returns {Promise<string>}
       */
      async readCache(relativePath, options = {}) {
        if (this.transport.isElectronEnvironment()) {
          try {
            const bytes = await readElectronChunks(
              this.transport,
              'filesystem_read_cache_chunk',
              { relativePath },
              options.chunkSize,
              options.onProgress
            )
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
          } catch (error) {
            throw fileOperationError('Read cache failed', error)
          }
        }

        const baseDir = await this._getCacheBaseDir()
        const rel = (relativePath || '')
          .trim()
          .replace(/[\\/]+/g, '\\')
          .replace(/^\\+/, '')

        const fullPath = rel ? `${baseDir}\\${rel}` : baseDir
        return this.readFile(fullPath, options)
      }

      /**
       * 删除文件
       * @param {string} path - 文件路径
       * @returns {Promise<boolean>}
       */
      async deleteFile(path) {
        const r = await this.transport.call('filesystem_delete_file', { path })
        if (r && r.success) {
          return true
        }
        throw new Error(r?.error || 'Delete file failed')
      }

      /**
       * 复制文件
       * @param {string} sourcePath - 源文件路径
       * @param {string} destPath - 目标文件路径
       * @returns {Promise<boolean>}
       */
      async copyFile(sourcePath, destPath) {
        const r = await this.transport.call('filesystem_copy_file', {
          sourcePath,
          destPath
        })
        if (r && r.success) {
          return true
        }
        throw new Error(r?.error || 'Copy file failed')
      }

      /**
       * 移动文件
       * @param {string} sourcePath - 源文件路径
       * @param {string} destPath - 目标文件路径
       * @returns {Promise<boolean>}
       */
      async moveFile(sourcePath, destPath) {
        const r = await this.transport.call('filesystem_move_file', {
          sourcePath,
          destPath
        })
        if (r && r.success) {
          return true
        }
        throw new Error(r?.error || 'Move file failed')
      }

      /**
       * 检查文件是否存在
       * @param {string} path - 文件路径
       * @returns {Promise<boolean>}
       */
      async fileExists(path) {
        const r = await this.transport.call('filesystem_file_exists', { path })
        if (r && r.success) {
          return r.exists || false
        }
        return false
      }

      /**
       * 获取文件大小
       * @param {string} path - 文件路径
       * @returns {Promise<number>} 文件大小(字节),-1表示失败
       */
      async getFileSize(path) {
        const r = await this.transport.call('filesystem_get_file_size', { path })
        if (r && r.success && r.size !== undefined) {
          return r.size
        }
        return -1
      }

      // ============ 目录操作 ============

      /**
       * 创建目录
       * @param {string} path - 目录路径
       * @returns {Promise<boolean>}
       */
      async createDirectory(path) {
        const r = await this.transport.call('filesystem_create_directory', { path })
        if (r && r.success) {
          return true
        }
        throw new Error(r?.error || 'Create directory failed')
      }

      /**
       * 删除目录
       * @param {string} path - 目录路径
       * @returns {Promise<boolean>}
       */
      async deleteDirectory(path) {
        const r = await this.transport.call('filesystem_delete_directory', { path })
        if (r && r.success) {
          return true
        }
        throw new Error(r?.error || 'Delete directory failed')
      }

      /**
       * 检查目录是否存在
       * @param {string} path - 目录路径
       * @returns {Promise<boolean>}
       */
      async directoryExists(path) {
        const r = await this.transport.call('filesystem_directory_exists', { path })
        if (r && r.success) {
          return r.exists || false
        }
        return false
      }

      /**
       * 获取目录内容
       * @param {string} path - 目录路径
       * @returns {Promise<Array>} 文件和目录列表
       */
      async getDirectoryContents(path) {
        const r = await this.transport.call('filesystem_get_directory_contents', {
          path
        })
        if (r && r.success && r.files) {
          return r.files
        }
        throw new Error(r?.error || 'Get directory contents failed')
      }

      /**
       * 获取当前工作目录
       * @returns {Promise<string>}
       */
      async getCurrentDirectory() {
        const r = await this.transport.call('filesystem_get_current_directory', {})
        if (r && r.success && r.path) {
          return r.path
        }
        throw new Error(r?.error || 'Get current directory failed')
      }

      /**
       * 设置当前工作目录
       * @param {string} path - 目录路径
       * @returns {Promise<boolean>}
       */
      async setCurrentDirectory(path) {
        const r = await this.transport.call('filesystem_set_current_directory', {
          path
        })
        if (r && r.success) {
          return true
        }
        throw new Error(r?.error || 'Set current directory failed')
      }

      // ============ 文件查找 ============

      /**
       * 查找文件
       * @param {string} path - 搜索路径
       * @param {string} pattern - 文件模式,默认 '*.*'
       * @returns {Promise<Array>} 文件列表
       */
      async findFiles(path, pattern = '*.*') {
        const r = await this.transport.call('filesystem_find_files', {
          path,
          pattern
        })
        if (r && r.success && r.files) {
          return r.files
        }
        throw new Error(r?.error || 'Find files failed')
      }

      /**
       * 查找目录
       * @param {string} path - 搜索路径
       * @param {string} pattern - 目录模式,默认 '*'
       * @returns {Promise<Array>} 目录列表
       */
      async findDirectories(path, pattern = '*') {
        const r = await this.transport.call('filesystem_find_directories', {
          path,
          pattern
        })
        if (r && r.success && r.files) {
          return r.files
        }
        throw new Error(r?.error || 'Find directories failed')
      }

      // ============ 路径操作 ============

      /**
       * 获取完整路径
       * @param {string} path - 相对或绝对路径
       * @returns {Promise<string>}
       */
      async getFullPath(path) {
        const r = await this.transport.call('filesystem_get_full_path', { path })
        if (r && r.success && r.path) {
          return r.path
        }
        throw new Error(r?.error || 'Get full path failed')
      }

      /**
       * 合并路径
       * @param {string} path1 - 路径1
       * @param {string} path2 - 路径2
       * @returns {Promise<string>}
       */
      async combinePath(path1, path2) {
        const r = await this.transport.call('filesystem_combine_path', {
          path1,
          path2
        })
        if (r && r.success && r.path) {
          return r.path
        }
        throw new Error(r?.error || 'Combine path failed')
      }

      /**
       * 获取文件名
       * @param {string} path - 文件路径
       * @returns {Promise<string>}
       */
      async getFileName(path) {
        const r = await this.transport.call('filesystem_get_file_name', { path })
        if (r && r.success && r.name !== undefined) {
          return r.name
        }
        throw new Error(r?.error || 'Get file name failed')
      }

      /**
       * 获取文件扩展名
       * @param {string} path - 文件路径
       * @returns {Promise<string>}
       */
      async getExtension(path) {
        const r = await this.transport.call('filesystem_get_extension', { path })
        if (r && r.success && r.extension !== undefined) {
          return r.extension
        }
        throw new Error(r?.error || 'Get extension failed')
      }

      /**
       * 获取父目录
       * @param {string} path - 路径
       * @returns {Promise<string>}
       */
      async getParentDirectory(path) {
        const r = await this.transport.call('filesystem_get_parent_directory', {
          path
        })
        if (r && r.success && r.path !== undefined) {
          return r.path
        }
        throw new Error(r?.error || 'Get parent directory failed')
      }
    }

    // ========================================
    // api/fs-reference.js
    // ========================================

    /** SDK contract 2 source. Client activation accompanies Main/preload/manifest and all consumer migration. */
    class ReferenceFileSystemAPI {
      constructor(transport) { this.transport = transport }

      _error(code, message) { const error = new Error(message); error.code = code; return error }
      _reference(ref, kinds, right) {
        if (!ref || typeof ref !== 'object' || Array.isArray(ref) ||
            typeof ref.grantId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ref.grantId) || !kinds.includes(ref.kind) ||
            Object.keys(ref).some(key => !['grantId', 'displayName', 'kind', 'operations', 'fileUrl'].includes(key)) ||
            !Array.isArray(ref.operations) || (right && !ref.operations.includes(right))) {
          throw this._error('INVALID_REQUEST', '请使用当前SDK授权的文件引用，不能使用旧路径')
        }
        return ref.grantId
      }
      _relative(value = '', empty = true) {
        if (typeof value !== 'string' || new TextEncoder().encode(value).length > 4096 || value.includes('\0') || (!empty && !value)) {
          throw this._error('INVALID_REQUEST', '相对文件名无效')
        }
        if (value) {
          const parts = value.split('/')
          if (parts.length > 64 || parts.some(part => !part || part === '.' || part === '..' || /^\.ztools-save-/i.test(part))) {
            throw this._error('INVALID_REQUEST', '相对文件名超出授权范围')
          }
        }
        return value
      }
      _options(options, keys) {
        if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !keys.includes(key))) {
          throw this._error('INVALID_REQUEST', '文件选项无效')
        }
        if (options.replace !== undefined && typeof options.replace !== 'boolean') throw this._error('INVALID_REQUEST', 'replace必须为布尔值')
        if (options.onProgress !== undefined && typeof options.onProgress !== 'function') throw this._error('INVALID_REQUEST', 'onProgress必须为函数')
        if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== 'boolean' ||
            typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) {
          throw this._error('INVALID_REQUEST', 'signal必须为AbortSignal')
        }
        return options
      }
      async _call(method, params, options = {}, allowWriteOutcomeUnknown = false) {
        const bridge = window.__ztoolsElectron
        if (options.signal?.aborted) throw this._error('CALLER_DESTROYED', '文件请求已取消')
        if (bridge?.contractVersion !== 2 || typeof bridge.transport?.methods?.[method] !== 'function') {
          throw this._error('NOT_SUPPORTED', '文件引用需要已完成迁移的SDK合约2宿主')
        }
        // Cancellation requires the per-method bridge and the actual Transport implementation, never local-only pretend cancellation.
        if (options.signal && (typeof bridge.transport?.cancellations?.[method] !== 'function' || this.transport.supportsAbortSignal !== true)) {
          throw this._error('NOT_SUPPORTED', '当前宿主尚未开放此文件请求的取消入口')
        }
        let result = await this.transport.call(method, params, { ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeout !== undefined ? { timeout: options.timeout } : {}) })
        if (allowWriteOutcomeUnknown) {
          result = this._writeRecord(result, ['success', 'status', 'size', 'reference']) ||
            this._writeRecord(result, ['success', 'status', 'size', 'issues']) ||
            this._writeRecord(result, ['success', 'status', 'code']) || this._writeRecord(result, ['success', 'error'])
          if (!result) throw this._error('FILE_ERROR', '文件写入回执无效')
          if (result.error) result.error = this._writeRecord(result.error, ['code', 'message'])
        }
        if (!result?.success) {
          const keys = result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result) : []
          if (allowWriteOutcomeUnknown && result?.success === false && result.status === 'result-unknown' &&
              result.code === 'FILE_WRITE_OUTCOME_UNKNOWN' && keys.length === 3 &&
              keys.every(key => ['success', 'status', 'code'].includes(key))) return result
          throw this._error(result?.error?.code || 'FILE_ERROR', result?.error?.message || '文件引用操作失败')
        }
        return result
      }
      async readFile(ref, options = {}) {
        this._options(options, ['relativePath', 'signal', 'onProgress'])
        const result = await this._call('filesystem_read_file', { grantId: this._reference(ref, ['file', 'directory'], 'read'),
          relativePath: this._relative(options.relativePath), encoding: 'utf8' }, options)
        if (typeof result.content !== 'string' || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > 16 * 1024 * 1024 ||
            new TextEncoder().encode(result.content).length > 16 * 1024 * 1024) throw this._error('FILE_ERROR', '文件读取响应无效')
        options.onProgress?.(result.size, result.size)
        return result.content
      }
      async readFileAsBinary(ref, options = {}) {
        this._options(options, ['relativePath', 'signal', 'onProgress'])
        const result = await this._call('filesystem_read_file', { grantId: this._reference(ref, ['file', 'directory'], 'read'),
          relativePath: this._relative(options.relativePath), encoding: 'base64' }, options)
        const bytes = this._decode(result.content, result.size)
        options.onProgress?.(bytes.length, bytes.length)
        return bytes.buffer
      }
      async readFileRange(ref, offset, length, options = {}) {
        this._options(options, ['relativePath', 'signal'])
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
            length > 16 * 1024 * 1024 || offset > Number.MAX_SAFE_INTEGER - length) throw this._error('INVALID_REQUEST', '分段范围无效')
        const result = await this._call('filesystem_read_file_range', { grantId: this._reference(ref, ['file', 'directory'], 'read'),
          relativePath: this._relative(options.relativePath), offset, length }, options)
        const bytes = this._decode(result.content, result.size)
        if (result.offset !== offset || result.encoding !== 'base64' || bytes.length > length) throw this._error('FILE_ERROR', '分段读取响应无效')
        return bytes.buffer
      }
      _decode(content, size) {
        if (typeof content !== 'string' || !Number.isSafeInteger(size) || size < 0 || size > 16 * 1024 * 1024 || content.length > 24 * 1024 * 1024) {
          throw this._error('FILE_ERROR', '文件字节响应超出上限')
        }
        let binary
        try { binary = atob(content) } catch { throw this._error('FILE_ERROR', '文件字节响应无效') }
        if (binary.length !== size || btoa(binary) !== content) throw this._error('FILE_ERROR', '文件字节响应无效')
        return Uint8Array.from(binary, char => char.charCodeAt(0))
      }
      _content(content) {
        let value
        try { value = encodeContent(content) } catch { throw this._error('INVALID_REQUEST', '文件内容必须为文本或字节数组') }
        const bytes = value.encoding === 'utf8' ? new TextEncoder().encode(value.content).length : atob(value.content).length
        if (bytes > 16 * 1024 * 1024) throw this._error('FILE_TOO_LARGE', '单次文件写入超过16MiB上限')
        return value
      }
      _writeRecord(value, fields) {
        try {
          if (!value || typeof value !== 'object') return null
          const proto = Object.getPrototypeOf(value)
          const constructor = proto && Object.getOwnPropertyDescriptor(proto, 'constructor')?.value
          if (proto !== null && (Object.getPrototypeOf(proto) !== null ||
              typeof constructor !== 'function' || Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(Object))) return null
          const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors)
          if (keys.length !== fields.length || keys.some(key => !fields.includes(key) ||
              !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) return null
          return Object.fromEntries(fields.map(key => [key, descriptors[key].value]))
        } catch { return null }
      }
      _unavailableWriteReceipt(result, expectedBytes) {
        const data = (value, fields) => this._writeRecord(value, fields)
        try {
          const fact = data(result, ['success', 'status', 'size', 'issues'])
          if (!fact || fact.success !== true || fact.status !== 'committed-reference-unavailable' ||
              !Number.isSafeInteger(fact.size) || fact.size < 0 || fact.size > 16 * 1024 * 1024 ||
              fact.size !== expectedBytes || !Array.isArray(fact.issues) || fact.issues.length < 1 || fact.issues.length > 2) return null
          const issues = [], seen = new Set()
          for (let index = 0; index < fact.issues.length; index++) {
            const descriptor = Object.getOwnPropertyDescriptor(fact.issues, String(index))
            const issue = descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value') && data(descriptor.value, ['stage', 'code'])
            if (!issue || !['reference', 'release'].includes(issue.stage) || seen.has(issue.stage) ||
                (issue.stage === 'reference' && seen.has('release')) ||
                !['PERMISSION_DENIED', 'FILE_ERROR'].includes(issue.code) ||
                (issue.stage === 'release' && issue.code !== 'FILE_ERROR')) return null
            seen.add(issue.stage); issues.push(Object.freeze(issue))
          }
          if (Reflect.ownKeys(fact.issues).length !== issues.length + 1) return null
          return Object.freeze({ success: true, status: fact.status, size: fact.size, issues: Object.freeze(issues) })
        } catch { return null }
      }
      async writeFile(ref, content, options = {}) {
        this._options(options, ['replace', 'signal'])
        const encoded = this._content(content)
        const expectedBytes = encoded.encoding === 'utf8' ? new TextEncoder().encode(encoded.content).length : atob(encoded.content).length
        const result = await this._call('filesystem_write_file', { saveGrantId: this._reference(ref, ['save'], 'write'),
          ...encoded, replace: options.replace ?? false }, options, true)
        if (result.success === false) return Object.freeze({ success: false, status: 'result-unknown', code: 'FILE_WRITE_OUTCOME_UNKNOWN' })
        const unavailable = this._unavailableWriteReceipt(result, expectedBytes)
        if (unavailable) return unavailable
        const keys = result && typeof result === 'object' && !Array.isArray(result) ? Object.keys(result) : []
        if (result.success !== true || result.status !== 'committed' || !Number.isSafeInteger(result.size) ||
            result.size !== expectedBytes || !result.reference || keys.length !== 4 ||
            keys.some(key => !['success', 'status', 'size', 'reference'].includes(key))) {
          throw this._error('FILE_ERROR', '文件写入回执无效')
        }
        const rawReference = this._writeRecord(result.reference, ['grantId', 'displayName', 'kind', 'operations', 'fileUrl'])
        const operation = Array.isArray(rawReference?.operations) && Object.getOwnPropertyDescriptor(rawReference.operations, '0')
        if (!rawReference || !Array.isArray(rawReference.operations) || rawReference.operations.length !== 1 ||
            Reflect.ownKeys(rawReference.operations).length !== 2 ||
            operation?.enumerable !== true || !Object.hasOwn(operation, 'value') || operation.value !== 'read') {
          throw this._error('FILE_ERROR', '文件写入回执无效')
        }
        rawReference.operations = ['read']
        const reference = this._returnedReference(rawReference, ['file'])
        if (typeof reference.fileUrl !== 'string' ||
            reference.fileUrl !== 'ztools://file/' + reference.grantId + '/' + encodeURIComponent(reference.displayName)) {
          throw this._error('FILE_ERROR', '文件写入回执产物 URL 无效')
        }
        return Object.freeze({ success: true, status: 'committed', size: result.size,
          reference: Object.freeze({ ...reference, operations: Object.freeze([...reference.operations]) }) })
      }
      async copyFile(source, destination, options = {}) {
        this._options(options, ['replace', 'signal'])
        return this._call('filesystem_copy_file', { fileGrantId: this._reference(source, ['file'], 'read'),
          saveGrantId: this._reference(destination, ['save'], 'write'), replace: options.replace ?? false }, options)
      }
      async moveFile(directory, relativePath, destination, options = {}) {
        this._options(options, ['replace', 'signal'])
        return this._call('filesystem_move_file', { directoryGrantId: this._reference(directory, ['directory'], 'write'),
          relativePath: this._relative(relativePath, false), saveGrantId: this._reference(destination, ['save'], 'write'), replace: options.replace ?? false }, options)
      }
      async _directory(method, directory, relativePath, right, options = {}, extra = {}, empty = false) {
        this._options(options, ['signal'])
        return this._call(method, { directoryGrantId: this._reference(directory, ['directory'], right), relativePath: this._relative(relativePath, empty), ...extra }, options)
      }
      async deleteFile(directory, name, options = {}) { return this._directory('filesystem_delete_file', directory, name, 'write', options, { isDirectory: false }) }
      async deleteDirectory(directory, name, options = {}) { return this._directory('filesystem_delete_directory', directory, name, 'write', options, { isDirectory: true }) }
      async createDirectory(directory, name, options = {}) { return this._directory('filesystem_create_directory', directory, name, 'write', options) }
      async getDirectoryContents(directory, name = '', options = {}) {
        const files = (await this._directory('filesystem_get_directory_contents', directory, name, 'list', options, {}, true)).files
        return this._listedFiles(files)
      }
      _listedFiles(files) {
        let names = 0
        if (!Array.isArray(files) || files.length > 10000 || files.some(file => {
          if (!file || typeof file !== 'object' || Array.isArray(file) || Object.keys(file).some(key => !['name', 'isDirectory', 'size'].includes(key)) ||
              typeof file.name !== 'string' || !file.name || file.name === '.' || file.name === '..' || /[\/\0]/.test(file.name) ||
              /^\.ztools-save-/i.test(file.name) || typeof file.isDirectory !== 'boolean' || !Number.isSafeInteger(file.size) || file.size < 0) return true
          const bytes = new TextEncoder().encode(file.name).length
          names += bytes
          return bytes > 4096 || names > 1024 * 1024
        })) throw this._error('FILE_ERROR', '目录枚举响应无效')
        return files
      }
      async _find(method, directory, pattern, options) {
        this._options(options, ['relativePath', 'caseSensitive', 'signal'])
        if (typeof pattern !== 'string' || !pattern || new TextEncoder().encode(pattern).length > 256 ||
            Array.from(pattern).length > 128 || /[\/\0]/.test(pattern) ||
            (options.caseSensitive !== undefined && typeof options.caseSensitive !== 'boolean')) throw this._error('INVALID_REQUEST', '文件查找模式无效')
        const result = await this._call(method, { directoryGrantId: this._reference(directory, ['directory'], 'list'),
          relativePath: this._relative(options.relativePath), pattern, caseSensitive: options.caseSensitive ?? true }, options)
        const files = this._listedFiles(result.files)
        if (files.some(file => file.isDirectory !== (method === 'filesystem_find_directories'))) throw this._error('FILE_ERROR', '文件查找响应类型无效')
        return files
      }
      async findFiles(directory, pattern = '*', options = {}) { return this._find('filesystem_find_files', directory, pattern, options) }
      async findDirectories(directory, pattern = '*', options = {}) { return this._find('filesystem_find_directories', directory, pattern, options) }
      _returnedReference(value, kinds) {
        try {
          this._reference(value, kinds)
          if (typeof value.displayName !== 'string' || value.displayName.includes('\0') || new TextEncoder().encode(value.displayName).length > 4096 ||
              new Set(value.operations).size !== value.operations.length || value.operations.some(right => !['read', 'write', 'list'].includes(right)) ||
              (value.kind === 'file' && (value.operations.length !== 1 || value.operations[0] !== 'read')) ||
              (value.kind === 'save' && (value.operations.length !== 1 || value.operations[0] !== 'write')) ||
              (value.fileUrl !== undefined && (value.kind !== 'file' || typeof value.fileUrl !== 'string' ||
                value.fileUrl !== 'ztools://file/' + value.grantId + '/' + encodeURIComponent(value.displayName)))) throw new Error('invalid')
          return value
        } catch { throw this._error('FILE_ERROR', '宿主文件引用响应无效') }
      }
      async deriveRead(directory, name, options = {}) { return this._returnedReference((await this._directory('filesystem_derive_read', directory, name, 'read', options)).reference, ['file']) }
      async deriveSave(directory, name, options = {}) { return this._returnedReference((await this._directory('filesystem_derive_save', directory, name, 'write', options)).reference, ['save']) }
      async deriveDirectory(directory, name, options = {}) { return this._returnedReference((await this._directory('filesystem_derive_directory', directory, name, undefined, options)).reference, ['directory']) }
      async describe(ref, options = {}) {
        this._options(options, ['signal'])
        const result = await this._call('filesystem_describe', { grantId: this._reference(ref, ['file', 'directory']) }, options)
        if (typeof result.isDirectory !== 'boolean' || !Number.isSafeInteger(result.size) || result.size < 0 ||
            !Number.isSafeInteger(result.lastModifiedMs)) throw this._error('FILE_ERROR', '文件元数据响应无效')
        return result
      }
      async getFileSize(ref, options = {}) { return (await this.describe(ref, options)).size }
      async fileExists(ref, options = {}) { return !(await this.describe(ref, options)).isDirectory }
      async directoryExists(ref, options = {}) { return (await this.describe(ref, options)).isDirectory }
      async revoke(ref) { return this._call('filesystem_revoke', { grantId: this._reference(ref, ['file', 'directory', 'save']) }) }
      async getCurrentDirectory() {
        const reference = (await this._call('filesystem_get_current_directory', {})).reference
        return reference === null ? null : this._returnedReference(reference, ['directory'])
      }
      async setCurrentDirectory(directory, options = {}) {
        this._options(options, ['signal'])
        return this._call('filesystem_set_current_directory', { directoryGrantId: this._reference(directory, ['directory'], 'read') }, options)
      }
      _recoveryEntry(entry, inspected = false) {
        const fields = ['recoveryId', 'displayName', 'phase', 'createdAt', 'expectedBytes', ...(inspected ? ['observation', 'businessResult'] : [])]
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== fields.length ||
            Object.keys(entry).some(key => !fields.includes(key)) || typeof entry.recoveryId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.recoveryId) ||
            typeof entry.displayName !== 'string' || !entry.displayName || /[\/\0]/.test(entry.displayName) ||
            new TextEncoder().encode(entry.displayName).length > 4096 || !['intent', 'staging', 'committing', 'unknown'].includes(entry.phase) ||
            !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0 ||
            (entry.expectedBytes !== null && (!Number.isSafeInteger(entry.expectedBytes) || entry.expectedBytes < 0 || entry.expectedBytes > 2 * 1024 ** 3))) {
          throw this._error('FILE_ERROR', '写入恢复响应无效')
        }
        if (inspected) {
          const observation = entry.observation
          if (entry.businessResult !== 'unconfirmed' || !observation || typeof observation !== 'object' || Array.isArray(observation) ||
              Object.keys(observation).length !== 2 || !['unresolved', 'staging', 'committed-object'].includes(observation.state) ||
              (observation.reason === 'no-object-proof' ? observation.state !== 'unresolved' || Object.keys(observation).some(key => !['state', 'reason'].includes(key)) :
                Object.keys(observation).some(key => !['state', 'size'].includes(key)) || !Number.isSafeInteger(observation.size) || observation.size < 0)) {
            throw this._error('FILE_ERROR', '写入恢复观察结果无效')
          }
          return Object.freeze({ ...entry, observation: Object.freeze({ ...observation }) })
        }
        return Object.freeze({ ...entry })
      }
      async listWriteRecovery(options = {}) {
        this._options(options, ['signal'])
        const entries = (await this._call('filesystem_list_write_recovery', {}, options)).entries
        if (!Array.isArray(entries) || entries.length > 256) throw this._error('FILE_ERROR', '写入恢复记录超出上限')
        const ids = new Set()
        return Object.freeze(entries.map(entry => {
          const result = this._recoveryEntry(entry)
          if (ids.has(result.recoveryId)) throw this._error('FILE_ERROR', '写入恢复记录重复')
          ids.add(result.recoveryId)
          return result
        }))
      }
      async inspectWriteRecovery(recoveryId, options = {}) {
        this._options(options, ['signal'])
        if (typeof recoveryId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(recoveryId)) {
          throw this._error('INVALID_REQUEST', '写入恢复记录ID无效')
        }
        const entry = this._recoveryEntry((await this._call('filesystem_inspect_write_recovery', { recoveryId }, options)).entry, true)
        if (entry.recoveryId !== recoveryId) throw this._error('FILE_ERROR', '写入恢复记录ID不匹配')
        return entry
      }
      async readCache(name, options = {}) {
        this._options(options, ['signal'])
        const result = await this._call('filesystem_read_cache', { name: this._relative(name, false), encoding: 'utf8' }, options)
        if (typeof result.content !== 'string' || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > 16 * 1024 * 1024 ||
            new TextEncoder().encode(result.content).length > 16 * 1024 * 1024) throw this._error('FILE_ERROR', '缓存读取响应无效')
        return result.content
      }
      async readCacheAsBinary(name, options = {}) {
        this._options(options, ['signal'])
        const result = await this._call('filesystem_read_cache', { name: this._relative(name, false), encoding: 'base64' }, options)
        return this._decode(result.content, result.size).buffer
      }
      async writeCache(name, content, options = {}) {
        this._options(options, ['replace', 'signal'])
        const result = await this._call('filesystem_write_cache', { name: this._relative(name, false), ...this._content(content), replace: options.replace ?? false }, options)
        this._returnedReference(result.reference, ['file'])
        return result
      }
    }

    // ========================================
    // api/db.js
    // ========================================

    /**
     * Database API - 存储/数据库操作
     * 封装存储相关的业务逻辑
     */
    class DatabaseAPI {
      static arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer)
        const chunks = []
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
        }
        return btoa(chunks.join(''))
      }

      constructor(transport) {
        this.transport = transport
        this._currentPluginId = null
      }

      /**
       * 设置当前插件ID（用于便捷API）
       * @param {string} pluginId - 插件ID
       */
      async setPluginId(pluginId) {
        this._currentPluginId = pluginId
      }

      /**
       * 获取存储的值（带插件ID参数）
       * @param {string} pluginIdOrKey - 插件ID 或 键名（如果已设置 pluginId）
       * @param {string} key - 键名（可选）
       * @returns {Promise<any>} 存储的值,不存在返回null
       */
      async get(pluginIdOrKey, key) {
        try {
          let pluginId, actualKey

          if (key !== undefined) {
            // 两个参数：get(pluginId, key)
            pluginId = pluginIdOrKey
            actualKey = key
          } else if (this._currentPluginId) {
            // 一个参数且已设置 pluginId：get(key)
            pluginId = this._currentPluginId
            actualKey = pluginIdOrKey
          } else {
            return null
          }

          const r = await this.transport.call('db_get', {
            plugin_id: pluginId,
            key: actualKey
          })
          if (r && r.success === true && r.data !== undefined) {
            // 尝试解析 JSON，如果失败则返回原始字符串
            if (typeof r.data === 'string') {
              try {
                return JSON.parse(r.data)
              } catch {
                return r.data
              }
            }
            return r.data
          }
          return null
        } catch {
          return null
        }
      }

      /**
       * 存储文档（uTools 风格）
       * @param {object} doc - 文档对象，必须包含 _id 字段
       * @returns {Promise<object>} 存储的文档
       */
      async put(doc) {
        if (!this._currentPluginId) {
          throw new Error('Please call setPluginId() first')
        }
        if (!doc || !doc._id) {
          throw new Error('Document must have _id field')
        }

        const key = doc._id
        const value = doc

        const r = await this.transport.call('db_put', {
          plugin_id: this._currentPluginId,
          key,
          value
        })

        if (r && r.success === true) {
          return doc
        }
        throw new Error(r?.error || 'Put failed')
      }

      /**
       * 删除文档（uTools 风格）
       * @param {string} id - 文档ID
       * @returns {Promise<object>} 删除结果
       */
      async remove(id) {
        if (!this._currentPluginId) {
          throw new Error('Please call setPluginId() first')
        }

        const r = await this.transport.call('db_delete', {
          plugin_id: this._currentPluginId,
          key: id
        })

        if (r && r.success === true) {
          return { ok: true, id }
        }
        throw new Error(r?.error || 'Remove failed')
      }

      /**
       * 设置存储的值
       * @param {string} pluginIdOrKey - 插件ID 或 键名（如果已设置 pluginId）
       * @param {string} keyOrValue - 键名 或 值（如果第一个参数是 key）
       * @param {any} value - 值（可选）
       * @returns {Promise<boolean>}
       */
      async set(pluginIdOrKey, keyOrValue, value) {
        let pluginId, key, actualValue

        if (value !== undefined) {
          // 三个参数：set(pluginId, key, value)
          pluginId = pluginIdOrKey
          key = keyOrValue
          actualValue = value
        } else if (this._currentPluginId) {
          // 两个参数且已设置 pluginId：set(key, value)
          pluginId = this._currentPluginId
          key = pluginIdOrKey
          actualValue = keyOrValue
        } else {
          throw new Error(
            'Please call setPluginId() first or provide pluginId as first parameter'
          )
        }

        const r = await this.transport.call('db_put', {
          plugin_id: pluginId,
          key,
          value: actualValue
        })
        return r && r.success === true
      }

      /**
       * 删除存储的值
       * @param {string} pluginIdOrKey - 插件ID 或 键名（如果已设置 pluginId）
       * @param {string} key - 键名（可选）
       * @returns {Promise<boolean>}
       */
      async delete(pluginIdOrKey, key) {
        let pluginId, actualKey

        if (key !== undefined) {
          // 两个参数：delete(pluginId, key)
          pluginId = pluginIdOrKey
          actualKey = key
        } else if (this._currentPluginId) {
          // 一个参数且已设置 pluginId：delete(key)
          pluginId = this._currentPluginId
          actualKey = pluginIdOrKey
        } else {
          throw new Error(
            'Please call setPluginId() first or provide pluginId as first parameter'
          )
        }

        const r = await this.transport.call('db_delete', {
          plugin_id: pluginId,
          key: actualKey
        })
        return r && r.success === true
      }

      /**
       * 获取所有文档（uTools 风格）
       * @param {string} prefix - 可选的前缀过滤
       * @returns {Promise<Array>} 文档数组
       */
      async allDocs(prefix = '') {
        if (!this._currentPluginId) {
          throw new Error('Please call setPluginId() first')
        }

        const r = await this.transport.call('db_query', {
          plugin_id: this._currentPluginId,
          prefix: prefix || '',
          limit: 0 // 0 表示不限制
        })

        if (r && r.success === true && Array.isArray(r.data)) {
          // 将结果转换为文档格式 (兼容 uTools)
          return r.data.map((item) => {
            try {
              // 如果 value 是 JSON 字符串，解析它
              const doc =
                typeof item.value === 'string' ? JSON.parse(item.value) : item.value
              // 确保包含 _id
              if (!doc._id) {
                doc._id = item.key
              }
              return doc
            } catch {
              // 如果不是 JSON，返回简单对象
              return {
                _id: item.key,
                value: item.value
              }
            }
          })
        }
        throw new Error(typeof r?.error === 'string' && r.error.trim()
          ? r.error
          : 'Database query failed or returned invalid documents')
      }

      /**
       * 批量操作（uTools 风格）
       * @param {Array<object>} docs - 文档数组
       * @returns {Promise<Array>} 操作结果
       */
      async bulkDocs(docs) {
        if (!this._currentPluginId) {
          throw new Error('Please call setPluginId() first')
        }

        if (!Array.isArray(docs) || docs.length === 0) {
          return []
        }

        const operations = docs.map((doc) => ({
          op: 'put',
          key: doc._id,
          value: JSON.stringify(doc)
        }))

        const r = await this.transport.call('db_batch', {
          plugin_id: this._currentPluginId,
          operations
        })

        if (r && r.success === true) {
          return docs.map((doc) => ({ ok: true, id: doc._id }))
        }
        throw new Error(r?.error || 'Batch operation failed')
      }

      /**
       * 添加附件（uTools 风格）
       * @param {string} docId - 文档ID
       * @param {string|ArrayBuffer|Blob} attachment - 附件数据
       * @param {string} type - MIME类型
       * @returns {Promise<object>}
       */
      async postAttachment(docId, attachment, type) {
        if (!this._currentPluginId) {
          throw new Error('Please call setPluginId() first')
        }

        // 将附件转换为 base64
        let base64Data
        if (typeof attachment === 'string') {
          // 如果已经是 data URL，提取 base64 部分
          if (attachment.startsWith('data:')) {
            base64Data = attachment.split(',')[1]
          } else {
            base64Data = btoa(attachment)
          }
        } else if (attachment instanceof ArrayBuffer) {
          base64Data = DatabaseAPI.arrayBufferToBase64(attachment)
        } else if (attachment instanceof Blob) {
          return new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = async (e) => {
              const base64 = e.target.result.split(',')[1]
              try {
                const result = await this._storeAttachment(docId, base64, type)
                resolve(result)
              } catch (error) {
                reject(error)
              }
            }
            reader.onerror = reject
            reader.readAsDataURL(attachment)
          })
        }

        return await this._storeAttachment(docId, base64Data, type)
      }

      /**
       * 存储附件的内部方法
       */
      async _storeAttachment(docId, base64Data, type) {
        // 存储附件数据和类型
        const attachmentKey = `attachment:${docId}`
        const typeKey = `attachment_type:${docId}`

        await this.put({
          _id: attachmentKey,
          data: base64Data
        })

        await this.put({
          _id: typeKey,
          type: type
        })

        return { ok: true, id: docId }
      }

      /**
       * 获取附件（uTools 风格）
       * @param {string} docId - 文档ID
       * @returns {Promise<string>} Base64编码的附件数据
       */
      async getAttachment(docId) {
        if (!this._currentPluginId) {
          throw new Error('Please call setPluginId() first')
        }

        const attachmentKey = `attachment:${docId}`
        const doc = await this.get(attachmentKey)

        return doc ? doc.data : null
      }

      /**
       * 获取附件类型（uTools 风格）
       * @param {string} docId - 文档ID
       * @returns {Promise<string>} MIME类型
       */
      async getAttachmentType(docId) {
        if (!this._currentPluginId) {
          throw new Error('Please call setPluginId() first')
        }

        const typeKey = `attachment_type:${docId}`
        const doc = await this.get(typeKey)

        return doc ? doc.type : null
      }

      /**
       * 存储加密数据
       * @param {string} pluginIdOrKey - 插件ID 或 键名
       * @param {string} keyOrValue - 键名 或 值
       * @param {string} [value] - 值
       * @returns {Promise<boolean>}
       */
      async putSecure(pluginIdOrKey, keyOrValue, value) {
        let pluginId, key, actualValue

        if (value !== undefined) {
          // 三个参数：putSecure(pluginId, key, value)
          pluginId = pluginIdOrKey
          key = keyOrValue
          actualValue = value
        } else if (this._currentPluginId) {
          // 两个参数且已设置 pluginId：putSecure(key, value)
          pluginId = this._currentPluginId
          key = pluginIdOrKey
          actualValue = keyOrValue
        } else {
          throw new Error(
            'Please call setPluginId() first or provide pluginId as first parameter'
          )
        }

        const r = await this.transport.call('db_put_secure', {
          plugin_id: pluginId,
          key,
          value: actualValue
        })
        return r && r.success === true
      }

      /**
       * 读取加密数据
       * @param {string} pluginIdOrKey - 插件ID 或 键名
       * @param {string} [key] - 键名
       * @returns {Promise<string>} 解密后的值
       */
      async getSecure(pluginIdOrKey, key) {
        let pluginId, actualKey

        if (key !== undefined) {
          // 两个参数：getSecure(pluginId, key)
          pluginId = pluginIdOrKey
          actualKey = key
        } else if (this._currentPluginId) {
          // 一个参数且已设置 pluginId：getSecure(key)
          pluginId = this._currentPluginId
          actualKey = pluginIdOrKey
        } else {
          throw new Error(
            'Please call setPluginId() first or provide pluginId as first parameter'
          )
        }

        const r = await this.transport.call('db_get_secure', {
          plugin_id: pluginId,
          key: actualKey
        })

        if (r && r.success === true && r.data !== undefined) {
          return r.data
        }
        return null
      }
    }

    // ========================================
    // api/credentials.js
    // ========================================

    const CREDENTIAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
    const MAX_CREDENTIAL_VALUE_BYTES = 64 * 1024

    function credentialError(code, message) {
      const error = new Error(message)
      error.code = code
      return error
    }

    function requireCredentialKey(key) {
      if (typeof key !== 'string' || !CREDENTIAL_KEY_PATTERN.test(key)) {
        throw credentialError('INVALID_REQUEST', '凭据 key 格式无效')
      }
    }

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    function unwrapResponse(response) {
      if (!isRecord(response) || !Object.hasOwn(response, 'success')) return response
      if (response.success !== true) {
        const error = isRecord(response.error) ? response.error : {}
        const code = typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR'
        const messages = {
          INVALID_REQUEST: '凭据请求格式无效',
          PERMISSION_DENIED: '当前插件实例无权访问凭据',
          NOT_SUPPORTED: '宿主安全凭据存储不可用',
          FILE_TOO_LARGE: '凭据超过 64 KiB 上限',
          DATA_CORRUPT: '安全凭据记录损坏或无法解密',
          STORAGE_ERROR: '安全凭据读写失败'
        }
        throw credentialError(code, messages[code] || '宿主安全凭据操作失败')
      }
      return Object.hasOwn(response, 'data') ? response.data : response
    }

    /** Versioned, plugin-scoped OS credential store over the existing SDK transport. */
    class CredentialStoreV1API {
      constructor(transport) {
        this.transport = transport
      }

      async status() {
        const result = await this.call('credential_v1_status', {})
        if (isRecord(result) && result.status === 'available') return { status: 'available' }
        if (isRecord(result) && result.status === 'unavailable' &&
            ['encryption-unavailable', 'insecure-backend', 'backend-unknown'].includes(result.reason)) {
          return { status: 'unavailable', reason: result.reason }
        }
        throw credentialError('INTERNAL_ERROR', '凭据存储状态响应无效')
      }

      async set(key, value) {
        requireCredentialKey(key)
        if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_CREDENTIAL_VALUE_BYTES) {
          throw credentialError('INVALID_REQUEST', '凭据必须是 64 KiB 以内的字符串')
        }
        const result = await this.call('credential_v1_set', { key, value })
        if (result !== 'OK') throw credentialError('INTERNAL_ERROR', '凭据写入结果无效')
        return true
      }

      async get(key) {
        requireCredentialKey(key)
        const result = await this.call('credential_v1_get', { key })
        if (isRecord(result) && result.status === 'missing') return null
        if (isRecord(result) && result.status === 'present' && typeof result.value === 'string' &&
            new TextEncoder().encode(result.value).byteLength <= MAX_CREDENTIAL_VALUE_BYTES) return result.value
        throw credentialError('DATA_CORRUPT', '凭据读取结果无效')
      }

      async delete(key) {
        requireCredentialKey(key)
        const result = await this.call('credential_v1_delete', { key })
        if (result !== 'OK') throw credentialError('INTERNAL_ERROR', '凭据删除结果无效')
        return true
      }

      async call(method, params) {
        try {
          return unwrapResponse(await this.transport.call(method, params))
        } catch (error) {
          if (typeof error?.code === 'string') {
            const messages = {
              INVALID_REQUEST: '凭据请求格式无效',
              PERMISSION_DENIED: '当前插件实例无权访问凭据',
              NOT_SUPPORTED: '宿主安全凭据存储不可用',
              FILE_TOO_LARGE: '凭据超过 64 KiB 上限',
              DATA_CORRUPT: '安全凭据记录损坏或无法解密',
              STORAGE_ERROR: '安全凭据读写失败'
            }
            throw credentialError(error.code, messages[error.code] || '宿主安全凭据操作失败')
          }
          throw credentialError('INTERNAL_ERROR', '宿主安全凭据操作失败')
        }
      }
    }

    /** Explicit namespace keeps the wire contract version visible to plugin authors. */
    class CredentialsAPI {
      constructor(transport) {
        this.v1 = new CredentialStoreV1API(transport)
      }
    }

    // ========================================
    // api/sys.js
    // ========================================

    /**
     * System API - 系统操作
     * 封装系统相关的业务逻辑
     */
    class SystemAPI {
      constructor(transport) {
        this.transport = transport
      }

      /**
       * 显示系统通知（支持模态/非模态）
       * @param {string} title - 通知标题
       * @param {string} message - 通知内容
       * @param {object} options - 可选配置 { modal: boolean }
       * @returns {Promise<boolean>}
       */
      async notify(title, message, options = {}) {
        const r = await this.transport.call('system_notify', {
          title,
          message,
          modal: options.modal !== undefined ? options.modal : true // 默认模态
        })
        return r && r.success === true
      }

      /**
       * 显示 Toast 通知（轻量、非阻塞、自动消失）
       * @param {string} type - 类型: 'success' | 'error' | 'info' | 'warning' | 'loading'
       * @param {string} message - 通知内容
       * @param {number} duration - 持续时间（秒），默认 3 秒，0 表示不自动关闭
       * @returns {Promise<void>}
       */
      async toast(type, message, duration = 3) {
        // 直接调用前端 Toast，不经过后端
        if (typeof window !== 'undefined' && window.__ztoolsToast) {
          window.__ztoolsToast(type, message, duration)
        } else {
          console.warn('[sys.toast] Toast 系统未初始化，降级为 console 输出')
          console.log(`[${type.toUpperCase()}] ${message}`)
        }
      }

      /**
       * Read only this plugin instance's recent, sanitized Main failures for known SDK request IDs.
       * @param {{requestIds?: string[]}} options
       * @returns {Promise<{schemaVersion: number, requestFailures: Array<object>}>}
       */
      async getDiagnostics(options = {}) {
        const requestIds = options?.requestIds
        if (options === null || typeof options !== 'object' || Array.isArray(options) ||
            Object.keys(options).some(key => key !== 'requestIds') ||
            (requestIds !== undefined && (!Array.isArray(requestIds) || requestIds.length > 64 ||
              requestIds.some(value => typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value))))) {
          const error = new Error('诊断请求 ID 无效')
          error.code = 'INVALID_REQUEST'
          throw error
        }
        const ids = requestIds === undefined ? [] : [...new Set(requestIds)]
        const data = await this.transport.call('diagnostics_get', ids.length ? { requestIds: ids } : {})
        if (!data || data.schemaVersion !== 1 || !Array.isArray(data.requestFailures) || data.requestFailures.length > ids.length) {
          const error = new Error('宿主诊断响应无效')
          error.code = 'DIAGNOSTICS_INVALID'
          throw error
        }
        const allowedIds = new Set(ids)
        const requestFailures = []
        const seen = new Set()
        for (const failure of data.requestFailures) {
          if (!failure || typeof failure !== 'object' || Array.isArray(failure) ||
              failure.schemaVersion !== 1 || failure.layer !== 'main' ||
              typeof failure.requestId !== 'string' || !allowedIds.has(failure.requestId) || seen.has(failure.requestId) ||
              typeof failure.method !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(failure.method) ||
              typeof failure.failureStage !== 'string' || !/^[a-z-]{1,32}$/.test(failure.failureStage) ||
              typeof failure.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(failure.errorCode) ||
              typeof failure.occurredAt !== 'string' || !Number.isFinite(Date.parse(failure.occurredAt))) {
            const error = new Error('宿主诊断记录无效')
            error.code = 'DIAGNOSTICS_INVALID'
            throw error
          }
          seen.add(failure.requestId)
          requestFailures.push(Object.freeze({
            schemaVersion: 1,
            layer: 'main',
            requestId: failure.requestId,
            method: failure.method,
            failureStage: failure.failureStage,
            errorCode: failure.errorCode,
            occurredAt: new Date(Date.parse(failure.occurredAt)).toISOString()
          }))
        }
        return Object.freeze({ schemaVersion: 1, requestFailures: Object.freeze(requestFailures) })
      }

      /**
       * 显示确认对话框（模态）
       * @param {string} title - 标题
       * @param {string} message - 消息内容
       * @param {object} options - 可选配置 { okText, cancelText }
       * @returns {Promise<boolean>} 用户是否点击确认
       */
      async confirm(title, message, options = {}) {
        // TODO: 后续实现 Delphi 非模态对话框
        // 当前使用浏览器原生 confirm
        if (typeof window !== 'undefined') {
          return window.confirm(`${title}\n\n${message}`)
        }
        return false
      }

      /**
       * 设置暗黑模式
       * @param {boolean} enabled - 是否启用暗黑模式
       * @returns {Promise<boolean>}
       */
      async setDarkMode(enabled) {
        const r = await this.transport.call('system_set_dark_mode', {
          dark: !!enabled
        })
        return r && r.success === true
      }

      /**
       * 获取系统信息
       * @returns {Promise<object>}
       */
      async getInfo() {
        const r = await this.transport.call('get_system_info', {})
        if (r && r.success) {
          return r
        }
        throw new Error(r?.error || 'Get system info failed')
      }

      // ============ 系统扩展功能 (类似 uTools API) ============

      /**
       * 获取本机唯一标识
       * @returns {Promise<string>}
       */
      async getNativeId() {
        const r = await this.transport.call('system_get_native_id', {})
        if (r && r.success && r.nativeId) {
          return r.nativeId
        }
        throw new Error(r?.error || 'Get native ID failed')
      }

      /**
       * 获取应用名称
       * @returns {Promise<string>}
       */
      async getAppName() {
        const r = await this.transport.call('system_get_app_name', {})
        if (r && r.success && r.appName) {
          return r.appName
        }
        return 'ZTools'
      }

      /**
       * 获取应用版本（从应用程序文件版本资源读取）
       * @returns {Promise<string>}
       */
      async getAppVersion() {
        const r = await this.transport.call('system_get_app_version', {})
        if (r && r.success && r.appVersion) {
          return r.appVersion
        }
        return '1.0.0'
      }

      /**
       * 获取系统路径
       * @param {string} name - 路径名称 (app, home, appData, userData, temp, desktop, documents, downloads, music, pictures, videos, cache)
       * @returns {Promise<string>}
       */
      async getPath(name) {
        const r = await this.transport.call('system_get_path', { name })
        if (r && r.success && r.path) {
          return r.path
        }
        return ''
      }

      /**
       * Read the real Windows login-item state when the host supports it.
       * @returns {Promise<{success: boolean, enabled: boolean}>}
       */
      async getAutostart() {
        return await this.transport.call('system_get_autostart', {})
      }

      /**
       * Update the real Windows login-item state.
       * @param {boolean} enabled
       * @returns {Promise<{success: boolean, enabled: boolean}>}
       */
      async setAutostart(enabled) {
        return await this.transport.call('system_set_autostart', { enabled: !!enabled })
      }

      /**
       * 获取文件图标（通过 Windows SHGetFileInfo API）
       * @param {string} filePath - 文件路径
       * @returns {Promise<string>} Base64 编码的图标数据 (data:image/png;base64,...)
       */
      async getFileIcon(filePath) {
        const r = await this.transport.call('system_get_file_icon', { filePath })
        if (r && r.success) {
          return r.icon || ''
        }
        return ''
      }

      /**
       * 读取当前文件夹路径
       * @returns {Promise<string>}
       */
      async readCurrentFolderPath() {
        const r = await this.transport.call('system_read_current_folder', {})
        if (r && r.success && r.path) {
          return r.path
        }
        return ''
      }

      /**
       * 读取当前浏览器 URL（通过 Windows API 获取前台浏览器窗口）
       * 支持 Chrome, Edge, Firefox 等主流浏览器
       * @returns {Promise<{url: string, browser: string}>} 返回 URL 和浏览器名称
       */
      async readCurrentBrowserUrl() {
        const r = await this.transport.call('system_read_current_browser_url', {})
        if (r && r.success) {
          return {
            url: r.url || '',
            browser: r.browser || ''
          }
        }
        return { url: '', browser: '' }
      }

      /**
       * 是否为开发模式
       * @returns {Promise<boolean>}
       */
      async isDev() {
        const r = await this.transport.call('system_is_dev', {})
        if (r && r.success) {
          return r.isDev || false
        }
        return false
      }

      /**
       * 获取平台信息
       * @returns {Promise<object>} {platform, isWindows, isMacOS, isLinux}
       */
      async getPlatform() {
        try {
          const r = await this.transport.call('system_get_platform', {})
          if (r && r.success) {
            return {
              platform: r.platform || 'unknown',
              isWindows: r.isWindows || false,
              isMacOS: r.isMacOS || false,
              isLinux: r.isLinux || false
            }
          }
        } catch {
          // A failed host query must not guess the operating system.
        }
        return {
          platform: 'unknown',
          isWindows: false,
          isMacOS: false,
          isLinux: false
        }
      }

      /**
       * 查询当前运行时中已登记能力的只读状态。
       * 查询不会申请权限；每次实际 IPC 操作仍会独立校验授权与系统权限。
       * @param {string} capability - 稳定能力 ID
       * @returns {Promise<object>} capability-record.schema.json 定义的状态快照
       */
      async getCapability(capability) {
        if (
          typeof this.transport.isElectronEnvironment !== 'function' ||
          !this.transport.isElectronEnvironment()
        ) {
          const error = new Error('运行时能力查询仅支持 Electron 宿主')
          error.code = 'NOT_SUPPORTED'
          throw error
        }
        return this.transport.call('runtime_capability_get', { capability })
      }

      /** Requests screen-capture authorization for this trusted plugin instance. */
      async requestCapability(request, options = {}) {
        if (
          typeof this.transport.isElectronEnvironment !== 'function' ||
          !this.transport.isElectronEnvironment()
        ) {
          const error = new Error('运行时能力申请仅支持 Electron 宿主')
          error.code = 'NOT_SUPPORTED'
          throw error
        }
        const capability = request && typeof request === 'object' ? request.capability : undefined
        const timeout = options.timeout ?? 120000
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) {
          const error = new Error('屏幕权限申请等待时间必须为 1 到 120000 毫秒')
          error.code = 'INVALID_REQUEST'
          throw error
        }
        if (options.signal !== undefined && (!options.signal || typeof options.signal.aborted !== 'boolean' ||
            typeof options.signal.addEventListener !== 'function' || typeof options.signal.removeEventListener !== 'function')) {
          const error = new Error('屏幕权限申请 signal 无效')
          error.code = 'INVALID_REQUEST'
          throw error
        }
        return this.transport.call('runtime_capability_request', { capability }, {
          ...(options.signal ? { signal: options.signal } : {}),
          timeout
        })
      }

      /** Revokes a capability previously granted to the current plugin instance. */
      async revokeCapability(request) {
        if (
          typeof this.transport.isElectronEnvironment !== 'function' ||
          !this.transport.isElectronEnvironment()
        ) {
          const error = new Error('运行时能力撤销仅支持 Electron 宿主')
          error.code = 'NOT_SUPPORTED'
          throw error
        }
        const capability = request && typeof request === 'object' ? request.capability : undefined
        return this.transport.call('runtime_capability_revoke', { capability })
      }

      /** Main-window only: lists active instance grants for user management. */
      async listCapabilityGrants() {
        if (
          typeof this.transport.isElectronEnvironment !== 'function' ||
          !this.transport.isElectronEnvironment()
        ) {
          const error = new Error('运行时能力管理仅支持 Electron 宿主')
          error.code = 'NOT_SUPPORTED'
          throw error
        }
        return this.transport.call('runtime_capability_grants_list', {})
      }

      /** Main-window only: revokes one opaque grant ID displayed by listCapabilityGrants. */
      async revokeCapabilityGrant(grantId) {
        if (
          typeof this.transport.isElectronEnvironment !== 'function' ||
          !this.transport.isElectronEnvironment()
        ) {
          const error = new Error('运行时能力管理仅支持 Electron 宿主')
          error.code = 'NOT_SUPPORTED'
          throw error
        }
        return this.transport.call('runtime_capability_grant_revoke', { grantId })
      }

      /**
       * Returns the current Electron host identity without accepting caller supplied identity data.
       * @returns {Promise<object>} Runtime identity defined by runtime-identity.schema.json
       */
      async getRuntimeIdentity() {
        if (
          typeof this.transport.isElectronEnvironment !== 'function' ||
          !this.transport.isElectronEnvironment()
        ) {
          const error = new Error('Runtime identity is only available from the Electron host')
          error.code = 'NOT_SUPPORTED'
          throw error
        }
        return this.transport.call('system_get_runtime_identity', {})
      }

      /**
       * 是否为 Windows 系统
       * @returns {Promise<boolean>}
       */
      async isWindows() {
        const info = await this.getPlatform()
        return info.isWindows
      }

      /**
       * 是否为 macOS 系统
       * @returns {Promise<boolean>}
       */
      async isMacOS() {
        const info = await this.getPlatform()
        return info.isMacOS
      }

      /**
       * 是否为 Linux 系统
       * @returns {Promise<boolean>}
       */
      async isLinux() {
        const info = await this.getPlatform()
        return info.isLinux
      }

      // ============ 电源管理功能 ============

      /**
       * 关机
       * @param {boolean} force - 是否强制关机，默认 false
       * @param {number} timeout - 延迟时间（秒），默认 0
       * @returns {Promise<boolean>}
       */
      async shutdown(force = false, timeout = 0) {
        const r = await this.transport.call('system_shutdown', { force, timeout })
        return r && r.success === true
      }

      /**
       * 重启
       * @param {boolean} force - 是否强制重启，默认 false
       * @returns {Promise<boolean>}
       */
      async restart(force = false) {
        const r = await this.transport.call('system_restart', { force })
        return r && r.success === true
      }

      /**
       * 注销当前用户
       * @param {boolean} force - 是否强制注销，默认 false
       * @returns {Promise<boolean>}
       */
      async logout(force = false) {
        const r = await this.transport.call('system_logout', { force })
        return r && r.success === true
      }

      /**
       * 锁定屏幕
       * @returns {Promise<boolean>}
       */
      async lock() {
        const r = await this.transport.call('system_lock', {})
        return r && r.success === true
      }

      /**
       * 睡眠（挂起到内存）
       * @returns {Promise<boolean>}
       */
      async sleep() {
        const r = await this.transport.call('system_sleep', {})
        return r && r.success === true
      }

      /**
       * 休眠（挂起到磁盘）
       * @returns {Promise<boolean>}
       */
      async hibernate() {
        const r = await this.transport.call('system_hibernate', {})
        return r && r.success === true
      }

      /**
       * 阻止/允许系统休眠
       * @param {boolean} enable - 是否阻止休眠
       * @returns {Promise<boolean>}
       */
      async preventSleep(enable) {
        const r = await this.transport.call('system_prevent_sleep', {
          enable: !!enable
        })
        return r && r.success === true
      }

      // ============ Phase 1.4: 键鼠模拟 ============

      /**
       * 模拟按键
       * @param {string} key - 按键，如 'A', 'Enter', 'F1'
       * @returns {Promise<boolean>}
       */
      async simulateKeyPress(key) {
        const r = await this.transport.call('system_simulate_key_press', { key })
        return r && r.success === true
      }

      /**
       * 模拟组合键
       * @param {string} keys - 组合键，如 'Ctrl+C', 'Alt+F4'
       * @returns {Promise<boolean>}
       */
      async simulateKeyCombo(keys) {
        const r = await this.transport.call('system_simulate_key_combo', { keys })
        return r && r.success === true
      }

      /**
       * 输入文本
       * @param {string} text - 要输入的文本
       * @returns {Promise<boolean>}
       */
      async simulateText(text) {
        const r = await this.transport.call('system_simulate_text', { text })
        return r && r.success === true
      }

      /**
       * 移动鼠标
       * @param {number} x - X坐标
       * @param {number} y - Y坐标
       * @returns {Promise<boolean>}
       */
      async simulateMouseMove(x, y) {
        const r = await this.transport.call('system_simulate_mouse_move', { x, y })
        return r && r.success === true
      }

      /**
       * 模拟鼠标点击
       * @param {string} button - 按钮：'left'|'right'|'middle'
       * @param {number} [x] - X坐标(可选,不提供则在当前位置点击)
       * @param {number} [y] - Y坐标(可选)
       * @returns {Promise<boolean>}
       */
      async simulateMouseClick(button, x, y) {
        const r = await this.transport.call('system_simulate_mouse_click', {
          button,
          x,
          y
        })
        return r && r.success === true
      }

      /**
       * 模拟鼠标滚轮
       * @param {number} delta - 滚动量（正数向上，负数向下）
       * @returns {Promise<boolean>}
       */
      async simulateMouseWheel(delta) {
        const r = await this.transport.call('system_simulate_mouse_wheel', {
          delta
        })
        return r && r.success === true
      }

      // ============ Phase 2: 系统监控 ============

      /**
       * 获取CPU使用率
       * @returns {Promise<{total: number, perCore: Array<number>}>}
       */
      async getHardwareSummary() {
        const result = await this.transport.call('system_get_hardware_summary', {})
        const data = result?.data, failed = () => Object.assign(new Error('硬件概要响应无效'), { code: 'SYSTEM_ERROR' })
        if (result?.success !== true || !data || !['windows', 'macos'].includes(data.platform) || !['ia32', 'x64', 'arm64'].includes(data.processArch) || typeof data.osVersion !== 'string' || data.osVersion.length > 64 || !Array.isArray(data.cpuModels) || data.cpuModels.length > 32 || data.cpuModels.some(value => typeof value !== 'string' || !value || value.length > 512) || !Number.isSafeInteger(data.logicalCpuCount) || data.logicalCpuCount < 0 || data.logicalCpuCount > 65536 || !Number.isSafeInteger(data.totalMemory) || data.totalMemory < 0 || !data.fieldAvailability || ['cpuModels', 'logicalCpuCount', 'totalMemory', 'osVersion'].some(key => typeof data.fieldAvailability[key] !== 'boolean')) throw failed()
        if (data.fieldAvailability.cpuModels !== !!data.cpuModels.length || data.fieldAvailability.logicalCpuCount !== (data.logicalCpuCount > 0) || data.fieldAvailability.totalMemory !== (data.totalMemory > 0) || data.fieldAvailability.osVersion !== !!data.osVersion) throw failed()
        return Object.freeze({ platform: data.platform, processArch: data.processArch, osVersion: data.osVersion, cpuModels: Object.freeze([...data.cpuModels]), logicalCpuCount: data.logicalCpuCount, totalMemory: data.totalMemory, fieldAvailability: Object.freeze({ ...data.fieldAvailability }) })
      }
      async getCPUUsage() {
        const r = await this.transport.call('system_get_cpu_usage', {})
        return r && r.success ? r : null
      }

      /**
       * 获取内存使用情况
       * @returns {Promise<{total: number, used: number, available: number, percent: number}>}
       */
      async getMemoryUsage() {
        const r = await this.transport.call('system_get_memory_usage', {})
        return r && r.success ? r : null
      }

      /**
       * 获取磁盘使用情况
       * @param {string} [drive] - 卷绝对路径；省略时使用当前系统卷根目录
       * @returns {Promise<{total: number, used: number, free: number, percent: number}>}
       */
      async getDiskUsage(drive) {
        const params = drive === undefined ? {} : { drive }
        const r = await this.transport.call('system_get_disk_usage', params)
        return r && r.success ? r : null
      }

      /**
       * 获取网络统计
       * @returns {Promise<{sent: number, received: number, speed: number}>}
       */
      async getNetworkStats() {
        const r = await this.transport.call('system_get_network_stats', {})
        return r && r.success ? r : null
      }

      /**
       * 获取电池状态
       * @returns {Promise<{percent: number, isCharging: boolean, timeRemaining: number}>}
       */
      async getBatteryStatus() {
        const r = await this.transport.call('system_get_battery_status', {})
        return r && r.success ? r : null
      }

      // ============ 软件更新功能 ============

      /**
       * 检查更新（同时检查App和Web）
       * @returns {Promise<{app: object|null, web: object|null}>}
       * {
       *   app: { version, changelog, force, fileSize, downloadUrl, checksum } | null,
       *   web: { version, changelog, fileSize, downloadUrl } | null
       * }
       */
      async checkUpdate(source = 'manual') {
        const normalizedSource = source === 'startup' ? 'startup' : 'manual'
        const r = await this.transport.call('update_check', { source: normalizedSource })
        if (r && r.success) {
          return {
            app: r.app || null,
            web: r.web || null
          }
        }
        throw new Error(r?.error || 'Check update failed')
      }

      /**
       * 检查App更新（兼容方法，实际调用统一检查）
       * @returns {Promise<object|null>}
       */
      async checkAppUpdate() {
        const result = await this.checkUpdate()
        return result.app
      }

      /**
       * 检查Web资源更新（兼容方法，实际调用统一检查）
       * @returns {Promise<object|null>}
       */
      async checkWebUpdate() {
        const result = await this.checkUpdate()
        return result.web
      }

      /**
       * 执行更新
       * @param {string} type - 更新类型: 'app' | 'web'
       * @param {object} [info] - 更新信息（可选，传入后不依赖 Delphi 端缓存）
       * @param {string} [info.version] - 版本号
       * @param {string} [info.downloadUrl] - 下载地址
       * @param {string} [info.changelog] - 更新日志
       * @param {number} [info.fileSize] - 文件大小
       * @param {string} [info.checksum] - 校验和
       * @param {string} [info.minAppVersion] - Web 更新要求的最低宿主版本
       * @returns {Promise<{status: string}>}
       */
      async performUpdate(type, info = {}) {
        const payload = { type, ...info }
        const r = await this.transport.call('update_install_start', payload, {
          ...(type === 'app' ? { timeout: Infinity } : {})
        })
        if (r && r.success) {
          return r
        }
        throw new Error(r?.error || 'Update failed')
      }

      /**
       * 获取当前版本信息
       * @returns {Promise<{appVersion: string, webVersion: string}>}
       */
      async getCurrentVersion() {
        const r = await this.transport.call('update_get_version', {})
        if (r && r.success) {
          return {
            appVersion: r.appVersion || '0',
            webVersion: r.webVersion || '0'
          }
        }
        throw new Error(r?.error || 'Get version failed')
      }

      // ============ 提权执行功能 ============

      /**
       * 提权执行原子操作
       * @param {string} type - 操作类型 (reg_write, reg_delete, file_delete, file_write, file_copy, file_move, process_kill, scheduled_task_set_enabled, restart_explorer, system_action)
       * @param {object} payload - 操作参数
       * @param {number} [timeout=30000] - 超时时间（毫秒）
       * @returns {Promise<any>}
       */
      async privilegedExecute(type, payload, timeout = 30000) {
        const r = await this.transport.call('privileged_execute', {
          type,
          payload,
          timeout
        })
        if (r && r.success) {
          return r.result
        }
        throw new Error(r?.error || 'Privileged execute failed')
      }

      // ============ 快捷键管理 ============

      /**
       * 重新加载超级面板热键配置
       * @returns {Promise<boolean>}
       */
      async reloadHotkeys() {
        const r = await this.transport.call('system_reload_hotkeys', {})
        return r && r.success === true
      }

      /**
       * 获取已加入超级面板的本地软件
       * @returns {Promise<Array<{id: string, name: string}>>}
       */
      async getPanelLocalApps() {
        const r = await this.transport.call('system_get_panel_local_apps', {})
        if (r && r.success) {
          return Array.isArray(r.apps) ? r.apps : []
        }
        throw new Error(r?.error || 'Get panel local apps failed')
      }

    }

    // ========================================
    // api/runtime-capability.js
    // ========================================

    const CAPABILITY_REQUEST_TIMEOUT_MS = 120_000

    function permissionError(message = '屏幕访问未获授权。如需使用，请关闭并重新打开该插件以再次发起授权申请。') {
      return Object.assign(new Error(message), { code: 'PERMISSION_DENIED' })
    }

    /** SDK convenience only; Main repeats the authorization check before every capture operation. */
    async function ensureRuntimeCapability(sys, capability, options = {}) {
      const transport = sys?.transport
      if (typeof transport?.isElectronEnvironment !== 'function' || !transport.isElectronEnvironment()) return
      const current = await sys.getCapability(capability)
      if (current?.authorization === 'granted') return
      if (current?.authorization !== 'not-requested') throw permissionError()
      const requested = await sys.requestCapability({ capability }, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeout: CAPABILITY_REQUEST_TIMEOUT_MS
      })
      if (requested?.authorization !== 'granted') throw permissionError()
    }

    // ========================================
    // api/window.js
    // ========================================

    /**
     * Window API - 窗口操作
     * 封装窗口相关的业务逻辑
     */
    class WindowAPI {
      constructor(transport) {
        this.transport = transport
      }

      /**
       * 打开新窗口
       * @param {string} url - URL地址
       * @returns {Promise<any>}
       */
      async open(url) {
        return await this.transport.call('window_open', { url })
      }

      /**
       * 关闭窗口
       * @returns {Promise<any>}
       */
      async close() {
        return await this.transport.call('window_close', {})
      }

      /**
       * 最小化窗口
       * @returns {Promise<any>}
       */
      async minimize() {
        return await this.transport.call('window_minimize', {})
      }

      /**
       * 最大化窗口
       * @returns {Promise<any>}
       */
      async maximize() {
        return await this.transport.call('window_maximize', {})
      }

      /**
       * 切换全屏
       * @returns {Promise<any>}
       */
      async toggleFullscreen() {
        return await this.transport.call('window_fullscreen_toggle', {})
      }

      /**
       * 拖动窗口
       * @returns {Promise<any>}
       */
      async drag() {
        return await this.transport.call('window_drag', {})
      }

      /**
       * 隐藏窗口
       * @returns {Promise<any>}
       */
      async hide() {
        return await this.transport.call('window_hide', {})
      }

      /**
       * 显示窗口
       * @returns {Promise<any>}
       */
      async show() {
        return await this.transport.call('window_show', {})
      }

      /**
       * 隐藏插件窗口（仅在插件窗口上下文中生效）
       * @returns {Promise<any>}
       */
      async hidePluginWindow() {
        return await this.transport.call('pluginwin_hide', {})
      }

      /**
       * 显示插件窗口（仅在插件窗口上下文中生效）
       * @returns {Promise<any>}
       */
      async showPluginWindow() {
        return await this.transport.call('pluginwin_show', {})
      }

      /**
       * 最小化插件窗口（仅在插件窗口上下文中生效）
       * @returns {Promise<any>}
       */
      async minimizePluginWindow() {
        return await this.transport.call('pluginwin_minimize', {})
      }

      /**
       * 恢复插件窗口（从最小化恢复，仅在插件窗口上下文中生效）
       * @returns {Promise<any>}
       */
      async restorePluginWindow() {
        return await this.transport.call('pluginwin_restore', {})
      }

      /**
       * 设置窗口高度
       * @param {number} height - 窗口高度（像素）
       * @returns {Promise<any>}
       */
      async setHeight(height) {
        return await this.transport.call('window_set_height', { height })
      }

      /**
       * 退出插件模式，隐藏窗口
       * @returns {Promise<any>}
       */
      async outPlugin() {
        return await this.transport.call('window_out_plugin', {})
      }

      /**
       * 跳转到指定URL
       * @param {string} url - 目标URL
       * @returns {Promise<any>}
       */
      async redirect(url) {
        return await this.transport.call('window_redirect', { url })
      }

      /**
       * 显示打开文件对话框
       * @param {Object} options - 对话框选项
       * @param {string} options.title - 对话框标题
       * @param {string} options.defaultPath - 默认路径
       * @param {string} options.filters - 文件过滤器，如 "文本文件 (*.txt)|*.txt"
       * @param {Array<string>} options.properties - 属性数组，如 ['multiSelections', 'openDirectory']
       * @returns {Promise<{filePath?: string, fileUrl?: string, filePaths?: Array<{path: string, fileUrl?: string}>, canceled: boolean}>}
       * @note 此接口不设超时限制，会一直等待用户选择或取消
       */
      async showOpenDialog(options = {}) {
        // 文件对话框不设超时，等待用户操作完成（设置为 Infinity 表示无限等待）
        return await this.transport.call('window_show_open_dialog', options, {
          timeout: Infinity
        })
      }

      /**
       * 显示保存文件对话框
       * @param {Object} options - 对话框选项
       * @param {string} options.title - 对话框标题
       * @param {string} options.defaultPath - 初始目录路径
       * @param {string} options.defaultName - 默认文件名
       * @param {string} options.filters - 文件过滤器，如 "文本文件 (*.txt)|*.txt"
       * @returns {Promise<{filePath?: string, fileUrl?: string, canceled: boolean}>}
       * @note 此接口不设超时限制，会一直等待用户选择或取消
       */
      async showSaveDialog(options = {}) {
        // 文件对话框不设超时，等待用户操作完成（设置为 Infinity 表示无限等待）
        return await this.transport.call('window_show_save_dialog', options, {
          timeout: Infinity
        })
      }

      /**
       * 显示选择文件夹对话框
       * @param {Object} options - 对话框选项
       * @param {string} options.title - 对话框标题
       * @param {string} options.defaultPath - 默认路径
       * @returns {Promise<{folderPath?: string, canceled: boolean}>}
       * @note 此接口不设超时限制，会一直等待用户选择或取消
       */
      async showSelectFolderDialog(options = {}) {
        // 文件对话框不设超时，等待用户操作完成（设置为 Infinity 表示无限等待）
        return await this.transport.call(
          'window_show_select_folder_dialog',
          options,
          { timeout: Infinity }
        )
      }

      /**
       * 设置窗口大小
       * @param {number} width - 窗口宽度（像素）
       * @param {number} height - 窗口高度（像素）
       * @param {boolean} animate - 是否使用动画效果，默认 true
       * @returns {Promise<any>}
       */
      async setSize(width, height, animate = true) {
        return await this.transport.call('window_set_size', {
          width,
          height,
          animate
        })
      }

      /**
       * 获取窗口位置和大小
       * @returns {Promise<{x: number, y: number, width: number, height: number}>}
       */
      async getBounds() {
        const r = await this.transport.call('window_get_bounds', {})
        if (r && r.success) {
          return {
            x: r.x || 0,
            y: r.y || 0,
            width: r.width || 0,
            height: r.height || 0
          }
        }
        throw new Error(r?.error || 'Get bounds failed')
      }

      /**
       * 设置窗口透明度
       * @param {number} opacity - 透明度 (0.0 - 1.0)
       * @returns {Promise<any>}
       */
      async setOpacity(opacity) {
        return await this.transport.call('window_set_opacity', { opacity })
      }

      /**
       * 设置窗口置顶
       * @param {boolean} alwaysOnTop - 是否置顶
       * @returns {Promise<any>}
       */
      async setAlwaysOnTop(alwaysOnTop) {
        return await this.transport.call('window_set_always_on_top', {
          alwaysOnTop
        })
      }

      /**
       * 在鼠标附近显示宿主原生 Tooltip。
       * @param {string} text - 提示文本
       * @returns {Promise<any>}
       */
      async showTooltip(text) {
        return await this.transport.call('window_show_tooltip', { text })
      }

      /**
       * 隐藏宿主原生 Tooltip。
       * @returns {Promise<any>}
       */
      async hideTooltip() {
        return await this.transport.call('window_hide_tooltip', {})
      }

      /**
       * 显示桌面置顶悬浮录屏控制条。
       * @param {Object} [options]
       * @param {number} [options.duration] - 初始已录制秒数
       * @param {string} [options.taskId] - 录制任务ID
       * @returns {Promise<any>}
       */
      async showRecordBar(options = {}) {
        return await this.transport.call('window_show_record_bar', options)
      }

      /**
       * 更新录屏控制条显示状态或时长。
       * @param {Object} [options]
       * @param {number} [options.duration] - 当前录制秒数
       * @param {string} [options.status] - 录制状态
       * @returns {Promise<any>}
       */
      async updateRecordBar(options = {}) {
        return await this.transport.call('window_update_record_bar', options)
      }

      /**
       * 隐藏并销毁录屏控制条。
       * @returns {Promise<any>}
       */
      async hideRecordBar() {
        return await this.transport.call('window_hide_record_bar', {})
      }

      /**
       * 切换开发者工具
       * @returns {Promise<any>}
       */
      async toggleDevTools() {
        return await this.transport.call('window_toggle_devtools', {})
      }

      /**
       * 发送关闭确认结果
       * @param {Object} result - 确认结果 {confirmed: boolean, doNotAskAgain: boolean, action: 'exit'|'minimize'|'cancel'}
       * @returns {Promise<any>}
       */
      async sendCloseConfirmResult(result) {
        return await this.transport.call('ui_close_confirm_result', result)
      }
    }

    // ========================================
    // api/plugin.js
    // ========================================

    /**
     * Plugin API - 插件操作
     * 封装插件相关的业务逻辑
     */
    class PluginAPI {
      constructor(transport) {
        this.transport = transport
      }

      /**
       * 获取插件列表
       * @returns {Promise<Array>}
       */
      async getList() {
        return await this.transport.call('plugin_list_get', {})
      }

      /**
       * 打开插件
       * @param {string} pluginId - 插件ID
       * @param {Object} [payload] - 传递给目标插件的启动参数，序列化后不超过 64KB
       * @returns {Promise<any>}
       */
      async open(pluginId, payload) {
        const params = { pluginId }
        if (payload !== undefined) {
          if (
            payload === null ||
            typeof payload !== 'object' ||
            Array.isArray(payload)
          ) {
            throw new TypeError('plugin.open payload must be an object')
          }
          let serialized
          try {
            serialized = JSON.stringify(payload)
          } catch (error) {
            throw new TypeError(
              `plugin.open payload is not serializable: ${error.message}`
            )
          }
          if (serialized.length > 64 * 1024) {
            throw new RangeError('plugin.open payload exceeds the 64KB limit')
          }
          params.payload = payload
        }
        return await this.transport.call('plugin_open', params)
      }

      /**
       * 卸载插件
       * @param {string} pluginId - 插件ID
       * @returns {Promise<any>}
       */
      async uninstall(pluginId) {
        // 卸载大型插件时需要递归删除目录，可能耗时较长，使用 20 秒超时
        return await this.transport.call(
          'plugin_uninstall',
          { pluginId },
          { timeout: 20000 }
        )
      }

      /**
       * 获取插件历史数据快照。
       * @param {string} pluginId - 插件ID
       * @returns {Promise<any>}
       */
      async listPreservedData(pluginId) {
        return await this.transport.call('plugin_data_list', { pluginId })
      }

      /**
       * 将指定历史快照中的明确资产恢复到受管恢复目录，不覆盖插件代码或现有数据。
       * @param {string} pluginId - 插件ID
       * @param {string} preservationId - 历史快照ID
       * @param {string[]} assets - 快照内的相对资产路径
       * @returns {Promise<any>}
       */
      async restorePreservedData(pluginId, preservationId, assets) {
        if (!Array.isArray(assets) || assets.length === 0) {
          throw new TypeError('plugin.restorePreservedData assets must be a non-empty array')
        }
        return await this.transport.call('plugin_data_restore', {
          pluginId,
          preservationId,
          assets
        })
      }

      /**
       * 安装插件
       * @param {string} pluginId - 插件ID
       * @param {string} url - 下载地址
       * @param {Object} info - 完整性元数据
       * @returns {Promise<any>}
       */
      async install(pluginId, url, info = {}) {
        return await this.transport.call('plugin_install', {
          pluginId,
          url,
          version: info.version || '',
          checksum: info.checksum || '',
          fileSize: info.fileSize || info.file_size || 0
        })
      }

      /**
       * 刷新插件列表
       * @returns {Promise<any>}
       */
      async refresh() {
        return await this.getList()
      }

      /**
       * 切换插件启用状态
       * @param {string} pluginId - 插件ID
       * @returns {Promise<any>}
       */
      async toggle(pluginId) {
        return await this.transport.call('plugin_toggle', { pluginId })
      }

      /**
       * 关闭插件窗口
       * @param {string} pluginId - 插件ID
       * @param {string} [instanceId] - 实例ID（可选，为空则关闭该插件所有窗口）
       * @returns {Promise<any>}
       */
      async close(pluginId, instanceId) {
        const params = { pluginId }
        if (instanceId !== undefined && instanceId !== '') {
          if (typeof instanceId !== 'string') {
            throw new TypeError('plugin.close instanceId must be a string')
          }
          params.instanceId = instanceId
        }
        return await this.transport.call('plugin_window_close', params)
      }

      /**
       * 创建桌面快捷方式
       * @param {string} pluginId - 插件ID
       * @returns {Promise<any>}
       */
      async createShortcut(pluginId) {
        return await this.transport.call(
          'plugin_create_shortcut',
          { pluginId },
          { timeout: 60000 }
        )
      }

      async refreshIcon(pluginId, iconUrl) {
        return await this.transport.call('plugin_refresh_icon', { pluginId, iconUrl })
      }
    }

    // ========================================
    // api/settings.js
    // ========================================

    /**
     * Settings API - 设置操作
     * 封装设置相关的业务逻辑
     */
    class SettingsAPI {
      constructor(transport) {
        this.transport = transport
      }

      /**
       * 获取设置值
       * @param {string} key - 设置键名
       * @returns {Promise<any>} 设置值,不存在返回undefined
       */
      async get(key) {
        const r = await this.transport.call('settings_get', { key })
        if (r && r.success === true && r.value !== undefined) {
          return r.value
        }
        return undefined
      }

      /**
       * 设置值
       * @param {string} key - 设置键名
       * @param {any} value - 设置值
       * @returns {Promise<boolean>}
       */
      async set(key, value) {
        const r = await this.transport.call('settings_set', { key, value })
        return r && r.success === true
      }
    }

    // ========================================
    // api/config.js
    // ========================================

    class ConfigAPI {
      constructor(transport) {
        this.transport = transport
      }

      /**
       * 获取配置值
       * @param {string} path - 配置路径，如 'ui.theme' 或 'system.autostart'
       * @param {string} defaultValue - 默认值
       * @param {string} file - 文件名，默认 'user_settings.json'
       * @returns {Promise<string>} 配置值
       */
      async get(path, defaultValue = '', file = 'user_settings.json') {
        // console.log(`[ConfigAPI] get: path=${path}, default=${defaultValue}`)
        const r = await this.transport.call('config_get', {
          file,
          path,
          default: defaultValue
        })
        // console.log(`[ConfigAPI] get response:`, r)
        const raw = r?.value ?? defaultValue
        // 尝试解析 JSON 字符串（获取整个 group 时后端返回的是 JSON 字符串）
        if (typeof raw === 'string' && raw.length > 0) {
          const trimmed = raw.trim()
          if (trimmed[0] === '{' || trimmed[0] === '[') {
            try {
              return JSON.parse(trimmed)
            } catch (e) {
              // 解析失败，返回原始字符串
            }
          }
        }
        return raw
      }

      /**
       * 设置配置值
       * @param {string} path - 配置路径
       * @param {any} value - 配置值
       * @param {boolean} syncEnabled - 是否启用云同步，默认 false
       * @param {string} file - 文件名，默认 'user_settings.json'
       * @returns {Promise<boolean>}
       */
      async set(path, value, syncEnabled = false, file = 'user_settings.json') {
        // 对象/数组类型使用 JSON.stringify 序列化，避免 String({}) 变成 "[object Object]"
        const serialized =
          typeof value === 'object' && value !== null
            ? JSON.stringify(value)
            : String(value)
        const r = await this.transport.call('config_set', {
          file,
          path,
          value: serialized,
          sync_enabled: syncEnabled
        })
        return r?.success === true
      }

      /**
       * 批量获取配置（便捷方法）
       * @param {Object} paths - 路径和默认值映射，如 { 'ui.theme': 'light', 'ui.fontSize': '14' }
       * @param {string} file - 文件名
       * @returns {Promise<Object>} 配置值对象
       */
      async getMultiple(paths, file = 'user_settings.json') {
        const result = {}
        for (const [path, defaultValue] of Object.entries(paths)) {
          result[path] = await this.get(path, defaultValue, file)
        }
        return result
      }

      /**
       * 批量设置配置（便捷方法）
       * @param {Object} values - 路径和值映射
       * @param {boolean} syncEnabled - 是否启用云同步
       * @param {string} file - 文件名
       * @returns {Promise<boolean>}
       */
      async setMultiple(values, syncEnabled = false, file = 'user_settings.json') {
        for (const [path, value] of Object.entries(values)) {
          await this.set(path, value, syncEnabled, file)
        }
        return true
      }
    }

    // ========================================
    // api/user.js
    // ========================================

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

    // ========================================
    // api/protocol.js
    // ========================================

    /**
     * ZTools 自定义协议 API
     *
     * 提供高性能的本地文件访问能力，无需Base64编码
     *
     * 协议格式:
     * - ztools://file/绝对路径     - 读取任意本地文件
     * - ztools://cache/相对路径    - 读取Cache目录文件
     * - ztools://temp/相对路径     - 读取临时文件
     *
     * 使用场景:
     * 1. 图片/视频预览: <img src="ztools://file/C:/image.jpg">
     * 2. Fetch API: await fetch('ztools://cache/data.json')
     * 3. Blob处理: const blob = await fetch(url).then(r => r.blob())
     */

    class ZToolsProtocol {
      static encodePath(pathValue) {
        return pathValue
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/')
      }

      /**
       * 将本地文件路径转换为 ztools:// 协议URL
       * @param {string} filePath - 本地文件绝对路径
       * @returns {string} ztools:// 协议URL
       */
      static fileUrl(filePath) {
        if (typeof filePath === 'string' && /^ztools:\/\/file\//i.test(filePath)) {
          return filePath
        }
        // 规范化路径分隔符
        const normalizedPath = filePath.replace(/\\/g, '/')
        return `ztools://file/${this.encodePath(normalizedPath)}`
      }

      /**
       * 将Cache目录相对路径转换为 ztools:// 协议URL
       * @param {string} relativePath - 相对于Cache目录的路径
       * @returns {string} ztools:// 协议URL
       */
      static cacheUrl(relativePath) {
        const raw = (relativePath || '').toString()
        let normalizedPath = raw.replace(/\\/g, '/')
        // 去掉开头多余的分隔符
        normalizedPath = normalizedPath.replace(/^\/+/, '')

        // 旧版 CEF 目录需要显式插件前缀；Electron session 已经按插件隔离。
        let pluginPrefix = ''
        try {
          const isElectron = typeof window !== 'undefined' && !!window.__ztoolsElectron?.transport
          if (!isElectron && typeof window !== 'undefined' && window.__ztools_plugin_id) {
            pluginPrefix = `${window.__ztools_plugin_id}/`
          }
        } catch (_) {
          // 忽略环境检测错误, 退化为全局Cache
        }

        return `ztools://cache/${this.encodePath(`${pluginPrefix}${normalizedPath}`)}`
      }

      /**
       * 将临时目录相对路径转换为 ztools:// 协议URL
       * @param {string} relativePath - 相对于临时目录的路径
       * @returns {string} ztools:// 协议URL
       */
      static tempUrl(relativePath) {
        const normalizedPath = relativePath.replace(/\\/g, '/')
        return `ztools://temp/${this.encodePath(normalizedPath)}`
      }

      /**
       * 读取文件为文本（使用自定义协议，高性能）
       * @param {string} filePath - 本地文件路径
       * @returns {Promise<string>} 文件内容
       */
      static async readFileAsText(filePath) {
        const url = this.fileUrl(filePath)
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(
            `Failed to read file: ${response.status} ${response.statusText}`
          )
        }
        return await response.text()
      }

      /**
       * 读取文件为二进制（使用自定义协议，高性能）
       * @param {string} filePath - 本地文件路径
       * @returns {Promise<ArrayBuffer>} 文件二进制数据
       */
      static async readFileAsArrayBuffer(filePath) {
        const url = this.fileUrl(filePath)
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(
            `Failed to read file: ${response.status} ${response.statusText}`
          )
        }
        return await response.arrayBuffer()
      }

      /**
       * 读取文件为Blob（使用自定义协议，高性能）
       * @param {string} filePath - 本地文件路径
       * @returns {Promise<Blob>} 文件Blob对象
       */
      static async readFileAsBlob(filePath) {
        const url = this.fileUrl(filePath)
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(
            `Failed to read file: ${response.status} ${response.statusText}`
          )
        }
        return await response.blob()
      }

      /**
       * 读取文件为Data URL（使用自定义协议）
       * @param {string} filePath - 本地文件路径
       * @returns {Promise<string>} Data URL
       */
      static async readFileAsDataURL(filePath) {
        const blob = await this.readFileAsBlob(filePath)
        return new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
      }

      /**
       * 读取Cache文件为文本
       * @param {string} relativePath - 相对于Cache目录的路径
       * @returns {Promise<string>} 文件内容
       */
      static async readCacheAsText(relativePath) {
        const url = this.cacheUrl(relativePath)
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(
            `Failed to read cache file: ${response.status} ${response.statusText}`
          )
        }
        return await response.text()
      }

      /**
       * 读取Cache文件为JSON
       * @param {string} relativePath - 相对于Cache目录的路径
       * @returns {Promise<any>} JSON对象
       */
      static async readCacheAsJSON(relativePath) {
        const url = this.cacheUrl(relativePath)
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(
            `Failed to read cache file: ${response.status} ${response.statusText}`
          )
        }
        return await response.json()
      }

      /**
       * 检查文件是否可访问（通过尝试读取）
       * @param {string} filePath - 本地文件路径
       * @returns {Promise<boolean>} 是否可访问
       */
      static async fileExists(filePath) {
        try {
          const url = this.fileUrl(filePath)
          const response = await fetch(url, { method: 'HEAD' })
          return response.ok
        } catch {
          return false
        }
      }

      /**
       * 读取大文件为Blob（支持进度回调）
       * ⚠️ 注意：fetch API 的进度监控需要使用 ReadableStream
       *
       * @param {string} filePath - 本地文件路径
       * @param {Function} [onProgress] - 进度回调函数 (loaded, total) => void
       * @returns {Promise<Blob>} 文件Blob对象
       *
       * @example
       * const blob = await ztools.protocol.readFileAsBlobWithProgress(
       *   'C:/large-video.mp4',
       *   (loaded, total) => {
       *     const percent = (loaded / total * 100).toFixed(2)
       *     console.log(`下载进度: ${percent}%`)
       *   }
       * )
       */
      static async readFileAsBlobWithProgress(filePath, onProgress) {
        const url = this.fileUrl(filePath)
        const response = await fetch(url)

        if (!response.ok) {
          throw new Error(
            `Failed to read file: ${response.status} ${response.statusText}`
          )
        }

        // 如果没有提供进度回调，直接返回Blob
        if (!onProgress) {
          return await response.blob()
        }

        // 获取文件总大小
        const contentLength = response.headers.get('Content-Length')
        const total = parseInt(contentLength, 10)

        if (!contentLength || isNaN(total)) {
          // 无法获取文件大小，降级为普通读取
          console.warn('[protocol] 无法获取文件大小，进度回调不可用')
          return await response.blob()
        }

        // 使用 ReadableStream 读取数据并报告进度
        const reader = response.body.getReader()
        const chunks = []
        let loaded = 0

        while (true) {
          const { done, value } = await reader.read()

          if (done) {
            break
          }

          chunks.push(value)
          loaded += value.length

          // 调用进度回调
          try {
            onProgress(loaded, total)
          } catch (error) {
            console.error('[protocol] 进度回调错误:', error)
          }
        }

        // 合并所有 chunks 为 Blob
        const mimeType =
          response.headers.get('Content-Type') || 'application/octet-stream'
        return new Blob(chunks, { type: mimeType })
      }

      /**
       * 读取大文件为ArrayBuffer（支持进度回调）
       *
       * @param {string} filePath - 本地文件路径
       * @param {Function} [onProgress] - 进度回调函数 (loaded, total) => void
       * @returns {Promise<ArrayBuffer>} 文件二进制数据
       *
       * @example
       * const buffer = await ztools.protocol.readFileAsArrayBufferWithProgress(
       *   'C:/large-file.bin',
       *   (loaded, total) => {
       *     console.log(`已加载: ${loaded} / ${total} 字节`)
       *   }
       * )
       */
      static async readFileAsArrayBufferWithProgress(filePath, onProgress) {
        const blob = await this.readFileAsBlobWithProgress(filePath, onProgress)
        return await blob.arrayBuffer()
      }

      /**
       * 读取大文件为Data URL（支持进度回调）
       * ⚠️ 注意：Data URL 会将文件编码为 Base64，大文件不推荐使用
       *
       * @param {string} filePath - 本地文件路径
       * @param {Function} [onProgress] - 进度回调函数 (loaded, total) => void
       * @returns {Promise<string>} Data URL
       *
       * @example
       * const dataUrl = await ztools.protocol.readFileAsDataURLWithProgress(
       *   'C:/photo.jpg',
       *   (loaded, total) => {
       *     const percent = Math.round(loaded / total * 100)
       *     updateProgressBar(percent)
       *   }
       * )
       */
      static async readFileAsDataURLWithProgress(filePath, onProgress) {
        const blob = await this.readFileAsBlobWithProgress(filePath, onProgress)
        return new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result)
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
      }
    }

    // 导出为ES模块

    // ========================================
    // api/clipboard.js
    // ========================================

    function clipboardBytesToBase64(bytes) {
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(binary)
    }
    /**
     * Clipboard API - 剪贴板操作
     * 提供剪贴板操作功能，类似 uTools API
     */
    class ClipboardAPI {
      constructor(transport, events) {
        this.transport = transport
        this.events = events
        this.changeHandlers = new Map()
      }

      // ============ 复制操作 ============

      /**
       * 复制文本到剪贴板
       * 超过 200KB 的文本自动走临时文件传递，避免 CEF IPC 大数据崩溃
       * @param {string} text - 要复制的文本
       * @returns {Promise<boolean>}
       */
      async copyText(text, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          const refs = new ReferenceFileSystemAPI(this.transport)
          refs._options(options, ['signal'])
          if (typeof text === 'string' && new TextEncoder().encode(text).length > 8 * 1024 * 1024) throw refs._error('RESPONSE_TOO_LARGE', '剪贴板文本超过8MiB')
          await refs._call('clipboard_copy_text', typeof text === 'string' ? { text } : { fileGrantId: refs._reference(text, ['file'], 'read') }, options)
          return true
        }
        if (Object.keys(options).length) throw Object.assign(new Error('当前剪贴板合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
        const MAX_IPC_SIZE = 200 * 1024 // 200KB 阈值

        // 大文本：写入临时文件，只传文件路径
        if (text.length > MAX_IPC_SIZE && typeof window._writeFileArrayBuffer === 'function') {
          try {
            const tempPath = await this._getTempFilePath()
            const encoder = new TextEncoder()
            const byteArray = Array.from(encoder.encode(text))
            const ok = window._writeFileArrayBuffer(tempPath, byteArray)
            if (ok) {
              const r = await this.transport.call('clipboard_copy_text', { tempFile: tempPath })
              return r && r.success === true
            }
          } catch (e) {
            // 临时文件方案失败，回退到直接传输（可能崩溃，但至少尝试）
            console.warn('[clipboard.copyText] 临时文件方案失败，回退直接传输:', e)
          }
        }

        // 小文本或非 CEF 环境：直接传输
        const r = await this.transport.call('clipboard_copy_text', { text })
        return r && r.success === true
      }

      /**
       * 生成临时文件路径（用于大数据传输）
       * @returns {Promise<string>}
       * @private
       */
      async _getTempFilePath() {
        // 通过 system API 获取临时目录
        const r = await this.transport.call('system_get_path', { name: 'temp' })
        const tempDir = (r && r.success && r.path) ? r.path : 'C:\\Temp'
        return tempDir + '\\ztools_clipboard_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.tmp'
      }

      /**
       * 复制图片到剪贴板
       * @param {string} image - Base64 编码的图片
       * @returns {Promise<boolean>}
       */
      async copyImage(image, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          const refs = new ReferenceFileSystemAPI(this.transport)
          refs._options(options, ['signal'])
          if (typeof image === 'string' && new TextEncoder().encode(image).length > 700 * 1024) throw refs._error('FILE_TOO_LARGE', '大图请使用FileRef')
          await refs._call('clipboard_copy_image', typeof image === 'string' ? { image } : { fileGrantId: refs._reference(image, ['file'], 'read') }, options)
          return true
        }
        if (Object.keys(options).length) throw Object.assign(new Error('当前剪贴板合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
        const r = await this.transport.call('clipboard_copy_image', { image })
        return r && r.success === true
      }

      /**
       * 复制文件到剪贴板
       * @param {string} filePath - 文件路径
       * @returns {Promise<boolean>}
       */
      async copyFile(filePath) {
        const r = await this.transport.call('clipboard_copy_file', { filePath })
        return r && r.success === true
      }

      /**
       * 复制多个文件到剪贴板
       * @param {string[]} filePaths - 文件路径数组
       * @returns {Promise<boolean>}
       */
      async copyFiles(filePaths) {
        const r = await this.transport.call('clipboard_copy_files', { filePaths })
        return r && r.success === true
      }

      // ============ 读取操作 ============

      /**
       * 读取剪贴板文本
       * @returns {Promise<string>} 剪贴板文本内容
       */
      async readText(options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          const refs = new ReferenceFileSystemAPI(this.transport)
          refs._options(options, ['signal'])
          const result = await refs._call('clipboard_read_text', {}, options)
          if (typeof result.text !== 'string' || new TextEncoder().encode(result.text).length > 8 * 1024 * 1024) throw refs._error('RESPONSE_TOO_LARGE', '剪贴板文本响应无效')
          return result.text
        }
        if (Object.keys(options).length) throw Object.assign(new Error('当前剪贴板合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
        const r = await this.transport.call('clipboard_read_text', {})
        if (r && r.success && r.text !== undefined) {
          return r.text
        }
        return ''
      }

      /**
       * 读取剪贴板图片
       * @returns {Promise<string|object>} Base64编码的图片或临时文件对象
       */
      async readImageReference(options = {}) {
        const refs = new ReferenceFileSystemAPI(this.transport)
        refs._options(options, ['signal'])
        const result = await refs._call('clipboard_read_image', {}, options)
        if (result.useReference === false) {
          if (typeof result.image !== 'string' || (result.image !== '' && (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(result.image) || result.image.length > 700 * 1024))) throw refs._error('CLIPBOARD_ERROR', '剪贴板图片响应无效')
          return result.image
        }
        const reference = refs._returnedReference(result.reference, ['file'])
        try {
          if (result.useReference !== true || result.fileUrl !== 'ztools://file/' + reference.grantId + '/' + encodeURIComponent(reference.displayName) || !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 16 * 1024 * 1024 || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width <= 0 || result.height <= 0 || result.width * result.height > 32 * 1024 * 1024) throw refs._error('CLIPBOARD_ERROR', '剪贴板图片引用响应无效')
          let released
          return Object.freeze({ type: 'reference', reference: Object.freeze({ ...reference, operations: Object.freeze([...reference.operations]) }), fileUrl: result.fileUrl, size: result.size, width: result.width, height: result.height,
            release: () => released ??= refs.revoke(reference),
            toDataURL: async (readOptions = {}) => {
              refs._options(readOptions, ['signal'])
              if (released) throw refs._error('PERMISSION_DENIED', '图片引用已释放')
              const bytes = new Uint8Array(await refs.readFileAsBinary(reference, readOptions))
              return 'data:image/png;base64,' + clipboardBytesToBase64(bytes)
            }
          })
        } catch (error) { await refs.revoke(reference); throw error }
      }

      async readImage(options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          const result = await this.readImageReference(options)
          if (typeof result === 'string') return result
          try { return await result.toDataURL(options) }
          finally { await result.release() }
        }
        if (Object.keys(options).length) throw Object.assign(new Error('当前剪贴板合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
        const r = await this.transport.call('clipboard_read_image', {})
        if (r && r.success) {
          if (r.useTempFile) {
            // 大图片(大于2M)：返回临时文件对象
            return {
              type: 'file',
              path: r.tempFile,
              size: r.size,
              width: r.width,
              height: r.height,
              /**
               * 转换为可用的 blob URL
               * @returns {Promise<string>} Blob URL
               */
              toDataURL: async () => {
                // 通过 filesystem API 读取文件
                if (window.ztools && window.ztools.fs) {
                  const binary = await window.ztools.fs.readFileAsBinary(r.tempFile)
                  const blob = new Blob([binary], { type: 'image/png' })
                  return URL.createObjectURL(blob)
                }
                throw new Error('filesystem API not available')
              }
            }
          } else {
            // 小图片：返回 Base64
            return r.image
          }
        }
        return ''
      }

      /**
       * 读取剪贴板文件列表
       * @returns {Promise<Array>} 文件路径数组
       */
      async readFilesDetailed(options = {}) {
        const refs = new ReferenceFileSystemAPI(this.transport)
        refs._options(options, ['signal'])
        const result = await refs._call('clipboard_read_files', {}, options), acquired = new Set()
        try {
          if (!Array.isArray(result.files) || result.files.length > 256 || !Array.isArray(result.errors) || result.errors.length > 256) throw refs._error('CLIPBOARD_ERROR', '文件剪贴板响应无效')
          const files = result.files.map(file => {
            const ref = refs._returnedReference(file, ['file', 'directory'])
            if (acquired.has(ref.grantId)) throw refs._error('CLIPBOARD_ERROR', '文件剪贴板引用重复')
            acquired.add(ref.grantId)
            if (ref.kind === 'directory' && (ref.operations.length !== 2 || !ref.operations.includes('read') || !ref.operations.includes('list'))) throw refs._error('CLIPBOARD_ERROR', '剪贴板目录权限无效')
            return Object.freeze({ ...ref, operations: Object.freeze([...ref.operations]) })
          })
          const errors = result.errors.map(error => {
            if (!error || typeof error !== 'object' || Object.keys(error).some(key => !['index', 'code', 'message'].includes(key)) || !Number.isSafeInteger(error.index) || error.index < 0 || error.index >= 256 || typeof error.code !== 'string' || error.code.length > 64 || typeof error.message !== 'string' || error.message.length > 2048) throw refs._error('CLIPBOARD_ERROR', '文件剪贴板错误响应无效')
            return Object.freeze({ ...error })
          })
          if (options.signal?.aborted) throw refs._error('CALLER_DESTROYED', '文件剪贴板请求已取消')
          return Object.freeze({ files: Object.freeze(files), errors: Object.freeze(errors) })
        } catch (error) { await Promise.all([...acquired].map(grantId => refs._call('filesystem_revoke', { grantId }))); throw error }
      }

      async readFiles(options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) return (await this.readFilesDetailed(options)).files
        if (Object.keys(options).length) throw Object.assign(new Error('当前剪贴板合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
        const r = await this.transport.call('clipboard_read_files', {})
        if (r && r.success && r.files) {
          return r.files
        }
        return []
      }

      // ============ 隐藏并粘贴/输入 ============

      /**
       * 隐藏主窗口并粘贴文本
       * @param {string} text - 要粘贴的文本
       * @returns {Promise<boolean>}
       */
      async hideAndPasteText(text) {
        const r = await this.transport.call('clipboard_hide_and_paste_text', {
          text
        })
        return r && r.success === true
      }

      /**
       * 隐藏主窗口并粘贴图片
       * @param {string} image - Base64 编码的图片
       * @returns {Promise<boolean>}
       */
      async hideAndPasteImage(image) {
        const r = await this.transport.call('clipboard_hide_and_paste_image', {
          image
        })
        return r && r.success === true
      }

      /**
       * 隐藏主窗口并粘贴文件
       * @param {string} filePath - 文件路径
       * @returns {Promise<boolean>}
       */
      async hideAndPasteFile(filePath) {
        const r = await this.transport.call('clipboard_hide_and_paste_file', {
          filePath
        })
        return r && r.success === true
      }

      /**
       * 隐藏主窗口并输入文本 (模拟键盘输入)
       * @param {string} text - 要输入的文本
       * @returns {Promise<boolean>}
       */
      async hideAndType(text) {
        const r = await this.transport.call('clipboard_hide_and_type', { text })
        return r && r.success === true
      }

      // ============ 便捷方法（别名） ============

      /**
       * 写入文本到剪贴板（copyText 的别名）
       * @param {string} text - 要写入的文本
       * @returns {Promise<boolean>}
       */
      async writeText(text, options = {}) {
        return await this.copyText(text, options)
      }

      /**
       * 清空剪贴板
       * @returns {Promise<boolean>}
       */
      async clear(options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          const refs = new ReferenceFileSystemAPI(this.transport)
          refs._options(options, ['signal']); await refs._call('clipboard_clear', {}, options); return true
        }
        if (Object.keys(options).length) throw Object.assign(new Error('当前剪贴板合约不支持取消选项'), { code: 'NOT_SUPPORTED' })
        const r = await this.transport.call('clipboard_clear', {})
        return r && r.success === true
      }

      // ============ 剪贴板监控 ============

      /**
       * 监听剪贴板变化
       * @param {function} handler - 回调函数，接收事件对象
       * @returns {function} 取消监听的函数
       *
       * 事件对象格式：
       * {
       *   type: 'text' | 'image' | 'files',
       *   // 文本类型：
       *   text: string,
       *   hasData: boolean,
       *   size: number,
       *   // 图片类型：
       *   image: string (Base64),  // 小图片
       *   hasData: boolean,
       *   tempFile: string,         // 大图片临时文件路径
       *   width: number,
       *   height: number,
       *   size: number,
       *   format: string,
       *   // 文件类型：
       *   files: Array<string>
       * }
       */
      onChange(handler) {
        if (typeof handler !== 'function') {
          throw new Error('Handler must be a function')
        }

        const existing = this.changeHandlers.get(handler)
        if (existing) return existing.dispose
        const record = { wrapped: undefined, dispose: undefined }
        record.wrapped = (envelope) => {
          if (this.changeHandlers.get(handler) === record && envelope?.type === 'clipboard_change' && envelope.payload) handler(envelope.payload)
        }
        record.dispose = () => {
          if (this.changeHandlers.get(handler) !== record) return
          this.changeHandlers.delete(handler)
          this.events.off('clipboard_change', record.wrapped)
        }
        this.changeHandlers.set(handler, record)
        try { this.events.on('clipboard_change', record.wrapped) }
        catch (error) { this.changeHandlers.delete(handler); throw error }
        return record.dispose
      }

      /**
       * 取消监听剪贴板变化
       * @param {function} handler - 要取消的回调函数（可选）
       */
      offChange(handler) {
        if (handler !== undefined && typeof handler !== 'function') throw new TypeError('Handler must be a function')
        if (handler === undefined) { for (const record of [...this.changeHandlers.values()]) record.dispose() }
        else this.changeHandlers.get(handler)?.dispose()
      }
    }

    // ========================================
    // api/screen.js
    // ========================================

    /**
     * Screen API - 屏幕操作
     * 提供屏幕操作功能，类似 uTools API
     */
    function bytesToBase64(bytes) {
      const chunkSize = 0x8000
      let binary = ''
      for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
      }
      return btoa(binary)
    }

    class ScreenAPI {
      constructor(transport, sys) {
        this.transport = transport
        this.sys = sys
      }

      // ============ 屏幕截图 ============

      /**
       * 屏幕截图
       * @param {object} rect - 截图区域 {x, y, width, height}，不传则截取全屏
       * @param {function} callback - 回调函数，接收 Base64 编码的图片
       * @returns {Promise<string>} Base64 编码的图片
       */
      async captureReference(rect, options = {}) {
        return this._captureReference('screen_capture', rect ? { rect } : {}, options)
      }
      async captureRegionReference(options = {}) {
        return this._captureReference('screen_capture_region', {}, options)
      }
      async _captureReference(method, params, options) {
        const refs = new ReferenceFileSystemAPI(this.transport)
        refs._options(options, ['signal'])
        await ensureRuntimeCapability(this.sys, 'screen.capture', options)
        const result = await refs._call(method, params, { ...options, ...(method === 'screen_capture_region' ? { timeout: 120000 } : {}) })
        if (method === 'screen_capture_region' && result.cancelled !== undefined) {
          if (result.reference) await refs.revoke(refs._returnedReference(result.reference, ['file']))
          if (result.cancelled !== true || Object.keys(result).some(key => !['success', 'cancelled'].includes(key))) throw refs._error('SCREEN_ERROR', '区域截图取消响应无效')
          return undefined
        }
        const reference = refs._returnedReference(result.reference, ['file'])
        try {
          if (result.fileUrl !== 'ztools://file/' + reference.grantId + '/' + encodeURIComponent(reference.displayName) || !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 16 * 1024 * 1024 || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width <= 0 || result.height <= 0 || result.width * result.height > 32 * 1024 * 1024) throw refs._error('SCREEN_ERROR', '截图引用响应无效')
          return Object.freeze({ reference: Object.freeze({ ...reference, operations: Object.freeze([...reference.operations]) }), fileUrl: result.fileUrl, size: result.size, width: result.width, height: result.height })
        } catch (error) { await refs.revoke(reference); throw error }
      }

      async capture(rect, callback, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          const refs = new ReferenceFileSystemAPI(this.transport), result = await this.captureReference(rect, options)
          let imageBase64
          try {
            const bytes = new Uint8Array(await refs.readFileAsBinary(result.reference, { signal: options.signal }))
            imageBase64 = 'data:image/png;base64,' + bytesToBase64(bytes)
          } finally { await refs.revoke(result.reference) }
          if (typeof callback === 'function') callback(imageBase64)
          return imageBase64
        }
        if (Object.keys(options).length) throw Object.assign(new Error('当前截图合约不支持引用取消选项'), { code: 'NOT_SUPPORTED' })
        await ensureRuntimeCapability(this.sys, 'screen.capture')
        const params = rect ? { rect } : {}
        const r = await this.transport.call('screen_capture', params)

        if (r && r.success && r.tempFile) {
          try {
            // 使用文件系统API读取临时文件
            const binaryData = await window.ztools.fs.readFileAsBinary(r.tempFile)

            // 转换为Base64
            const imageBase64 = 'data:image/png;base64,' + bytesToBase64(binaryData)

            // 删除临时文件
            try {
              await window.ztools.fs.deleteFile(r.tempFile)
            } catch (e) {
              console.warn('Failed to delete temp screenshot file:', e)
            }

            if (typeof callback === 'function') {
              callback(imageBase64)
            }
            return imageBase64
          } catch (e) {
            console.error('Failed to read temp screenshot file:', e)
            throw new Error('Failed to read screenshot: ' + e.message)
          }
        }

        throw new Error(r?.error || 'Screen capture failed')
      }

      async _screenCall(method, params) {
        if (window.__ztoolsElectron?.contractVersion === 2) return new ReferenceFileSystemAPI(this.transport)._call(method, params)
        return this.transport.call(method, params)
      }

      // ============ 鼠标位置 ============

      /**
       * 获取鼠标位置
       * @returns {Promise<{x: number, y: number}>} 鼠标坐标
       */
      async getCursorScreenPoint() {
        const r = await this._screenCall('screen_get_cursor_pos', {})
        if (r && r.success) {
          return { x: r.x, y: r.y }
        }
        throw new Error(r?.error || 'Get cursor position failed')
      }

      /**
       * 获取鼠标位置 (别名，兼容部分组件调用)
       * @returns {Promise<{x: number, y: number}>} 鼠标坐标
       */
      async getCursorPos() {
        return await this.getCursorScreenPoint()
      }

      // ============ 显示器信息 ============

      /**
       * 获取主显示器信息
       * @returns {Promise<object>} 显示器信息
       */
      async getPrimaryDisplay() {
        const r = await this._screenCall('screen_get_primary_display', {})
        if (r && r.success && r.display) {
          return r.display
        }
        throw new Error(r?.error || 'Get primary display failed')
      }

      /**
       * 获取所有显示器信息
       * @returns {Promise<Array>} 显示器信息数组
       */
      async getAllDisplays() {
        const r = await this._screenCall('screen_get_all_displays', {})
        if (r && r.success && r.displays) {
          return r.displays
        }
        throw new Error(r?.error || 'Get all displays failed')
      }

      /**
       * 获取距离指定点最近的显示器
       * @param {object} point - 坐标点 {x, y}
       * @returns {Promise<object>} 显示器信息
       */
      async getDisplayNearestPoint(point) {
        const r = await this._screenCall('screen_get_display_nearest', {
          point
        })
        if (r && r.success && r.display) {
          return r.display
        }
        throw new Error(r?.error || 'Get display nearest point failed')
      }

      /**
       * 获取与指定矩形最匹配的显示器
       * @param {object} rect - 矩形区域 {x, y, width, height}
       * @returns {Promise<object>} 显示器信息
       */
      async getDisplayMatching(rect) {
        const r = await this._screenCall('screen_get_display_matching', { rect })
        if (r && r.success && r.display) {
          return r.display
        }
        throw new Error(r?.error || 'Get display matching failed')
      }

      // ============ 便捷方法 ============

      /**
       * 全屏截图
       * @returns {Promise<string>} Base64 编码的图片
       */
      async captureFullScreen(options = {}) {
        return await this.capture(undefined, undefined, options)
      }

      /**
       * 区域截图
       * @param {number} x - X坐标
       * @param {number} y - Y坐标
       * @param {number} width - 宽度
       * @param {number} height - 高度
       * @returns {Promise<string>} Base64 编码的图片
       */
      async captureRegion(x, y, width, height, options = {}) {
        return await this.capture({ x, y, width, height }, undefined, options)
      }
    }

    // ========================================
    // api/file-producers-reference.js
    // ========================================

    /** SDK2 source; activated together with every file consumer and the Main/preload contract. */
    class ReferenceWindowAPI extends WindowAPI {
      constructor(transport) { super(transport); this.references = new ReferenceFileSystemAPI(transport) }
      async _showReferenceDialog(method, params, options, mode) {
        const refs = this.references
        refs._options(options, ['signal'])
        refs._options(params, mode === 'open' ? ['title', 'filters', 'properties'] : mode === 'save' ? ['title', 'filters', 'defaultName'] : ['title', 'access'])
        for (const key of ['title', 'filters', 'defaultName']) if (params[key] !== undefined && (typeof params[key] !== 'string' ||
            params[key].includes('\0') || new TextEncoder().encode(params[key]).length > 4096)) throw refs._error('INVALID_REQUEST', '文件选择提示无效')
        if (params.defaultName !== undefined) { refs._relative(params.defaultName, false); if (params.defaultName.includes('/')) throw refs._error('INVALID_REQUEST', '保存名称只能有一个文件名') }
        if (params.properties !== undefined && (!Array.isArray(params.properties) || !params.properties.length || params.properties.length > 3 ||
            new Set(params.properties).size !== params.properties.length || params.properties.some(item => !['openFile', 'openDirectory', 'multiSelections'].includes(item)))) {
          throw refs._error('INVALID_REQUEST', '文件选择类型无效')
        }
        if (params.access !== undefined && !['read', 'read-write'].includes(params.access)) throw refs._error('INVALID_REQUEST', '目录授权范围无效')
        const result = await refs._call(method, params, { ...options, timeout: Infinity })
        if (Object.keys(result).some(key => !['success', 'canceled', 'references'].includes(key)) || typeof result.canceled !== 'boolean' ||
            !Array.isArray(result.references) || result.references.length > 64 || (result.canceled && result.references.length)) throw refs._error('FILE_ERROR', '文件选择响应无效')
        for (const reference of result.references) refs._returnedReference(reference, mode === 'save' ? ['save'] : mode === 'folder' ? ['directory'] : ['file', 'directory'])
        return result
      }
      showOpenDialog(params = {}, options = {}) { return this._showReferenceDialog('window_show_open_dialog', params, options, 'open') }
      showSaveDialog(params = {}, options = {}) { return this._showReferenceDialog('window_show_save_dialog', params, options, 'save') }
      showSelectFolderDialog(params = {}, options = {}) { return this._showReferenceDialog('window_show_select_folder_dialog', params, options, 'folder') }
    }

    class ReferenceClipboardAPI extends ClipboardAPI {
      constructor(transport, events) { super(transport, events); this.references = new ReferenceFileSystemAPI(transport); this.referenceHandlers = new Map() }
      _getTempFilePath() { return Promise.reject(this.references._error('NOT_SUPPORTED', '文件引用SDK不返回临时路径')) }
      async copyText(textOrFile, options = {}) {
        const refs = this.references; refs._options(options, ['signal'])
        const params = typeof textOrFile === 'string' ? { text: textOrFile } : { fileGrantId: refs._reference(textOrFile, ['file'], 'read') }
        if (params.text !== undefined && new TextEncoder().encode(params.text).length > 8 * 1024 * 1024) throw refs._error('FILE_TOO_LARGE', '剪贴板文本超过8MiB')
        return refs._call('clipboard_copy_text', params, options)
      }
      async readFiles(options = {}) {
        const refs = this.references; refs._options(options, ['signal'])
        const result = await refs._call('clipboard_read_files', {}, options)
        return this._fileResult(result)
      }
      _fileResult(result) {
        const refs = this.references
        if (Object.keys(result).some(key => !['success', 'files', 'errors'].includes(key)) || !Array.isArray(result.files) || result.files.length > 256 ||
            !Array.isArray(result.errors) || result.errors.length > 256) throw refs._error('FILE_ERROR', '文件剪贴板响应无效')
        for (const file of result.files) refs._returnedReference(file, ['file', 'directory'])
        for (const error of result.errors) if (!error || Object.keys(error).some(key => !['index', 'code', 'message'].includes(key)) || !Number.isInteger(error.index) || typeof error.code !== 'string' || typeof error.message !== 'string') throw refs._error('FILE_ERROR', '文件剪贴板错误响应无效')
        return result
      }
      onChange(handler) {
        const refs = this.references
        if (window.__ztoolsElectron?.contractVersion !== 2 || !this.events) throw refs._error('NOT_SUPPORTED', '文件引用事件宿主不可用')
        if (typeof handler !== 'function') throw refs._error('INVALID_REQUEST', '剪贴板事件处理器无效')
        if (this.referenceHandlers.size >= 256 && !this.referenceHandlers.has(handler)) throw refs._error('PERMISSION_DENIED', '剪贴板事件处理器超过上限')
        if (!this.referenceHandlers.has(handler)) {
          const wrapped = envelope => {
            if (envelope?.type !== 'clipboard_change' || !envelope.payload) return
            const payload = envelope.payload
            if (payload.type === 'files') {
              if (payload.contractVersion !== 2 || Object.keys(payload).some(key => !['contractVersion', 'type', 'files', 'errors', 'hasData'].includes(key)) ||
                  typeof payload.hasData !== 'boolean') throw refs._error('FILE_ERROR', '文件剪贴板事件契约无效')
              this._fileResult({ success: true, files: payload.files, errors: payload.errors })
              if (payload.hasData !== (payload.files.length > 0)) throw refs._error('FILE_ERROR', '文件剪贴板事件状态无效')
            }
            handler(payload)
          }
          this.events.on('clipboard_change', wrapped)
          this.referenceHandlers.set(handler, wrapped)
        }
        let active = true
        return () => { if (active) { active = false; this.offChange(handler) } }
      }
      offChange(handler) {
        const handlers = handler === undefined ? [...this.referenceHandlers.keys()] : [handler]
        for (const original of handlers) {
          const wrapped = this.referenceHandlers.get(original)
          if (wrapped) { this.events.off('clipboard_change', wrapped); this.referenceHandlers.delete(original) }
        }
      }
      async readImage(options = {}) {
        const refs = this.references; refs._options(options, ['signal'])
        const result = await refs._call('clipboard_read_image', {}, options)
        if (result.useReference === true) return referenceImageResult(refs, result, true)
        if (result.useReference !== false || Object.keys(result).some(key => !['success', 'useReference', 'image'].includes(key)) ||
            typeof result.image !== 'string') throw refs._error('FILE_ERROR', '图片剪贴板响应无效')
        if (result.image) {
          const prefix = 'data:image/png;base64,'
          if (!result.image.startsWith(prefix)) throw refs._error('FILE_ERROR', '图片数据响应无效')
          const content = result.image.slice(prefix.length)
          const size = Math.floor(content.length / 4) * 3 - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0)
          if (size > 512 * 1024) throw refs._error('FILE_ERROR', '直接图片数据超出上限')
          refs._decode(content, size)
        }
        return result
      }
      async copyFile(file, options = {}) { this.references._options(options, ['signal']); return this.references._call('clipboard_copy_file', { fileGrantId: this.references._reference(file, ['file'], 'read') }, options) }
      async copyFiles(files, options = {}) {
        this.references._options(options, ['signal'])
        if (!Array.isArray(files) || !files.length || files.length > 256) return Promise.reject(this.references._error('INVALID_REQUEST', '文件剪贴板数量无效'))
        return this.references._call('clipboard_copy_files', { fileGrantIds: files.map(file => this.references._reference(file, ['file'], 'read')) }, options)
      }
      hideAndPasteFile() { return Promise.reject(this.references._error('NOT_SUPPORTED', '引用文件粘贴消费者尚未接线')) }
    }

    function referenceImageResult(refs, result, clipboard = false) {
      if (Object.keys(result).some(key => !['success', 'reference', 'fileUrl', 'size', 'width', 'height', ...(clipboard ? ['useReference'] : [])].includes(key)) ||
          !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width <= 0 || result.height <= 0 ||
          result.width * result.height > 32 * 1024 * 1024 || !Number.isSafeInteger(result.size) || result.size < 0 || result.size > 16 * 1024 * 1024 ||
          typeof result.fileUrl !== 'string') throw refs._error('FILE_ERROR', '图片引用响应无效')
      refs._returnedReference({ ...result.reference, fileUrl: result.fileUrl }, ['file'])
      return result
    }
    class ReferenceScreenAPI extends ScreenAPI {
      constructor(transport) { super(transport); this.references = new ReferenceFileSystemAPI(transport) }
      async capture(params = {}, options = {}) {
        this.references._options(options, ['signal'])
        this.references._options(params, ['rect'])
        return referenceImageResult(this.references, await this.references._call('screen_capture', params, options))
      }
      captureFullScreen(options = {}) { return this.capture({}, options) }
      captureRegion(x, y, width, height, options = {}) { return this.capture({ rect: { x, y, width, height } }, options) }
    }

    // ========================================
    // api/shell.js
    // ========================================

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

    // ========================================
    // api/network.js
    // ========================================

    /**
     * Network API - 网络请求
     * 解决 CEF 环境下的 CORS 限制
     */
    class NetworkAPI {
      constructor(transport) {
        this.transport = transport
      }

      /**
       * 发起HTTP请求
       * @param {Object} options - 请求选项
       * @param {string} options.method - 请求方法：'GET'|'HEAD'|'POST'|'PUT'|'DELETE'
       * @param {string} options.url - 请求URL
       * @param {Object} [options.headers] - 自定义请求头
       * @param {string|Object} [options.body] - 请求体(POST/PUT)
       * @param {number} [options.timeout=30000] - 超时时间(毫秒)
       * @param {AbortSignal} [options.signal] - 取消请求；仅通过 Transport 受控选项传递
       * @returns {Promise<{statusCode: number, statusText: string, body: string}>}
       */
      async request(options) {
        const { method, url, headers, body, timeout = 30000, signal } = options
        // Let the NetworkService's own deadline return its stable timeout result
        // before the outer IPC deadline can race it. Main's parser caps this at 300s.
        const transportTimeout = Number.isSafeInteger(timeout) && timeout > 0
          ? Math.min(timeout + 250, 300250)
          : timeout

        return await this.transport.call(
          'network_http_request',
          {
            method: method.toUpperCase(),
            url,
            headers,
            body: typeof body === 'object' ? JSON.stringify(body) : body,
            timeout
          },
          { timeout: transportTimeout, ...(signal === undefined ? {} : { signal }) }
        )
      }

      /**
       * 发起HTTP请求 (别名)
       */
      async httpRequest(options) {
        return await this.request(options)
      }

      /**
       * GET请求简化方法
       * @param {string} url - 请求URL
       * @param {Object} [options] - 额外选项
       * @returns {Promise<{statusCode: number, statusText: string, body: string}>}
       */
      async get(url, options = {}) {
        return this.request({ method: 'GET', url, ...options })
      }

      /**
       * POST请求简化方法
       * @param {string} url - 请求URL
       * @param {string|Object} body - 请求体
       * @param {Object} [options] - 额外选项
       * @returns {Promise<{statusCode: number, statusText: string, body: string}>}
       */
      async post(url, body, options = {}) {
        return this.request({ method: 'POST', url, body, ...options })
      }

      /**
       * PUT请求简化方法
       * @param {string} url - 请求URL
       * @param {string|Object} body - 请求体
       * @param {Object} [options] - 额外选项
       * @returns {Promise<{statusCode: number, statusText: string, body: string}>}
       */
      async put(url, body, options = {}) {
        return this.request({ method: 'PUT', url, body, ...options })
      }

      /**
       * DELETE请求简化方法
       * @param {string} url - 请求URL
       * @param {Object} [options] - 额外选项
       * @returns {Promise<{statusCode: number, statusText: string, body: string}>}
       */
      async delete(url, options = {}) {
        return this.request({ method: 'DELETE', url, ...options })
      }

      /**
       * 下载文件(带进度回调)
       * @param {string} url - 文件URL
       * @param {string} savePath - 保存路径
       * @param {Object} [options] - 下载选项
       * @param {Object} [options.headers] - 自定义请求头
       * @param {Function} [options.onProgress] - 进度回调 (downloaded, total) => void
       * @returns {Promise<{path: string, size: number}>}
       */
      async download(url, savePath, options = {}) {
        const { headers, onProgress, timeout = 120000 } = options

        // TODO: 实现进度回调监听
        // 需要通过EventBus监听download进度事件

        const result = await this.transport.call(
          'network_http_download',
          { url, savePath, headers, timeout },
          { timeout }
        )
        onProgress?.(result.size, result.size)
        return result
      }

      /**
       * 上传文件(带进度回调)
       * @param {string} url - 上传URL
       * @param {string} filePath - 文件路径
       * @param {Object} [options] - 上传选项
       * @param {Object} [options.headers] - 自定义请求头
       * @param {string} [options.fieldName='file'] - 表单字段名
       * @param {Function} [options.onProgress] - 进度回调 (uploaded, total) => void
       * @returns {Promise<Object>}
       */
      async upload(url, filePath, options = {}) {
        const { headers, fieldName = 'file', onProgress, timeout = 120000 } = options

        // TODO: 实现进度回调监听

        const result = await this.transport.call(
          'network_http_upload',
          { url, filePath, fieldName, headers, timeout },
          { timeout }
        )
        onProgress?.(1, 1)
        return result
      }

      /**
       * 设置Cookie
       * @param {Object} cookie - Cookie对象
       * @param {string} cookie.name - Cookie名称
       * @param {string} cookie.value - Cookie值
       * @param {string} [cookie.domain] - 域名
       * @param {string} [cookie.path='/'] - 路径
       * @returns {Promise<void>}
       */
      async setCookie(cookie) {
        return await this.transport.call('network_set_cookie', cookie)
      }

      /**
       * 获取Cookie
       * @param {string} url - URL
       * @returns {Promise<Array<Object>>} Cookie列表
       */
      async getCookie(url) {
        return await this.transport.call('network_get_cookie', { url })
      }

      /**
       * 清除所有Cookie
       * @returns {Promise<void>}
       */
      async clearCookies() {
        return await this.transport.call('network_clear_cookies', {})
      }

      /**
       * 设置代理
       * @param {Object} proxy - 代理配置
       * @param {string} proxy.host - 代理主机
       * @param {number} proxy.port - 代理端口
       * @param {string} [proxy.username] - 用户名
       * @param {string} [proxy.password] - 密码
       * @returns {Promise<void>}
       */
      async setProxy(proxy) {
        return await this.transport.call('network_set_proxy', proxy)
      }
    }

    // 导出类(不导出单例,由client.js实例化)

    // ========================================
    // api/network-reference.js
    // ========================================

    /** SDK2 transfer source. Non-file networking continues through the existing NetworkAPI. */
    class ReferenceNetworkAPI extends NetworkAPI {
      constructor(transport) { super(transport); this.references = new ReferenceFileSystemAPI(transport) }
      _transferOptions(url, options, upload) {
        const refs = this.references
        refs._options(options, upload ? ['headers', 'fieldName', 'timeout', 'signal', 'onProgress'] : ['headers', 'replace', 'timeout', 'signal', 'onProgress'])
        let parsed
        try { parsed = new URL(url) } catch { throw refs._error('INVALID_REQUEST', '文件传输URL无效') }
        if (typeof url !== 'string' || new TextEncoder().encode(url).length > 8192 || /[\0\r\n]/.test(url) ||
            !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw refs._error('INVALID_REQUEST', '文件传输URL无效')
        const timeout = options.timeout ?? 120000
        if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) throw refs._error('INVALID_REQUEST', '文件传输超时范围无效')
        if (options.headers !== undefined) {
          if (!options.headers || typeof options.headers !== 'object' || Array.isArray(options.headers) || Object.keys(options.headers).length > 128) throw refs._error('INVALID_REQUEST', '文件传输headers无效')
          let bytes = 0
          for (const [key, value] of Object.entries(options.headers)) {
            if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(key) || typeof value !== 'string' || /[\0\r\n]/.test(value) || new TextEncoder().encode(value).length > 8192) throw refs._error('INVALID_REQUEST', '文件传输headers无效')
            bytes += new TextEncoder().encode(key + value).length
            if (bytes > 64 * 1024) throw refs._error('INVALID_REQUEST', '文件传输headers超出上限')
          }
        }
        if (upload && options.fieldName !== undefined && (typeof options.fieldName !== 'string' || !options.fieldName || /[\0\r\n]/.test(options.fieldName) || new TextEncoder().encode(options.fieldName).length > 256)) throw refs._error('INVALID_REQUEST', '上传字段名无效')
        return { url: parsed.href, timeout, ...(options.headers !== undefined ? { headers: options.headers } : {}) }
      }
      async download(url, save, options = {}) {
        const params = this._transferOptions(url, options, false), refs = this.references
        const saveGrantId = refs._reference(save, ['save'], 'write')
        const result = await refs._call('network_http_download', { ...params, saveGrantId, replace: options.replace ?? false }, { signal: options.signal, timeout: params.timeout })
        if (Object.keys(result).some(key => !['success', 'grantId', 'size', 'statusCode', 'statusText'].includes(key)) || result.grantId !== saveGrantId ||
            !Number.isSafeInteger(result.size) || result.size < 0 || result.size > 1024 * 1024 * 1024 || !Number.isInteger(result.statusCode) ||
            result.statusCode < 200 || result.statusCode >= 300 || typeof result.statusText !== 'string') throw refs._error('FILE_WRITE_OUTCOME_UNKNOWN', '下载完成后的响应无法确认')
        options.onProgress?.(result.size, result.size)
        return result
      }
      async upload(url, file, options = {}) {
        const params = this._transferOptions(url, options, true), refs = this.references
        const result = await refs._call('network_http_upload', { ...params, fileGrantId: refs._reference(file, ['file'], 'read'), fieldName: options.fieldName ?? 'file' }, { signal: options.signal, timeout: params.timeout })
        if (Object.keys(result).some(key => !['success', 'data'].includes(key)) || !result.data || Object.keys(result.data).some(key => !['statusCode', 'statusText', 'body'].includes(key)) ||
            !Number.isInteger(result.data.statusCode) || result.data.statusCode < 200 || result.data.statusCode >= 300 || typeof result.data.statusText !== 'string' ||
            typeof result.data.body !== 'string' || new TextEncoder().encode(result.data.body).length > 16 * 1024 * 1024) throw refs._error('NETWORK_ERROR', '上传响应无效')
        options.onProgress?.(1, 1)
        return result
      }
    }

    // ========================================
    // api/process.js
    // ========================================

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
        if (!response || response.success !== true || !Array.isArray(response.data) || response.data.length > 20000 || !['darwin-lsof', 'windows-netstat'].includes(response.source) || response.visibility !== 'visible-processes' || typeof response.queriedAt !== 'string' || !Number.isFinite(Date.parse(response.queriedAt))) throw failed()
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

    // ========================================
    // api/ocr-reference.js
    // ========================================

    class ReferenceOcrAPI extends ReferenceFileSystemAPI {
      _common(result) {
        if (result.provider !== 'apple-vision-local' || !Number.isSafeInteger(result.revision) || result.revision < 1) throw this._error('FILE_ERROR', '本地OCR结果无效')
      }
      _languages(value, maximum) {
        if (!Array.isArray(value) || value.length > maximum || value.some(v => typeof v !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(v)) || new Set(value).size !== value.length) throw this._error('INVALID_REQUEST', '本地OCR语言无效')
        return [...value]
      }
      async languages(options = {}) {
        this._options(options, ['signal'])
        const result = await this._call('ocr_local_languages', {}, options); this._common(result)
        const languages = this._languages(result.languages, 256)
        if (!languages.length) throw this._error('FILE_ERROR', '本地OCR未提供语言')
        return Object.freeze({ provider: result.provider, revision: result.revision, languages: Object.freeze(languages) })
      }
      async recognize(file, options = {}) {
        this._options(options, ['languages', 'signal'])
        const languages = this._languages(options.languages ?? [], 8)
        const result = await this._call('ocr_recognize_reference', { fileGrantId: this._reference(file, ['file'], 'read'), languages }, { signal: options.signal, timeout: 35000 })
        this._common(result)
        if (!Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width < 1 || result.height < 1 || result.width > 8192 || result.height > 8192 || result.width * result.height > 8 * 1024 * 1024 || typeof result.text !== 'string' || new TextEncoder().encode(result.text).length > 1024 * 1024 || !Array.isArray(result.lines) || result.lines.length > 10000) throw this._error('FILE_ERROR', '本地OCR结果无效')
        let bytes = 0
        const lines = result.lines.map(line => {
          if (!line || typeof line.text !== 'string' || typeof line.confidence !== 'number' || !Number.isFinite(line.confidence) || line.confidence < 0 || line.confidence > 1 || !Array.isArray(line.box) || line.box.length !== 4 || line.box.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) || line.box[0] + line.box[2] > 1.00001 || line.box[1] + line.box[3] > 1.00001) throw this._error('FILE_ERROR', '本地OCR行无效')
          bytes += new TextEncoder().encode(line.text).length + 1; if (bytes > 1024 * 1024) throw this._error('FILE_ERROR', '本地OCR文字过多')
          return Object.freeze({ text: line.text, confidence: line.confidence, box: Object.freeze([...line.box]) })
        })
        if (lines.map(v => v.text).join('\n') !== result.text) throw this._error('FILE_ERROR', '本地OCR文字不一致')
        return Object.freeze({ provider: result.provider, revision: result.revision, width: result.width, height: result.height, text: result.text, lines: Object.freeze(lines) })
      }
    }

    // ========================================
    // api/ocr.js
    // ========================================

    /**
     * OCR API - 文字识别
     * 直接调用服务器 OCR 进行文字识别
     */
    class OCRAPI {
      constructor(transport) {
        this.transport = transport
        this.ocrServerUrl = 'http://localhost:8001/api/services/ocr/recognize'
        this.remotePollInterval = 2000
        this.remotePollTimeout = 120000
        this.remoteDllCallTimeout = 60000
      }

      /** Contract 2: local Vision only; never routes through DLL/cloud/token code. */
      recognizeLocal(file, options = {}) {
        return (this._localAPI ??= new ReferenceOcrAPI(this.transport)).recognize(file, options)
      }
      getLocalLanguages(options = {}) {
        return (this._localAPI ??= new ReferenceOcrAPI(this.transport)).languages(options)
      }

      async _withAuthToken(params = {}) {
        const payload = { ...params }
        try {
          if (!payload.token && window.ztools?.user?.getToken) {
            const token = await window.ztools.user.getToken()
            if (token) {
              payload.token = token
            }
          }
        } catch (error) {
          console.warn('[OCR] 获取用户 token 失败，将仅使用本地识别:', error)
        }
        return payload
      }

      /**
       * 单张图片OCR识别
       * @param {Object} params
       * @param {string} params.imagePath - 图片文件路径
       * @param {string} [params.language] - 识别语言
       * @returns {Promise<any>}
       */
      async getOrcRes(params) {
        const payload = await this._withAuthToken(params)
        const result = await window.ztools.dllplugin.call(
          'ImageOcrPlugin',
          'PerformOcr',
          payload,
          { timeout: payload.dllCallTimeout || this.remoteDllCallTimeout }
        )
        return await this._resolveRemoteTaskResult(result, payload)
      }

      /**
       * 批量OCR识别
       * @param {Object} params
       * @param {string[]} params.images - 图片文件路径数组
       * @param {string} [params.outputDir] - 结果输出目录（可选）
       * @returns {Promise<{success: boolean, data: {results: Array, total: number, successCount: number, failCount: number}}>}
       */
      async batchOcr(params) {
        const payload = await this._withAuthToken(params)
        const images = Array.isArray(payload.images) ? payload.images : []
        const results = []
        let successCount = 0
        let failCount = 0

        for (const imagePath of images) {
          const startTime = Date.now()
          try {
            const result = await this.getOrcRes({
              ...payload,
              imagePath
            })
            if (!result?.success) {
              throw new Error(result?.error || '识别失败')
            }
            const text = this._extractTextFromOcrData(result?.data)
            results.push({
              imagePath,
              success: true,
              text,
              data: result?.data,
              engine: result?.engine || 'unknown',
              elapsed: Date.now() - startTime
            })
            successCount++
          } catch (error) {
            results.push({
              imagePath,
              success: false,
              error: error.message || '识别失败',
              elapsed: Date.now() - startTime
            })
            failCount++
          }
        }

        return {
          success: failCount === 0,
          data: {
            results,
            total: images.length,
            successCount,
            failCount
          }
        }
      }

      _extractTextFromOcrData(data) {
        if (!data) return ''
        if (Array.isArray(data.ocr_response)) {
          return data.ocr_response
            .map((item) => (typeof item?.text === 'string' ? item.text : ''))
            .filter(Boolean)
            .join('\n')
        }
        if (typeof data.text === 'string') return data.text
        if (typeof data === 'string') return data
        return ''
      }

      async _callOcrDll(params, timeout) {
        return await window.ztools.dllplugin.call(
          'ImageOcrPlugin',
          'PerformOcr',
          params,
          { timeout: timeout || this.remoteDllCallTimeout }
        )
      }

      async _waitRemoteTask(serialNo, token, options = {}) {
        const timeout = options.timeout || this.remotePollTimeout
        const pollInterval = options.pollInterval || this.remotePollInterval
        const startTime = Date.now()

        while (true) {
          if (timeout > 0 && Date.now() - startTime > timeout) {
            throw new Error('远端OCR任务等待超时')
          }

          const result = await this._callOcrDll(
            {
              serial_no: serialNo,
              token
            },
            options.dllCallTimeout
          )

          if (!result?.success) {
            throw new Error(result?.error || '远端OCR任务失败')
          }
          if (!result?.async || result?.completed) {
            return result
          }

          await new Promise((resolve) => setTimeout(resolve, pollInterval))
        }
      }

      async _startRemoteDownload(taskResult, token, options = {}) {
        const resultPath =
          taskResult?.data?.result_path ||
          taskResult?.task?.result?.path ||
          (typeof taskResult?.task?.result === 'string' ? taskResult.task.result : '')

        if (!resultPath) {
          throw new Error('远端OCR任务完成但未返回结果路径')
        }

        const result = await this._callOcrDll(
          {
            action: 'startDownload',
            result_path: resultPath,
            serial_no: taskResult?.data?.serial_no,
            token
          },
          options.dllCallTimeout
        )

        if (!result?.success) {
          throw new Error(result?.error || '启动远端OCR结果下载失败')
        }

        const downloadTaskId = result?.data?.download_task_id
        if (!downloadTaskId) {
          throw new Error('远端OCR结果下载未返回任务编号')
        }
        return downloadTaskId
      }

      async _waitRemoteDownload(downloadTaskId, token, options = {}) {
        const timeout = options.timeout || this.remotePollTimeout
        const pollInterval = options.pollInterval || this.remotePollInterval
        const startTime = Date.now()

        while (true) {
          if (timeout > 0 && Date.now() - startTime > timeout) {
            throw new Error('远端OCR结果下载等待超时')
          }

          const result = await this._callOcrDll(
            {
              action: 'pollDownload',
              download_task_id: downloadTaskId,
              token
            },
            options.dllCallTimeout
          )

          if (!result?.success) {
            throw new Error(result?.error || '远端OCR结果下载失败')
          }
          if (result?.completed) {
            return result
          }

          await new Promise((resolve) => setTimeout(resolve, pollInterval))
        }
      }

      async _getRemoteDownloadResult(downloadTaskId, token, options = {}) {
        const result = await this._callOcrDll(
          {
            action: 'getDownloadResult',
            download_task_id: downloadTaskId,
            token
          },
          options.dllCallTimeout
        )

        if (!result?.success) {
          throw new Error(result?.error || '获取远端OCR结果失败')
        }
        return result
      }

      async _resolveRemoteTaskResult(result, payload) {
        const serialNo = result?.data?.serial_no
        if (!result?.async || !serialNo) {
          return result
        }

        const taskResult = await this._waitRemoteTask(serialNo, payload.token, {
          timeout: payload.timeout,
          pollInterval: payload.pollInterval,
          dllCallTimeout: payload.dllCallTimeout
        })
        if (!taskResult?.requiresDownload) {
          return {
            ...taskResult,
            fallbackReason: result.fallbackReason,
            localError: result.localError
          }
        }

        const downloadTaskId = await this._startRemoteDownload(taskResult, payload.token, {
          dllCallTimeout: payload.dllCallTimeout
        })
        await this._waitRemoteDownload(downloadTaskId, payload.token, {
          timeout: payload.timeout,
          pollInterval: payload.pollInterval,
          dllCallTimeout: payload.dllCallTimeout
        })
        const remoteResult = await this._getRemoteDownloadResult(downloadTaskId, payload.token, {
          dllCallTimeout: payload.dllCallTimeout
        })
        return {
          ...remoteResult,
          fallbackReason: result.fallbackReason,
          localError: result.localError
        }
      }

      /**
       * 调用 OCR 服务器 API（内部方法）
       * @private
       * @param {string} base64Image - Base64编码的图片
       * @param {string} language - 识别语言
       * @returns {Promise<{text: string, blocks: Array}>}
       */
      async _callOCRServer(base64Image, language) {
        try {
          const response = await fetch(this.ocrServerUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              image: base64Image
            })
          })

          if (!response.ok) {
            throw new Error(
              `OCR API 请求失败: ${response.status} ${response.statusText}`
            )
          }

          const result = await response.json()

          // 返回标准格式
          return {
            text: result.text || '',
            blocks: result.blocks || []
          }
        } catch (error) {
          console.error('[OCR] API 调用失败:', error)
          throw new Error(`OCR 识别失败: ${error.message}`)
        }
      }

      /**
       * 从图片识别(Base64 或 URL)
       * @param {string} imageData - Base64编码的图片 或 图片URL
       * @param {Object} [options] - 识别选项
       * @param {string} [options.language='chi_sim'] - 识别语言：'chi_sim'(简体中文)、'eng'(英文)等
       * @returns {Promise<{text: string, blocks: Array<{text: string, x: number, y: number, width: number, height: number}>}>}
       */
      async fromImage(imageData, options = {}) {
        const { language = 'chi_sim' } = options
        let base64Image = imageData

        // 判断是否为 URL
        if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
          try {
            // 下载图片并转换为 Base64
            const response = await fetch(imageData)
            if (!response.ok) {
              throw new Error(`下载图片失败: ${response.status}`)
            }
            const blob = await response.blob()
            base64Image = await this._blobToBase64(blob)
          } catch (error) {
            throw new Error(`下载图片失败: ${error.message}`)
          }
        }

        return await this._callOCRServer(base64Image, language)
      }

      /**
       * 从屏幕区域识别
       * @param {Object} rect - 屏幕区域
       * @param {number} rect.x - X坐标
       * @param {number} rect.y - Y坐标
       * @param {number} rect.width - 宽度
       * @param {number} rect.height - 高度
       * @param {Object} [options] - 识别选项
       * @param {string} [options.language='chi_sim'] - 识别语言
       * @returns {Promise<{text: string, blocks: Array}>}
       */
      async fromScreen(rect, options = {}) {
        const { language = 'chi_sim' } = options

        try {
          // 调用 screen.capture 获取截图
          if (!window.ztools || !window.ztools.screen) {
            throw new Error('Screen API 不可用')
          }

          const base64Image = await window.ztools.screen.capture(rect)
          return await this._callOCRServer(base64Image, language)
        } catch (error) {
          throw new Error(`屏幕截图失败: ${error.message}`)
        }
      }

      /**
       * 从文件识别
       * @param {string} filePath - 图片文件路径
       * @param {Object} [options] - 识别选项
       * @param {string} [options.language='chi_sim'] - 识别语言
       * @returns {Promise<{text: string, blocks: Array}>}
       */
      async fromFile(filePath, options = {}) {
        const { language = 'chi_sim' } = options

        try {
          // 读取文件并转换为 Base64
          if (!window.ztools || !window.ztools.fs) {
            throw new Error('FileSystem API 不可用')
          }

          const binaryData = await window.ztools.fs.readFileAsBinary(filePath)
          const base64Image = this._arrayBufferToBase64(binaryData)

          return await this._callOCRServer(base64Image, language)
        } catch (error) {
          throw new Error(`读取文件失败: ${error.message}`)
        }
      }

      /**
       * Blob 转 Base64（内部方法）
       * @private
       */
      async _blobToBase64(blob) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onloadend = () => {
            // 移除 data URL 前缀，只保留 Base64 部分
            const base64 = reader.result.split(',')[1]
            resolve(base64)
          }
          reader.onerror = reject
          reader.readAsDataURL(blob)
        })
      }

      /**
       * ArrayBuffer/Uint8Array 转 Base64（内部方法）
       * @private
       */
      _arrayBufferToBase64(buffer) {
        let binary = ''
        const bytes = new Uint8Array(buffer)
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i])
        }
        return btoa(binary)
      }

      // ==================== 表格识别接口 ====================

      /**
       * 调用表格识别 API（内部方法）
       * @private
       * @param {string} base64Image - Base64编码的图片
       * @param {string} language - 识别语言
       * @returns {Promise<{table: Array<Array<string>>}>}
       */
      async _callTableOCRServer(base64Image, language) {
        try {
          const tableUrl = 'http://localhost:8001/api/services/ocr/recognize-table'
          const response = await fetch(tableUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              image: base64Image,
              language: language
            })
          })

          if (!response.ok) {
            throw new Error(
              `表格识别 API 请求失败: ${response.status} ${response.statusText}`
            )
          }

          const result = await response.json()

          // 返回标准格式
          return {
            table: result.table || [],
            text: result.text || '',
            blocks: result.blocks || []
          }
        } catch (error) {
          console.error('[OCR Table] API 调用失败:', error)
          throw new Error(`表格识别失败: ${error.message}`)
        }
      }

      /**
       * 从图片识别表格
       * @param {string} imageData - Base64编码的图片 或 图片URL
       * @param {Object} [options] - 识别选项
       * @param {string} [options.language='chi_sim'] - 识别语言
       * @returns {Promise<{table: Array<Array<string>>, text: string, blocks: Array}>}
       */
      async fromImageTable(imageData, options = {}) {
        const { language = 'chi_sim' } = options
        let base64Image = imageData

        // 判断是否为 URL
        if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
          try {
            const response = await fetch(imageData)
            if (!response.ok) {
              throw new Error(`下载图片失败: ${response.status}`)
            }
            const blob = await response.blob()
            base64Image = await this._blobToBase64(blob)
          } catch (error) {
            throw new Error(`下载图片失败: ${error.message}`)
          }
        }

        return await this._callTableOCRServer(base64Image, language)
      }

      /**
       * 从屏幕区域识别表格
       * @param {Object} rect - 屏幕区域
       * @param {number} rect.x - X坐标
       * @param {number} rect.y - Y坐标
       * @param {number} rect.width - 宽度
       * @param {number} rect.height - 高度
       * @param {Object} [options] - 识别选项
       * @param {string} [options.language='chi_sim'] - 识别语言
       * @returns {Promise<{table: Array<Array<string>>, text: string, blocks: Array}>}
       */
      async fromScreenTable(rect, options = {}) {
        const { language = 'chi_sim' } = options

        try {
          if (!window.ztools || !window.ztools.screen) {
            throw new Error('Screen API 不可用')
          }

          const base64Image = await window.ztools.screen.capture(rect)
          return await this._callTableOCRServer(base64Image, language)
        } catch (error) {
          throw new Error(`屏幕截图失败: ${error.message}`)
        }
      }

      /**
       * 从文件识别表格
       * @param {string} filePath - 图片文件路径
       * @param {Object} [options] - 识别选项
       * @param {string} [options.language='chi_sim'] - 识别语言
       * @returns {Promise<{table: Array<Array<string>>, text: string, blocks: Array}>}
       */
      async fromFileTable(filePath, options = {}) {
        const { language = 'chi_sim' } = options

        try {
          if (!window.ztools || !window.ztools.fs) {
            throw new Error('FileSystem API 不可用')
          }

          const binaryData = await window.ztools.fs.readFileAsBinary(filePath)
          const base64Image = this._arrayBufferToBase64(binaryData)

          return await this._callTableOCRServer(base64Image, language)
        } catch (error) {
          throw new Error(`读取文件失败: ${error.message}`)
        }
      }

      // ==================== 公式识别接口 ====================

      /**
       * 调用公式识别 API（内部方法）
       * @private
       * @param {string} base64Image - Base64编码的图片
       * @returns {Promise<{latex: string, confidence: number}>}
       */
      async _callFormulaOCRServer(base64Image) {
        try {
          const formulaUrl =
            'http://localhost:8001/api/services/ocr/recognize-formula'
          const response = await fetch(formulaUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              image: base64Image
            })
          })

          if (!response.ok) {
            throw new Error(
              `公式识别 API 请求失败: ${response.status} ${response.statusText}`
            )
          }

          const result = await response.json()

          // 返回标准格式
          return {
            latex: result.latex || '',
            confidence: result.confidence || 0,
            raw: result.raw || ''
          }
        } catch (error) {
          console.error('[OCR Formula] API 调用失败:', error)
          throw new Error(`公式识别失败: ${error.message}`)
        }
      }

      /**
       * 从图片识别公式
       * @param {string} imageData - Base64编码的图片 或 图片URL
       * @param {Object} [options] - 识别选项（公式识别暂不支持语言选项）
       * @returns {Promise<{latex: string, confidence: number, raw: string}>}
       */
      async fromImageFormula(imageData, options = {}) {
        let base64Image = imageData

        // 判断是否为 URL
        if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
          try {
            const response = await fetch(imageData)
            if (!response.ok) {
              throw new Error(`下载图片失败: ${response.status}`)
            }
            const blob = await response.blob()
            base64Image = await this._blobToBase64(blob)
          } catch (error) {
            throw new Error(`下载图片失败: ${error.message}`)
          }
        }

        return await this._callFormulaOCRServer(base64Image)
      }

      /**
       * 从屏幕区域识别公式
       * @param {Object} rect - 屏幕区域
       * @param {number} rect.x - X坐标
       * @param {number} rect.y - Y坐标
       * @param {number} rect.width - 宽度
       * @param {number} rect.height - 高度
       * @param {Object} [options] - 识别选项
       * @returns {Promise<{latex: string, confidence: number, raw: string}>}
       */
      async fromScreenFormula(rect, options = {}) {
        try {
          if (!window.ztools || !window.ztools.screen) {
            throw new Error('Screen API 不可用')
          }

          const base64Image = await window.ztools.screen.capture(rect)
          return await this._callFormulaOCRServer(base64Image)
        } catch (error) {
          throw new Error(`屏幕截图失败: ${error.message}`)
        }
      }

      /**
       * 从文件识别公式
       * @param {string} filePath - 图片文件路径
       * @param {Object} [options] - 识别选项
       * @returns {Promise<{latex: string, confidence: number, raw: string}>}
       */
      async fromFileFormula(filePath, options = {}) {
        try {
          if (!window.ztools || !window.ztools.fs) {
            throw new Error('FileSystem API 不可用')
          }

          const binaryData = await window.ztools.fs.readFileAsBinary(filePath)
          const base64Image = this._arrayBufferToBase64(binaryData)

          return await this._callFormulaOCRServer(base64Image)
        } catch (error) {
          throw new Error(`读取文件失败: ${error.message}`)
        }
      }
    }

    // 导出类(不导出单例,由client.js实例化)

    // ========================================
    // api/trigger.js
    // ========================================

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

    // ========================================
    // api/privileged.js
    // ========================================

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

    // ========================================
    // api/update.js
    // ========================================

    /**
     * Update API - 软件更新
     * 提供应用和插件更新功能
     */
    class UpdateAPI {
      constructor(transport) {
        this.transport = transport
      }

      /**
       * 检查更新
       * @param {string} source - 检查来源：startup | manual
       * @returns {Promise<object>}
       */
      async check(source = 'manual') {
        const normalizedSource = source === 'startup' ? 'startup' : 'manual'
        const r = await this.transport.call('update_check', { source: normalizedSource })
        // 严格协议：只接受扁平结构 { success, app, web }
        if (!r || typeof r !== 'object' || !('success' in r)) {
          throw new Error('Invalid update_check response: missing success')
        }
        return {
          success: r.success === true,
          app: r.app ?? null,
          web: r.web ?? null
        }
      }

      /**
       * 下载并安装应用更新。
       * 下载完成后再把已校验的包交给外部安装器，避免把“下载成功”误报为“已安装”。
       * @param {object} info - 更新信息 { version, downloadUrl, checksum }
       * @returns {Promise<object>}
       */
      async downloadAndInstall(info) {
        const packageInfo = {
          type: 'app',
          version: info.version,
          downloadUrl: info.downloadUrl,
          checksum: info.checksum,
          fileSize: info.fileSize || 0
        }
        const downloaded = await this.transport.call('update_download_start', packageInfo)
        if (!downloaded || downloaded.success !== true) return downloaded || { success: false }
        const installed = await this.transport.call('update_install_start', packageInfo, { timeout: Infinity })
        return installed || { success: false }
      }

      /**
       * 取消尚未交给安装器的更新下载。
       * @returns {Promise<object>}
       */
      async cancel() {
        return (await this.transport.call('update_cancel', {})) || { success: false }
      }

      /**
       * 下载应用更新
       * @param {object} info - 更新信息
       * @returns {Promise<boolean>}
       */
      async downloadApp(info) {
        const r = await this.transport.call('update_download_start', {
          type: 'app',
          ...info
        })
        return r && r.success === true
      }

      /**
       * 下载插件更新
       * @param {string} id - 插件ID
       * @param {object} info - 更新信息（来自 batchCheckPlugins / checkPluginUpdate）
       * @returns {Promise<boolean>}
       */
      async downloadPlugin(id, info) {
        // 后端返回 download_url，Delphi 端读取 url，需要做字段映射
        const url = info.download_url || info.downloadUrl || info.url || ''
        const r = await this.transport.call('plugin_update', {
          pluginId: id,
          url,
          version: info.version || '',
          checksum: info.checksum || '',
          fileSize: info.fileSize || info.file_size || 0
        })
        return r && r.success === true
      }
    }

    // ========================================
    // api/image.js
    // ========================================

    /**
     * Image API - 图片处理
     * 通过 ImagePlugin DLL 插件实现（基于 Image32 库）
     * 所有图片处理函数均通过异步调用执行，不阻塞 CEF 主线程
     */
    class ImageAPI {
      constructor(transport) {
        this.transport = transport
      }

      /**
       * 异步调用 DLL 插件函数（内部方法）
       * 通过 callAsync + waitTask 实现非阻塞调用，避免大图处理时冻结 UI
       * @private
       * @param {string} funcName - DLL 函数名
       * @param {Object} params - 函数参数
       * @param {number} [pollInterval=200] - 轮询间隔（ms）
       * @returns {Promise<Object>} DLL 返回的 JSON 结果
       */
      async _callAsync(funcName, params, pollInterval = 200) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          const api = this._referenceAPI ??= new ReferenceImageAPI(this.transport)
          switch (funcName) {
            case 'ImageToBase64':
              if (params.format !== undefined) throw Object.assign(new Error('引用编码保留原始PNG/JPEG格式'), { code: 'INVALID_REQUEST' })
              return { result: await api.imageToBase64(params.input) }
            case 'Base64ToImage': await api.base64ToImage(params.input, params.output, params.format); break
            case 'GetInfo': return { result: await api.getInfo(params.path) }
            case 'Convert': await api.convert(params.input, params.output, params.format, params.quality ?? 85); break
            case 'Resize': await api.resize(params.input, params.output, params.width, params.height,
              { keepAspectRatio: params.keepAspectRatio, ...(params.quality !== undefined ? { quality: params.quality } : {}) }); break
            case 'Scale': await api.scale(params.input, params.output, params.scaleX / 100, params.scaleY / 100); break
            case 'Crop': await api.crop(params.input, params.output, { x: params.x, y: params.y, width: params.width, height: params.height }); break
            case 'Rotate': await api.rotate(params.input, params.output, params.angle); break
            case 'Flip': await api.flip(params.input, params.output, params.direction); break
            case 'Compress': await api.compress(params.input, params.output, params.quality); break
            default: {
              const error = new Error('此图片方法的跨平台provider尚未实现')
              error.code = 'METHOD_NOT_FOUND'
              throw error
            }
          }
          return { result: true }
        }
        const dllplugin = window.ztools.dllplugin
        const taskId = await dllplugin.callAsync('ImagePlugin', funcName, params)
        let terminalObserved = false
        try {
          const result = await dllplugin.waitTask(taskId, pollInterval, 30_000)
          terminalObserved = true
          return result
        } catch (error) {
          terminalObserved = error?.taskDone === true || error?.workNotStarted === true
          throw error
        } finally {
          if (terminalObserved) {
            try { await dllplugin.clearCallback(taskId, true) }
            catch (error) { console.error('[image] 图片任务清理失败:', error) }
          }
        }
      }

      /** Contract 2 effect preview writes to private cache and returns a read-only FileRef. */
      async preview(input, operation, params = {}, options = {}) {
        if (window.__ztoolsElectron?.contractVersion !== 2) throw Object.assign(new Error('当前宿主尚未开放引用预览'), { code: 'NOT_SUPPORTED' })
        return (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).preview(input, operation, params, options)
      }

      _unwrapResult(response, operation = '图片处理') {
        if (response == null) {
          throw new Error(`${operation}返回空结果`)
        }
        if (response.error) {
          throw new Error(response.error)
        }
        return response.result !== undefined ? response.result : response
      }

      _isTrueResult(response, operation = '图片处理') {
        const value = this._unwrapResult(response, operation)
        return value === true || value === 'true'
      }

      /**
       * 格式转换
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {string} format - 目标格式 ('png'|'jpg'|'bmp'|'gif'|'webp')
       * @param {number} [quality] - 输出质量 (1-100，可选，默认85)
       * @returns {Promise<boolean>}
       */
      async convert(input, output, format, quality, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).convert(input, output, format, quality ?? 85, options)
          return true
        }
        if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
        const result = await this._callAsync('Convert', {
          input,
          output,
          format,
          quality
        })
        return this._isTrueResult(result, '图片格式转换')
      }

      /**
       * 固定尺寸缩放
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {number} width - 目标宽度
       * @param {number} height - 目标高度
       * @param {Object} options - 缩放选项
       * @param {boolean} [options.keepAspectRatio=true] - 保持宽高比
       * @param {number} [options.quality] - JPEG 输出质量 (1-100)，不传则使用默认值
       * @returns {Promise<boolean>}
       */
      async resize(input, output, width, height, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          const api = this._referenceAPI ??= new ReferenceImageAPI(this.transport)
          api._options(options, ['format', 'replace', 'quality', 'keepAspectRatio', 'signal'])
          if (width === 0 && Number.isSafeInteger(height) && height > 0 || height === 0 && Number.isSafeInteger(width) && width > 0) {
            const info = await api.getInfo(input, { ...(options.signal ? { signal: options.signal } : {}) })
            if (width === 0) width = Math.max(1, Math.round(info.width * height / info.height))
            else height = Math.max(1, Math.round(info.height * width / info.width))
          }
          await api.resize(input, output, width, height, options)
          return true
        }
        if (Object.keys(options).some(key => !['keepAspectRatio', 'quality'].includes(key))) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
        const params = {
          input,
          output,
          width,
          height,
          keepAspectRatio: options.keepAspectRatio !== false
        }
        // 透传 quality 参数给 DLL，用于控制 JPEG 输出质量
        if (options.quality != null) {
          params.quality = options.quality
        }
        const result = await this._callAsync('Resize', params)
        return this._isTrueResult(result, '图片缩放')
      }

      /**
       * 按百分比缩放
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {number} scaleX - 水平缩放比例 (0.1-5.0)
       * @param {number} scaleY - 垂直缩放比例 (0.1-5.0)
       * @returns {Promise<boolean>}
       */
      async scale(input, output, scaleX, scaleY = scaleX, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).scale(input, output, scaleX, scaleY, options)
          return true
        }
        if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
        const result = await this._callAsync('Scale', {
          input,
          output,
          scaleX: scaleX * 100, // 转换为百分比
          scaleY: scaleY * 100
        })
        return this._isTrueResult(result, '图片按比例缩放')
      }

      /**
       * 自由裁剪
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {Object} rect - 裁剪区域 {x, y, width, height}
       * @returns {Promise<boolean>}
       */
      async crop(input, output, rect, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).crop(input, output, rect, options)
          return true
        }
        if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
        const result = await this._callAsync('Crop', {
          input,
          output,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height
        })
        return this._isTrueResult(result, '图片裁剪')
      }

      /**
       * 旋转图片
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {number} angle - 旋转角度 (90, 180, 270 或任意角度)
       * @returns {Promise<boolean>}
       */
      async rotate(input, output, angle, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).rotate(input, output, angle, options)
          return true
        }
        if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
        const result = await this._callAsync('Rotate', {
          input,
          output,
          angle
        })
        return this._isTrueResult(result, '图片旋转')
      }

      /**
       * 翻转图片
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {string} direction - 翻转方向 ('horizontal'|'vertical')
       * @returns {Promise<boolean>}
       */
      async flip(input, output, direction = 'horizontal', options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).flip(input, output, direction, options)
          return true
        }
        if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
        const result = await this._callAsync('Flip', {
          input,
          output,
          direction
        })
        return this._isTrueResult(result, '图片翻转')
      }

      /**
       * 压缩图片（仅JPG格式支持质量压缩）
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {number} quality - 质量 (0-100，仅对JPG有效)
       * @returns {Promise<boolean>}
       */
      async compress(input, output, quality = 85, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).compress(input, output, quality, options)
          return true
        }
        if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
        const result = await this._callAsync('Compress', {
            input,
            output,
            quality
          }
        )
        return this._isTrueResult(result, '图片压缩')
      }

      /**
       * PNG无损压缩
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {number} compressionLevel - 压缩级别 (0-9，默认6)
       * @param {boolean} preserveAlpha - 是否保留透明通道 (默认true)
       * @returns {Promise<boolean>}
       */
      async compressPNG(input, output, compressionLevel = 6, preserveAlpha = true) {
        const result = await this._callAsync('CompressPNG', {
            input,
            output,
            compressionLevel,
            preserveAlpha
          }
        )
        return this._isTrueResult(result, 'PNG 压缩')
      }

      /**
       * PNG有损压缩 (使用pngquant算法)
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {number} quality - 质量 (0-100，100为无损，推荐65-80)
       * @returns {Promise<boolean>}
       */
      async compressPNGLossy(input, output, quality = 80) {
        const result = await this._callAsync('CompressPNGLossy', {
            input,
            output,
            quality
          }
        )
        return this._isTrueResult(result, 'PNG 有损压缩')
      }

      /**
       * 添加图片水印
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {string} watermark - 水印图片路径
       * @param {Object} options - 水印选项
       * @param {string} [options.position='center'] - 位置 ('center'|'top-left'|'top-right'|'bottom-left'|'bottom-right')
       * @param {number} [options.opacity=255] - 透明度 (0-255)
       * @returns {Promise<boolean>}
       */
      async watermark(input, output, watermark, options = {}) {
        const result = await this._callAsync('Watermark', {
            input,
            output,
            watermark,
            position: options.position || 'center',
            opacity: Math.round((options.opacity ?? 1.0) * 255) // 转换为0-255范围
          }
        )
        return this._isTrueResult(result, '图片水印')
      }

      /**
       * 添加文字标注
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {string} text - 文字内容
       * @param {Object} options - 文字选项
       * @param {number} [options.x=10] - X坐标
       * @param {number} [options.y=10] - Y坐标
       * @param {string} [options.fontName='Arial'] - 字体名称
       * @param {number} [options.fontSize=24] - 字体大小
       * @param {string|number} [options.color='#000000'] - 文字颜色
       * @returns {Promise<boolean>}
       */
      async textOut(input, output, text, options = {}) {
        // TextOut 使用 Delphi TColor（BGR 格式），需要将 RGB 转为 BGR
        const rgbColor = this._colorToInt(options.color || '#000000')
        const r = (rgbColor >> 16) & 0xff
        const g = (rgbColor >> 8) & 0xff
        const b = rgbColor & 0xff
        const bgrColor = (b << 16) | (g << 8) | r

        const result = await this._callAsync('TextOut', {
            input,
            output,
            text,
            x: options.x || 10,
            y: options.y || 10,
            fontName: options.fontName || 'Arial',
            fontSize: options.fontSize || 24,
            color: bgrColor
          }
        )
        return this._isTrueResult(result, '图片文字标注')
      }

      /**
       * 图像拼接
       * @param {string[]} images - 要拼接的图片路径数组
       * @param {string} output - 输出文件路径
       * @param {string} direction - 拼接方向 ('horizontal'|'vertical')
       * @returns {Promise<boolean>}
       */
      async concat(images, output, direction = 'horizontal') {
        const result = await this._callAsync('Concat', {
          images: images.join(','),
          output,
          direction
        })
        return this._isTrueResult(result, '图片拼接')
      }

      /**
       * 添加边框
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {Object} options - 边框选项
       * @param {number} [options.borderWidth=10] - 边框宽度(px)
       * @param {number} [options.padding=5] - 内边距(px)
       * @param {string|number} [options.borderColor='#000000'] - 边框颜色
       * @param {string|number} [options.backgroundColor='#ffffff'] - 背景颜色
       * @param {number} [options.opacity=1.0] - 边框不透明度(0-1)
       * @returns {Promise<boolean>}
       */
      async addBorder(input, output, options = {}) {
        const result = await this._callAsync('AddBorder', {
            input,
            output,
            borderWidth: options.borderWidth ?? 10,
            padding: options.padding ?? 5,
            borderColor: this._colorToInt(options.borderColor ?? '#000000'),
            backgroundColor: this._colorToInt(options.backgroundColor ?? '#ffffff'),
            opacity: Math.round((options.opacity ?? 1.0) * 255)
          }
        )
        return this._isTrueResult(result, '图片边框')
      }

      /**
       * 设置圆角
       * @param {string} input - 输入文件路径
       * @param {string} output - 输出文件路径
       * @param {Object} options - 圆角选项
       * @param {number} [options.radius=20] - 统一圆角半径(px)
       * @param {number} [options.radiusLT] - 左上角圆角半径(px)
       * @param {number} [options.radiusRT] - 右上角圆角半径(px)
       * @param {number} [options.radiusLB] - 左下角圆角半径(px)
       * @param {number} [options.radiusRB] - 右下角圆角半径(px)
       * @param {string|number} [options.backgroundColor='#ffffff'] - 背景颜色
       * @returns {Promise<boolean>}
       */
      async roundCorners(input, output, options = {}) {
        const result = await this._callAsync('RoundCorners', {
            input,
            output,
            radius: options.radius ?? 20,
            radiusLT: options.radiusLT ?? -1,
            radiusRT: options.radiusRT ?? -1,
            radiusLB: options.radiusLB ?? -1,
            radiusRB: options.radiusRB ?? -1,
            backgroundColor: this._colorToInt(options.backgroundColor ?? '#ffffff')
          }
        )
        return this._isTrueResult(result, '图片圆角')
      }

      /**
       * 图片转PDF
       * @param {string[]} images - 要转换的图片路径数组（顺序即PDF页顺序）
       * @param {string} output - 输出PDF文件路径
       * @returns {Promise<boolean>}
       */
      async previewGIF(images, options = {}) {
        if (window.__ztoolsElectron?.contractVersion !== 2) throw Object.assign(new Error('GIF预览需要引用图片处理器'), { code: 'NOT_SUPPORTED' })
        return (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).previewGIF(images, options)
      }
      async imagesToGIF(images, output, options = {}) {
        if (window.__ztoolsElectron?.contractVersion !== 2) throw Object.assign(new Error('真实GIF编码需要引用图片处理器'), { code: 'NOT_SUPPORTED' })
        await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).imagesToGIF(images, output, options)
        return true
      }

      async imagesToPDF(images, output, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) { await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).imagesToPDF(images, output, options); return true }
        if (Object.keys(options).length) { const error = new Error('当前图片桥不支持新增PDF请求选项'); error.code = 'NOT_SUPPORTED'; throw error }
        const result = await this._callAsync('ImagesToPDF', {
            images: images.join(','),
            output
          }
        )
        return this._isTrueResult(result, '图片转 PDF')
      }

      /**
       * 生成二维码
       * @param {string} text - 要编码的文本内容
       * @param {string} output - 输出图片路径
       * @param {Object} options - 生成选项
       * @param {number} [options.size=256] - 二维码尺寸 (像素)
       * @returns {Promise<boolean>}
       */
      async generateQR(text, output, options = {}) {
        const result = await this._callAsync('GenerateQR', {
            text,
            output,
            size: options.size || 256
          }
        )
        return this._isTrueResult(result, '二维码生成')
      }

      /**
       * 解码二维码
       * @param {string} input - 包含二维码的图片路径
       * @returns {Promise<string>} 解码结果文本
       */
      async decodeQR(input) {
        const result = await this._callAsync('DecodeQR', {
            input
          }
        )
        return this._unwrapResult(result, '二维码解码')
      }

      /**
       * SVG转PNG
       * @param {string} input - 输入SVG文件路径
       * @param {string} output - 输出PNG文件路径
       * @param {number} width - 目标宽度
       * @param {number} height - 目标高度
       * @param {boolean} [keepAspectRatio=true] - 保持宽高比
       * @returns {Promise<boolean>}
       */
      async svgToPng(input, output, width, height, keepAspectRatio = true) {
        const result = await this._callAsync('SvgToPng', {
            input,
            output,
            width,
            height,
            keepAspectRatio
          }
        )
        return this._isTrueResult(result, 'SVG 转 PNG')
      }

      /**
       * 获取图片信息
       * @param {string} path - 图片路径
       * @returns {Promise<Object>} {width, height, format, size}
       */
      async getInfo(path, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) return (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).getInfo(path, options)
        if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
        const result = await this._callAsync('GetInfo', {
            path
          }
        )
        return this._unwrapResult(result, '获取图片信息')
      }

      /**
       * 读取图片为 Data URL（用于前端显示）
       * ⚠️ 推荐使用 ztools.protocol.readFileAsDataURL() 代替，性能更好
       * @deprecated 使用 ztools.protocol.readFileAsDataURL(path) 代替
       * @param {string} path - 图片路径
       * @returns {Promise<string>} Data URL
       */
      async readAsDataURL(path) {
        try {
          // 新方案：使用 ztools:// 协议，性能提升3-10倍
          if (window.ztools && window.ztools.protocol) {
            return await window.ztools.protocol.readFileAsDataURL(path)
          }

          // 向后兼容：旧方案（Base64传输）
          const binaryData = await window.ztools.fs.readFileAsBinary(path)
          const mimeType = await this._getMimeType(path)
          const uint8Array = new Uint8Array(binaryData)
          const btoaData = uint8Array.reduce(
            (acc, i) => (acc += String.fromCharCode.apply(null, [i])),
            ''
          )
          const base64 = btoa(btoaData)
          return `data:${mimeType};base64,${base64}`
        } catch (error) {
          console.error('[image.readAsDataURL] 读取图片失败:', error)
          throw error
        }
      }

      /**
       * 读取图片为 Blob（用于前端处理）
       * ⚠️ 推荐使用 ztools.protocol.readFileAsBlob() 代替，性能更好
       * @deprecated 使用 ztools.protocol.readFileAsBlob(path) 代替
       * @param {string} path - 图片路径
       * @returns {Promise<Blob>} Blob 对象
       */
      async readAsBlob(path) {
        try {
          // 新方案：使用 ztools:// 协议，性能提升3-10倍
          if (window.ztools && window.ztools.protocol) {
            return await window.ztools.protocol.readFileAsBlob(path)
          }

          // 向后兼容：旧方案（Base64传输）
          console.log('[image.readAsBlob] 开始读取:', path)
          const binaryData = await window.ztools.fs.readFileAsBinary(path)
          console.log('[image.readAsBlob] 读取完成，二进制长度:', binaryData.length)

          const mimeType = await this._getMimeType(path)
          console.log('[image.readAsBlob] MIME类型:', mimeType)

          console.log('[image.readAsBlob] 开始创建Blob...')
          const blob = new Blob([binaryData], { type: mimeType })
          console.log('[image.readAsBlob] Blob创建成功，大小:', blob.size)

          return blob
        } catch (error) {
          console.error('[image.readAsBlob] 读取图片失败:', error)
          throw error
        }
      }

      /**
       * 读取大图片为 Blob（支持进度回调）
       * 推荐用于大文件读取，可以实时显示加载进度
       *
       * @param {string} path - 图片路径
       * @param {Function} [onProgress] - 进度回调函数 (loaded, total) => void
       * @returns {Promise<Blob>} Blob 对象
       *
       * @example
       * const blob = await ztools.image.readAsBlobWithProgress(
       *   'C:/large-photo.jpg',
       *   (loaded, total) => {
       *     const percent = (loaded / total * 100).toFixed(2)
       *     console.log(`加载进度: ${percent}%`)
       *     updateProgressBar(percent)
       *   }
       * )
       * const url = URL.createObjectURL(blob)
       * document.querySelector('img').src = url
       */
      async readAsBlobWithProgress(path, onProgress) {
        try {
          // 使用 ztools:// 协议的进度读取
          if (window.ztools && window.ztools.protocol) {
            return await window.ztools.protocol.readFileAsBlobWithProgress(
              path,
              onProgress
            )
          }

          // 降级：使用旧方案（无进度支持）
          console.warn(
            '[image.readAsBlobWithProgress] ztools.protocol 不可用，降级为无进度读取'
          )
          return await this.readAsBlob(path)
        } catch (error) {
          console.error('[image.readAsBlobWithProgress] 读取图片失败:', error)
          throw error
        }
      }

      /**
       * 读取大图片为 Data URL（支持进度回调）
       * ⚠️ 注意：Data URL 会将文件编码为 Base64，大文件不推荐使用
       *
       * @param {string} path - 图片路径
       * @param {Function} [onProgress] - 进度回调函数 (loaded, total) => void
       * @returns {Promise<string>} Data URL
       *
       * @example
       * const dataUrl = await ztools.image.readAsDataURLWithProgress(
       *   'C:/large-photo.jpg',
       *   (loaded, total) => {
       *     const percent = Math.round(loaded / total * 100)
       *     progressElement.textContent = `${percent}%`
       *   }
       * )
       * document.querySelector('img').src = dataUrl
       */
      async readAsDataURLWithProgress(path, onProgress) {
        try {
          // 使用 ztools:// 协议的进度读取
          if (window.ztools && window.ztools.protocol) {
            return await window.ztools.protocol.readFileAsDataURLWithProgress(
              path,
              onProgress
            )
          }

          // 降级：使用旧方案（无进度支持）
          console.warn(
            '[image.readAsDataURLWithProgress] ztools.protocol 不可用，降级为无进度读取'
          )
          return await this.readAsDataURL(path)
        } catch (error) {
          console.error('[image.readAsDataURLWithProgress] 读取图片失败:', error)
          throw error
        }
      }

      /**
       * 图片转BASE64（已改为返回文件路径，避免通过CEF传递Base64数据）
       * ⚠️ 新方案：返回文件路径，前端使用 ztools.protocol.fileUrl() 获取图片URL
       *
       * @param {string} input - 输入文件路径
       * @param {string} [format] - 输出格式 ('png'|'jpg'|'bmp'|'gif')，不指定则从文件扩展名推断
       * @returns {Promise<Object>} {filePath, mimeType}
       *
       * @example
       * // 获取图片路径信息
       * const { filePath, mimeType } = await ztools.image.imageToBase64('C:/photo.jpg')
       * // 方式1: 使用 ztools:// 协议（推荐，高性能）
       * const imgUrl = ztools.protocol.fileUrl(filePath)
       * document.querySelector('img').src = imgUrl
       * // 方式2: 读取为 Data URL
       * const dataUrl = await ztools.protocol.readFileAsDataURL(filePath)
       * document.querySelector('img').src = dataUrl
       */
      async imageToBase64(input, format, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          if (format !== undefined) throw Object.assign(new Error('引用编码保留原始PNG/JPEG格式'), { code: 'INVALID_REQUEST' })
          return (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).imageToBase64(input, options)
        }
        if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
        const result = await this._callAsync('ImageToBase64', {
            input,
            format
          }
        )
        const payload = this._unwrapResult(result, '图片转 Base64')

        // 新方案：返回 {filePath, mimeType}
        const data = typeof payload === 'string' ? JSON.parse(payload) : payload

        // 检查返回格式，向后兼容旧版本
        if (data.filePath) {
          // 新版本：返回文件路径
          return data
        } else if (data.base64) {
          // 旧版本：返回 Base64（不推荐）
          console.warn(
            '[image.imageToBase64] 检测到旧版本返回格式，建议升级 ImagePlugin'
          )
          return data
        }

        return data
      }

      /**
       * BASE64转图片（已改为文件路径转图片，避免通过CEF传递Base64数据）
       * ⚠️ 新方案：接收输入文件路径和输出文件路径
       *
       * @param {string} input - 输入文件路径（新方案）或 BASE64字符串（旧方案，向后兼容）
       * @param {string} output - 输出文件路径
       * @param {string} [format] - 输出格式 ('png'|'jpg'|'bmp'|'gif')，不指定则从文件扩展名推断
       * @returns {Promise<boolean>}
       *
       * @example
       * // 新方案：文件路径转换（推荐）
       * await ztools.image.base64ToImage('C:/input.png', 'C:/output.jpg', 'jpg')
       *
       * // 旧方案：如果前端有 Base64 字符串，需要先保存为临时文件
       * const tempFile = await ztools.sys.getPath('temp') + '/temp_' + Date.now() + '.png'
       * // 先将 Base64 写入临时文件（使用 fs API）
       * await ztools.fs.writeFile(tempFile, base64Data, { encoding: 'base64' })
       * // 再调用此函数转换格式
       * await ztools.image.base64ToImage(tempFile, output, format)
       */
      async base64ToImage(input, output, format, options = {}) {
        if (window.__ztoolsElectron?.contractVersion === 2) {
          await (this._referenceAPI ??= new ReferenceImageAPI(this.transport)).base64ToImage(input, output, format, options)
          return true
        }
        if (Object.keys(options).length) throw Object.assign(new Error('旧图片处理器不支持请求选项'), { code: 'NOT_SUPPORTED' })
        const result = await this._callAsync('Base64ToImage', {
            input, // 新方案：传入文件路径
            output,
            format
          }
        )
        return this._isTrueResult(result, 'Base64 转图片')
      }

      /**
       * 获取文件 MIME 类型（内部方法）
       * @private
       * @param {string} path - 文件路径
       * @returns {Promise<string>} MIME 类型
       */
      async _getMimeType(path) {
        const extension = path.toLowerCase().split('.').pop()
        const mimeTypes = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          bmp: 'image/bmp',
          webp: 'image/webp',
          ico: 'image/x-icon',
          svg: 'image/svg+xml'
        }
        return mimeTypes[extension] || 'application/octet-stream'
      }

      /**
       * 颜色转换为整数（内部方法）
       * @private
       * @param {string|number} color - 颜色值
       * @returns {number} 颜色整数值
       */
      _colorToInt(color) {
        if (typeof color === 'number') {
          return color
        }
        if (typeof color === 'string') {
          if (color.startsWith('#')) {
            // 十六进制颜色
            const hex = color.substring(1)
            return parseInt(hex, 16)
          }
          // 颜色名称映射（简化版）
          const colorMap = {
            black: 0x000000,
            white: 0xffffff,
            red: 0xff0000,
            green: 0x00ff00,
            blue: 0x0000ff,
            yellow: 0xffff00,
            cyan: 0x00ffff,
            magenta: 0xff00ff
          }
          return colorMap[color.toLowerCase()] || 0x000000
        }
        return 0x000000
      }
    }

    // ========================================
    // api/image-reference.js
    // ========================================

    /** Shared Electron PNG/JPEG operations using FileRef/SaveRef; advanced image methods await their provider. */
    class ReferenceImageAPI extends ReferenceFileSystemAPI {
      async previewGIF(images, options = {}) {
        this._options(options, ['signal', 'interval', 'loop'])
        const interval = options.interval ?? 500, loop = options.loop ?? true
        if (!Array.isArray(images) || !images.length || images.length > 64 || !Number.isSafeInteger(interval) || interval < 10 || interval > 10000 || interval % 10 !== 0 || typeof loop !== 'boolean') throw this._error('INVALID_REQUEST', 'GIF预览图片或间隔无效')
        const result = await this._call('image_preview_gif', { fileGrantIds: images.map(input => this._reference(input, ['file'], 'read')), interval, loop }, { signal: options.signal })
        const reference = this._returnedReference(result.reference, ['file'])
        try {
          if (result.frameCount !== images.length || result.fileUrl !== 'ztools://file/' + reference.grantId + '/' + encodeURIComponent(reference.displayName) || !Number.isSafeInteger(result.size) || result.size < 14 || result.size > 16 * 1024 * 1024 || ![result.width, result.height].every(size => Number.isSafeInteger(size) && size > 0 && size <= 1024) || result.width * result.height * images.length > 4 * 1024 * 1024) throw this._error('FILE_ERROR', 'GIF预览响应无效')
          return Object.freeze({ reference: Object.freeze({ ...reference, operations: Object.freeze([...reference.operations]) }), fileUrl: result.fileUrl, size: result.size, frameCount: result.frameCount, width: result.width, height: result.height })
        } catch (error) { await this.revoke(reference); throw error }
      }
      async imagesToGIF(images, output, options = {}) {
        this._options(options, ['replace', 'signal', 'interval', 'loop'])
        const interval = options.interval ?? 500, loop = options.loop ?? true
        if (!Array.isArray(images) || !images.length || images.length > 64 || !Number.isSafeInteger(interval) || interval < 10 || interval > 10000 || interval % 10 !== 0 || typeof loop !== 'boolean' || (options.replace !== undefined && typeof options.replace !== 'boolean')) throw this._error('INVALID_REQUEST', 'GIF输入图片或间隔无效')
        const result = await this._call('image_to_gif', { fileGrantIds: images.map(input => this._reference(input, ['file'], 'read')), saveGrantId: this._reference(output, ['save'], 'write'), interval, loop, replace: options.replace ?? false }, { signal: options.signal })
        if (result.status !== 'committed' || result.frameCount !== images.length || !Number.isSafeInteger(result.size) || result.size < 14 || result.size > 16 * 1024 * 1024 || ![result.width, result.height].every(size => Number.isSafeInteger(size) && size > 0 && size <= 1024) || result.width * result.height * images.length > 4 * 1024 * 1024) throw this._error('FILE_WRITE_OUTCOME_UNKNOWN', 'GIF保存结果未确认')
        return Object.freeze({ status: result.status, size: result.size, frameCount: result.frameCount, width: result.width, height: result.height })
      }
      async imagesToPDF(images, output, options = {}) {
        this._options(options, ['replace', 'signal'])
        if (!Array.isArray(images) || !images.length || images.length > 64 || (options.replace !== undefined && typeof options.replace !== 'boolean')) throw this._error('INVALID_REQUEST', 'PDF输入图片列表无效')
        const result = await this._call('image_to_pdf', { fileGrantIds: images.map(input => this._reference(input, ['file'], 'read')),
          saveGrantId: this._reference(output, ['save'], 'write'), replace: options.replace ?? false }, options)
        if (!result || result.success !== true || result.status !== 'committed' || result.pageCount !== images.length ||
            !Number.isSafeInteger(result.size) || result.size < 8 || result.size > 16 * 1024 * 1024) throw this._error('FILE_WRITE_OUTCOME_UNKNOWN', 'PDF保存结果未确认')
        return Object.freeze({ status: result.status, size: result.size, pageCount: result.pageCount })
      }
      async preview(input, operation, params = {}, options = {}) {
        this._options(options, ['format', 'quality', 'signal'])
        const fields = operation === 'resize' ? ['width', 'height', 'keepAspectRatio'] : operation === 'scale' ? ['scaleX', 'scaleY'] :
          operation === 'crop' ? ['rect'] : operation === 'rotate' ? ['angle'] : operation === 'flip' ? ['direction'] : []
        if (!['convert', 'compress', 'resize', 'scale', 'crop', 'rotate', 'flip'].includes(operation) ||
            !params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !fields.includes(key))) {
          throw this._error('INVALID_REQUEST', '图片预览参数无效')
        }
        const format = options.format ?? 'png'
        if (!['png', 'jpg'].includes(format) || (options.quality !== undefined && (!Number.isSafeInteger(options.quality) || options.quality < 1 || options.quality > 100))) {
          throw this._error('INVALID_REQUEST', '图片预览格式或质量无效')
        }
        const result = await this._call('image_preview', { fileGrantId: this._reference(input, ['file'], 'read'), operation, ...params,
          format, ...(options.quality !== undefined ? { quality: options.quality } : {}) }, options)
        this._imageResult(result)
        this._returnedReference({ ...result.reference, fileUrl: result.fileUrl }, ['file'])
        if (!Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 16 * 1024 * 1024) throw this._error('FILE_ERROR', '图片预览响应无效')
        return Object.freeze({ reference: Object.freeze({ ...result.reference }), fileUrl: result.fileUrl, size: result.size,
          width: result.width, height: result.height, format: result.format })
      }
      async imageToBase64(input, options = {}) {
        this._options(options, ['signal'])
        const result = await this._call('image_encode_base64', { fileGrantId: this._reference(input, ['file'], 'read') }, options)
        this._returnedReference({ ...result.reference, fileUrl: result.fileUrl }, ['file'])
        if (!['image/png', 'image/jpeg'].includes(result.mimeType) || !Number.isSafeInteger(result.size) ||
            result.size <= 0 || result.size > 16 * 1024 * 1024) throw this._error('FILE_ERROR', 'Base64编码响应无效')
        return Object.freeze({ reference: Object.freeze({ ...result.reference }), fileUrl: result.fileUrl, mimeType: result.mimeType, size: result.size })
      }
      async base64ToImage(input, output, format, options = {}) {
        this._options(options, ['quality', 'replace', 'signal'])
        if (options.quality !== undefined && (!Number.isSafeInteger(options.quality) || options.quality < 1 || options.quality > 100)) {
          throw this._error('INVALID_REQUEST', 'JPEG质量须为1到100')
        }
        const result = await this._call('image_decode_base64', { fileGrantId: this._reference(input, ['file'], 'read'),
          saveGrantId: this._reference(output, ['save'], 'write'), format: this._format(output, format),
          replace: options.replace ?? false, ...(options.quality !== undefined ? { quality: options.quality } : {}) }, options)
        this._imageResult(result)
        if (result.status !== 'committed' || !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 16 * 1024 * 1024) {
          throw this._error('FILE_WRITE_OUTCOME_UNKNOWN', '图片保存收据无效，请核实目标文件')
        }
        return Object.freeze({ status: result.status, width: result.width, height: result.height, format: result.format, size: result.size })
      }
      async getInfo(input, options = {}) {
        this._options(options, ['signal'])
        const result = await this._call('image_get_info', { fileGrantId: this._reference(input, ['file'], 'read') }, options)
        this._imageResult(result)
        return Object.freeze({ width: result.width, height: result.height, format: result.format })
      }
      _imageResult(result) {
        if (!Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width <= 0 || result.height <= 0 ||
            result.width > 8192 || result.height > 8192 || result.width * result.height > 8 * 1024 * 1024 || !['png', 'jpg'].includes(result.format)) {
          throw this._error('FILE_ERROR', '图片处理响应无效')
        }
      }
      _format(output, explicit) {
        const format = explicit ?? (/\.jpe?g$/i.test(output?.displayName ?? '') ? 'jpg' : /\.png$/i.test(output?.displayName ?? '') ? 'png' : null)
        if (!['png', 'jpg'].includes(format)) throw this._error('INVALID_REQUEST', '请明确选择PNG或JPEG输出格式')
        return format
      }
      async _transform(operation, input, output, params, options) {
        this._options(options, ['format', 'replace', 'quality', 'keepAspectRatio', 'signal'])
        if (options.quality !== undefined && (!Number.isSafeInteger(options.quality) || options.quality < 1 || options.quality > 100)) {
          throw this._error('INVALID_REQUEST', 'JPEG质量须为1到100')
        }
        const result = await this._call('image_transform', { operation,
          fileGrantId: this._reference(input, ['file'], 'read'), saveGrantId: this._reference(output, ['save'], 'write'),
          format: this._format(output, options.format), replace: options.replace ?? false,
          ...(options.quality !== undefined ? { quality: options.quality } : {}), ...params }, options)
        this._imageResult(result)
        if (result.status !== 'committed' || !Number.isSafeInteger(result.size) || result.size <= 0 || result.size > 16 * 1024 * 1024) {
          throw this._error('FILE_WRITE_OUTCOME_UNKNOWN', '图片保存收据无效，请核实目标文件')
        }
        return Object.freeze({ status: result.status, width: result.width, height: result.height, format: result.format, size: result.size })
      }
      async convert(input, output, format, quality = 85, options = {}) {
        this._options(options, ['replace', 'signal'])
        return this._transform('convert', input, output, {}, { ...options, format, quality })
      }
      async resize(input, output, width, height, options = {}) {
        this._options(options, ['format', 'replace', 'quality', 'keepAspectRatio', 'signal'])
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192 ||
            width * height > 8 * 1024 * 1024 || (options.keepAspectRatio !== undefined && typeof options.keepAspectRatio !== 'boolean')) {
          throw this._error('INVALID_REQUEST', '图片缩放尺寸无效')
        }
        return this._transform('resize', input, output, { width, height, keepAspectRatio: options.keepAspectRatio ?? true }, options)
      }
      async scale(input, output, scaleX, scaleY = scaleX, options = {}) {
        this._options(options, ['format', 'replace', 'quality', 'signal'])
        if ([scaleX, scaleY].some(scale => typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.1 || scale > 5)) {
          throw this._error('INVALID_REQUEST', '图片缩放比例须为0.1到5')
        }
        return this._transform('scale', input, output, { scaleX, scaleY }, options)
      }
      async crop(input, output, rect, options = {}) {
        this._options(options, ['format', 'replace', 'quality', 'signal'])
        if (!rect || typeof rect !== 'object' || Array.isArray(rect) || Object.keys(rect).length !== 4 ||
            Object.keys(rect).some(key => !['x', 'y', 'width', 'height'].includes(key)) ||
            ['x', 'y', 'width', 'height'].some(key => !Number.isSafeInteger(rect[key])) || rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) {
          throw this._error('INVALID_REQUEST', '图片裁剪范围无效')
        }
        return this._transform('crop', input, output, { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }, options)
      }
      async rotate(input, output, angle, options = {}) {
        this._options(options, ['format', 'replace', 'quality', 'signal'])
        if (typeof angle !== 'number' || !Number.isFinite(angle) || Math.abs(angle) > 36000) throw this._error('INVALID_REQUEST', '图片旋转角度无效')
        return this._transform('rotate', input, output, { angle }, options)
      }
      async flip(input, output, direction = 'horizontal', options = {}) {
        this._options(options, ['format', 'replace', 'quality', 'signal'])
        if (!['horizontal', 'vertical'].includes(direction)) throw this._error('INVALID_REQUEST', '图片翻转方向无效')
        return this._transform('flip', input, output, { direction }, options)
      }
      async compress(input, output, quality = 85, options = {}) {
        this._options(options, ['replace', 'signal'])
        return this._transform('compress', input, output, {}, { ...options, format: 'jpg', quality })
      }
    }

    // ========================================
    // api/ffmpeg.js
    // ========================================

    /**
     * FFmpeg API - 音视频处理
     * 通过 FFmpegPlugin DLL 插件实现
     */
    class FFmpegAPI {
      constructor(transport) {
        this.transport = transport
      }

      /**
       * 开始屏幕录制
       * @param {Object} options - 录制选项
       * @param {string} options.type - 录制类型 ('fullscreen'|'window'|'region')
       * @param {string} options.output - 输出文件路径
       * @param {string} [options.windowTitle] - 窗口标题 (type='window'时必需)
       * @param {Object} [options.region] - 录制区域 {x, y, width, height}
       * @param {Object} [options.audio] - 音频配置
       * @param {boolean} [options.audio.system] - 是否录制系统声音
       * @param {boolean} [options.audio.microphone] - 是否录制麦克风
       * @param {string} [options.audio.systemDevice] - 系统音频设备名称
       * @param {string} [options.audio.micDevice] - 麦克风设备名称
       * @param {Object} [options.video] - 视频配置
       * @param {string} [options.video.codec='libx264'] - 编码器
       * @param {string} [options.video.preset='fast'] - 预设
       * @param {number} [options.video.crf=23] - 质量系数
       * @param {number} [options.video.fps=30] - 帧率
       * @param {boolean} [options.video.showMouse=true] - 是否显示鼠标
       * @param {number} [options.duration=0] - 录制时长(秒), 0表示手动停止
       * @returns {Promise<string>} taskId - 任务ID
       */
      async startRecording(options) {
        const result = await window.ztools.dllplugin.callAsync(
          'FFmpegPlugin',
          'StartRecording',
          options
        )
        return result.taskId
      }

      /**
       * 停止屏幕录制
       * @param {string} taskId - 任务ID
       * @param {boolean} [force=false] - 是否强制停止
       * @returns {Promise<Object>} {success, output}
       */
      async stopRecording(taskId, force = false) {
        return await window.ztools.dllplugin.call('FFmpegPlugin', 'StopRecording', {
          taskId,
          force
        })
      }

      /**
       * 获取录制进度
       * @param {string} taskId - 任务ID
       * @returns {Promise<Object>} {status, duration, size, fps}
       */
      async getRecordingProgress(taskId) {
        return await window.ztools.dllplugin.call(
          'FFmpegPlugin',
          'GetRecordingProgress',
          {
            taskId
          }
        )
      }

      /**
       * 列出音频设备
       * @returns {Promise<Object>} {system: string[], microphone: string[]}
       */
      async listAudioDevices() {
        return await window.ztools.dllplugin.call(
          'FFmpegPlugin',
          'ListAudioDevices',
          {}
        )
      }

      /**
       * 屏幕截图
       * @param {Object} options - 截图选项
       * @param {string} options.type - 截图类型 ('fullscreen'|'window'|'region')
       * @param {string} options.output - 输出文件路径
       * @param {string} [options.windowTitle] - 窗口标题
       * @param {Object} [options.region] - 截图区域 {x, y, width, height}
       * @param {string} [options.format='png'] - 图片格式
       * @param {boolean} [options.showMouse=false] - 是否显示鼠标
       * @returns {Promise<Object>} {success, output, width, height}
       */
      async captureScreen(options) {
        return await window.ztools.dllplugin.call(
          'FFmpegPlugin',
          'CaptureScreen',
          options
        )
      }

      /**
       * 音视频格式转换
       * @param {Object} options - 转换选项
       * @param {string} options.input - 输入文件路径
       * @param {string} options.output - 输出文件路径
       * @param {Object} [options.video] - 视频配置
       * @param {Object} [options.audio] - 音频配置
       * @param {Function} [options.onProgress] - 进度回调
       * @returns {Promise<string>} taskId
       */
      async convertMedia(options) {
        const taskId = await window.ztools.dllplugin.callAsync(
          'FFmpegPlugin',
          'ConvertMedia',
          options
        )

        if (options.onProgress) {
          const progressHandler = (event) => {
            if (event.taskId === taskId) {
              options.onProgress(event.percent, event.message)
            }
          }
          window.ztools.dllplugin.on('progress', progressHandler)
        }

        return taskId
      }

      /**
       * 录制音频
       * @param {Object} options - 录制选项
       * @param {string} options.output - 输出文件路径
       * @param {string} options.source - 音频源 ('system'|'microphone'|'both')
       * @param {string} [options.systemDevice] - 系统音频设备名称
       * @param {string} [options.micDevice] - 麦克风设备名称
       * @param {string} [options.format='mp3'] - 音频格式
       * @param {number} [options.bitrate=128] - 音频码率(kbps)
       * @param {number} [options.duration=0] - 录制时长(秒)
       * @returns {Promise<string>} taskId
       */
      async recordAudio(options) {
        const result = await window.ztools.dllplugin.callAsync(
          'FFmpegPlugin',
          'RecordAudio',
          options
        )
        return result.taskId
      }

      /**
       * 从视频提取帧为图片
       * @param {Object} options - 选项
       * @param {string} options.input - 输入视频路径
       * @param {string} options.output - 输出图片路径
       * @param {number|string} options.time - 时间点
       * @param {string} [options.format='png'] - 图片格式
       * @returns {Promise<Object>} {success, output}
       */
      async extractFrame(options) {
        return await window.ztools.dllplugin.call(
          'FFmpegPlugin',
          'ExtractFrame',
          options
        )
      }

      /**
       * 裁剪视频
       * @param {Object} options - 选项
       * @param {string} options.input - 输入视频
       * @param {string} options.output - 输出视频
       * @param {number|string} options.start - 开始时间
       * @param {number|string} [options.end] - 结束时间
       * @param {number} [options.duration] - 持续时长(秒)
       * @returns {Promise<string>} taskId
       */
      async trimVideo(options) {
        const result = await window.ztools.dllplugin.callAsync(
          'FFmpegPlugin',
          'TrimVideo',
          options
        )
        return result.taskId
      }

      /**
       * 合并视频
       * @param {Object} options - 选项
       * @param {string[]} options.inputs - 输入视频列表
       * @param {string} options.output - 输出视频
       * @returns {Promise<string>} taskId
       */
      async mergeVideos(options) {
        const result = await window.ztools.dllplugin.callAsync(
          'FFmpegPlugin',
          'MergeVideos',
          options
        )
        return result.taskId
      }

      /**
       * 生成GIF动图
       * @param {Object} options - 选项
       * @param {string} options.input - 输入视频
       * @param {string} options.output - 输出GIF路径
       * @param {number|string} [options.start] - 开始时间
       * @param {number} [options.duration=5] - 持续时长(秒)
       * @param {number} [options.fps=10] - 帧率
       * @param {string} [options.scale] - 缩放 '800x450'
       * @returns {Promise<string>} taskId
       */
      async createGif(options) {
        const result = await window.ztools.dllplugin.callAsync(
          'FFmpegPlugin',
          'CreateGif',
          options
        )
        return result.taskId
      }

      /**
       * 获取媒体文件信息
       * @param {string} filePath - 文件路径
       * @returns {Promise<Object>} 媒体信息
       */
      async getMediaInfo(filePath) {
        return await window.ztools.dllplugin.call('FFmpegPlugin', 'GetMediaInfo', {
          filePath
        })
      }

      /**
       * 检查FFmpeg是否已安装
       * @returns {Promise<Object>} {installed, version, path}
       */
      async checkFFmpeg() {
        return await window.ztools.dllplugin.call('FFmpegPlugin', 'CheckFFmpeg', {})
      }

      /**
       * 查询任务状态
       * @param {string} taskId - 任务ID
       * @returns {Promise<Object>} 任务信息
       */
      async queryTask(taskId) {
        return await window.ztools.dllplugin.call('FFmpegPlugin', 'QueryTask', {
          taskId
        })
      }

      /**
       * 取消任务
       * @param {string} taskId - 任务ID
       * @param {boolean} [force=false] - 是否强制取消
       * @returns {Promise<Object>} {success}
       */
      async cancelTask(taskId, force = false) {
        return await window.ztools.dllplugin.call('FFmpegPlugin', 'CancelTask', {
          taskId,
          force
        })
      }
    }

    // ========================================
    // api/dllplugin.js
    // ========================================

    /**
     * DLL Plugin API - DLL 插件接口
     * 提供 DLL 插件调用和任务管理功能
     */
    const PROGRESS_EVENT_TYPE = 'dllplugin_progress'
    const CALLBACK_RESULT_EVENT_TYPE = 'dllplugin_callback_result'


    function copyTaskStartMetadata(taskInfo, value) {
      if (value.taskStartResolved === true || value.taskStartResolved === 'not-started' || value.taskStartPending === false) {
        taskInfo.startPending = false
      } else if (value.taskStartPending === true && taskInfo.startPending !== false) taskInfo.startPending = true
      for (const key of ['code', 'taskStartResolved', 'workNotStarted', 'workOutcome', 'noReplay']) {
        if (value[key] !== undefined) taskInfo[key] = value[key]
      }
    }

    function dllTaskFailure(value, message, taskId) {
      const error = new Error(message)
      for (const key of ['code', 'taskStartResolved', 'workNotStarted', 'workOutcome', 'noReplay']) {
        if (value?.[key] !== undefined) error[key] = value[key]
      }
      if (taskId) error.taskId = taskId
      return error
    }

    function taskObservationFailure(taskInfo, taskId, message, code = 'DLL_TASK_OUTCOME_UNKNOWN') {
      return Object.assign(new Error(message), {
        code, taskId, workOutcome: 'unknown', noReplay: true,
        startPending: taskInfo.startPending === true
      })
    }

    // 日志输出
    function dllLog(...args) {
      console.log('[dllplugin]', ...args)
    }

    function dllError(...args) {
      console.error('[dllplugin]', ...args)
    }

    function toNumber(value, fallback = 0) {
      return typeof value === 'number' && !Number.isNaN(value) ? value : fallback
    }

    function normalizeTaskStatus(value) {
      if (typeof value !== 'string') return null
      switch (value.toLowerCase()) {
        case 'invoking':
          return 'invoking'
        case 'progress':
        case 'pending':
        case 'processing':
        case 'running':
          return 'running'
        case 'complete':
        case 'completed':
        case 'done':
        case 'success':
          return 'completed'
        case 'cancelled':
        case 'canceled':
          return 'cancelled'
        case 'error':
        case 'failed':
        case 'failure':
          return 'error'
        default:
          return null
      }
    }

    function isTerminalTaskStatus(status) {
      return status === 'completed' || status === 'cancelled' || status === 'error'
    }

    function getCallbackResultStatus(result, explicitError = null) {
      const isObject = result && typeof result === 'object' && !Array.isArray(result)
      const data = isObject && result.data && typeof result.data === 'object' && !Array.isArray(result.data)
        ? result.data
        : null
      const typeStatus = normalizeTaskStatus(isObject ? result.type : null)
      const status = normalizeTaskStatus(isObject ? result.status : null)
      const nestedStatus = normalizeTaskStatus(data?.status)
      const error = explicitError || (isObject && result.error) || data?.error || null

      if (isObject && Object.hasOwn(result, 'type') && typeStatus === null) return 'unknown'
      if (typeStatus === 'running') {
        return 'running'
      }
      if (typeStatus === 'error') return 'error'
      if (typeStatus === 'cancelled') return 'cancelled'
      if (typeStatus === 'completed') return 'completed'
      if (status === 'error' || nestedStatus === 'error' || error) return 'error'
      if (status === 'cancelled' || nestedStatus === 'cancelled') return 'cancelled'
      if (status === 'completed' || nestedStatus === 'completed') return 'completed'
      if (typeStatus === 'running' || status === 'running' || nestedStatus === 'running') return 'running'

      if (isObject && (
        typeof result.type === 'string' ||
        typeof result.status === 'string' ||
        typeof data?.status === 'string'
      )) return 'unknown'

      // Older DLLs return a result object without a type/status envelope.
      return 'completed'
    }

    function getCallbackProgress(result, fallback = {}) {
      const data = result && typeof result === 'object' && result.data && typeof result.data === 'object'
        ? result.data
        : result
      const directPercent = typeof result?.percent === 'number'
        ? result.percent
        : typeof data?.percent === 'number'
          ? data.percent
          : undefined
      const progress = typeof result?.progress === 'number'
        ? result.progress
        : typeof data?.progress === 'number'
          ? data.progress
          : undefined
      const rawPercent = directPercent ?? progress ?? fallback.percent ?? 0
      const percent = directPercent !== undefined || rawPercent > 1 ? rawPercent : rawPercent * 100
      return {
        percent: Math.max(0, Math.min(100, percent)),
        current: toNumber(data?.current, toNumber(data?.currentIndex, fallback.current || 0)),
        total: toNumber(data?.total, toNumber(data?.totalFiles, fallback.total || 0)),
        message: typeof data?.message === 'string' ? data.message : fallback.message || ''
      }
    }

    class DLLPluginAPI {
      constructor(transport, events) {
        this.transport = transport
        this.events = events
        this._listeners = {}
        this._tasks = new Map()
        this._callbackHandlers = new Map()
        this._startingTasks = new Set()
        this._eventsBound = false

        // 初始化事件桥接
        this._initEventBridge()
      }

      /**
       * 初始化事件桥接
       * @private
       */
      _initEventBridge() {
        if (!this.events || typeof this.events.on !== 'function') {
          dllError('Events module not available')
          return
        }

        const handler = (envelope) => {
          if (!envelope || !envelope.payload) {
            return
          }

          const payload = envelope.payload
          const taskId = payload.taskId || payload.id
          if (!taskId) {
            return
          }

          const now = Date.now()
          let taskInfo = this._tasks.get(taskId)
          if (!taskInfo) {
            taskInfo = {
              pluginName: payload.plugin || null,
              funcName: payload.func || '',
              params: {},
              status: 'running',
              startTime: now,
              percent: 0,
              current: 0,
              total: 0,
              message: '',
              updatedAt: now,
              completeEmitted: false,
              errorEmitted: false,
              cancelledEmitted: false,
              cancelRequested: false
            }
            this._tasks.set(taskId, taskInfo)
          }
          copyTaskStartMetadata(taskInfo, payload)
          if (isTerminalTaskStatus(taskInfo.status)) {
            if (
              normalizeTaskStatus(payload.status) === taskInfo.status &&
              taskInfo.status === 'completed' &&
              taskInfo.result === undefined &&
              payload.data !== undefined
            ) {
              taskInfo.result = payload.data
              taskInfo.updatedAt = now
            }
            return
          }

          if (payload.taskStartResolved === true || payload.taskStartPending === false) {
            taskInfo.startPending = false
            this._startingTasks.delete(taskId)
          }
          if (payload.settingsSavedPending === true) taskInfo.settingsSavedPending = true
          if (typeof payload.settingsSaved === 'boolean') {
            taskInfo.settingsSaved = payload.settingsSaved
            taskInfo.settingsSavedPending = false
          }

          const pluginName = payload.plugin || taskInfo.pluginName || null
          const current = toNumber(payload.current, taskInfo.current || 0)
          const total = toNumber(payload.total, taskInfo.total || 0)
          const percent = Math.max(
            toNumber(taskInfo.percent, 0),
            Math.max(0, Math.min(100, toNumber(payload.percent, taskInfo.percent || 0)))
          )
          const statusFromPayload = normalizeTaskStatus(payload.status)
          const message = payload.message || taskInfo.message || ''

          const progressEvent = {
            pluginName,
            taskId,
            current,
            total,
            percent,
            message,
            status: statusFromPayload || 'running',
            timestamp: now
          }

          if (payload.error) {
            progressEvent.error = payload.error
            progressEvent.status = 'error'
          }

          if (payload.data !== undefined) {
            progressEvent.data = payload.data
          }
          if (progressEvent.status === 'completed') progressEvent.percent = 100

          this._emit('progress', progressEvent)

          taskInfo.pluginName = pluginName
          taskInfo.current = current
          taskInfo.total = total
          taskInfo.percent = percent
          taskInfo.message = message
          taskInfo.status = progressEvent.status
          taskInfo.updatedAt = now
          if (isTerminalTaskStatus(taskInfo.status)) taskInfo.cancelRequested = false

          if (isTerminalTaskStatus(progressEvent.status) && progressEvent.data !== undefined) {
            taskInfo.result = progressEvent.data
          }

          if (progressEvent.status === 'completed' && !taskInfo.completeEmitted) {
            taskInfo.completeEmitted = true
            this._emit('complete', {
              taskId,
              data: taskInfo.result
            })
          }

          if (progressEvent.status === 'error' && !taskInfo.errorEmitted) {
            taskInfo.errorEmitted = true
            taskInfo.error = progressEvent.error || progressEvent.message
            this._emit('error', {
              taskId,
              error: taskInfo.error
            })
          }

          if (progressEvent.status === 'cancelled' && !taskInfo.cancelledEmitted) {
            taskInfo.cancelledEmitted = true
            taskInfo.cancelRequested = false
            this._emit('cancelled', { taskId })
          }
        }

        this.events.on(PROGRESS_EVENT_TYPE, handler)

        // 监听回调结果事件
        const callbackResultHandler = (envelope) => {
          if (!envelope || !envelope.payload) {
            return
          }

          const payload = envelope.payload
          const taskId = payload.taskId || payload.id
          if (!taskId) {
            return
          }

          const now = Date.now()
          let taskInfo = this._tasks.get(taskId)
          if (!taskInfo) {
            taskInfo = {
              pluginName: payload.plugin || null,
              funcName: payload.func || '',
              params: {},
              status: 'running',
              startTime: now,
              updatedAt: now,
              completeEmitted: false,
              errorEmitted: false,
              cancelledEmitted: false,
              cancelRequested: false
            }
            this._tasks.set(taskId, taskInfo)
          }
          taskInfo.startPending = false
          this._startingTasks.delete(taskId)
          const wasTerminal = isTerminalTaskStatus(taskInfo.status)
          taskInfo.pluginName = payload.plugin || taskInfo.pluginName

          // 解析回调结果
          let resultData = null
          let error = null
          let hasResultData = false
          if (payload.result !== undefined && payload.result !== null) {
            try {
              resultData =
                typeof payload.result === 'string'
                  ? JSON.parse(payload.result)
                  : payload.result
              hasResultData = true
            } catch (e) {
              dllError('Failed to parse callback result JSON:', e)
              error = '回调结果解析失败: ' + (e instanceof Error ? e.message : String(e))
            }
          } else if (payload.data !== undefined) {
            resultData = payload.data
            hasResultData = true
          }

          if (payload.error) {
            error = payload.error
          }
          const resultDataObject = resultData && typeof resultData === 'object' && !Array.isArray(resultData)
            ? resultData
            : null
          const nestedData = resultDataObject?.data && typeof resultDataObject.data === 'object'
            ? resultDataObject.data
            : null
          if (!error) error = resultDataObject?.error || nestedData?.error || null

          const resultStatus = getCallbackResultStatus(resultData, error)
          if (wasTerminal) {
            if (resultStatus === taskInfo.status) {
              if (taskInfo.status === 'error' && !taskInfo.error && error) {
                taskInfo.error = error
              }
              if (taskInfo.result === undefined && hasResultData) {
                taskInfo.result = resultData
                if (taskInfo.status === 'completed') taskInfo.percent = 100
                taskInfo.updatedAt = now
                this._emit('callback', {
                  taskId,
                  data: resultData,
                  ...(taskInfo.status === 'error' && taskInfo.error ? { error: taskInfo.error } : {})
                })
              } else if (taskInfo.status === 'error' && !taskInfo.error && error) {
                taskInfo.error = error
                taskInfo.updatedAt = now
              }
            }
            return
          }

          taskInfo.updatedAt = now
          if (resultStatus === 'running') {
            const progress = getCallbackProgress(resultData, taskInfo)
            taskInfo.current = progress.current
            taskInfo.total = progress.total
            taskInfo.percent = Math.max(toNumber(taskInfo.percent, 0), progress.percent)
            taskInfo.message = progress.message
            taskInfo.status = 'running'
            taskInfo.updatedAt = now
            this._emit('progress', {
              pluginName: taskInfo.pluginName,
              taskId,
              current: progress.current,
              total: progress.total,
              percent: progress.percent,
              message: progress.message,
              status: 'running',
              timestamp: now,
              data: resultData
            })
            this._emit('callback', { taskId, data: resultData })
          } else if (resultStatus === 'cancelled') {
            taskInfo.status = 'cancelled'
            if (hasResultData) taskInfo.result = resultData
            taskInfo.cancelRequested = false
            taskInfo.updatedAt = now
            if (hasResultData) this._emit('callback', { taskId, data: resultData })
            if (!taskInfo.cancelledEmitted) {
              taskInfo.cancelledEmitted = true
              this._emit('cancelled', { taskId })
            }
          } else if (resultStatus === 'error') {
            error = error || 'DLL 回调调用失败'
            taskInfo.status = 'error'
            if (hasResultData) taskInfo.result = resultData
            taskInfo.error = error
            const workNotStarted = payload.taskStartResolved === 'not-started' || payload.workNotStarted === true
            if (workNotStarted) taskInfo.workNotStarted = true
            if (typeof payload.code === 'string') taskInfo.errorCode = payload.code
            taskInfo.cancelRequested = false
            if (!taskInfo.errorEmitted) {
              taskInfo.errorEmitted = true
              this._emit('callback', {
                taskId,
                error: error,
                data: resultData,
                ...(workNotStarted ? { workNotStarted: true } : {}),
                ...(typeof payload.code === 'string' ? { code: payload.code } : {})
              })
              this._emit('error', {
                taskId,
                error: error,
                ...(workNotStarted ? { workNotStarted: true } : {}),
                ...(typeof payload.code === 'string' ? { code: payload.code } : {})
              })
            }
          } else if (resultStatus === 'completed') {
            taskInfo.status = 'completed'
            taskInfo.result = resultData
            taskInfo.percent = 100
            taskInfo.cancelRequested = false
            if (!taskInfo.completeEmitted) {
              taskInfo.completeEmitted = true
              this._emit('callback', {
                taskId,
                data: resultData
              })
              this._emit('complete', {
                taskId,
                data: resultData
              })
            }
          } else {
            this._emit('callback', { taskId, data: resultData })
          }
        }

        this.events.on(CALLBACK_RESULT_EVENT_TYPE, callbackResultHandler)

        this._eventsBound = true
        // dllLog('DLL 插件进度事件桥接已启用')
      }

      /**
       * 添加事件监听器
       */
      on(event, callback) {
        if (!this._listeners[event]) {
          this._listeners[event] = []
        }
        this._listeners[event].push(callback)
      }

      /**
       * 移除事件监听器
       */
      off(event, callback) {
        if (!this._listeners[event]) return
        const index = this._listeners[event].indexOf(callback)
        if (index > -1) {
          this._listeners[event].splice(index, 1)
        }
      }

      /**
       * 触发事件
       * @private
       */
      _emit(event, data) {
        if (!this._listeners[event]) return
        this._listeners[event].forEach((callback) => {
          try {
            callback(data)
          } catch (e) {
            dllError('Event listener error:', e)
          }
        })
      }

      /**
       * 获取所有 DLL 插件列表
       */
      async list() {
        try {
          const response = await this.transport.call('dllplugin_list', {})
          if (response && response.success) {
            return response.plugins || []
          } else {
            throw new Error((response && response.error) || '获取 DLL 插件列表失败')
          }
        } catch (e) {
          dllError('Failed to get DLL plugin list:', e)
          throw e
        }
      }

      /**
       * 获取所有 DLL 插件列表 (别名)
       */
      async getList() {
        return await this.list()
      }

      /**
       * 调用 DLL 插件函数
       * @param {string} pluginName - DLL插件名称  直接使用插件名称，如 'MathPlugin'
       * @param {string} funcName - 函数名称
       * @param {Object} params - 函数参数
       * @returns {Promise<any>} 函数返回值
       */
      async call(pluginName, funcName, params = {}, options = {}) {
        try {
          if (!pluginName || typeof pluginName !== 'string') {
            throw new Error('插件名称无效')
          }

          if (!funcName || typeof funcName !== 'string') {
            throw new Error('函数名称无效')
          }

          const response = await this.transport.call(
            'dllplugin_call',
            {
              plugin: pluginName,
              func: funcName,
              params: params
            },
            options
          )

          if (response && response.success) {
            return response.data
          } else {
            throw new Error(response.error || 'DLL 插件调用失败')
          }
        } catch (e) {
          dllError(`Failed to call DLL plugin ${pluginName}.${funcName}:`, e)
          throw e
        }
      }

      /**
       * 带回调的调用 DLL 插件函数（结果通过回调返回）
       * @param {string} pluginName - DLL插件名称 直接使用插件名称，如 'MathPlugin'
       * @param {string} funcName - 函数名称
       * @param {Object} params - 函数参数（必须包含 taskId）
       * @param {Function} [onCallback] - 回调函数，接收 (data, error) 参数
       * @returns {Promise<string>} taskId - 任务ID
       */
      async callWithCallback(pluginName, funcName, params = {}, onCallback = null) {
        let taskId = ''
        let reservedTaskId = false
        let definitiveNoStartCleared = false
        try {
          if (!pluginName || typeof pluginName !== 'string') {
            throw new Error('插件名称无效')
          }

          if (!funcName || typeof funcName !== 'string') {
            throw new Error('函数名称无效')
          }

          // 生成 taskId（如果未提供）
          if (!params.taskId) {
            params.taskId = `callback_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          }

          taskId = params.taskId
          if (
            this._tasks.has(taskId) ||
            this._startingTasks.has(taskId) ||
            this._callbackHandlers.has(taskId)
          ) {
            throw new Error('DLL 回调任务ID已被占用')
          }
          this._startingTasks.add(taskId)
          reservedTaskId = true

          const provisionalTime = Date.now()
          this._tasks.set(taskId, {
            pluginName,
            funcName,
            params,
            status: 'running',
            startPending: true,
            startTime: provisionalTime,
            updatedAt: provisionalTime,
            completeEmitted: false,
            errorEmitted: false,
            cancelledEmitted: false,
            cancelRequested: false
          })

          // 如果提供了回调函数，注册监听器
          if (onCallback && typeof onCallback === 'function') {
            const callbackHandler = (event) => {
              if (event.taskId === taskId) {
                // 调用用户提供的回调函数
                try {
                  if (event.error) {
                    onCallback(event.data ?? null, event.error)
                  } else {
                    onCallback(event.data, null)
                  }
                } catch (e) {
                  dllError('Callback handler error:', e)
                }
              }
            }
            this.on('callback', callbackHandler)
            this._callbackHandlers.set(taskId, callbackHandler)
          }

          const response = await this.transport.call(
            'dllplugin_call_with_callback',
            {
              plugin: pluginName,
              func: funcName,
              params: params
            }
          )

          if (response && response.success) {
            const now = Date.now()
            const taskInfo = this._tasks.get(taskId)
            if (taskInfo) {
              taskInfo.pluginName = pluginName
              taskInfo.funcName = funcName
              taskInfo.params = params
              taskInfo.startTime = taskInfo.startTime || now
              taskInfo.updatedAt = now
              taskInfo.completeEmitted = taskInfo.completeEmitted === true
              taskInfo.errorEmitted = taskInfo.errorEmitted === true
              taskInfo.cancelledEmitted = taskInfo.cancelledEmitted === true
              if (taskInfo.startPending !== false) taskInfo.startPending = response.taskStartPending === true
              if (typeof response.settingsSaved === 'boolean') taskInfo.settingsSaved = response.settingsSaved
              if (response.settingsSavedPending === true) taskInfo.settingsSavedPending = true
            } else {
              this._tasks.set(taskId, {
                pluginName,
                funcName,
                params,
                status: 'running',
                startPending: response.taskStartPending === true,
                ...(typeof response.settingsSaved === 'boolean' ? { settingsSaved: response.settingsSaved } : {}),
                ...(response.settingsSavedPending === true ? { settingsSavedPending: true } : {}),
                startTime: now,
                updatedAt: now,
                completeEmitted: false,
                errorEmitted: false,
                cancelledEmitted: false,
                cancelRequested: false
              })
            }

            return taskId
          } else {
            if (response?.taskStartResolved === 'not-started') {
              await this.clearCallback(taskId, true)
              definitiveNoStartCleared = true
            }
            const responseError = response?.error && typeof response.error === 'object'
              ? response.error
              : null
            const error = new Error(
              responseError?.message || response?.error || 'DLL 插件回调调用失败'
            )
            const code = response?.code || responseError?.code
            Object.assign(error, {
              ...(typeof code === 'string' ? { code } : {}),
              ...(response?.taskStartResolved === 'not-started' || response?.workNotStarted === true
                ? { workNotStarted: true }
                : {})
            })
            throw error
          }
        } catch (e) {
          if (taskId && reservedTaskId && !definitiveNoStartCleared) {
            await this.clearCallback(taskId, true).catch(() => undefined)
          }
          dllError(
            `Failed to call DLL plugin with callback ${pluginName}.${funcName}:`,
            e
          )
          throw e
        } finally {
          const taskInfo = taskId ? this._tasks.get(taskId) : null
          if (reservedTaskId && taskInfo?.startPending !== true) this._startingTasks.delete(taskId)
        }
      }

      /**
       * 清理指定回调任务在当前页面注册的监听器
       */
      async clearCallback(taskId, removeTask = false) {
        if (!taskId) return

        try {
          const response = await this.transport.call('dllplugin_clear_callback_task', { taskId })
          if (!response || response.success !== true) {
            throw new Error(response?.error || '清理 DLL 回调任务失败')
          }
          const callbackHandler = this._callbackHandlers.get(taskId)
          if (callbackHandler) {
            this.off('callback', callbackHandler)
            this._callbackHandlers.delete(taskId)
          }
          if (removeTask) this._tasks.delete(taskId)
          this._startingTasks.delete(taskId)
          return response
        } catch (e) {
          if (this.transport._debug) {
            dllLog('Failed to clear callback task mapping:', e)
          }
          throw e
        }
      }

      /**
       * 检查插件是否存在
       */
      async exists(pluginName) {
        try {
          const plugins = await this.list()
          return plugins.some((p) => p.name === pluginName)
        } catch (e) {
          dllError('Failed to check plugin existence:', e)
          return false
        }
      }

      /**
       * 获取插件信息
       */
      async getInfo(pluginName) {
        try {
          const plugins = await this.list()
          return plugins.find((p) => p.name === pluginName) || null
        } catch (e) {
          dllError('Failed to get plugin info:', e)
          return null
        }
      }

      /**
       * 异步调用 DLL 插件函数（带进度回调）
       * @param {string} pluginName - DLL插件名称 直接使用插件名称，如 'MathPlugin'
       * @param {string} funcName - 函数名称
       * @param {Object} params - 函数参数
       * @returns {Promise<string>} taskId - 任务ID
       */
      async callAsync(pluginName, funcName, params = {}) {
        try {
          if (!pluginName || typeof pluginName !== 'string') {
            throw dllTaskFailure({ code: 'INVALID_REQUEST', workNotStarted: true, taskStartResolved: 'not-started' }, '插件名称无效')
          }

          if (!funcName || typeof funcName !== 'string') {
            throw dllTaskFailure({ code: 'INVALID_REQUEST', workNotStarted: true, taskStartResolved: 'not-started' }, '函数名称无效')
          }

          const response = await this.transport.call('dllplugin_call_async', {
            plugin: pluginName,
            func: funcName,
            params: params
          })

          if (response && response.success) {
            const taskId = response.taskId
            if (typeof taskId !== 'string' || !taskId) throw taskObservationFailure({}, '', '宿主返回无效任务ID')

            const now = Date.now()
            const taskInfo = this._tasks.get(taskId)
            if (taskInfo) {
              taskInfo.pluginName = pluginName
              taskInfo.funcName = funcName
              taskInfo.params = params
              taskInfo.startTime = taskInfo.startTime || now
              taskInfo.percent = taskInfo.percent || 0
              taskInfo.current = taskInfo.current || 0
              taskInfo.total = taskInfo.total || 0
              taskInfo.message = taskInfo.message || ''
              taskInfo.updatedAt = now
              taskInfo.completeEmitted = taskInfo.completeEmitted === true
              taskInfo.errorEmitted = taskInfo.errorEmitted === true
              taskInfo.cancelledEmitted = taskInfo.cancelledEmitted === true
              taskInfo.cancelRequested = taskInfo.cancelRequested === true
              copyTaskStartMetadata(taskInfo, response)
              if (typeof response.settingsSaved === 'boolean') taskInfo.settingsSaved = response.settingsSaved
            } else {
              this._tasks.set(taskId, {
                pluginName,
                funcName,
                params,
                status: response.taskStartPending === true ? 'invoking' : 'running',
                startPending: response.taskStartPending === true,
                startTime: now,
                percent: 0,
                current: 0,
                total: 0,
                message: '',
                updatedAt: now,
                completeEmitted: false,
                errorEmitted: false,
                cancelledEmitted: false,
                cancelRequested: false,
                ...(typeof response.settingsSaved === 'boolean' ? { settingsSaved: response.settingsSaved } : {})
              })
            }

            dllLog(`异步任务已登记: ${taskId}`)
            return taskId
          } else {
            throw dllTaskFailure(response, response?.error || 'DLL 插件异步调用失败', response?.taskId)
          }
        } catch (e) {
          dllError(`Failed to call DLL plugin async ${pluginName}.${funcName}:`, e)
          if (e?.workNotStarted === true) throw e
          const error = dllTaskFailure(e, e instanceof Error ? e.message : String(e), e?.taskId)
          error.workOutcome = 'unknown'
          error.noReplay = true
          throw error
        }
      }

      /**
       * 查询任务状态
       */
      async queryTask(pluginName, taskId, options = {}) {
        try {
          // 参数验证
          if (!pluginName || typeof pluginName !== 'string') {
            throw new Error('插件名称无效: ' + pluginName)
          }
          if (!taskId || typeof taskId !== 'string') {
            throw new Error('任务ID无效: ' + taskId)
          }

          // 调用后端查询任务状态
          const response = await this.transport.call('dllplugin_query_task', {
            plugin: pluginName,
            taskId: taskId
          }, options)

          // 处理响应
          if (!response) {
            throw new Error('查询任务返回空响应')
          }

          const hasTaskStatus = typeof response.taskStatus === 'string' && response.taskStatus.length > 0
          const reportedStatus = hasTaskStatus
            ? normalizeTaskStatus(response.taskStatus) || response.taskStatus
            : response.taskDone
              ? response.taskError
                ? 'error'
                : 'completed'
              : 'running'
          const reportedDone = isTerminalTaskStatus(reportedStatus) || (!hasTaskStatus && response.taskDone === true)
          const taskInfo = this._tasks.get(taskId)
          let effectiveStatus = reportedStatus
          let effectiveDone = reportedDone

          if (taskInfo) {
            taskInfo.updatedAt = Date.now()
            copyTaskStartMetadata(taskInfo, response)
            taskInfo.startPending = response.taskStartPending === true
            if (!taskInfo.startPending) this._startingTasks.delete(taskId)
            if (isTerminalTaskStatus(taskInfo.status)) {
              if (taskInfo.status === reportedStatus) {
                if (taskInfo.result === undefined && response.taskData !== undefined) {
                  taskInfo.result = response.taskData
                }
                if (taskInfo.status === 'error' && !taskInfo.error && response.taskError) {
                  taskInfo.error = response.taskError
                }
              }
            } else {
              taskInfo.status = reportedStatus
              taskInfo.cancelRequested = reportedDone
                ? false
                : response.taskCancelRequested === true || taskInfo.cancelRequested === true
              if (response.taskData !== undefined) taskInfo.result = response.taskData
              if (response.taskError !== undefined) taskInfo.error = response.taskError
              if (!reportedDone && response.taskProgress !== undefined) {
                taskInfo.progress = response.taskProgress
              }
            }
            if (taskInfo.status === 'completed') taskInfo.percent = 100
            effectiveStatus = taskInfo.status
            effectiveDone = isTerminalTaskStatus(taskInfo.status) || reportedDone
          } else if (response.queryOk) {
            this._tasks.set(taskId, {
              pluginName,
              status: reportedStatus,
              ...(response.taskData !== undefined ? { result: response.taskData } : {}),
              ...(response.taskError !== undefined ? { error: response.taskError } : {}),
              ...(response.taskProgress !== undefined ? { progress: response.taskProgress } : {}),
              cancelRequested: response.taskCancelRequested === true && !reportedDone,
              startPending: response.taskStartPending === true,
              completeEmitted: false,
              errorEmitted: false,
              cancelledEmitted: false,
              updatedAt: Date.now()
            })
          }

          const effectiveTaskInfo = this._tasks.get(taskId)
          if (effectiveTaskInfo && isTerminalTaskStatus(effectiveTaskInfo.status)) {
            effectiveStatus = effectiveTaskInfo.status
            effectiveDone = true
            if (effectiveStatus === 'completed' && !effectiveTaskInfo.completeEmitted) {
              effectiveTaskInfo.completeEmitted = true
              this._emit('complete', {
                plugin: effectiveTaskInfo.pluginName || pluginName,
                taskId,
                result: effectiveTaskInfo.result
              })
            }
          }

          const result = {
            success: response.queryOk === true,
            completed: effectiveDone,
            status: effectiveStatus
          }

          if (isTerminalTaskStatus(effectiveStatus) && effectiveTaskInfo?.result !== undefined) {
            result.data = effectiveTaskInfo.result
          }
          if (effectiveStatus === 'error' || effectiveStatus === 'cancelled') {
            const taskError = effectiveTaskInfo?.error || response.taskError
            if (taskError) result.error = taskError
          } else if (response.taskProgress !== undefined) {
            result.progress = response.taskProgress
          }
          if (effectiveTaskInfo?.cancelRequested) result.cancelRequested = true
          if (effectiveTaskInfo?.startPending) result.startPending = true
          for (const key of ['code', 'taskStartResolved', 'workNotStarted', 'workOutcome', 'noReplay']) {
            if (response[key] !== undefined) result[key] = response[key]
          }

          // 如果查询失败，抛出错误
          if (!response.queryOk) {
            throw new Error(response.taskError || '查询任务失败')
          }

          return result
        } catch (e) {
          // 记录错误
          if (this.transport._debug) {
            console.error('[ztools-dllplugin] QueryTask error:', e)
          }
          throw e
        }
      }

      /**
       * 等待任务完成（轮询）
       */
      async waitTask(taskId, pollInterval = 1000, timeout = 0, options = {}) {
        const taskInfo = this._tasks.get(taskId)
        if (!taskInfo) throw new Error('未知的任务ID: ' + taskId)
        const signal = options?.signal
        if (!Number.isFinite(pollInterval) || pollInterval <= 0 || pollInterval > 60_000 ||
            !Number.isFinite(timeout) || timeout < 0 || timeout > 86_400_000 ||
            (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' ||
              typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) {
          throw Object.assign(new Error('DLL 任务观察参数无效'), { code: 'INVALID_REQUEST' })
        }
        const deadline = timeout > 0 ? Date.now() + timeout : Infinity
        const checkObservation = () => {
          if (signal?.aborted) {
            throw Object.assign(taskObservationFailure(taskInfo, taskId, '已停止观察任务，原生结果仍须确认',
              'DLL_TASK_OBSERVATION_ABORTED'), { name: 'AbortError' })
          }
          if (Date.now() >= deadline) {
            throw taskObservationFailure(taskInfo, taskId, '任务等待超时，原生结果仍须确认', 'DLL_TASK_WAIT_TIMEOUT')
          }
        }
        const terminalResult = () => {
          if (taskInfo.status === 'completed') return { done: true, data: taskInfo.result }
          if (taskInfo.status === 'error' || taskInfo.status === 'cancelled') {
            throw Object.assign(dllTaskFailure(taskInfo, taskInfo.error ||
              (taskInfo.status === 'cancelled' ? '任务已取消' : '任务执行失败'), taskId), { taskDone: true })
          }
          return { done: false }
        }
        while (true) {
          checkObservation()
          const terminal = terminalResult()
          if (terminal.done) return terminal.data
          try {
            // One bounded query remains owned by this observer. An abort does not
            // abandon it or forward a fake native cancellation capability.
            await this.queryTask(taskInfo.pluginName, taskId, {
              timeout: Math.min(10_000, Math.max(1, deadline - Date.now()))
            })
          } catch (error) {
            checkObservation()
            const lateTerminal = terminalResult()
            if (lateTerminal.done) return lateTerminal.data
            throw taskObservationFailure(taskInfo, taskId,
              error instanceof Error ? error.message : String(error))
          }
          checkObservation()
          const queriedTerminal = terminalResult()
          if (queriedTerminal.done) return queriedTerminal.data
          await new Promise(resolve => {
            let timer
            const finish = () => {
              clearTimeout(timer)
              signal?.removeEventListener('abort', finish)
              resolve()
            }
            timer = setTimeout(finish, Math.min(pollInterval, Math.max(0, deadline - Date.now())))
            signal?.addEventListener('abort', finish, { once: true })
            if (signal?.aborted) finish()
          })
        }
      }

      /**
       * 取消任务
       */
      async cancelTask(pluginName, taskId) {
        try {
          const taskInfo = this._tasks.get(taskId)
          if (taskInfo && (isTerminalTaskStatus(taskInfo.status) || taskInfo.cancelRequested)) return true

          const response = await this.transport.call('dllplugin_cancel_task', {
            plugin: pluginName,
            taskId: taskId
          })

          if (response && response.success) {
            if (taskInfo && !isTerminalTaskStatus(taskInfo.status)) {
              taskInfo.cancelRequested = true
              taskInfo.updatedAt = Date.now()
            }

            dllLog(`已请求取消任务: ${taskId}`)
            return true
          } else {
            throw new Error(response.error || '取消任务失败')
          }
        } catch (e) {
          dllError('Failed to cancel task:', e)
          throw e
        }
      }

      /**
       * 获取任务信息
       */
      getTaskInfo(taskId) {
        return this._tasks.get(taskId) || null
      }

      /**
       * 获取所有任务
       */
      getAllTasks() {
        const tasks = []
        this._tasks.forEach((info, taskId) => {
          tasks.push({ taskId, ...info })
        })
        return tasks
      }
    }

    // ========================================
    // api/screenshot.js
    // ========================================

    /**
     * Screenshot API - 高层交互式截图能力
     * 封装 ScreenCapturePlugin.dll 提供区域、全屏、窗口截图能力
     */
    class ScreenshotAPI {
      constructor(dllplugin, sys) {
        this.dllplugin = dllplugin
        this.sys = sys
      }

      /**
       * 获取公共截图插件名称
       * @private
       */
      _getPluginName() {
        return 'ScreenCapturePlugin'
      }

      /**
       * 标准化插件返回结果
       * @private
       */
      _normalizeResult(result, defaultMessage = '截图失败') {
        if (!result || typeof result !== 'object') {
          throw new Error(defaultMessage)
        }

        if (result.success === false) {
          return {
            success: false,
            cancelled: result.cancelled === true,
            error: result.error || defaultMessage,
            message: result.message || result.error || defaultMessage
          }
        }

        return {
          success: true,
          cancelled: false,
          outputPath: result.outputPath || '',
          savedPath: typeof result.savedPath === 'string' ? result.savedPath : '',
          clipboard: result.clipboard === true,
          pinned: result.pinned === true,
          width: result.width || 0,
          height: result.height || 0,
          rect: result.rect || null,
          screenCount: result.screenCount || 0,
          message: result.message || '操作成功'
        }
      }

      _awaitCapture(promise, signal) {
        return new Promise((resolve, reject) => {
          const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
          if (signal.aborted) { Promise.resolve(promise).catch(() => {}); abort(); return }
          signal.addEventListener('abort', abort, { once: true })
          Promise.resolve(promise).then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
        })
      }

      async _waitCaptureRegionTask(pluginName, taskId, pollInterval, signal) {
        try {
          while (true) {
            signal.throwIfAborted()
            const status = await this._awaitCapture(this.dllplugin.queryTask(pluginName, taskId), signal)
            signal.throwIfAborted()
            if (!status || typeof status !== 'object' || typeof status.completed !== 'boolean') throw new Error('截图任务状态无效')
            if (status.completed) {
              if (status.status === 'cancelled') return { success: false, cancelled: true, error: status.error || '截图已取消' }
              if (status.status === 'error') throw new Error(status.error || '截图失败')
              return status.data
            }
            await new Promise((resolve, reject) => {
              const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason) }
              const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, pollInterval)
              signal.addEventListener('abort', abort, { once: true })
              if (signal.aborted) abort()
            })
          }
        } catch (error) {
          if (signal.aborted) void this.dllplugin.cancelTask(pluginName, taskId).catch(() => {})
          throw error
        }
      }

      /**
       * 交互式截图，默认等同于区域截图
       * @param {Object} [options]
       * @returns {Promise<Object>}
       */
      async capture(options = {}) {
        return await this.captureRegion(options)
      }

      /**
       * 区域截图
       * @param {Object} [options]
       * @param {string} [options.outputDir]
       * @param {string} [options.outputFormat='png']
       * @param {boolean} [options.openFolder=false]
       * @param {boolean} [options.enableToolbar=false] 是否开启编辑工具栏
       * @param {boolean} [options.enablePinToScreen=false] 是否允许"贴到屏幕"
       * @param {boolean} [options.autoFinishOnSelect=false] 区域框选完成后是否直接返回
       * @param {AbortSignal} [options.signal] 取消轮询并请求取消原生任务
       * @param {number} [options.timeout=300000] 有界等待时间（ms，最多600000）
       * @param {number} [options.pollInterval=200] 任务状态轮询间隔（ms）
       * @returns {Promise<Object>}
       */
      async captureRegion(options = {}) {
        const pollInterval = options.pollInterval ?? 200, timeout = options.timeout ?? 300000
        if (!Number.isInteger(pollInterval) || pollInterval < 10 || pollInterval > 5000 || !Number.isInteger(timeout) || timeout < 1 || timeout > 600000 ||
            (options.signal !== undefined && (!options.signal || typeof options.signal.addEventListener !== 'function' || typeof options.signal.aborted !== 'boolean'))) throw new Error('截图取消/超时参数无效')
        await ensureRuntimeCapability(this.sys, 'screen.capture', options)
        const controller = new AbortController()
        const cancelError = Object.assign(new Error('截图已取消'), { name: 'AbortError', code: 'CALLER_DESTROYED' })
        const abort = () => controller.abort(cancelError)
        if (options.signal?.aborted) abort()
        else options.signal?.addEventListener('abort', abort, { once: true })
        const timer = setTimeout(() => controller.abort(Object.assign(new Error('截图等待超时'), { code: 'REQUEST_TIMEOUT' })), timeout)
        const pluginName = this._getPluginName()
        let taskId
        try {
          controller.signal.throwIfAborted()
          // Cancel waiting immediately; an ID arriving later still receives cancellation.
          const creation = this.dllplugin.callAsync(pluginName, 'CaptureRegion', {
            outputDir: options.outputDir || '', outputFormat: options.outputFormat || 'png',
            openFolder: options.openFolder === true, enableToolbar: options.enableToolbar === true,
            enablePinToScreen: options.enablePinToScreen === true, autoFinishOnSelect: options.autoFinishOnSelect === true
          })
          void creation.then(id => { if (controller.signal.aborted) void this.dllplugin.cancelTask(pluginName, id).catch(() => {}) }, () => {})
          taskId = await this._awaitCapture(creation, controller.signal)
          const result = await this._waitCaptureRegionTask(pluginName, taskId, pollInterval, controller.signal)
          return this._normalizeResult(result, '区域截图失败')
        } finally {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', abort)
        }
      }

      /**
       * 全屏截图
       * @param {Object} [options]
       * @param {string} [options.outputDir]
       * @param {string} [options.outputFormat='png']
       * @param {number[]} [options.screens]
       * @param {boolean} [options.openFolder=false]
       * @returns {Promise<Object>}
       */
      async captureScreen(options = {}) {
        await ensureRuntimeCapability(this.sys, 'screen.capture')
        const pluginName = this._getPluginName()
        const result = await this.dllplugin.call(pluginName, 'CaptureScreen', {
          outputDir: options.outputDir || '',
          outputFormat: options.outputFormat || 'png',
          screens: Array.isArray(options.screens) ? options.screens : undefined,
          openFolder: options.openFolder === true
        })
        return this._normalizeResult(result, '全屏截图失败')
      }

      /**
       * 窗口截图
       * @param {Object} options
       * @param {string} options.windowTitle
       * @param {string} [options.outputDir]
       * @param {string} [options.outputFormat='png']
       * @param {boolean} [options.openFolder=false]
       * @returns {Promise<Object>}
       */
      async captureWindow(options = {}) {
        if (!options.windowTitle) {
          throw new Error('windowTitle 参数必填')
        }

        await ensureRuntimeCapability(this.sys, 'screen.capture')

        const pluginName = this._getPluginName()
        const result = await this.dllplugin.call(pluginName, 'CaptureWindow', {
          windowTitle: options.windowTitle,
          outputDir: options.outputDir || '',
          outputFormat: options.outputFormat || 'png',
          openFolder: options.openFolder === true
        })
        return this._normalizeResult(result, '窗口截图失败')
      }

      /**
       * 获取窗口列表
       * @returns {Promise<Array>}
       */
      async getWindowList() {
        const pluginName = this._getPluginName()
        const result = await this.dllplugin.call(pluginName, 'GetWindowList', {})
        if (result?.success === false) {
          throw new Error(result.error || result.message || '获取窗口列表失败')
        }
        return Array.isArray(result?.windows) ? result.windows : []
      }

      /**
       * 获取屏幕列表
       * @returns {Promise<Array>}
       */
      async getScreenList() {
        const pluginName = this._getPluginName()
        const result = await this.dllplugin.call(pluginName, 'GetScreenList', {})
        if (result?.success === false) {
          throw new Error(result.error || result.message || '获取屏幕列表失败')
        }
        return Array.isArray(result?.screens) ? result.screens : []
      }

      /**
       * 检查公共截图插件是否可用
       * @returns {Promise<boolean>}
       */
      async isAvailable() {
        try {
          return await this.dllplugin.exists(this._getPluginName())
        } catch (error) {
          console.error('[screenshot] 检查插件可用性失败:', error)
          return false
        }
      }
    }

    // ========================================
    // api/zip.js
    // ========================================

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

    // ========================================
    // api/sqlite-reference.js
    // ========================================

    /** Shared fixed read-only browser queries; requires an independently exported SQLite FileRef snapshot. */
    class ReferenceSQLiteAPI extends ReferenceFileSystemAPI {
      async readBrowserSnapshot(file, options = {}) {
        this._options(options, ['kind', 'limit', 'keyword', 'signal'])
        if (!['chromium-history', 'firefox-history', 'firefox-bookmarks'].includes(options.kind) || !Number.isSafeInteger(options.limit ?? 200) || (options.limit ?? 200) < 1 || (options.limit ?? 200) > 1000 || typeof (options.keyword ?? '') !== 'string' || new TextEncoder().encode(options.keyword ?? '').length > 1024 || (options.keyword ?? '').includes(String.fromCharCode(0)) || (options.kind === 'firefox-bookmarks' && options.keyword)) throw this._error('INVALID_REQUEST', '浏览器快照选项无效')
        const result = await this._call('sqlite_read_browser_snapshot', { fileGrantId: this._reference(file, ['file'], 'read'), kind: options.kind, limit: options.limit ?? 200, keyword: options.keyword ?? '' }, { signal: options.signal })
        if (!Array.isArray(result.columns) || !result.columns.length || result.columns.length > 8 || result.columns.some(name => typeof name !== 'string' || name.length > 128) || !Array.isArray(result.rows) || result.rows.length > (options.limit ?? 200) || typeof result.truncated !== 'boolean' || typeof result.sqliteVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(result.sqliteVersion)) throw this._error('FILE_ERROR', 'SQLite响应无效')
        let bytes = 0
        const rows = result.rows.map(row => {
          if (!Array.isArray(row) || row.length !== result.columns.length) throw this._error('FILE_ERROR', 'SQLite行无效')
          for (const cell of row) {
            if (typeof cell === 'string') { const length = new TextEncoder().encode(cell).length; if (length > 512 * 1024) throw this._error('FILE_TOO_LARGE', 'SQLite字段超过上限'); bytes += length }
            else if (cell !== null && (typeof cell !== 'number' || !Number.isFinite(cell))) throw this._error('FILE_ERROR', 'SQLite字段无效')
            else bytes += 8
          }
          return Object.freeze([...row])
        })
        if (bytes > 8 * 1024 * 1024) throw this._error('RESPONSE_TOO_LARGE', 'SQLite结果超过8MiB')
        return Object.freeze({ columns: Object.freeze([...result.columns]), rows: Object.freeze(rows), truncated: result.truncated, sqliteVersion: result.sqliteVersion })
      }
    }

    // ========================================
    // api/analytics.js
    // ========================================

    /**
     * Analytics API - 埋点上报
     * 封装埋点上报相关的业务逻辑，通过IPC调用Delphi端异步上报
     */
    class AnalyticsAPI {
      constructor(transport) {
        this.transport = transport
        this._webVersion = ''  // web前端版本号
      }

      /**
       * 设置web前端版本号
       * @param {string} version - 版本号
       */
      setWebVersion(version) {
        this._webVersion = version || ''
      }

      /**
       * 上报埋点事件
       * @param {string} event - 事件名称（必填），如 'plugin_open', 'button_click'
       * @param {string} pluginId - 插件ID（可选），标识事件来源插件
       * @param {object} data - 扩展数据（可选），任意JSON对象
       * @returns {Promise<boolean>} 是否上报成功
       *
       * @example
       * // 简单事件（无插件上下文）
       * await ztools.analytics.report('app_launch')
       *
       * // 指定插件ID
       * await ztools.analytics.report('plugin_open', 'ocr')
       *
       * // 指定插件ID + 扩展数据
       * await ztools.analytics.report('button_click', 'ocr', { button: 'start' })
       *
       * // 无插件ID但有扩展数据
       * await ztools.analytics.report('settings_change', '', { theme: 'dark' })
       */
      async report(event, pluginId = '', data = null) {
        if (!event || typeof event !== 'string') {
          console.warn('[analytics] event 参数必须是非空字符串')
          return false
        }

        // 兼容旧调用方式：report(event, data) - 第二个参数是对象时当作data处理
        if (pluginId !== null && typeof pluginId === 'object') {
          data = pluginId
          pluginId = ''
        }

        try {
          const params = {
            event,
            plugin_id: pluginId || '',
            web_version: this._webVersion
          }
          if (data !== null && data !== undefined) {
            params.data = data
          }

          const r = await this.transport.call('analytics_report', params)
          return r && r.success === true
        } catch (e) {
          // 埋点上报失败不应影响业务，静默处理
          console.warn('[analytics] 上报失败:', e.message || e)
          return false
        }
      }
    }

    // ========================================
    // client.js
    // ========================================

    /**
     * Client - 客户端门面
     * 组装所有模块，提供统一的 API 入口
     */
    // Keep this list aligned with electron-client/src/contracts/reference-transport.ts.
    // Contract 2 is all-or-nothing: each method must have its own trusted cancel bridge.
    const SDK2_REFERENCE_METHODS = Object.freeze([
      'filesystem_write_file', 'filesystem_write_cache', 'filesystem_delete_file',
      'filesystem_copy_file', 'filesystem_move_file', 'filesystem_create_directory', 'filesystem_delete_directory',
      'network_http_download', 'clipboard_copy_text', 'clipboard_copy_image', 'clipboard_clear', 'clipboard_copy_file', 'clipboard_copy_files', 'shell_trash_item',
      'clipboard_read_image', 'screen_capture', 'screen_capture_region', 'image_transform', 'image_encode_base64', 'image_decode_base64', 'image_preview', 'image_to_pdf', 'image_to_gif', 'image_preview_gif', 'zip_compress', 'zip_extract',
      'filesystem_read_file', 'filesystem_read_file_range', 'filesystem_read_cache',
      'filesystem_file_exists', 'filesystem_get_file_size', 'filesystem_directory_exists', 'filesystem_get_directory_contents',
      'filesystem_get_current_directory', 'filesystem_set_current_directory', 'filesystem_find_files', 'filesystem_find_directories',
      'filesystem_derive_read', 'filesystem_derive_save', 'filesystem_derive_directory', 'filesystem_describe', 'filesystem_revoke',
      'window_show_open_dialog', 'window_show_save_dialog', 'window_show_select_folder_dialog',
      'network_http_upload', 'clipboard_read_files', 'filesystem_list_write_recovery', 'filesystem_inspect_write_recovery', 'sqlite_read_browser_snapshot', 'ocr_local_languages', 'ocr_recognize_reference', 'clipboard_read_text', 'image_get_info', 'zip_list', 'zip_test', 'screen_get_cursor_pos', 'screen_get_primary_display', 'screen_get_all_displays', 'screen_get_display_nearest', 'screen_get_display_matching'
    ])

    function useReferenceClientContract() {
      const host = typeof window !== 'undefined' ? window.__ztoolsElectron : null
      if (host?.contractVersion !== 2) return false

      const methods = host.transport?.methods
      const cancellations = host.transport?.cancellations
      const hasOwnFunction = (bridge, method) => bridge && typeof bridge === 'object' && !Array.isArray(bridge) &&
        Object.prototype.hasOwnProperty.call(bridge, method) && typeof bridge[method] === 'function'
      if (!SDK2_REFERENCE_METHODS.every(method => hasOwnFunction(methods, method) && hasOwnFunction(cancellations, method))) {
        const error = new Error('SDK合约2宿主缺少完整的逐方法调用与取消入口')
        error.code = 'NOT_SUPPORTED'
        throw error
      }
      return true
    }

    class ZToolsClient {
      constructor(config = {}) {
        const referenceContract = useReferenceClientContract()

        // 初始化通信层
        this.transport = referenceContract ? new ReferenceTransport(config) : new Transport(config)
        this.destroyPromise = null

        // 初始化业务API模块
        this.fs = referenceContract ? new ReferenceFileSystemAPI(this.transport) : new FileSystemAPI(this.transport)
        this.db = new DatabaseAPI(this.transport)
        this.credentials = new CredentialsAPI(this.transport)
        this.sys = new SystemAPI(this.transport)
        this.window = referenceContract ? new ReferenceWindowAPI(this.transport) : new WindowAPI(this.transport)
        this.plugin = new PluginAPI(this.transport)
        this.settings = new SettingsAPI(this.transport)
        this.config = new ConfigAPI(this.transport)
        this.user = new UserAPI(this.transport)

        // 初始化事件系统（需要在clipboard之前）
        this.events = new Events(this.transport)

        // 初始化新增模块 (类似 uTools API) - clipboard需要events
        this.clipboard = referenceContract
          ? new ReferenceClipboardAPI(this.transport, this.events)
          : new ClipboardAPI(this.transport, this.events)
        this.screen = new ScreenAPI(this.transport, this.sys)
        this.shell = new ShellAPI(this.transport)

        // Phase 1 新增模块 (2025-11-21)
        this.network = referenceContract ? new ReferenceNetworkAPI(this.transport) : new NetworkAPI(this.transport)
        this.process = new ProcessAPI(this.transport)
        this.ocr = new OCRAPI(this.transport)

        // 触发器 API (2026-01-14)
        this.trigger = new TriggerAPI(this.transport)

        // 特权与更新 API (2026-01-14)
        this.privileged = new PrivilegedAPI(this.transport)
        this.update = new UpdateAPI(this.transport)

        // 埋点上报 API
        this.analytics = new AnalyticsAPI(this.transport)

        // Phase 2 新增模块 (2025-11-21) - DLL插件方式
        this.image = new ImageAPI(this.transport)
        this.ffmpeg = new FFmpegAPI(this.transport)

        // 初始化 DLL 插件 API（依赖 events）
        this.dllplugin = new DLLPluginAPI(this.transport, this.events)

        // 初始化 Screenshot API（依赖 dllplugin）
        this.screenshot = new ScreenshotAPI(this.dllplugin, this.sys)

        // 初始化 Zip API（依赖 dllplugin）
        this.zip = new ZipAPI(this.dllplugin, this.transport)
        this.sqlite = new ReferenceSQLiteAPI(this.transport)

        // 设置消息接收回调
        this._setupMessageCallback()

        // 初始化完成
        this._initialize()

        // 监听页面卸载，清理待处理的请求（避免 Vite HMR 导致的超时）
        this._setupUnloadHandler()
      }

      // ============ 初始化 ============

      _setupMessageCallback() {
        const electronTransport = this.transport.getElectronTransport()
        if (
          electronTransport &&
          typeof electronTransport.setMessageCallback === 'function'
        ) {
          electronTransport.setMessageCallback((msgType, msgData) => {
            this._handleMessage(msgType, msgData)
          })
          return
        }

        // 设置V8消息回调
        if (
          typeof window.ztools !== 'undefined' &&
          window.ztools &&
          window.ztools._setMessageCallback
        ) {
          window.ztools._setMessageCallback((msgType, msgData) => {
            this._handleMessage(msgType, msgData)
          })
        }
      }

      _handleMessage(msgType, msgData) {
        // 处理接收到的消息
        this.transport.handleMessage(msgType, msgData)

        // 如果是事件信封,分发到事件系统
        if (msgType === 'event_envelope') {
          const envelope =
            msgData && msgData.envelope ? msgData.envelope : msgData || {}
          this.events.dispatchEnvelope(envelope)
        }
      }

      _initialize() {
        // 发送就绪消息
        this.transport
          .call('app_ready', { status: 'initialized' })
          .then(() => {
            // 初始化成功，静默处理
          })
          .catch((err) => {
            console.error('[ztools] Client initialization error:', err)
          })
      }

      _setupUnloadHandler() {
        // 监听页面卸载事件（支持 Vite HMR 等场景）
        if (typeof window !== 'undefined') {
          const cleanup = () => {
            // 页面卸载，清理待处理请求
            this.destroy()
          }

          window.addEventListener('beforeunload', cleanup)
          window.addEventListener('pagehide', cleanup)

          // 监听 Vite HMR 的 vite:beforeUpdate 事件（仅开发环境）
          // 注意：打包后的文件不支持 Vite HMR，这里只处理浏览器环境
          try {
            // 检查是否有 Vite HMR 全局对象（仅开发环境）
            if (typeof window !== 'undefined' && window.__VITE_HMR__) {
              // Vite HMR 在开发环境会自动处理，这里不需要额外处理
            }
          } catch (e) {
            // 忽略错误
          }
        }
      }

      // ============ 生命周期 ============

      /**
       * 销毁客户端,清理资源
       */
      destroy() {
        if (this.destroyPromise) return this.destroyPromise

        this.nativeTooltipInterceptor?.destroy()
        this.destroyPromise = this.events.destroy().finally(() => {
          const electronTransport = this.transport.getElectronTransport()
          if (
            electronTransport &&
            typeof electronTransport.setMessageCallback === 'function'
          ) {
            electronTransport.setMessageCallback(null)
          }
          this.transport.destroy()
        })
        return this.destroyPromise
      }

      /**
       * 获取客户端版本
       */
      getVersion() {
        return '2.0.0'
      }
    }

    // ========================================
    // index.js
    // ========================================

    /**
     * Index - 入口文件
     * 创建全局 API 实例，暴露给前端使用
     */

    // 检查是否已经初始化
    if (window.ztools && window.ztools.fs) {
      console.warn('[ztools] Already initialized, skipping...')
    } else {
      // 创建全局API实例
      const client = new ZToolsClient({
        debug: false, // 关闭调试模式，减少日志噪音
        timeout: 10000
      })

      // SDK 级统一接管：所有加载 ztools-api.js 的 CEF 页面和插件自动生效。
      client.nativeTooltipInterceptor = environment.isCEF()
        ? new NativeTooltipInterceptor(client.window)
        : null

      // 暴露到全局
      // 保存原始的 V8 绑定（如果存在）
      const originalZTools = window.ztools || {}

      // 创建新的 ztools 对象，保留所有 Delphi V8 绑定
      window.ztools = {
        // 新的统一API
        fs: client.fs,
        db: client.db,
        credentials: client.credentials,
        sys: client.sys,
        win: client.window,
        window: client.window,
        plugin: client.plugin,
        settings: client.settings,
        config: client.config,
        user: client.user,
        events: client.events,

        // 新增模块 (类似 uTools API)
        clipboard: client.clipboard,
        screen: client.screen,
        shell: client.shell,

        // Phase 1 新增模块 (2025-11-21)
        network: client.network,
        process: client.process,
        ocr: client.ocr,
        trigger: client.trigger,
        privileged: client.privileged,
        update: client.update,

        // 埋点上报
        analytics: client.analytics,

        // Phase 2 新增模块 (2025-11-21) - DLL插件方式
        image: client.image,
        ffmpeg: client.ffmpeg,

        // DLL 插件 API
        dllplugin: client.dllplugin,

        // Screenshot 截图 API
        screenshot: client.screenshot,

        // Zip 压缩解压 API
        zip: client.zip,

        // SQLite 快照查询 API (GAP-03)
        sqlite: client.sqlite,

        // 🆕 高性能协议 API (无需Base64编码)
        protocol: ZToolsProtocol,

        // IPC 通信管道（Transport 层依赖）
        _sendMessage: originalZTools._sendMessage,
        _setMessageCallback: originalZTools._setMessageCallback,

        // 工具方法
        getVersion: () => client.getVersion(),
        destroy: () => client.destroy(),

        // 环境检测方法
        getEnvironment: () => environment.getInfo(),
        isElectron: () => environment.isElectron(),
        isCEF: () => environment.isCEF(),
        isBrowser: () => environment.isBrowser(),

        // 内部引用（用于调试）
        _client: client,
        _transport: client.transport,
        _environment: environment
      }

      client.nativeTooltipInterceptor?.start()

      // console.log('[ztools] API initialized, version:', client.getVersion())
      // console.log('[ztools] Environment:', environment.getInfo())
    }

})();
