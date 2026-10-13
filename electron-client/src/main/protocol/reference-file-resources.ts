import type { WindowRegistry } from '../windows/window-registry.js'
import type { PathGrantService } from '../services/path-grant-service.js'
import { anchoredFileCapabilityResponse } from './anchored-file-capability.js'

type Registry = Pick<WindowRegistry, 'get' | 'getWebContents' | 'getSession' | 'getSdkApiLane'>
type Grants = Pick<PathGrantService, 'canLoadResource' | 'openResource' | 'ownsResourceUrl'>

/** Main-only paired ports: register allowsNativeRequest on the same session as respond.
 * Protocol Request has no WebContents identity; never accept a Renderer-supplied owner/referrer.
 */
export class ReferenceFileResources {
  readonly #stop = new AbortController()
  constructor(private readonly registry: Registry, private readonly grants: Grants) {}

  claimsUrl(url: string): boolean {
    try { return !this.#stop.signal.aborted && this.grants.ownsResourceUrl(url) } catch { return false }
  }

  allowsLegacyRequest(details: Pick<Electron.OnBeforeRequestListenerDetails,
    'url' | 'method' | 'webContentsId' | 'webContents' | 'frame'>, session: Electron.Session,
    files: { canLoadFileCapability(url: string, owner: number): boolean }): boolean {
    const owner = this.#owner(details, session, 1)
    try { return owner !== undefined && files.canLoadFileCapability(details.url, owner) } catch { return false }
  }

  allowsNativeRequest(details: Pick<Electron.OnBeforeRequestListenerDetails,
    'url' | 'method' | 'webContentsId' | 'webContents' | 'frame'>, session: Electron.Session): boolean {
    const owner = this.#owner(details, session, 2)
    try { return owner !== undefined && this.grants.canLoadResource(details.url, owner) } catch { return false }
  }

  #owner(details: Pick<Electron.OnBeforeRequestListenerDetails,
    'url' | 'method' | 'webContentsId' | 'webContents' | 'frame'>, session: Electron.Session, lane: 1 | 2): number | undefined {
    try {
      const owner = details.webContentsId
      if (this.#stop.signal.aborted || !Number.isSafeInteger(owner) || !owner || owner <= 0 ||
          (details.method !== 'GET' && details.method !== 'HEAD')) return undefined
      const target = this.registry.getWebContents(owner), caller = this.registry.get(owner)
      if (!target || target.isDestroyed() || !caller || caller.webContentsId !== owner ||
          this.registry.getSession(owner) !== session || (details.webContents && details.webContents !== target) ||
          !details.frame || details.frame !== target.mainFrame || this.registry.getSdkApiLane(caller) !== lane) return undefined
      const page = new URL(details.frame.url)
      if (page.protocol !== 'ztools:' || page.username || page.password || page.port) return undefined
      if (caller.type === 'main') { if (page.hostname !== 'web' || caller.pluginId || caller.pluginInstanceId) return undefined }
      else if (caller.type === 'plugin') {
        if (page.hostname !== 'plugins' || !caller.pluginId || !caller.pluginInstanceId ||
            decodeURIComponent(page.pathname.split('/')[1] ?? '') !== caller.pluginId) return undefined
      } else return undefined
      return owner
    } catch { return undefined }
  }

  respond(request: Pick<Request, 'url' | 'method' | 'headers' | 'signal'>): Promise<Response> {
    if (this.#stop.signal.aborted) return Promise.resolve(new Response(null, { status: 404 }))
    return anchoredFileCapabilityResponse({ url: request.url, method: request.method, headers: request.headers,
      signal: AbortSignal.any([request.signal, this.#stop.signal]) }, this.grants)
  }

  closeIngress(): void { this.#stop.abort() }
  stop(): void { this.closeIngress() }
}
