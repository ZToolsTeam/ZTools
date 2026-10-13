import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { saveClipboardHistory, type ClipboardHistoryEntry } from './clipboard-history.js'
import { ClassicLevel, type BatchOperation } from 'classic-level'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { CredentialProtection, CredentialProtectionStatus } from './credential-protection.js'
import type {
  DatabaseBatchParams,
  DatabaseGetParams,
  DatabaseKeyParams,
  DatabasePutParams,
  DatabaseQueryParams,
  DatabaseSecurePutParams
} from '../../contracts/method-params.js'

const MAX_VALUE_BYTES = 16 * 1024 * 1024
const MAX_SECURE_VALUE_BYTES = 1024 * 1024
const MAX_CREDENTIAL_VALUE_BYTES = 64 * 1024
// JSON escaping can expand a 64 KiB UTF-8 value (for example NUL bytes) to about 384 KiB.
const MAX_CREDENTIAL_CIPHERTEXT_BYTES = 512 * 1024
const MAX_QUERY_RESPONSE_BYTES = 16 * 1024 * 1024
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CREDENTIAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const PLUGIN_INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const CREDENTIAL_DB_KEY_PREFIX = '__ztools_credential_v1__:'
const CREDENTIAL_STORE_NAMESPACE_PREFIX = '__ztools_credential_v1__'
const CREDENTIAL_RECORD_PREFIX = 'ztools-credential-v1:'
const CREDENTIAL_ENVELOPE_FORMAT = 'ztools-credential-envelope-v1'
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

type LevelStore = ClassicLevel<string, Buffer>
type DatabaseState = 'running' | 'stopping' | 'stopped'

interface OpenDatabase {
  namespace: string
  store: LevelStore
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = []
  let current = error
  while (typeof current === 'object' && current !== null && chain.length < 4) {
    chain.push(current)
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined
  }
  return chain
}

function databaseFailure(error: unknown, action: string): ZToolsError {
  if (error instanceof ZToolsError) return error
  const chain = errorChain(error)
  const codes = chain.map(errorCode)
  const detail = chain
    .filter((item): item is Error => item instanceof Error)
    .map((item) => item.message)
    .join(': ')
    .slice(0, 512) || '未知数据库错误'
  if (codes.includes('LEVEL_LOCKED')) {
    return new ZToolsError(errorCodes.databaseLocked, '数据库正在被另一个进程使用')
  }
  if (codes.includes('LEVEL_CORRUPTION') || /corrupt/i.test(detail)) {
    return new ZToolsError(errorCodes.dataCorrupt, '数据库已损坏')
  }
  return new ZToolsError(errorCodes.storageError, `${action}失败`)
}

function requireNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  if (signal.reason === errorCodes.appStopping) {
    throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
  }
  throw new ZToolsError(errorCodes.callerDestroyed, '数据库操作已取消')
}

function requirePluginId(pluginId: string): void {
  if (!PLUGIN_ID_PATTERN.test(pluginId) || pluginId.endsWith('.') || WINDOWS_DEVICE_PATTERN.test(pluginId)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'plugin_id 格式无效')
  }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function strictBase64(value: string): Buffer {
  if (!BASE64_PATTERN.test(value)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'value 不是有效 Base64')
  }
  return Buffer.from(value, 'base64')
}

function serializeValue(value: unknown, isBase64 = false): Buffer {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (!isBase64 && serialized === undefined) {
    throw new ZToolsError(errorCodes.invalidRequest, 'value 不能序列化为 JSON')
  }
  const result = isBase64
    ? strictBase64(value as string)
    : Buffer.from(serialized as string, 'utf8')
  if (result.byteLength > MAX_VALUE_BYTES) {
    throw new ZToolsError(errorCodes.fileTooLarge, '数据库值超过 16 MiB 上限')
  }
  return result
}

function decodeUtf8(value: Buffer): string {
  if (value.byteLength > MAX_VALUE_BYTES) {
    throw new ZToolsError(errorCodes.responseTooLarge, '数据库值超过 16 MiB 返回上限')
  }
  try {
    return utf8Decoder.decode(value)
  } catch {
    throw new ZToolsError(errorCodes.dataCorrupt, '数据库文本不是有效 UTF-8')
  }
}

