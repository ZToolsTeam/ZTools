import { errorCodes, ZToolsError } from './errors.js'

export const IPC_CALL_CHANNEL = 'ztools:call' as const
export const IPC_EVENT_CHANNEL = 'ztools:event' as const
export const DEFAULT_TIMEOUT_MS = 10_000
export const MAX_TIMEOUT_MS = 300_000
/** NetworkService owns the request deadline; the outer IPC timeout needs a small settle grace. */
export const MAX_NETWORK_REQUEST_IPC_TIMEOUT_MS = MAX_TIMEOUT_MS + 250
export const MAX_REQUEST_BYTES = 1024 * 1024
export const MAX_FILE_REQUEST_BYTES = 24 * 1024 * 1024
export const INFINITE_TIMEOUT = 'infinite' as const

const infiniteTimeoutMethods = new Set([
  'window_show_open_dialog',
  'window_show_save_dialog',
  'update_install_start',
  'window_show_select_folder_dialog',
  'process_wait'
])

const largeRequestMethods = new Set([
  'filesystem_write_file',
  'filesystem_write_cache',
  'filesystem_write_file_chunk',
  'filesystem_write_cache_chunk',
  'clipboard_copy_image',
  'db_put',
  'db_batch',
  'db_put_secure',
  'credential_v1_set'
])

/**
 * 剪贴板文本写入：宿主剪贴板上限是 8 MiB（UTF-8），请求体按同一上限另留 1 KiB 信封余量
 * （与 Contract 2 直连通道一致），其它普通请求仍是 1 MiB。
 */
export const MAX_CLIPBOARD_TEXT_REQUEST_BYTES = 8 * 1024 * 1024 + 1024
const clipboardTextMethods = new Set(['clipboard_copy_text', 'clipboard_hide_and_paste_text'])

/**
 * 声明式插件会话令牌：32 字节随机数的 base64url（43 个字符）。
 * 只在信封里携带，不进入 params，因此不影响任何方法的参数校验；主进程只按「令牌 + 发送窗口」查归属。
 */
export const PLUGIN_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export interface ZToolsRequest {
  messageId: string
  method: string
  params: unknown
  timeoutMs?: number | typeof INFINITE_TIMEOUT
  /** 可选的声明式插件会话令牌（见 DeclarativePluginAttributionService） */
  pluginSession?: string
}

export type ZToolsResponse =
  | { messageId: string; success: true; data: unknown }
  | {
      messageId: string
      success: false
      error: { code: string; message: string; details?: Readonly<Record<string, unknown>> }
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function serializedSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    throw new ZToolsError(errorCodes.invalidRequest, 'params 必须可序列化')
  }
}

export function parseRequest(value: unknown): ZToolsRequest {
  if (!isRecord(value)) throw new ZToolsError(errorCodes.invalidRequest, '请求必须是对象')
  const allowedKeys = new Set(['messageId', 'method', 'params', 'timeoutMs', 'pluginSession'])
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new ZToolsError(errorCodes.invalidRequest, '请求包含未知字段')
  }
  if (typeof value.messageId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value.messageId)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'messageId 无效')
  }
  if (typeof value.method !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/.test(value.method)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'method 无效')
  }
  if (!Object.hasOwn(value, 'params')) {
    throw new ZToolsError(errorCodes.invalidRequest, 'params 字段缺失')
  }
  const pluginSession = value.pluginSession
  if (pluginSession !== undefined &&
      (typeof pluginSession !== 'string' || !PLUGIN_SESSION_TOKEN_PATTERN.test(pluginSession))) {
    throw new ZToolsError(errorCodes.invalidRequest, 'pluginSession 无效')
  }
  const timeoutMs = value.timeoutMs
  const maxTimeoutMs = value.method === 'network_http_request'
    ? MAX_NETWORK_REQUEST_IPC_TIMEOUT_MS
    : MAX_TIMEOUT_MS
  if (
    timeoutMs !== undefined &&
    timeoutMs !== INFINITE_TIMEOUT &&
    (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs)
  ) {
    throw new ZToolsError(errorCodes.invalidRequest, 'timeoutMs 超出范围')
  }
  if (timeoutMs === INFINITE_TIMEOUT && !infiniteTimeoutMethods.has(value.method)) {
    throw new ZToolsError(errorCodes.invalidRequest, '该方法不允许无限等待')
  }
  const requestLimit = largeRequestMethods.has(value.method)
    ? MAX_FILE_REQUEST_BYTES
    : clipboardTextMethods.has(value.method) ? MAX_CLIPBOARD_TEXT_REQUEST_BYTES : MAX_REQUEST_BYTES
  if (serializedSize(value.params) > requestLimit) {
    throw new ZToolsError(errorCodes.invalidRequest, 'params 超过大小上限')
  }
  return {
    messageId: value.messageId,
    method: value.method,
    params: value.params,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(pluginSession === undefined ? {} : { pluginSession })
  }
}

