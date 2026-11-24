import { ZipFile } from 'yazl'
import type { Readable } from 'node:stream'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { grantId, parseReferenceDirectory } from '../../contracts/path-reference.js'
import type { PathGrantService } from './path-grant-service.js'
const limit = 16 * 1024 * 1024
const cancelled = () => new ZToolsError(errorCodes.callerDestroyed, 'ZIP compression cancelled')
const invalid = () => new ZToolsError(errorCodes.invalidRequest, 'Invalid ZIP compression parameters')
/** read -> encode/drain -> confirmed SaveRef commit; cancellation never replays writes. */
export class ReferenceZipCompressionService {
  readonly #pending = new Map<number, AbortController>()
  #stopped = false
  constructor(private readonly grants: Pick<PathGrantService, 'read' | 'save' | 'reference' | 'list' | 'deriveRead' | 'revoke'>) {}
  stop() { this.#stopped = true; for (const controller of this.#pending.values()) controller.abort() }
  async compress(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !['fileGrantIds', 'saveGrantId', 'level', 'replace', 'storePaths'].includes(key))) throw invalid()
    const params = value as Record<string, unknown>, level = params.level ?? 6
    if ((params.storePaths !== undefined && typeof params.storePaths !== 'boolean') || !Array.isArray(params.fileGrantIds) || !params.fileGrantIds.length || params.fileGrantIds.length > 64 || !Number.isInteger(level) || Number(level) < 0 || Number(level) > 9 || (params.replace !== undefined && typeof params.replace !== 'boolean')) throw invalid()
    const inputs = params.fileGrantIds.map(grantId), output = grantId(params.saveGrantId)
    if (this.#stopped || signal.aborted) throw cancelled()
    if (this.#pending.has(caller.webContentsId) || this.#pending.size >= 2) throw new ZToolsError(errorCodes.fileTooLarge, 'ZIP compression is already in progress')
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
    const active = () => { if (this.#stopped || combined.aborted) throw cancelled() }
    this.#pending.set(caller.webContentsId, controller)
    try {
      const files: { name: string; bytes: Buffer; directory: boolean }[] = [], names = new Set<string>(); let size = 0
      const register = (name: string, directory: boolean, bytes: Buffer) => {
        const plain = name.replace(/\/$/, '')
        parseReferenceDirectory({ directoryGrantId: output, relativePath: plain })
        const key = plain.normalize('NFC').toLowerCase()
        if (names.has(key) || files.length >= 1024 || Buffer.byteLength(name, 'utf8') > 4096) throw invalid()
        names.add(key); size += bytes.length
        if (size > limit) throw new ZToolsError(errorCodes.fileTooLarge, 'Total ZIP source files exceed 16 MiB')
        files.push({ name, bytes, directory })
      }
      const leaf = (name: string) => { if (!name || /[\/\\\0]/.test(name) || /^[A-Za-z]:/.test(name) || ['.', '..'].includes(name) || Buffer.byteLength(name, 'utf8') > 1024) throw invalid() }
      for (const input of inputs) {
        active()
        const ref = this.grants.reference(caller.webContentsId, input), name = ref.displayName
        leaf(name)
        if (!ref.operations.includes('read')) throw new ZToolsError(errorCodes.permissionDenied, 'ZIP source must be a readable reference')
        if (ref.kind === 'file') {
          const bytes = await this.grants.read(caller.webContentsId, input, '', limit, combined); active()
          register(name, false, bytes)
        } else if (ref.kind === 'directory' && ref.operations.includes('list')) {
          if (params.storePaths === false) throw new ZToolsError(errorCodes.notSupported, 'Directory compression requires preserving relative paths')
          register(name + '/', true, Buffer.alloc(0))
          const pending = [{ relative: '', prefix: name, depth: 0 }]
          while (pending.length) {
            active(); const folder = pending.pop()!
            const children = await this.grants.list(caller.webContentsId, input, folder.relative, combined); active()
            if (children.length + files.length > 1024) throw new ZToolsError(errorCodes.fileTooLarge, 'ZIP entry count exceeds 1024')
            for (const child of children) {
              active(); leaf(child.name)
              if (typeof child.isDirectory !== 'boolean' || !Number.isSafeInteger(child.size) || child.size < 0 || child.size > limit) throw invalid()
              const relative = folder.relative ? folder.relative + '/' + child.name : child.name, archiveName = folder.prefix + '/' + child.name
              if (child.isDirectory) {
                if (folder.depth >= 32) throw new ZToolsError(errorCodes.fileTooLarge, 'ZIP directory depth exceeds 32')
                register(archiveName + '/', true, Buffer.alloc(0)); pending.push({ relative, prefix: archiveName, depth: folder.depth + 1 })
              } else {
                const file = await this.grants.deriveRead(caller.webContentsId, input, relative, combined)
                try {
                  const bytes = await this.grants.read(caller.webContentsId, file.grantId, '', limit, combined); active()
                  if (bytes.length !== child.size) throw new ZToolsError(errorCodes.fileError, 'File size changed during compression')
                  register(archiveName, false, bytes)
                } finally { await this.grants.revoke(caller.webContentsId, file.grantId) }
              }
            }
          }
        } else throw new ZToolsError(errorCodes.permissionDenied, 'ZIP source must be a file or listable directory reference')
      }
      const zip = new ZipFile(), stream = zip.outputStream as Readable
      zip.on('error', error => stream.destroy(error))
      const chunks: Buffer[] = []; let encodedSize = 0, tooLarge = false
      for (const file of files) {
        if (file.directory) zip.addEmptyDirectory(file.name)
        else zip.addBuffer(file.bytes, file.name, { compressionLevel: Number(level) })
      }
      zip.end()
      // yazl has no encoder cancellation API. Drain its bounded in-memory work before releasing ownership;
      // after cancellation discard chunks and never begin the external commit.
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        encodedSize += bytes.length
        if (encodedSize > limit) tooLarge = true
        if (!combined.aborted && !tooLarge) chunks.push(bytes)
        else chunks.length = 0
      }
      active()
      if (tooLarge) throw new ZToolsError(errorCodes.fileTooLarge, 'ZIP output exceeds 16 MiB')
      const encoded = Buffer.concat(chunks, encodedSize)
      const receipt = await this.grants.save(caller.webContentsId, output, encoded, params.replace === true, combined)
      if (receipt.status !== 'committed' || receipt.bytesWritten !== encoded.length || combined.aborted) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, 'ZIP save outcome could not be confirmed; check the target file')
      return { success: true as const, status: 'committed' as const, size: encodedSize, fileCount: files.filter(file => !file.directory).length, sourceCount: inputs.length }
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      if (combined.aborted) throw cancelled()
      throw new ZToolsError(errorCodes.fileError, 'ZIP compression failed')
    } finally { this.#pending.delete(caller.webContentsId) }
  }
}
