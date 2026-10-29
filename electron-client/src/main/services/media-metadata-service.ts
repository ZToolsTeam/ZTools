import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { validateMediaMetadataParams } from '../../contracts/media-metadata.js'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { FileSystemService } from './file-system-service.js'
import { cleanMediaCopy, outputMatchesType, readMediaTags, summarizeMedia } from './media-metadata-engine.js'

/** 单任务按窗口与插件归属取消；原文件只读，ExifTool 仅接触私有临时副本。 */
export class MediaMetadataService {
  #job: { caller: CallerIdentity; id: string; controller: AbortController } | undefined
  #stopped = false
  constructor(private readonly files: Pick<FileSystemService, 'readFile' | 'writeFile'>) {}
  stop() { this.#stopped = true; this.#job?.controller.abort() }
  cancel(id: string, caller: CallerIdentity) {
    const own = this.#job?.id === id && this.#job.caller.webContentsId === caller.webContentsId && this.#job.caller.pluginId === caller.pluginId
    if (own) this.#job!.controller.abort()
    return { success: true, cancelRequested: own }
  }
  async execute(value: unknown, caller: CallerIdentity, signal: AbortSignal) {
    validateMediaMetadataParams(value)
    if (this.#stopped || this.#job) throw new ZToolsError(errorCodes.invalidRequest, '媒体处理暂不可用，请稍后重试')
    const p = value, controller = new AbortController()
    signal = AbortSignal.any([signal, controller.signal]); signal.throwIfAborted()
    this.#job = { caller, id: p.operationId, controller }
    let directory: string | undefined
    try {
      const source = await this.files.readFile({ path: p.path, encoding: 'base64' }, caller)
      signal.throwIfAborted()
      const bytes = Buffer.from(source.content, 'base64'), digest = createHash('sha256').update(bytes).digest('hex')
      if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new Error('单文件最大 16 MiB')
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ztools-media-'))
      await fs.chmod(directory, 0o700)
      // 不使用来源文件名，避免控制字符或后缀影响工具参数；格式由内容识别。
      const temporary = path.join(directory, 'media.bin')
      await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
      const tags = await readMediaTags(temporary, signal), summary = { ...summarizeMedia(tags), digest, size: bytes.length, name: path.basename(p.path) }
      if (p.action === 'inspect') return { success: true, summary }
      if (p.digest !== digest) throw new Error('原文件已变化，请重新选择后再处理')
      if (path.resolve(p.path) === path.resolve(p.outputPath!)) throw new Error('必须另存新副本，不能覆盖原文件')
      if (!outputMatchesType(p.outputPath!, summary.type)) throw new Error('请使用与原照片一致的扩展名')
      const cleaned = await cleanMediaCopy(temporary, p.mode!, tags, signal)
      signal.throwIfAborted()
      const saved = await this.files.writeFile({ path: p.outputPath!, content: cleaned.toString('base64'), encoding: 'base64', overwrite: false }, caller, signal, { replaceConfirmed: true, protectedPath: p.path })
      if (saved.success !== true || saved.size !== cleaned.length) throw new ZToolsError(errorCodes.fileWriteOutcomeUnknown, '副本保存结果未确认，请检查目标文件')
      return { success: true, status: 'committed', name: path.basename(p.outputPath!), size: cleaned.length }
    } catch (failure) {
      if (failure instanceof ZToolsError) throw failure
      throw new ZToolsError(errorCodes.fileError, signal.aborted ? '媒体处理已取消' : failure instanceof Error ? failure.message : '媒体处理失败')
    } finally {
      try { if (directory) await fs.rm(directory, { force: true, recursive: true }) } finally { this.#job = undefined }
    }
  }
}
