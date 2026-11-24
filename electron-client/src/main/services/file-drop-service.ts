import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { toLocalizedPublicError } from '../ipc/error-localizer.js'
import { IPC_EVENT_CHANNEL } from '../../contracts/ipc.js'
import type { WindowRegistry } from '../windows/window-registry.js'
import type { ClipboardService } from './clipboard-service.js'
import { fileFailure, type FileSystemService } from './file-system-service.js'

export const FILE_DROP_CHANNEL = 'ztools:native-file-drop'
export const FILE_PASTE_CHANNEL = 'ztools:native-file-paste'
const MAX_FILES = 100
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const PASTE_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000
const PASTE_CACHE_MAX_FILES = 50

interface PublishMetadata {
  source?: 'drop' | 'paste'
  targetFieldId?: string
}

/** Only the isolated preload sends native File paths or paste requests; this is not a public SDK method. */
export class FileDropService {
  constructor(
    private readonly registry: Pick<WindowRegistry, 'get' | 'send'>,
    private readonly files: Pick<FileSystemService, 'grantOpenPath'> & Partial<Pick<FileSystemService, 'writeGeneratedCacheFile'>>,
    private readonly clipboard?: Pick<ClipboardService, 'readPasteSource'>
  ) {}

  async accept(webContentsId: number, value: unknown): Promise<{ success: true; accepted: number; rejected: number }> {
    const caller = this.requireCaller(webContentsId)
    let rawPaths: unknown = value
    let allowDirectories = false
    let targetFieldId: string | undefined

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      if (typeof record.targetFieldId === 'string' && record.targetFieldId.length > 0 && record.targetFieldId.length <= 128) {
        targetFieldId = record.targetFieldId
      }
      if (record.allowDirectories === true) {
        allowDirectories = true
      }
      if ('overflowCount' in record) {
        const count = record.overflowCount
        if (!Number.isSafeInteger(count) || Number(count) <= MAX_FILES || Number(count) > 1_000_000) {
          throw new ZToolsError(errorCodes.invalidRequest, 'Invalid dropped file count')
        }
        return this.publish(
          caller,
          [],
          [{ index: -1, code: errorCodes.fileTooLarge, message: 'At most 100 files can be dropped at once' }],
          Number(count),
          targetFieldId ? { targetFieldId } : undefined
        )
      }
      if ('paths' in record) {
        rawPaths = record.paths
      }
    }

