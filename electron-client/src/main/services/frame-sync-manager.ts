export type FrameSyncState =
  | 'unattached'
  | 'visible'
  | 'hidden'
  | 'suspend_pending'
  | 'suspended'
  | 'resuming'
  | 'destroyed'

export interface ManagedWebContents {
  isDestroyed(): boolean
  setBackgroundThrottling(allowed: boolean): void
  setFrameRate?(fps: number): void
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  session?: {
    clearCache?(): Promise<void>
  }
}

export interface ManagedWindow {
  isVisible(): boolean
  isMinimized(): boolean
  isDestroyed(): boolean
  show(): void
  hide(): void
  focus(): void
  restore(): void
  readonly webContents: ManagedWebContents
  on(event: 'show' | 'hide' | 'close' | 'closed' | 'focus' | 'blur', listener: () => void): unknown
  removeListener(event: string, listener: () => void): unknown
}

export interface FrameSyncManagerOptions {
  /**
   * 窗口隐藏多久后触发挂起并释放 GPU 显存（默认 15000 毫秒 = 15秒）
   */
  suspendTimeoutMs?: number
  /**
   * requestAnimationFrame 首帧渲染确认超时保底时间（默认 300 毫秒）
   */
  frameSyncTimeoutMs?: number
  /**
   * 运行平台标识（传入 'darwin' 时自动跳过隐藏窗口的 rAF 阻塞等待，避免 macOS NSWindow Occlusion 导致超时死等）
   */
  platform?: NodeJS.Platform
  /**
   * 是否在窗口隐藏时跳过 show() 之前的 rAF 首帧等待
   */
  skipHiddenFrameWait?: boolean
  /**
   * 挂起触发回调（用于显存清理通知或监控）
   */
  onSuspend?: (window: ManagedWindow) => void | Promise<void>
  /**
   * 恢复完成回调
   */
  onResume?: (window: ManagedWindow) => void | Promise<void>
  /**
   * 挂起时内存深度瘦身回调（触发 EmptyWorkingSet 与侧车内存整理）
   */
  trimMemory?: () => void | Promise<void>
  /**
   * 日志输出
   */
  logger?: (level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: unknown) => void
}

/**
 * 双重缓冲与帧同步渲染控制器 (Frame Sync & Suspend Controller)
 *
 * 核心治理能力：
 * 首次显示或挂起恢复：hidden/suspended → resuming → visible。
 * 短时间内再次显示：suspend_pending → visible，复用已绘制内容，不等待隐藏页 rAF。
 * 隐藏/解绑会撤销 resuming；旧异步回调不得再次显示窗口或覆盖新请求。
 * 隐藏 15 秒后开启后台限频；HTTP 缓存并非 GPU 缓存，不应随显隐清理。
 */
export class FrameSyncManager {
  readonly #suspendTimeoutMs: number
  readonly #frameSyncTimeoutMs: number
  readonly #skipHiddenFrameWait: boolean
  readonly #onSuspend: ((window: ManagedWindow) => void | Promise<void>) | undefined
  readonly #onResume: ((window: ManagedWindow) => void | Promise<void>) | undefined
  readonly #trimMemory: (() => void | Promise<void>) | undefined
  readonly #logger: ((level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: unknown) => void) | undefined

  #window: ManagedWindow | null = null
  #state: FrameSyncState = 'unattached'
  #suspendTimer: NodeJS.Timeout | null = null
  #resumingPromise: Promise<void> | null = null
  #resumeAbort: AbortController | null = null
  #hasPresentedFrame = false
  #disposed = false

  readonly #listeners: Array<{ event: string; listener: () => void }> = []

  constructor(options: FrameSyncManagerOptions = {}) {
    this.#suspendTimeoutMs = Math.max(10, options.suspendTimeoutMs ?? 15000)
    this.#frameSyncTimeoutMs = Math.max(10, options.frameSyncTimeoutMs ?? 300)
    this.#skipHiddenFrameWait = options.skipHiddenFrameWait ?? (options.platform === 'darwin')
    this.#onSuspend = options.onSuspend
    this.#onResume = options.onResume
    this.#trimMemory = options.trimMemory
    this.#logger = options.logger
  }

  get state(): FrameSyncState {
    return this.#state
  }

  get isAttached(): boolean {
    return this.#window !== null && !this.#window.isDestroyed()
  }