function deriveKeySeed(pluginId: string, key: string): number {
  let seed = 0x9e3779b9
  for (const input of [pluginId, key]) {
    for (let index = 0; index < input.length; index += 1) {
      const character = input.charCodeAt(index) & 0xff
      seed = (seed ^ (((seed << 5) + character + (seed >>> 2)) >>> 0)) >>> 0
    }
  }
  return seed
}

function createSBoxes(initialSeed: number): { forward: Uint8Array; inverse: Uint8Array } {
  const forward = new Uint8Array(256)
  const inverse = new Uint8Array(256)
  for (let index = 0; index < forward.length; index += 1) forward[index] = index
  let seed = initialSeed >>> 0
  for (let index = 255; index >= 1; index -= 1) {
    seed = (seed ^ (seed << 13)) >>> 0
    seed = (seed ^ (seed >>> 17)) >>> 0
    seed = (seed ^ (seed << 5)) >>> 0
    const swapIndex = seed % (index + 1)
    const temporary = forward[index] as number
    forward[index] = forward[swapIndex] as number
    forward[swapIndex] = temporary
  }
  for (let index = 0; index < forward.length; index += 1) inverse[forward[index] as number] = index
  return { forward, inverse }
}

function rotateLeft8(value: number, shift: number): number {
  const normalized = shift & 7
  return normalized === 0 ? value : ((value << normalized) | (value >>> (8 - normalized))) & 0xff
}

function rotateRight8(value: number, shift: number): number {
  const normalized = shift & 7
  return normalized === 0 ? value : ((value >>> normalized) | (value << (8 - normalized))) & 0xff
}

function transformLegacySecure(pluginId: string, key: string, value: string, decrypt: boolean): string {
  if (value === '') return ''
  const seed = deriveKeySeed(pluginId, key)
  const boxes = createSBoxes(seed)
  const characters = new Uint16Array(value.length)
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    const keyByte = key.length > 0 ? key.charCodeAt(index % key.length) & 0xff : 0
    const dynamicKey = (0x5a + (seed & 0xff) + ((index + 1) * 17) + keyByte) & 0xff
    let lowByte = codeUnit & 0xff
    if (decrypt) {
      lowByte = rotateRight8(lowByte, dynamicKey)
      lowByte = boxes.inverse[lowByte] as number
      lowByte ^= dynamicKey
    } else {
      lowByte ^= dynamicKey
      lowByte = boxes.forward[lowByte] as number
      lowByte = rotateLeft8(lowByte, dynamicKey)
    }
    characters[index] = (codeUnit & 0xff00) | lowByte
  }
  const chunks: string[] = []
  for (let offset = 0; offset < characters.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...characters.subarray(offset, offset + 0x8000)))
  }
  return chunks.join('')
}

export function encryptLegacySecure(pluginId: string, key: string, value: string): string {
  const transformed = transformLegacySecure(pluginId, key, value, false)
  return Buffer.from(transformed, 'utf16le').toString('base64')
}

export function decryptLegacySecure(pluginId: string, key: string, encryptedValue: string): string {
  const bytes = strictBase64(encryptedValue)
  if (bytes.byteLength % 2 !== 0) {
    throw new ZToolsError(errorCodes.dataCorrupt, '加密数据库值长度无效')
  }
  return transformLegacySecure(pluginId, key, bytes.toString('utf16le'), true)
}

export interface CredentialV1KeyParams {
  key: string
}

export interface CredentialV1SetParams extends CredentialV1KeyParams {
  value: string
}

export type CredentialV1Status = CredentialProtectionStatus

export type CredentialV1Value =
  | { readonly status: 'missing' }
  | { readonly status: 'present'; readonly value: string }

function requireCredentialKey(key: string): void {
  if (typeof key !== 'string' || !CREDENTIAL_KEY_PATTERN.test(key)) {
    throw new ZToolsError(errorCodes.invalidRequest, '凭据 key 格式无效')
  }
}

