import { randomBytes } from 'node:crypto'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { isReferenceWriteIssues, type PathGrantRef, type ReferenceWriteIssue } from '../../contracts/path-reference.js'
import type { AnchoredPathObject, PathAccessAdapter, PathAccessProvider, PathAccessRight, PathDirectoryEntry, PathSaveResult, PathMetadata, PathMutationResult, PathDirectoryCreateResult } from '../platform/path-access.js'

interface Grant {
  owner: number
  object: AnchoredPathObject
  adapter: PathAccessAdapter
  rights: readonly PathAccessRight[]
  expiresAt: number
  state: 'active' | 'revoking' | 'closed'
  controller: AbortController
  pending: Set<Promise<unknown>>
  closing?: Promise<void>
  children: Set<Grant>
  parent?: Grant
  writeTail?: Promise<void>
  cleanupFailed: boolean
}
export type OpaquePathGrant = PathGrantRef
type ArtifactReference = OpaquePathGrant & { readonly kind: 'file'; readonly operations: readonly ['read'] }
export type PathSaveArtifactResult = PathSaveResult & (
  | { readonly referenceState: 'available'; readonly reference: ArtifactReference }
  | { readonly referenceState: 'unavailable'; readonly issues: readonly ReferenceWriteIssue[] })
export interface PathGrantOwnerLifecycle {
  isActive(owner: number): boolean
  onRemoved(listener: (owner: number) => void): () => void
}
export interface PathResourceLease {
  metadata: PathMetadata
  displayName: string
  signal: AbortSignal
  read(offset: number, length: number): Promise<Buffer>
  close(): void
}
const denied = () => new ZToolsError(errorCodes.permissionDenied, '文件授权无效或已撤销')

export function grantPathSegments(relativePath: string, platform: 'win32' | 'darwin' = process.platform === 'darwin' ? 'darwin' : 'win32'): string[] {
  if (typeof relativePath !== 'string' || relativePath.length > 4096 || relativePath.includes('\0') || (platform === 'win32' && relativePath.includes('\\'))) throw denied()
  if (relativePath === '') return []
  const segments = relativePath.split('/')
  if (segments.length > 64 || segments.some(part => !part || part === '.' || part === '..' || /^\.ztools-save-/i.test(part) || (platform === 'win32' && /[:\x00-\x1f]/.test(part)))) throw denied()
  return segments
}

