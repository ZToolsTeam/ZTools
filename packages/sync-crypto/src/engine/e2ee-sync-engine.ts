import { deriveMasterKey, type Argon2idOptions } from '../crypto/argon2id.js'
import {
  encryptConfigPayload,
  decryptConfigPayload,
  encryptClipboardPayload,
  decryptClipboardPayload,
  type ConfigSyncData,
  type ClipboardSyncData
} from '../crypto/sync-payload.js'
import type { EncryptedPayload } from '../crypto/aes-gcm.js'
import type { WebDavSyncAdapter } from '../adapters/webdav-adapter.js'
import type { GistSyncAdapter } from '../adapters/gist-adapter.js'

export interface SyncEngineOptions {
  masterPassword: string | Buffer
  salt: string | Buffer
  argon2Options?: Argon2idOptions
}

/**
 * 去中心化端到端加密同步引擎 (E2EE Sync Engine)
 * 集成 Argon2id 强密钥衍生、AES-256-GCM 密文封包与 WebDAV / GitHub Gist 远端同步
 */
export class E2eeSyncEngine {
  readonly #derivedKey: Buffer

  constructor(options: SyncEngineOptions) {
    this.#derivedKey = deriveMasterKey(
      options.masterPassword,
      options.salt,
      options.argon2Options
    )
  }

  get key(): Buffer {
    return this.#derivedKey
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
    if (!file || !file.content) {
      throw new Error(`Gist [${gist.id}] 中未找到加密配置文件: ${filename}`)
    }

    const payload = JSON.parse(file.content) as EncryptedPayload
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
    if (!file || !file.content) {
      throw new Error(`Gist [${gist.id}] 中未找到加密剪贴板文件: ${filename}`)
    }

    const payload = JSON.parse(file.content) as EncryptedPayload
    const clipboard = decryptClipboardPayload(payload, this.#derivedKey)
    return { clipboard, updatedAt: gist.updatedAt, gistId: gist.id }
  }
}