function credentialDatabaseKey(key: string): string {
  return `${CREDENTIAL_DB_KEY_PREFIX}${Buffer.from(key, 'utf8').toString('base64url')}`
}

function credentialStoreNamespace(pluginId: string): string {
  const ownerHash = createHash('sha256').update(pluginId, 'utf8').digest('hex')
  return `${CREDENTIAL_STORE_NAMESPACE_PREFIX}${ownerHash}`
}

function isCredentialDatabaseKey(key: string): boolean {
  return typeof key === 'string' && key.startsWith(CREDENTIAL_DB_KEY_PREFIX)
}

function rejectCredentialDatabaseKey(key: string): void {
  if (isCredentialDatabaseKey(key)) {
    throw new ZToolsError(errorCodes.permissionDenied, '该数据库键由宿主凭据存储保留')
  }
}

function isCancellation(error: unknown): boolean {
  return error instanceof ZToolsError && (
    error.code === errorCodes.callerDestroyed ||
    error.code === errorCodes.appStopping ||
    error.code === errorCodes.cancelled ||
    error.code === errorCodes.requestTimeout
  )
}

function isCredentialEnvelope(value: unknown): value is {
  format: typeof CREDENTIAL_ENVELOPE_FORMAT
  pluginId: string
  key: string
  value: string
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 4 &&
    Object.hasOwn(record, 'format') && Object.hasOwn(record, 'pluginId') &&
    Object.hasOwn(record, 'key') && Object.hasOwn(record, 'value') &&
    record.format === CREDENTIAL_ENVELOPE_FORMAT &&
    typeof record.pluginId === 'string' && typeof record.key === 'string' &&
    typeof record.value === 'string'
}

export class DatabaseService {
  readonly #databases = new Map<string, Promise<OpenDatabase>>()
  readonly #credentialLocks = new Map<string, Promise<void>>()
  #state: DatabaseState = 'running'
  #stopPromise: Promise<void> | undefined

  constructor(
    private readonly root: string,
    private readonly credentialProtection?: CredentialProtection
  ) {}

