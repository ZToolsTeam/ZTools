/**
 * Index - 入口文件
 * 创建全局 API 实例，暴露给前端使用
 */

/**
 * 遍历目标对象原型链上的非 constructor 方法并绑定 this 到实例自身，
 * 防止调用方解构（如 const { get } = window.ztools.config）时丢失 this 上下文。
 * @param {object|Function} target - 待绑定的 API 实例或静态方法类
 * @returns {object|Function} 绑定后的原目标
 */
function bindApiMethods(target) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) {
    return target
  }

  // 静态方法类（如 ZToolsProtocol）：绑定自身可调用静态方法
  if (typeof target === 'function') {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (key === 'length' || key === 'name' || key === 'prototype') continue
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      if (descriptor && typeof descriptor.value === 'function' && descriptor.configurable) {
        Object.defineProperty(target, key, {
          value: descriptor.value.bind(target),
          writable: true,
          enumerable: descriptor.enumerable,
          configurable: true
        })
      }
    }
    return target
  }

  const seen = new Set()
  let proto = Object.getPrototypeOf(target)
  while (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || seen.has(key)) continue
      seen.add(key)
      if (Object.prototype.hasOwnProperty.call(target, key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(proto, key)
      if (descriptor && typeof descriptor.value === 'function') {
        Object.defineProperty(target, key, {
          value: descriptor.value.bind(target),
          writable: true,
          enumerable: descriptor.enumerable,
          configurable: true
        })
      }
    }
    proto = Object.getPrototypeOf(proto)
  }
  return target
}

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

  // 嵌套子模块实例方法绑定
  if (client.credentials?.v1) {
    bindApiMethods(client.credentials.v1)
  }

  // 创建新的 ztools 对象，保留所有 Delphi V8 绑定并加固所有模块实例方法绑定
  window.ztools = {
    // 新的统一API
    fs: bindApiMethods(client.fs),
    db: bindApiMethods(client.db),
    credentials: bindApiMethods(client.credentials),
    sys: bindApiMethods(client.sys),
    win: bindApiMethods(client.window),
    window: client.window,
    plugin: bindApiMethods(client.plugin),
    settings: bindApiMethods(client.settings),
    config: bindApiMethods(client.config),
    events: bindApiMethods(client.events),

    // 新增模块 (类似 uTools API)
    clipboard: bindApiMethods(client.clipboard),
    screen: bindApiMethods(client.screen),
    shell: bindApiMethods(client.shell),

    // Phase 1 新增模块 (2025-11-21)
    network: bindApiMethods(client.network),
    process: bindApiMethods(client.process),
    ocr: bindApiMethods(client.ocr),
    trigger: bindApiMethods(client.trigger),
    privileged: bindApiMethods(client.privileged),
    update: bindApiMethods(client.update),

    // Phase 2 新增模块 (2025-11-21) - DLL插件方式
    image: bindApiMethods(client.image),
    ffmpeg: bindApiMethods(client.ffmpeg),

    // DLL 插件 API
    dllplugin: bindApiMethods(client.dllplugin),

    // Screenshot 截图 API
    screenshot: bindApiMethods(client.screenshot),

    // Zip 压缩解压 API
    zip: bindApiMethods(client.zip),

    // SQLite 快照查询 API (GAP-03)
    sqlite: bindApiMethods(client.sqlite),

    // 🆕 高性能协议 API (无需Base64编码)
    protocol: bindApiMethods(ZToolsProtocol),

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
    _transport: bindApiMethods(client.transport),
    _environment: environment
  }

  client.nativeTooltipInterceptor?.start()

  // 幂等订阅宿主语言热切换事件（不依赖 plugin-sdk.js，避免重复绑定）
  if (
    !window.__ztools_api_locale_hooked &&
    client.events &&
    typeof client.events.on === 'function'
  ) {
    window.__ztools_api_locale_hooked = true
    client.events.on('system.LocaleChange', (envelope) => {
      try {
        const payload = envelope && (envelope.payload || envelope.data || envelope)
        const nextLocale = typeof payload === 'string' ? payload : payload && payload.locale
        if (typeof nextLocale === 'string' && nextLocale.trim().length > 0) {
          applyApiLocaleChange(nextLocale)
        }
      } catch (err) {
        console.error('[ztools] system.LocaleChange dispatch error:', err)
      }
    })
  }

  // console.log('[ztools] API initialized, version:', client.getVersion())
  // console.log('[ztools] Environment:', environment.getInfo())
}
