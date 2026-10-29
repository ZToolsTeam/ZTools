import { validateOfficeParams } from '../../contracts/office-document.js'
import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { FileSystemService } from './file-system-service.js'
import { readZipArchive } from './reference-zip-service.js'
import { cleanOfficeMetadata, encodeVerifiedOfficeArchive, inspectOffice, officeImages } from './office-archive.js'

const ownerKey = (caller: CallerIdentity) => `${caller.webContentsId}:${caller.pluginId ?? ''}`
/** 处理只使用已经由原生对话框授权的文件；不执行 DLL，也不接受任意路径写入。 */
export class OfficeDocumentService {
  readonly #pending = new Map<string, { id: string; controller: AbortController }>()
  #stopped = false
  constructor(private readonly files: Pick<FileSystemService, 'readFile' | 'writeFile'>) {}
  stop() { this.#stopped = true; for (const { controller } of this.#pending.values()) controller.abort() }
  cancel(operationId: string, caller: CallerIdentity) {
    const pending = this.#pending.get(ownerKey(caller))
    if (pending?.id === operationId) pending.controller.abort()
    return { success: true, cancelRequested: pending?.id === operationId }
  }
  async execute(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    validateOfficeParams(value)
    const p = value, key = ownerKey(caller)
    if (this.#pending.has(key) || this.#pending.size >= 2) throw new ZToolsError(errorCodes.invalidRequest, '文档正在处理中')
    const controller = new AbortController()
    signal = AbortSignal.any([signal, controller.signal])
    const active = () => { signal.throwIfAborted(); if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '文档处理已停止') }
    active(); this.#pending.set(key, { id: p.operationId, controller })
    try {
      const source = await this.files.readFile({ path: p.path, encoding: 'base64' }, caller)
      active()
      const archive = await readZipArchive(Buffer.from(source.content, 'base64'), signal)
      active()
      const summary = { ...inspectOffice(archive.entries), size: archive.size, digest: archive.digest, name: path.basename(p.path) }
      if (p.action === 'inspect') return { success: true as const, summary }
      if (archive.digest !== p.digest) throw new ZToolsError(errorCodes.fileError, '源文档已变化，请重新选择后再处理')
      const output = p.outputPath!
      if (path.resolve(output) === path.resolve(p.path)) throw new ZToolsError(errorCodes.invalidRequest, '请另存新副本，不能覆盖原文件')
      if (!output.toLowerCase().endsWith(p.action === 'extract' ? '.zip' : '.' + summary.type)) throw new ZToolsError(errorCodes.invalidRequest, '请另存为相同 Office 格式，导出原图请使用 .zip')
      const entries = p.action === 'extract' ? officeImages(archive.entries) : p.cleanMetadata === true ? cleanOfficeMetadata(archive.entries) : archive.entries
      const bytes = await encodeVerifiedOfficeArchive(entries, signal)
      active()
      const receipt = await this.files.writeFile({ path: output, encoding: 'base64', content: bytes.toString('base64'), overwrite: false }, caller, signal, { replaceConfirmed: true, protectedPath: p.path })
      if (receipt.success !== true || receipt.size !== bytes.length) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '保存结果未确认，请检查新文件')
      return { success: true as const, status: 'committed' as const, name: path.basename(output), size: bytes.length, originalSize: archive.size, imageCount: summary.images.length }
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      if (signal.aborted) throw new ZToolsError(errorCodes.callerDestroyed, '文档处理已取消')
      throw new ZToolsError(errorCodes.fileError, error instanceof Error ? error.message : '文档处理失败')
    } finally { this.#pending.delete(key) }
  }
}
