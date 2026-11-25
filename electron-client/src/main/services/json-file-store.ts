import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'

export type JsonObject = Record<string, unknown>

export interface JsonFileStoreOptions {
  compactFiles?: ReadonlySet<string>
}

interface CachedDocument {
  mtimeMs: number
  ctimeMs: number
  size: number
  ino: number
  document: JsonObject
}

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
let temporarySequence = 0
const RENAME_RETRY_DELAYS_MS = [10, 25, 50] as const
const DEFAULT_COMPACT_FILES: ReadonlySet<string> = new Set(['catalog_snapshot.json'])

function normalizeQueueKey(filePath: string): string {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function cloneJsonObject(document: JsonObject, fallbackJson?: string): JsonObject {
  try {
    return structuredClone(document)
  } catch {
    if (fallbackJson !== undefined) {
      return JSON.parse(fallbackJson) as JsonObject
    }
    return JSON.parse(JSON.stringify(document)) as JsonObject
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, target)
      return
    } catch (error) {
      const retryDelay = RENAME_RETRY_DELAYS_MS[attempt]
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(errorCode(error) ?? '') || retryDelay === undefined) {
        throw error
      }
      await delay(retryDelay)
    }
  }
}

export class JsonFileStore {
  static readonly #writeQueues = new Map<string, Promise<unknown>>()
  static readonly #cache = new Map<string, CachedDocument>()
  static readonly #writeVersions = new Map<string, number>()

  readonly #compactFiles: ReadonlySet<string>

  constructor(
    private readonly root: string,
    private readonly allowedFiles: ReadonlySet<string>,
    options?: JsonFileStoreOptions
  ) {
    this.#compactFiles = options?.compactFiles ?? DEFAULT_COMPACT_FILES
  }

  async read(fileName: string): Promise<JsonObject> {
    const filePath = this.#filePath(fileName)
    const queueKey = normalizeQueueKey(filePath)
    let pendingWrite = JsonFileStore.#writeQueues.get(queueKey)
    while (pendingWrite) {
      await pendingWrite.catch(() => undefined)
      const nextWrite = JsonFileStore.#writeQueues.get(queueKey)
      if (nextWrite === pendingWrite) break
      pendingWrite = nextWrite
    }
    return this.#read(fileName)
  }

