import { tSync } from '../i18n.js'

export type WebDavPreset = 'jianguoyun' | 'nextcloud' | 'synology' | 'generic'

export interface WebDavConfig {
  endpoint: string
  username?: string
  password?: string
  basePath?: string
  preset?: WebDavPreset
  customHeaders?: Record<string, string>
  fetchFn?: typeof fetch
  locale?: string
  /**
   * 是否显式允许非加密明文 HTTP 连接（默认 false，强制 HTTPS）
   */
  allowInsecureHttp?: boolean
}

export interface WebDavResource {
  href: string
  name: string
  isCollection: boolean
  contentLength?: number
  etag?: string
  lastModified?: string
  status: number
}

export class WebDavError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly statusText?: string,
    public readonly responseBody?: string
  ) {
    super(message)
    this.name = 'WebDavError'
  }
}

// 控制字符（含空字节 \0）与 URL 编码穿越特征正则
const CONTROL_CHAR_REGEX = /[\u0000-\u001f\u007f]/
const ENCODED_TRAVERSAL_REGEX = /%(?:2e|2f|5c|00)/i
const ABSOLUTE_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/**
 * WebDAV 去中心化同步协议适配器
 * 全面支持坚果云、Nextcloud、群晖/私有 NAS 等主流 WebDAV 服务
 */
export class WebDavSyncAdapter {
  readonly #endpoint: string
  readonly #endpointOrigin: string
  readonly #basePathname: string
  readonly #username?: string
  readonly #password?: string
  readonly #basePath: string
  readonly #preset: WebDavPreset
  readonly #customHeaders: Record<string, string>
  readonly #fetch: typeof fetch
  #locale?: string

  constructor(config: WebDavConfig) {
    this.#locale = config.locale

    const rawEndpoint = typeof config.endpoint === 'string' ? config.endpoint.trim() : ''
    let parsedEndpoint: URL
    try {
      parsedEndpoint = new URL(rawEndpoint)
    } catch {
      throw new WebDavError(
        tSync('webdav.invalidEndpoint', { endpoint: String(config.endpoint ?? '') }, config.locale)
      )
    }

    if (parsedEndpoint.protocol === 'http:') {
      if (config.allowInsecureHttp !== true) {
        throw new WebDavError(
          tSync('webdav.insecureHttpNotAllowed', undefined, config.locale)
        )
      }
    } else if (parsedEndpoint.protocol !== 'https:') {
      throw new WebDavError(
        tSync('webdav.invalidEndpoint', { endpoint: rawEndpoint }, config.locale)
      )
    }

    let ep = parsedEndpoint.toString()
    if (!ep.endsWith('/')) ep += '/'
    const normalizedEndpointUrl = new URL(ep)
    this.#endpoint = normalizedEndpointUrl.toString()
    this.#endpointOrigin = normalizedEndpointUrl.origin

    this.#username = config.username
    this.#password = config.password

    const rawBase = (config.basePath ?? '').trim()
    if (rawBase) {
      if (
        CONTROL_CHAR_REGEX.test(rawBase) ||
        rawBase.includes('\\') ||
        rawBase.includes('://') ||
        rawBase.startsWith('//') ||
        ABSOLUTE_SCHEME_REGEX.test(rawBase) ||
        ENCODED_TRAVERSAL_REGEX.test(rawBase) ||
        rawBase.includes('?') ||
        rawBase.includes('#')
      ) {
        throw new WebDavError(
          tSync('webdav.invalidBasePath', { basePath: rawBase }, config.locale)
        )
      }
      const baseSegments = rawBase.split('/').filter((s) => s.length > 0)
      if (baseSegments.some((seg) => seg === '.' || seg === '..')) {
        throw new WebDavError(
          tSync('webdav.invalidBasePath', { basePath: rawBase }, config.locale)
        )
      }
    }

    let base = rawBase
    if (base && !base.startsWith('/')) base = '/' + base
    if (base && !base.endsWith('/')) base = base + '/'
    this.#basePath = base

    // 计算并验证基准路径 URL 的合法 pathname 前缀
    const baseFullUrl = new URL(this.#basePath ? this.#basePath.slice(1) : '', this.#endpoint)
    if (
      baseFullUrl.origin !== this.#endpointOrigin ||
      !baseFullUrl.pathname.startsWith(normalizedEndpointUrl.pathname)
    ) {
      throw new WebDavError(
        tSync('webdav.invalidBasePath', { basePath: rawBase }, config.locale)
      )
    }
    this.#basePathname = baseFullUrl.pathname.endsWith('/')
      ? baseFullUrl.pathname
      : `${baseFullUrl.pathname}/`

    this.#preset = config.preset ?? 'generic'
    this.#customHeaders = config.customHeaders ?? {}
    this.#fetch = config.fetchFn ?? globalThis.fetch
  }

  get locale(): string | undefined {
    return this.#locale
  }

  setLocale(locale?: string): void {
    this.#locale = locale
  }

  get endpoint(): string {
    return this.#endpoint
  }

  get basePath(): string {
    return this.#basePath
  }

  get preset(): WebDavPreset {
    return this.#preset
  }

  /**
   * PROPFIND: 查询目录或文件元数据
   * @param remotePath 相对路径（例如 "config.enc" 或 "backups/"）
   * @param depth 检索深度 (0: 仅当前资源, 1: 包含直属子项)
   */
  async propfind(remotePath = '', depth: 0 | 1 = 1, options?: { locale?: string }): Promise<WebDavResource[]> {
    const locale = options?.locale ?? this.#locale
    const url = this.#resolveUrl(remotePath, locale)
    const headers = this.#buildHeaders({
      Depth: String(depth),
      'Content-Type': 'application/xml; charset=utf-8'
    })

