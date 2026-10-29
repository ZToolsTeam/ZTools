import path from 'node:path'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { MAX_MARKDOWN_BYTES, validateMarkdownParams, validateMarkdownText } from '../../contracts/markdown-document.js'
import type { FileSystemService } from './file-system-service.js'
import type { ClipboardService } from './clipboard-service.js'
import { readZipArchive } from './reference-zip-service.js'
import { inspectOffice } from './office-archive.js'

const ownerKey = (c: CallerIdentity) => JSON.stringify([c.webContentsId, c.pluginId, c.pluginInstanceId, c.attributedPlugin?.sessionId])
export class MarkdownDocumentService {
  #stopped = false
  readonly #pending = new Map<string, { windowId: number; operationId: string; controller: AbortController; done: Promise<void> }>()
  constructor(private readonly files: Pick<FileSystemService, 'resolveAuthorizedPath' | 'writeFile'>, private readonly clipboard: Pick<ClipboardService, 'copyRichText'>) {}
  closeOwner(windowId: number) { for (const p of this.#pending.values()) if (p.windowId === windowId) p.controller.abort() }
  async stop() { this.#stopped = true; const pending = [...this.#pending.values()]; for (const p of pending) p.controller.abort(); await Promise.allSettled(pending.map(p => p.done)) }
  async #read(input: string, caller: CallerIdentity, signal: AbortSignal) {
    const target = await this.files.resolveAuthorizedPath(input, caller, 'read', false)
    signal.throwIfAborted()
    // 打开时阻止 FIFO 等待写端；校验真实句柄，不能只检查可能被替换的路径。
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      signal.throwIfAborted()
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error('只能读取普通 Markdown 文件')
      if (stat.size > MAX_MARKDOWN_BYTES) throw new Error('Markdown 文件超过 256 KiB，请拆分后导入')
      const bytes = Buffer.alloc(MAX_MARKDOWN_BYTES + 1)
      let length = 0
      while (length < bytes.length) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(bytes, length, Math.min(65536, bytes.length - length), length)
        signal.throwIfAborted()
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > MAX_MARKDOWN_BYTES) throw new Error('Markdown 文件超过 256 KiB，请拆分后导入')
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    } finally { await handle.close() }
  }
  async execute(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    validateMarkdownParams(value)
    const p = value, key = ownerKey(caller)
    if (p.action === 'cancel') {
      const pending = this.#pending.get(key), matched = pending?.operationId === p.operationId
      if (matched) { pending.controller.abort(); await pending.done }
      return { success: true as const, cancelRequested: matched }
    }
    if (this.#pending.has(key) || this.#pending.size >= 2) throw new ZToolsError(errorCodes.invalidRequest, '已有文档正在处理，请稍候')
    const controller = new AbortController(), activeSignal = AbortSignal.any([signal, controller.signal])
    const active = () => { activeSignal.throwIfAborted(); if (this.#stopped) throw new ZToolsError(errorCodes.appStopping, '文档服务已停止') }
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    active(); this.#pending.set(key, { windowId: caller.webContentsId, operationId: p.operationId, controller, done })
    try {
      if (p.action === 'read') {
        const markdown = await this.#read(p.path, caller, activeSignal)
        active()
        validateMarkdownText(markdown)
        return { success: true as const, markdown, name: path.basename(p.path) }
      }
      const { renderMarkdown } = await import('./markdown-renderer.js')
      active()
      const rendered = renderMarkdown(p.markdown, p.options)
      active()
      if (p.action === 'inspect') return { success: true as const, summary: rendered.summary }
      if (p.action === 'copy') {
        await this.clipboard.copyRichText({ text: rendered.text, html: rendered.html }, activeSignal)
        return { success: true as const, copied: true as const, summary: rendered.summary }
      }
      const bytes = await rendered.docx()
      active()
      const archive = await readZipArchive(bytes, activeSignal), summary = inspectOffice(archive.entries)
      if (summary.type !== 'docx') throw new Error('生成的文档格式校验失败')
      active()
      const receipt = await this.files.writeFile({ path: p.outputPath!, content: bytes.toString('base64'), encoding: 'base64', overwrite: false }, caller, activeSignal, { replaceConfirmed: true })
      if (receipt.success !== true || receipt.size !== bytes.length) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '保存结果未确认，请检查新文件')
      return { success: true as const, status: 'committed' as const, size: bytes.length, name: path.basename(p.outputPath!), summary: rendered.summary }
    } catch (error) {
      if (error instanceof ZToolsError) throw error
      if (activeSignal.aborted) throw new ZToolsError(errorCodes.callerDestroyed, '文档处理已取消')
      throw new ZToolsError(errorCodes.fileError, error instanceof Error ? error.message : '文档处理失败')
    } finally { this.#pending.delete(key); finish() }
  }
}