  async recordClipboard(entry: ClipboardHistoryEntry): Promise<void> {
    await this.#perform('clipboard-manager', { type: 'main', webContentsId: 0 },
      new AbortController().signal, '保存剪贴板历史', (store) => saveClipboardHistory(store, entry))
  }

  async put(
    params: DatabasePutParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: 'OK' }> {
    rejectCredentialDatabaseKey(params.key)
    return this.#perform(params.plugin_id, caller, signal, '写入数据库', async (store) => {
      await store.put(params.key, serializeValue(params.value, params.is_base64), { sync: true })
      return { success: true, data: 'OK' }
    })
  }

  async get(
    params: DatabaseGetParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: string }> {
    rejectCredentialDatabaseKey(params.key)
    return this.#perform(params.plugin_id, caller, signal, '读取数据库', async (store) => {
      const value = await store.get(params.key)
      if (value === undefined) {
        throw new ZToolsError(errorCodes.databaseKeyNotFound, 'Key not found')
      }
      return {
        success: true,
        data: params.is_base64 ? value.toString('base64') : decodeUtf8(value)
      }
    })
  }

  async delete(
    params: DatabaseKeyParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: 'OK' }> {
    rejectCredentialDatabaseKey(params.key)
    return this.#perform(params.plugin_id, caller, signal, '删除数据库值', async (store) => {
      await store.del(params.key, { sync: true })
      return { success: true, data: 'OK' }
    })
  }

  async exists(
    params: DatabaseKeyParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: boolean }> {
    rejectCredentialDatabaseKey(params.key)
    return this.#perform(params.plugin_id, caller, signal, '检查数据库值', async (store) => ({
      success: true,
      data: await store.has(params.key)
    }))
  }

  async query(
    params: DatabaseQueryParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: Array<{ key: string; value: string }> }> {
    return this.#perform(params.plugin_id, caller, signal, '查询数据库', async (store) => {
      const data: Array<{ key: string; value: string }> = []
      let responseBytes = 0
      for await (const [key, encodedValue] of store.iterator({
        ...(params.prefix === '' ? {} : { gte: params.prefix }),
        fillCache: false,
        highWaterMarkBytes: 1024 * 1024
      })) {
        requireNotAborted(signal)
        if (params.prefix !== '' && !key.startsWith(params.prefix)) break
        if (isCredentialDatabaseKey(key)) continue
        if (params.limit > 0 && data.length >= params.limit) break
        const value = decodeUtf8(encodedValue)
        responseBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8')
        if (responseBytes > MAX_QUERY_RESPONSE_BYTES) {
          throw new ZToolsError(errorCodes.responseTooLarge, '数据库查询结果超过 16 MiB 上限')
        }
        data.push({ key, value })
      }
      return { success: true, data }
    })
  }

  async batch(
    params: DatabaseBatchParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: 'OK' }> {
    for (const operation of params.operations) rejectCredentialDatabaseKey(operation.key)
    return this.#perform(params.plugin_id, caller, signal, '批量写入数据库', async (store) => {
      const operations: Array<BatchOperation<LevelStore, string, Buffer>> = params.operations.map((operation) =>
        operation.op === 'put'
          ? { type: 'put', key: operation.key, value: serializeValue(operation.value) }
          : { type: 'del', key: operation.key }
      )
      await store.batch(operations, { sync: true })
      return { success: true, data: 'OK' }
    })
  }

  async putSecure(
    params: DatabaseSecurePutParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: 'OK' }> {
    if (Buffer.byteLength(params.value, 'utf8') > MAX_SECURE_VALUE_BYTES) {
      throw new ZToolsError(errorCodes.fileTooLarge, '安全数据库值超过 1 MiB 上限')
    }
    const namespace = this.#namespace(params.plugin_id, caller)
    const encrypted = encryptLegacySecure(namespace, params.key, params.value)
    return this.put({ plugin_id: namespace, key: `secure:${params.key}`, value: encrypted }, caller, signal)
  }

  async getSecure(
    params: DatabaseKeyParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: string }> {
    const namespace = this.#namespace(params.plugin_id, caller)
    const result = await this.get({ plugin_id: namespace, key: `secure:${params.key}` }, caller, signal)
    try {
      return { success: true, data: decryptLegacySecure(namespace, params.key, result.data) }
    } catch (error) {
      if (error instanceof ZToolsError && error.code === errorCodes.invalidRequest) {
        throw new ZToolsError(errorCodes.dataCorrupt, '安全数据库值不是有效密文')
      }
      throw error
    }
  }

  /** Reports whether the current host can protect plugin credentials with OS-backed safeStorage. */
  async credentialV1Status(caller: CallerIdentity): Promise<{ success: true; data: CredentialV1Status }> {
    this.#credentialNamespace(caller)
    return { success: true, data: await this.#credentialProtectionStatus() }
  }

  /** Stores a plugin-scoped string protected by Electron safeStorage. Overwrites the current value. */
  async credentialV1Set(
    params: CredentialV1SetParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: 'OK' }> {
    requireCredentialKey(params.key)
    if (typeof params.value !== 'string') {
      throw new ZToolsError(errorCodes.invalidRequest, '凭据 value 必须是字符串')
    }
    if (Buffer.byteLength(params.value, 'utf8') > MAX_CREDENTIAL_VALUE_BYTES) {
      throw new ZToolsError(errorCodes.fileTooLarge, '凭据超过 64 KiB 上限')
    }
    const pluginId = this.#credentialNamespace(caller)
    return this.#withCredentialKeyLock(pluginId, params.key, async () => {
      const protection = await this.#requireCredentialProtection()
      requireNotAborted(signal)
      const plaintext = JSON.stringify({
        format: CREDENTIAL_ENVELOPE_FORMAT,
        pluginId,
        key: params.key,
        value: params.value
      })
      let ciphertext: Buffer
      try {
        ciphertext = await protection.encrypt(plaintext)
      } catch {
        throw new ZToolsError(errorCodes.storageError, '安全凭据加密失败')
      }
      if (!Buffer.isBuffer(ciphertext) || ciphertext.byteLength === 0 ||
          ciphertext.byteLength > MAX_CREDENTIAL_CIPHERTEXT_BYTES) {
        throw new ZToolsError(errorCodes.storageError, '安全凭据加密结果无效')
      }

      const record = Buffer.from(`${CREDENTIAL_RECORD_PREFIX}${ciphertext.toString('base64')}`, 'utf8')
      const dbKey = credentialDatabaseKey(params.key)
      let committed = false
      try {
        return await this.#performCredential(caller, signal, '保存安全凭据', async (store) => {
          requireNotAborted(signal)
          await store.put(dbKey, record, { sync: true })
          committed = true
          return { success: true, data: 'OK' }
        })
      } catch (error) {
        // Once LevelDB confirms the synchronous write, cancellation cannot undo the commit.
        if (committed && isCancellation(error)) return { success: true, data: 'OK' }
        throw error
      }
    })
  }

  /** Missing keys return an explicit status; legacy db_get_secure records are never consulted. */
  async credentialV1Get(
    params: CredentialV1KeyParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: CredentialV1Value }> {
    requireCredentialKey(params.key)
    const pluginId = this.#credentialNamespace(caller)
    return this.#withCredentialKeyLock(pluginId, params.key, async () => {
      const protection = await this.#requireCredentialProtection()
      const dbKey = credentialDatabaseKey(params.key)
      return this.#performCredential(caller, signal, '读取安全凭据', async (store) => {
        let record: Buffer | undefined
        try {
          record = await store.get(dbKey)
        } catch (error) {
          if (errorCode(error) !== 'LEVEL_NOT_FOUND') throw error
        }
        if (record === undefined) return { success: true, data: { status: 'missing' } }
        const maxEncodedRecordBytes = CREDENTIAL_RECORD_PREFIX.length + Math.ceil(MAX_CREDENTIAL_CIPHERTEXT_BYTES / 3) * 4
        if (record.byteLength > maxEncodedRecordBytes) {
          throw new ZToolsError(errorCodes.dataCorrupt, '安全凭据记录超过大小上限')
        }
        const encoded = decodeUtf8(record)
        if (!encoded.startsWith(CREDENTIAL_RECORD_PREFIX)) {
          throw new ZToolsError(errorCodes.dataCorrupt, '安全凭据记录格式无效')
        }
        const base64 = encoded.slice(CREDENTIAL_RECORD_PREFIX.length)
        let ciphertext: Buffer
        try {
          ciphertext = strictBase64(base64)
        } catch {
          throw new ZToolsError(errorCodes.dataCorrupt, '安全凭据记录格式无效')
        }
        if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_CREDENTIAL_CIPHERTEXT_BYTES ||
            ciphertext.toString('base64') !== base64) {
          throw new ZToolsError(errorCodes.dataCorrupt, '安全凭据记录格式无效')
        }
        requireNotAborted(signal)
        let decrypted: { readonly plaintext: string; readonly shouldReEncrypt: boolean }
        try {
          decrypted = await protection.decrypt(ciphertext)
        } catch {
          throw new ZToolsError(errorCodes.dataCorrupt, '安全凭据无法解密')
        }
        let envelope: unknown
        try {
          envelope = JSON.parse(decrypted.plaintext)
        } catch {
          throw new ZToolsError(errorCodes.dataCorrupt, '安全凭据内容损坏')
        }
        if (!isCredentialEnvelope(envelope) || envelope.pluginId !== pluginId || envelope.key !== params.key ||
            Buffer.byteLength(envelope.value, 'utf8') > MAX_CREDENTIAL_VALUE_BYTES) {
          throw new ZToolsError(errorCodes.dataCorrupt, '安全凭据内容损坏')
        }
        if (decrypted.shouldReEncrypt) {
          requireNotAborted(signal)
          let refreshedCiphertext: Buffer
          try {
            refreshedCiphertext = await protection.encrypt(decrypted.plaintext)
          } catch {
            throw new ZToolsError(errorCodes.storageError, '安全凭据重新保护失败')
          }
          if (!Buffer.isBuffer(refreshedCiphertext) || refreshedCiphertext.byteLength === 0 ||
              refreshedCiphertext.byteLength > MAX_CREDENTIAL_CIPHERTEXT_BYTES) {
            throw new ZToolsError(errorCodes.storageError, '安全凭据重新保护结果无效')
          }
          await store.put(
            dbKey,
            Buffer.from(`${CREDENTIAL_RECORD_PREFIX}${refreshedCiphertext.toString('base64')}`, 'utf8'),
            { sync: true }
          )
        }
        return { success: true, data: { status: 'present', value: envelope.value } }
      })
    })
  }

  /** Deletes idempotently; deletion remains available when OS encryption is unavailable. */
  async credentialV1Delete(
    params: CredentialV1KeyParams,
    caller: CallerIdentity,
    signal: AbortSignal
  ): Promise<{ success: true; data: 'OK' }> {
    requireCredentialKey(params.key)
    const pluginId = this.#credentialNamespace(caller)
    return this.#withCredentialKeyLock(pluginId, params.key, async () => {
      const dbKey = credentialDatabaseKey(params.key)
      let committed = false
      try {
        return await this.#performCredential(caller, signal, '删除安全凭据', async (store) => {
          requireNotAborted(signal)
          await store.del(dbKey, { sync: true })
          committed = true
          return { success: true, data: 'OK' }
        })
      } catch (error) {
        if (committed && isCancellation(error)) return { success: true, data: 'OK' }
        throw error
      }
    })
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    this.#state = 'stopping'
    this.#stopPromise = (async () => {
      const opened = await Promise.allSettled(this.#databases.values())
      const databases = opened
        .filter((result): result is PromiseFulfilledResult<OpenDatabase> => result.status === 'fulfilled')
        .map((result) => result.value.store)
      const closed = await Promise.allSettled(databases.map((store) => store.close()))
      this.#databases.clear()
      this.#state = 'stopped'
      const failure = closed.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failure) throw databaseFailure(failure.reason, '关闭数据库')
    })()
    return this.#stopPromise
  }

  async #perform<T>(
    requestedNamespace: string,
    caller: CallerIdentity,
    signal: AbortSignal,
    action: string,
    operation: (store: LevelStore) => Promise<T>
  ): Promise<T> {
    try {
      this.#requireRunning()
      requireNotAborted(signal)
      const namespace = this.#namespace(requestedNamespace, caller)
      const { store } = await this.#database(namespace)
      requireNotAborted(signal)
      const result = await operation(store)
      requireNotAborted(signal)
      return result
    } catch (error) {
      throw databaseFailure(error, action)
    }
  }

  #namespace(requested: string, caller: CallerIdentity): string {
    requirePluginId(requested)
    if (caller.type !== 'plugin') return requested
    const isTimestampNamespace = caller.pluginId === 'timestamp' &&
      (requested === 'timestamp' || requested === 'time')
    if (!caller.pluginId || (caller.pluginId !== requested && !isTimestampNamespace)) {
      throw new ZToolsError(errorCodes.permissionDenied, '插件只能访问自身数据库')
    }
    return caller.pluginId === 'timestamp' ? 'time' : caller.pluginId
  }

  #credentialNamespace(caller: CallerIdentity): string {
    if (caller.type !== 'plugin' || !Number.isSafeInteger(caller.webContentsId) || caller.webContentsId <= 0 ||
        !caller.pluginId || !PLUGIN_INSTANCE_ID_PATTERN.test(caller.pluginInstanceId ?? '')) {
      throw new ZToolsError(errorCodes.permissionDenied, '安全凭据仅允许已注册的插件实例访问')
    }
    // Keep credential ownership bound to the exact host-registered ID. In particular,
    // do not inherit the legacy timestamp -> time database alias.
    return caller.pluginId
  }

  async #performCredential<T>(
    caller: CallerIdentity,
    signal: AbortSignal,
    action: string,
    operation: (store: LevelStore) => Promise<T>
  ): Promise<T> {
    try {
      this.#requireRunning()
      requireNotAborted(signal)
      const pluginId = this.#credentialNamespace(caller)
      const storeNamespace = credentialStoreNamespace(pluginId)
      const { store } = await this.#database(storeNamespace)
      requireNotAborted(signal)
      const result = await operation(store)
      requireNotAborted(signal)
      return result
    } catch (error) {
      throw databaseFailure(error, action)
    }
  }

  async #credentialProtectionStatus(): Promise<CredentialV1Status> {
    if (!this.credentialProtection) return { status: 'unavailable', reason: 'encryption-unavailable' }
    try {
      const status = await this.credentialProtection.status()
      if (status.status === 'available') return { status: 'available' }
      if (status.status === 'unavailable' && [
        'encryption-unavailable', 'insecure-backend', 'backend-unknown'
      ].includes(status.reason)) return status
    } catch {
      // Do not expose OS key-store errors or credential-related data.
    }
    return { status: 'unavailable', reason: 'encryption-unavailable' }
  }

  async #requireCredentialProtection(): Promise<CredentialProtection> {
    const status = await this.#credentialProtectionStatus()
    if (status.status !== 'available' || !this.credentialProtection) {
      throw new ZToolsError(errorCodes.notSupported, '安全凭据存储当前不可用')
    }
    return this.credentialProtection
  }

  async #withCredentialKeyLock<T>(namespace: string, key: string, operation: () => Promise<T>): Promise<T> {
    const lockKey = `${namespace}\u0000${key}`
    const previous = this.#credentialLocks.get(lockKey) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    this.#credentialLocks.set(lockKey, current)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.#credentialLocks.get(lockKey) === current) this.#credentialLocks.delete(lockKey)
    }
  }

  async #database(namespace: string): Promise<OpenDatabase> {
    const cacheKey = namespace.toLocaleLowerCase('en-US')
    const existing = this.#databases.get(cacheKey)
    if (existing) return existing
    const opening = this.#openDatabase(namespace)
    this.#databases.set(cacheKey, opening)
    try {
      return await opening
    } catch (error) {
      if (this.#databases.get(cacheKey) === opening) this.#databases.delete(cacheKey)
      throw error
    }
  }

  async #openDatabase(namespace: string): Promise<OpenDatabase> {
    const location = await this.#prepareDatabasePath(namespace)
    const store = new ClassicLevel<string, Buffer>(location, {
      keyEncoding: 'utf8',
      valueEncoding: 'buffer',
      createIfMissing: true,
      errorIfExists: false,
      // The Delphi LevelDB build cannot decode SST blocks written by classic-level's Snappy build.
      compression: false,
      writeBufferSize: 4 * 1024 * 1024,
      cacheSize: 8 * 1024 * 1024,
      maxOpenFiles: 100
    })
    try {
      await store.open()
      if (this.#state !== 'running') {
        await store.close()
        throw new ZToolsError(errorCodes.appStopping, '应用正在退出')
      }
      return { namespace, store }
    } catch (error) {
      if (store.status === 'open' || store.status === 'opening') {
        try { await store.close() } catch { /* preserve the original open error */ }
      }
      throw error
    }
  }

  async #prepareDatabasePath(namespace: string): Promise<string> {
    await fs.mkdir(this.root, { recursive: true })
    const canonicalRoot = await fs.realpath(this.root)
    const target = path.join(canonicalRoot, namespace)
    try {
      await fs.lstat(target)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
      try {
        await fs.mkdir(target)
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError
      }
    }
    const stats = await fs.lstat(target)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new ZToolsError(errorCodes.permissionDenied, '数据库目录不是普通目录')
    }
    const canonicalTarget = await fs.realpath(target)
    if (!isWithin(canonicalRoot, canonicalTarget)) {
      throw new ZToolsError(errorCodes.permissionDenied, '数据库目录越界')
    }
    return canonicalTarget
  }

  #requireRunning(): void {
    if (this.#state !== 'running') {
      throw new ZToolsError(errorCodes.appStopping, '数据库服务正在退出')
    }
  }
}
