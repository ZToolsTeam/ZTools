import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { grantId, isConfirmedReferenceWriteReceipt, type PathGrantRef } from '../../contracts/path-reference.js'
import type { ReferenceMethod } from '../../contracts/reference-transport.js'
import type { AnchoredFileSystemService } from '../services/anchored-file-system-service.js'
import type { ReferenceCacheService } from '../services/reference-cache-service.js'
import type { ReferenceDirectoryLocations } from '../services/reference-directory-locations.js'
import type { ReferenceHandler } from './reference-endpoint.js'

function params(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(key => !keys.includes(key))) throw new ZToolsError(errorCodes.invalidRequest, '文件请求字段无效')
  return value as Record<string, unknown>
}
const id = (value: unknown) => grantId(params(value, ['grantId']).grantId)

/** Concrete reference handler composition. Normal Router activates this only with all SDK2 consumers. */
export function createReferenceFileHandlers(files: AnchoredFileSystemService, cache: ReferenceCacheService,
  locations: ReferenceDirectoryLocations): Partial<Record<ReferenceMethod, ReferenceHandler>> {
  const handler = (execute: ReferenceHandler['execute']): ReferenceHandler => ({ execute })
  const disposeUndelivered = async (result: unknown, caller: CallerIdentity) => {
    if (isConfirmedReferenceWriteReceipt(result) && result.status === 'committed-reference-unavailable') return
    if (result && typeof result === 'object' && (result as { status?: unknown }).status === 'result-unknown' &&
        (result as { success?: unknown }).success === false &&
        (result as { code?: unknown }).code === errorCodes.fileWriteOutcomeUnknown) return
    const reference = (result as { reference?: PathGrantRef })?.reference
    if (!reference) throw new ZToolsError(errorCodes.fileError, '未交付文件引用无效')
    await files.revoke(reference.grantId, caller)
  }
  const producer = (execute: ReferenceHandler['execute']): ReferenceHandler => ({ execute, disposeUndelivered })
  const project = async (reference: PathGrantRef, caller: CallerIdentity) => {
    try {
      return { success: true, reference: reference.kind === 'file' ? { ...reference, fileUrl: files.resourceUrl(reference.grantId, caller) } : reference }
    } catch (error) { await files.revoke(reference.grantId, caller); throw error }
  }
  const writeFile = producer(async (value, caller, signal) => {
    return files.writeFile(value, caller, signal)
  })
  return {
    filesystem_read_file: handler((value, caller, signal) => files.readFile(value, caller, signal)),
    filesystem_read_file_range: handler((value, caller, signal) => files.readFileRange(value, caller, signal)),
    filesystem_write_file: writeFile,
    filesystem_copy_file: handler((value, caller, signal) => files.copyFile(value, caller, signal)),
    filesystem_move_file: handler((value, caller, signal) => files.moveFile(value, caller, signal)),
    filesystem_create_directory: handler((value, caller, signal) => files.createDirectory(value, caller, signal)),
    filesystem_delete_file: handler((value, caller, signal) => {
      const v = params(value, ['directoryGrantId', 'relativePath', 'isDirectory'])
      if (v.isDirectory !== false) throw new ZToolsError(errorCodes.invalidRequest, '文件删除不接受目录')
      return files.remove(value, caller, signal)
    }),
    filesystem_delete_directory: handler((value, caller, signal) => {
      const v = params(value, ['directoryGrantId', 'relativePath', 'isDirectory'])
      if (v.isDirectory !== true) throw new ZToolsError(errorCodes.invalidRequest, '目录删除只接受空目录')
      return files.remove(value, caller, signal)
    }),
    filesystem_find_files: handler((value, caller, signal) => files.find(value, caller, false, signal)),
    filesystem_find_directories: handler((value, caller, signal) => files.find(value, caller, true, signal)),
    filesystem_get_directory_contents: handler((value, caller, signal) => files.getDirectoryContents(value, caller, signal)),
    filesystem_derive_read: producer(async (value, caller, signal) => project(await files.deriveRead(value, caller, signal), caller)),
    filesystem_derive_save: producer(async (value, caller, signal) => project(await files.deriveSave(value, caller, signal), caller)),
    filesystem_derive_directory: producer(async (value, caller, signal) => project(await files.deriveDirectory(value, caller, signal), caller)),
    filesystem_describe: handler(async (value, caller, signal) => ({ success: true, ...await files.describe(id(value), caller, signal) })),
    filesystem_get_file_size: handler(async (value, caller, signal) => ({ success: true, size: (await files.describe(id(value), caller, signal)).size })),
    filesystem_file_exists: handler(async (value, caller, signal) => ({ success: true, exists: !(await files.describe(id(value), caller, signal)).isDirectory })),
    filesystem_directory_exists: handler(async (value, caller, signal) => ({ success: true, exists: (await files.describe(id(value), caller, signal)).isDirectory })),
    filesystem_revoke: handler(async (value, caller) => files.revoke(id(value), caller)),
    filesystem_read_cache: handler((value, caller, signal) => cache.readCache(value, caller, signal)),
    filesystem_write_cache: producer((value, caller, signal) => cache.writeCache(value, caller, signal)),
    filesystem_get_current_directory: handler(async (value, caller) => { params(value, []); return locations.getCurrentDirectory(caller) }),
    filesystem_set_current_directory: handler(async (value, caller, signal) =>
      locations.setCurrentDirectory(grantId(params(value, ['directoryGrantId']).directoryGrantId), caller, signal))
  }
}
