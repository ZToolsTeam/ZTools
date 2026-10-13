import { randomUUID } from 'node:crypto'

export const DEFAULT_HUD_DURATION_MS = 1500
export const MAX_HUD_MESSAGE_LENGTH = 1000

export interface HudMessagePayload {
  id: string
  message: string
  icon?: string
  durationMs: number
  timestamp: number
}

export interface HudEventPublisher {
  publishHost(type: string, payload: unknown): { success: true; delivered: number }
}

export interface HudServiceOptions {
  events?: HudEventPublisher | undefined
  defaultDurationMs?: number | undefined
  onShow?: ((payload: HudMessagePayload) => void) | undefined
  onHide?: ((id: string) => void) | undefined
}

export class HudService {
  readonly #events: HudEventPublisher | null
  readonly #defaultDurationMs: number
  readonly #onShow: ((payload: HudMessagePayload) => void) | null
  readonly #onHide: ((id: string) => void) | null

  #currentHud: HudMessagePayload | null = null
  #hideTimer: NodeJS.Timeout | null = null

  constructor(options: HudServiceOptions = {}) {
    this.#events = options.events ?? null
    this.#defaultDurationMs = options.defaultDurationMs ?? DEFAULT_HUD_DURATION_MS
    this.#onShow = options.onShow ?? null
    this.#onHide = options.onHide ?? null
  }

  isShowing(): boolean {
    return this.#currentHud !== null
  }

  getActiveHUD(): Readonly<HudMessagePayload> | null {
    return this.#currentHud
  }

  /**
   * 触发 HUD 气泡展示，并启动 1.5 秒自动隐去定时器
   */
  async showHUD(
    message: unknown,
    iconOrOptions?: string | { icon?: string; durationMs?: number }
  ): Promise<HudMessagePayload> {
    // 清理先前的自动关闭计时器
    if (this.#hideTimer) {
      clearTimeout(this.#hideTimer)
      this.#hideTimer = null
    }

    // 参数防御与防溢出保护
    let rawText = ''
    if (typeof message === 'string') {
      rawText = message
    } else if (message !== null && message !== undefined) {
      rawText = String(message)
    }

    const sanitizedMessage = rawText.length > MAX_HUD_MESSAGE_LENGTH
      ? rawText.slice(0, MAX_HUD_MESSAGE_LENGTH) + '...'
      : rawText

    let icon: string | undefined
    let durationMs = this.#defaultDurationMs

    if (typeof iconOrOptions === 'string') {
      icon = iconOrOptions
    } else if (iconOrOptions && typeof iconOrOptions === 'object') {
      if (typeof iconOrOptions.icon === 'string') {
        icon = iconOrOptions.icon
      }
      if (typeof iconOrOptions.durationMs === 'number' && Number.isFinite(iconOrOptions.durationMs) && iconOrOptions.durationMs > 0) {
        durationMs = iconOrOptions.durationMs
      }
    }

    const payload: HudMessagePayload = {
      id: randomUUID(),
      message: sanitizedMessage,
      ...(icon ? { icon } : {}),
      durationMs,
      timestamp: Date.now()
    }

    this.#currentHud = payload

    // 触发宿主协议广播事件
    try {
      this.#events?.publishHost('hud_shown', payload)
    } catch {
      // 广播失败不阻断核心调用
    }

    this.#onShow?.(payload)

    // 设定到期隐去定时器
    this.#hideTimer = setTimeout(() => {
      this.hideHUD(payload.id)
    }, durationMs)

    return payload
  }

  /**
   * 隐去 HUD 气泡
   */
  hideHUD(targetId?: string): boolean {
    if (!this.#currentHud) return false
    if (targetId && this.#currentHud.id !== targetId) return false

    if (this.#hideTimer) {
      clearTimeout(this.#hideTimer)
      this.#hideTimer = null
    }

    const closedId = this.#currentHud.id
    this.#currentHud = null

    try {
      this.#events?.publishHost('hud_hidden', { id: closedId, timestamp: Date.now() })
    } catch {
      // 广播失败不阻断
    }

    this.#onHide?.(closedId)
    return true
  }

  stop(): void {
    if (this.#hideTimer) {
      clearTimeout(this.#hideTimer)
      this.#hideTimer = null
    }
    this.#currentHud = null
  }
}

export interface NoViewExecutionContext {
  hideMainWindow(): void
  showHUD(message: string, icon?: string): Promise<void>
}

export interface NoViewCommand {
  id: string
  pluginId: string
  title?: string
  mode?: 'view' | 'no-view' | 'menu-bar'
  action: (context: NoViewExecutionContext) => Promise<{ message?: string; icon?: string } | string | void>
}

export interface WindowVisibilityManager {
  hideMainWindow(): void
  isMainWindowVisible?(): boolean
}

/**
 * No-View 轻量后台命令调度器
 */
export class NoViewCommandDispatcher {
  constructor(
    private readonly hudService: HudService,
    private readonly windowManager: WindowVisibilityManager
  ) {}

  async executeCommand(command: NoViewCommand): Promise<{
    success: boolean
    message?: string
    error?: string
    hudDispatched: boolean
  }> {
    if (!command || typeof command.action !== 'function') {
      return { success: false, error: '无效命令', hudDispatched: false }
    }

    const isNoView = command.mode === 'no-view'

    // 1. 如果是 no-view 模式，立即隐藏主窗口
    if (isNoView) {
      this.windowManager.hideMainWindow()
    }

    let hudCalledExplicitly = false

    try {
      // 2. 后台静默执行插件动作
      const result = await command.action({
        hideMainWindow: () => this.windowManager.hideMainWindow(),
        showHUD: async (msg, icon) => {
          hudCalledExplicitly = true
          await this.hudService.showHUD(msg, icon)
        }
      })

      // 3. 执行完毕处理反馈
      let resultMsg: string | undefined
      let resultIcon: string | undefined

      if (typeof result === 'string') {
        resultMsg = result
      } else if (result && typeof result === 'object' && typeof result.message === 'string') {
        resultMsg = result.message
        resultIcon = result.icon
      }

      // 如果动作返回了消息且此前未手动调用 showHUD，则自动投递 HUD
      if (isNoView && resultMsg && !hudCalledExplicitly) {
        await this.hudService.showHUD(resultMsg, resultIcon)
        return { success: true, message: resultMsg, hudDispatched: true }
      }

      if (resultMsg !== undefined) {
        return {
          success: true,
          message: resultMsg,
          hudDispatched: hudCalledExplicitly || Boolean(isNoView)
        }
      }

      return {
        success: true,
        hudDispatched: hudCalledExplicitly
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (isNoView) {
        await this.hudService.showHUD(`执行失败: ${errMsg}`, 'error')
      }
      return { success: false, error: errMsg, hudDispatched: isNoView }
    }
  }
}
