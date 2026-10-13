import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { parseReferenceRead, parseReferenceRange, parseReferenceWrite, parseReferenceCopy, parseReferenceDirectory, parseReferenceRemove, parseReferenceMove, grantId, type ReferenceWriteReceipt, type ReferenceWriteIssue } from '../../contracts/path-reference.js'
import { parseReferenceFind } from '../../contracts/path-find.js'
import { referenceNameMatcher } from './reference-name-matcher.js'
import { setImmediate } from 'node:timers/promises'
import { PathGrantService } from './path-grant-service.js'

/** Reference-contract facade, enabled only when all production consumers switch together. */
export class AnchoredFileSystemService {
  constructor(private readonly grants: PathGrantService) {}
  async readFile(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const params = parseReferenceRead(value)
    const bytes = await this.grants.read(caller.webContentsId, params.grantId, params.relativePath, 16 * 1024 * 1024, signal)
    let content: string
    try { content = params.encoding === 'base64' ? bytes.toString('base64') : new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { throw new ZToolsError(errorCodes.fileError, '文件不是有效UTF-8文本；请使用二进制读取') }
    return { success: true as const, content, size: bytes.length }
  }
  async writeFile(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const params = parseReferenceWrite(value)
    const bytes = Buffer.from(params.content, params.encoding === 'base64' ? 'base64' : 'utf8')
    if (params.encoding === 'base64' && bytes.toString('base64') !== params.content) throw new ZToolsError(errorCodes.invalidRequest, '文件二进制内容必须为规范base64')
    if (bytes.length > 16 * 1024 * 1024) throw new ZToolsError(errorCodes.fileTooLarge, '文件超过16MiB IPC上限')
    try {
      const result = await this.grants.saveWithReference(caller.webContentsId, params.saveGrantId, bytes, params.replace, signal)
      if (result.referenceState === 'unavailable') {
        return { success: true, status: 'committed-reference-unavailable', size: result.bytesWritten,
          issues: result.issues } satisfies ReferenceWriteReceipt
      }
      try {
        const fileUrl = this.grants.resourceUrl(caller.webContentsId, result.reference.grantId)
        return { success: true, status: 'committed', size: result.bytesWritten,
          reference: { ...result.reference, fileUrl } } satisfies ReferenceWriteReceipt
      } catch (error) {
        const issues: ReferenceWriteIssue[] = [{ stage: 'reference', code: error instanceof ZToolsError && error.code === errorCodes.permissionDenied
          ? errorCodes.permissionDenied : errorCodes.fileError }]
        try { await this.grants.revoke(caller.webContentsId, result.reference.grantId) }
        catch { issues.push({ stage: 'release', code: errorCodes.fileError }) }
        return { success: true, status: 'committed-reference-unavailable', size: result.bytesWritten,
          issues: Object.freeze(issues.map(issue => Object.freeze(issue))) } satisfies ReferenceWriteReceipt
      }
    } catch (error) {
      if (error instanceof ZToolsError && error.code === errorCodes.fileWriteOutcomeUnknown) {
        return { success: false, status: 'result-unknown', code: errorCodes.fileWriteOutcomeUnknown } satisfies ReferenceWriteReceipt
      }
      throw error
    }
  }
  async readFileRange(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const params = parseReferenceRange(value)
    const bytes = await this.grants.readRange(caller.webContentsId, params.grantId, params.relativePath, params.offset, params.length, signal)
    // A range may cut through a UTF-8 sequence; transport bytes without lossy text decoding.
    return { success: true as const, content: bytes.toString('base64'), encoding: 'base64' as const, offset: params.offset, size: bytes.length }
  }
  async copyFile(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const params = parseReferenceCopy(value)
    const result = await this.grants.copy(caller.webContentsId, params.fileGrantId, params.saveGrantId, params.replace, signal)
    return { success: true as const, size: result.bytesWritten }
  }
  async getDirectoryContents(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const params = parseReferenceDirectory(value, true)
    return { success: true as const, files: await this.grants.list(caller.webContentsId, params.directoryGrantId, params.relativePath, signal) }
  }
  async find(value: unknown, caller: CallerIdentity, directories: boolean, signal?: AbortSignal) {
    const params = parseReferenceFind(value)
    if (signal?.aborted) throw new ZToolsError(errorCodes.callerDestroyed, '目录查找已取消')
    const files = await this.grants.list(caller.webContentsId, params.directoryGrantId, params.relativePath, signal)
    const matches = referenceNameMatcher(params.pattern, params.caseSensitive), result = []
    for (let index = 0; index < files.length; index++) {
      if (index % 64 === 0) await setImmediate()
      if (signal?.aborted) throw new ZToolsError(errorCodes.callerDestroyed, '目录查找已取消')
      const file = files[index]!
      if (file.isDirectory === directories && matches(file.name)) result.push(file)
    }
    // Revalidate owner/TTL after yielding; metadata is a snapshot, never permission to reopen a raw path.
    this.grants.reference(caller.webContentsId, params.directoryGrantId)
    return { success: true as const, files: result }
  }
  async createDirectory(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const params = parseReferenceDirectory(value)
    return { success: true as const, ...(await this.grants.createDirectory(caller.webContentsId, params.directoryGrantId, params.relativePath, signal)) }
  }
  async remove(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const params = parseReferenceRemove(value)
    await this.grants.remove(caller.webContentsId, params.directoryGrantId, params.relativePath, params.isDirectory, signal)
    return { success: true as const }
  }
  async moveFile(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const params = parseReferenceMove(value)
    await this.grants.move(caller.webContentsId, params.directoryGrantId, params.relativePath, params.saveGrantId, params.replace, signal)
    return { success: true as const }
  }
  async deriveRead(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const params = parseReferenceDirectory(value)
    return this.grants.deriveRead(caller.webContentsId, params.directoryGrantId, params.relativePath, signal)
  }
  async deriveSave(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const params = parseReferenceDirectory(value)
    return this.grants.deriveSave(caller.webContentsId, params.directoryGrantId, params.relativePath, signal)
  }
  async deriveDirectory(value: unknown, caller: CallerIdentity, signal?: AbortSignal) {
    const params = parseReferenceDirectory(value)
    return this.grants.deriveDirectory(caller.webContentsId, params.directoryGrantId, params.relativePath, signal)
  }
  async describe(id: unknown, caller: CallerIdentity, signal?: AbortSignal) { return this.grants.describe(caller.webContentsId, grantId(id), signal) }
  async revoke(id: unknown, caller: CallerIdentity) { await this.grants.revoke(caller.webContentsId, grantId(id)); return { success: true as const } }
  resourceUrl(id: unknown, caller: CallerIdentity) { return this.grants.resourceUrl(caller.webContentsId, grantId(id)) }
}