  /**
   * 绑定受管窗口
   */
  attach(window: ManagedWindow): void {
    if (this.#disposed) {
      throw new Error('FrameSyncManager 已销毁，无法重新绑定')
    }
    if (this.#window) {
      this.detach()
    }
    this.#window = window

    if (window.isDestroyed()) {
      this.#state = 'destroyed'
      return
    }
    this.#hasPresentedFrame = window.isVisible()

    const onShow = (): void => {
      if (this.#window !== window || !window.isVisible()) return
      this.#cancelSuspendTimer()
      if (this.#state !== 'resuming') {
        this.#state = 'visible'
      }
    }

    const onHide = (): void => {
      if (this.#state === 'destroyed' || this.#disposed || this.#window !== window || window.isVisible()) return
      this.#cancelResume()
      this.#state = 'suspend_pending'
      this.#scheduleSuspendTimer()
    }

    const onClose = (): void => {
      this.#cancelSuspendTimer()
    }

    const onClosed = (): void => {
      this.#cancelSuspendTimer()
      this.#state = 'destroyed'
      this.detach()
    }

    this.#addListener(window, 'show', onShow)
    this.#addListener(window, 'hide', onHide)
    this.#addListener(window, 'close', onClose)
    this.#addListener(window, 'closed', onClosed)

    if (window.isVisible()) {
      this.#state = 'visible'
    } else {
      this.#state = 'suspend_pending'
      this.#scheduleSuspendTimer()
    }

    this.#log('INFO', 'FrameSyncManager attached to window', {
      initialState: this.#state,
      suspendTimeoutMs: this.#suspendTimeoutMs
    })
  }

  /**
   * 解绑受管窗口
   */
  detach(): void {
    this.#cancelResume()
    this.#cancelSuspendTimer()
    this.#hasPresentedFrame = false
    if (this.#window) {
      for (const { event, listener } of this.#listeners) {
        try {
          this.#window.removeListener(event, listener)
        } catch {
          this.#log('WARN', '移除窗口监听器失败')
        }
      }
      this.#listeners.length = 0
      this.#window = null
    }
    if (this.#state !== 'destroyed') {
      this.#state = 'unattached'
    }
  }

