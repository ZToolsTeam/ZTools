import { deriveMasterKey, type Argon2idOptions } from '../crypto/argon2id.js'
import {
  encryptConfigPayload,
  decryptConfigPayload,
  encryptClipboardPayload,
  decryptClipboardPayload,
  type ConfigSyncData,
  type ClipboardSyncData
} from '../crypto/sync-payload.js'
import {
  encryptAesGcm,
  decryptAesGcmString,
  type EncryptedPayload
} from '../crypto/aes-gcm.js'
import { WebDavError, type WebDavSyncAdapter } from '../adapters/webdav-adapter.js'
import { GistConflictError, GistError, type GistSyncAdapter, type GistSyncFile } from '../adapters/gist-adapter.js'

export interface SyncRecord<T = unknown> {
  id: string
  collection?: string
  data: T | null
  updatedAt: number
  deleted?: boolean
  deviceId?: string
}

export interface SyncStateSnapshot {
  schemaVersion: number
  updatedAt: string
  deviceId: string
  records: SyncRecord[]
}

export class SyncConflictError extends Error {
  constructor(
    message: string,
    public readonly localVersion?: string,
    public readonly remoteVersion?: string
  ) {
    super(message)
    this.name = 'SyncConflictError'
  }
}

export interface SyncEngineOptions {
  masterPassword: string | Buffer
  salt: string | Buffer
  argon2Options?: Argon2idOptions
  deviceId?: string
  adapter?: WebDavSyncAdapter | GistSyncAdapter
  remoteFilename?: string
  gistId?: string
  fetchFn?: typeof fetch
}

/**
 * 去中心化端到端加密同步引擎 (E2EE Sync Engine)
 * 集成 Argon2id 强密钥衍生、AES-256-GCM 密文封包、LWW + Tombstone 状态机与 WebDAV / GitHub Gist 远端同步
 */
export class E2eeSyncEngine {
  readonly #derivedKey: Buffer
  readonly #deviceId: string
  readonly #records = new Map<string, SyncRecord>()
  readonly #fetchImpl: typeof fetch
  #adapter?: WebDavSyncAdapter | GistSyncAdapter
  #remoteFilename: string
  #gistId?: string
  #remoteEtag?: string
  #remoteUpdatedAt?: string

