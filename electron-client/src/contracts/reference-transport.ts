import { errorCodes, ZToolsError } from './errors.js'
import { parseRequest, MAX_REQUEST_BYTES, MAX_FILE_REQUEST_BYTES, type ZToolsRequest } from './ipc.js'

export const REFERENCE_CANCEL_CHANNEL = 'ztools:reference-cancel' as const
export const REFERENCE_MUTATING_METHODS = [
  'filesystem_write_file', 'filesystem_write_cache', 'filesystem_delete_file',
  'filesystem_copy_file', 'filesystem_move_file', 'filesystem_create_directory', 'filesystem_delete_directory',
  'network_http_download', 'clipboard_copy_text', 'clipboard_copy_image', 'clipboard_clear', 'clipboard_copy_file', 'clipboard_copy_files', 'shell_trash_item',
  'clipboard_read_image', 'screen_capture', 'screen_capture_region', 'image_transform', 'image_encode_base64', 'image_decode_base64', 'image_preview', 'image_to_pdf', 'image_to_gif', 'image_preview_gif', 'zip_compress', 'zip_extract'
] as const
export const REFERENCE_METHODS = [...REFERENCE_MUTATING_METHODS,
  'filesystem_read_file', 'filesystem_read_file_range', 'filesystem_read_cache',
  'filesystem_file_exists', 'filesystem_get_file_size', 'filesystem_directory_exists', 'filesystem_get_directory_contents',
  'filesystem_get_current_directory', 'filesystem_set_current_directory', 'filesystem_find_files', 'filesystem_find_directories',
  'filesystem_derive_read', 'filesystem_derive_save', 'filesystem_derive_directory', 'filesystem_describe', 'filesystem_revoke',
  'window_show_open_dialog', 'window_show_save_dialog', 'window_show_select_folder_dialog',
  'network_http_upload', 'clipboard_read_files', 'filesystem_list_write_recovery', 'filesystem_inspect_write_recovery', 'sqlite_read_browser_snapshot', 'ocr_local_languages', 'ocr_recognize_reference', 'clipboard_read_text', 'image_get_info', 'zip_list', 'zip_test', 'screen_get_cursor_pos', 'screen_get_primary_display', 'screen_get_all_displays', 'screen_get_display_nearest', 'screen_get_display_matching'
] as const
export type ReferenceMethod = typeof REFERENCE_METHODS[number]
const methods = new Set<string>(REFERENCE_METHODS)

export function parseReferenceCancellation(value: unknown): {
  messageId: string; method: ReferenceMethod; reason: 'cancel' | 'timeout'
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const source = value as Record<string, unknown>
  if (Object.keys(source).some(key => !['messageId', 'method', 'reason'].includes(key)) ||
      typeof source.messageId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(source.messageId) ||
      typeof source.method !== 'string' || !methods.has(source.method) ||
      (source.reason !== 'cancel' && source.reason !== 'timeout')) throw invalid()
  return { messageId: source.messageId, method: source.method as ReferenceMethod, reason: source.reason }
}
function invalid(): ZToolsError { return new ZToolsError(errorCodes.invalidRequest, '文件取消请求无效') }

/** Contract 2 text uses bounded direct IPC or native FileRef, never legacy temporary paths. */
export function parseReferenceRequest(value: unknown): ZToolsRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'params')) throw invalidRequest()
  const source = value as Record<string, unknown>
  // Reuse the envelope/timeout validation without applying the legacy 1MiB text limit.
  const envelope = parseRequest({ ...source, params: {} })
  const limit = envelope.method === 'clipboard_copy_text' ? 8 * 1024 * 1024 + 1024 :
    ['filesystem_write_file', 'filesystem_write_cache'].includes(envelope.method) ? MAX_FILE_REQUEST_BYTES : MAX_REQUEST_BYTES
  try {
    if (Buffer.byteLength(JSON.stringify(source.params), 'utf8') > limit) throw invalidRequest()
  } catch { throw invalidRequest() }
  return { ...envelope, params: source.params }
}
function invalidRequest(): ZToolsError { return new ZToolsError(errorCodes.invalidRequest, '文件引用请求无效或超出传输上限') }
