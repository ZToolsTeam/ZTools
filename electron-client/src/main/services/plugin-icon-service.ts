import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { PluginDirectoryProvider } from './plugin-install-service.js'
import type { PluginStateProvider } from './plugin-state-service.js'

const MAX_ICON_BYTES = 4 * 1024 * 1024
// 低于渲染层 IPC 默认的 10 秒超时，失败能如实回到调用方
const ICON_DOWNLOAD_TIMEOUT_MS = 8_000

function validateIconUrl(source: string): URL {
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new ZToolsError(errorCodes.invalidRequest, 'Invalid icon URL')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) {
    throw new ZToolsError(errorCodes.permissionDenied, 'Icon download only allows HTTPS or local test URLs')
  }
  return url
}

function iconSuffix(contentType: string): string {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase()
  if (normalized === 'image/png') return '.png'
  if (normalized === 'image/jpeg') return '.jpg'
  if (normalized === 'image/svg+xml') return '.svg'
  if (normalized === 'image/webp') return '.webp'
  if (normalized === 'image/x-icon' || normalized === 'image/vnd.microsoft.icon') return '.ico'
  throw new ZToolsError(errorCodes.notSupported, 'Icon format is not supported')
}

export class PluginIconService {
  readonly #inFlight = new Map<
    string,
    { url: string; promise: Promise<{ success: true; pluginId: string; status: 'refreshing' }> }
  >()
  constructor(
    private readonly manifests: PluginDirectoryProvider,
    private readonly state: PluginStateProvider,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async refresh(pluginId: string, iconUrl: string): Promise<{ success: true; pluginId: string; status: 'refreshing' }> {
    const url = validateIconUrl(iconUrl)
    const key = pluginId.trim().toLowerCase()
    const existing = this.#inFlight.get(key)
    if (existing && existing.url === url.href) {
      return existing.promise
    }
    const task = existing
      ? existing.promise.then(() => undefined, () => undefined).then(() => this.#refreshNow(pluginId, url))
      : this.#refreshNow(pluginId, url)
    const entry = { url: url.href, promise: task }
    this.#inFlight.set(key, entry)
    try {
      return await task
    } finally {
      if (this.#inFlight.get(key) === entry) {
        this.#inFlight.delete(key)
      }
    }
  }

  async #refreshNow(pluginId: string, url: URL): Promise<{ success: true; pluginId: string; status: 'refreshing' }> {
    // 先在插件目录锁之外下载：独占锁期间插件无法打开会话，不能让网络耗时（或断网挂起）占住它
    let response: Response
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(ICON_DOWNLOAD_TIMEOUT_MS) })
    } catch {
      throw new ZToolsError(errorCodes.networkError, 'Failed to download plugin icon')
    }
    if (!response.ok) throw new ZToolsError(errorCodes.networkError, 'Failed to download plugin icon')
    const contentType = response.headers.get('content-type') ?? ''
    const suffix = iconSuffix(contentType)
    let bytes: Buffer
    try {
      bytes = Buffer.from(await response.arrayBuffer())
    } catch {
      throw new ZToolsError(errorCodes.networkError, 'Failed to download plugin icon')
    }
    if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) {
      throw new ZToolsError(errorCodes.fileTooLarge, 'Plugin icon exceeds size limit')
    }
    return this.manifests.withPluginDirectory(pluginId, async (manifest, pluginRoot) => {
      const target = path.join(pluginRoot, `icon${suffix}`)
      const temporary = path.join(pluginRoot, `.icon-${randomUUID()}.tmp`)
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
        await fs.rm(target, { force: true })
        await fs.rename(temporary, target)
        await fs.writeFile(path.join(pluginRoot, 'icon.url'), `${url.href}\n`, { encoding: 'utf8', mode: 0o600 })
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined)
      }
      await this.state.setIconUrl(manifest.id, url.href)
      return { success: true, pluginId: manifest.id, status: 'refreshing' }
    })
  }
}
