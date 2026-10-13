import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'

export type JsonObject = Record<string, unknown>

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024
let temporarySequence = 0
const RENAME_RETRY_DELAYS_MS = [10, 25, 50] as const

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
  static readonly #queues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly root: string,
    private readonly allowedFiles: ReadonlySet<string>
  ) {}

  read(fileName: string): Promise<JsonObject> {
    return this.#serialize(fileName, () => this.#read(fileName))
  }

  update(fileName: string, mutate: (document: JsonObject) => void): Promise<void> {
    return this.#serialize(fileName, async () => {
      const document = await this.#read(fileName)
      mutate(document)
      await this.#write(fileName, document)
    })
  }

  replace(fileName: string, document: JsonObject): Promise<void> {
    return this.#serialize(fileName, () => this.#write(fileName, document))
  }

  #filePath(fileName: string): string {
    if (!this.allowedFiles.has(fileName)) {
      throw new ZToolsError(errorCodes.permissionDenied, '配置文件不在允许列表')
    }
    return path.join(this.root, fileName)
  }

  async #serialize<T>(fileName: string, operation: () => Promise<T>): Promise<T> {
    const filePath = this.#filePath(fileName)
    const queueKey = process.platform === 'win32'
      ? path.resolve(filePath).toLowerCase()
      : path.resolve(filePath)
    const previous = JsonFileStore.#queues.get(queueKey) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    JsonFileStore.#queues.set(queueKey, current)
    try { return await current } finally {
      if (JsonFileStore.#queues.get(queueKey) === current) JsonFileStore.#queues.delete(queueKey)
    }
  }

  async #read(fileName: string): Promise<JsonObject> {
    const filePath = this.#filePath(fileName)
    try {
      const handle = await fs.open(filePath, 'r')
      let source: string
      try {
        const info = await handle.stat()
        if (info.size > MAX_DOCUMENT_BYTES) {
          throw new ZToolsError(errorCodes.dataCorrupt, '配置文件超过大小上限')
        }
        source = await handle.readFile('utf8')
      } finally {
        await handle.close()
      }
      const normalizedSource = source.startsWith('\uFEFF') ? source.slice(1) : source
      if (normalizedSource.trim() === '') return {}
      const value: unknown = JSON.parse(normalizedSource)
      if (!isRecord(value)) {
        throw new ZToolsError(errorCodes.dataCorrupt, '配置文件根节点必须是对象')
      }
      return value
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      if (errorCode(error) === 'ENOENT') return {}
      if (error instanceof SyntaxError) {
        throw new ZToolsError(errorCodes.dataCorrupt, '配置文件 JSON 已损坏')
      }
      throw new ZToolsError(errorCodes.storageError, '读取配置文件失败')
    }
  }

  async #write(fileName: string, document: JsonObject): Promise<void> {
    const filePath = this.#filePath(fileName)
    const temporaryPath = path.join(
      this.root,
      `.${fileName}.${process.pid}.${++temporarySequence}.tmp`
    )
    try {
      await fs.mkdir(this.root, { recursive: true })
      const encoded = `\uFEFF${JSON.stringify(document, null, 2)}\n`
      if (Buffer.byteLength(encoded, 'utf8') > MAX_DOCUMENT_BYTES) {
        throw new ZToolsError(errorCodes.storageError, '配置文件超过大小上限')
      }
      await fs.writeFile(temporaryPath, encoded, { encoding: 'utf8', flag: 'wx' })
      await renameWithRetry(temporaryPath, filePath)
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.storageError, '保存配置文件失败')
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
