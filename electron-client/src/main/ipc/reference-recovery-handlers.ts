import type { ReferenceMethod } from '../../contracts/reference-transport.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type { PathWriteRecoveryService } from '../services/path-write-recovery-service.js'
import type { ReferenceHandler } from './reference-endpoint.js'

/** Main-only read-only diagnostics; no acknowledge/replay/delete operation. */
export function createReferenceRecoveryHandlers(recovery: PathWriteRecoveryService): Partial<Record<ReferenceMethod, ReferenceHandler>> {
  const fields = (value: unknown, expected: readonly string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
        Object.keys(value).some(key => !expected.includes(key))) throw new ZToolsError(errorCodes.invalidRequest, '写入恢复查询字段无效')
    return value as Record<string, unknown>
  }
  return {
    filesystem_list_write_recovery: { execute: async (value, caller, signal) => {
      fields(value, [])
      if (caller.type !== 'main') throw new ZToolsError(errorCodes.permissionDenied, '写入恢复仅允许主窗口访问')
      return { success: true, entries: await recovery.list(caller, signal) }
    } },
    filesystem_inspect_write_recovery: { execute: async (value, caller, signal) => {
      const params = fields(value, ['recoveryId'])
      if (caller.type !== 'main') throw new ZToolsError(errorCodes.permissionDenied, '写入恢复仅允许主窗口访问')
      return { success: true, entry: await recovery.inspect(params.recoveryId, caller, signal) }
    } }
  }
}
