import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { grantId } from '../../contracts/path-reference.js'
import type { PathGrantService } from './path-grant-service.js'
import { imageHeader, type ReferenceImageFactory } from './reference-image-service.js'
export interface ReferencePdfRenderer { render(html: string, signal: AbortSignal): Promise<Buffer>; stop(): void }
const invalid = () => new ZToolsError(errorCodes.invalidRequest, '图片转PDF参数无效')
const cancelled = () => new ZToolsError(errorCodes.callerDestroyed, '图片转PDF已取消')
/** idle -> read -> render -> commit -> release; cancel/stop always releases its renderer before returning. */
export class ReferencePdfService {
  readonly #pending = new Map<number, AbortController>()
  #stopped = false
  constructor(private readonly grants: Pick<PathGrantService, 'read' | 'save'>, private readonly images: { createFromBuffer(bytes: Buffer): Pick<ReturnType<ReferenceImageFactory['createFromBuffer']>, 'isEmpty' | 'getSize'> },
    private readonly renderer: ReferencePdfRenderer) {}
  stop(): void { this.#stopped = true; for (const pending of this.#pending.values()) pending.abort(); this.renderer.stop() }
  async convert(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
        Object.keys(value).some(key => !['fileGrantIds', 'saveGrantId', 'replace'].includes(key))) throw invalid()
    const params = value as Record<string, unknown>
    if (!Array.isArray(params.fileGrantIds) || !params.fileGrantIds.length || params.fileGrantIds.length > 64 ||
        (params.replace !== undefined && typeof params.replace !== 'boolean')) throw invalid()
    const inputs = params.fileGrantIds.map(grantId), output = grantId(params.saveGrantId)
    if (this.#stopped || signal.aborted) throw cancelled()
    if (this.#pending.has(caller.webContentsId) || this.#pending.size >= 2) throw new ZToolsError(errorCodes.fileTooLarge, '图片转PDF正在处理中')
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
    const active = () => { if (this.#stopped || combined.aborted) throw cancelled() }
    this.#pending.set(caller.webContentsId, controller)
    try {
      const pages: string[] = [], rules: string[] = []; let total = 0, pixels = 0
      for (const [index, input] of inputs.entries()) {
        active()
        const bytes = await this.grants.read(caller.webContentsId, input, '', 16 * 1024 * 1024, combined); active()
        total += bytes.length
        if (total > 32 * 1024 * 1024) throw new ZToolsError(errorCodes.fileTooLarge, 'PDF源图片合计超过32MiB')
        const header = imageHeader(bytes); pixels += header.width * header.height
        if (pixels > 32 * 1024 * 1024) throw new ZToolsError(errorCodes.fileTooLarge, 'PDF源图片合计超过32Mi像素')
        const decoded = this.images.createFromBuffer(bytes)
        if (decoded.isEmpty() || decoded.getSize().width !== header.width || decoded.getSize().height !== header.height) throw new ZToolsError(errorCodes.fileError, 'PDF源图片无法解码')
        rules.push(`@page p${index}{size:${header.width}px ${header.height}px;margin:0}`)
        pages.push(`<section style="page:p${index};width:${header.width}px;height:${header.height}px"><img width="${header.width}" height="${header.height}" src="data:image/${header.format === 'png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}"></section>`)
      }
      active()
      const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0}section{break-after:page;overflow:hidden}section:last-child{break-after:auto}img{display:block}' + rules.join('') + '</style></head><body>' + pages.join('') + '</body></html>'
      const bytes = await this.renderer.render(html, combined); active()
      if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024 || bytes.length < 8 || bytes.toString('ascii', 0, 5) !== '%PDF-') throw new ZToolsError(errorCodes.fileError, 'PDF生成结果无效或超过16MiB')
      const receipt = await this.grants.save(caller.webContentsId, output, bytes, params.replace === true, combined)
      if (receipt.status !== 'committed' || combined.aborted || this.#stopped) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, 'PDF保存结果未确认')
      return { success: true as const, status: 'committed' as const, size: receipt.bytesWritten, pageCount: inputs.length }
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      if (combined.aborted || this.#stopped) throw cancelled()
      throw new ZToolsError(errorCodes.fileError, '图片转PDF失败')
    } finally { this.#pending.delete(caller.webContentsId) }
  }
}