  update(fileName: string, mutate: (document: JsonObject) => void): Promise<void> {
    return this.#serializeWrite(fileName, async () => {
      const document = await this.#read(fileName)
      mutate(document)
      await this.#write(fileName, document)
    })
  }

  replace(fileName: string, document: JsonObject): Promise<void> {
    return this.#serializeWrite(fileName, () => this.#write(fileName, document))
  }

  #filePath(fileName: string): string {
    if (!this.allowedFiles.has(fileName)) {
      throw new ZToolsError(errorCodes.permissionDenied, 'Configuration file is not in the allowlist')
    }
    return path.join(this.root, fileName)
  }

  static #bumpWriteVersion(queueKey: string): number {
    const next = (JsonFileStore.#writeVersions.get(queueKey) ?? 0) + 1
    JsonFileStore.#writeVersions.set(queueKey, next)
    return next
  }

  async #serializeWrite<T>(fileName: string, operation: () => Promise<T>): Promise<T> {
    const filePath = this.#filePath(fileName)
    const queueKey = normalizeQueueKey(filePath)
    const previous = JsonFileStore.#writeQueues.get(queueKey) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    JsonFileStore.#writeQueues.set(queueKey, current)
    try { return await current } finally {
      if (JsonFileStore.#writeQueues.get(queueKey) === current) JsonFileStore.#writeQueues.delete(queueKey)
    }
  }

  async #read(fileName: string): Promise<JsonObject> {
    const filePath = this.#filePath(fileName)
    const queueKey = normalizeQueueKey(filePath)
    const versionBeforeRead = JsonFileStore.#writeVersions.get(queueKey) ?? 0
    try {
      const statInfo = await fs.stat(filePath)
      if (statInfo.size > MAX_DOCUMENT_BYTES) {
        JsonFileStore.#cache.delete(queueKey)
        throw new ZToolsError(errorCodes.dataCorrupt, 'Configuration file exceeds size limit')
      }
      const cached = JsonFileStore.#cache.get(queueKey)
      if (
        cached &&
        cached.mtimeMs === statInfo.mtimeMs &&
        cached.ctimeMs === statInfo.ctimeMs &&
        cached.size === statInfo.size &&
        cached.ino === statInfo.ino
      ) {
        return cloneJsonObject(cached.document)
      }

      const handle = await fs.open(filePath, 'r')
      let source: string
      let openedInfo: { mtimeMs: number; ctimeMs: number; size: number; ino: number }
      try {
        const info = await handle.stat()
        if (info.size > MAX_DOCUMENT_BYTES) {
          throw new ZToolsError(errorCodes.dataCorrupt, 'Configuration file exceeds size limit')
        }
        openedInfo = {
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          size: info.size,
          ino: info.ino
        }
        source = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
      const normalizedSource = source.startsWith('\uFEFF') ? source.slice(1) : source
      let value: JsonObject
      if (normalizedSource.trim() === '') {
        value = {}
      } else {
        const parsed: unknown = JSON.parse(normalizedSource)
        if (!isRecord(parsed)) {
          throw new ZToolsError(errorCodes.dataCorrupt, 'Configuration file root must be a JSON object')
        }
        value = parsed
      }
      if ((JsonFileStore.#writeVersions.get(queueKey) ?? 0) === versionBeforeRead) {
        JsonFileStore.#cache.set(queueKey, {
          mtimeMs: openedInfo.mtimeMs,
          ctimeMs: openedInfo.ctimeMs,
          size: openedInfo.size,
          ino: openedInfo.ino,
          document: cloneJsonObject(value)
        })
      }
      return value
    } catch (error) {
      JsonFileStore.#cache.delete(queueKey)
      if (error instanceof ZToolsError) throw error
      if (errorCode(error) === 'ENOENT') return {}
      if (error instanceof SyntaxError) {
        throw new ZToolsError(errorCodes.dataCorrupt, 'Configuration file JSON is corrupted')
      }
      throw new ZToolsError(errorCodes.storageError, 'Failed to read configuration file')
    }
  }

  async #write(fileName: string, document: JsonObject): Promise<void> {
    const filePath = this.#filePath(fileName)
    const queueKey = normalizeQueueKey(filePath)
    const temporaryPath = path.join(
      this.root,
      `.${fileName}.${process.pid}.${++temporarySequence}.tmp`
    )
    JsonFileStore.#bumpWriteVersion(queueKey)
    let tempCreated = false
    try {
      await fs.mkdir(this.root, { recursive: true })
      const serialized = this.#compactFiles.has(fileName)
        ? JSON.stringify(document)
        : JSON.stringify(document, null, 2)
      const encoded = `\uFEFF${serialized}\n`
      if (Buffer.byteLength(encoded, 'utf8') > MAX_DOCUMENT_BYTES) {
        throw new ZToolsError(errorCodes.storageError, 'Configuration file exceeds size limit')
      }
      await fs.writeFile(temporaryPath, encoded, { encoding: 'utf8', flag: 'wx' })
      tempCreated = true
      await renameWithRetry(temporaryPath, filePath)
      tempCreated = false
      JsonFileStore.#bumpWriteVersion(queueKey)
      try {
        const info = await fs.stat(filePath)
        JsonFileStore.#cache.set(queueKey, {
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
          size: info.size,
          ino: info.ino,
          document: cloneJsonObject(document, serialized)
        })
      } catch {
        JsonFileStore.#cache.delete(queueKey)
      }
    } catch (error) {
      JsonFileStore.#cache.delete(queueKey)
      if (tempCreated) {
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
      }
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.storageError, 'Failed to save configuration file')
    }
  }
}

export function parseStoredValue(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+$/.test(trimmed)) {
    const integer = Number(trimmed)
    if (Number.isSafeInteger(integer)) return integer
  }
  return value
}

export function getByPath(document: JsonObject, pathValue: string): unknown {
  let current: unknown = document
  for (const segment of pathValue.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

export function setByPath(document: JsonObject, pathValue: string, value: unknown): void {
  const segments = pathValue.split('.')
  let current = document
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment]
    if (!isRecord(child)) current[segment] = {}
    current = current[segment] as JsonObject
  }
  const finalSegment = segments.at(-1)
  if (finalSegment !== undefined) current[finalSegment] = value
}
