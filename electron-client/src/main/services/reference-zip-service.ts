import * as yauzl from 'yauzl'
import { crc32 } from 'node:zlib'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { grantId } from '../../contracts/path-reference.js'
import type { PathGrantService } from './path-grant-service.js'
const limit = 16 * 1024 * 1024
const cancelled = () => new ZToolsError(errorCodes.callerDestroyed, 'ZIP操作已取消')
const failed = () => new ZToolsError(errorCodes.fileError, 'ZIP文件损坏或条目无效')

async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(cancelled()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
  })
}
async function* entries(zip: yauzl.ZipFile, signal: AbortSignal) {
  const iterator = zip.eachEntry()
  try {
    while (true) {
      const next = await wait(iterator.next(), signal)
      if (next.done) return
      yield next.value
    }
  } finally { await iterator.return?.(undefined) }
}

export interface ZipContentEntry { name: string; isDirectory: boolean; data: Buffer }
export class ReferenceZipService {
  readonly #pending = new Map<number, AbortController>()
  #stopped = false
  constructor(private readonly grants: Pick<PathGrantService, 'read'>) {}
  stop() { this.#stopped = true; for (const controller of this.#pending.values()) controller.abort() }
  list(value: unknown, caller: CallerIdentity, signal: AbortSignal) { return this.#run(value, caller, signal, false) }
  test(value: unknown, caller: CallerIdentity, signal: AbortSignal) { return this.#run(value, caller, signal, true) }
  async readEntries(value: unknown, caller: CallerIdentity, signal: AbortSignal): Promise<ZipContentEntry[]> {
    const result = await this.#run(value, caller, signal, true, true)
    if (!result.contents) throw failed()
    return result.contents
  }
  async #run(value: unknown, caller: CallerIdentity, signal: AbortSignal, verify: boolean, collect = false) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => key !== 'fileGrantId')) throw new ZToolsError(errorCodes.invalidRequest, 'ZIP参数无效')
    const id = grantId((value as { fileGrantId: unknown }).fileGrantId)
    if (this.#stopped || signal.aborted) throw cancelled()
    if (this.#pending.has(caller.webContentsId) || this.#pending.size >= 2) throw new ZToolsError(errorCodes.fileTooLarge, 'ZIP操作正在处理中')
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
    const active = () => { if (this.#stopped || combined.aborted) throw cancelled() }
    this.#pending.set(caller.webContentsId, controller)
    let zip: yauzl.ZipFile | undefined
    try {
      const bytes = await this.grants.read(caller.webContentsId, id, '', limit, combined)
      active()
      try {
        zip = await yauzl.fromBufferPromise(bytes, { autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: true })
        active()
        const archive = zip
        // A closed in-memory reader may finish an already queued callback after cancellation.
        archive.on('error', () => undefined)
        const abort = () => archive.close()
        combined.addEventListener('abort', abort, { once: true })
        try {
          const files: { name: string; size: number; compressedSize: number; isDirectory: boolean }[] = []
          const contents: ZipContentEntry[] = []
          const names = new Set<string>(); let expanded = 0, nameBytes = 0
          for await (const entry of entries(archive, combined)) {
            active()
            const name = entry.fileName, segments = name.replace(/\/$/, '').split('/')
            if (!name || name.includes('\\') || name.includes('\0') || /^[A-Za-z]:/.test(name) || segments.some(part => !part || part === '.' || part === '..') || names.has(name)) throw failed()
            nameBytes += Buffer.byteLength(name, 'utf8'); expanded += entry.uncompressedSize
            if (files.length >= 1024 || nameBytes > 512 * 1024 || entry.uncompressedSize > limit || expanded > 64 * 1024 * 1024) throw new ZToolsError(errorCodes.fileTooLarge, 'ZIP条目数量或展开大小超过上限')
            names.add(name)
            if (entry.isEncrypted() || !entry.canDecodeFileData() || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new ZToolsError(errorCodes.notSupported, 'ZIP加密、特殊条目或压缩算法尚不支持')
            const directory = name.endsWith('/')
            if (verify && !directory) {
              const input = await archive.openReadStreamPromise(entry)
              const cancelInput = () => input.destroy(cancelled())
              combined.addEventListener('abort', cancelInput, { once: true })
              const chunks: Buffer[] = []
              let length = 0, crc = 0
              try {
                active()
                for await (const chunk of input) {
                  active(); const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
                  length += data.length
                  if (length > entry.uncompressedSize || length > limit) throw failed()
                  crc = crc32(data, crc); if (collect) chunks.push(data)
                }
                active()
                if (length !== entry.uncompressedSize || crc !== entry.crc32) throw failed()
                if (collect) contents.push({ name, isDirectory: false, data: Buffer.concat(chunks, length) })
              } finally { combined.removeEventListener('abort', cancelInput); input.destroy() }
            }
            if (collect && directory) {
              if (entry.uncompressedSize !== 0) throw failed()
              contents.push({ name, isDirectory: true, data: Buffer.alloc(0) })
            }
            files.push({ name, size: entry.uncompressedSize, compressedSize: entry.compressedSize, isDirectory: directory })
          }
          active()
          return collect ? { success: true as const, contents } : verify ? { success: true as const, valid: true } : { success: true as const, files }
        } finally { combined.removeEventListener('abort', abort) }
      } catch (error) {
        active()
        if (error instanceof ZToolsError && error.code !== errorCodes.fileError) throw error
        if (verify && !collect) return { success: true as const, valid: false }
        throw failed()
      }
    } finally { zip?.close(); this.#pending.delete(caller.webContentsId) }
  }
}