// =============================================================================
// M2 扩展宿主与多端通信安全信道契约 (Host Process ↔ Worker Pool ↔ Renderer)
// =============================================================================

export const IPC_EXTENSION_HOST_REQUEST_CHANNEL = 'ztools:ext:request' as const
export const IPC_EXTENSION_HOST_NOTIFY_CHANNEL = 'ztools:ext:notify' as const
export const IPC_EXTENSION_HOST_RESULT_CHANNEL = 'ztools:ext:result' as const
export const IPC_EXTENSION_RENDER_CHANNEL = 'extension:render' as const
export const IPC_EXTENSION_CALLBACK_CHANNEL = 'extension:callback' as const

export interface ExtensionHostRequest {
  id: string
  action: 'initialize' | 'nativeCallback' | 'terminate' | 'ping'
  payload: Record<string, unknown>
}

export interface ExtensionHostNotification {
  action: 'promoteTree' | 'renderEmpty' | 'ready' | 'terminate' | 'toast' | 'pop' | 'error'
  payload?: unknown
}

export interface ExtensionHostResult {
  id: string
  success: boolean
  data?: unknown
  error?: {
    code: string
    message: string
    stack?: string
  }
}

export interface ExtensionRenderPayload {
  sessionId: string
  descriptor?: unknown
  empty?: boolean
}

export interface ExtensionCallbackPayload {
  sessionId: string
  callbackId: string
  args?: unknown[]
}

// =============================================================================
// M1.5 第二组 8 大高频内置服务请求契约 (Group 2 Services Contracts)
// =============================================================================

export interface EmojiSearchParams {
  readonly query?: string
  readonly category?: string
  readonly skinTone?: string
  readonly limit?: number
}

export interface EmojiRecordUsageParams {
  readonly char: string
}

export interface EmojiToggleFavoriteParams {
  readonly char: string
}

export interface TranslatorTranslateParams {
  readonly text: string
  readonly sourceLanguage?: string
  readonly targetLanguage?: string
}

export interface TranslatorDetectParams {
  readonly text: string
}

export interface NotesListParams {
  readonly search?: string
  readonly includeTrash?: boolean
  readonly onlyTrash?: boolean
  readonly tag?: string
  readonly pinnedFirst?: boolean
  readonly limit?: number
}

export interface NotesGetParams {
  readonly id: string
}

export interface NotesSaveParams {
  readonly id?: string
  readonly title: string
  readonly content: string
  readonly pinned?: boolean
  readonly color?: string
  readonly tags?: string[]
}

export interface NotesDeleteParams {
  readonly id: string
  readonly permanent?: boolean
}

export interface NotesRestoreParams {
  readonly id: string
}

export interface NotesTogglePinParams {
  readonly id: string
}

export interface WindowsRunSearchParams {
  readonly query?: string
}

export interface WindowsRunExecuteParams {
  readonly command: string
  readonly args?: readonly string[]
  readonly runAsAdmin?: boolean
  readonly shell?: 'cmd' | 'powershell' | 'git-bash' | 'wsl'
  readonly workingDirectory?: string
}

export interface WindowsRunRegisterAliasParams {
  readonly alias: string
  readonly command: string
  readonly description?: string
  readonly descriptionZh?: string
  readonly runAsAdminByDefault?: boolean
}

export interface WindowsRunRemoveAliasParams {
  readonly alias: string
}

export interface ScreenshotsScanParams {
  readonly query?: string
  readonly limit?: number
  readonly pinnedFirst?: boolean
  readonly forceRefresh?: boolean
}

export interface ScreenshotsTogglePinParams {
  readonly filePath: string
}

export interface ScreenshotsDeleteParams {
  readonly filePath: string
  readonly permanent?: boolean
}

export interface ApplicationsListParams {
  readonly query?: string
  readonly includeSystemComponents?: boolean
  readonly forceRefresh?: boolean
}

export interface ApplicationsUninstallParams {
  readonly command: string
}

export interface DictionaryLookupParams {
  readonly word: string
}

export interface DictionarySuggestionsParams {
  readonly prefix: string
  readonly limit?: number
}

export interface DictionaryToggleFavoriteParams {
  readonly word: string
}