  /**
   * 复用热窗口；首次显示或挂起恢复才等待首帧，并允许隐藏请求取消等待。
   */
  showWindow(): Promise<void> {
    if (!this.#window || this.#window.isDestroyed()) {
      return Promise.reject(new Error('受管窗口未挂载或已销毁'))
    }

    const win = this.#window

    if (win.isMinimized()) {
      win.restore()
    }

    // 已完全可见且不需要帧同步唤醒
    if (win.isVisible() && this.#state === 'visible') {
      win.focus()
      return Promise.resolve()
    }

    // 取消挂起计时器
    this.#cancelSuspendTimer()

    // 若当前已在唤醒同步流程中，复用该 Promise
    if (this.#resumingPromise) {
      return this.#resumingPromise
    }

    const skipWaitWhileHidden = this.#skipHiddenFrameWait && !win.isVisible()
    const needsFrameSync = (!this.#hasPresentedFrame || this.#state === 'suspended') && !skipWaitWhileHidden
    const resumeAbort = new AbortController()
    this.#resumeAbort = resumeAbort
    const isCurrent = (): boolean => !resumeAbort.signal.aborted &&
      !this.#disposed && this.#window === win && !win.isDestroyed()

    const resumeAction = async (): Promise<void> => {
      this.#state = 'resuming'
      const webContents = win.webContents

      if (!webContents.isDestroyed()) {
        // 1. 解除后台限频
        webContents.setBackgroundThrottling(false)
        webContents.setFrameRate?.(60)

        if (needsFrameSync) {
          await this.#waitForFirstFrame(webContents, this.#frameSyncTimeoutMs, resumeAbort.signal)
        }
      }

      // 3. 确认首帧绘制完成后，再映射原生窗口并聚焦
      if (isCurrent()) {
        win.show()
        if (!isCurrent()) return
        win.focus()
        if (!isCurrent()) return
        this.#hasPresentedFrame = true
        this.#state = 'visible'
        this.#log('INFO', 'Window presented with frame sync confirmed')
        if (this.#onResume) {
          try {
            await this.#onResume(win)
          } catch (callbackErr) {
            this.#log('WARN', 'onResume 回调执行异常', callbackErr)
          }
        }
      }
    }

    const resumingPromise = resumeAction().finally(() => {
      if (this.#resumeAbort === resumeAbort) {
        this.#resumeAbort = null
        this.#resumingPromise = null
      }
    })
    // show/focus 可同步触发 blur → hide，不得把刚取消的请求重新写回。
    if (this.#resumeAbort === resumeAbort) this.#resumingPromise = resumingPromise
    return resumingPromise
  }

  /**
   * 隐藏窗口并进入挂起倒计时（15 秒）
   */
  hideWindow(): void {
    if (!this.#window || this.#window.isDestroyed()) return
    this.#cancelResume()
    this.#cancelSuspendTimer()
    if (this.#window.isVisible()) this.#window.hide()
    this.#state = 'suspend_pending'
    this.#scheduleSuspendTimer()
  }

  /**
   * 挂起后台渲染，并按宿主能力整理内存
   */
  async suspend(): Promise<void> {
    if (!this.#window || this.#window.isDestroyed()) return
    if (this.#state === 'visible' || this.#state === 'resuming' || this.#state === 'suspended') {
      // 正在显示或恢复中，不强制挂起
      return
    }

    this.#cancelSuspendTimer()
    this.#state = 'suspended'
    const win = this.#window
    const webContents = win.webContents

    if (!webContents.isDestroyed()) {
      // 1. 启动后台渲染降频（节约 CPU/GPU）
      webContents.setBackgroundThrottling(true)
      webContents.setFrameRate?.(1)

    }

    // 4. 深度工作集物理页置换与垃圾回收 (WorkingSet Trim)
    try {
      if (typeof globalThis.gc === 'function') {
        globalThis.gc()
      }
      if (this.#trimMemory) {
        await this.#trimMemory()
      }
    } catch (trimErr) {
      this.#log('WARN', '内存深度瘦身执行异常', trimErr)
    }

    if (this.#disposed || this.#window !== win || win.isDestroyed() || win.isVisible() || this.#state !== 'suspended') return
    this.#log('INFO', 'Window entered suspended state')

    if (this.#onSuspend) {
      try {
        await this.#onSuspend(win)
      } catch (err) {
        this.#log('WARN', 'onSuspend 回调执行异常', err)
      }
    }
  }

  /**
   * 释放控制器
   */
  dispose(): void {
    this.#disposed = true
    this.detach()
  }

  #scheduleSuspendTimer(): void {
    this.#cancelSuspendTimer()
    this.#suspendTimer = setTimeout(() => {
      this.#suspendTimer = null
      void this.suspend().catch((err) => {
        this.#log('ERROR', '执行挂起释放失败', err)
      })
    }, this.#suspendTimeoutMs)
  }

  #cancelSuspendTimer(): void {
    if (this.#suspendTimer !== null) {
      clearTimeout(this.#suspendTimer)
      this.#suspendTimer = null
    }
  }

  #cancelResume(): void {
    this.#resumeAbort?.abort()
    this.#resumeAbort = null
    this.#resumingPromise = null
  }

  #addListener(win: ManagedWindow, event: 'show' | 'hide' | 'close' | 'closed', listener: () => void): void {
    win.on(event, listener)
    this.#listeners.push({ event, listener })
  }

  /**
   * 等待 Web 侧 requestAnimationFrame 首帧渲染完成（双重缓冲回调）
   */
  async #waitForFirstFrame(webContents: ManagedWebContents, timeoutMs: number, signal: AbortSignal): Promise<void> {
    const frameScript = `
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(true);
          });
        });
      })
    `

    let timeoutHandle: NodeJS.Timeout | null = null
    let cancelWait: () => void = () => undefined
    const timeoutPromise = new Promise<void>((resolve) => {
      cancelWait = resolve
      signal.addEventListener('abort', cancelWait, { once: true })
      timeoutHandle = setTimeout(resolve, timeoutMs)
    })

    try {
      const jsPromise = webContents.executeJavaScript(frameScript).catch((error: unknown) => {
        this.#log('WARN', '首帧确认失败，使用原生窗口呈现', error)
      })
      await Promise.race([jsPromise, timeoutPromise])
    } finally {
      signal.removeEventListener('abort', cancelWait)
      if (timeoutHandle !== null) clearTimeout(timeoutHandle)
    }
  }

  #log(level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: unknown): void {
    if (this.#logger) {
      this.#logger(level, message, data)
    }
  }
}