    const body = `<?xml version="1.0" encoding="utf-8" ?>
      <D:propfind xmlns:D="DAV:">
        <D:prop>
          <D:resourcetype/>
          <D:getcontentlength/>
          <D:getetag/>
          <D:getlastmodified/>
        </D:prop>
      </D:propfind>`

    const response = await this.#fetch(url, {
      method: 'PROPFIND',
      headers,
      body
    })

    if (!response.ok && response.status !== 207) {
      const text = await response.text().catch(() => '')
      throw new WebDavError(
        tSync(
          'webdav.propfindFailed',
          {
            status: response.status,
            statusText: response.statusText,
            remotePath
          },
          locale
        ),
        response.status,
        response.statusText,
        text
      )
    }

    const xml = await response.text()
    return parseMultiStatusXml(xml)
  }

  /**
   * MKCOL: 创建集合目录
   * 遵循 WebDAV RFC 4918 规范，自动兼容 405 (已存在) 等状态
   */
  async mkcol(remotePath: string, options?: { locale?: string }): Promise<void> {
    const locale = options?.locale ?? this.#locale
    const url = this.#resolveUrl(remotePath, locale)
    const headers = this.#buildHeaders()

    const response = await this.#fetch(url, {
      method: 'MKCOL',
      headers
    })

    // 201 Created 为新建成功；405 Method Not Allowed 代表目录已存在（Nextcloud / 坚果云标准行为）
    if (response.status === 201 || response.status === 200 || response.status === 405) {
      return
    }

    const text = await response.text().catch(() => '')
    throw new WebDavError(
      tSync(
        'webdav.mkcolFailed',
        {
          status: response.status,
          statusText: response.statusText,
          remotePath
        },
        locale
      ),
      response.status,
      response.statusText,
      text
    )
  }

  /**
   * 确保多层目录层级存在（递归 MKCOL）
   */
  async ensureDirectory(dirPath: string, options?: { locale?: string }): Promise<void> {
    const locale = options?.locale ?? this.#locale
    // 先对完整目录路径执行严格穿越校验，避免非法路径触发任何远端请求
    this.#resolveUrl(dirPath, locale)
    const segments = dirPath.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current += segment + '/'
      await this.mkcol(current, options)
    }
  }

  /**
   * GET: 下载文件数据与元数据
   */
  async get(remotePath: string, options?: { locale?: string }): Promise<{ data: Buffer; etag?: string; lastModified?: string }> {
    const locale = options?.locale ?? this.#locale
    const url = this.#resolveUrl(remotePath, locale)
    const headers = this.#buildHeaders()

    const response = await this.#fetch(url, {
      method: 'GET',
      headers
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new WebDavError(
        tSync(
          'webdav.getFailed',
          {
            status: response.status,
            statusText: response.statusText,
            remotePath
          },
          locale
        ),
        response.status,
        response.statusText,
        text
      )
    }

    const arrayBuf = await response.arrayBuffer()
    const data = Buffer.from(arrayBuf)
    const etag = response.headers.get('etag') ?? undefined
    const lastModified = response.headers.get('last-modified') ?? undefined

    return { data, etag, lastModified }
  }

  /**
   * PUT: 上传文件
   * 支持通过 If-Match 头进行乐观锁冲突防护
   */
  async put(
    remotePath: string,
    content: Buffer | string,
    options: { ifMatch?: string; contentType?: string; locale?: string } = {}
  ): Promise<{ etag?: string }> {
    const locale = options.locale ?? this.#locale
    const url = this.#resolveUrl(remotePath, locale)
    const headers = this.#buildHeaders({
      'Content-Type': options.contentType ?? 'application/octet-stream'
    })

    if (options.ifMatch) {
      headers['If-Match'] = options.ifMatch
    }

    const body = (Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')) as unknown as BodyInit

    const response = await this.#fetch(url, {
      method: 'PUT',
      headers,
      body
    })

    if (response.status === 412) {
      throw new WebDavError(
        tSync('webdav.putConflict', undefined, locale),
        412,
        'Precondition Failed'
      )
    }

    if (!response.ok && response.status !== 201 && response.status !== 204) {
      const text = await response.text().catch(() => '')
      throw new WebDavError(
        tSync(
          'webdav.putFailed',
          {
            status: response.status,
            statusText: response.statusText,
            remotePath
          },
          locale
        ),
        response.status,
        response.statusText,
        text
      )
    }

    const etag = response.headers.get('etag') ?? undefined
    return { etag }
  }

  /**
   * DELETE: 删除文件或目录
   */
  async delete(remotePath: string, options?: { locale?: string }): Promise<void> {
    const locale = options?.locale ?? this.#locale
    const url = this.#resolveUrl(remotePath, locale)
    const headers = this.#buildHeaders()

    const response = await this.#fetch(url, {
      method: 'DELETE',
      headers
    })

    if (!response.ok && response.status !== 404 && response.status !== 204) {
      const text = await response.text().catch(() => '')
      throw new WebDavError(
        tSync(
          'webdav.deleteFailed',
          {
            status: response.status,
            statusText: response.statusText,
            remotePath
          },
          locale
        ),
        response.status,
        response.statusText,
        text
      )
    }
  }

  /**
   * 连通性测试
   */
  async testConnection(options?: { locale?: string }): Promise<{ ok: boolean; status: number; message: string }> {
    const locale = options?.locale ?? this.#locale
    try {
      const res = await this.propfind('', 0, { locale })
      return { ok: true, status: 200, message: tSync('webdav.connectionSuccess', { count: res.length }, locale) }
    } catch (error) {
      if (error instanceof WebDavError && error.status) {
        return { ok: false, status: error.status, message: error.message }
      }
      return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }
    }
  }

  #resolveUrl(subPath: string, locale?: string): string {
    const effectiveLocale = locale ?? this.#locale
    if (typeof subPath !== 'string') {
      throw new WebDavError(
        tSync('webdav.invalidSubPath', { subPath: String(subPath) }, effectiveLocale)
      )
    }

    if (subPath.length > 0) {
      if (
        CONTROL_CHAR_REGEX.test(subPath) ||
        subPath.includes('\\') ||
        subPath.startsWith('//') ||
        subPath.includes('://') ||
        ABSOLUTE_SCHEME_REGEX.test(subPath) ||
        ENCODED_TRAVERSAL_REGEX.test(subPath) ||
        subPath.includes('?') ||
        subPath.includes('#')
      ) {
        throw new WebDavError(
          tSync('webdav.invalidSubPath', { subPath }, effectiveLocale)
        )
      }

      const rawSegments = subPath.split('/')
      for (const seg of rawSegments) {
        if (seg === '.' || seg === '..') {
          throw new WebDavError(
            tSync('webdav.invalidSubPath', { subPath }, effectiveLocale)
          )
        }
      }
    }

    const cleanSub = subPath.startsWith('/') ? subPath.slice(1) : subPath
    const fullRelative = this.#basePath ? (this.#basePath.slice(1) + cleanSub) : cleanSub

    let resolved: URL
    try {
      resolved = new URL(fullRelative, this.#endpoint)
    } catch {
      throw new WebDavError(
        tSync('webdav.invalidSubPath', { subPath }, effectiveLocale)
      )
    }

    // 二次断言：解析结果必须与端点同源且 pathname 严格位于基准路径前缀之内
    if (
      resolved.origin !== this.#endpointOrigin ||
      !resolved.pathname.startsWith(this.#basePathname)
    ) {
      throw new WebDavError(
        tSync('webdav.invalidSubPath', { subPath }, effectiveLocale)
      )
    }

    return resolved.toString()
  }

  #buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'ZTools-E2EE-Sync/1.0',
      ...this.#customHeaders,
      ...extra
    }

    if (this.#username && this.#password) {
      const creds = Buffer.from(`${this.#username}:${this.#password}`).toString('base64')
      headers['Authorization'] = `Basic ${creds}`
    }

    return headers
  }
}

