import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AttributedPlugin, CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { ZToolsRequest } from '../../contracts/ipc.js'
import type { DeclarativeSessionCloseParams, DeclarativeSessionOpenParams } from '../../contracts/method-params.js'
import { resolveSafeFile } from '../protocol/safe-path.js'

/**
 * 主窗口声明式插件的会话归属。
 *
 * 声明式插件和宿主界面跑在同一个渲染进程、同一个 JS 上下文里，主进程只能看到「主窗口」这个调用者。
 * 宿主在打开插件时用本服务申请会话：主进程自己读该插件的 plugin.json（不信任渲染层传来的权限），
 * 签发随机令牌；渲染层把令牌放进只属于这个插件的调用通道，主进程按「令牌 + 发送窗口」查出 pluginId。
 *
 * 能做到：正常插件的调用被准确归属；被下架 / 禁用 / 卸载 / 更新、窗口刷新或关闭后旧令牌失效；
 * 令牌绑定窗口，换个窗口用无效。
 *
 * 做不到（这不是安全隔离边界）：同一 JS 上下文里存心作恶的插件可以不带令牌直接调原始通道，
 * 也可以自己调用 declarative_session_open 冒充别的插件（例如拿到 google-auth 的会话读出它的加密数据）。
 * 加密存储防的是「磁盘 / 备份 / 其他本机程序读到明文」，不防同一宿主里的其他 ZTools 插件；
 * 这一层依赖人工审核 + AST 扫描 + 源码构建 hash + 下架开关。真正隔离需要把插件挪进独立 realm。
 */

/** 与主进程其他插件 ID 校验一致（大小写先归一） */
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/
const DEFAULT_MAX_SESSIONS_PER_WINDOW = 32
const INVALID_TOKEN_WARN_INTERVAL_MS = 60_000
const MAX_PERMISSION_COUNT = 64
const MAX_PERMISSION_LENGTH = 64

export interface AttributionSessionSnapshot {
  readonly sessionId: string
  readonly webContentsId: number
  readonly pluginId: string
  readonly source: 'installed' | 'bundled'
  readonly permissions: readonly string[]
  readonly manifestVersion: string
  readonly openedAt: number
}

interface AttributionSession extends AttributionSessionSnapshot {
  readonly tokenHash: string
  readonly attributed: AttributedPlugin
}

/** 读取插件清单；安装目录的读取应自带「未安装 / 已禁用 / 已下架」拒绝 */
export interface AttributionManifestSource {
  /** 随包内置插件：返回原始清单；不是内置插件时返回 undefined */
  readBundled(pluginId: string): Promise<unknown | undefined>
  readInstalled(pluginId: string): Promise<unknown>
  isRevoked(pluginId: string): Promise<{ revoked: boolean; reason?: string | undefined }>
}

