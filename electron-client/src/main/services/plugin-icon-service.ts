import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { PluginDirectoryProvider } from './plugin-install-service.js'
import type { PluginStateProvider } from './plugin-state-service.js'

const MAX_ICON_BYTES = 4 * 1024 * 1024

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
    return this.manifests.withPluginDirectory(pluginId, async (manifest, pluginRoot) => {
      let response: Response
      try {
        response = await this.fetchImpl(url)
      } catch {
        throw new ZToolsError(errorCodes.networkError, '下载插件图标失败')
      }
      if (!response.ok) throw new ZToolsError(errorCodes.networkError, '下载插件图标失败')
      const contentType = response.headers.get('content-type') ?? ''
      const suffix = iconSuffix(contentType)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) {
        throw new ZToolsError(errorCodes.fileTooLarge, '插件图标超过大小限制')
      }
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
