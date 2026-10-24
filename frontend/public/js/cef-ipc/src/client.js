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