/** 本服务需要的 WebContents 能力（便于测试替身） */
export interface AttributionWebContents {
  readonly id: number
  isDestroyed(): boolean
  on(event: 'did-start-navigation', listener: (...args: unknown[]) => void): unknown
  on(event: 'render-process-gone', listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface AttributionRegistry {
  get(webContentsId: number): CallerIdentity | undefined
  getWebContents(webContentsId: number): unknown
  onRemoved(listener: (webContentsId: number) => void): () => void
}

export interface DeclarativePluginAttributionOptions {
  readonly maxSessionsPerWindow?: number
  readonly now?: () => number
  readonly log?: Pick<Console, 'info' | 'warn' | 'error'>
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function readPermissions(value: unknown, pluginId: string, log: Pick<Console, 'warn'>): Set<string> {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || value.length > MAX_PERMISSION_COUNT ||
      value.some(item => typeof item !== 'string' || item.length === 0 || item.length > MAX_PERMISSION_LENGTH)) {
    log.warn('[attribution] plugin.json permissions 不是合法的字符串数组，按无权限处理', { pluginId })
    return new Set()
  }
  return new Set(value as string[])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从 web 根目录 bundled-plugins/<id>/plugin.json 读取内置清单（与前端 isBundledPlugin 的优先级一致） */
export function createBundledManifestReader(webRoot: string | (() => string)) {
  return async (pluginId: string): Promise<unknown | undefined> => {
    const root = typeof webRoot === 'function' ? webRoot() : webRoot
    let file: string
    try {
      file = await resolveSafeFile(root, `bundled-plugins/${encodeURIComponent(pluginId)}/plugin.json`)
    } catch {
      return undefined
    }
    let raw: string
    try {
      const stat = await fs.stat(file)
      if (stat.size > 256 * 1024) throw new ZToolsError(errorCodes.pluginPackageInvalid, '内置插件清单过大')
      raw = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.pluginPackageInvalid, '内置插件清单无法读取')
    }
    try {
      return JSON.parse(raw)
    } catch {
      throw new ZToolsError(errorCodes.pluginPackageInvalid, `内置插件清单损坏: ${path.basename(path.dirname(file))}`)
    }
  }
}

export class DeclarativePluginAttributionService {
  readonly #byToken = new Map<string, AttributionSession>()
  readonly #bySession = new Map<string, AttributionSession>()
  readonly #byWindow = new Map<number, Set<string>>()
  /** 每个窗口的导航代数：读清单途中窗口刷新 / 销毁，结果作废，不登记 */
  readonly #generation = new Map<number, number>()
  readonly #windowListeners = new Map<number, () => void>()
  readonly #lastInvalidTokenWarn = new Map<number, number>()
  readonly #removeRegistryListener: () => void
  readonly #maxSessionsPerWindow: number
  readonly #now: () => number
  readonly #log: Pick<Console, 'info' | 'warn' | 'error'>
  #stopped = false

  constructor(
    private readonly registry: AttributionRegistry,
    private readonly manifests: AttributionManifestSource,
    options: DeclarativePluginAttributionOptions = {}
  ) {
    this.#maxSessionsPerWindow = options.maxSessionsPerWindow ?? DEFAULT_MAX_SESSIONS_PER_WINDOW
    this.#now = options.now ?? Date.now
    this.#log = options.log ?? console
    this.#removeRegistryListener = registry.onRemoved((webContentsId) => this.#dropWindow(webContentsId, 'window-removed'))
  }

  /** 宿主窗口为一个插件申请会话；权限以主进程读到的清单为准 */
  async open(
    caller: CallerIdentity,
    params: DeclarativeSessionOpenParams
  ): Promise<{ success: true; data: { sessionId: string; token: string; pluginId: string; permissions: string[] } }> {
    this.#requireRunning()
    if (caller.type !== 'main' || caller.attributedPlugin) {
      throw new ZToolsError(errorCodes.permissionDenied, '只有宿主窗口可以申请插件会话')
    }
    const requested = typeof params.pluginId === 'string' ? params.pluginId.trim().toLowerCase() : ''
    if (!PLUGIN_ID_PATTERN.test(requested) || requested.includes('..') || requested.endsWith('.')) {
      throw new ZToolsError(errorCodes.invalidRequest, 'pluginId 格式无效')
    }
    const webContentsId = caller.webContentsId
    // 先挂上刷新 / 崩溃监听，读清单途中发生的导航也能让本次结果作废
    const watched = this.registry.getWebContents(webContentsId)
    if (!watched) throw new ZToolsError(errorCodes.callerDestroyed, '申请会话的窗口已关闭')
    this.#watchWindow(webContentsId, watched)
    const generation = this.#generation.get(webContentsId) ?? 0

    let source: 'installed' | 'bundled' = 'bundled'
    let manifest = await this.manifests.readBundled(requested)
    if (manifest !== undefined) {
      const revoked = await this.manifests.isRevoked(requested)
      if (revoked.revoked) {
        throw new ZToolsError(errorCodes.permissionDenied, `该插件已被官方下架禁用: ${revoked.reason || '存在安全合规风险'}`)
      }
    } else {
      source = 'installed'
      manifest = await this.manifests.readInstalled(requested)
    }
    if (!isRecord(manifest) || typeof manifest.id !== 'string' || manifest.id.trim().toLowerCase() !== requested) {
      throw new ZToolsError(errorCodes.pluginPackageInvalid, '插件清单 id 与请求的插件不一致')
    }
    const pluginId = manifest.id.trim()
    const permissions = readPermissions(manifest.permissions, pluginId, this.#log)
    const manifestVersion = typeof manifest.version === 'string' ? manifest.version.slice(0, 64) : ''

    // 读清单是异步的：期间窗口刷新 / 销毁 / 服务停止则结果作废
    this.#requireRunning()
    const contents = this.registry.getWebContents(webContentsId)
    const current = this.registry.get(webContentsId)
    if (!contents || !current || current.type !== 'main' ||
        (this.#generation.get(webContentsId) ?? 0) !== generation) {
      throw new ZToolsError(errorCodes.callerDestroyed, '申请会话的窗口已刷新或关闭')
    }
    this.#watchWindow(webContentsId, contents)

    const token = randomBytes(32).toString('base64url')
    const sessionId = `ds_${randomBytes(12).toString('base64url')}`
    const attributed: AttributedPlugin = Object.freeze({
      pluginId,
      sessionId,
      permissions: Object.freeze(new Set(permissions)) as ReadonlySet<string>,
      source
    })
    const session: AttributionSession = Object.freeze({
      sessionId,
      webContentsId,
      pluginId,
      source,
      permissions: Object.freeze([...permissions]),
      manifestVersion,
      openedAt: this.#now(),
      tokenHash: hashToken(token),
      attributed
    })
    const windowSessions = this.#byWindow.get(webContentsId) ?? new Set<string>()
    // 正常引用计数下不会超过上限；超了说明渲染层泄漏。淘汰最旧的会话而不是拒绝新会话，
    // 否则泄漏一次后这个窗口就再也无法给插件归属
    while (windowSessions.size >= this.#maxSessionsPerWindow) {
      const oldest = [...windowSessions]
        .map(id => this.#bySession.get(id))
        .filter((item): item is AttributionSession => item !== undefined)
        .sort((left, right) => left.openedAt - right.openedAt)[0]
      if (!oldest) break
      this.#log.error('[attribution] 窗口插件会话数达到上限，淘汰最旧会话（渲染层可能未释放会话）', {
        webContentsId, evictedSessionId: oldest.sessionId, evictedPluginId: oldest.pluginId
      })
      this.#delete(oldest)
    }
    windowSessions.add(sessionId)
    this.#byWindow.set(webContentsId, windowSessions)
    this.#byToken.set(session.tokenHash, session)
    this.#bySession.set(sessionId, session)
    this.#log.info('[attribution] open', { pluginId, sessionId, webContentsId, source })
    return { success: true, data: { sessionId, token, pluginId, permissions: [...permissions] } }
  }

  /** 只能关闭本窗口的会话；不存在时幂等成功 */
  close(caller: CallerIdentity, params: DeclarativeSessionCloseParams): { success: true } {
    if (caller.type !== 'main') {
      throw new ZToolsError(errorCodes.permissionDenied, '只有宿主窗口可以关闭插件会话')
    }
    const session = this.#bySession.get(params.sessionId)
    if (session && session.webContentsId === caller.webContentsId) {
      this.#delete(session)
      this.#log.info('[attribution] close', {
        pluginId: session.pluginId, sessionId: session.sessionId, webContentsId: session.webContentsId
      })
    }
    return { success: true }
  }

  resolve(webContentsId: number, token: string): AttributedPlugin | undefined {
    const session = this.#byToken.get(hashToken(token))
    return session && session.webContentsId === webContentsId ? session.attributed : undefined
  }

  /**
   * 给已注册调用者附加会话归属。
   * - 不带令牌：原样返回（与改动前完全一致）；
   * - 插件窗口（type:'plugin'）本来就有可靠身份，带令牌即为非法请求；
   * - 令牌失效 / 属于别的窗口：按未归属处理（拿不到任何需要归属的能力），并标记 stalePluginSession，
   *   不再被当作宿主自身（拿不到登录凭据等宿主专属数据），只记限频 warn。
   */
  attributeCaller(caller: CallerIdentity, request: Pick<ZToolsRequest, 'pluginSession' | 'method'>): CallerIdentity {
    if (request.pluginSession === undefined) return caller
    if (caller.type !== 'main') {
      throw new ZToolsError(errorCodes.invalidRequest, '插件窗口调用不能携带声明式插件会话')
    }
    const attributedPlugin = this.resolve(caller.webContentsId, request.pluginSession)
    if (!attributedPlugin) {
      const now = this.#now()
      const last = this.#lastInvalidTokenWarn.get(caller.webContentsId)
      if (last === undefined || now - last >= INVALID_TOKEN_WARN_INTERVAL_MS) {
        this.#lastInvalidTokenWarn.set(caller.webContentsId, now)
        this.#log.warn('[attribution] 插件会话令牌已失效，按未归属调用处理', {
          webContentsId: caller.webContentsId, method: request.method
        })
      }
      // 仍按未归属处理（拿不到需要归属的能力），只额外标记「来自插件代码」，宿主专属数据据此拒绝下发
      return Object.freeze({ ...caller, stalePluginSession: true })
    }
    return Object.freeze({ ...caller, attributedPlugin })
  }

  /** 下架 / 禁用 / 卸载 / 更新：所有窗口里该插件的会话立即失效 */
  revokePlugin(pluginId: string): number {
    const key = String(pluginId || '').trim().toLowerCase()
    let removed = 0
    for (const session of [...this.#bySession.values()]) {
      if (session.pluginId.toLowerCase() !== key) continue
      this.#delete(session)
      removed += 1
    }
    if (removed > 0) this.#log.info('[attribution] revoke', { pluginId: key, removed })
    return removed
  }

  /** 诊断与测试用：不含令牌 */
  snapshot(): AttributionSessionSnapshot[] {
    return [...this.#bySession.values()].map(({ sessionId, webContentsId, pluginId, source, permissions, manifestVersion, openedAt }) => ({
      sessionId, webContentsId, pluginId, source, permissions, manifestVersion, openedAt
    }))
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#removeRegistryListener()
    for (const dispose of this.#windowListeners.values()) dispose()
    this.#windowListeners.clear()
    this.#byToken.clear()
    this.#bySession.clear()
    this.#byWindow.clear()
    this.#generation.clear()
    this.#lastInvalidTokenWarn.clear()
  }

  #requireRunning(): void {
    if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
  }

  #watchWindow(webContentsId: number, contents: unknown): void {
    if (this.#windowListeners.has(webContentsId)) return
    const target = contents as Partial<AttributionWebContents>
    if (typeof target.on !== 'function' || typeof target.removeListener !== 'function') return
    // 主框架的跨文档导航（刷新、loadURL 到新页面）意味着旧 JS 上下文已经不存在
    const onNavigation = (...args: unknown[]): void => {
      const details = args[0] as { isSameDocument?: unknown; isMainFrame?: unknown } | undefined
      const isInPlace = typeof args[2] === 'boolean' ? args[2] : details?.isSameDocument === true
      const isMainFrame = typeof args[3] === 'boolean' ? args[3] : details?.isMainFrame !== false
      if (!isMainFrame || isInPlace) return
      this.#dropWindow(webContentsId, 'navigation', false)
    }
    const onGone = (): void => this.#dropWindow(webContentsId, 'render-process-gone', false)
    target.on('did-start-navigation', onNavigation)
    target.on('render-process-gone', onGone)
    this.#windowListeners.set(webContentsId, () => {
      try {
        target.removeListener?.('did-start-navigation', onNavigation)
        target.removeListener?.('render-process-gone', onGone)
      } catch { /* 窗口已销毁 */ }
    })
  }

  #dropWindow(webContentsId: number, reason: string, removeListeners = true): void {
    this.#generation.set(webContentsId, (this.#generation.get(webContentsId) ?? 0) + 1)
    const sessions = this.#byWindow.get(webContentsId)
    if (sessions && sessions.size > 0) {
      const removed = sessions.size
      for (const sessionId of [...sessions]) {
        const session = this.#bySession.get(sessionId)
        if (session) this.#delete(session)
      }
      this.#log.info('[attribution] window sessions cleared', { webContentsId, reason, removed })
    }
    this.#byWindow.delete(webContentsId)
    this.#lastInvalidTokenWarn.delete(webContentsId)
    if (removeListeners) {
      this.#windowListeners.get(webContentsId)?.()
      this.#windowListeners.delete(webContentsId)
      this.#generation.delete(webContentsId)
    }
  }

  #delete(session: AttributionSession): void {
    this.#byToken.delete(session.tokenHash)
    this.#bySession.delete(session.sessionId)
    const windowSessions = this.#byWindow.get(session.webContentsId)
    windowSessions?.delete(session.sessionId)
    if (windowSessions && windowSessions.size === 0) this.#byWindow.delete(session.webContentsId)
  }
}
