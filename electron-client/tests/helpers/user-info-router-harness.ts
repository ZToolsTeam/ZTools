import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import type { CallerIdentity } from '../../src/contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../src/contracts/errors.js'
import { parseRequest } from '../../src/contracts/ipc.js'
import { validateMethodParams } from '../../src/contracts/method-params.js'
import type { AccountService } from '../../src/main/edition-types.js'
import { isHostCaller } from '../../src/main/ipc/plugin-principal.js'
import { authorizeIpcRequest } from '../../src/main/ipc/router.js'
import { DeclarativePluginAttributionService } from '../../src/main/services/declarative-plugin-attribution-service.js'
import { WindowRegistry } from '../../src/main/windows/window-registry.js'

// user_get_info 经过路由同一条管线（解析信封 → 登记身份 → 会话归属 → 鉴权 → 参数校验 → 处理函数）的测试工具。
// 账号服务由调用方传入：公共用例用内存替身，商业版用例用真实的账号文件服务。

export const ACCESS_TOKEN = 'secret-access-token'
export const REFRESH_TOKEN = 'secret-refresh-token'

export const mainCaller: CallerIdentity = { type: 'main', webContentsId: 1 }
export const pluginWindowCaller: CallerIdentity = { type: 'plugin', webContentsId: 16, pluginId: 'ocr', pluginInstanceId: 'i-1' }
export const internalPluginCaller: CallerIdentity = { type: 'plugin', webContentsId: 17, pluginId: 'internal-settings' }
export const pluginWithoutIdCaller: CallerIdentity = { type: 'plugin', webContentsId: 18 }
export const attributedMainCaller: CallerIdentity = {
  type: 'main',
  webContentsId: 1,
  attributedPlugin: { pluginId: 'kill-process', sessionId: 's-1', permissions: new Set(), source: 'installed' }
}

/** 与路由 user_get_info 处理函数一致：按真实调用方身份决定是否带凭据 */
export function userInfoFor(user: AccountService, caller: CallerIdentity): Promise<Record<string, unknown>> {
  return user.getInfo({ includeCredentials: isHostCaller(caller) })
}

export function assertNoCredentials(info: Record<string, unknown>): void {
  assert.equal('token' in info, false)
  assert.equal('refresh_token' in info, false)
  const serialized = JSON.stringify(info)
  assert.equal(serialized.includes(ACCESS_TOKEN), false)
  assert.equal(serialized.includes(REFRESH_TOKEN), false)
}

export class FakeWebContents extends EventEmitter {
  #destroyed = false
  readonly session = {}
  constructor(readonly id: number, private readonly url = 'ztools://web/index.html') { super() }
  isDestroyed(): boolean { return this.#destroyed }
  getURL(): string { return this.url }
  send(): void {}
  destroy(): void {
    this.#destroyed = true
    this.emit('destroyed')
  }
  /** Electron 的 did-start-navigation：(details, url, isInPlace, isMainFrame) */
  reload(): void {
    this.emit('did-start-navigation', { isSameDocument: false, isMainFrame: true }, this.url, false, true)
  }
}

export interface RouterHarness {
  registry: WindowRegistry
  attribution: DeclarativePluginAttributionService
  warnings: string[]
  main: FakeWebContents
  mainCaller: CallerIdentity
  window(id: number): { contents: FakeWebContents; caller: CallerIdentity }
  /** 与 IpcRouter.#handleLegacy 相同的顺序处理一次 user_get_info */
  call(sender: FakeWebContents, pluginSession?: unknown): Promise<Record<string, unknown>>
  dispose(): void
}

let envelopeSequence = 0

export function createRouterHarness(user: AccountService, revoked = new Set<string>()): RouterHarness {
  const registry = new WindowRegistry()
  const warnings: string[] = []
  const attribution = new DeclarativePluginAttributionService(registry, {
    readBundled: async () => undefined,
    readInstalled: async (pluginId) => ({ id: pluginId, version: '1.0.0', permissions: [] }),
    isRevoked: async (pluginId) => ({ revoked: revoked.has(pluginId) })
  }, { log: { info() {}, warn: (message: unknown) => { warnings.push(String(message)) }, error() {} } })
  const window = (id: number) => {
    const contents = new FakeWebContents(id)
    return { contents, caller: registry.registerMain(contents as unknown as WebContents) }
  }
  const { contents: main, caller: mainCaller } = window(1)
  return {
    registry, attribution, warnings, main, mainCaller, window,
    async call(sender, pluginSession) {
      envelopeSequence += 1
      const request = parseRequest({
        messageId: `user-info-${envelopeSequence}`,
        method: 'user_get_info',
        params: {},
        ...(pluginSession === undefined ? {} : { pluginSession })
      })
      let caller = registry.get(sender.id)
      if (!caller) throw new ZToolsError(errorCodes.permissionDenied, '调用者未注册')
      caller = attribution.attributeCaller(caller, request)
      authorizeIpcRequest(caller, request, sender)
      validateMethodParams(request.method, request.params)
      return userInfoFor(user, caller)
    },
    dispose() {
      attribution.stop()
    }
  }
}

export async function openToken(h: RouterHarness, pluginId: string, caller = h.mainCaller): Promise<{ token: string; sessionId: string }> {
  const opened = await h.attribution.open(caller, { pluginId })
  return { token: opened.data.token, sessionId: opened.data.sessionId }
}
