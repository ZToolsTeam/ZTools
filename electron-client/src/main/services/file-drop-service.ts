import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, toPublicError, ZToolsError } from '../../contracts/errors.js'
import { IPC_EVENT_CHANNEL } from '../../contracts/ipc.js'
import type { WindowRegistry } from '../windows/window-registry.js'
import { fileFailure, type FileSystemService } from './file-system-service.js'

export const FILE_DROP_CHANNEL = 'ztools:native-file-drop'
const MAX_FILES = 100
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

/** Only the isolated preload sends native File paths; this is not a public SDK method. */
export class FileDropService {
  constructor(
    private readonly registry: Pick<WindowRegistry, 'get' | 'send'>,
    private readonly files: Pick<FileSystemService, 'grantOpenPath'>
  ) {}

  async accept(webContentsId: number, value: unknown): Promise<{ success: true; accepted: number; rejected: number }> {
    const caller = this.requireCaller(webContentsId)
    if (typeof value === 'object' && value !== null && 'overflowCount' in value) {
      const count = value.overflowCount
      if (!Number.isSafeInteger(count) || Number(count) <= MAX_FILES || Number(count) > 1_000_000) {
        throw new ZToolsError(errorCodes.invalidRequest, '拖放文件数量无效')
      }
      return this.publish(caller, [], [{ index: -1, code: errorCodes.fileTooLarge, message: '一次最多拖入100个文件' }], Number(count))
    }
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FILES) {
      throw new ZToolsError(errorCodes.invalidRequest, '拖放文件数量须为1..100')
    }
    const accepted: string[] = []
    const errors: Array<{ index: number; code: string; message: string }> = []
    const seen = new Set<string>()
    let totalBytes = 0
    for (let index = 0; index < value.length; index += 1) {
      try {
        const candidate: unknown = value[index]
        if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 4096 || /[\u0000\r\n"]/.test(candidate) || !path.isAbsolute(candidate)) {
          throw new ZToolsError(errorCodes.invalidRequest, '拖放路径无效')
        }
        const target = path.resolve(candidate)
        // Reject a symlink/junction at any component rather than silently granting its destination.
        let cursor = target
        while (true) {
          const stats = await fs.lstat(cursor)
          if (stats.isSymbolicLink()) throw new ZToolsError(errorCodes.permissionDenied, '拖放路径包含重解析链接')
          const parent = path.dirname(cursor)
          if (parent === cursor) break
          cursor = parent
        }
        const real = await fs.realpath(target)
        if (seen.has(real)) continue
        const stats = await fs.stat(real)
        if (!stats.isFile()) throw new ZToolsError(errorCodes.invalidRequest, '拖放目标必须为普通文件')
        if (!Number.isSafeInteger(stats.size) || stats.size > MAX_FILE_BYTES || totalBytes + stats.size > MAX_TOTAL_BYTES) {
          throw new ZToolsError(errorCodes.fileTooLarge, '拖放文件超过大小上限')
        }
        this.requireCaller(webContentsId, caller)
        await this.files.grantOpenPath(real, caller)
        this.requireCaller(webContentsId, caller)
        seen.add(real)
        totalBytes += stats.size
        accepted.push(real)
      } catch (error) {
        const publicError = toPublicError(fileFailure(error))
        errors.push({ index, ...publicError })
      }
    }
    this.requireCaller(webContentsId, caller)
    return this.publish(caller, accepted, errors, errors.length)
  }

  private publish(caller: CallerIdentity, accepted: string[], errors: Array<{ index: number; code: string; message: string }>, rejectedCount: number): { success: true; accepted: number; rejected: number } {
    this.registry.send(caller.webContentsId, IPC_EVENT_CHANNEL, {
      msgType: 'event_envelope',
      msgData: {
        envelope: {
          envelopeId: `host_${randomUUID()}`, version: 'v1', timestamp: Date.now(),
          type: 'plugin_files_dropped', scope: 'plugin', source: { kind: 'host' },
          target: { pluginId: caller.pluginId }, payload: { files: accepted, errors }
        }
      }
    })
    return { success: true, accepted: accepted.length, rejected: rejectedCount }
  }

  private requireCaller(webContentsId: number, expected?: CallerIdentity): CallerIdentity {
    const caller = this.registry.get(webContentsId)
    if (!caller || caller.type !== 'plugin' || !caller.pluginId || (expected && (caller.pluginId !== expected.pluginId || caller.pluginInstanceId !== expected.pluginInstanceId))) {
      throw new ZToolsError(errorCodes.permissionDenied, '拖放调用者不是当前注册插件窗口')
    }
    return caller
  }
}