    if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > MAX_FILES) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Dropped file count must be between 1 and 100')
    }
    return this.authorizeAndPublish(
      webContentsId,
      caller,
      rawPaths,
      allowDirectories,
      targetFieldId ? { targetFieldId } : undefined
    )
  }

  async acceptPaste(
    webContentsId: number,
    value: unknown
  ): Promise<{ success: true; accepted: number; rejected: number; ignored?: boolean }> {
    const caller = this.requireCaller(webContentsId)
    if (!this.clipboard) {
      return { success: true, accepted: 0, rejected: 0, ignored: true }
    }
    const record = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
    const allowImage = record.allowImage === true
    const allowDirectories = record.allowDirectories === true
    const targetFieldId = typeof record.targetFieldId === 'string' &&
      record.targetFieldId.length > 0 &&
      record.targetFieldId.length <= 128
      ? record.targetFieldId
      : undefined

    const source = await this.clipboard.readPasteSource({ allowImage })
    this.requireCaller(webContentsId, caller)

    if (source.kind === 'files') {
      const capped = source.files.slice(0, MAX_FILES)
      return this.authorizeAndPublish(webContentsId, caller, capped, allowDirectories, {
        source: 'paste',
        ...(targetFieldId ? { targetFieldId } : {})
      })
    }

    if (source.kind === 'image') {
      if (typeof this.files.writeGeneratedCacheFile !== 'function') {
        throw new ZToolsError(errorCodes.notSupported, 'Writing clipboard image cache is not supported in this environment')
      }
      const generated = await this.files.writeGeneratedCacheFile(
        `clipboard/paste_${randomUUID()}.png`,
        source.png,
        caller
      )
      this.requireCaller(webContentsId, caller)
      // 显式将截图缓存文件加入窗口 #grants 表，确保弹出独立窗口时可通过 transferGrants 转交读取权限
      await this.files.grantOpenPath(generated.path, caller)
      this.requireCaller(webContentsId, caller)
      void this.pruneOldPasteImages(path.dirname(generated.path)).catch(() => undefined)
      return this.publish(caller, [generated.path], [], 0, {
        source: 'paste',
        ...(targetFieldId ? { targetFieldId } : {})
      })
    }

    return { success: true, accepted: 0, rejected: 0, ignored: true }
  }

  private async authorizeAndPublish(
    webContentsId: number,
    caller: CallerIdentity,
    candidates: unknown[],
    allowDirectories: boolean,
    meta?: PublishMetadata
  ): Promise<{ success: true; accepted: number; rejected: number }> {
    const accepted: string[] = []
    // 已确认是文件夹的路径（accepted 的子集），随事件下发，渲染层据此判断而不是按名称后缀猜测
    const directories: string[] = []
    const errors: Array<{ index: number; code: string; message: string }> = []
    const seen = new Set<string>()
    let totalBytes = 0
    for (let index = 0; index < candidates.length; index += 1) {
      try {
        const candidate: unknown = candidates[index]
        if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 4096 || /[\u0000\r\n"]/.test(candidate) || !path.isAbsolute(candidate)) {
          throw new ZToolsError(errorCodes.invalidRequest, 'Invalid dropped file path')
        }
        const target = path.resolve(candidate)
        // Reject a symlink/junction at any component rather than silently granting its destination.
        let cursor = target
        while (true) {
          const stats = await fs.lstat(cursor)
          if (stats.isSymbolicLink()) throw new ZToolsError(errorCodes.permissionDenied, 'Dropped path contains a symbolic link or reparse point')
          const parent = path.dirname(cursor)
          if (parent === cursor) break
          cursor = parent
        }
        const real = await fs.realpath(target)
        if (seen.has(real)) continue
        const stats = await fs.stat(real)
        const isAllowedType = stats.isFile() || (allowDirectories && stats.isDirectory())
        if (!isAllowedType) {
          throw new ZToolsError(
            errorCodes.invalidRequest,
            allowDirectories ? 'Dropped target must be a regular file or directory' : 'Dropped target must be a regular file'
          )
        }
        if (stats.isFile() && (!Number.isSafeInteger(stats.size) || stats.size > MAX_FILE_BYTES || totalBytes + stats.size > MAX_TOTAL_BYTES)) {
          throw new ZToolsError(errorCodes.fileTooLarge, 'Dropped file exceeds size limit')
        }
        this.requireCaller(webContentsId, caller)
        await this.files.grantOpenPath(real, caller)
        this.requireCaller(webContentsId, caller)
        seen.add(real)
        if (stats.isFile()) totalBytes += stats.size
        else directories.push(real)
        accepted.push(real)
      } catch (error) {
        const publicError = toLocalizedPublicError(fileFailure(error))
        errors.push({ index, ...publicError })
      }
    }
    this.requireCaller(webContentsId, caller)
    return this.publish(caller, accepted, errors, errors.length, meta, directories)
  }

  private async pruneOldPasteImages(clipboardDir: string): Promise<void> {
    const entries = await fs.readdir(clipboardDir).catch(() => [] as string[])
    const pasteFiles = entries.filter((name) => /^paste_[0-9a-f-]+\.png$/i.test(name))
    if (pasteFiles.length === 0) return
    const now = Date.now()
    const statsList: Array<{ fullPath: string; mtimeMs: number }> = []
    for (const name of pasteFiles) {
      const fullPath = path.join(clipboardDir, name)
      try {
        const st = await fs.lstat(fullPath)
        if (!st.isFile() || st.isSymbolicLink()) continue
        if (now - st.mtimeMs > PASTE_CACHE_RETENTION_MS) {
          await fs.unlink(fullPath).catch(() => undefined)
        } else {
          statsList.push({ fullPath, mtimeMs: st.mtimeMs })
        }
      } catch {
        // Ignore concurrent removals.
      }
    }
    if (statsList.length > PASTE_CACHE_MAX_FILES) {
      statsList.sort((a, b) => b.mtimeMs - a.mtimeMs)
      for (const stale of statsList.slice(PASTE_CACHE_MAX_FILES)) {
        await fs.unlink(stale.fullPath).catch(() => undefined)
      }
    }
  }

  private publish(
    caller: CallerIdentity,
    accepted: string[],
    errors: Array<{ index: number; code: string; message: string }>,
    rejectedCount: number,
    meta?: PublishMetadata,
    directories: string[] = []
  ): { success: true; accepted: number; rejected: number } {
    this.registry.send(caller.webContentsId, IPC_EVENT_CHANNEL, {
      msgType: 'event_envelope',
      msgData: {
        envelope: {
          envelopeId: `host_${randomUUID()}`, version: 'v1', timestamp: Date.now(),
          type: 'plugin_files_dropped', scope: 'plugin', source: { kind: 'host' },
          target: caller.pluginId ? { pluginId: caller.pluginId } : { window: 'main' },
          payload: {
            files: accepted,
            ...(directories.length > 0 ? { directories } : {}),
            errors,
            ...(meta?.source ? { source: meta.source } : {}),
            ...(meta?.targetFieldId ? { targetFieldId: meta.targetFieldId } : {})
          }
        }
      }
    })
    return { success: true, accepted: accepted.length, rejected: rejectedCount }
  }

  private requireCaller(webContentsId: number, expected?: CallerIdentity): CallerIdentity {
    const caller = this.registry.get(webContentsId)
    const isPluginCaller = Boolean(caller && caller.type === 'plugin' && caller.pluginId)
    const isMainCaller = Boolean(caller && caller.type === 'main')
    const matchesExpected = !expected || (
      caller?.type === expected.type &&
      caller?.pluginId === expected.pluginId &&
      caller?.pluginInstanceId === expected.pluginInstanceId
    )
    if (!caller || (!isPluginCaller && !isMainCaller) || !matchesExpected) {
      throw new ZToolsError(errorCodes.permissionDenied, 'File drop caller is not a currently registered plugin window')
    }
    return caller
  }
}