/**
 * 健壮的 WebDAV multistatus XML 响应解析器
 * 自动适配各类 XML 命名空间前缀 (<D:response>, <d:response>, <response>)
 */
export function parseMultiStatusXml(xml: string): WebDavResource[] {
  const resources: WebDavResource[] = []
  const responseRegex = /<(?:[a-zA-Z0-9_-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?response>/gi

  let match: RegExpExecArray | null
  while ((match = responseRegex.exec(xml)) !== null) {
    const block = match[1] ?? ''

    const hrefMatch = /<(?:[a-zA-Z0-9_-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?href>/i.exec(block)
    const href = hrefMatch?.[1]?.trim() ?? ''

    const isCollection = /<(?:[a-zA-Z0-9_-]+:)?collection\b[^>]*\/?>/i.test(block)

    const lenMatch = /<(?:[a-zA-Z0-9_-]+:)?getcontentlength\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?getcontentlength>/i.exec(block)
    const contentLength = lenMatch ? Number.parseInt(lenMatch[1]!.trim(), 10) : undefined

    const etagMatch = /<(?:[a-zA-Z0-9_-]+:)?getetag\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?getetag>/i.exec(block)
    const etag = etagMatch?.[1]?.trim().replace(/^"|"$/g, '') || undefined

    const lastModMatch = /<(?:[a-zA-Z0-9_-]+:)?getlastmodified\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?getlastmodified>/i.exec(block)
    const lastModified = lastModMatch?.[1]?.trim() || undefined

    const statusMatch = /<(?:[a-zA-Z0-9_-]+:)?status\b[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?status>/i.exec(block)
    const statusText = statusMatch?.[1]?.trim() ?? ''
    const statusCodeMatch = /HTTP\/[0-9.]+\s+(\d+)/i.exec(statusText)
    const status = statusCodeMatch ? Number.parseInt(statusCodeMatch[1]!, 10) : 200

    const cleanHref = href.replace(/\/+$/, '')
    const name = cleanHref.split('/').pop() ?? ''

    resources.push({
      href,
      name,
      isCollection,
      contentLength,
      etag,
      lastModified,
      status
    })
  }

  return resources
}