// =========================================================================
// 快捷键防注销保护器 (HotKey Anti-Deregistration Protector)
// =========================================================================

export interface GlobalShortcutApi {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  isRegistered(accelerator: string): boolean
}

export interface HookIsolationEvent {
  type: 'stalled' | 'crashed' | 'restarted' | 'recovered'
  detail?: unknown
}

export interface HookIsolationPort {
  readonly isIsolated: boolean
  readonly isAlive: boolean
  onLifecycleEvent(listener: (event: HookIsolationEvent) => void): () => void
}

export interface RegisteredHotKeyEntry {
  id: string
  accelerator: string
  handler: () => void
  registeredAt: number
  lastVerifiedAt: number
  status: 'active' | 'conflicted' | 'deregistered'
}

export interface HotKeyProtectorOptions {
  shortcutApi: GlobalShortcutApi
  hookPort?: HookIsolationPort
  watchdogIntervalMs?: number
  logger?: (level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: unknown) => void
}

/**
 * 快捷键防注销保护器 (HotKey Anti-Deregistration Protector)
 *
 * 核心保护机制：
 * 1. 严格 RegisterHotKey 映射表：精确记录每个快捷键的绑定元数据与状态。
 * 2. 看门狗巡检与自愈（防注销）：定期或在系统休眠唤醒、焦点变化时主动检查 isRegistered，
 *    一旦发现被第三方软件占用或系统静默注销，立即发起冲突诊断与自动重新注册。
 * 3. 底层钩子独立线程隔离：与 NativeHost32 独立进程/线程配合，解耦主 UI 线程卡顿，
 *    杜绝因 Windows LowLevelHooksTimeout 超时导致的底层钩子被系统强制摘除。
 */
export class HotKeyProtector {
  readonly #shortcutApi: GlobalShortcutApi
  readonly #hookPort: HookIsolationPort | null
  readonly #watchdogIntervalMs: number
  readonly #logger: ((level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: unknown) => void) | undefined

  readonly #entries = new Map<string, RegisteredHotKeyEntry>()
  readonly #acceleratorToId = new Map<string, string>()

  #watchdogTimer: NodeJS.Timeout | null = null
  #removeHookListener: (() => void) | null = null
  #disposed = false

  // 监控统计指标
  #repairedCount = 0
  #conflictCount = 0

