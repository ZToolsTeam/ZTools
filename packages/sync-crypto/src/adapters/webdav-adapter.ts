export type WebDavPreset = 'jianguoyun' | 'nextcloud' | 'synology' | 'generic'

export interface WebDavConfig {
  endpoint: string
  username?: string
  password?: string
  basePath?: string
  preset?: WebDavPreset
  customHeaders?: Record<string, string>
  fetchFn?: typeof fetch
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

/**
 * WebDAV 去中心化同步协议适配器
 * 全面支持坚果云、Nextcloud、群晖/私有 NAS 等主流 WebDAV 服务
 */
export class WebDavSyncAdapter {
  readonly #endpoint: string
  readonly #username?: string
  readonly #password?: string
  readonly #basePath: string
  readonly #preset: WebDavPreset
  readonly #customHeaders: Record<string, string>
  readonly #fetch: typeof fetch

  constructor(config: WebDavConfig) {
    let ep = config.endpoint.trim()
    if (!ep.endsWith('/')) ep += '/'
    this.#endpoint = ep

    this.#username = config.username
    this.#password = config.password

    let base = (config.basePath ?? '').trim()
    if (base && !base.startsWith('/')) base = '/' + base
    if (base && !base.endsWith('/')) base = base + '/'
    this.#basePath = base

    this.#preset = config.preset ?? 'generic'
    this.#customHeaders = config.customHeaders ?? {}
    this.#fetch = config.fetchFn ?? globalThis.fetch
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
  async propfind(remotePath = '', depth: 0 | 1 = 1): Promise<WebDavResource[]> {
    const url = this.#resolveUrl(remotePath)
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
        `PROPFIND 失败 [${response.status} ${response.statusText}]: ${remotePath}`,
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
  async mkcol(remotePath: string): Promise<void> {
    const url = this.#resolveUrl(remotePath)
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
      `MKCOL 创建目录失败 [${response.status} ${response.statusText}]: ${remotePath}`,
      response.status,
      response.statusText,
      text
    )
  }

  /**
   * 确保多层目录层级存在（递归 MKCOL）
   */
  async ensureDirectory(dirPath: string): Promise<void> {
    const segments = dirPath.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current += segment + '/'
      await this.mkcol(current)
    }
  }

  /**
   * GET: 下载文件数据与元数据
   */
  async get(remotePath: string): Promise<{ data: Buffer; etag?: string; lastModified?: string }> {
    const url = this.#resolveUrl(remotePath)
    const headers = this.#buildHeaders()

    const response = await this.#fetch(url, {
      method: 'GET',
      headers
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new WebDavError(
        `GET 下载文件失败 [${response.status} ${response.statusText}]: ${remotePath}`,
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
    options: { ifMatch?: string; contentType?: string } = {}
  ): Promise<{ etag?: string }> {
    const url = this.#resolveUrl(remotePath)
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
        `PUT 发生并发冲突（412 Precondition Failed）：远程版本与 If-Match 不符`,
        412,
        'Precondition Failed'
      )
    }

    if (!response.ok && response.status !== 201 && response.status !== 204) {
      const text = await response.text().catch(() => '')
      throw new WebDavError(
        `PUT 上传文件失败 [${response.status} ${response.statusText}]: ${remotePath}`,
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
  async delete(remotePath: string): Promise<void> {
    const url = this.#resolveUrl(remotePath)
    const headers = this.#buildHeaders()

    const response = await this.#fetch(url, {
      method: 'DELETE',
      headers
    })

    if (!response.ok && response.status !== 404 && response.status !== 204) {
      const text = await response.text().catch(() => '')
      throw new WebDavError(
        `DELETE 删除失败 [${response.status} ${response.statusText}]: ${remotePath}`,
        response.status,
        response.statusText,
        text
      )
    }
  }

  /**
   * 连通性测试
   */
  async testConnection(): Promise<{ ok: boolean; status: number; message: string }> {
    try {
      const res = await this.propfind('', 0)
      return { ok: true, status: 200, message: `连接成功 (检测到 ${res.length} 个资源)` }
    } catch (error) {
      if (error instanceof WebDavError && error.status) {
        return { ok: false, status: error.status, message: error.message }
      }
      return { ok: false, status: 0, message: error instanceof Error ? error.message : String(error) }
    }
  }

  #resolveUrl(subPath: string): string {
    const cleanSub = subPath.startsWith('/') ? subPath.slice(1) : subPath
    const fullRelative = this.#basePath ? (this.#basePath.slice(1) + cleanSub) : cleanSub
    return new URL(fullRelative, this.#endpoint).toString()
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
