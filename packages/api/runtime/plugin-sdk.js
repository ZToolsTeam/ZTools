/*
  ZTools Plugin SDK
  版本：2.2
  更新日期：2025-12-09

  提供主题联动、生命周期事件、右键菜单等基础功能
  依赖: ztools-api.js
*/
;(function () {
  'use strict'

  const global = window
  const STATE = { initialized: false }
  const ENTER_HANDLERS = new Set()
  const OUT_HANDLERS = new Set()
  const DROP_HANDLERS = new Set()
  let CURRENT_ENTER_META = null

  // ==================== 工具函数 ====================

  /**
   * 统一的日志输出
   */
  function log(...args) {
    console.log('[plugin-sdk]', ...args)
  }

  /**
   * 获取根元素
   */
  function getRoot(opt) {
    return (opt && opt.root) || document.documentElement
  }

  /**
   * 确保只执行一次
   */
  function ensureOnce(key) {
    if (global[key]) return true
    global[key] = true
    return false
  }

  /**
   * 判断是否为插件窗口
   */
  function isPluginWindow() {
    try {
      const href = (global.location && global.location.href) || ''
      const hostname = (global.location && global.location.hostname) || ''
      const protocol = (global.location && global.location.protocol) || ''
      // 支持: /Plugins/ 路径、手动标记、localhost/127.0.0.1 本地开发环境
      return (
        /\/Plugins\//i.test(href) ||
        !!global.__ZTOOLS_PLUGIN_WINDOW__ ||
        (protocol.toLowerCase() === 'ztools:' && hostname.toLowerCase() === 'plugins') ||
        hostname === 'localhost' ||
        hostname === '127.0.0.1'
      )
    } catch (_) {
      return false
    }
  }

  // ==================== 主题管理 ====================

  /**
   * 应用主题
   * @param {boolean} isDark - 是否深色模式
   * @param {object} opt - 配置项
   */
  function applyTheme(isDark, opt) {
    const root = getRoot(opt)
    if (!root) return
    root.classList.toggle('dark', isDark)
  }

  /**
   * 猜测初始主题
   * @returns {boolean} 是否深色模式
   */
  function guessInitialTheme() {
    try {
      if (global.matchMedia) {
        return global.matchMedia('(prefers-color-scheme: dark)').matches
      }
    } catch (error) {
      console.warn('[PluginSDK] 读取系统主题失败:', error)
    }
    return false
  }

  /**
   * 处理深色模式事件
   */
  function onDarkModeEnvelope(envelope, opt) {
    const p = envelope && envelope.payload ? envelope.payload : {}
    const isDark = !!(p.isDark ?? p.dark ?? p.enabled ?? p.value)
    applyTheme(isDark, opt)
    log('theme ->', isDark)
  }

  /**
   * 设置主题监听
   */
  async function setupTheme(opt) {
    const z = global.ztools
    if (!z) {
      console.error('[plugin-sdk] ztools not available')
      return
    }

    const ev = z.events
    if (!ev) {
      console.error('[plugin-sdk] ztools.events not available')
      return
    }

    // 先应用系统主题
    applyTheme(guessInitialTheme(), opt)

    // 从系统信息获取主题
    if (z.sys && typeof z.sys.getInfo === 'function') {
      try {
        const info = await z.sys.getInfo()
        if (info && info.darkMode !== undefined) {
          applyTheme(info.darkMode, opt)
          log('initial theme from ztools.sys.getInfo ->', info.darkMode)
        }
      } catch (e) {
        log('failed to get theme from ztools.sys.getInfo:', e)
      }
    }

    // 使用 on 方法订阅事件，它会自动调用 event_subscribe
    if (typeof ev.on === 'function') {
      ev.on('system.DarkModeChange', (envelope) =>
        onDarkModeEnvelope(envelope, opt)
      )
    }
  }

  // ==================== 文件拖拽管理 ====================

  /**
   * 文件拖拽管理器
   * 提供统一的拖拽视觉反馈，文件路径通过 Delphi WM_DROPFILES -> onFileDrop 回调获取
   */
  const FILE_DROP = {
    enabled: false, // 是否已启用
    dragCounter: 0, // 拖拽计数器（处理子元素进出）
    overlay: null, // 遮罩 DOM 元素
    options: {}, // 配置选项
    handlers: {
      // 事件处理函数引用（用于移除）
      dragenter: null,
      dragleave: null,
      dragover: null,
      drop: null
    }
  }

  /**
   * 注入拖拽遮罩的 CSS 动画样式（只注入一次）
   */
  function injectDropStyles() {
    if (document.getElementById('ztools-drop-styles')) return
    const style = document.createElement('style')
    style.id = 'ztools-drop-styles'
    style.textContent = `
      @keyframes zt-drop-fade-in {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      @keyframes zt-drop-fade-out {
        from { opacity: 1; }
        to   { opacity: 0; }
      }
      @keyframes zt-drop-icon-bounce {
        0%, 100% { transform: translateY(0); }
        50%      { transform: translateY(-6px); }
      }
      @keyframes zt-drop-border-pulse {
        0%, 100% { border-color: var(--plugin-primary, #1890ff); }
        50%      { border-color: color-mix(in srgb, var(--plugin-primary, #1890ff) 50%, transparent); }
      }
      #ztools-file-drop-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483640;
        display: none;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        gap: 16px;
        pointer-events: none;
        background: color-mix(in srgb, var(--plugin-bg, #ffffff) 85%, var(--plugin-primary, #1890ff) 15%);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        border: 2.5px dashed var(--plugin-primary, #1890ff);
        animation: zt-drop-border-pulse 2s ease-in-out infinite;
      }
      #ztools-file-drop-overlay.zt-drop-visible {
        display: flex;
        animation: zt-drop-fade-in 0.18s ease-out forwards, zt-drop-border-pulse 2s ease-in-out 0.18s infinite;
      }
      #ztools-file-drop-overlay.zt-drop-hiding {
        display: flex;
        animation: zt-drop-fade-out 0.15s ease-in forwards;
      }
      #ztools-file-drop-overlay .zt-drop-icon {
        font-size: 44px;
        line-height: 1;
        animation: zt-drop-icon-bounce 1.2s ease-in-out infinite;
      }
      #ztools-file-drop-overlay .zt-drop-text {
        font-size: 15px;
        font-weight: 600;
        color: var(--plugin-primary, #1890ff);
      }
      #ztools-file-drop-overlay .zt-drop-hint {
        font-size: 12px;
        color: var(--plugin-text-secondary, #999);
      }
    `
    document.head.appendChild(style)
  }

  /**
   * 创建拖拽遮罩元素
   */
  function createDropOverlay(options) {
    injectDropStyles()

    const overlay = document.createElement('div')
    overlay.id = 'ztools-file-drop-overlay'

    // 图标
    const icon = document.createElement('div')
    icon.className = 'zt-drop-icon'
    icon.textContent = options.overlayIcon || '📁'

    // 主提示文字
    const text = document.createElement('div')
    text.className = 'zt-drop-text'
    text.textContent = options.overlayText || '拖放文件到此处'

    // 副提示（可选）
    const hint = document.createElement('div')
    hint.className = 'zt-drop-hint'
    hint.textContent = options.overlayHint || ''
    hint.style.display = options.overlayHint ? '' : 'none'

    overlay.appendChild(icon)
    overlay.appendChild(text)
    overlay.appendChild(hint)
    document.body.appendChild(overlay)
    return overlay
  }

  /**
   * 显示/隐藏拖拽遮罩（带动画）
   */
  function showDropOverlay(show) {
    if (!FILE_DROP.overlay) return
    const el = FILE_DROP.overlay

    if (show) {
      // 显示：移除隐藏类和内联 display 样式，添加可见类
      el.classList.remove('zt-drop-hiding')
      el.style.display = ''
      el.classList.add('zt-drop-visible')
    } else {
      // 隐藏：播放退场动画后移除
      if (!el.classList.contains('zt-drop-visible')) return
      el.classList.remove('zt-drop-visible')
      el.classList.add('zt-drop-hiding')
      const onEnd = () => {
        el.classList.remove('zt-drop-hiding')
        el.style.display = 'none'
        el.removeEventListener('animationend', onEnd)
      }
      el.addEventListener('animationend', onEnd, { once: true })
      // 兜底：动画未触发时 200ms 后强制隐藏
      setTimeout(() => {
        if (el.classList.contains('zt-drop-hiding')) {
          el.classList.remove('zt-drop-hiding')
          el.style.display = 'none'
        }
      }, 200)
    }
  }

  /**
   * 启用文件拖拽
   * @param {object} options - 配置选项
   * @param {string} options.overlayText - 遮罩主提示文字
   * @param {string} options.overlayIcon - 遮罩图标
   * @param {string} options.overlayHint - 遮罩副提示（如支持的格式说明）
   */
  function enableFileDrop(options = {}) {
    // 幂等：已启用则先清理再重新启用
    if (FILE_DROP.enabled) {
      disableFileDrop()
    }

    FILE_DROP.options = options
    FILE_DROP.dragCounter = 0
    FILE_DROP.overlay = createDropOverlay(options)

    // 支持浏览器原生拖放视觉状态；路径仍只由宿主可信事件提供。
    FILE_DROP.handlers.dragenter = function (e) {
      if (e.dataTransfer && !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      FILE_DROP.dragCounter += 1
      showDropOverlay(true)
    }

    FILE_DROP.handlers.dragleave = function (e) {
      if (e.dataTransfer && !e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      FILE_DROP.dragCounter = Math.max(0, FILE_DROP.dragCounter - 1)
      if (FILE_DROP.dragCounter === 0) showDropOverlay(false)
    }

    FILE_DROP.handlers.dragover = function (e) {
      e.preventDefault()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy'
      }
    }

    FILE_DROP.handlers.drop = function (e) {
      e.preventDefault()
      e.stopPropagation()
      FILE_DROP.dragCounter = 0
      showDropOverlay(false)
    }

    document.addEventListener('dragenter', FILE_DROP.handlers.dragenter)
    document.addEventListener('dragleave', FILE_DROP.handlers.dragleave)
    document.addEventListener('dragover', FILE_DROP.handlers.dragover)
    document.addEventListener('drop', FILE_DROP.handlers.drop)

    FILE_DROP.enabled = true
    log('fileDrop enabled')
  }

  /**
   * 关闭文件拖拽
   */
  function disableFileDrop() {
    if (!FILE_DROP.enabled) return

    // 移除事件监听
    if (FILE_DROP.handlers.dragenter) {
      document.removeEventListener('dragenter', FILE_DROP.handlers.dragenter)
    }
    if (FILE_DROP.handlers.dragleave) {
      document.removeEventListener('dragleave', FILE_DROP.handlers.dragleave)
    }
    if (FILE_DROP.handlers.dragover) {
      document.removeEventListener('dragover', FILE_DROP.handlers.dragover)
    }
    if (FILE_DROP.handlers.drop) {
      document.removeEventListener('drop', FILE_DROP.handlers.drop)
    }

    // 移除遮罩 DOM
    if (FILE_DROP.overlay && FILE_DROP.overlay.parentNode) {
      FILE_DROP.overlay.parentNode.removeChild(FILE_DROP.overlay)
    }

    FILE_DROP.overlay = null
    FILE_DROP.dragCounter = 0
    FILE_DROP.enabled = false
    FILE_DROP.handlers = {
      dragenter: null,
      dragleave: null,
      dragover: null,
      drop: null
    }
    log('fileDrop disabled')
  }

  // ==================== 窗口控制 ====================
  // 注意：这里控制的是插件窗口自身，而非主窗口
  // 通过发送消息到 Delphi 端的插件窗口处理器

  /**
   * 发送窗口消息的辅助函数
   */
  async function sendWindowMessage(action) {
    try {
      const z = global.ztools
      if (
        z &&
        z.window &&
        typeof z.window[action.replace('window_', '')] === 'function'
      ) {
        const method = action.replace('window_', '')
        await z.window[method]()
        log(`Plugin window action: ${action} (via API)`)
      } else if (z && typeof z._sendMessage === 'function') {
        await z._sendMessage(action, '')
        log(`Plugin window action: ${action} (via _sendMessage)`)
      } else {
        console.error('[plugin-sdk] ztools API or _sendMessage not available')
      }
    } catch (e) {
      console.error(`[plugin-sdk] ${action} error`, e)
    }
  }

  const windowAPI = {
    minimize: () => sendWindowMessage('window_minimize'),
    maximize: () => sendWindowMessage('window_maximize'),
    close: () => sendWindowMessage('window_close'),
    drag: () => sendWindowMessage('window_drag')
  }

  /**
   * 显示关闭确认对话框
   * @returns {Promise<boolean>} 用户是否确认关闭
   */
  async function showCloseConfirmDialog() {
    return new Promise((resolve) => {
      // 创建遮罩层
      const overlay = document.createElement('div')
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2147483646;
      `

      // 创建对话框
      const dialog = document.createElement('div')
      dialog.style.cssText = `
        background: white;
        border-radius: 8px;
        padding: 24px;
        min-width: 320px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
      `

      // 标题
      const title = document.createElement('div')
      title.textContent = '确认关闭'
      title.style.cssText = `
        font-size: 16px;
        font-weight: 600;
        margin-bottom: 12px;
        color: #333;
      `

      // 内容
      const content = document.createElement('div')
      content.textContent = '确定要关闭此窗口吗？'
      content.style.cssText = `
        font-size: 14px;
        margin-bottom: 20px;
        color: #666;
        line-height: 1.5;
      `

      // 按钮容器
      const buttons = document.createElement('div')
      buttons.style.cssText = `
        display: flex;
        gap: 10px;
        justify-content: flex-end;
      `

      // 关闭对话框的通用函数
      const closeDialog = (result) => {
        document.body.removeChild(overlay)
        document.removeEventListener('keydown', handleKeydown)
        resolve(result)
      }

      // 创建按钮的辅助函数
      const createButton = (text, isPrimary, onClick) => {
        const btn = document.createElement('button')
        btn.textContent = text
        btn.style.cssText = `
          padding: 8px 20px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          transition: all 0.2s;
          ${
            isPrimary
              ? 'border: none; background: #e53e3e; color: white;'
              : 'border: 1px solid #ddd; background: white; color: #333;'
          }
        `
        btn.onmouseover = () => {
          btn.style.background = isPrimary ? '#c53030' : '#f5f5f5'
        }
        btn.onmouseout = () => {
          btn.style.background = isPrimary ? '#e53e3e' : 'white'
        }
        btn.onclick = onClick
        return btn
      }

      const cancelBtn = createButton('取消', false, () => closeDialog(false))
      const confirmBtn = createButton('关闭', true, () => closeDialog(true))

      buttons.appendChild(cancelBtn)
      buttons.appendChild(confirmBtn)

      dialog.appendChild(title)
      dialog.appendChild(content)
      dialog.appendChild(buttons)
      overlay.appendChild(dialog)

      document.body.appendChild(overlay)

      // ESC 键关闭
      const handleKeydown = (e) => {
        if (e.key === 'Escape') {
          closeDialog(false)
        }
      }
      document.addEventListener('keydown', handleKeydown)

      confirmBtn.focus()
    })
  }

  // ==================== 原生标题栏集成（不再注入网页标题栏） ====================
  // 原生端（Delphi）在插件窗口关闭按钮点击时会优先调用 window.__ztools_close_handler。
  // 这里只保留“响应逻辑”：弹出确认框 -> 用户确认 -> 发送 window_close。
  if (isPluginWindow()) {
    window.__ztools_close_handler = async () => {
      const confirmed = await showCloseConfirmDialog()
      if (confirmed && windowAPI) {
        windowAPI.close()
      }
    }
  }

  // ==================== 生命周期事件 ====================

  /**
   * 注册一个生命周期回调，并返回只注销本次注册的幂等清理函数。
   */
  function subscribeLifecycleHandler(handlers, callback) {
    if (typeof callback !== 'function') return undefined

    const registration = { callback }
    handlers.add(registration)
    let subscribed = true

    return () => {
      if (!subscribed) return
      subscribed = false
      handlers.delete(registration)
    }
  }

  /**
   * 注册一个文件拖放回调，并返回只注销本次注册的幂等清理函数。
   */
  function referenceDropPayload(data) {
    const invalid = () => { throw new Error('SDK2 文件拖放数据无效') }
    if (global.__ztoolsElectron?.contractVersion !== 2 || !data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).some(key => !['contractVersion', 'files', 'errors'].includes(key)) || data.contractVersion !== 2 ||
        !Array.isArray(data.files) || data.files.length > 100 || !Array.isArray(data.errors) || data.errors.length > 100) invalid()
    const ids = new Set()
    const files = data.files.map(file => {
      if (!file || typeof file !== 'object' || Array.isArray(file) ||
          Object.keys(file).some(key => !['grantId', 'displayName', 'kind', 'operations', 'fileUrl'].includes(key)) ||
          typeof file.grantId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(file.grantId) || ids.has(file.grantId) ||
          file.kind !== 'file' || typeof file.displayName !== 'string' || !file.displayName || /[\/\0]/.test(file.displayName) ||
          /^\.ztools-save-/i.test(file.displayName) || new TextEncoder().encode(file.displayName).length > 4096 ||
          !Array.isArray(file.operations) || file.operations.length !== 1 || file.operations[0] !== 'read' ||
          file.fileUrl !== 'ztools://file/' + file.grantId + '/' + encodeURIComponent(file.displayName)) invalid()
      ids.add(file.grantId)
      return Object.freeze({ grantId: file.grantId, displayName: file.displayName, kind: 'file',
        operations: Object.freeze(['read']), fileUrl: file.fileUrl })
    })
    const errors = data.errors.map(error => {
      if (!error || typeof error !== 'object' || Array.isArray(error) || Object.keys(error).some(key => !['index', 'code', 'message'].includes(key)) ||
          !Number.isSafeInteger(error.index) || error.index < -1 || error.index >= 100 || typeof error.code !== 'string' ||
          !/^[A-Z][A-Z0-9_]{0,127}$/.test(error.code) || typeof error.message !== 'string' || new TextEncoder().encode(error.message).length > 4096) invalid()
      return Object.freeze({ index: error.index, code: error.code, message: error.message })
    })
    return { files: Object.freeze(files), errors: Object.freeze(errors) }
  }

  function subscribeFileDropHandler(callback) {
    if (typeof callback !== 'function') return undefined
    if (global.__ztoolsElectron?.contractVersion === 2 && DROP_HANDLERS.size >= 256) {
      const error = new Error('文件拖放监听超过256项'); error.code = 'FILE_TOO_LARGE'; throw error
    }

    const registration = { callback }
    DROP_HANDLERS.add(registration)
    let subscribed = true

    return () => {
      if (!subscribed) return
      subscribed = false
      DROP_HANDLERS.delete(registration)
    }
  }

  /**
   * 挂载后端事件监听
   */
  function hookBackendEvents() {
    if (global.__ztools_plugin_enter_exit_hooked) return
    global.__ztools_plugin_enter_exit_hooked = true

    const events = global.ztools?.events
    if (!events || typeof events.on !== 'function') {
      console.error('[plugin-sdk] ztools.events not available')
      return
    }

    log('Using ztools.events system')

    // 插件进入事件
    events.on('plugin_enter', (envelope) => {
      try {
        CURRENT_ENTER_META = envelope.data || envelope.payload || envelope
        for (const registration of Array.from(ENTER_HANDLERS)) {
          if (!ENTER_HANDLERS.has(registration)) continue
          try {
            const callback = registration.callback
            callback(CURRENT_ENTER_META)
          } catch (e) {
            console.error('onPluginEnter handler error', e)
          }
        }
      } catch (e) {
        console.error('plugin_enter dispatch error', e)
      }
    })

    // 退出确认只报告本次回调结果；落盘和owner身份由Main另行校验。
    let activeExitRequest = null
    let completedExitRequest = null
    events.on('plugin_out', async (envelope) => {
      const requestId = envelope?.source?.kind === 'host' &&
        typeof envelope.envelopeId === 'string' &&
        envelope.correlationId === envelope.envelopeId ? envelope.envelopeId : null
      if (requestId && (activeExitRequest === requestId || completedExitRequest === requestId)) return
      if (requestId && activeExitRequest) {
        try { await events.respond(requestId, { ok: false }, { scope: 'plugin' }) }
        catch { console.error('plugin_out acknowledgement failed') }
        return
      }
      if (requestId) activeExitRequest = requestId
      let ok = true
      try {
        const data = envelope.data || envelope.payload || envelope
        if (requestId && typeof data.isKill !== 'boolean') throw new Error('INVALID_EXIT_PAYLOAD')
        const results = []
        for (const registration of Array.from(OUT_HANDLERS)) {
          if (!OUT_HANDLERS.has(registration)) continue
          try { results.push(Promise.resolve(registration.callback(!!data.isKill))) }
          catch { ok = false; console.error('onPluginOut handler error') }
        }
        const settled = await Promise.allSettled(results)
        if (settled.some(result => result.status === 'rejected')) {
          ok = false
          console.error('onPluginOut handler error')
        }
        CURRENT_ENTER_META = null
      } catch {
        ok = false
        console.error('plugin_out dispatch error')
      }
      if (requestId) {
        completedExitRequest = requestId
        activeExitRequest = null
        try { await events.respond(requestId, { ok }, { scope: 'plugin' }) }
        catch { console.error('plugin_out acknowledgement failed') }
      }
    })

    // 文件拖放事件
    events.on('plugin_files_dropped', (envelope) => {
      try {
        // 立即隐藏遮罩
        showDropOverlay(false)
        // 重置拖拽计数器，确保状态干净
        FILE_DROP.dragCounter = 0
        let data = envelope.data || envelope.payload || envelope
        if (global.__ztoolsElectron?.contractVersion === 2 || data?.contractVersion !== undefined) data = referenceDropPayload(data)
        if (data?.files) {
          for (const registration of Array.from(DROP_HANDLERS)) {
            if (!DROP_HANDLERS.has(registration)) continue
            try {
              registration.callback(data.files, Array.isArray(data.errors) ? data.errors : [])
            } catch (e) {
              console.error('onFileDrop handler error', e)
            }
          }
        }
      } catch (e) {
        console.error('plugin_files_dropped dispatch error', e)
      }
    })

    // 拖拽进入事件（Delphi CEF OnDragEnter 触发）
    events.on('plugin_drag_enter', () => {
      if (FILE_DROP.enabled) {
        showDropOverlay(true)
      }
    })

    // 拖拽离开事件（Delphi 端 drop 完成或兜底定时器触发）
    // 仅在遮罩当前处于显示状态时执行隐藏，已隐藏时忽略
    events.on('plugin_drag_leave', () => {
      FILE_DROP.dragCounter = 0
      if (
        FILE_DROP.enabled &&
        FILE_DROP.overlay &&
        FILE_DROP.overlay.classList.contains('zt-drop-visible')
      ) {
        showDropOverlay(false)
      }
    })
  }

  // ==================== 右键菜单 ====================

  /**
   * 右键菜单类
   */
  class ContextMenu {
    constructor() {
      this.menuElement = null
      this.menuItems = []
      this.visible = false
      this.x = 0
      this.y = 0
      this.onBeforeShow = null
      this.injectStyles()
      this.createMenuElement()
      this.bindEvents()
    }

    /**
     * 注入菜单样式
     */
    injectStyles() {
      if (document.getElementById('ztools-context-menu-styles')) return

      const style = document.createElement('style')
      style.id = 'ztools-context-menu-styles'
      style.textContent = `
        /* ===== 菜单容器 ===== */
        .ztools-context-menu {
          position: fixed;
          z-index: 99999;
          min-width: 180px;
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          padding: 4px 0;
          user-select: none;
          font-size: 14px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
                       'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
          opacity: 0;
          transform: scale(0.95);
          transition: opacity 0.15s ease, transform 0.15s ease;
        }

        .ztools-context-menu.show {
          opacity: 1;
          transform: scale(1);
        }

        /* ===== 深色模式 ===== */
        .dark .ztools-context-menu {
          background: #1f2937;
          border-color: #374151;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        }

        /* ===== 菜单项 ===== */
        .ztools-context-menu-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 16px;
          cursor: pointer;
          transition: background-color 0.15s ease;
          color: #374151;
        }

        .dark .ztools-context-menu-item {
          color: #e5e7eb;
        }

        .ztools-context-menu-item:hover:not(.disabled) {
          background-color: #f3f4f6;
        }

        .dark .ztools-context-menu-item:hover:not(.disabled) {
          background-color: #374151;
        }

        .ztools-context-menu-item:active:not(.disabled) {
          transform: scale(0.98);
        }

        .ztools-context-menu-item.disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        /* ===== 菜单图标 ===== */
        .ztools-context-menu-icon {
          font-size: 16px;
          flex-shrink: 0;
          width: 16px;
          height: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        /* ===== 菜单标签 ===== */
        .ztools-context-menu-label {
          flex: 1;
          white-space: nowrap;
        }

        /* ===== 分隔线 ===== */
        .ztools-context-menu-separator {
          height: 1px;
          background-color: #e5e7eb;
          margin: 4px 8px;
        }

        .dark .ztools-context-menu-separator {
          background-color: #4b5563;
        }
      `
      document.head.appendChild(style)
    }

    /**
     * 创建菜单元素
     */
    createMenuElement() {
      this.menuElement = document.createElement('div')
      this.menuElement.className = 'ztools-context-menu'
      this.menuElement.style.display = 'none'
      document.body.appendChild(this.menuElement)
    }

    /**
     * 绑定事件
     */
    bindEvents() {
      // 点击外部关闭菜单
      document.addEventListener('click', (e) => {
        if (this.visible && !this.menuElement.contains(e.target)) {
          this.hide()
        }
      })

      // 窗口失焦关闭菜单
      window.addEventListener('blur', () => {
        if (this.visible) this.hide()
      })

      // ESC 键关闭菜单
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.visible) {
          this.hide()
        }
      })
    }

    /**
     * 设置菜单项
     */
    setItems(items) {
      this.menuItems = items || []
      return this
    }

    /**
     * 显示菜单
     */
    show(event) {
      event.preventDefault()
      event.stopPropagation()

      // 如果有 beforeShow 回调，先执行
      if (this.onBeforeShow && this.onBeforeShow(event) === false) {
        return
      }

      this.x = event.clientX
      this.y = event.clientY

      // 渲染菜单
      this.render()

      // 显示菜单
      this.menuElement.style.display = 'block'
      this.menuElement.style.left = `${this.x}px`
      this.menuElement.style.top = `${this.y}px`

      // 调整位置防止超出屏幕
      requestAnimationFrame(() => {
        const rect = this.menuElement.getBoundingClientRect()
        const { innerWidth, innerHeight } = window

        if (rect.right > innerWidth) {
          this.menuElement.style.left = `${innerWidth - rect.width - 5}px`
        }

        if (rect.bottom > innerHeight) {
          this.menuElement.style.top = `${innerHeight - rect.height - 5}px`
        }

        // 添加显示动画
        this.menuElement.classList.add('show')
      })

      this.visible = true
    }

    /**
     * 隐藏菜单
     */
    hide() {
      this.menuElement.classList.remove('show')
      setTimeout(() => {
        this.menuElement.style.display = 'none'
        this.visible = false
      }, 150)
    }

    /**
     * 渲染菜单
     */
    render() {
      this.menuElement.innerHTML = ''

      this.menuItems.forEach((item) => {
        if (item.type === 'separator') {
          const separator = document.createElement('div')
          separator.className = 'ztools-context-menu-separator'
          this.menuElement.appendChild(separator)
          return
        }

        const menuItem = document.createElement('div')
        menuItem.className = 'ztools-context-menu-item'
        if (item.disabled) {
          menuItem.classList.add('disabled')
        }

        // 图标
        if (item.icon) {
          const icon = document.createElement('span')
          icon.className = 'ztools-context-menu-icon'
          icon.innerHTML = item.icon
          menuItem.appendChild(icon)
        }

        // 标签
        const label = document.createElement('span')
        label.className = 'ztools-context-menu-label'
        label.textContent = item.label || ''
        menuItem.appendChild(label)

        // 点击事件
        if (!item.disabled && item.onClick) {
          menuItem.addEventListener('click', (e) => {
            e.stopPropagation()
            item.onClick(item)
            this.hide()
          })
        }

        this.menuElement.appendChild(menuItem)
      })
    }

    /**
     * 设置 beforeShow 回调
     */
    beforeShow(callback) {
      this.onBeforeShow = callback
      return this
    }

    /**
     * 销毁菜单
     */
    destroy() {
      if (this.menuElement) {
        this.menuElement.remove()
        this.menuElement = null
      }
    }
  }

  /**
   * 创建右键菜单实例
   */
  function createContextMenu(options = {}) {
    const menu = new ContextMenu()

    // 设置菜单项
    if (options.items) {
      menu.setItems(options.items)
    }

    // 设置 beforeShow 回调
    if (options.beforeShow) {
      menu.beforeShow(options.beforeShow)
    }

    // 绑定目标元素
    if (options.target) {
      const target =
        typeof options.target === 'string'
          ? document.querySelector(options.target)
          : options.target

      if (target) {
        target.addEventListener('contextmenu', (e) => menu.show(e))
      }
    } else if (options.global !== false) {
      // 默认绑定到全局
      document.addEventListener('contextmenu', (e) => menu.show(e))
    }

    return menu
  }

  // ==================== 初始化 ====================

  /**
   * SDK 初始化
   */
  async function init(options = {}) {
    if (STATE.initialized) return
    STATE.initialized = true

    // 设置主题
    if (!global.ztools) {
      setTimeout(() => setupTheme(options), 0)
    } else {
      setupTheme(options)
    }

    // 挂载事件监听
    hookBackendEvents()
  }

  // 自动初始化
  function autoInit() {
    init({})
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoInit, { once: true })
  } else {
    autoInit()
  }

  // ==================== 导出 API ====================

  global.ztoolsPlugin = {
    // 核心方法
    init,
    applyTheme,
    guessInitialTheme,

    // 生命周期事件
    onPluginEnter(cb) {
      return subscribeLifecycleHandler(ENTER_HANDLERS, cb)
    },
    onPluginOut(cb) {
      return subscribeLifecycleHandler(OUT_HANDLERS, cb)
    },
    onFileDrop(cb) {
      return subscribeFileDropHandler(cb)
    },
    getCurrentPluginMeta() {
      return CURRENT_ENTER_META
    },

    // 文件拖拽开关
    enableFileDrop,
    disableFileDrop,

    // 右键菜单
    createContextMenu,
    ContextMenu
  }
})()
