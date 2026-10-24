import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import type { PathGrantRef } from '../../contracts/path-reference.js'
import { errorCodes, toPublicError, ZToolsError } from '../../contracts/errors.js'
import type { FileClipboardAdapter } from './clipboard-service.js'
import type { PathGrantService } from './path-grant-service.js'
import type { EventService } from './event-service.js'

type ClipboardRef = PathGrantRef & { fileUrl?: string }
type ClipboardGrants = Pick<PathGrantService, 'createSelected' | 'revoke' | 'resourceUrl'>
const failed = () => new ZToolsError(errorCodes.clipboardError, '文件剪贴板引用获取未完成')

/** OS clipboard supplies selection names; classify and authorize each exact object in one native open. */
export class ReferenceClipboardFilesService {
  #requests = 0
  #publishing = false
  constructor(private readonly clipboard: Pick<FileClipboardAdapter, 'readFiles'>, private readonly grants: ClipboardGrants) {}

  /** Capture once privately, acquire distinct owner references, then deliver only to that owner instance. */
  async publishChange(events: Pick<EventService, 'subscribers' | 'publishHostToOwner'>, signal: AbortSignal,
    isCurrent: () => boolean, isOwnerEligible: (owner: CallerIdentity) => boolean = () => true): Promise<{ delivered: number }> {
    const eligible = (owner: CallerIdentity) => { try { return isOwnerEligible(owner) } catch { return false } }
    if (signal.aborted || this.#publishing) throw failed()
    this.#publishing = true
    let delivered = 0
    try {
      const owners = events.subscribers('clipboard_change').filter(eligible)
      if (owners.length === 0) return { delivered: 0 }
      const selected = await this.clipboard.readFiles(signal)
      if (!Array.isArray(selected) || selected.length > 256 || owners.length > 256 || selected.length * owners.length > 1024) throw failed()
      const names = Object.freeze([...selected])
      const snapshot = new ReferenceClipboardFilesService({ readFiles: async () => [...names] }, this.grants)
      for (const owner of owners) {
        if (!eligible(owner)) continue
        if (signal.aborted || !isCurrent()) throw failed()
        const result = await snapshot.read(owner, signal)
        let sent = false
        try {
          if (signal.aborted || !isCurrent()) throw failed()
          if (!eligible(owner)) continue
          sent = events.publishHostToOwner('clipboard_change', { contractVersion: 2, type: 'files',
            files: result.files, errors: result.errors, hasData: result.files.length > 0 }, owner).delivered === 1
          if (sent) delivered++
        } finally {
          if (!sent) {
            const cleanup = await Promise.allSettled(result.files.map(file => this.grants.revoke(owner.webContentsId, file.grantId)))
            if (cleanup.some(item => item.status === 'rejected')) throw failed()
          }
        }
      }
      return { delivered }
    } catch (error) { throw error instanceof ZToolsError ? error : failed() }
    finally { this.#publishing = false }
  }

  async read(caller: CallerIdentity, signal: AbortSignal): Promise<{
    success: true
    files: readonly ClipboardRef[]
    errors: readonly { index: number; code: string; message: string }[]
  }> {
    if (!['main', 'plugin'].includes(caller.type) || !Number.isSafeInteger(caller.webContentsId) || caller.webContentsId <= 0 || signal.aborted || this.#requests >= 8) throw failed()
    this.#requests++
    const acquired = new Set<string>()
    try {
      const captured = await this.clipboard.readFiles(signal)
      if (signal.aborted) throw failed()
      if (!Array.isArray(captured)) throw failed()
      const selected = [...captured]
      if (!Array.isArray(selected) || selected.length > 256 || selected.some(item => typeof item !== 'string' ||
          !path.isAbsolute(item) || item.includes('\0') || Buffer.byteLength(item) > 4096) ||
          selected.reduce((bytes, item) => bytes + Buffer.byteLength(item), 0) > 128 * 1024) throw failed()
      const files: ClipboardRef[] = [], errors: { index: number; code: string; message: string }[] = [], seen = new Set<string>()
      for (let index = 0; index < selected.length; index++) {
        let current: string | undefined
        try {
          if (signal.aborted) throw failed()
          const nativeSelection = selected[index]!
          if (seen.has(nativeSelection)) continue
          const grant = await this.grants.createSelected(caller.webContentsId, nativeSelection, signal)
          current = grant.grantId; acquired.add(current)
          if (signal.aborted || !/^[A-Za-z0-9_-]{43}$/.test(current) || !['file', 'directory'].includes(grant.kind)) throw failed()
          files.push(Object.freeze({ grantId: current, displayName: grant.displayName, kind: grant.kind,
            operations: Object.freeze(grant.kind === 'directory' ? ['read', 'list'] as const : ['read'] as const),
            ...(grant.kind === 'file' ? { fileUrl: this.grants.resourceUrl(caller.webContentsId, current) } : {}) }))
          seen.add(nativeSelection)
        } catch (error) {
          if (current) {
            try { await this.grants.revoke(caller.webContentsId, current); acquired.delete(current) }
            catch { throw failed() }
          }
          if (signal.aborted) throw failed()
          errors.push({ index, ...toPublicError(error instanceof ZToolsError ? error : failed()) })
        }
      }
      if (signal.aborted) throw failed()
      return { success: true, files: Object.freeze(files), errors: Object.freeze(errors) }
    } catch (error) {
      const cleanup = await Promise.allSettled([...acquired].map(id => this.grants.revoke(caller.webContentsId, id)))
      if (cleanup.some(result => result.status === 'rejected')) throw failed()
      throw error instanceof ZToolsError ? error : failed()
    } finally { this.#requests-- }
  }
}
