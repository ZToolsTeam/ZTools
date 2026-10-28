import type { CallerIdentity } from '../../contracts/capabilities.js'
import type { SystemPowerSessionParams } from '../../contracts/method-params.js'

export interface PowerSessionAdapter {
  startPreventSleep(mode?: 'display' | 'system'): number
  stopPreventSleep(id: number): void
}

interface PowerSession {
  windowId: number
  blockerId: number
  mode: 'display' | 'system'
  durationMinutes: number
  startedAtMs: number
  expiresAtMs: number | null
  sessionId: number
  timer?: ReturnType<typeof setTimeout>
}

/** 主进程持有定时器与电源断言；退出插件页面不影响任务，窗口销毁和应用退出会释放。 */
export class PowerSessionService {
  readonly #sessions = new Map<string, PowerSession>()
  #sequence = 0

  constructor(private readonly adapter: PowerSessionAdapter) {}

  #owner(caller: CallerIdentity): string {
    if (caller.stalePluginSession) throw new Error('插件会话已失效，请重新打开插件')
    return JSON.stringify([caller.webContentsId, caller.attributedPlugin?.pluginId ?? caller.pluginId ?? null])
  }

  #release(owner: string): void {
    const session = this.#sessions.get(owner)
    if (!session) return
    this.adapter.stopPreventSleep(session.blockerId)
    clearTimeout(session.timer)
    this.#sessions.delete(owner)
  }

  #schedule(owner: string, session: PowerSession, delay: number): void {
    session.timer = setTimeout(() => {
      if (this.#sessions.get(owner) !== session) return
      this.#releaseSafely(owner, session)
    }, delay)
    session.timer.unref()
  }

  #releaseSafely(owner: string, session: PowerSession): void {
    try { this.#release(owner) }
    catch (error) {
      // 清理一项失败不能中断其他资源的释放；保留句柄重试，不能遗失原生断言。
      console.error('释放防休眠会话失败，将重试', error)
      clearTimeout(session.timer)
      this.#schedule(owner, session, 1000)
    }
  }

  execute(params: SystemPowerSessionParams, caller: CallerIdentity) {
    const owner = this.#owner(caller)
    let session = this.#sessions.get(owner)
    if (session?.expiresAtMs !== null && session?.expiresAtMs !== undefined && session.expiresAtMs <= Date.now()) {
      this.#release(owner)
      session = undefined
    }
    const action = params.action === 'toggle' ? (session ? 'stop' : 'start') : params.action
    if (action === 'stop') this.#release(owner)
    else if (action === 'start') {
      const durationMinutes = params.durationMinutes ?? 0
      const mode = params.mode ?? 'display'
      if (!Number.isInteger(durationMinutes) || durationMinutes < 0 || durationMinutes > 10080) throw new Error('防休眠时长必须为 0~10080 的整数分钟')
      if (mode !== 'display' && mode !== 'system') throw new Error('防休眠模式无效')
      // 先结束旧会话，再建立新断言；失败时没有失去归属的第二个断言。
      this.#release(owner)
      const blockerId = this.adapter.startPreventSleep(mode)
      if (!Number.isInteger(blockerId) || blockerId < 0) throw new Error('无法建立系统防休眠断言')
      const now = Date.now()
      const next: PowerSession = {
        windowId: caller.webContentsId, blockerId, mode, durationMinutes,
        startedAtMs: now, expiresAtMs: durationMinutes ? now + durationMinutes * 60000 : null,
        sessionId: ++this.#sequence
      }
      this.#sessions.set(owner, next)
      if (next.expiresAtMs !== null) this.#schedule(owner, next, next.expiresAtMs - now)
    } else if (action !== 'status') throw new Error('防休眠操作无效')

    const current = this.#sessions.get(owner)
    return {
      success: true as const,
      active: Boolean(current), mode: current?.mode ?? 'display', durationMinutes: current?.durationMinutes ?? 0,
      startedAtMs: current?.startedAtMs ?? null, expiresAtMs: current?.expiresAtMs ?? null,
      remainingMs: current?.expiresAtMs === null || !current ? null : Math.max(0, current.expiresAtMs - Date.now()),
      sessionId: current?.sessionId ?? 0
    }
  }

  /** 插件卸载、停用或下架后不再有界面可以关闭它的防休眠，必须一并释放（不论在哪个窗口建立） */
  releasePlugin(pluginId: string): void {
    const target = pluginId.trim().toLowerCase()
    for (const [owner, session] of this.#sessions) {
      const [, ownerPluginId] = JSON.parse(owner) as [number, string | null]
      if (typeof ownerPluginId !== 'string' || ownerPluginId.toLowerCase() !== target) continue
      this.#releaseSafely(owner, session)
    }
  }

  releaseWindow(windowId: number): void {
    for (const [owner, session] of this.#sessions) {
      if (session.windowId !== windowId) continue
      this.#releaseSafely(owner, session)
    }
  }

  stop(): void {
    for (const [owner, session] of this.#sessions) this.#releaseSafely(owner, session)
  }
}
