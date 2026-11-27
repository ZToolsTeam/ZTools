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
import { tSync } from '../i18n.js'

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
  locale?: string
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
  #locale?: string
  #destroyed = false

  constructor(options: SyncEngineOptions) {
    this.#locale = options.locale
    this.#derivedKey = deriveMasterKey(
      options.masterPassword,
      options.salt,
      {
        ...options.argon2Options,
        locale: options.argon2Options?.locale ?? options.locale
      }
    )
    this.#deviceId = options.deviceId ?? 'ztools-device-default'
    this.#adapter = options.adapter
    this.#remoteFilename = options.remoteFilename ?? 'ztools_sync_state.enc.json'
    this.#gistId = options.gistId
    this.#fetchImpl = options.fetchFn ?? globalThis.fetch
  }

  get locale(): string | undefined {
    return this.#locale
  }

  setLocale(locale?: string): void {
    this.#locale = locale
  }

  /**
   * 当前同步引擎是否已销毁并清零派生密钥
   */
  get isDestroyed(): boolean {
    return this.#destroyed
  }

  /**
   * 销毁同步引擎：彻底清零内存中的派生密钥并清空本地记录（幂等操作）
   */
  destroy(): void {
    if (this.#destroyed) return
    this.#derivedKey.fill(0)
    this.#records.clear()
    this.#destroyed = true
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
          locale?: string
        },
    data?: T,
    options?: { collection?: string; updatedAt?: number; deviceId?: string; locale?: string } | number
  ): SyncRecord<T> {
    let id: string
    let payloadData: T
    let collection: string | undefined
    let updatedAt: number
    let deviceId: string
    let locale: string | undefined = this.#locale

    if (typeof idOrRecord === 'object' && idOrRecord !== null) {
      id = idOrRecord.id
      payloadData = (idOrRecord.data !== undefined ? idOrRecord.data : idOrRecord.value) as T
      collection = idOrRecord.collection
      updatedAt = idOrRecord.updatedAt ?? Date.now()
      deviceId = idOrRecord.deviceId ?? this.#deviceId
      locale = idOrRecord.locale ?? this.#locale
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
        locale = options?.locale ?? this.#locale
      }
    }

    if (!id || typeof id !== 'string') {
      throw new Error(tSync('engine.invalidRecordId', undefined, locale))
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
    options?: { updatedAt?: number; deviceId?: string; collection?: string; locale?: string } | number
  ): SyncRecord<null> {
    const locale = (typeof options === 'object' ? options?.locale : undefined) ?? this.#locale
    if (!id || typeof id !== 'string') {
      throw new Error(tSync('engine.invalidRecordId', undefined, locale))
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
    options?: { force?: boolean; filename?: string; gistId?: string; locale?: string }
  ): Promise<{ etag?: string; gistId?: string; updatedAt?: string }> {
    const locale = options?.locale ?? this.#locale
    this.#assertNotDestroyed(locale)
    const adapter = targetAdapter ?? this.#adapter
    if (!adapter) {
      throw new Error(tSync('engine.missingAdapter', undefined, locale))
    }

    const filename = options?.filename ?? this.#remoteFilename
    const snapshot: SyncStateSnapshot = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      deviceId: this.#deviceId,
      records: Array.from(this.#records.values())
    }
    const aad = `ztools:sync-state:v${snapshot.schemaVersion}`
    const encrypted = encryptAesGcm(JSON.stringify(snapshot), this.#derivedKey, aad, locale)
    const serialized = JSON.stringify(encrypted, null, 2)

    if (this.#isWebDavAdapter(adapter)) {
      if (!this.#remoteEtag && !options?.force) {
        // 本地尚无基线版本号，先检查远端是否已存在同步文件
        const existsOnRemote = await this.#checkWebDavRemoteExists(adapter, filename, locale)
        if (existsOnRemote) {
          throw new SyncConflictError(
            tSync('engine.remoteExistsBaselineMissing', undefined, locale)
          )
        }
      }

      try {
        const res = await adapter.put(filename, serialized, {
          contentType: 'application/json',
          ...(this.#remoteEtag ? { ifMatch: this.#remoteEtag } : {}),
          ...(locale !== undefined ? { locale } : {})
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
      const existingGist = await this.#tryGetGist(adapter, gistId, locale)
      if (existingGist && existingGist.files[filename]) {
        throw new SyncConflictError(
          tSync('engine.remoteGistExistsBaselineMissing', undefined, locale),
          undefined,
          existingGist.updatedAt
        )
      }
    }

    if (!gistId) {
      const created = await adapter.createGist(
        { [filename]: { content: serialized } },
        'ZTools E2EE Encrypted Sync State',
        locale !== undefined ? { locale } : undefined
      )
      this.#gistId = created.id
      this.#remoteUpdatedAt = created.updatedAt
      return { gistId: created.id, updatedAt: created.updatedAt }
    }

    try {
      const updated = await adapter.updateGist(
        gistId,
        { [filename]: { content: serialized } },
        {
          ...(this.#remoteUpdatedAt ? { expectedUpdatedAt: this.#remoteUpdatedAt } : {}),
          ...(locale !== undefined ? { locale } : {})
        }
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
    options?: { filename?: string; gistId?: string; locale?: string }
  ): Promise<{ records: SyncRecord[]; etag?: string; updatedAt?: string }> {
    const locale = options?.locale ?? this.#locale
    this.#assertNotDestroyed(locale)
    const adapter = targetAdapter ?? this.#adapter
    if (!adapter) {
      throw new Error(tSync('engine.missingAdapter', undefined, locale))
    }

    const filename = options?.filename ?? this.#remoteFilename
    if (this.#isWebDavAdapter(adapter)) {
      const { data, etag } = await adapter.get(filename, locale !== undefined ? { locale } : undefined)
      const payload = JSON.parse(data.toString('utf8')) as EncryptedPayload
      const snapshot = this.#decryptStateSnapshot(payload, locale)
      this.#remoteEtag = etag ?? '"webdav-synced"'
      this.mergeRecords(snapshot.records)
      return { records: this.listRecords(), etag: this.#remoteEtag }
    }

    const gistId = options?.gistId ?? this.#gistId ?? adapter.gistId
    const { snapshot, updatedAt, resolvedGistId } = await this.#pullFromGist(
      adapter,
      filename,
      gistId,
      locale
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
    options?: { filename?: string; gistId?: string; locale?: string }
  ): Promise<{ records: SyncRecord[]; etag?: string; gistId?: string; updatedAt?: string }> {
    const locale = options?.locale ?? this.#locale
    this.#assertNotDestroyed(locale)
    const adapter = targetAdapter ?? this.#adapter
    if (!adapter) {
      throw new Error(tSync('engine.missingAdapter', undefined, locale))
    }

    try {
      await this.pull(adapter, options)
    } catch (err) {
      const isNotFound =
        (err instanceof WebDavError && err.status === 404) ||
        (err instanceof GistError && err.status === 404)
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
    options?: { ifMatch?: string; locale?: string }
  ): Promise<{ etag?: string }> {
    const locale = options?.locale ?? this.#locale
    this.#assertNotDestroyed(locale)
    const payload = encryptConfigPayload(config, this.#derivedKey, locale)
    const jsonStr = JSON.stringify(payload, null, 2)
    return adapter.put(remoteFilename, jsonStr, {
      contentType: 'application/json',
      ...(options?.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}),
      ...(locale !== undefined ? { locale } : {})
    })
  }

  /**
   * 从 WebDAV 拉取并解密全量配置
   */
  async pullConfigFromWebDav(
    adapter: WebDavSyncAdapter,
    remoteFilename = 'ztools_config.enc',
    options?: { locale?: string }
  ): Promise<{ config: ConfigSyncData; etag?: string; lastModified?: string }> {
    const locale = options?.locale ?? this.#locale
    this.#assertNotDestroyed(locale)
    const { data, etag, lastModified } = await adapter.get(
      remoteFilename,
      locale !== undefined ? { locale } : undefined
    )
    const payload = JSON.parse(data.toString('utf8')) as EncryptedPayload
    const config = decryptConfigPayload(payload, this.#derivedKey, locale)
    return { config, etag, lastModified }
  }

  /**
   * 将剪贴板历史加密并推送到 WebDAV
   */
  async pushClipboardToWebDav(
    adapter: WebDavSyncAdapter,
    clipboard: ClipboardSyncData,
    remoteFilename = 'ztools_clipboard.enc',
    options?: { ifMatch?: string; locale?: string }
  ): Promise<{ etag?: string }> {
    const locale = options?.locale ?? this.#locale
    this.#assertNotDestroyed(locale)
    const payload = encryptClipboardPayload(clipboard, this.#derivedKey, locale)
    const jsonStr = JSON.stringify(payload, null, 2)
    return adapter.put(remoteFilename, jsonStr, {
      contentType: 'application/json',
      ...(options?.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}),
      ...(locale !== undefined ? { locale } : {})
    })
  }

  /**
   * 从 WebDAV 拉取并解密剪贴板历史
   */
  async pullClipboardFromWebDav(
    adapter: WebDavSyncAdapter,
    remoteFilename = 'ztools_clipboard.enc',
    options?: { locale?: string }
  ): Promise<{ clipboard: ClipboardSyncData; etag?: string; lastModified?: string }> {
    const locale = options?.locale ?? this.#locale
    this.#assertNotDestroyed(locale)
    const { data, etag, lastModified } = await adapter.get(
      remoteFilename,
      locale !== undefined ? { locale } : undefined
    )
    const payload = JSON.parse(data.toString('utf8')) as EncryptedPayload
    const clipboard = decryptClipboardPayload(payload, this.#derivedKey, locale)
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
    options?: { expectedUpdatedAt?: string; locale?: string }
  ): Promise<{ gistId: string; updatedAt: string }> {
    const locale = options?.locale ?? this.#locale
    this.#assertNotDestroyed(locale)
    const payload = encryptConfigPayload(config, this.#derivedKey, locale)
    const fileContent = JSON.stringify(payload, null, 2)
    const filename = 'ztools_config.enc.json'

    if (!gistId && !adapter.gistId) {
      const created = await adapter.createGist(
        {
          [filename]: { content: fileContent }
        },
        'ZTools E2EE Encrypted Configuration',
        locale !== undefined ? { locale } : undefined
      )
      return { gistId: created.id, updatedAt: created.updatedAt }
    }

    const targetId = (gistId ?? adapter.gistId)!
    const updated = await adapter.updateGist(
      targetId,
      { [filename]: { content: fileContent } },
      {
        ...(options?.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: options.expectedUpdatedAt } : {}),
        ...(locale !== undefined ? { locale } : {})
      }
    )
    return { gistId: updated.id, updatedAt: updated.updatedAt }
  }

  /**
   * 从 GitHub 私有 Gist 拉取并解密全量配置
   */
  async pullConfigFromGist(
    adapter: GistSyncAdapter,
    gistId?: string,
    options?: { locale?: string }
  ): Promise<{ config: ConfigSyncData; updatedAt: string; gistId: string }> {
    const locale = options?.locale ?? this.#locale
    this.#assertNotDestroyed(locale)
    const gist = await adapter.getGist(gistId, locale !== undefined ? { locale } : undefined)
    const filename = 'ztools_config.enc.json'
    const file = gist.files[filename]
    if (!file) {
      throw new Error(tSync('engine.gistConfigFileNotFound', { gistId: gist.id, filename }, locale))
    }

    const rawContent = await this.#resolveGistFileContent(file, locale)
    if (!rawContent) {
      throw new Error(tSync('engine.gistConfigFileNotFound', { gistId: gist.id, filename }, locale))
    }

    const payload = JSON.parse(rawContent) as EncryptedPayload
    const config = decryptConfigPayload(payload, this.#derivedKey, locale)
    return { config, updatedAt: gist.updatedAt, gistId: gist.id }
  }

  /**
   * 将剪贴板历史加密并推送到 GitHub Gist
   */
  async pushClipboardToGist(
    adapter: GistSyncAdapter,
    clipboard: ClipboardSyncData,
    gistId?: string,
    options?: { expectedUpdatedAt?: string; locale?: string }
  ): Promise<{ gistId: string; updatedAt: string }> {
    const locale = options?.locale ?? this.#locale
    this.#assertNotDestroyed(locale)
    const payload = encryptClipboardPayload(clipboard, this.#derivedKey, locale)
    const fileContent = JSON.stringify(payload, null, 2)
    const filename = 'ztools_clipboard.enc.json'

    if (!gistId && !adapter.gistId) {
      const created = await adapter.createGist(
        {
          [filename]: { content: fileContent }
        },
        'ZTools E2EE Encrypted Clipboard',
        locale !== undefined ? { locale } : undefined
      )
      return { gistId: created.id, updatedAt: created.updatedAt }
    }

    const targetId = (gistId ?? adapter.gistId)!
    const updated = await adapter.updateGist(
      targetId,
      { [filename]: { content: fileContent } },
      {
        ...(options?.expectedUpdatedAt !== undefined ? { expectedUpdatedAt: options.expectedUpdatedAt } : {}),
        ...(locale !== undefined ? { locale } : {})
      }
    )
    return { gistId: updated.id, updatedAt: updated.updatedAt }
  }

  /**
   * 从 GitHub Gist 拉取并解密剪贴板历史
   */
  async pullClipboardFromGist(
    adapter: GistSyncAdapter,
    gistId?: string,
    options?: { locale?: string }
  ): Promise<{ clipboard: ClipboardSyncData; updatedAt: string; gistId: string }> {
    const locale = options?.locale ?? this.#locale
    this.#assertNotDestroyed(locale)
    const gist = await adapter.getGist(gistId, locale !== undefined ? { locale } : undefined)
    const filename = 'ztools_clipboard.enc.json'
    const file = gist.files[filename]
    if (!file) {
      throw new Error(tSync('engine.gistClipboardFileNotFound', { gistId: gist.id, filename }, locale))
    }

    const rawContent = await this.#resolveGistFileContent(file, locale)
    if (!rawContent) {
      throw new Error(tSync('engine.gistClipboardFileNotFound', { gistId: gist.id, filename }, locale))
    }

    const payload = JSON.parse(rawContent) as EncryptedPayload
    const clipboard = decryptClipboardPayload(payload, this.#derivedKey, locale)
    return { clipboard, updatedAt: gist.updatedAt, gistId: gist.id }
  }

  // =========================================================================
  // 内部辅助方法
  // =========================================================================

  #isWebDavAdapter(adapter: WebDavSyncAdapter | GistSyncAdapter): adapter is WebDavSyncAdapter {
    return typeof (adapter as WebDavSyncAdapter).put === 'function' &&
      typeof (adapter as WebDavSyncAdapter).get === 'function'
  }

  async #checkWebDavRemoteExists(
    adapter: WebDavSyncAdapter,
    filename: string,
    locale?: string
  ): Promise<boolean> {
    try {
      await adapter.get(filename, locale !== undefined ? { locale } : undefined)
      return true
    } catch (err) {
      if (err instanceof WebDavError && err.status === 404) {
        return false
      }
      throw err
    }
  }

  async #tryGetGist(adapter: GistSyncAdapter, gistId: string, locale?: string) {
    try {
      return await adapter.getGist(gistId, locale !== undefined ? { locale } : undefined)
    } catch (err) {
      if (err instanceof GistError && err.status === 404) {
        return null
      }
      throw err
    }
  }

  async #resolveGistFileContent(
    fileData: GistSyncFile & { raw_url?: string },
    locale?: string
  ): Promise<string> {
    const rawUrl = fileData.rawUrl ?? fileData.raw_url
    if (fileData.truncated === true && rawUrl) {
      const response = await this.#fetchImpl(rawUrl, { method: 'GET' })
      if (!response.ok) {
        throw new GistError(
          tSync(
            'engine.gistRawUrlFetchFailed',
            {
              status: response.status,
              statusText: response.statusText
            },
            locale
          ),
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
    gistId?: string,
    locale?: string
  ): Promise<{ snapshot: SyncStateSnapshot; updatedAt: string; resolvedGistId: string }> {
    const gist = await adapter.getGist(gistId, locale !== undefined ? { locale } : undefined)
    const fileData = gist.files[filename] as (GistSyncFile & { raw_url?: string }) | undefined
    if (!fileData) {
      throw new GistError(
        tSync('engine.gistSyncFileNotFound', { gistId: gist.id, filename }, locale),
        404,
        'Not Found'
      )
    }

    const content = await this.#resolveGistFileContent(fileData, locale)
    if (!content) {
      throw new Error(tSync('engine.gistSyncFileEmpty', { gistId: gist.id, filename }, locale))
    }

    const payload = JSON.parse(content) as EncryptedPayload
    const snapshot = this.#decryptStateSnapshot(payload, locale)
    return {
      snapshot,
      updatedAt: gist.updatedAt,
      resolvedGistId: gist.id
    }
  }

  #assertNotDestroyed(locale?: string): void {
    if (this.#destroyed) {
      throw new Error(tSync('engine.destroyed', undefined, locale ?? this.#locale))
    }
  }

  #decryptStateSnapshot(payload: EncryptedPayload, locale?: string): SyncStateSnapshot {
    this.#assertNotDestroyed(locale)
    const jsonStr = decryptAesGcmString(payload, this.#derivedKey, {
      locale,
      expectedAadPrefix: 'ztools:sync-state:'
    })
    const parsed = JSON.parse(jsonStr) as SyncStateSnapshot
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
      throw new Error(tSync('engine.invalidSyncState', undefined, locale))
    }
    return parsed
  }
}