  constructor(options: HotKeyProtectorOptions) {
    this.#shortcutApi = options.shortcutApi
    this.#hookPort = options.hookPort ?? null
    this.#watchdogIntervalMs = Math.max(1000, options.watchdogIntervalMs ?? 30000)
    this.#logger = options.logger

    if (this.#hookPort) {
      this.#removeHookListener = this.#hookPort.onLifecycleEvent((event) => {
        this.#handleHookLifecycle(event)
      })
    }
  }

  get entries(): ReadonlyMap<string, RegisteredHotKeyEntry> {
    return this.#entries
  }

  get diagnostics(): {
    totalRegistered: number
    activeCount: number
    repairedCount: number
    conflictCount: number
    hookIsolated: boolean
    hookAlive: boolean
  } {
    let active = 0
    for (const entry of this.#entries.values()) {
      if (entry.status === 'active') active++
    }
    return {
      totalRegistered: this.#entries.size,
      activeCount: active,
      repairedCount: this.#repairedCount,
      conflictCount: this.#conflictCount,
      hookIsolated: this.#hookPort?.isIsolated ?? false,
      hookAlive: this.#hookPort?.isAlive ?? true
    }
  }

  /**
   * 注册快捷键（严格映射与防重校验）
   */
  register(id: string, accelerator: string, handler: () => void): boolean {
    if (this.#disposed) return false
    const normalizedAcc = accelerator.trim()
    if (!normalizedAcc) return false

    // 检查冲突
    const existingId = this.#acceleratorToId.get(normalizedAcc)
    if (existingId && existingId !== id) {
      this.#log('WARN', `快捷键已被 ID [${existingId}] 占用: ${normalizedAcc}`)
      this.#conflictCount++
      return false
    }

    // 若当前 ID 已有注册，先清理旧注册
    if (this.#entries.has(id)) {
      this.unregister(id)
    }

    const success = this.#shortcutApi.register(normalizedAcc, handler)
    const entry: RegisteredHotKeyEntry = {
      id,
      accelerator: normalizedAcc,
      handler,
      registeredAt: Date.now(),
      lastVerifiedAt: Date.now(),
      status: success ? 'active' : 'conflicted'
    }

    this.#entries.set(id, entry)
    if (success) {
      this.#acceleratorToId.set(normalizedAcc, id)
      this.#log('INFO', `快捷键注册成功: ${id} -> ${normalizedAcc}`)
    } else {
      this.#conflictCount++
      this.#log('WARN', `快捷键系统注册被拒绝/冲突: ${id} -> ${normalizedAcc}`)
    }

    return success
  }

  /**
   * 注销快捷键
   */
  unregister(id: string): boolean {
    const entry = this.#entries.get(id)
    if (!entry) return false

    try {
      this.#shortcutApi.unregister(entry.accelerator)
    } catch {
      // 容错
    }

    this.#acceleratorToId.delete(entry.accelerator)
    this.#entries.delete(id)
    this.#log('INFO', `快捷键已注销: ${id} (${entry.accelerator})`)
    return true
  }

  /**
   * 巡检并自愈（验证 RegisterHotKey 映射是否在 OS 层面依然有效）
   */
  verifyAndRepair(): { verified: number; repaired: string[]; failed: string[] } {
    const repaired: string[] = []
    const failed: string[] = []
    let verified = 0

    for (const [id, entry] of this.#entries) {
      verified++
      entry.lastVerifiedAt = Date.now()

      const stillRegistered = this.#shortcutApi.isRegistered(entry.accelerator)
      if (!stillRegistered) {
        this.#log('WARN', `检测到快捷键被意外注销/抢占: ${id} (${entry.accelerator})，发起自愈恢复...`)
        try {
          const ok = this.#shortcutApi.register(entry.accelerator, entry.handler)
          if (ok) {
            entry.status = 'active'
            repaired.push(id)
            this.#repairedCount++
            this.#log('INFO', `快捷键自愈恢复成功: ${id} (${entry.accelerator})`)
          } else {
            entry.status = 'conflicted'
            failed.push(id)
            this.#conflictCount++
            this.#log('ERROR', `快捷键自愈重注册失败（已被系统或第三方占用）: ${id}`)
          }
        } catch (error) {
          entry.status = 'conflicted'
          failed.push(id)
          this.#conflictCount++
          this.#log('ERROR', `快捷键恢复异常: ${id}`, error)
        }
      } else {
        entry.status = 'active'
      }
    }

    return { verified, repaired, failed }
  }

  /**
   * 启动看门狗巡检
   */
  startWatchdog(): void {
    if (this.#watchdogTimer !== null) return
    this.#watchdogTimer = setInterval(() => {
      this.verifyAndRepair()
    }, this.#watchdogIntervalMs)
  }

  /**
   * 停止看门狗
   */
  stopWatchdog(): void {
    if (this.#watchdogTimer !== null) {
      clearInterval(this.#watchdogTimer)
      this.#watchdogTimer = null
    }
  }

  /**
   * 销毁保护器
   */
  dispose(): void {
    this.#disposed = true
    this.stopWatchdog()

    if (this.#removeHookListener) {
      this.#removeHookListener()
      this.#removeHookListener = null
    }

    for (const [id] of this.#entries) {
      this.unregister(id)
    }
    this.#entries.clear()
    this.#acceleratorToId.clear()
  }

  #handleHookLifecycle(event: HookIsolationEvent): void {
    this.#log('INFO', `收到底层钩子隔离线程事件: ${event.type}`, event.detail)
    if (event.type === 'crashed' || event.type === 'stalled') {
      this.#log('WARN', '底层钩子线程异常，确保系统级 RegisterHotKey 映射处于激活状态')
      this.verifyAndRepair()
    } else if (event.type === 'restarted' || event.type === 'recovered') {
      this.#log('INFO', '底层钩子线程已恢复，重新同步状态')
      this.verifyAndRepair()
    }
  }

  #log(level: 'INFO' | 'WARN' | 'ERROR', message: string, data?: unknown): void {
    if (this.#logger) {
      this.#logger(level, message, data)
    }
  }
}
