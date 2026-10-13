import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, toPublicError, ZToolsError } from '../../contracts/errors.js'
import { grantId, parseReferenceDirectory } from '../../contracts/path-reference.js'
import type { PathGrantService } from './path-grant-service.js'
import type { ReferenceZipService } from './reference-zip-service.js'
const invalid = () => new ZToolsError(errorCodes.invalidRequest, 'ZIP解压参数或输出名称冲突')
const cancelled = () => new ZToolsError(errorCodes.callerDestroyed, 'ZIP解压已取消')
/** CRC-verified in-memory preparation precedes all directory/file writes. No overwrite or rollback. */
export class ReferenceZipExtractionService {
  readonly #pending = new Map<number, AbortController>()
  #stopped = false
  constructor(private readonly reader: ReferenceZipService, private readonly grants: Pick<PathGrantService, 'reference' | 'createDirectory' | 'deriveSave' | 'save' | 'revoke'>) {}
  stop() { this.#stopped = true; for (const controller of this.#pending.values()) controller.abort() }
  async extract(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !['fileGrantId', 'directoryGrantId'].includes(key))) throw invalid()
    const params = value as Record<string, unknown>, fileId = grantId(params.fileGrantId), directoryId = grantId(params.directoryGrantId)
    if (this.#stopped || signal.aborted) throw cancelled()
    if (this.#pending.has(caller.webContentsId) || this.#pending.size >= 2) throw new ZToolsError(errorCodes.fileTooLarge, 'ZIP解压正在处理中')
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]), owner = caller.webContentsId
    const active = () => { if (this.#stopped || combined.aborted) throw cancelled() }
    this.#pending.set(owner, controller)
    try {
      const destination = this.grants.reference(owner, directoryId)
      if (destination.kind !== 'directory' || !destination.operations.includes('write')) throw new ZToolsError(errorCodes.permissionDenied, '需要明确授权的可写目录')
      const entries = await this.reader.readEntries({ fileGrantId: fileId }, caller, combined)
      active()
      const directories = new Set<string>(), namespace = new Map<string, { name: string; directory: boolean }>()
      const register = (name: string, directory: boolean) => {
        parseReferenceDirectory({ directoryGrantId: directoryId, relativePath: name })
        const key = name.normalize('NFC').toLowerCase(), prior = namespace.get(key)
        if (prior && (prior.name !== name || prior.directory !== directory || !directory)) throw invalid()
        namespace.set(key, { name, directory }); if (directory) directories.add(name)
        if (namespace.size > 2048 || directories.size > 1024) throw new ZToolsError(errorCodes.fileTooLarge, '解压目录数量超过上限')
      }
      for (const entry of entries) {
        const name = entry.name.replace(/\/$/, ''), parts = name.split('/')
        for (let i = 1; i < parts.length; i++) register(parts.slice(0, i).join('/'), true)
        register(name, entry.isDirectory)
      }
      const completed: string[] = [], createdDirectories: string[] = []
      let writing: string | undefined
      try {
        for (const name of [...directories].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))) {
          active(); writing = name
          const receipt = await this.grants.createDirectory(owner, directoryId, name, combined)
          if (!['created', 'existing'].includes(receipt.status) || combined.aborted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '目录创建结果未确认')
          if (receipt.status === 'created') createdDirectories.push(name)
          writing = undefined
        }
        for (const entry of entries) {
          if (entry.isDirectory) continue
          active()
          const save = await this.grants.deriveSave(owner, directoryId, entry.name, combined)
          try {
            active(); writing = entry.name
            const receipt = await this.grants.save(owner, save.grantId, entry.data, false, combined)
            if (receipt.status !== 'committed' || receipt.bytesWritten !== entry.data.length || combined.aborted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '解压文件保存结果未确认')
            completed.push(entry.name); writing = undefined
          } finally { await this.grants.revoke(owner, save.grantId) }
        }
        active()
        return { success: true as const, status: 'committed' as const, completed, createdDirectories }
      } catch (error) {
        return { success: true as const, status: 'partial' as const, completed, createdDirectories, uncertain: error instanceof ZToolsError && error.code === errorCodes.fileWriteOutcomeUnknown ? writing : undefined, error: toPublicError(error) }
      }
    } finally { this.#pending.delete(owner) }
  }
}