  constructor(options: SyncEngineOptions) {
    this.#derivedKey = deriveMasterKey(
      options.masterPassword,
      options.salt,
      options.argon2Options
    )
    this.#deviceId = options.deviceId ?? 'ztools-device-default'
    this.#adapter = options.adapter
    this.#remoteFilename = options.remoteFilename ?? 'ztools_sync_state.enc.json'
    this.#gistId = options.gistId
    this.#fetchImpl = options.fetchFn ?? globalThis.fetch
  }

  get key(): Buffer {
    return this.#derivedKey
  }

  get deviceId(): string {
    return this.#deviceId
  }

  get remoteEtag(): string | undefined {
    return this.#remoteEtag
  }

  get remoteUpdatedAt(): string | undefined {
    return this.#remoteUpdatedAt
  }

  // =========================================================================
  // 本地记录状态机 (LWW + Tombstone 防复活)
  // =========================================================================

  /**
   * 新增或更新同步记录
   */
  upsertRecord<T = unknown>(
    idOrRecord:
      | string
      | {
          id: string
          data?: T
          value?: T
          collection?: string
          updatedAt?: number
          deviceId?: string
        },
    data?: T,
    options?: { collection?: string; updatedAt?: number; deviceId?: string } | number
  ): SyncRecord<T> {
    let id: string
    let payloadData: T
    let collection: string | undefined
    let updatedAt: number
    let deviceId: string

    if (typeof idOrRecord === 'object' && idOrRecord !== null) {
      id = idOrRecord.id
      payloadData = (idOrRecord.data !== undefined ? idOrRecord.data : idOrRecord.value) as T
      collection = idOrRecord.collection
      updatedAt = idOrRecord.updatedAt ?? Date.now()
      deviceId = idOrRecord.deviceId ?? this.#deviceId
    } else {
      id = idOrRecord
      payloadData = data as T
      if (typeof options === 'number') {
        updatedAt = options
        collection = undefined
        deviceId = this.#deviceId
      } else {
        updatedAt = options?.updatedAt ?? Date.now()
        collection = options?.collection
        deviceId = options?.deviceId ?? this.#deviceId
      }
    }

    if (!id || typeof id !== 'string') {
      throw new Error('同步记录 ID 必须为非空字符串')
    }

    const existing = this.#records.get(id)
    const record: SyncRecord<T> = {
      id,
      ...(collection ?? existing?.collection ? { collection: collection ?? existing?.collection } : {}),
      data: payloadData,
      updatedAt,
      deleted: false,
      deviceId
    }
    this.#records.set(id, record)
    return record
  }

  /**
   * 标记删除同步记录（生成 Tombstone 墓碑记录防止旧版本复活）
   */
  deleteRecord(
    id: string,
    options?: { updatedAt?: number; deviceId?: string; collection?: string } | number
  ): SyncRecord<null> {
    if (!id || typeof id !== 'string') {
      throw new Error('同步记录 ID 必须为非空字符串')
    }
    const existing = this.#records.get(id)
    const updatedAt =
      typeof options === 'number'
        ? options
        : options?.updatedAt ?? Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1)
    const deviceId =
      typeof options === 'object' && options?.deviceId ? options.deviceId : this.#deviceId
    const collection =
      typeof options === 'object' && options?.collection ? options.collection : existing?.collection

    const tombstone: SyncRecord<null> = {
      id,
      ...(collection ? { collection } : {}),
      data: null,
      updatedAt,
      deleted: true,
      deviceId
    }
    this.#records.set(id, tombstone)
    return tombstone
  }

  /**
   * 获取单条同步记录（默认过滤已删除的墓碑记录）
   */
  getRecord<T = unknown>(
    id: string,
    options?: { includeDeleted?: boolean }
  ): SyncRecord<T> | undefined {
    const record = this.#records.get(id) as SyncRecord<T> | undefined
    if (!record) return undefined
    if (record.deleted && !options?.includeDeleted) {
      return undefined
    }
    return record
  }

  /**
   * 列出当前所有同步记录（默认不包含已删除的墓碑记录）
   */
  listRecords<T = unknown>(options?: {
    collection?: string
    includeDeleted?: boolean
  }): SyncRecord<T>[] {
    const result: SyncRecord<T>[] = []
    for (const record of this.#records.values()) {
      if (record.deleted && !options?.includeDeleted) continue
      if (options?.collection && record.collection !== options.collection) continue
      result.push(record as SyncRecord<T>)
    }
    return result
  }

  /**
   * 基于 LWW (Last-Write-Wins) 与 Tombstone 墓碑机制合并远端记录集
   */
  mergeRecords(remoteRecords: SyncRecord[]): SyncRecord[] {
    for (const remote of remoteRecords) {
      if (!remote || typeof remote.id !== 'string') continue
      const local = this.#records.get(remote.id)
      if (!local) {
        this.#records.set(remote.id, { ...remote })
        continue
      }

      if (remote.updatedAt > local.updatedAt) {
        this.#records.set(remote.id, { ...remote })
      } else if (remote.updatedAt === local.updatedAt) {
        // 时间戳相同时：墓碑删除优先（防复活），否则按 deviceId 字典序决胜保证多端收敛一致
        if (remote.deleted && !local.deleted) {
          this.#records.set(remote.id, { ...remote })
        } else if (remote.deleted === local.deleted) {
          const remoteDev = remote.deviceId ?? ''
          const localDev = local.deviceId ?? ''
          if (remoteDev > localDev) {
            this.#records.set(remote.id, { ...remote })
          }
        }
      }
      // 若 remote.updatedAt < local.updatedAt，保留本地（含本地 Tombstone 防复活）
    }
    return this.listRecords()
  }

  /**
   * 将当前状态机记录加密推送至远端（支持新设备未 pull 防盲目覆盖拦截）
   */
  async push(
    targetAdapter?: WebDavSyncAdapter | GistSyncAdapter,
    options?: { force?: boolean; filename?: string; gistId?: string }
  ): Promise<{ etag?: string; gistId?: string; updatedAt?: string }> {
    const adapter = targetAdapter ?? this.#adapter
    if (!adapter) {
      throw new Error('未配置同步适配器 (WebDavSyncAdapter 或 GistSyncAdapter)')
    }

    const filename = options?.filename ?? this.#remoteFilename
    const snapshot: SyncStateSnapshot = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      deviceId: this.#deviceId,
      records: Array.from(this.#records.values())
    }
    const aad = `ztools:sync-state:v${snapshot.schemaVersion}`
    const encrypted = encryptAesGcm(JSON.stringify(snapshot), this.#derivedKey, aad)
    const serialized = JSON.stringify(encrypted, null, 2)

    if (this.#isWebDavAdapter(adapter)) {
      if (!this.#remoteEtag && !options?.force) {
        // 本地尚无基线版本号，先检查远端是否已存在同步文件
        const existsOnRemote = await this.#checkWebDavRemoteExists(adapter, filename)
        if (existsOnRemote) {
          throw new SyncConflictError(
            '检测到远端已存在同步数据，而本地尚无同步基线版本号；请先执行 pull() 或 sync() 合并远端数据后再推送'
          )
        }
      }

      try {
        const res = await adapter.put(filename, serialized, {
          contentType: 'application/json',
          ...(this.#remoteEtag ? { ifMatch: this.#remoteEtag } : {})
        })
        if (res.etag) {
          this.#remoteEtag = res.etag
        }
        return { etag: res.etag }
      } catch (err) {
        if (err instanceof WebDavError && err.status === 412) {
          throw new SyncConflictError(err.message, this.#remoteEtag)
        }
        throw err
      }
    }

    // Gist 适配器分支
    const gistId = options?.gistId ?? this.#gistId ?? adapter.gistId
    if (!this.#remoteUpdatedAt && !options?.force && gistId) {
      const existingGist = await this.#tryGetGist(adapter, gistId)
      if (existingGist && existingGist.files[filename]) {
        throw new SyncConflictError(
          '检测到远端 Gist 已存在同步文件，而本地尚无同步基线版本号；请先执行 pull() 或 sync() 合并远端数据后再推送',
          undefined,
          existingGist.updatedAt
        )
      }
    }

    if (!gistId) {
      const created = await adapter.createGist(
        { [filename]: { content: serialized } },
        'ZTools E2EE Encrypted Sync State'
      )
      this.#gistId = created.id
      this.#remoteUpdatedAt = created.updatedAt
      return { gistId: created.id, updatedAt: created.updatedAt }
    }

    try {
      const updated = await adapter.updateGist(
        gistId,
        { [filename]: { content: serialized } },
        this.#remoteUpdatedAt ? { expectedUpdatedAt: this.#remoteUpdatedAt } : {}
      )
      this.#gistId = updated.id
      this.#remoteUpdatedAt = updated.updatedAt
      return { gistId: updated.id, updatedAt: updated.updatedAt }
    } catch (err) {
      if (err instanceof GistConflictError) {
        throw new SyncConflictError(
          err.message,
          err.localExpectedUpdatedAt,
          err.remoteUpdatedAt
        )
      }
      throw err
    }
  }

  /**
   * 从远端拉取加密状态快照并与本地记录按 LWW + Tombstone 合并
   */
  async pull(
    targetAdapter?: WebDavSyncAdapter | GistSyncAdapter,
    options?: { filename?: string; gistId?: string }
  ): Promise<{ records: SyncRecord[]; etag?: string; updatedAt?: string }> {
    const adapter = targetAdapter ?? this.#adapter
    if (!adapter) {
      throw new Error('未配置同步适配器 (WebDavSyncAdapter 或 GistSyncAdapter)')
    }

    const filename = options?.filename ?? this.#remoteFilename
    if (this.#isWebDavAdapter(adapter)) {
      const { data, etag } = await adapter.get(filename)
      const payload = JSON.parse(data.toString('utf8')) as EncryptedPayload
      const snapshot = this.#decryptStateSnapshot(payload)
      this.#remoteEtag = etag ?? '"webdav-synced"'
      this.mergeRecords(snapshot.records)
      return { records: this.listRecords(), etag: this.#remoteEtag }
    }

    const gistId = options?.gistId ?? this.#gistId ?? adapter.gistId
    const { snapshot, updatedAt, resolvedGistId } = await this.#pullFromGist(
      adapter,
      filename,
      gistId
    )
    this.#gistId = resolvedGistId
    this.#remoteUpdatedAt = updatedAt
    this.mergeRecords(snapshot.records)
    return { records: this.listRecords(), updatedAt }
  }

  /**
   * 双向同步：先拉取远端数据（若存在）进行 LWW + Tombstone 合并，再将合并结果推送回远端
   */
  async sync(
    targetAdapter?: WebDavSyncAdapter | GistSyncAdapter,
    options?: { filename?: string; gistId?: string }
  ): Promise<{ records: SyncRecord[]; etag?: string; gistId?: string; updatedAt?: string }> {
    const adapter = targetAdapter ?? this.#adapter
    if (!adapter) {
      throw new Error('未配置同步适配器 (WebDavSyncAdapter 或 GistSyncAdapter)')
    }

    try {
      await this.pull(adapter, options)
    } catch (err) {
      const isNotFound =
        (err instanceof WebDavError && err.status === 404) ||
        (err instanceof GistError && err.status === 404) ||
        (err instanceof Error && err.message.includes('未找到'))
      if (!isNotFound) {
        throw err
      }
    }

    const pushRes = await this.push(adapter, { ...options, force: true })
    return {
      records: this.listRecords(),
      ...pushRes
    }
  }

  // =========================================================================
  // WebDAV 同步链路
  // =========================================================================

  /**
   * 将全量配置加密并推送到 WebDAV
   */
  async pushConfigToWebDav(
    adapter: WebDavSyncAdapter,
    config: ConfigSyncData,
    remoteFilename = 'ztools_config.enc',
    options?: { ifMatch?: string }
  ): Promise<{ etag?: string }> {
    const payload = encryptConfigPayload(config, this.#derivedKey)
    const jsonStr = JSON.stringify(payload, null, 2)
    return adapter.put(remoteFilename, jsonStr, {
      contentType: 'application/json',
      ...(options?.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {})
    })
  }

  /**
   * 从 WebDAV 拉取并解密全量配置
   */
  async pullConfigFromWebDav(
    adapter: WebDavSyncAdapter,
    remoteFilename = 'ztools_config.enc'
  ): Promise<{ config: ConfigSyncData; etag?: string; lastModified?: string }> {
    const { data, etag, lastModified } = await adapter.get(remoteFilename)
    const payload = JSON.parse(data.toString('utf8')) as EncryptedPayload
    const config = decryptConfigPayload(payload, this.#derivedKey)
    return { config, etag, lastModified }
  }

  /**
   * 将剪贴板历史加密并推送到 WebDAV
   */
  async pushClipboardToWebDav(
    adapter: WebDavSyncAdapter,
    clipboard: ClipboardSyncData,
    remoteFilename = 'ztools_clipboard.enc',
    options?: { ifMatch?: string }
  ): Promise<{ etag?: string }> {
    const payload = encryptClipboardPayload(clipboard, this.#derivedKey)
    const jsonStr = JSON.stringify(payload, null, 2)
    return adapter.put(remoteFilename, jsonStr, {
      contentType: 'application/json',
      ...(options?.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {})
    })
  }

  /**
   * 从 WebDAV 拉取并解密剪贴板历史
   */
  async pullClipboardFromWebDav(
    adapter: WebDavSyncAdapter,
    remoteFilename = 'ztools_clipboard.enc'
  ): Promise<{ clipboard: ClipboardSyncData; etag?: string; lastModified?: string }> {
    const { data, etag, lastModified } = await adapter.get(remoteFilename)
    const payload = JSON.parse(data.toString('utf8')) as EncryptedPayload
    const clipboard = decryptClipboardPayload(payload, this.#derivedKey)
    return { clipboard, etag, lastModified }
  }

  // =========================================================================
  // GitHub Gist 同步链路
  // =========================================================================

  /**
   * 将全量配置加密并推送到 GitHub 私有 Gist
   */
  async pushConfigToGist(
    adapter: GistSyncAdapter,
    config: ConfigSyncData,
    gistId?: string,
    options?: { expectedUpdatedAt?: string }
  ): Promise<{ gistId: string; updatedAt: string }> {
    const payload = encryptConfigPayload(config, this.#derivedKey)
    const fileContent = JSON.stringify(payload, null, 2)
    const filename = 'ztools_config.enc.json'

    if (!gistId && !adapter.gistId) {
      const created = await adapter.createGist({
        [filename]: { content: fileContent }
      }, 'ZTools E2EE Encrypted Configuration')
      return { gistId: created.id, updatedAt: created.updatedAt }
    }

    const targetId = (gistId ?? adapter.gistId)!
    const updated = await adapter.updateGist(
      targetId,
      { [filename]: { content: fileContent } },
      options
    )
    return { gistId: updated.id, updatedAt: updated.updatedAt }
  }

  /**
   * 从 GitHub 私有 Gist 拉取并解密全量配置
   */
  async pullConfigFromGist(
    adapter: GistSyncAdapter,
    gistId?: string
  ): Promise<{ config: ConfigSyncData; updatedAt: string; gistId: string }> {
    const gist = await adapter.getGist(gistId)
    const filename = 'ztools_config.enc.json'
    const file = gist.files[filename]
    if (!file) {
      throw new Error(`Gist [${gist.id}] 中未找到加密配置文件: ${filename}`)
    }

    const rawContent = await this.#resolveGistFileContent(file)
    if (!rawContent) {
      throw new Error(`Gist [${gist.id}] 中未找到加密配置文件: ${filename}`)
    }

    const payload = JSON.parse(rawContent) as EncryptedPayload
    const config = decryptConfigPayload(payload, this.#derivedKey)
    return { config, updatedAt: gist.updatedAt, gistId: gist.id }
  }

  /**
   * 将剪贴板历史加密并推送到 GitHub Gist
   */
  async pushClipboardToGist(
    adapter: GistSyncAdapter,
    clipboard: ClipboardSyncData,
    gistId?: string,
    options?: { expectedUpdatedAt?: string }
  ): Promise<{ gistId: string; updatedAt: string }> {
    const payload = encryptClipboardPayload(clipboard, this.#derivedKey)
    const fileContent = JSON.stringify(payload, null, 2)
    const filename = 'ztools_clipboard.enc.json'

    if (!gistId && !adapter.gistId) {
      const created = await adapter.createGist({
        [filename]: { content: fileContent }
      }, 'ZTools E2EE Encrypted Clipboard')
      return { gistId: created.id, updatedAt: created.updatedAt }
    }

    const targetId = (gistId ?? adapter.gistId)!
    const updated = await adapter.updateGist(
      targetId,
      { [filename]: { content: fileContent } },
      options
    )
    return { gistId: updated.id, updatedAt: updated.updatedAt }
  }

  /**
   * 从 GitHub Gist 拉取并解密剪贴板历史
   */
  async pullClipboardFromGist(
    adapter: GistSyncAdapter,
    gistId?: string
  ): Promise<{ clipboard: ClipboardSyncData; updatedAt: string; gistId: string }> {
    const gist = await adapter.getGist(gistId)
    const filename = 'ztools_clipboard.enc.json'
    const file = gist.files[filename]
    if (!file) {
      throw new Error(`Gist [${gist.id}] 中未找到加密剪贴板文件: ${filename}`)
    }

    const rawContent = await this.#resolveGistFileContent(file)
    if (!rawContent) {
      throw new Error(`Gist [${gist.id}] 中未找到加密剪贴板文件: ${filename}`)
    }

    const payload = JSON.parse(rawContent) as EncryptedPayload
    const clipboard = decryptClipboardPayload(payload, this.#derivedKey)
    return { clipboard, updatedAt: gist.updatedAt, gistId: gist.id }
  }

  // =========================================================================
  // 内部辅助方法
  // =========================================================================

  #isWebDavAdapter(adapter: WebDavSyncAdapter | GistSyncAdapter): adapter is WebDavSyncAdapter {
    return typeof (adapter as WebDavSyncAdapter).put === 'function' &&
      typeof (adapter as WebDavSyncAdapter).get === 'function'
  }

  async #checkWebDavRemoteExists(adapter: WebDavSyncAdapter, filename: string): Promise<boolean> {
    try {
      await adapter.get(filename)
      return true
    } catch (err) {
      if (err instanceof WebDavError && err.status === 404) {
        return false
      }
      throw err
    }
  }

  async #tryGetGist(adapter: GistSyncAdapter, gistId: string) {
    try {
      return await adapter.getGist(gistId)
    } catch (err) {
      if (err instanceof GistError && err.status === 404) {
        return null
      }
      throw err
    }
  }

  async #resolveGistFileContent(
    fileData: GistSyncFile & { raw_url?: string }
  ): Promise<string> {
    const rawUrl = fileData.rawUrl ?? fileData.raw_url
    if (fileData.truncated === true && rawUrl) {
      const response = await this.#fetchImpl(rawUrl, { method: 'GET' })
      if (!response.ok) {
        throw new GistError(
          `通过 raw_url 拉取截断密文失败 [${response.status} ${response.statusText}]`,
          response.status,
          response.statusText
        )
      }
      return await response.text()
    }
    return fileData.content
  }

  async #pullFromGist(
    adapter: GistSyncAdapter,
    filename: string,
    gistId?: string
  ): Promise<{ snapshot: SyncStateSnapshot; updatedAt: string; resolvedGistId: string }> {
    const gist = await adapter.getGist(gistId)
    const fileData = gist.files[filename] as (GistSyncFile & { raw_url?: string }) | undefined
    if (!fileData) {
      throw new Error(`Gist [${gist.id}] 中未找到加密同步文件: ${filename}`)
    }

    const content = await this.#resolveGistFileContent(fileData)
    if (!content) {
      throw new Error(`Gist [${gist.id}] 中同步文件内容为空: ${filename}`)
    }

    const payload = JSON.parse(content) as EncryptedPayload
    const snapshot = this.#decryptStateSnapshot(payload)
    return {
      snapshot,
      updatedAt: gist.updatedAt,
      resolvedGistId: gist.id
    }
  }

  #decryptStateSnapshot(payload: EncryptedPayload): SyncStateSnapshot {
    const jsonStr = decryptAesGcmString(payload, this.#derivedKey)
    const parsed = JSON.parse(jsonStr) as SyncStateSnapshot
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
      throw new Error('解密后的同步状态数据格式无效')
    }
    return parsed
  }
}