/** selectedPath is supplied by trusted main dialog/provider code only. */
export class PathGrantService {
  readonly #grants = new Map<string, Grant>()
  readonly #closedOwners = new Set<number>()
  readonly #creating = new Map<Promise<unknown>, { owner: number; controller: AbortController; releaseFailed: boolean }>()
  readonly #stopController = new AbortController()
  #stopping?: Promise<void>
  #saveBytes = 0
  #saveCalls = 0
  #streamCalls = 0
  #artifactReservations = 0
  readonly #artifactReservationsByOwner = new Map<number, number>()
  readonly #removeOwnerListener: () => void
  #ownerCleanupFailed = false
  readonly #resourceCounts = new Map<number, number>()
  constructor(private readonly adapter: PathAccessAdapter | PathAccessProvider, private readonly now = Date.now, private readonly closeTimeoutMs = 5000,
    private readonly owners?: PathGrantOwnerLifecycle) {
    if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 30_000) throw denied()
    this.#removeOwnerListener = owners?.onRemoved(owner => {
      void this.closeOwner(owner).catch(() => { this.#ownerCleanupFailed = true })
    }) ?? (() => {})
  }

  create(owner: number, selectedPath: string, kind: AnchoredPathObject['kind'], rights: readonly PathAccessRight[], signal?: AbortSignal): Promise<OpaquePathGrant> {
    if (!Number.isSafeInteger(owner) || owner <= 0 || !['file', 'directory', 'save'].includes(kind) || !rights.length ||
        rights.some(right => !['read', 'write', 'list'].includes(right)) || new Set(rights).size !== rights.length ||
        (kind === 'save' && (rights.length !== 1 || rights[0] !== 'write')) ||
        (kind !== 'directory' && rights.includes('list'))) return Promise.reject(denied())
    return this.#create(owner, selectedPath, kind, rights, signal)
  }

  /** Clipboard/native selection only; same native open determines kind and never adds write authority. */
  createSelected(owner: number, selectedPath: string, signal?: AbortSignal): Promise<OpaquePathGrant> {
    if (!Number.isSafeInteger(owner) || owner <= 0) return Promise.reject(denied())
    return this.#create(owner, selectedPath, 'selected', ['read'], signal)
  }

  /** Re-project an existing live grant for trusted main consumers; never reopen or reveal its path. */
  reference(owner: number, grantId: string): OpaquePathGrant {
    this.#assertOwner(owner)
    const grant = this.#grants.get(grantId)
    if (!grant || grant.owner !== owner || grant.state !== 'active' || grant.expiresAt <= this.now()) throw denied()
    return Object.freeze({ grantId, displayName: grant.object.displayName, kind: grant.object.kind,
      operations: Object.freeze([...grant.rights]) })
  }

  #create(owner: number, selectedPath: string, kind: AnchoredPathObject['kind'] | 'selected', rights: readonly PathAccessRight[], signal?: AbortSignal): Promise<OpaquePathGrant> {
    const immutableRights = Object.freeze([...rights])
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const creation = { owner, controller, releaseFailed: false }
    const operation = (async () => {
      this.#assertOwner(owner)
      if (combined.aborted) throw denied()
      for (const grant of this.#grants.values()) if (grant.expiresAt <= this.now()) void this.#close(grant).catch(() => {})
      if ([...this.#grants.values()].filter(grant => grant.owner === owner).length +
          [...this.#creating.values()].filter(item => item.owner === owner).length + (this.#artifactReservationsByOwner.get(owner) ?? 0) >= 256 || this.#creating.size >= 256) throw denied()
      if (this.#grants.size + this.#creating.size + this.#artifactReservations >= 256) throw denied()
      const adapter = 'forOwner' in this.adapter ? this.adapter.forOwner(owner) : this.adapter
      if (kind === 'selected' && !adapter.pinSelected) throw new ZToolsError(errorCodes.nativeHostUnavailable, '原生文件选择访问能力不可用')
      const object = kind === 'selected' ? await adapter.pinSelected!(selectedPath, combined) : await adapter.pin(selectedPath, kind, immutableRights, combined)
      try {
        this.#assertOwner(owner)
        if (combined.aborted || (kind === 'selected' ? object.kind !== 'file' && object.kind !== 'directory' : object.kind !== kind)) throw denied()
        const selectedRights: readonly PathAccessRight[] = kind === 'selected' && object.kind === 'directory' ? Object.freeze(['read', 'list']) : immutableRights
        return this.#register(owner, object, selectedRights, adapter)
      } catch (error) {
        try { await this.#bounded(adapter.release(object)) }
        catch { creation.releaseFailed = true; throw new ZToolsError(errorCodes.fileError, '文件授权释放未确认') }
        throw error
      }
    })()
    this.#creating.set(operation, creation)
    void operation.finally(() => this.#creating.delete(operation)).catch(() => {})
    return operation
  }

  read(owner: number, grantId: string, relativePath = '', maxBytes = 16 * 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 16 * 1024 * 1024) return Promise.reject(denied())
    return this.#operation(owner, grantId, relativePath, 'read', async (grant, segments, combined) => {
      const data = await grant.adapter.read(grant.object, segments, maxBytes, combined)
      if (combined.aborted || !Buffer.isBuffer(data) || data.byteLength > maxBytes) throw denied()
      return data
    }, false, signal)
  }

  list(owner: number, grantId: string, relativePath = '', signal?: AbortSignal): Promise<PathDirectoryEntry[]> {
    return this.#operation(owner, grantId, relativePath, 'list', (grant, segments, combined) => {
      if (grant.object.kind !== 'directory') throw denied()
      return grant.adapter.list(grant.object, segments, combined)
    }, false, signal)
  }

  readRange(owner: number, grantId: string, relativePath: string, offset: number, length: number, signal?: AbortSignal): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 ||
        length > 16 * 1024 * 1024 || offset > Number.MAX_SAFE_INTEGER - length) return Promise.reject(denied())
    return this.#operation(owner, grantId, relativePath, 'read', async (grant, segments, combined) => {
      const data = await grant.adapter.readRange(grant.object, segments, offset, length, combined)
      if (!Buffer.isBuffer(data) || data.byteLength > length) throw denied()
      return data
    }, false, signal)
  }

  save(owner: number, grantId: string, data: Buffer, replace = false, signal?: AbortSignal): Promise<PathSaveResult> {
    if (!Buffer.isBuffer(data) || data.length > 16 * 1024 * 1024 || typeof replace !== 'boolean' ||
        this.#saveCalls >= 16 || data.length > 32 * 1024 * 1024 - this.#saveBytes) return Promise.reject(denied())
    this.#saveCalls++; this.#saveBytes += data.length
    const snapshot = Buffer.from(data)
    return this.#operation(owner, grantId, '', 'write', async (grant, _, combined) => {
      if (grant.object.kind !== 'save') throw denied()
      const result = await grant.adapter.save(grant.object, snapshot, replace, combined)
      if (result.status !== 'committed' || result.bytesWritten !== snapshot.length || combined.aborted) {
        throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '保存结果未确认；不能保证输出未提交')
      }
      if (result.cleanupIssues !== undefined) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '保存已提交，但日志清理未确认；不能重试写入')
      return result
    }, true, signal).finally(() => { this.#saveCalls--; this.#saveBytes -= snapshot.length })
  }

  saveWithReference(owner: number, grantId: string, data: Buffer, replace = false, signal?: AbortSignal): Promise<PathSaveArtifactResult> {
    if (!Buffer.isBuffer(data) || data.length > 16 * 1024 * 1024 || typeof replace !== 'boolean' ||
        this.#saveCalls >= 16 || data.length > 32 * 1024 * 1024 - this.#saveBytes) return Promise.reject(denied())
    let save: Grant | undefined
    try {
      this.#assertOwner(owner)
      save = this.#grants.get(grantId)
      if (!save || save.owner !== owner || save.state !== 'active' || save.expiresAt <= this.now() ||
          save.object.kind !== 'save' || !save.rights.includes('write')) throw denied()
      const ownerCount = [...this.#grants.values()].filter(grant => grant.owner === owner).length
      const creatingCount = [...this.#creating.values()].filter(item => item.owner === owner).length
      if (ownerCount + creatingCount + (this.#artifactReservationsByOwner.get(owner) ?? 0) >= 256 ||
          this.#grants.size + this.#creating.size + this.#artifactReservations >= 256) throw denied()
    } catch (error) { return Promise.reject(error) }
    this.#reserveArtifact(owner); this.#saveCalls++; this.#saveBytes += data.length
    const snapshot = Buffer.from(data)
    let created: ArtifactReference | undefined, reservationConsumed = false, committed: PathSaveResult | undefined
    const issues: ReferenceWriteIssue[] = []
    const addIssue = (stage: ReferenceWriteIssue['stage'], code: ReferenceWriteIssue['code']) => {
      if (!issues.some(issue => issue.stage === stage)) issues.push({ stage, code })
      issues.sort((left, right) => (left.stage === 'reference' ? 0 : 1) - (right.stage === 'reference' ? 0 : 1))
    }
    const unavailable = (): PathSaveArtifactResult => ({ status: 'committed', bytesWritten: committed!.bytesWritten,
      referenceState: 'unavailable', issues: Object.freeze(issues.map(issue => Object.freeze({ ...issue }))) })
    return this.#operation(owner, grantId, '', 'write', async (grant, _, combined) => {
      if (grant !== save || grant.object.kind !== 'save') throw denied()
      const result = await grant.adapter.save(grant.object, snapshot, replace, combined)
      if (result.status !== 'committed' || result.bytesWritten !== snapshot.length) {
        throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '保存结果未确认；不能保证输出未提交')
      }
      committed = { status: 'committed', bytesWritten: result.bytesWritten }
      if (result.cleanupIssues !== undefined) {
        if (isReferenceWriteIssues(result.cleanupIssues)) for (const issue of result.cleanupIssues) addIssue(issue.stage, issue.code)
        else addIssue('release', errorCodes.fileError)
        return unavailable()
      }
      let file: AnchoredPathObject | undefined
      try {
        this.#assertOwner(owner)
        if (combined.aborted) throw denied()
        file = await grant.adapter.pinCommittedSave(grant.object, combined)
        this.#assertOwner(owner)
        if (combined.aborted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '保存结果未确认；不能保证输出未提交')
        if (grant.state !== 'active' || file.kind !== 'file' || file.displayName !== grant.object.displayName)
          throw new ZToolsError(errorCodes.fileError, '文件保存已确认，但只读产物引用不可用')
        const metadata = await grant.adapter.describe(file, combined)
        if (combined.aborted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '保存结果未确认；不能保证输出未提交')
        if (metadata.isDirectory || metadata.size !== result.bytesWritten)
          throw new ZToolsError(errorCodes.fileError, '文件保存已确认，但产物大小与写入回执不匹配')
        const observed = await grant.adapter.read(file, [], snapshot.length, combined)
        if (combined.aborted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '保存结果未确认；不能保证输出未提交')
        if (!Buffer.isBuffer(observed) || !observed.equals(snapshot))
          throw new ZToolsError(errorCodes.fileError, '文件保存已确认，但产物内容与写入回执不匹配')
        if (grant.expiresAt <= this.now())
          throw new ZToolsError(errorCodes.fileError, '文件保存已确认，但保存授权在产物引用生成前过期')
        created = this.#register(owner, file, Object.freeze(['read']), grant.adapter, undefined, grant.expiresAt) as ArtifactReference
        this.#releaseArtifact(owner); reservationConsumed = true
        file = undefined
        return { status: 'committed' as const, bytesWritten: result.bytesWritten, referenceState: 'available' as const, reference: created }
      } catch (error) {
        addIssue('reference', error instanceof ZToolsError && error.code === errorCodes.permissionDenied ? errorCodes.permissionDenied : errorCodes.fileError)
        if (file) {
          try { await this.#bounded(grant.adapter.release(file)) }
          catch { grant.cleanupFailed = true; addIssue('release', errorCodes.fileError) }
        }
        return unavailable()
      }
    }, true, signal, true).catch(async error => {
      const artifact = created && this.#grants.get(created.grantId)
      if (artifact) {
        try { await this.#close(artifact) }
        catch { if (save) save.cleanupFailed = true; addIssue('release', errorCodes.fileError) }
      }
      if (committed) {
        addIssue('reference', error instanceof ZToolsError && error.code === errorCodes.permissionDenied ? errorCodes.permissionDenied : errorCodes.fileError)
        return unavailable()
      }
      throw error
    }).finally(() => {
      if (!reservationConsumed) this.#releaseArtifact(owner)
      this.#saveCalls--; this.#saveBytes -= snapshot.length
    })
  }

  deriveSave(owner: number, directoryGrantId: string, relativePath: string, signal?: AbortSignal): Promise<OpaquePathGrant> {
    return this.#derive(owner, directoryGrantId, relativePath, 'save', signal)
  }

  streamSave(owner: number, grantId: string, expectedBytes: number | undefined, chunks: AsyncIterable<Buffer>, replace = false, signal?: AbortSignal): Promise<PathSaveResult> {
    if ((expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > 2 * 1024 * 1024 * 1024)) || typeof replace !== 'boolean' ||
        !chunks || typeof chunks[Symbol.asyncIterator] !== 'function' || this.#streamCalls >= 8) return Promise.reject(denied())
    this.#streamCalls++
    return this.#operation(owner, grantId, '', 'write', async (grant, _, combined) => {
      if (grant.object.kind !== 'save') throw denied()
      if (combined.aborted) throw denied()
      const result = await grant.adapter.streamSave(grant.object, expectedBytes, chunks, replace, combined)
      if (result.status !== 'committed' || !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 0 || result.bytesWritten > 2 * 1024 * 1024 * 1024 ||
          (expectedBytes !== undefined && result.bytesWritten !== expectedBytes) || combined.aborted || result.cleanupIssues !== undefined) {
        throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '流式保存提交结果未确认；不能保证目标未改变')
      }
      return result
    }, true, signal).finally(() => { this.#streamCalls-- })
  }

  copy(owner: number, sourceGrantId: string, destinationGrantId: string, replace = false, signal?: AbortSignal): Promise<PathSaveResult> {
    if (typeof replace !== 'boolean') return Promise.reject(denied())
    return this.#operation(owner, sourceGrantId, '', 'read', (source, _, sourceSignal) => this.#operation(owner, destinationGrantId, '', 'write', async (destination, __, destinationSignal) => {
      if (source.object.kind !== 'file' || destination.object.kind !== 'save') throw denied()
      const combined = AbortSignal.any([sourceSignal, destinationSignal])
      const result = await source.adapter.copy(source.object, destination.object, replace, combined)
      if (result.status !== 'committed' || !Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 0 || result.bytesWritten > 2 * 1024 * 1024 * 1024 || combined.aborted || result.cleanupIssues !== undefined) {
        throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '复制结果未确认；不能保证输出未提交，源文件未删除')
      }
      return result
    }, true, signal), true, signal)
  }

  remove(owner: number, directoryGrantId: string, relativePath: string, isDirectory = false, signal?: AbortSignal): Promise<PathMutationResult> {
    if (typeof isDirectory !== 'boolean') return Promise.reject(denied())
    return this.#operation(owner, directoryGrantId, relativePath, 'write', async (grant, segments, combined) => {
      if (grant.object.kind !== 'directory' || !segments.length) throw denied()
      const result = await grant.adapter.remove(grant.object, segments, isDirectory, combined)
      if (result.status !== 'committed' || combined.aborted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '删除结果未确认；不能保证目标未删除')
      return result
    }, true, signal)
  }

  move(owner: number, directoryGrantId: string, relativePath: string, destinationGrantId: string, replace = false, signal?: AbortSignal): Promise<PathMutationResult> {
    if (typeof replace !== 'boolean') return Promise.reject(denied())
    return this.#operation(owner, directoryGrantId, relativePath, 'write', (source, segments, sourceSignal) => this.#operation(owner, destinationGrantId, '', 'write', async (destination, _, destinationSignal) => {
      if (source.object.kind !== 'directory' || !segments.length || destination.object.kind !== 'save') throw denied()
      const combined = AbortSignal.any([sourceSignal, destinationSignal])
      const result = await source.adapter.move(source.object, segments, destination.object, replace, combined)
      if (result.status !== 'committed' || combined.aborted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '移动结果未确认；不能保证源或目标未改变')
      return result
    }, true, signal), true, signal)
  }

  createDirectory(owner: number, directoryGrantId: string, relativePath: string, signal?: AbortSignal): Promise<PathDirectoryCreateResult> {
    return this.#operation(owner, directoryGrantId, relativePath, 'write', async (grant, segments, combined) => {
      if (grant.object.kind !== 'directory' || !segments.length) throw denied()
      const result = await grant.adapter.createDirectory(grant.object, segments, combined)
      if (!['created', 'existing'].includes(result.status) || combined.aborted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '创建目录结果未确认；不能保证目录未创建')
      return result
    }, true, signal)
  }

  deriveRead(owner: number, directoryGrantId: string, relativePath: string, signal?: AbortSignal): Promise<OpaquePathGrant> {
    return this.#derive(owner, directoryGrantId, relativePath, 'file', signal)
  }
  deriveDirectory(owner: number, directoryGrantId: string, relativePath: string, signal?: AbortSignal): Promise<OpaquePathGrant> {
    return this.#derive(owner, directoryGrantId, relativePath, 'directory', signal)
  }

  describe(owner: number, grantId: string, signal?: AbortSignal): Promise<PathMetadata> {
    return this.#operation(owner, grantId, '', 'read', async (grant, _, combined) => {
      if (grant.object.kind === 'save') throw denied()
      const metadata = await grant.adapter.describe(grant.object, combined)
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || !Number.isSafeInteger(metadata.lastModifiedMs) ||
          Math.abs(metadata.lastModifiedMs) > 8640000000000000 || typeof metadata.isDirectory !== 'boolean' ||
          metadata.isDirectory !== (grant.object.kind === 'directory') || (metadata.isDirectory && metadata.size !== 0)) throw denied()
      return metadata
    }, false, signal)
  }

  async #derive(owner: number, directoryGrantId: string, relativePath: string, kind: AnchoredPathObject['kind'], signal?: AbortSignal): Promise<OpaquePathGrant> {
    const right = kind === 'save' ? 'write' : kind === 'file' ? 'read' : this.#grants.get(directoryGrantId)?.rights[0] ?? 'read'
    let registered: OpaquePathGrant | undefined, parentForCleanup: Grant | undefined
    try { return await this.#operation(owner, directoryGrantId, relativePath, right, async (parent, segments, combined) => {
      parentForCleanup = parent
      if (this.#grants.size + [...this.#grants.values()].reduce((count, grant) => count + grant.pending.size, 0) + this.#creating.size + this.#artifactReservations >= 256) throw denied()
      if (parent.object.kind !== 'directory' || !segments.length || [...this.#grants.values()].filter(grant => grant.owner === owner).length +
          [...this.#grants.values()].filter(grant => grant.owner === owner).reduce((count, grant) => count + grant.pending.size, 0) +
          [...this.#creating.values()].filter(item => item.owner === owner).length + (this.#artifactReservationsByOwner.get(owner) ?? 0) >= 256) throw denied()
      const object = kind === 'save' ? await parent.adapter.deriveSave(parent.object, segments, combined) :
        kind === 'file' ? await parent.adapter.deriveRead(parent.object, segments, combined) :
          await parent.adapter.deriveDirectory(parent.object, segments, combined)
      try {
        this.#assertOwner(owner)
        if (parent.state !== 'active' || combined.aborted || object.kind !== kind) throw denied()
        registered = this.#register(owner, object, kind === 'directory' ? parent.rights : Object.freeze([right]), parent.adapter, parent)
        return registered
      } catch (error) {
        try { await this.#bounded(parent.adapter.release(object)) }
        catch { parent.cleanupFailed = true; throw new ZToolsError(errorCodes.fileError, '派生文件授权释放未确认') }
        throw error
      }
    }, false, signal) } catch (error) {
      // If cancellation races the completion microtask, revoke the child that the caller never received.
      const child = registered && this.#grants.get(registered.grantId)
      if (child) {
        try { await this.#close(child) }
        catch { if (parentForCleanup) parentForCleanup.cleanupFailed = true; throw new ZToolsError(errorCodes.fileError, '派生文件授权释放未确认') }
      }
      throw error
    }
  }

  #register(owner: number, object: AnchoredPathObject, rights: readonly PathAccessRight[], adapter: PathAccessAdapter, parent?: Grant, expiresAt = Infinity): OpaquePathGrant {
    if (!object.handle || !object.displayName || object.displayName.includes('/') || object.displayName.includes('\0') ||
        (this.adapter.platform === 'win32' && object.displayName.includes('\\'))) throw denied()
    const now = this.now()
    const grantExpiresAt = Math.min(now + 3_600_000, parent?.expiresAt ?? Infinity, expiresAt)
    if (grantExpiresAt <= now) throw denied()
    const grantId = randomBytes(32).toString('base64url')
    const grant: Grant = { owner, object, adapter, rights, expiresAt: grantExpiresAt,
      state: 'active', controller: new AbortController(), pending: new Set(), children: new Set(), cleanupFailed: false, ...(parent ? { parent } : {}) }
    this.#grants.set(grantId, grant); parent?.children.add(grant)
    return { grantId, displayName: object.displayName, kind: object.kind, operations: [...rights] }
  }

  #operation<T>(owner: number, grantId: string, relativePath: string, right: PathAccessRight,
    action: (grant: Grant, segments: readonly string[], signal: AbortSignal) => Promise<T>, writeCommit = false, signal?: AbortSignal,
    serializeWrite = false): Promise<T> {
    try {
      this.#assertOwner(owner)
      const grant = this.#grants.get(grantId), segments = grantPathSegments(relativePath, this.adapter.platform)
      if (!grant || grant.owner !== owner || grant.state !== 'active') throw denied()
      if (grant.expiresAt <= this.now()) { void this.#close(grant).catch(() => {}); throw denied() }
      if (!grant.rights.includes(right) || (grant.object.kind !== 'directory' && segments.length)) throw denied()
      const combined = signal ? AbortSignal.any([signal, grant.controller.signal]) : grant.controller.signal
      const execute = () => {
        if (combined.aborted) throw denied()
        return action(grant, segments, combined)
      }
      const actionResult = serializeWrite ? this.#serializeWrite(grant, execute) : Promise.resolve().then(execute)
      const pending = actionResult.then(data => {
        if (combined.aborted) {
          if (writeCommit) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '保存结果未确认；不能保证输出未提交')
          throw denied()
        }
        return data
      })
      grant.pending.add(pending)
      void pending.finally(() => grant.pending.delete(pending)).catch(() => {})
      return pending
    } catch (error) { return Promise.reject(error) }
  }

  #serializeWrite<T>(grant: Grant, action: () => Promise<T>): Promise<T> {
    const previous = grant.writeTail ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => gate)
    grant.writeTail = tail
    return previous.then(action).finally(() => {
      release()
      if (grant.writeTail === tail) delete grant.writeTail
    })
  }

  #reserveArtifact(owner: number): void {
    this.#artifactReservations++
    this.#artifactReservationsByOwner.set(owner, (this.#artifactReservationsByOwner.get(owner) ?? 0) + 1)
  }

  #releaseArtifact(owner: number): void {
    this.#artifactReservations--
    const count = (this.#artifactReservationsByOwner.get(owner) ?? 1) - 1
    if (count) this.#artifactReservationsByOwner.set(owner, count)
    else this.#artifactReservationsByOwner.delete(owner)
  }

  resourceUrl(owner: number, grantId: string): string {
    const grant = this.#resourceGrant(grantId, owner)
    return `ztools://file/${grantId}/${encodeURIComponent(grant.object.displayName)}`
  }
  readReference(owner: number, grantId: string): OpaquePathGrant {
    const grant = this.#resourceGrant(grantId, owner)
    return { grantId, displayName: grant.object.displayName, kind: 'file', operations: ['read'] }
  }
  saveReference(owner: number, grantId: string): OpaquePathGrant {
    this.#assertOwner(owner)
    const grant = this.#grants.get(grantId)
    if (!grant || grant.owner !== owner || grant.state !== 'active' || grant.expiresAt <= this.now() ||
        grant.object.kind !== 'save' || !grant.rights.includes('write')) throw denied()
    return { grantId, displayName: grant.object.displayName, kind: 'save', operations: ['write'] }
  }

  /** Call only with Electron webRequest's trusted WebContents ID, never a Renderer supplied owner. */
  /** Main-only provenance, including pending/revoked-read states; never grants access. */
  ownsResourceUrl(url: string): boolean {
    if (typeof url !== 'string' || url.length > 16 * 1024) return false
    try {
      const parsed = new URL(url), pieces = parsed.pathname.split('/')
      if (parsed.protocol !== 'ztools:' || parsed.hostname !== 'file' || parsed.port || parsed.username || parsed.password ||
          parsed.search || parsed.hash || pieces.length !== 3 || !/^[A-Za-z0-9_-]{43}$/.test(pieces[1]!)) return false
      const grant = this.#grants.get(pieces[1]!)
      return !!grant && url === 'ztools://file/' + pieces[1] + '/' + encodeURIComponent(grant.object.displayName)
    } catch { return false }
  }

  canLoadResource(url: string, owner: number): boolean {
    try { this.#resourceFromUrl(url, owner); return true } catch { return false }
  }

  /** Protocol handler still requires canLoadResource from the session webRequest owner guard. */
  async openResource(url: string, signal: AbortSignal): Promise<PathResourceLease> {
    const { grantId, grant } = this.#resourceFromUrl(url)
    const count = this.#resourceCounts.get(grant.owner) ?? 0
    if (count >= 8 || signal.aborted) throw denied()
    this.#resourceCounts.set(grant.owner, count + 1)
    const controller = new AbortController(), combined = AbortSignal.any([controller.signal, signal, grant.controller.signal])
    let closed = false
    const close = () => {
      if (closed) return
      closed = true; combined.removeEventListener('abort', close); controller.abort()
      const remaining = (this.#resourceCounts.get(grant.owner) ?? 1) - 1
      if (remaining) this.#resourceCounts.set(grant.owner, remaining)
      else this.#resourceCounts.delete(grant.owner)
    }
    combined.addEventListener('abort', close, { once: true })
    try {
      const metadata = await this.describe(grant.owner, grantId, combined)
      if (combined.aborted || metadata.isDirectory || metadata.size > 2 * 1024 * 1024 * 1024) throw denied()
      return { metadata, displayName: grant.object.displayName, signal: combined, close,
        read: (offset, length) => {
          if (closed || combined.aborted || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) ||
              length < 0 || length > 64 * 1024 || offset > metadata.size - length) return Promise.reject(denied())
          return this.#operation(grant.owner, grantId, '', 'read', async current => {
            const bytes = await current.adapter.readRange(current.object, [], offset, length, combined)
            if (combined.aborted || !Buffer.isBuffer(bytes) || bytes.length !== length) throw denied()
            return bytes
          })
        } }
    } catch (error) { close(); throw error }
  }

  #resourceGrant(grantId: string, owner?: number): Grant {
    const grant = this.#grants.get(grantId)
    if (!grant || (owner !== undefined && grant.owner !== owner) || grant.state !== 'active' ||
        grant.expiresAt <= this.now() || grant.object.kind !== 'file' || !grant.rights.includes('read')) throw denied()
    this.#assertOwner(grant.owner)
    return grant
  }

  #resourceFromUrl(url: string, owner?: number): { grantId: string; grant: Grant } {
    if (typeof url !== 'string' || url.length > 16 * 1024) throw denied()
    const parsed = new URL(url), pieces = parsed.pathname.split('/')
    if (parsed.protocol !== 'ztools:' || parsed.hostname !== 'file' || parsed.port || parsed.username || parsed.password ||
        parsed.search || parsed.hash || pieces.length !== 3 || !/^[A-Za-z0-9_-]{43}$/.test(pieces[1]!)) throw denied()
    const grantId = pieces[1]!, grant = this.#resourceGrant(grantId, owner)
    if (url !== this.resourceUrl(grant.owner, grantId)) throw denied()
    return { grantId, grant }
  }

  revoke(owner: number, grantId: string): Promise<void> {
    const grant = this.#grants.get(grantId)
    if (!grant || grant.owner !== owner) return Promise.reject(denied())
    return this.#close(grant)
  }

  async closeOwner(owner: number): Promise<void> {
    this.#closedOwners.add(owner)
    const creating = [...this.#creating].filter(([, item]) => item.owner === owner)
    for (const [, item] of creating) item.controller.abort()
    try {
      const results = await this.#bounded(Promise.allSettled([...creating.map(([pending]) => pending),
        ...[...this.#grants.values()].filter(grant => grant.owner === owner).map(grant => this.#close(grant))]))
      // Pin rejection is expected when the closing owner cancels creation. Release failures still propagate via close.
      if (creating.some(([, item]) => item.releaseFailed) || results.slice(creating.length).some(result => result.status === 'rejected')) throw denied()
    } finally {
      if ('forOwner' in this.adapter) await this.#bounded(this.adapter.closeOwner(owner))
    }
  }

  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping
    this.#removeOwnerListener()
    this.#stopController.abort()
    for (const item of this.#creating.values()) item.controller.abort()
    this.#stopping = (async () => {
      const creating = [...this.#creating]
      let incomplete = false
      try {
        const results = await this.#bounded(Promise.allSettled([...creating.map(([pending]) => pending), ...[...this.#grants.values()].map(grant => this.#close(grant))]))
        incomplete = creating.some(([, item]) => item.releaseFailed) || results.slice(creating.length).some(result => result.status === 'rejected')
      } catch { incomplete = true }
      try { await this.#bounded(this.adapter.stop()) } catch { incomplete = true }
      if (incomplete || this.#ownerCleanupFailed) throw new ZToolsError(errorCodes.fileError, '文件授权释放未确认')
    })()
    return this.#stopping
  }

  #assertOwner(owner: number): void {
    if (!Number.isSafeInteger(owner) || owner <= 0 || this.#stopController.signal.aborted || this.#closedOwners.has(owner) ||
        (this.owners && !this.owners.isActive(owner))) throw denied()
  }

  #close(grant: Grant): Promise<void> {
    if (grant.closing) return grant.closing
    grant.state = 'revoking'
    grant.controller.abort()
    const children = [...grant.children].map(child => this.#close(child))
    grant.closing = (async () => {
      const pending = [...grant.pending]
      const results = await this.#bounded(Promise.allSettled([...pending, ...children]))
      await this.#bounded(grant.adapter.release(grant.object))
      if (grant.cleanupFailed || results.slice(pending.length).some(result => result.status === 'rejected')) throw new ZToolsError(errorCodes.fileError, '派生保存授权释放未确认')
      grant.state = 'closed'
      grant.parent?.children.delete(grant)
      for (const [id, candidate] of this.#grants) if (candidate === grant) this.#grants.delete(id)
    })()
    return grant.closing
  }

  async #bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ZToolsError(errorCodes.fileError, '原生授权操作停止未确认')), this.closeTimeoutMs)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
}
