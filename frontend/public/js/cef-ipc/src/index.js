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
