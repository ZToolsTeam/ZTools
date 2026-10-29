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
    throw new ZToolsError(errorCodes.invalidRequest, '图标地址无效')
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password) {
    throw new ZToolsError(errorCodes.permissionDenied, '图标下载只允许 HTTPS 或本机测试地址')
  }
  return url
}

function iconSuffix(contentType: string): string {
  const normalized = contentType.split(';', 1)[0]?.trim().toLowerCase()
  if (normalized === 'image/png') return '.png'
  if (normalized === 'image/jpeg') return '.jpg'
  if (normalized === 'image/x-icon' || normalized === 'image/vnd.microsoft.icon') return '.ico'
  throw new ZToolsError(errorCodes.notSupported, '图标格式暂不支持')
}

export class PluginIconService {
  constructor(
    private readonly manifests: PluginDirectoryProvider,
    private readonly state: PluginStateProvider,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async refresh(pluginId: string, iconUrl: string): Promise<{ success: true; pluginId: string; status: 'refreshing' }> {
    const url = validateIconUrl(iconUrl)
    // 先在插件目录锁之外下载：独占锁期间插件无法打开会话，不能让网络耗时（或断网挂起）占住它
    let response: Response
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(ICON_DOWNLOAD_TIMEOUT_MS) })
    } catch {
      throw new ZToolsError(errorCodes.networkError, '下载插件图标失败')
    }
    if (!response.ok) throw new ZToolsError(errorCodes.networkError, '下载插件图标失败')
    const contentType = response.headers.get('content-type') ?? ''
    const suffix = iconSuffix(contentType)
    let bytes: Buffer
    try {
      bytes = Buffer.from(await response.arrayBuffer())
    } catch {
      throw new ZToolsError(errorCodes.networkError, '下载插件图标失败')
    }
    if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) {
      throw new ZToolsError(errorCodes.fileTooLarge, '插件图标超过大小限制')
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
