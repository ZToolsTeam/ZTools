import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { grantId } from '../../contracts/path-reference.js'
import type { VisionBackend } from '../platform/macos/vision-runner.js'
import type { PathGrantService } from './path-grant-service.js'
import { imageHeader } from './reference-image-service.js'
const invalid = () => new ZToolsError(errorCodes.invalidRequest, '本地OCR参数无效')
const cancelled = () => new ZToolsError(errorCodes.callerDestroyed, '本地OCR已取消')
const failed = () => new ZToolsError(errorCodes.fileError, '本地OCR结果无效')
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !keys.includes(key))) throw invalid()
  return value as Record<string, unknown>
}
function languageList(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some(v => typeof v !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(v)) || new Set(value).size !== value.length) throw invalid()
  return value as string[]
}
/** Local only: FileRef bytes enter Vision; no path, cloud/token, persistence or DLL fallback. */
export class ReferenceOcrService {
  #stopped = false
  readonly #pending = new Map<number, { controller: AbortController; finished: Promise<void> }>()
  constructor(private readonly grants: Pick<PathGrantService, 'read'>, private readonly backend: VisionBackend) {}
  stop(): Promise<void> { this.#stopped = true; for (const item of this.#pending.values()) item.controller.abort(); return Promise.all([...this.#pending.values()].map(v => v.finished)).then(() => {}) }
  async languages(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    record(value, [])
    return this.#execute(caller, signal, async combined => {
      const result = record(await this.backend.run({ version: 1, operation: 'languages' }, combined), ['version', 'success', 'provider', 'revision', 'languages'])
      this.#common(result)
      const languages = languageList(result.languages, 256); if (!languages.length) throw failed()
      return { success: true as const, provider: 'apple-vision-local' as const, revision: Number(result.revision), languages }
    })
  }
  async recognize(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    const params = record(value, ['fileGrantId', 'languages']), input = grantId(params.fileGrantId), languages = languageList(params.languages ?? [], 8)
    return this.#execute(caller, signal, async combined => {
      const bytes = await this.grants.read(caller.webContentsId, input, '', 16 * 1024 * 1024, combined)
      if (combined.aborted) throw cancelled()
      const header = imageHeader(bytes)
      const result = record(await this.backend.run({ version: 1, operation: 'recognize', imageBase64: bytes.toString('base64'), languages }, combined), ['version', 'success', 'provider', 'revision', 'width', 'height', 'text', 'lines'])
      this.#common(result)
      if (!Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || !((result.width === header.width && result.height === header.height) || (result.width === header.height && result.height === header.width)) || typeof result.text !== 'string' || Buffer.byteLength(result.text, 'utf8') > 1024 * 1024 || !Array.isArray(result.lines) || result.lines.length > 10000) throw failed()
      let total = 0
      const lines = result.lines.map(value => {
        const line = record(value, ['text', 'confidence', 'box'])
        if (typeof line.text !== 'string' || typeof line.confidence !== 'number' || !Number.isFinite(line.confidence) || line.confidence < 0 || line.confidence > 1 || !Array.isArray(line.box) || line.box.length !== 4 || line.box.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) || line.box[0] + line.box[2] > 1.00001 || line.box[1] + line.box[3] > 1.00001) throw failed()
        total += Buffer.byteLength(line.text, 'utf8') + 1; if (total > 1024 * 1024) throw failed()
        return { text: line.text, confidence: line.confidence, box: line.box as [number, number, number, number] }
      })
      if (lines.map(v => v.text).join('\n') !== result.text) throw failed()
      return { success: true as const, provider: 'apple-vision-local' as const, revision: Number(result.revision), width: Number(result.width), height: Number(result.height), text: result.text, lines }
    })
  }
  #common(result: Record<string, unknown>) { if (result.version !== 1 || result.success !== true || result.provider !== 'apple-vision-local' || !Number.isSafeInteger(result.revision) || Number(result.revision) < 1) throw failed() }
  async #execute<T>(caller: CallerIdentity, signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#stopped || signal.aborted) throw cancelled()
    if (this.#pending.has(caller.webContentsId) || this.#pending.size >= 2) throw new ZToolsError(errorCodes.fileTooLarge, '本地OCR正在处理中')
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal]); let finish!: () => void
    this.#pending.set(caller.webContentsId, { controller, finished: new Promise<void>(resolve => { finish = resolve }) })
    try { const result = await action(combined); if (this.#stopped || combined.aborted) throw cancelled(); return result }
    catch (error) { if (combined.aborted) throw cancelled(); if (error instanceof ZToolsError) throw error; throw failed() }
    finally { this.#pending.delete(caller.webContentsId); finish() }
  }
}
