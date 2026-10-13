export interface GistConfig {
  token: string
  gistId?: string
  fetchFn?: typeof fetch
}

export interface GistSyncFile {
  filename: string
  content: string
  truncated?: boolean
  size?: number
}

export interface GistReadResult {
  id: string
  description: string
  updatedAt: string
  createdAt: string
  etag?: string
  files: Record<string, GistSyncFile>
  isPublic: boolean
}

export class GistError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly statusText?: string,
    public readonly responseBody?: string
  ) {
    super(message)
    this.name = 'GistError'
  }
}

export class GistConflictError extends GistError {
  constructor(
    message: string,
    public readonly localExpectedUpdatedAt: string,
    public readonly remoteUpdatedAt: string,
    public readonly remoteFiles: Record<string, GistSyncFile>
  ) {
    super(message, 409, 'Conflict')
    this.name = 'GistConflictError'
  }
}

/**
 * GitHub Gist 去中心化同步适配器
 * 基于 GitHub Personal Access Token (PAT) 的私有 Gist 读写与高精度并发冲突检测
 */
export class GistSyncAdapter {
  readonly #token: string
  #gistId?: string
  readonly #fetch: typeof fetch
  readonly #baseUrl = 'https://api.github.com'

  constructor(config: GistConfig) {
    const trimmedToken = config.token.trim()
    if (!trimmedToken) {
      throw new Error('GitHub Gist 适配器需要有效的 Personal Access Token')
    }
    this.#token = trimmedToken
    this.#gistId = config.gistId?.trim()
    this.#fetch = config.fetchFn ?? globalThis.fetch
  }

  get gistId(): string | undefined {
    return this.#gistId
  }

  set gistId(value: string | undefined) {
    this.#gistId = value?.trim()
  }

  /**
   * 读取 Gist 内容与元数据
   */
  async getGist(targetGistId?: string): Promise<GistReadResult> {
    const id = targetGistId ?? this.#gistId
    if (!id) {
      throw new GistError('未指定目标 Gist ID')
    }

    const url = `${this.#baseUrl}/gists/${id}`
    const response = await this.#fetch(url, {
      method: 'GET',
      headers: this.#buildHeaders()
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new GistError(
        `获取 Gist 失败 [${response.status} ${response.statusText}]`,
        response.status,
        response.statusText,
        text
      )
    }

    const data = await response.json() as Record<string, unknown>
    return this.#parseGistResponse(data, response.headers.get('etag') ?? undefined)
  }

  /**
   * 创建新的私有 Gist (public = false)
   */
  async createGist(
    files: Record<string, { content: string }>,
    description = 'ZTools E2EE Encrypted Sync'
  ): Promise<GistReadResult> {
    const url = `${this.#baseUrl}/gists`
    const body = JSON.stringify({
      description,
      public: false,
      files
    })

    const response = await this.#fetch(url, {
      method: 'POST',
      headers: this.#buildHeaders({ 'Content-Type': 'application/json' }),
      body
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new GistError(
        `创建私有 Gist 失败 [${response.status} ${response.statusText}]`,
        response.status,
        response.statusText,
        text
      )
    }

    const data = await response.json() as Record<string, unknown>
    const result = this.#parseGistResponse(data, response.headers.get('etag') ?? undefined)
    this.#gistId = result.id
    return result
  }

  /**
   * 更新 Gist 并进行并发冲突检测
   * @param gistId 目标 Gist ID
   * @param files 文件增量修改（设置 content 为 null 代表删除该文件）
   * @param options 包含 expectedUpdatedAt：如果远程已被第三方修改，将立即抛出 GistConflictError
   */
  async updateGist(
    gistId: string,
    files: Record<string, { content: string } | null>,
    options: {
      expectedUpdatedAt?: string
      description?: string
    } = {}
  ): Promise<GistReadResult> {
    // 若开启冲突检测，先拉取最新元数据进行比对
    if (options.expectedUpdatedAt) {
      const current = await this.getGist(gistId)
      if (current.updatedAt !== options.expectedUpdatedAt) {
        throw new GistConflictError(
          `检测到 Gist 同步冲突：远程版本已在 ${current.updatedAt} 被更新，本地预期为 ${options.expectedUpdatedAt}`,
          options.expectedUpdatedAt,
          current.updatedAt,
          current.files
        )
      }
    }

    const url = `${this.#baseUrl}/gists/${gistId}`
    const payload: Record<string, unknown> = { files }
    if (options.description) {
      payload.description = options.description
    }

    const response = await this.#fetch(url, {
      method: 'PATCH',
      headers: this.#buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new GistError(
        `更新 Gist 失败 [${response.status} ${response.statusText}]`,
        response.status,
        response.statusText,
        text
      )
    }

    const data = await response.json() as Record<string, unknown>
    return this.#parseGistResponse(data, response.headers.get('etag') ?? undefined)
  }

  #buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.#token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ZTools-E2EE-Sync/1.0',
      ...extra
    }
  }

  #parseGistResponse(data: Record<string, unknown>, etag?: string): GistReadResult {
    const rawFiles = (data.files ?? {}) as Record<string, Record<string, unknown>>
    const files: Record<string, GistSyncFile> = {}

    for (const [key, fileObj] of Object.entries(rawFiles)) {
      files[key] = {
        filename: String(fileObj.filename ?? key),
        content: String(fileObj.content ?? ''),
        truncated: Boolean(fileObj.truncated),
        size: typeof fileObj.size === 'number' ? fileObj.size : undefined
      }
    }

    return {
      id: String(data.id ?? ''),
      description: String(data.description ?? ''),
      updatedAt: String(data.updated_at ?? ''),
      createdAt: String(data.created_at ?? ''),
      etag,
      files,
      isPublic: Boolean(data.public)
    }
  }
}
