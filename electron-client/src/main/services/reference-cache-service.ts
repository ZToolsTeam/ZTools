import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { parseReferenceDirectory, parseReferenceRead, parseReferenceWrite, type PathGrantRef } from '../../contracts/path-reference.js'
import type { PathGrantService } from './path-grant-service.js'
import { AnchoredFileSystemService } from './anchored-file-system-service.js'

const denied = () => new ZToolsError(errorCodes.permissionDenied, '缓存引用不可用')
const unknown = () => new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '缓存写入后引用交付或清理未完成，请先核查结果')
const syntaxId = 'a'.repeat(43)
function cacheName(value: unknown): string {
  return parseReferenceDirectory({ directoryGrantId: syntaxId, relativePath: value }).relativePath
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(key => !keys.includes(key))) throw new ZToolsError(errorCodes.invalidRequest, '缓存参数无效')
  return value as Record<string, unknown>
}

/** Root provider is trusted main composition only; Renderer chooses a relative name, never a root or owner. */
export class ReferenceCacheService {
  readonly #files: AnchoredFileSystemService
  #requests = 0
  #writeBytes = 0
  readonly #ownerRequests = new Map<number, number>()
  constructor(private readonly grants: PathGrantService,
    private readonly rootForCaller: (caller: CallerIdentity, signal?: AbortSignal) => Promise<PathGrantRef>) {
    this.#files = new AnchoredFileSystemService(grants)
  }

  async readCache(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const v = record(value, ['name', 'encoding']), name = cacheName(v.name)
    const read = parseReferenceRead({ grantId: syntaxId, relativePath: name, encoding: v.encoding })
    return this.#operation(caller, signal, async () => {
      const root = await this.#root(caller, signal)
      return this.#files.readFile({ ...read, grantId: root.grantId }, caller, signal)
    })
  }

  async writeCache(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const v = record(value, ['name', 'content', 'encoding', 'replace']), name = cacheName(v.name)
    const write = parseReferenceWrite({ saveGrantId: syntaxId, content: v.content, encoding: v.encoding, replace: v.replace })
    return this.#operation(caller, signal, async () => {
      const budget = write.encoding === 'base64' ? Math.max(0, Math.floor(write.content.length / 4) * 3 -
        (write.content.endsWith('==') ? 2 : write.content.endsWith('=') ? 1 : 0)) : Buffer.byteLength(write.content)
      if (budget > 16 * 1024 * 1024 || this.#writeBytes > 64 * 1024 * 1024 - budget) {
        throw new ZToolsError(errorCodes.fileTooLarge, '缓存写入超过内存预算')
      }
      this.#writeBytes += budget
      try {
        // Decode only after concurrency admission, before root acquisition or directory side effects.
        const bytes = Buffer.from(write.content, write.encoding === 'base64' ? 'base64' : 'utf8')
        if ((write.encoding === 'base64' && bytes.toString('base64') !== write.content) || bytes.length > 16 * 1024 * 1024) {
          throw new ZToolsError(errorCodes.invalidRequest, '缓存内容必须为有效且不超过16MiB的数据')
        }
        const root = await this.#root(caller, signal), parts = name.split('/')
        for (let index = 1; index < parts.length; index++) {
          await this.grants.createDirectory(caller.webContentsId, root.grantId, parts.slice(0, index).join('/'), signal)
        }
        const save = await this.grants.deriveSave(caller.webContentsId, root.grantId, name, signal)
        let committed = false, released = false, read: PathGrantRef | undefined
        try {
          const result = await this.grants.save(caller.webContentsId, save.grantId, bytes, write.replace, signal)
          committed = true
          await this.grants.revoke(caller.webContentsId, save.grantId); released = true
          read = await this.grants.deriveRead(caller.webContentsId, root.grantId, name, signal)
          const fileUrl = this.grants.resourceUrl(caller.webContentsId, read.grantId)
          if (signal?.aborted) throw unknown()
          return { success: true as const, reference: read, fileUrl, size: result.bytesWritten }
        } catch (error) {
          const cleanup = await Promise.allSettled([
            ...(!released ? [this.grants.revoke(caller.webContentsId, save.grantId)] : []),
            ...(read ? [this.grants.revoke(caller.webContentsId, read.grantId)] : [])
          ])
          if (committed) throw unknown()
          if (cleanup.some(item => item.status === 'rejected')) throw new ZToolsError(errorCodes.fileError, '缓存授权释放未确认')
          throw error
        }
      } finally { this.#writeBytes -= budget }
    })
  }

  /** Main-generated image/temporary bytes use an unpredictable private cache name and return only a FileRef. */
  writeGeneratedCacheFile(data: Buffer, caller: CallerIdentity, extension = 'bin', signal?: AbortSignal) {
    if (!Buffer.isBuffer(data) || data.length > 16 * 1024 * 1024 || !/^[a-z0-9]{1,12}$/.test(extension)) return Promise.reject(denied())
    return this.writeCache({ name: 'generated-' + randomUUID() + '.' + extension, content: data.toString('base64'), encoding: 'base64' }, caller, signal)
  }

  /** Main consumer cleanup for a generated reference that was never delivered; does not delete the cache file. */
  revokeReference(reference: PathGrantRef, caller: CallerIdentity): Promise<void> {
    return this.grants.revoke(caller.webContentsId, reference.grantId)
  }

  async #root(caller: CallerIdentity, signal?: AbortSignal): Promise<PathGrantRef> {
    const selected = await this.rootForCaller({ ...caller }, signal)
    if (signal?.aborted) throw denied()
    const root = this.grants.reference(caller.webContentsId, selected.grantId)
    if (root.kind !== 'directory' || !['read', 'write', 'list'].every(right => root.operations.includes(right as 'read' | 'write' | 'list'))) throw denied()
    return root
  }
  async #operation<T>(caller: CallerIdentity, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const owner = caller.webContentsId, count = this.#ownerRequests.get(owner) ?? 0
    if (!['main', 'plugin'].includes(caller.type) || !Number.isSafeInteger(owner) || owner <= 0 || signal?.aborted ||
        this.#requests >= 8 || count >= 2) throw denied()
    this.#requests++; this.#ownerRequests.set(owner, count + 1)
    try { return await work() }
    finally {
      this.#requests--
      const remaining = (this.#ownerRequests.get(owner) ?? 1) - 1
      if (remaining) this.#ownerRequests.set(owner, remaining)
      else this.#ownerRequests.delete(owner)
    }
  }
}
