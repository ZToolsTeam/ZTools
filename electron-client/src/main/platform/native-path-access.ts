import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { AnchoredPathObject, PathAccessAdapter, PathAccessRight, PathDirectoryEntry, PathSaveResult, PathMetadata, PathMutationResult, PathDirectoryCreateResult } from './path-access.js'
import type { PathWriteJournal } from './path-write-journal.js'

const failure = () => new ZToolsError(errorCodes.fileError, '原生文件访问未完成')
class NativeReplyError extends ZToolsError {}
const u32 = (value: number): Buffer => { const data = Buffer.alloc(4); data.writeUInt32LE(value); return data }
const u64 = (value: number | bigint): Buffer => { const data = Buffer.alloc(8); data.writeBigUInt64LE(BigInt(value)); return data }
const string = (value: string): Buffer => {
  const data = Buffer.from(value, 'utf8')
  if (data.length > 4096 || value.includes('\0')) throw failure()
  return Buffer.concat([u32(data.length), data])
}
interface Pending {
  id: number
  resolve(value: Buffer): void
  reject(error: Error): void
}

/** Fixed main-owned executable only. Cancelling a request invalidates this entire broker generation. */
export class NativePathAccessAdapter implements PathAccessAdapter {
  readonly platform: 'win32' | 'darwin'
  get ownedProcessId(): number | undefined { return this.#exited ? undefined : this.#child?.pid }
  readonly #generation = randomUUID()
  #child?: ChildProcessWithoutNullStreams
  #exited = false
  #dead = false
  #start?: Promise<void>
  #resolveStart?: () => void
  #rejectStart?: (error: Error) => void
  #pending: Pending | undefined
  #queue: Promise<unknown> = Promise.resolve()
  #id = 0
  #queuedBytes = 0
  #queuedCalls = 0
  #streams = 0
  readonly #selectedPaths = new Map<number, string>()
  readonly #committedSaves = new Set<number>()
  #hello = false
  readonly #header = Buffer.alloc(4)
  #headerBytes = 0
  #frame: Buffer | undefined
  #frameBytes = 0
  #exitPromise: Promise<void> = Promise.resolve()
  #stop?: Promise<void>
  constructor(private readonly executable: string, private readonly timeoutMs = 5000,
    private readonly dependencies: { spawn?: typeof spawn; platform?: NodeJS.Platform; processArch?: string; writeJournal?: PathWriteJournal } = {}) {
    if (!path.isAbsolute(executable) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw failure()
    const platform = dependencies.platform ?? process.platform, arch = dependencies.processArch ?? process.arch
    if (!['win32', 'darwin'].includes(platform) || !['arm64', 'x64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) throw failure()
    this.platform = platform as 'win32' | 'darwin'
  }

  async pin(selectedPath: string, kind: AnchoredPathObject['kind'], rights: readonly PathAccessRight[], signal: AbortSignal): Promise<AnchoredPathObject> {
    const paths = this.platform === 'darwin' ? path.posix : path.win32
    if (!paths.isAbsolute(selectedPath) || !['file', 'directory', 'save'].includes(kind) || !rights.length ||
        new Set(rights).size !== rights.length || (kind === 'save' ? rights.length !== 1 || rights[0] !== 'write' :
          rights.some(right => right !== 'read' && !(kind === 'directory' && (right === 'list' || right === 'write'))))) throw failure()
    const result = await this.#call(Buffer.concat([Buffer.from([1, kind === 'file' ? 0 : kind === 'directory' ? 1 : 2]), string(selectedPath)]), signal)
    if (result.length !== 4 || result.readUInt32LE() === 0) { this.#fail(); await this.stop(); throw failure() }
    this.#selectedPaths.set(result.readUInt32LE(), selectedPath)
    return Object.freeze({ handle: `${this.#generation}:${result.readUInt32LE()}`, kind, displayName: paths.basename(selectedPath) || 'root' })
  }

  async read(object: AnchoredPathObject, segments: readonly string[], maxBytes: number, signal: AbortSignal): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 16 * 1024 * 1024 || segments.length > 64) throw failure()
    const payload = Buffer.concat([Buffer.from([2]), u32(this.#handle(object)), u32(maxBytes), u32(segments.length), ...segments.map(string)])
    const result = await this.#call(payload, signal)
    if (result.length > maxBytes) { this.#fail(); await this.stop(); throw failure() }
    return result
  }
  async pinSelected(selectedPath: string, signal: AbortSignal): Promise<AnchoredPathObject> {
    const paths = this.platform === 'darwin' ? path.posix : path.win32
    if (!paths.isAbsolute(selectedPath)) throw failure()
    const result = await this.#call(Buffer.concat([Buffer.from([21]), string(selectedPath)]), signal)
    if (result.length !== 5 || result.readUInt32LE() === 0 || result[4]! > 1) { this.#fail(); await this.stop(); throw failure() }
    this.#selectedPaths.set(result.readUInt32LE(), selectedPath)
    return Object.freeze({ handle: `${this.#generation}:${result.readUInt32LE()}`, kind: result[4] === 1 ? 'directory' : 'file', displayName: paths.basename(selectedPath) || 'root' })
  }

  async release(object: AnchoredPathObject): Promise<void> {
    const handle = this.#handle(object)
    if (this.#dead) { await this.stop(); return }
    const result = await this.#call(Buffer.concat([Buffer.from([3]), u32(handle)]), new AbortController().signal)
    if (result.length) { this.#fail(); await this.stop(); throw failure() }
    this.#selectedPaths.delete(handle)
    this.#committedSaves.delete(handle)
  }

  async pinCommittedSave(object: AnchoredPathObject, signal: AbortSignal): Promise<AnchoredPathObject> {
    if (object.kind !== 'save' || signal.aborted) throw failure()
    const handle = this.#handle(object), selectedPath = this.#selectedPaths.get(handle)
    if (!selectedPath || !this.#committedSaves.has(handle)) throw failure()
    const file = await this.pin(selectedPath, 'file', ['read'], signal)
    if (file.kind !== 'file' || file.displayName !== object.displayName) {
      try { await this.release(file) } catch { /* Do not expose a partial reference if release fails. */ }
      throw failure()
    }
    return file
  }

  async readRange(object: AnchoredPathObject, segments: readonly string[], offset: number, length: number, signal: AbortSignal): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
        length > 16 * 1024 * 1024 || offset > Number.MAX_SAFE_INTEGER - length || segments.length > 64) throw failure()
    const position = Buffer.alloc(8); position.writeBigUInt64LE(BigInt(offset))
    const result = await this.#call(Buffer.concat([Buffer.from([5]), u32(this.#handle(object)), position, u32(length),
      u32(segments.length), ...segments.map(string)]), signal)
    if (result.length > length) { this.#fail(); await this.stop(); throw failure() }
    return result
  }

  async save(object: AnchoredPathObject, data: Buffer, replace: boolean, signal: AbortSignal): Promise<PathSaveResult> {
    if (object.kind !== 'save' || !Buffer.isBuffer(data) || data.length > 16 * 1024 * 1024 || typeof replace !== 'boolean' || signal.aborted) throw failure()
    const handle = this.#handle(object)
    this.#committedSaves.delete(handle)
    if (this.dependencies.writeJournal) {
      async function* chunks() { if (data.length) yield data }
      return this.streamSave(object, data.length, chunks(), replace, signal)
    }
    const payload = Buffer.concat([Buffer.from([6]), u32(this.#handle(object)), Buffer.from([replace ? 1 : 0]), u32(data.length), data])
    try {
      const result = await this.#call(payload, signal)
      if (result.length !== 5 || result[0] !== 1 || result.readUInt32LE(1) !== data.length) {
        this.#fail(); await this.stop(); throw failure()
      }
      this.#committedSaves.add(handle)
      return { status: 'committed', bytesWritten: data.length }
    } catch (error) {
      if (!this.#dead && error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '保存结果未确认；不能保证输出未提交')
    }
  }

  async deriveSave(object: AnchoredPathObject, segments: readonly string[], signal: AbortSignal): Promise<AnchoredPathObject> {
    return this.#derive(object, segments, 'save', signal)
  }

  async deriveRead(object: AnchoredPathObject, segments: readonly string[], signal: AbortSignal): Promise<AnchoredPathObject> {
    return this.#derive(object, segments, 'file', signal)
  }
  async deriveDirectory(object: AnchoredPathObject, segments: readonly string[], signal: AbortSignal): Promise<AnchoredPathObject> {
    return this.#derive(object, segments, 'directory', signal)
  }

  async #derive(object: AnchoredPathObject, segments: readonly string[], kind: AnchoredPathObject['kind'], signal: AbortSignal): Promise<AnchoredPathObject> {
    if (object.kind !== 'directory' || !segments.length || segments.length > 64) throw failure()
    const result = await this.#call(Buffer.concat([Buffer.from([kind === 'save' ? 7 : kind === 'file' ? 8 : 20]), u32(this.#handle(object)), u32(segments.length), ...segments.map(string)]), signal)
    if (result.length !== 4 || !result.readUInt32LE()) { this.#fail(); await this.stop(); throw failure() }
    const selected = this.#selectedPaths.get(this.#handle(object))
    if (!selected) { this.#fail(); await this.stop(); throw failure() }
    this.#selectedPaths.set(result.readUInt32LE(), (this.platform === 'win32' ? path.win32 : path.posix).join(selected, ...segments))
    return Object.freeze({ handle: `${this.#generation}:${result.readUInt32LE()}`, kind, displayName: segments.at(-1)! })
  }

  async describe(object: AnchoredPathObject, signal: AbortSignal): Promise<PathMetadata> {
    if (object.kind === 'save') throw failure()
    const result = await this.#call(Buffer.concat([Buffer.from([9]), u32(this.#handle(object))]), signal)
    try {
      if (result.length !== 17 || ![0, 1].includes(result[0]!) || (result[0] === 1) !== (object.kind === 'directory')) throw failure()
      const size = result.readBigUInt64LE(1), modified = result.readBigInt64LE(9)
      if (size > BigInt(Number.MAX_SAFE_INTEGER) || (object.kind === 'directory' && size !== 0n) ||
          modified < -8640000000000000n || modified > 8640000000000000n) throw failure()
      return { isDirectory: result[0] === 1, size: Number(size), lastModifiedMs: Number(modified) }
    } catch { this.#fail(); await this.stop(); throw failure() }
  }

  async streamSave(object: AnchoredPathObject, expectedBytes: number | undefined, chunks: AsyncIterable<Buffer>, replace: boolean, signal: AbortSignal): Promise<PathSaveResult> {
    if (object.kind !== 'save' || (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > 2 * 1024 * 1024 * 1024)) ||
        typeof replace !== 'boolean' || signal.aborted || !chunks || typeof chunks[Symbol.asyncIterator] !== 'function' || this.#streams >= 8) throw failure()
    const saveHandle = this.#handle(object)
    this.#committedSaves.delete(saveHandle)
    let nativeWrite: number | undefined, journalId: string | undefined, commitStarted = false, stageRequest = false, received = 0
    const journal = this.dependencies.writeJournal, digest = journal ? createHash('sha256') : undefined
    const iterator = chunks[Symbol.asyncIterator]()
    this.#streams++
    try {
      if (journal) {
        const selected = this.#selectedPaths.get(this.#handle(object)); if (!selected) throw failure()
        journalId = await journal.reserve(this.platform, selected, expectedBytes)
      }
      const begin = await this.#call(Buffer.concat([Buffer.from([13]), u32(this.#handle(object)), u64(expectedBytes ?? 0xffffffffffffffffn), Buffer.from([replace ? 1 : 0])]), signal)
      if (begin.length !== 4 || !begin.readUInt32LE()) { this.#fail(); await this.stop(); throw failure() }
      nativeWrite = begin.readUInt32LE()
      if (journal && journalId) {
        const proof = await this.#call(Buffer.concat([Buffer.from([18]), u32(nativeWrite)]), signal)
        await journal.staged(journalId, proof)
      }
      for (;;) {
        const item = await this.#nextStreamItem(iterator, signal)
        if (item.done) break
        if (!Buffer.isBuffer(item.value) || !item.value.length || item.value.length > 16 * 1024 * 1024 ||
            item.value.length > (expectedBytes ?? 2 * 1024 * 1024 * 1024) - received) throw failure()
        for (let offset = 0; offset < item.value.length;) {
          const part = item.value.subarray(offset, Math.min(offset + 64 * 1024, item.value.length))
          stageRequest = true
          // Hash before yielding: a producer may mutate its Buffer while the private pipe request awaits ACK.
          digest?.update(part)
          const result = await this.#call(Buffer.concat([Buffer.from([14]), u32(nativeWrite), u32(part.length), part]), signal)
          if (result.length !== 4 || result.readUInt32LE() !== part.length) { this.#fail(); await this.stop(); throw failure() }
          received += part.length; offset += part.length
          stageRequest = false
        }
      }
      if (expectedBytes !== undefined && received !== expectedBytes) throw failure()
      if (signal.aborted) throw failure()
      if (journal && journalId) await journal.committing(journalId, received, digest!.digest('hex'))
      if (signal.aborted) throw failure()
      commitStarted = true; stageRequest = true
      const result = await this.#call(Buffer.concat([Buffer.from([15]), u32(nativeWrite)]), signal)
      nativeWrite = undefined
      if (result.length !== 5 || result[0] !== 1 || result.readUInt32LE(1) !== received) { this.#fail(); await this.stop(); throw failure() }
      if (journal && journalId) {
        try { await journal.committed(journalId); journalId = undefined }
        catch {
          // The validated native ACK is final. Keep the uncleaned durable record; do not repin or replay.
          return { status: 'committed', bytesWritten: received, cleanupIssues: [{ stage: 'release', code: errorCodes.fileError }] }
        }
      }
      this.#committedSaves.add(saveHandle)
      return { status: 'committed', bytesWritten: received }
    } catch (error) {
      // Native Append/Commit failures erase their stage entry; local/producer failures require an explicit abort.
      if (nativeWrite !== undefined && !this.#dead && !(stageRequest && error instanceof NativeReplyError)) {
        try { const result = await this.#call(Buffer.concat([Buffer.from([16]), u32(nativeWrite)]), new AbortController().signal)
          if (result.length) { this.#fail(); await this.stop() }
        } catch { this.#fail(); await this.stop() }
      }
      if (journal && journalId) { try { await journal.interrupted(journalId) } catch { /* Keep the last durable intent/proof; never invent a successful cleanup. */ } }
      if (!this.#dead && error instanceof ZToolsError) throw error
      if (commitStarted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '流式保存提交结果未确认；不能保证目标未改变')
      throw failure()
    } finally {
      this.#streams--
      // Do not await an untrusted/noncooperating producer's return forever.
      try { if (iterator.return) void this.#nextStreamItem({ next: () => iterator.return!() }, new AbortController().signal).catch(() => {}) } catch { /* Native staging was already settled above. */ }
    }
  }

  async #nextStreamItem(iterator: Pick<AsyncIterator<Buffer>, 'next'>, signal: AbortSignal): Promise<IteratorResult<Buffer>> {
    if (signal.aborted) throw failure()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      return await Promise.race([Promise.resolve().then(() => iterator.next()), new Promise<never>((_, reject) => {
        abort = () => reject(failure()); signal.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => reject(failure()), this.timeoutMs)
      })])
    } finally { if (timer) clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort) }
  }

  async copy(source: AnchoredPathObject, destination: AnchoredPathObject, replace: boolean, signal: AbortSignal): Promise<PathSaveResult> {
    if (source.kind !== 'file' || destination.kind !== 'save' || typeof replace !== 'boolean' || signal.aborted) throw failure()
    if (this.dependencies.writeJournal) {
      const before = await this.describe(source, signal)
      if (before.isDirectory || before.size > 2 * 1024 ** 3) throw failure()
      const adapter = this
      async function* chunks() {
        for (let offset = 0; offset < before.size; offset += 64 * 1024) {
          const length = Math.min(64 * 1024, before.size - offset)
          const bytes = await adapter.readRange(source, [], offset, length, signal)
          if (bytes.length !== length) throw failure()
          yield bytes
        }
        const after = await adapter.describe(source, signal)
        if (after.size !== before.size || after.lastModifiedMs !== before.lastModifiedMs) throw failure()
      }
      return this.streamSave(destination, before.size, chunks(), replace, signal)
    }
    const payload = Buffer.concat([Buffer.from([10]), u32(this.#handle(source)), u32(this.#handle(destination)), Buffer.from([replace ? 1 : 0])])
    try {
      const result = await this.#call(payload, signal)
      if (result.length !== 5 || result[0] !== 1 || result.readUInt32LE(1) > 2 * 1024 * 1024 * 1024) {
        this.#fail(); await this.stop(); throw failure()
      }
      return { status: 'committed', bytesWritten: result.readUInt32LE(1) }
    } catch (error) {
      if (!this.#dead && error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '复制结果未确认；不能保证输出未提交，源文件未删除')
    }
  }

  /** Main-only inspection of a sealed journal proof; no replay, unlink, truncation, or outcome promotion. */
  async observeWrite(object: AnchoredPathObject, proof: Buffer, signal: AbortSignal): Promise<{ state: 'unresolved' | 'staging' | 'committed-object'; size: number }> {
    if (object.kind !== 'save' || !Buffer.isBuffer(proof) || proof.length < 6 || proof.length > 8192) throw failure()
    const result = await this.#call(Buffer.concat([Buffer.from([19]), u32(this.#handle(object)), u32(proof.length), proof]), signal)
    if (result.length !== 9 || ![0, 1, 2].includes(result[0]!) || result.readBigUInt64LE(1) > BigInt(Number.MAX_SAFE_INTEGER)) {
      this.#fail(); await this.stop(); throw failure()
    }
    return { state: result[0] === 1 ? 'staging' : result[0] === 2 ? 'committed-object' : 'unresolved', size: Number(result.readBigUInt64LE(1)) }
  }

  async trash(object: AnchoredPathObject, signal: AbortSignal): Promise<PathMutationResult> {
    if (object.kind === 'save' || signal.aborted) throw failure()
    try {
      const result = await this.#call(Buffer.concat([Buffer.from([23]), u32(this.#handle(object))]), signal)
      if (result.length !== 1 || result[0] !== 1) { this.#fail(); await this.stop(); throw failure() }
      return { status: 'committed' }
    } catch (error) {
      if (!this.#dead && error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '回收结果未确认，请检查系统回收站与备份目录')
    }
  }

  async rename(object: AnchoredPathObject, name: string, signal: AbortSignal): Promise<PathMutationResult> {
    if (this.platform !== 'darwin' || object.kind === 'save' || !name || name === '.' || name === '..' || /[\0/]/.test(name) || signal.aborted) throw failure()
    try {
      const result = await this.#call(Buffer.concat([Buffer.from([24]), u32(this.#handle(object)), string(name)]), signal)
      if (result.length !== 1 || result[0] !== 1) { this.#fail(); await this.stop(); throw failure() }
      return { status: 'committed' }
    } catch (error) {
      if (!this.#dead && error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '改名结果未确认，请检查原名称和新名称，勿重复操作')
    }
  }

  async remove(directory: AnchoredPathObject, segments: readonly string[], isDirectory: boolean, signal: AbortSignal): Promise<PathMutationResult> {
    if (directory.kind !== 'directory' || !segments.length || segments.length > 64 || typeof isDirectory !== 'boolean' || signal.aborted) throw failure()
    try {
      const result = await this.#call(Buffer.concat([Buffer.from([11]), u32(this.#handle(directory)), Buffer.from([isDirectory ? 1 : 0]),
        u32(segments.length), ...segments.map(string)]), signal)
      if (result.length !== 1 || result[0] !== 1) { this.#fail(); await this.stop(); throw failure() }
      return { status: 'committed' }
    } catch (error) {
      if (!this.#dead && error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '删除结果未确认；不能保证目标未删除')
    }
  }

  async move(directory: AnchoredPathObject, segments: readonly string[], destination: AnchoredPathObject, replace: boolean, signal: AbortSignal): Promise<PathMutationResult> {
    if (directory.kind !== 'directory' || destination.kind !== 'save' || !segments.length || segments.length > 64 || typeof replace !== 'boolean' || signal.aborted) throw failure()
    try {
      const result = await this.#call(Buffer.concat([Buffer.from([12]), u32(this.#handle(directory)), u32(this.#handle(destination)),
        Buffer.from([replace ? 1 : 0]), u32(segments.length), ...segments.map(string)]), signal)
      if (result.length !== 1 || result[0] !== 1) { this.#fail(); await this.stop(); throw failure() }
      return { status: 'committed' }
    } catch (error) {
      if (!this.#dead && error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '移动结果未确认；不能保证源或目标未改变')
    }
  }

  async createDirectory(directory: AnchoredPathObject, segments: readonly string[], signal: AbortSignal): Promise<PathDirectoryCreateResult> {
    if (directory.kind !== 'directory' || !segments.length || segments.length > 64 || signal.aborted) throw failure()
    try {
      const result = await this.#call(Buffer.concat([Buffer.from([17]), u32(this.#handle(directory)), u32(segments.length), ...segments.map(string)]), signal)
      if (result.length !== 1 || ![0, 1].includes(result[0]!)) { this.#fail(); await this.stop(); throw failure() }
      return { status: result[0] === 1 ? 'created' : 'existing' }
    } catch (error) {
      if (!this.#dead && error instanceof ZToolsError) throw error
      throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '创建目录结果未确认；不能保证目录未创建')
    }
  }

  async list(object: AnchoredPathObject, segments: readonly string[], signal: AbortSignal, strict = false): Promise<PathDirectoryEntry[]> {
    if (object.kind !== 'directory' || segments.length > 64) throw failure()
    const data = await this.#call(Buffer.concat([Buffer.from([strict ? 22 : 4]), u32(this.#handle(object)), u32(segments.length), ...segments.map(string)]), signal)
    try {
      if (data.length < 4) throw failure()
      const count = data.readUInt32LE(); if (count > 10_000) throw failure()
      let offset = 4, nameBytes = 0
      const entries: PathDirectoryEntry[] = [], names = new Set<string>()
      for (let index = 0; index < count; index++) {
        if (data.length - offset < 4) throw failure()
        const length = data.readUInt32LE(offset); offset += 4
        if (length < 1 || length > 4096 || data.length - offset < length + 9) throw failure()
        nameBytes += length; if (nameBytes > 1024 * 1024) throw failure()
        const name = new TextDecoder('utf8', { fatal: true }).decode(data.subarray(offset, offset + length)); offset += length
        const kind = data[offset++], size = data.readBigUInt64LE(offset); offset += 8
        if (!name || name === '.' || name === '..' || /[/\x00]/.test(name) ||
            (this.platform === 'win32' && /[\\:\x00-\x1f]/.test(name)) || names.has(name) ||
            ![0, 1].includes(kind!) || size > BigInt(Number.MAX_SAFE_INTEGER) || (kind === 1 && size !== 0n)) throw failure()
        names.add(name); entries.push({ name, isDirectory: kind === 1, size: Number(size) })
      }
      if (offset !== data.length) throw failure()
      return entries
    } catch { this.#fail(); await this.stop(); throw failure() }
  }

  stop(): Promise<void> {
    if (this.#stop) return this.#stop
    this.#fail()
    this.#stop = this.#bounded(this.#exitPromise)
    return this.#stop
  }

  #handle(object: AnchoredPathObject): number {
    const prefix = `${this.#generation}:`
    if (!object.handle.startsWith(prefix)) throw failure()
    const text = object.handle.slice(prefix.length)
    if (!/^[1-9]\d{0,9}$/.test(text)) throw failure()
    const value = Number(text)
    if (value > 0xffffffff) throw failure()
    return value
  }

  #call(payload: Buffer, signal: AbortSignal): Promise<Buffer> {
    if (signal.aborted) return Promise.reject(failure())
    if (this.#dead) return this.stop().then(() => { throw failure() })
    const frameLimit = payload[0] === 6 ? 16 * 1024 * 1024 + 32 * 1024 : payload[0] === 14 ? 64 * 1024 + 32 : 32 * 1024
    if (payload.length > frameLimit - 4) return Promise.reject(failure())
    if (this.#queuedCalls >= 64 || payload.length > 32 * 1024 * 1024 - this.#queuedBytes) return Promise.reject(failure())
    this.#queuedCalls++; this.#queuedBytes += payload.length
    const abort = () => this.#fail()
    signal.addEventListener('abort', abort, { once: true })
    // Bound the whole queue wait, startup and response, rather than only the active RPC.
    const deadline = setTimeout(abort, this.timeoutMs)
    const queued = this.#queue.then(async () => {
      if (this.#dead) { await this.stop(); throw failure() }
      if (signal.aborted) throw failure()
      try {
        await this.#ensureStarted()
        if (signal.aborted || this.#dead || this.#id === 0xffffffff) throw failure()
        const id = ++this.#id
        const response = new Promise<Buffer>((resolve, reject) => { this.#pending = { id, resolve, reject } })
        this.#child!.stdin.write(Buffer.concat([u32(payload.length + 4), u32(id), payload]), error => { if (error) this.#fail() })
        const result = await this.#bounded(response)
        if (this.#dead || signal.aborted) {
          // Return only a correlated commit ACK for the save caller to validate its exact byte count.
          const commit = payload[0] === 6 || payload[0] === 15
          if (!commit || result.length !== 5 || result[0] !== 1 || result.readUInt32LE(1) > 2 * 1024 * 1024 * 1024 ||
              (payload[0] === 6 && result.readUInt32LE(1) !== payload.readUInt32LE(6))) throw failure()
        }
        return result
      } catch (error) {
        if (!(error instanceof ZToolsError)) this.#fail()
        if (this.#dead) await this.stop()
        throw error instanceof ZToolsError ? error : failure()
      }
    })
    this.#queue = queued.catch(() => {})
    return queued.finally(() => {
      clearTimeout(deadline); signal.removeEventListener('abort', abort)
      this.#queuedCalls--; this.#queuedBytes -= payload.length
    })
  }

  #ensureStarted(): Promise<void> {
    if (this.#start) return this.#start
    this.#start = this.#bounded(new Promise<void>((resolve, reject) => {
      this.#resolveStart = resolve; this.#rejectStart = reject
      try {
        const stat = fs.lstatSync(this.executable)
        if (!stat.isFile() || stat.isSymbolicLink()) throw failure()
        const platform = this.dependencies.platform ?? process.platform, arch = this.dependencies.processArch ?? process.arch
        const child = (this.dependencies.spawn ?? spawn)(platform === 'darwin' ? '/usr/bin/arch' : this.executable,
          platform === 'darwin' ? [arch === 'arm64' ? '-arm64' : '-x86_64', this.executable] : [],
          { shell: false, windowsHide: true, stdio: 'pipe' })
        this.#child = child
        this.#exitPromise = new Promise<void>(done => {
          child.once('exit', () => { this.#exited = true; this.#fail(); done() })
          child.once('error', () => { if (!child.pid) { this.#exited = true; done() }; this.#fail() })
        })
        child.stdin.on('error', () => this.#fail())
        child.stdout.on('data', (chunk: Buffer) => this.#receive(chunk))
        child.stdout.on('error', () => this.#fail())
        child.stderr.resume()
      } catch { this.#fail() }
    }))
    return this.#start
  }

  #receive(chunk: Buffer): void {
    if (this.#dead) return
    let offset = 0
    try {
      while (offset < chunk.length) {
        if (!this.#frame) {
          const count = Math.min(4 - this.#headerBytes, chunk.length - offset)
          chunk.copy(this.#header, this.#headerBytes, offset, offset + count)
          offset += count; this.#headerBytes += count
          if (this.#headerBytes < 4) continue
          this.#headerBytes = 0
          if (!this.#hello) {
            if (this.#header.toString('ascii') !== 'ZPA1') throw failure()
            this.#hello = true; this.#resolveStart?.(); continue
          }
          const length = this.#header.readUInt32LE()
          if (!this.#pending || length < 5 || length > 16 * 1024 * 1024 + 5) throw failure()
          this.#frame = Buffer.allocUnsafe(length); this.#frameBytes = 0
        }
        const count = Math.min(this.#frame.length - this.#frameBytes, chunk.length - offset)
        chunk.copy(this.#frame, this.#frameBytes, offset, offset + count)
        offset += count; this.#frameBytes += count
        if (this.#frameBytes === this.#frame.length) {
          const frame = this.#frame, pending = this.#pending
          this.#frame = undefined; this.#pending = undefined
          if (!pending || frame.readUInt32LE() !== pending.id || ![0, 1].includes(frame[4]!)) {
            pending?.reject(failure()); throw failure()
          }
          if (frame[4] === 0) {
            if (frame.length !== 6 || ![1, 2, 3, 4, 5, 6].includes(frame[5]!)) { pending.reject(failure()); throw failure() }
            const errors = {
              1: [errorCodes.fileError, '原生文件访问被拒绝'],
              2: [errorCodes.fileWriteOutcomeUnknown, '提交结果未确认；不能保证输出未提交'],
              3: [errorCodes.fileAlreadyExists, '输出已存在，未覆盖'],
              4: [errorCodes.fileTooLarge, '文件超过操作大小上限'],
              5: [errorCodes.fileCrossDevice, '跨卷移动不受支持；源和目标未提交移动'],
              6: [errorCodes.fileStagingRetained, '保存未提交；临时文件内容释放未确认，需恢复审计']
            } as const
            const [code, message] = errors[frame[5] as keyof typeof errors]
            pending.reject(new NativeReplyError(code, message))
          }
          else pending.resolve(frame.subarray(5))
        }
      }
    } catch { this.#fail() }
  }

  #fail(): void {
    this.#dead = true
    this.#rejectStart?.(failure()); this.#pending?.reject(failure()); this.#pending = undefined
    this.#committedSaves.clear()
    if (this.#child && !this.#exited) { try { this.#child.kill('SIGKILL') } catch { /* Exit confirmation remains required. */ } }
  }

  async #bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.#fail(); reject(failure()) }, this.timeoutMs)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
}
