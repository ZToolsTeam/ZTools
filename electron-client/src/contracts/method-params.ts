import type { AllowedMethod } from './capabilities.js'
import { errorCodes, ZToolsError } from './errors.js'
import { isRuntimeCapabilityId } from './runtime-capability.js'
import { MAX_TIMEOUT_MS } from './ipc.js'

export interface ConfigGetParams {
  file: string
  path: string
  default: unknown
}

export interface ConfigSetParams {
  file: string
  path: string
  value: string
  sync_enabled: boolean
}

export interface SettingsGetParams {
  key: string
}

export interface SettingsSetParams {
  key: string
  value: unknown
}

export interface UserSetTokenParams {
  token: string
  refresh_token: string
  user_id: string
  username?: string
  email?: string
  expires_at?: string
}

export interface AnalyticsReportParams {
  event: string
  plugin_id: string
  web_version: string
  client?: string
  data?: unknown
  user_id?: string | null
}

export interface DiagnosticsGetParams {
  readonly requestIds?: readonly string[]
}

export interface WindowUrlParams {
  url: string
}

/**
 * 弹出独立窗口时交给新窗口的插件状态（usePopoutState）。
 * - id：渲染层生成的一次性编号，必须与 URL 里的 handoff 参数一致（非机密，取走仍按新窗口 webContentsId 绑定）；
 * - state：JSON 文本（顶层对象），主进程只校验可解析与大小，不解读内容；
 * - paths：值里引用的本地路径，主进程只转交源窗口已有的授权。
 */
export interface PopoutHandoffParams {
  id: string
  pluginId: string
  featureCode?: string
  state: string
  paths?: string[]
}

export interface WindowOpenParams extends WindowUrlParams {
  handoff?: PopoutHandoffParams
}

export interface WindowPopoutHandoffTakeParams {
  handoffId: string
}

export const POPOUT_HANDOFF_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/
export const POPOUT_HANDOFF_MAX_STATE_BYTES = 256 * 1024
export const POPOUT_HANDOFF_MAX_PATHS = 2000
export const POPOUT_HANDOFF_MAX_PATH_LENGTH = 4096
/** paths 合计上限：与 state 一起保证整个请求在普通 1 MiB 上限内，window_open 不进入大请求名单 */
export const POPOUT_HANDOFF_MAX_PATHS_BYTES = 512 * 1024

export interface WindowSetHeightParams {
  height: number
}

export interface WindowSetSizeParams {
  width: number
  height: number
  animate: boolean
}

export interface WindowSetOpacityParams {
  opacity: number
}

export interface WindowSetAlwaysOnTopParams {
  alwaysOnTop: boolean
}

export interface WindowDialogParams {
  title?: string
  defaultPath?: string
  defaultName?: string
  filters?: string
  properties?: string[]
  timeout?: number
}

export interface WindowCloseConfirmParams {
  confirmed: boolean
  doNotAskAgain: boolean
  action: 'exit' | 'minimize' | 'cancel'
}

export interface EventKeyParams {
  key: string
}

export interface EventEnvelope {
  envelopeId: string
  version: 'v1'
  timestamp: number
  type: string
  scope: string
  channel?: string
  source: { kind: string }
  target: { broadcast: true }
  payload: unknown
  correlationId?: string
  replyTo?: string
  timeout?: number
}

export interface EventEnvelopeParams {
  envelope: EventEnvelope
}

export interface NetworkHttpRequestParams {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE'
  url: string
  headers?: Record<string, string>
  body?: string
  timeout: number
}

export interface NetworkTransferParams {
  url: string
  headers?: Record<string, string>
  savePath?: string
  filePath?: string
  fieldName?: string
  timeout?: number
}

export interface NetworkSetCookieParams {
  name: string
  value: string
  url?: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  expirationDate?: number
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

export interface NetworkGetCookieParams {
  url: string
}

export interface NetworkSetProxyParams {
  host: string
  port: number
  username?: string
  password?: string
}

export interface FilePathParams {
  path: string
}

export interface FileCopyParams {
  sourcePath: string
  destPath: string
}

export interface FileFindParams extends FilePathParams {
  pattern: string
}

export interface FileCombineParams {
  path1: string
  path2: string
}

export interface FileReadParams extends FilePathParams {
  encoding: 'utf8' | 'base64'
}

export interface FileWriteParams extends FileReadParams {
  content: string
  overwrite?: boolean
}

export interface FileReadChunkParams extends FilePathParams {
  offset: number
  length: number
}

export interface FileWriteStartParams extends FilePathParams {
  totalSize: number
}

export interface FileWriteChunkParams {
  handle: string
  offset: number
  content: string
}

export interface FileWriteHandleParams {
  handle: string
}

export interface FileCacheReadChunkParams {
  relativePath: string
  offset: number
  length: number
}

export interface FileCacheWriteStartParams {
  relativePath: string
  totalSize: number
}

export interface FileCacheParams {
  relativePath: string
  encoding: 'utf8' | 'base64'
  content?: string
}

export interface PluginFilesDroppedParams {
  dropId: string
  paths: string[]
}

export interface ShellPathParams {
  fullPath: string
}

export interface ShellOpenExternalParams {
  url: string
}

export interface ShellExecParams {
  command: string
}

export interface ProcessPidParams {
  pid: number
}

export interface ProcessExistsParams {
  nameOrPid: string
}

export interface ProcessFindParams {
  name: string
}

export interface ProcessStartParams {
  path: string
  args: string[]
  workingDir: string
  show: boolean
}

export interface ProcessKillParams extends ProcessPidParams {
  force: boolean
}

export interface ProcessKillByNameParams {
  name: string
  force: boolean
}

/** 结束本机任意进程（需要插件声明 process 权限，见 requirePluginPermission） */
export interface ProcessTerminatePidParams {
  pid: number
  mode: 'graceful' | 'force'
  tree?: boolean
  timeoutMs?: number
  expectedName?: string
}

export interface DeclarativeSessionOpenParams {
  pluginId: string
  featureCode?: string
}

export interface DeclarativeSessionCloseParams {
  sessionId: string
}

export interface DatabaseCompactParams {
  plugin_id: string
}

/** declarative_session_open 返回的会话编号格式（同时满足凭据存储的实例 ID 规则） */
export const DECLARATIVE_SESSION_ID_PATTERN = /^ds_[A-Za-z0-9_-]{16}$/
export const PROCESS_TERMINATE_MIN_TIMEOUT_MS = 100
export const PROCESS_TERMINATE_MAX_TIMEOUT_MS = 10_000

export interface ProcessWaitParams extends ProcessPidParams {
  timeout: number
}

export interface ProcessRunFFmpegParams {
  args: string[]
}

export interface ScreenPointParams {
  point: { x: number; y: number }
}

export interface ScreenRectParams {
  rect: { x: number; y: number; width: number; height: number }
}

export interface ScreenCaptureParams {
  rect?: ScreenRectParams['rect']
}

export interface ClipboardCopyTextParams {
  text?: string
  tempFile?: string
}

export interface ClipboardImageParams {
  image: string
}

export interface ClipboardFileParams {
  filePath: string
}

export interface ClipboardFilesParams {
  filePaths: string[]
}

export interface DatabaseKeyParams {
  plugin_id: string
  key: string
}

export interface DatabaseGetParams extends DatabaseKeyParams {
  is_base64?: boolean
}

export interface DatabasePutParams extends DatabaseGetParams {
  value: unknown
}

export interface DatabaseQueryParams {
  plugin_id: string
  prefix: string
  limit: number
}

export type DatabaseBatchOperation =
  | { op: 'put'; key: string; value: unknown }
  | { op: 'delete'; key: string }

export interface DatabaseBatchParams {
  plugin_id: string
  operations: DatabaseBatchOperation[]
}

export interface DatabaseSecurePutParams extends DatabaseKeyParams {
  value: string
}

/** Plugin ID and instance identity are always derived from the registered Main caller. */
export interface CredentialV1KeyParams {
  key: string
}

export interface CredentialV1SetParams extends CredentialV1KeyParams {
  value: string
}

export interface PluginKeyParams {
  pluginId: string
}

export interface PluginDataRestoreParams extends PluginKeyParams {
  preservationId: string
  assets: string[]
}

export interface PluginWindowCloseParams extends PluginKeyParams {
  instanceId?: string
}

export interface PluginLifecycleAckParams {
  lifecycleId: string
}

export interface PluginIconRefreshParams extends PluginKeyParams {
  iconUrl: string
}

export interface PluginOpenParams extends PluginKeyParams {
  payload?: Record<string, unknown>
}

export interface PluginWindowCloseParams extends PluginKeyParams {
  instanceId?: string
}

export interface PluginRevokeParams extends PluginKeyParams {
  revoked: boolean
  reason?: string
}

export interface PluginInstallParams extends PluginKeyParams {
  url: string
  version: string
  checksum?: string
  fileSize: number
  revoked?: boolean
  revoked_reason?: string
}

export interface UpdateCheckParams {
  source: 'startup' | 'manual'
}

export interface UpdatePackageParams {
  type?: 'app' | 'web'
  version: string
  downloadUrl: string
  checksum: string
  fileSize: number
  minAppVersion?: string
}

export interface PrivilegedExecuteParams {
  cmd: string
  args?: string[]
  cwd?: string
  timeout?: number
  show?: boolean
}

export interface PrivilegedRegistryParams {
  path: string
  name: string
  value?: string
  view: 32 | 64
}

export interface PrivilegedFileWriteParams {
  path: string
  content: string
}

export interface TriggerAction {
  mode: 'builtin' | 'dll' | 'script' | 'window'
  target: string
  params: Record<string, unknown>
}

export interface TriggerRegisterParams {
  id?: string
  pluginId: string
  type: 'hotkey' | 'timer' | 'hook' | 'clipboard' | 'network'
  enabled: boolean
  config: Record<string, unknown>
  action?: TriggerAction
  actionMode?: TriggerAction['mode']
  actionTarget?: string
  actionParams?: Record<string, unknown>
  priority?: number
}

export interface TriggerKeyParams {
  triggerId: string
}

export interface TriggerListParams {
  pluginId: string
}

export interface TriggerSetEnabledParams extends TriggerKeyParams {
  enabled: boolean
}

export interface TriggerConflictParams {
  key: string
  pluginId: string
}

export interface SystemNotifyParams {
  title: string
  message: string
  modal: boolean
}

export interface SystemDarkModeParams {
  dark: boolean
}

export interface SystemAutostartParams {
  enabled: boolean
}

export type SystemPathName =
  | 'app'
  | 'home'
  | 'appData'
  | 'userData'
  | 'temp'
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos'
  | 'cache'

export interface SystemPathParams {
  name: SystemPathName
}

export interface SystemFileIconParams {
  filePath: string
}

export interface SystemSearchFilesParams {
  query: string
  limit?: number
}

export interface SystemShutdownParams {
  force: boolean
  timeout: number
}

export interface SystemForceParams {
  force: boolean
}

export interface SystemPreventSleepParams {
  enable: boolean
}

export interface RuntimeCapabilityQueryParams {
  capability: string
}

export interface RuntimeCapabilityGrantRevokeParams {
  grantId: string
}

export interface SystemKeyParams {
  key: string
}

export interface SystemKeyComboParams {
  keys: string
}

export interface SystemTextParams {
  text: string
}

export interface SystemMouseMoveParams {
  x: number
  y: number
}

export interface SystemMouseClickParams {
  button: 'left' | 'right' | 'middle'
  x?: number
  y?: number
}

export interface SystemMouseWheelParams {
  delta: number
}

export interface SystemDiskUsageParams {
  drive?: string
}

export interface DllPluginCallParams {
  plugin: string
  func: string
  params: Record<string, unknown>
}

export interface DllPluginTaskParams {
  plugin: string
  taskId: string
}

export interface DllPluginClearTaskParams {
  taskId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const fields = Object.keys(value).filter((key) => !allowed.includes(key))
  if (fields.length > 0) {
    throw new ZToolsError(errorCodes.invalidRequest, '方法参数包含未知字段', {
      path: 'params',
      fields: fields.slice(0, 8)
    })
  }
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  options: { min?: number; max: number }
): string {
  const item = value[key]
  const min = options.min ?? 0
  if (typeof item !== 'string' || item.length < min || item.length > options.max) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 无效`, { path: key })
  }
  return item
}

function optionalString(value: Record<string, unknown>, key: string, max: number): void {
  const item = value[key]
  if (item !== undefined && (typeof item !== 'string' || item.length > max)) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 无效`, { path: key })
  }
}

function requireBoolean(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== 'boolean') {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 无效`, { path: key })
  }
}

function requireInteger(
  value: Record<string, unknown>,
  key: string,
  options: { min: number; max: number }
): void {
  const item = value[key]
  if (!Number.isInteger(item) || (item as number) < options.min || (item as number) > options.max) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 超出范围`, { path: key })
  }
}

function validateDialogParams(params: Record<string, unknown>, kind: 'open' | 'save' | 'folder'): void {
  const allowed = ['title', 'defaultPath']
  if (kind !== 'folder') allowed.push('filters')
  if (kind === 'open') allowed.push('properties')
  if (kind === 'save') allowed.push('defaultName')
  allowed.push('timeout')
  rejectUnknownKeys(params, allowed)
  optionalString(params, 'title', 256)
  optionalString(params, 'defaultPath', 32 * 1024)
  if (kind !== 'folder') optionalString(params, 'filters', 4096)
  if (kind === 'save') optionalString(params, 'defaultName', 1024)
  if (params.timeout !== undefined) requireInteger(params, 'timeout', { min: 1, max: MAX_TIMEOUT_MS })
  if (kind === 'open' && params.properties !== undefined) {
    const allowedProperties = new Set([
      'openFile',
      'openDirectory',
      'multiSelections',
      'showHiddenFiles',
      'createDirectory',
      'promptToCreate',
      'noResolveAliases',
      'treatPackageAsDirectory',
      'dontAddToRecent'
    ])
    if (
      !Array.isArray(params.properties) ||
      params.properties.length > allowedProperties.size ||
      params.properties.some((item) => typeof item !== 'string' || !allowedProperties.has(item))
    ) {
      throw new ZToolsError(errorCodes.invalidRequest, 'properties 无效')
    }
  }
}

function requireSerializable(value: unknown, key: string, max: number): void {
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(value)
  } catch {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 必须可序列化`)
  }
  if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > max) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 超过大小上限`)
  }
}

function requireDatabasePluginId(value: Record<string, unknown>): void {
  requirePluginIdentifier(value, 'plugin_id')
}

function requirePluginIdentifier(value: Record<string, unknown>, key: string): string {
  const pluginId = requireString(value, key, { min: 1, max: 128 })
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pluginId) ||
    pluginId.endsWith('.') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(pluginId)
  ) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 格式无效`)
  }
  return pluginId
}

function requirePluginInstanceId(value: Record<string, unknown>, key: string): string {
  const instanceId = requireString(value, key, { min: 36, max: 36 })
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(instanceId)) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 必须是有效 UUID`)
  }
  return instanceId
}

function requireDllFunction(value: Record<string, unknown>): void {
  const func = requireString(value, 'func', { min: 1, max: 128 })
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(func)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'func 格式无效')
  }
}

function requireDllTaskId(value: Record<string, unknown>): void {
  const taskId = requireString(value, 'taskId', { min: 1, max: 256 })
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(taskId)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'taskId 格式无效')
  }
}

function validateDllPluginCall(params: Record<string, unknown>): void {
  if (typeof params.pluginName === 'string' && params.plugin === undefined) {
    params.plugin = params.pluginName
  }
  if (typeof params.method === 'string' && params.func === undefined) {
    params.func = params.method
  }
  if (params.pluginName !== undefined && params.pluginName === params.plugin) {
    delete params.pluginName
  }
  if (params.method !== undefined && params.method === params.func) {
    delete params.method
  }
  rejectUnknownKeys(params, ['plugin', 'func', 'params'])
  requirePluginIdentifier(params, 'plugin')
  requireDllFunction(params)
  if (!isRecord(params.params)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'params 必须是对象')
  }
  requireSerializable(params.params, 'params', 768 * 1024)
}

function requireDatabaseKey(value: Record<string, unknown>, key = 'key'): void {
  const databaseKey = requireString(value, key, { min: 1, max: 8192 })
  if (databaseKey.includes('\0')) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 包含空字符`)
  }
}

function requireCredentialKey(value: Record<string, unknown>): void {
  const key = requireString(value, 'key', { min: 1, max: 128 })
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(key)) {
    throw new ZToolsError(errorCodes.invalidRequest, '凭据 key 格式无效')
  }
}

function validateDatabasePut(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['plugin_id', 'key', 'value', 'is_base64'])
  requireDatabasePluginId(params)
  requireDatabaseKey(params)
  if (!Object.hasOwn(params, 'value')) {
    throw new ZToolsError(errorCodes.invalidRequest, 'value 字段缺失')
  }
  if (params.is_base64 !== undefined && typeof params.is_base64 !== 'boolean') {
    throw new ZToolsError(errorCodes.invalidRequest, 'is_base64 无效')
  }
  if (params.is_base64 === true) {
    const encoded = requireString(params, 'value', { max: 24 * 1024 * 1024 })
    if (!isValidFileBase64(encoded)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'value 不是有效 Base64')
    }
    return
  }
  requireSerializable(params.value, 'value', 16 * 1024 * 1024)
}

function validateDatabaseBatch(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['plugin_id', 'operations'])
  requireDatabasePluginId(params)
  if (!Array.isArray(params.operations) || params.operations.length < 1 || params.operations.length > 1024) {
    throw new ZToolsError(errorCodes.invalidRequest, 'operations 数量超出范围')
  }
  requireSerializable(params.operations, 'operations', 16 * 1024 * 1024)
  for (const operation of params.operations) {
    if (!isRecord(operation)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'operation 必须是对象')
    }
    if (operation.op === 'put') {
      rejectUnknownKeys(operation, ['op', 'key', 'value'])
      requireDatabaseKey(operation)
      if (!Object.hasOwn(operation, 'value')) {
        throw new ZToolsError(errorCodes.invalidRequest, 'operation.value 字段缺失')
      }
    } else if (operation.op === 'delete') {
      rejectUnknownKeys(operation, ['op', 'key'])
      requireDatabaseKey(operation)
    } else {
      throw new ZToolsError(errorCodes.invalidRequest, 'operation.op 无效')
    }
  }
}

function requireConfigPath(value: Record<string, unknown>, key: string): void {
  const path = requireString(value, key, { min: 1, max: 256 })
  const segments = path.split('.')
  if (
    segments.some(
      (segment) =>
        !/^[A-Za-z0-9_-]{1,64}$/.test(segment) ||
        segment === '__proto__' ||
        segment === 'prototype' ||
        segment === 'constructor'
    )
  ) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 包含无效分段`)
  }
}

function requireEventKey(value: Record<string, unknown>, key: string): string {
  const item = requireString(value, key, { min: 1, max: 136 })
  if (item === '*') return item
  const normalized = item.startsWith('channel:') ? item.slice('channel:'.length) : item
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 无效`)
  }
  return item
}

const forbiddenNetworkHeaders = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

function requireHttpUrl(value: Record<string, unknown>, key: string): URL {
  const source = requireString(value, key, { min: 1, max: 8192 })
  let parsed: URL
  try {
    parsed = new URL(source)
  } catch {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 无效`)
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 只允许无凭据的 HTTP/HTTPS URL`)
  }
  return parsed
}

function validateNetworkHeaders(value: Record<string, unknown>, key: string): void {
  const headers = value[key]
  if (headers === undefined) return
  if (!isRecord(headers) || Object.keys(headers).length > 64) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 无效`)
  }
  let totalBytes = 0
  for (const [name, item] of Object.entries(headers)) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ||
      forbiddenNetworkHeaders.has(name.toLowerCase()) ||
      typeof item !== 'string' ||
      item.length > 16 * 1024 ||
      /[\r\n\0]/.test(item)
    ) {
      throw new ZToolsError(errorCodes.invalidRequest, `${key} 包含无效请求头`)
    }
    totalBytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(item, 'utf8')
  }
  if (totalBytes > 64 * 1024) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 超过大小上限`)
  }
}

function validateNetworkRequest(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['method', 'url', 'headers', 'body', 'timeout'])
  if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(String(params.method))) {
    throw new ZToolsError(errorCodes.invalidRequest, 'method 无效')
  }
  requireHttpUrl(params, 'url')
  validateNetworkHeaders(params, 'headers')
  optionalString(params, 'body', 768 * 1024)
  requireInteger(params, 'timeout', { min: 1, max: MAX_TIMEOUT_MS })
}

function validateNetworkTransfer(params: Record<string, unknown>, upload: boolean): void {
  rejectUnknownKeys(
    params,
    upload ? ['url', 'filePath', 'fieldName', 'headers', 'timeout'] : ['url', 'savePath', 'headers', 'timeout']
  )
  requireHttpUrl(params, 'url')
  const transferPath = requireString(params, upload ? 'filePath' : 'savePath', { min: 1, max: 32 * 1024 })
  if (transferPath.includes('\0')) throw new ZToolsError(errorCodes.invalidRequest, '文件路径无效')
  validateNetworkHeaders(params, 'headers')
  if (params.timeout !== undefined) requireInteger(params, 'timeout', { min: 1, max: MAX_TIMEOUT_MS })
  if (upload && params.fieldName !== undefined) {
    const fieldName = requireString(params, 'fieldName', { min: 1, max: 128 })
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(fieldName)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'fieldName 无效')
    }
  }
}

function validateNetworkCookie(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, [
    'name',
    'value',
    'url',
    'domain',
    'path',
    'secure',
    'httpOnly',
    'expirationDate',
    'sameSite'
  ])
  const name = requireString(params, 'name', { min: 1, max: 256 })
  const cookieValue = requireString(params, 'value', { max: 4096 })
  if (/[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(name) || /[\x00-\x1F\x7F;]/.test(cookieValue)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'Cookie 名称或值无效')
  }
  if (params.url !== undefined) requireHttpUrl(params, 'url')
  optionalString(params, 'domain', 253)
  if (typeof params.domain === 'string') {
    const hostname = params.domain.startsWith('.') ? params.domain.slice(1) : params.domain
    const labels = hostname.split('.')
    if (
      hostname.length === 0 ||
      labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
    ) {
      throw new ZToolsError(errorCodes.invalidRequest, 'domain 无效')
    }
  }
  if (params.url === undefined && params.domain === undefined) {
    throw new ZToolsError(errorCodes.invalidRequest, 'Cookie 必须提供 url 或 domain')
  }
  optionalString(params, 'path', 4096)
  if (typeof params.path === 'string' && !params.path.startsWith('/')) {
    throw new ZToolsError(errorCodes.invalidRequest, 'path 无效')
  }
  if (params.secure !== undefined) requireBoolean(params, 'secure')
  if (params.httpOnly !== undefined) requireBoolean(params, 'httpOnly')
  if (
    params.expirationDate !== undefined &&
    (typeof params.expirationDate !== 'number' ||
      !Number.isFinite(params.expirationDate) ||
      params.expirationDate < 0 ||
      params.expirationDate > 253_402_300_799)
  ) {
    throw new ZToolsError(errorCodes.invalidRequest, 'expirationDate 无效')
  }
  if (
    params.sameSite !== undefined &&
    !['unspecified', 'no_restriction', 'lax', 'strict'].includes(String(params.sameSite))
  ) {
    throw new ZToolsError(errorCodes.invalidRequest, 'sameSite 无效')
  }
}

function validateNetworkProxy(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['host', 'port', 'username', 'password'])
  const host = requireString(params, 'host', { min: 1, max: 253 })
  requireInteger(params, 'port', { min: 1, max: 65_535 })
  optionalString(params, 'username', 1024)
  optionalString(params, 'password', 1024)
  let parsed: URL
  try {
    parsed = new URL(`http://${host}/`)
  } catch {
    throw new ZToolsError(errorCodes.invalidRequest, 'host 无效')
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.hostname === '' ||
    parsed.port !== ''
  ) {
    throw new ZToolsError(errorCodes.invalidRequest, 'host 无效')
  }
}

function requireFilePath(value: Record<string, unknown>, key: string): void {
  const item = requireString(value, key, { min: 1, max: 32 * 1024 })
  if (item.includes('\0')) throw new ZToolsError(errorCodes.invalidRequest, `${key} 无效`)
}

function requireScreenshotPath(value: Record<string, unknown>): void {
  const item = requireString(value, 'filePath', { min: 1, max: 4096 })
  if (item.includes('\0')) throw new ZToolsError(errorCodes.invalidRequest, 'filePath 无效', { path: 'filePath' })
}

function validateCalendarQuery(value: Record<string, unknown>): void {
  optionalString(value, 'search', 256)
  for (const key of ['startTime', 'endTime']) {
    if (value[key] !== undefined) requireInteger(value, key, { min: 0, max: 8_640_000_000_000_000 })
  }
}

function requireFileEncoding(value: Record<string, unknown>): void {
  if (value.encoding !== 'utf8' && value.encoding !== 'base64') {
    throw new ZToolsError(errorCodes.invalidRequest, 'encoding 无效')
  }
}

function validateFileRead(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['path', 'encoding'])
  requireFilePath(params, 'path')
  requireFileEncoding(params)
}

/**
 * 逐字符校验标准 Base64（长度为 4 的倍数、仅末尾 1~2 个 '=' 填充）。
 * 不用 /^(?:[A-Za-z0-9+/]{4})*...$/ 正则：V8 在约 450 万字符时回溯栈溢出，抛出的 RangeError 会变成宿主内部错误。
 */
export function isValidFileBase64(content: string): boolean {
  if (content.length % 4 !== 0) return false
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0
  const dataEnd = content.length - padding
  for (let index = 0; index < dataEnd; index += 1) {
    const code = content.charCodeAt(index)
    if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) || code === 43 || code === 47) continue
    return false
  }
  return padding === 0 || dataEnd >= 2
}

function validateFileWrite(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['path', 'encoding', 'content', 'overwrite'])
  if (params.overwrite !== undefined && typeof params.overwrite !== 'boolean') {
    throw new ZToolsError(errorCodes.invalidRequest, 'overwrite 必须是布尔值')
  }
  requireFilePath(params, 'path')
  requireFileEncoding(params)
  const content = requireString(params, 'content', { max: 23 * 1024 * 1024 })
  if (params.encoding === 'base64' && !isValidFileBase64(content)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'content 不是有效 Base64')
  }
}

function validateFileCache(params: Record<string, unknown>, write: boolean): void {
  rejectUnknownKeys(params, write ? ['relativePath', 'encoding', 'content'] : ['relativePath', 'encoding'])
  const relativePath = requireString(params, 'relativePath', { min: 1, max: 4096 })
  if (
    /^[\\/]/.test(relativePath) ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.split(/[\\/]+/).some((part) => part === '..' || part === '')
  ) {
    throw new ZToolsError(errorCodes.invalidRequest, 'relativePath 必须是安全相对路径')
  }
  requireFileEncoding(params)
  if (write) validateFileWrite({ path: relativePath, encoding: params.encoding, content: params.content })
}

const MAX_FILE_CHUNK_BYTES = 2 * 1024 * 1024
const MAX_STREAM_FILE_BYTES = 4 * 1024 * 1024 * 1024

function requireFileOffset(value: Record<string, unknown>, key: string): void {
  requireInteger(value, key, { min: 0, max: MAX_STREAM_FILE_BYTES })
}

function requireBase64Content(value: Record<string, unknown>, key: string): void {
  const content = requireString(value, key, { max: Math.ceil(MAX_FILE_CHUNK_BYTES / 3) * 4 + 4 })
  if (!isValidFileBase64(content)) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 不是有效 Base64`)
  }
  if (Buffer.byteLength(content, 'base64') > MAX_FILE_CHUNK_BYTES) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 超过分块大小上限`)
  }
}

function validateFileReadChunk(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['path', 'offset', 'length'])
  requireFilePath(params, 'path')
  requireFileOffset(params, 'offset')
  requireInteger(params, 'length', { min: 1, max: MAX_FILE_CHUNK_BYTES })
}

function validateFileWriteStart(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['path', 'totalSize'])
  requireFilePath(params, 'path')
  requireInteger(params, 'totalSize', { min: 0, max: MAX_STREAM_FILE_BYTES })
}

function validateFileWriteChunk(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['handle', 'offset', 'content'])
  const handle = requireString(params, 'handle', { min: 1, max: 128 })
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(handle)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'handle 格式无效')
  }
  requireFileOffset(params, 'offset')
  requireBase64Content(params, 'content')
}

function validateFileWriteHandle(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['handle'])
  const handle = requireString(params, 'handle', { min: 1, max: 128 })
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(handle)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'handle 格式无效')
  }
}

function validateFileCacheReadChunk(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['relativePath', 'offset', 'length'])
  validateFileCache({ relativePath: params.relativePath, encoding: 'base64' }, false)
  requireFileOffset(params, 'offset')
  requireInteger(params, 'length', { min: 1, max: MAX_FILE_CHUNK_BYTES })
}

function validateFileCacheWriteStart(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['relativePath', 'totalSize'])
  validateFileCache({ relativePath: params.relativePath, encoding: 'base64' }, false)
  requireInteger(params, 'totalSize', { min: 0, max: MAX_STREAM_FILE_BYTES })
}

function requirePopoutHandoffId(value: Record<string, unknown>, key: string): void {
  const id = requireString(value, key, { min: 16, max: 64 })
  if (!POPOUT_HANDOFF_ID_PATTERN.test(id)) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 格式无效`, { path: key })
  }
}

function validatePopoutHandoff(value: unknown): void {
  if (!isRecord(value)) throw new ZToolsError(errorCodes.invalidRequest, 'handoff 无效', { path: 'handoff' })
  rejectUnknownKeys(value, ['id', 'pluginId', 'featureCode', 'state', 'paths'])
  requirePopoutHandoffId(value, 'id')
  requirePluginIdentifier(value, 'pluginId')
  optionalString(value, 'featureCode', 128)
  const state = requireString(value, 'state', { min: 2, max: POPOUT_HANDOFF_MAX_STATE_BYTES })
  if (Buffer.byteLength(state, 'utf8') > POPOUT_HANDOFF_MAX_STATE_BYTES) {
    throw new ZToolsError(errorCodes.invalidRequest, 'state 超过大小上限', { path: 'state' })
  }
  if (value.paths !== undefined) {
    requireStringArray(value, 'paths', {
      maxItems: POPOUT_HANDOFF_MAX_PATHS,
      maxItemLength: POPOUT_HANDOFF_MAX_PATH_LENGTH,
      maxBytes: POPOUT_HANDOFF_MAX_PATHS_BYTES
    })
    if ((value.paths as string[]).some((item) => item.length === 0)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'paths 包含空路径', { path: 'paths' })
    }
  }
}

function requireStringArray(
  value: Record<string, unknown>,
  key: string,
  options: { maxItems: number; maxItemLength: number; maxBytes: number }
): void {
  const items = value[key]
  if (!Array.isArray(items) || items.length > options.maxItems) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 无效`)
  }
  let totalBytes = 0
  for (const item of items) {
    if (typeof item !== 'string' || item.length > options.maxItemLength || item.includes('\0')) {
      throw new ZToolsError(errorCodes.invalidRequest, `${key} 包含无效参数`)
    }
    totalBytes += Buffer.byteLength(item, 'utf8')
  }
  if (totalBytes > options.maxBytes) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 超过大小上限`)
  }
}

function validateProcessStart(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['path', 'args', 'workingDir', 'show'])
  requireFilePath(params, 'path')
  requireStringArray(params, 'args', {
    maxItems: 128,
    maxItemLength: 32 * 1024,
    maxBytes: 64 * 1024
  })
  const workingDir = requireString(params, 'workingDir', { max: 32 * 1024 })
  if (workingDir.includes('\0')) throw new ZToolsError(errorCodes.invalidRequest, 'workingDir 无效')
  requireBoolean(params, 'show')
}

function validateScreenPoint(value: unknown, key: string): void {
  if (!isRecord(value)) throw new ZToolsError(errorCodes.invalidRequest, `${key} 无效`)
  rejectUnknownKeys(value, ['x', 'y'])
  requireInteger(value, 'x', { min: -1_000_000, max: 1_000_000 })
  requireInteger(value, 'y', { min: -1_000_000, max: 1_000_000 })
}

function validateScreenRect(value: unknown, key: string): void {
  if (!isRecord(value)) throw new ZToolsError(errorCodes.invalidRequest, `${key} 无效`)
  rejectUnknownKeys(value, ['x', 'y', 'width', 'height'])
  requireInteger(value, 'x', { min: -1_000_000, max: 1_000_000 })
  requireInteger(value, 'y', { min: -1_000_000, max: 1_000_000 })
  requireInteger(value, 'width', { min: 1, max: 16_384 })
  requireInteger(value, 'height', { min: 1, max: 16_384 })
}

/** 剪贴板文本写入上限（UTF-8 字节），与 ClipboardService 保持一致 */
export const MAX_CLIPBOARD_TEXT_BYTES = 8 * 1024 * 1024

function validateClipboardText(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['text', 'tempFile'])
  const hasText = Object.hasOwn(params, 'text')
  const hasTempFile = Object.hasOwn(params, 'tempFile')
  if (hasText === hasTempFile) {
    throw new ZToolsError(errorCodes.invalidRequest, 'text 和 tempFile 必须且只能提供一个')
  }
  if (hasText) {
    // 与 ClipboardService 的 8 MiB（UTF-8 字节）上限一致；超限明确报 RESPONSE_TOO_LARGE（字符数超限时不必再算字节）
    const text = requireString(params, 'text', { min: 1, max: Number.MAX_SAFE_INTEGER })
    if (text.length > MAX_CLIPBOARD_TEXT_BYTES || Buffer.byteLength(text, 'utf8') > MAX_CLIPBOARD_TEXT_BYTES) {
      throw new ZToolsError(errorCodes.responseTooLarge, '剪贴板文本超过 8 MiB 上限', { path: 'text' })
    }
  }
  if (hasTempFile) requireFilePath(params, 'tempFile')
}

function validateClipboardImage(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['image'])
  const image = requireString(params, 'image', { min: 1, max: 23 * 1024 * 1024 })
  const comma = image.indexOf(',')
  const encoded = image.startsWith('data:') ? image.slice(comma + 1) : image
  if (
    (image.startsWith('data:') && (comma < 0 || !/^data:image\/(?:bmp|jpeg|jpg|png);base64$/i.test(image.slice(0, comma)))) ||
    !isValidFileBase64(encoded)
  ) {
    throw new ZToolsError(errorCodes.invalidRequest, 'image 不是受支持的 Base64 图片')
  }
}

function requireEnvelopeId(value: Record<string, unknown>, key: string, optional = false): void {
  const item = value[key]
  if (optional && item === undefined) return
  if (typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(item)) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 无效`)
  }
}

function validateEventEnvelope(value: unknown, request: boolean): void {
  if (!isRecord(value)) throw new ZToolsError(errorCodes.invalidRequest, 'envelope 必须是对象')
  rejectUnknownKeys(value, [
    'envelopeId',
    'version',
    'timestamp',
    'type',
    'scope',
    'channel',
    'source',
    'target',
    'payload',
    'correlationId',
    'replyTo',
    'timeout'
  ])
  requireEnvelopeId(value, 'envelopeId')
  if (value.version !== 'v1') throw new ZToolsError(errorCodes.invalidRequest, 'version 无效')
  if (!Number.isSafeInteger(value.timestamp) || (value.timestamp as number) < 0) {
    throw new ZToolsError(errorCodes.invalidRequest, 'timestamp 无效')
  }
  requireEventKey(value, 'type')
  const scope = requireString(value, 'scope', { min: 1, max: 64 })
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(scope)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'scope 无效')
  }
  if (value.channel !== undefined) {
    const channel = { channel: value.channel }
    requireEventKey(channel, 'channel')
  }
  if (!isRecord(value.source)) throw new ZToolsError(errorCodes.invalidRequest, 'source 无效')
  rejectUnknownKeys(value.source, ['kind'])
  requireString(value.source, 'kind', { min: 1, max: 32 })
  if (!isRecord(value.target)) throw new ZToolsError(errorCodes.invalidRequest, 'target 无效')
  rejectUnknownKeys(value.target, ['broadcast'])
  if (value.target.broadcast !== true) {
    throw new ZToolsError(errorCodes.invalidRequest, '当前仅支持广播事件')
  }
  if (!Object.hasOwn(value, 'payload')) {
    throw new ZToolsError(errorCodes.invalidRequest, 'payload 字段缺失')
  }
  requireSerializable(value.payload, 'payload', 256 * 1024)
  requireEnvelopeId(value, 'correlationId', true)
  requireEnvelopeId(value, 'replyTo', true)
  if (value.timeout !== undefined) {
    requireInteger(value, 'timeout', { min: 1, max: MAX_TIMEOUT_MS })
  }
  if (request && value.replyTo !== undefined) {
    throw new ZToolsError(errorCodes.invalidRequest, 'event_request 不允许 replyTo')
  }
}

function validateUserSetToken(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, [
    'token',
    'refresh_token',
    'user_id',
    'username',
    'email',
    'expires_at'
  ])
  requireString(params, 'token', { min: 1, max: 16 * 1024 })
  requireString(params, 'refresh_token', { max: 16 * 1024 })
  requireString(params, 'user_id', { min: 1, max: 128 })
  optionalString(params, 'username', 256)
  optionalString(params, 'email', 320)
  optionalString(params, 'expires_at', 64)
  if (typeof params.expires_at === 'string' && params.expires_at !== '' && !Number.isFinite(Date.parse(params.expires_at))) {
    throw new ZToolsError(errorCodes.invalidRequest, 'expires_at 无效')
  }
}

function validateAnalyticsReport(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['event', 'plugin_id', 'web_version', 'client', 'data', 'user_id'])
  requireString(params, 'event', { min: 1, max: 100 })
  requireString(params, 'plugin_id', { max: 100 })
  requireString(params, 'web_version', { max: 32 })
  optionalString(params, 'client', 32)
  if (Object.hasOwn(params, 'data')) {
    requireSerializable(params.data, 'data', 8 * 1024)
  }
  if (params.user_id !== undefined && params.user_id !== null) {
    if (typeof params.user_id !== 'string' || params.user_id.length > 64) {
      throw new ZToolsError(errorCodes.invalidRequest, 'user_id 无效', { path: 'user_id' })
    }
  }
}

function validateUpdatePackage(params: Record<string, unknown>, requirePackage: boolean): void {
  rejectUnknownKeys(params, ['type', 'version', 'downloadUrl', 'checksum', 'fileSize', 'minAppVersion'])
  if (params.type !== undefined && params.type !== 'app' && params.type !== 'web') {
    throw new ZToolsError(errorCodes.invalidRequest, 'type 无效')
  }
  const packageKeys = ['version', 'downloadUrl', 'checksum', 'fileSize'] as const
  const suppliedPackageKeys = packageKeys.filter((key) => params[key] !== undefined)
  if (!requirePackage && suppliedPackageKeys.length === 0) return
  if (suppliedPackageKeys.length !== packageKeys.length) {
    throw new ZToolsError(errorCodes.invalidRequest, '更新包字段必须完整提供')
  }
  const version = requireString(params, 'version', { min: 1, max: 64 })
  if (!/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'version 格式无效')
  }
  requireHttpUrl(params, 'downloadUrl')
  const checksum = requireString(params, 'checksum', { max: 128 })
  if (checksum !== '' && !/^(?:sha256:)?[a-f0-9]{64}$/i.test(checksum)) {
    throw new ZToolsError(errorCodes.invalidRequest, 'checksum 必须为空或 SHA-256')
  }
  requireInteger(params, 'fileSize', { min: 0, max: 2 * 1024 * 1024 * 1024 })
  if (params.minAppVersion !== undefined) {
    const minAppVersion = requireString(params, 'minAppVersion', { min: 1, max: 64 })
    if (!/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(minAppVersion)) {
      throw new ZToolsError(errorCodes.invalidRequest, 'minAppVersion 格式无效')
    }
  }
}

function validatePrivilegedExecute(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, ['cmd', 'args', 'cwd', 'timeout', 'show'])
  requireString(params, 'cmd', { min: 1, max: 1024 })
  if (params.args !== undefined) {
    requireStringArray(params, 'args', {
      maxItems: 128,
      maxItemLength: 32 * 1024,
      maxBytes: 128 * 1024
    })
  }
  optionalString(params, 'cwd', 32 * 1024)
  if (params.timeout !== undefined) {
    requireInteger(params, 'timeout', { min: 1, max: 120_000 })
  }
  if (params.show !== undefined) requireBoolean(params, 'show')
}

function requireTriggerIdentifier(value: Record<string, unknown>, key: string): string {
  const identifier = requireString(value, key, { min: 1, max: 128 })
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(identifier)) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} 格式无效`)
  }
  return identifier
}

const ELECTRON_ACCELERATOR_MODIFIERS = new Set([
  'command', 'cmd',
  'control', 'ctrl',
  'commandorcontrol', 'cmdorctrl',
  'alt', 'option', 'altgr', 'shift',
  'super', 'meta'
])

const ELECTRON_ACCELERATOR_KEY_CODES = new Set([
  'plus', 'space', 'tab', 'capslock', 'numlock', 'scrolllock',
  'backspace', 'delete', 'insert', 'return', 'enter',
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown',
  'escape', 'esc', 'volumeup', 'volumedown', 'volumemute',
  'medianexttrack', 'mediaprevioustrack', 'mediastop', 'mediaplaypause',
  'printscreen', 'numdec', 'numadd', 'numsub', 'nummult', 'numdiv'
])

const ELECTRON_ACCELERATOR_PUNCTUATION = new Set([
  ')', '!', '@', '#', '$', '%', '^', '&', '*', '(', ':', ';', '=', '<',
  ',', '_', '-', '>', '.', '?', '/', '~', '`', '{', '}', ']', '[', '|',
  '\\', '"', "'"
])

function isElectronAcceleratorKeyCode(token: string): boolean {
  const keyCode = token.toLowerCase()
  return /^[0-9]$/.test(keyCode) ||
    /^[a-z]$/.test(keyCode) ||
    /^f(?:[1-9]|1[0-9]|2[0-4])$/.test(keyCode) ||
    /^num[0-9]$/.test(keyCode) ||
    ELECTRON_ACCELERATOR_KEY_CODES.has(keyCode) ||
    ELECTRON_ACCELERATOR_PUNCTUATION.has(token)
}

/**
 * Checks Electron 43.4.1's accelerator tokens without relying on
 * globalShortcut.register() exceptions, whose wording is not a stable API.
 */
export function isValidElectronAccelerator(value: string): boolean {
  if (value.length === 0 || /[\0-\x20\x7f]/.test(value.replace(/[\t ]/g, ''))) return false

  const tokens = value.split('+').map((token) => token.trim())
  if (tokens.some((token) => token === '')) return false

  let keyCodeFound = false
  for (const token of tokens) {
    if (!token) return false
    const normalized = token.toLowerCase()
    if (ELECTRON_ACCELERATOR_MODIFIERS.has(normalized)) continue
    if (keyCodeFound || !isElectronAcceleratorKeyCode(token)) {
      return false
    }
    keyCodeFound = true
  }
  return keyCodeFound
}

function requireHotkey(value: Record<string, unknown>, key: string): string {
  const hotkey = requireString(value, key, { min: 1, max: 128 }).trim()
  if (!isValidElectronAccelerator(hotkey)) {
    throw new ZToolsError(errorCodes.invalidRequest, `${key} Electron 快捷键格式无效`)
  }
  return hotkey
}

function validateTriggerAction(value: unknown): void {
  if (!isRecord(value)) throw new ZToolsError(errorCodes.invalidRequest, 'action 必须是对象')
  rejectUnknownKeys(value, ['mode', 'target', 'params'])
  if (!['builtin', 'dll', 'script', 'window'].includes(String(value.mode))) {
    throw new ZToolsError(errorCodes.invalidRequest, 'action.mode 无效')
  }
  requireString(value, 'target', { min: 1, max: 256 })
  if (!isRecord(value.params)) throw new ZToolsError(errorCodes.invalidRequest, 'action.params 必须是对象')
  requireSerializable(value.params, 'action.params', 64 * 1024)
}

function requireTriggerOwnerIdentifier(params: Record<string, unknown>, key: string): void {
  const value = requireString(params, key, { min: 1, max: 128 })
  if (/^localapp:[A-F0-9]{8}$/i.test(value)) return
  requirePluginIdentifier(params, key)
}

function validateTriggerRegister(params: Record<string, unknown>): void {
  rejectUnknownKeys(params, [
    'id',
    'pluginId',
    'type',
    'enabled',
    'config',
    'action',
    'actionMode',
    'actionTarget',
    'actionParams',
    'priority'
  ])
  if (params.id !== undefined) requireTriggerIdentifier(params, 'id')
  if (!['hotkey', 'timer', 'hook', 'clipboard', 'network'].includes(String(params.type))) {
    throw new ZToolsError(errorCodes.invalidRequest, 'type 无效')
  }
  requireBoolean(params, 'enabled')
  if (!isRecord(params.config)) throw new ZToolsError(errorCodes.invalidRequest, 'config 必须是对象')
  requireSerializable(params.config, 'config', 64 * 1024)
  if (params.type === 'hotkey') {
    rejectUnknownKeys(params.config, ['key'])
    requireHotkey(params.config, 'key')
  }

  const hasNestedAction = params.action !== undefined
  const hasFlatAction = ['actionMode', 'actionTarget', 'actionParams'].some((key) => params[key] !== undefined)
  if (hasNestedAction === hasFlatAction) {
    throw new ZToolsError(errorCodes.invalidRequest, 'action 必须使用嵌套或扁平格式之一')
  }
  if (hasNestedAction) {
    validateTriggerAction(params.action)
  } else {
    validateTriggerAction({
      mode: params.actionMode,
      target: params.actionTarget,
      params: params.actionParams
    })
  }
  const action = hasNestedAction ? params.action as Record<string, unknown> : {
    mode: params.actionMode, target: params.actionTarget, params: params.actionParams
  }
  if (action.mode === 'builtin' && action.target === 'launch_local_app') {
    const actionParams = action.params as Record<string, unknown>
    rejectUnknownKeys(actionParams, ['appId'])
    const appId = requireString(actionParams, 'appId', { min: 1, max: 128 })
    if (params.type !== 'hotkey' || !/^localapp:[A-F0-9]{8}$/i.test(appId) || params.pluginId !== appId) {
      throw new ZToolsError(errorCodes.invalidRequest, '本地应用快捷键必须绑定同一已保存 Windows 应用 ID')
    }
  } else {
    requirePluginIdentifier(params, 'pluginId')
  }
  if (params.priority !== undefined) {
    requireInteger(params, 'priority', { min: -1_000_000, max: 1_000_000 })
  }
}

export function validateMethodParams(method: AllowedMethod, params: unknown): void {
  if (!isRecord(params)) throw new ZToolsError(errorCodes.invalidRequest, '方法参数必须是对象')
  switch (method) {
    case 'app_ready':
      rejectUnknownKeys(params, ['status'])
      if (params.status !== 'initialized') {
        throw new ZToolsError(errorCodes.invalidRequest, 'app_ready.status 无效')
      }
      return
    case 'diagnostics_get':
      rejectUnknownKeys(params, ['requestIds'])
      if (params.requestIds !== undefined) {
        if (!Array.isArray(params.requestIds) || params.requestIds.length > 64 ||
            params.requestIds.some(value => typeof value !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(value))) {
          throw new ZToolsError(errorCodes.invalidRequest, 'diagnostics_get.requestIds 无效')
        }
      }
      return
    case 'config_get':
      rejectUnknownKeys(params, ['file', 'path', 'default'])
      requireString(params, 'file', { min: 1, max: 64 })
      requireConfigPath(params, 'path')
      requireSerializable(params.default, 'default', 512 * 1024)
      return
    case 'config_set':
      rejectUnknownKeys(params, ['file', 'path', 'value', 'sync_enabled'])
      requireString(params, 'file', { min: 1, max: 64 })
      requireConfigPath(params, 'path')
      requireString(params, 'value', { max: 512 * 1024 })
      if (typeof params.sync_enabled !== 'boolean') {
        throw new ZToolsError(errorCodes.invalidRequest, 'sync_enabled 无效')
      }
      return
    case 'settings_get':
      rejectUnknownKeys(params, ['key'])
      requireConfigPath(params, 'key')
      return
    case 'settings_set':
      rejectUnknownKeys(params, ['key', 'value'])
      requireConfigPath(params, 'key')
      if (!Object.hasOwn(params, 'value') || params.value === undefined) {
        throw new ZToolsError(errorCodes.invalidRequest, 'value 字段缺失')
      }
      return
    case 'features_get':
      rejectUnknownKeys(params, ['key'])
      if (params.key !== undefined) {
        requireString(params, 'key', { min: 1, max: 64 })
      }
      return
    case 'features_set':
      rejectUnknownKeys(params, ['key', 'enabled', 'features'])
      if (params.key !== undefined) {
        requireString(params, 'key', { min: 1, max: 64 })
        if (typeof params.enabled !== 'boolean') {
          throw new ZToolsError(errorCodes.invalidRequest, 'enabled 必须是布尔值')
        }
      }
      if (params.features !== undefined) {
        if (typeof params.features !== 'object' || params.features === null || Array.isArray(params.features)) {
          throw new ZToolsError(errorCodes.invalidRequest, 'features 必须是对象')
        }
      }
      return
    case 'user_get_info':
    case 'user_logout':
      rejectUnknownKeys(params, [])
      return
    case 'user_set_token':
      validateUserSetToken(params)
      return
    case 'analytics_report':
      validateAnalyticsReport(params)
      return
    case 'plugin_list_get':
      rejectUnknownKeys(params, [])
      return
    case 'plugin_refresh':
      rejectUnknownKeys(params, [])
      return
    case 'plugin_toggle':
      rejectUnknownKeys(params, ['pluginId'])
      requirePluginIdentifier(params, 'pluginId')
      return
    case 'plugin_create_shortcut':
      rejectUnknownKeys(params, ['pluginId'])
      requirePluginIdentifier(params, 'pluginId')
      return
    case 'plugin_refresh_icon':
      rejectUnknownKeys(params, ['pluginId', 'iconUrl'])
      requirePluginIdentifier(params, 'pluginId')
      requireString(params, 'iconUrl', { min: 1, max: 32 * 1024 })
      return
    case 'plugin_open':
      rejectUnknownKeys(params, ['pluginId', 'payload'])
      requirePluginIdentifier(params, 'pluginId')
      if (params.payload !== undefined) {
        if (!isRecord(params.payload)) {
          throw new ZToolsError(errorCodes.invalidRequest, 'payload 必须是对象')
        }
        requireSerializable(params.payload, 'payload', 64 * 1024)
      }
      return
    case 'plugin_window_close':
      rejectUnknownKeys(params, ['pluginId', 'instanceId'])
      requirePluginIdentifier(params, 'pluginId')
      if (params.instanceId !== undefined) requirePluginInstanceId(params, 'instanceId')
      return
    case 'plugin_uninstall':
      rejectUnknownKeys(params, ['pluginId'])
      requirePluginIdentifier(params, 'pluginId')
      return
    case 'plugin_data_list':
      rejectUnknownKeys(params, ['pluginId'])
      requirePluginIdentifier(params, 'pluginId')
      return
    case 'plugin_data_restore':
      rejectUnknownKeys(params, ['pluginId', 'preservationId', 'assets'])
      requirePluginIdentifier(params, 'pluginId')
      requireString(params, 'preservationId', { min: 1, max: 256 })
      if (!Array.isArray(params.assets) || params.assets.length === 0 || params.assets.length > 256) {
        throw new ZToolsError(errorCodes.invalidRequest, 'assets 必须是 1 到 256 项')
      }
      requireStringArray(params, 'assets', {
        maxItems: 256,
        maxItemLength: 4096,
        maxBytes: 1024 * 1024
      })
      return
    case 'plugin_install':
    case 'plugin_update': {
      rejectUnknownKeys(params, ['pluginId', 'url', 'version', 'checksum', 'fileSize'])
      requirePluginIdentifier(params, 'pluginId')
      requireHttpUrl(params, 'url')
      const version = requireString(params, 'version', { min: 1, max: 64 })
      if (!/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
        throw new ZToolsError(errorCodes.invalidRequest, 'version 格式无效')
      }
      optionalString(params, 'checksum', 128)
      if (typeof params.checksum === 'string' && params.checksum !== '' && !/^(?:sha256:)?[a-f0-9]{64}$/i.test(params.checksum)) {
        throw new ZToolsError(errorCodes.invalidRequest, 'checksum 必须是 SHA-256')
      }
      requireInteger(params, 'fileSize', { min: 0, max: 100 * 1024 * 1024 })
      return
    }
    case 'update_check':
      rejectUnknownKeys(params, ['source'])
      if (params.source !== 'startup' && params.source !== 'manual') {
        throw new ZToolsError(errorCodes.invalidRequest, 'source 无效')
      }
      return
    case 'update_get_version':
    case 'update_cancel':
    case 'builtin_restart_explorer':
      rejectUnknownKeys(params, [])
      return
    case 'update_download_start':
      validateUpdatePackage(params, true)
      return
    case 'update_install_start':
      validateUpdatePackage(params, false)
      return
    case 'privileged_execute':
      validatePrivilegedExecute(params)
      return
    case 'builtin_reg_write':
      rejectUnknownKeys(params, ['path', 'name', 'value', 'view'])
      requireString(params, 'path', { min: 1, max: 4096 })
      requireString(params, 'name', { max: 1024 })
      requireString(params, 'value', { max: 768 * 1024 })
      if (params.view !== 32 && params.view !== 64) {
        throw new ZToolsError(errorCodes.invalidRequest, 'view 无效')
      }
      return
    case 'builtin_reg_delete':
      rejectUnknownKeys(params, ['path', 'name', 'view'])
      requireString(params, 'path', { min: 1, max: 4096 })
      requireString(params, 'name', { max: 1024 })
      if (params.view !== 32 && params.view !== 64) {
        throw new ZToolsError(errorCodes.invalidRequest, 'view 无效')
      }
      return
    case 'builtin_file_write':
      rejectUnknownKeys(params, ['path', 'content'])
      requireFilePath(params, 'path')
      requireString(params, 'content', { max: 768 * 1024 })
      return
    case 'trigger_register':
      validateTriggerRegister(params)
      return
    case 'trigger_unregister':
      rejectUnknownKeys(params, ['triggerId'])
      requireTriggerIdentifier(params, 'triggerId')
      return
    case 'trigger_list':
      rejectUnknownKeys(params, ['pluginId'])
      if (params.pluginId !== '') requireTriggerOwnerIdentifier(params, 'pluginId')
      return
    case 'trigger_set_enabled':
      rejectUnknownKeys(params, ['triggerId', 'enabled'])
      requireTriggerIdentifier(params, 'triggerId')
      requireBoolean(params, 'enabled')
      return
    case 'trigger_check_conflict':
      rejectUnknownKeys(params, ['key', 'pluginId'])
      requireHotkey(params, 'key')
      if (params.pluginId !== '') requireTriggerOwnerIdentifier(params, 'pluginId')
      return
    case 'system_notify':
      rejectUnknownKeys(params, ['title', 'message', 'modal'])
      requireString(params, 'title', { max: 256 })
      requireString(params, 'message', { min: 1, max: 16 * 1024 })
      requireBoolean(params, 'modal')
      return
    case 'system_set_dark_mode':
      rejectUnknownKeys(params, ['dark'])
      requireBoolean(params, 'dark')
      return
    case 'get_system_info':
    case 'system_get_native_id':
    case 'system_get_app_name':
    case 'system_get_app_version':
    case 'system_get_autostart':
    case 'system_read_current_folder':
    case 'system_read_current_browser_url':
    case 'system_is_dev':
    case 'system_get_platform':
    case 'system_get_runtime_identity':
    case 'system_lock':
    case 'system_sleep':
    case 'system_hibernate':
    case 'system_get_hardware_summary':
    case 'system_get_cpu_usage':
    case 'system_get_memory_usage':
    case 'system_get_network_stats':
    case 'system_get_battery_status':
    case 'system_reload_hotkeys':
    case 'system_get_panel_local_apps':
      rejectUnknownKeys(params, [])
      return
    case 'runtime_capability_get': {
      rejectUnknownKeys(params, ['capability'])
      const capability = requireString(params, 'capability', { min: 1, max: 128 })
      if (!isRuntimeCapabilityId(capability)) {
        throw new ZToolsError(errorCodes.invalidRequest, '未知运行时能力')
      }
      return
    }
    case 'runtime_capability_request':
    case 'runtime_capability_revoke': {
      rejectUnknownKeys(params, ['capability'])
      const capability = requireString(params, 'capability', { min: 1, max: 128 })
      if (!isRuntimeCapabilityId(capability)) {
        throw new ZToolsError(errorCodes.invalidRequest, '未知运行时能力')
      }
      return
    }
    case 'runtime_capability_grants_list':
      rejectUnknownKeys(params, [])
      return
    case 'runtime_capability_grant_revoke':
      rejectUnknownKeys(params, ['grantId'])
      requireString(params, 'grantId', { min: 32, max: 128 })
      return
    case 'system_get_path':
      rejectUnknownKeys(params, ['name'])
      if (![
        'app', 'home', 'appData', 'userData', 'temp', 'desktop',
        'documents', 'downloads', 'music', 'pictures', 'videos', 'cache'
      ].includes(String(params.name))) {
        throw new ZToolsError(errorCodes.invalidRequest, 'name 无效')
      }
      return
    case 'system_list_common_folders':
      rejectUnknownKeys(params, [])
      return
    case 'system_get_file_icon':
      rejectUnknownKeys(params, ['filePath'])
      requireFilePath(params, 'filePath')
      return
    case 'system_search_files':
      rejectUnknownKeys(params, ['query', 'limit'])
      requireString(params, 'query', { min: 0, max: 512 })
      if (params.limit !== undefined) {
        requireInteger(params, 'limit', { min: 1, max: 200 })
      }
      return
    case 'system_shutdown':
      rejectUnknownKeys(params, ['force', 'timeout'])
      requireBoolean(params, 'force')
      requireInteger(params, 'timeout', { min: 0, max: 86_400 })
      return
    case 'system_restart':
    case 'system_logout':
      rejectUnknownKeys(params, ['force'])
      requireBoolean(params, 'force')
      return
    case 'system_prevent_sleep':
      rejectUnknownKeys(params, ['enable'])
      requireBoolean(params, 'enable')
      return
    case 'system_simulate_key_press':
      rejectUnknownKeys(params, ['key'])
      requireString(params, 'key', { min: 1, max: 64 })
      return
    case 'system_simulate_key_combo':
      rejectUnknownKeys(params, ['keys'])
      requireString(params, 'keys', { min: 1, max: 256 })
      return
    case 'system_simulate_text':
      rejectUnknownKeys(params, ['text'])
      requireString(params, 'text', { min: 1, max: 64 * 1024 })
      return
    case 'system_simulate_mouse_move':
      rejectUnknownKeys(params, ['x', 'y'])
      requireInteger(params, 'x', { min: -1_000_000, max: 1_000_000 })
      requireInteger(params, 'y', { min: -1_000_000, max: 1_000_000 })
      return
    case 'system_simulate_mouse_click': {
      rejectUnknownKeys(params, ['button', 'x', 'y'])
      if (!['left', 'right', 'middle'].includes(String(params.button))) {
        throw new ZToolsError(errorCodes.invalidRequest, 'button 无效')
      }
      const hasX = params.x !== undefined
      const hasY = params.y !== undefined
      if (hasX !== hasY) throw new ZToolsError(errorCodes.invalidRequest, 'x 和 y 必须同时提供')
      if (hasX) {
        requireInteger(params, 'x', { min: -1_000_000, max: 1_000_000 })
        requireInteger(params, 'y', { min: -1_000_000, max: 1_000_000 })
      }
      return
    }
    case 'system_simulate_mouse_wheel':
      rejectUnknownKeys(params, ['delta'])
      requireInteger(params, 'delta', { min: -1_000_000, max: 1_000_000 })
      return
    case 'system_get_disk_usage':
      rejectUnknownKeys(params, ['drive'])
      if (params.drive !== undefined) {
        const drive = requireString(params, 'drive', { min: 1, max: 4096 })
        if (/[\u0000-\u001f\u007f]/.test(drive) || !(/^[A-Za-z]:[\\/]/.test(drive) || drive.startsWith('/'))) {
          throw new ZToolsError(errorCodes.invalidRequest, 'drive 必须是绝对卷路径')
        }
      }
      return
    case 'dllplugin_list':
      rejectUnknownKeys(params, [])
      return
    case 'dllplugin_call':
    case 'dllplugin_call_async':
    case 'dllplugin_call_with_callback':
      validateDllPluginCall(params)
      return
    case 'dllplugin_query_task':
    case 'dllplugin_cancel_task':
      rejectUnknownKeys(params, ['plugin', 'taskId'])
      requirePluginIdentifier(params, 'plugin')
      requireDllTaskId(params)
      return
    case 'dllplugin_clear_callback_task':
      rejectUnknownKeys(params, ['taskId'])
      requireDllTaskId(params)
      return
    case 'window_open':
      rejectUnknownKeys(params, ['url', 'handoff'])
      requireString(params, 'url', { min: 1, max: 2048 })
      if (params.handoff !== undefined) validatePopoutHandoff(params.handoff)
      return
    case 'window_redirect':
      rejectUnknownKeys(params, ['url'])
      requireString(params, 'url', { min: 1, max: 2048 })
      return
    case 'window_popout_handoff_take':
      rejectUnknownKeys(params, ['handoffId'])
      requirePopoutHandoffId(params, 'handoffId')
      return
    case 'window_close':
    case 'window_minimize':
    case 'window_maximize':
    case 'window_fullscreen_toggle':
    case 'window_drag':
    case 'window_hide':
    case 'window_show':
    case 'pluginwin_hide':
    case 'pluginwin_show':
    case 'pluginwin_minimize':
    case 'pluginwin_restore':
    case 'window_out_plugin':
    case 'window_get_bounds':
    case 'window_hide_tooltip':
    case 'window_toggle_devtools':
      rejectUnknownKeys(params, [])
      return
    case 'window_set_height':
      rejectUnknownKeys(params, ['height'])
      requireInteger(params, 'height', { min: 1, max: 8192 })
      return
    case 'window_show_open_dialog':
      validateDialogParams(params, 'open')
      return
    case 'window_show_save_dialog':
      validateDialogParams(params, 'save')
      return
    case 'window_show_select_folder_dialog':
      validateDialogParams(params, 'folder')
      return
    case 'window_set_size':
      rejectUnknownKeys(params, ['width', 'height', 'animate'])
      requireInteger(params, 'width', { min: 1, max: 8192 })
      requireInteger(params, 'height', { min: 1, max: 8192 })
      requireBoolean(params, 'animate')
      return
    case 'window_set_opacity':
      rejectUnknownKeys(params, ['opacity'])
      if (typeof params.opacity !== 'number' || !Number.isFinite(params.opacity) || params.opacity < 0 || params.opacity > 1) {
        throw new ZToolsError(errorCodes.invalidRequest, 'opacity 超出范围')
      }
      return
    case 'window_set_always_on_top':
      rejectUnknownKeys(params, ['alwaysOnTop'])
      requireBoolean(params, 'alwaysOnTop')
      return
    case 'window_show_tooltip':
      rejectUnknownKeys(params, ['text'])
      requireString(params, 'text', { min: 1, max: 1024 })
      return
    case 'window_show_record_bar':
      rejectUnknownKeys(params, ['duration', 'taskId'])
      if (params.duration !== undefined && (typeof params.duration !== 'number' || !Number.isFinite(params.duration) || params.duration < 0)) {
        throw new ZToolsError(errorCodes.invalidRequest, 'duration 必须为非负数字')
      }
      if (params.taskId !== undefined && (typeof params.taskId !== 'string' || params.taskId.length > 256)) {
        throw new ZToolsError(errorCodes.invalidRequest, 'taskId 无效')
      }
      return
    case 'window_update_record_bar':
      rejectUnknownKeys(params, ['duration', 'status'])
      if (params.duration !== undefined && (typeof params.duration !== 'number' || !Number.isFinite(params.duration) || params.duration < 0)) {
        throw new ZToolsError(errorCodes.invalidRequest, 'duration 必须为非负数字')
      }
      if (params.status !== undefined && typeof params.status !== 'string') {
        throw new ZToolsError(errorCodes.invalidRequest, 'status 必须为字符串')
      }
      return
    case 'window_hide_record_bar':
      rejectUnknownKeys(params, [])
      return
    case 'ui_close_confirm_result':
      rejectUnknownKeys(params, ['confirmed', 'doNotAskAgain', 'action'])
      requireBoolean(params, 'confirmed')
      requireBoolean(params, 'doNotAskAgain')
      if (params.action !== 'exit' && params.action !== 'minimize' && params.action !== 'cancel') {
        throw new ZToolsError(errorCodes.invalidRequest, 'action 无效')
      }
      return
    case 'event_subscribe':
    case 'event_unsubscribe':
      rejectUnknownKeys(params, ['key'])
      requireEventKey(params, 'key')
      return
    case 'event_publish':
    case 'event_request':
      rejectUnknownKeys(params, ['envelope'])
      validateEventEnvelope(params.envelope, method === 'event_request')
      return
    case 'network_http_request':
      validateNetworkRequest(params)
      return
    case 'network_http_download':
      validateNetworkTransfer(params, false)
      return
    case 'network_http_upload':
      validateNetworkTransfer(params, true)
      return
    case 'network_set_cookie':
      validateNetworkCookie(params)
      return
    case 'network_get_cookie':
      rejectUnknownKeys(params, ['url'])
      requireHttpUrl(params, 'url')
      return
    case 'network_clear_cookies':
      rejectUnknownKeys(params, [])
      return
    case 'network_set_proxy':
      validateNetworkProxy(params)
      return
    case 'filesystem_read_file':
      validateFileRead(params)
      return
    case 'filesystem_write_file':
      validateFileWrite(params)
      return
    case 'filesystem_read_cache':
      validateFileCache(params, false)
      return
    case 'filesystem_write_cache':
      validateFileCache(params, true)
      return
    case 'filesystem_read_file_chunk':
      validateFileReadChunk(params)
      return
    case 'filesystem_read_cache_chunk':
      validateFileCacheReadChunk(params)
      return
    case 'filesystem_write_file_start':
      validateFileWriteStart(params)
      return
    case 'filesystem_write_cache_start':
      validateFileCacheWriteStart(params)
      return
    case 'filesystem_write_file_chunk':
    case 'filesystem_write_cache_chunk':
      validateFileWriteChunk(params)
      return
    case 'filesystem_write_file_end':
    case 'filesystem_write_cache_end':
    case 'filesystem_write_file_cancel':
    case 'filesystem_write_cache_cancel':
      validateFileWriteHandle(params)
      return
    case 'filesystem_delete_file':
    case 'filesystem_file_exists':
    case 'filesystem_get_file_size':
    case 'filesystem_create_directory':
    case 'filesystem_delete_directory':
    case 'filesystem_directory_exists':
    case 'filesystem_get_directory_contents':
    case 'filesystem_set_current_directory':
    case 'filesystem_get_full_path':
    case 'filesystem_get_file_name':
    case 'filesystem_get_extension':
    case 'filesystem_get_parent_directory':
      rejectUnknownKeys(params, ['path'])
      requireFilePath(params, 'path')
      return
    case 'filesystem_copy_file':
    case 'filesystem_move_file':
      rejectUnknownKeys(params, ['sourcePath', 'destPath'])
      requireFilePath(params, 'sourcePath')
      requireFilePath(params, 'destPath')
      return
    case 'filesystem_get_current_directory':
      rejectUnknownKeys(params, [])
      return
    case 'filesystem_find_files':
    case 'filesystem_find_directories':
      rejectUnknownKeys(params, ['path', 'pattern'])
      requireFilePath(params, 'path')
      requireString(params, 'pattern', { min: 1, max: 256 })
      if (/[\\/\0]/.test(String(params.pattern))) {
        throw new ZToolsError(errorCodes.invalidRequest, 'pattern 无效')
      }
      return
    case 'filesystem_combine_path':
      rejectUnknownKeys(params, ['path1', 'path2'])
      requireFilePath(params, 'path1')
      requireFilePath(params, 'path2')
      return
    case 'shell_open_path':
    case 'shell_trash_item':
    case 'shell_show_item_in_folder':
      rejectUnknownKeys(params, ['fullPath'])
      requireFilePath(params, 'fullPath')
      return
    case 'shell_open_external':
      rejectUnknownKeys(params, ['url'])
      requireHttpUrl(params, 'url')
      return
    case 'shell_beep':
    case 'process_list_ports':
      rejectUnknownKeys(params, [])
      return
    case 'process_list':
      rejectUnknownKeys(params, ['limit'])
      return
    case 'shell_exec':
      rejectUnknownKeys(params, ['command'])
      requireString(params, 'command', { min: 1, max: 32 * 1024 })
      return
    case 'process_info':
    case 'process_get_window':
      rejectUnknownKeys(params, ['pid'])
      requireInteger(params, 'pid', { min: 1, max: 0xffff_ffff })
      return
    case 'process_exists':
      rejectUnknownKeys(params, ['nameOrPid'])
      requireString(params, 'nameOrPid', { min: 1, max: 260 })
      return
    case 'process_find':
      rejectUnknownKeys(params, ['name'])
      requireString(params, 'name', { min: 1, max: 260 })
      return
    case 'process_start':
      validateProcessStart(params)
      return
    case 'process_kill':
      rejectUnknownKeys(params, ['pid', 'force'])
      requireInteger(params, 'pid', { min: 1, max: 0xffff_ffff })
      requireBoolean(params, 'force')
      return
    case 'process_terminate_pid':
      rejectUnknownKeys(params, ['pid', 'mode', 'tree', 'timeoutMs', 'expectedName'])
      // 0/1（launchd/init）与负数（进程组）一律拒绝
      requireInteger(params, 'pid', { min: 2, max: 0xffff_ffff })
      if (params.mode !== 'graceful' && params.mode !== 'force') {
        throw new ZToolsError(errorCodes.invalidRequest, 'mode 无效', { path: 'mode' })
      }
      if (params.tree !== undefined) requireBoolean(params, 'tree')
      if (params.timeoutMs !== undefined) {
        requireInteger(params, 'timeoutMs', {
          min: PROCESS_TERMINATE_MIN_TIMEOUT_MS,
          max: PROCESS_TERMINATE_MAX_TIMEOUT_MS
        })
      }
      if (params.expectedName !== undefined) {
        const expectedName = requireString(params, 'expectedName', { min: 1, max: 260 })
        if (expectedName.includes('\0')) {
          throw new ZToolsError(errorCodes.invalidRequest, 'expectedName 无效', { path: 'expectedName' })
        }
      }
      return
    case 'declarative_session_open':
      rejectUnknownKeys(params, ['pluginId', 'featureCode'])
      requireString(params, 'pluginId', { min: 1, max: 128 })
      optionalString(params, 'featureCode', 128)
      return
    case 'declarative_session_close':
      rejectUnknownKeys(params, ['sessionId'])
      if (!DECLARATIVE_SESSION_ID_PATTERN.test(requireString(params, 'sessionId', { min: 1, max: 64 }))) {
        throw new ZToolsError(errorCodes.invalidRequest, 'sessionId 无效', { path: 'sessionId' })
      }
      return
    case 'process_kill_by_name':
      rejectUnknownKeys(params, ['name', 'force'])
      const processName = requireString(params, 'name', { min: 1, max: 260 })
      if (/[\\/\0]/.test(processName)) {
        throw new ZToolsError(errorCodes.invalidRequest, 'name 必须是进程名')
      }
      requireBoolean(params, 'force')
      return
    case 'system_set_autostart':
      rejectUnknownKeys(params, ['enabled'])
      requireBoolean(params, 'enabled')
      return
    case 'process_wait':
      rejectUnknownKeys(params, ['pid', 'timeout'])
      requireInteger(params, 'pid', { min: 1, max: 0xffff_ffff })
      requireInteger(params, 'timeout', { min: 0, max: 120_000 })
      return
    case 'process_run_ffmpeg':
      rejectUnknownKeys(params, ['args'])
      requireStringArray(params, 'args', {
        maxItems: 256,
        maxItemLength: 32 * 1024,
        maxBytes: 128 * 1024
      })
      return
    case 'screen_capture':
      rejectUnknownKeys(params, ['rect'])
      if (params.rect !== undefined) validateScreenRect(params.rect, 'rect')
      return
    case 'screen_get_cursor_pos':
    case 'screen_get_primary_display':
    case 'screen_get_all_displays':
    case 'clipboard_read_text':
    case 'clipboard_read_image':
    case 'clipboard_read_files':
    case 'clipboard_clear':
      rejectUnknownKeys(params, [])
      return
    case 'db_put':
      validateDatabasePut(params)
      return
    case 'db_get':
      rejectUnknownKeys(params, ['plugin_id', 'key', 'is_base64'])
      requireDatabasePluginId(params)
      requireDatabaseKey(params)
      if (params.is_base64 !== undefined && typeof params.is_base64 !== 'boolean') {
        throw new ZToolsError(errorCodes.invalidRequest, 'is_base64 无效')
      }
      return
    case 'db_delete':
    case 'db_exists':
    case 'db_get_secure':
      rejectUnknownKeys(params, ['plugin_id', 'key'])
      requireDatabasePluginId(params)
      requireDatabaseKey(params)
      return
    case 'db_query':
      rejectUnknownKeys(params, ['plugin_id', 'prefix', 'limit'])
      requireDatabasePluginId(params)
      if (requireString(params, 'prefix', { max: 8192 }).includes('\0')) {
        throw new ZToolsError(errorCodes.invalidRequest, 'prefix 包含空字符')
      }
      requireInteger(params, 'limit', { min: 0, max: 10_000 })
      return
    case 'db_batch':
      validateDatabaseBatch(params)
      return
    case 'db_put_secure':
      rejectUnknownKeys(params, ['plugin_id', 'key', 'value'])
      requireDatabasePluginId(params)
      requireDatabaseKey(params)
      requireString(params, 'value', { max: 1024 * 1024 })
      return
    case 'credential_v1_status':
      rejectUnknownKeys(params, [])
      return
    case 'credential_v1_get':
    case 'credential_v1_delete':
      rejectUnknownKeys(params, ['key'])
      requireCredentialKey(params)
      return
    case 'credential_v1_set':
      rejectUnknownKeys(params, ['key', 'value', 'ifAbsent'])
      requireCredentialKey(params)
      requireString(params, 'value', { max: 64 * 1024 })
      if (params.ifAbsent !== undefined) requireBoolean(params, 'ifAbsent')
      return
    case 'db_compact':
      rejectUnknownKeys(params, ['plugin_id'])
      requireDatabasePluginId(params)
      return
    case 'screen_get_display_nearest':
      rejectUnknownKeys(params, ['point'])
      validateScreenPoint(params.point, 'point')
      return
    case 'screen_get_display_matching':
      rejectUnknownKeys(params, ['rect'])
      validateScreenRect(params.rect, 'rect')
      return
    case 'clipboard_copy_text':
    case 'clipboard_hide_and_paste_text':
      validateClipboardText(params)
      return
    case 'clipboard_copy_image':
    case 'clipboard_hide_and_paste_image':
      validateClipboardImage(params)
      return
    case 'clipboard_copy_file':
    case 'clipboard_hide_and_paste_file':
      rejectUnknownKeys(params, ['filePath'])
      requireFilePath(params, 'filePath')
      return
    case 'clipboard_copy_files':
      rejectUnknownKeys(params, ['filePaths'])
      requireStringArray(params, 'filePaths', {
        maxItems: 256,
        maxItemLength: 32 * 1024,
        maxBytes: 128 * 1024
      })
      if ((params.filePaths as string[]).length === 0) {
        throw new ZToolsError(errorCodes.invalidRequest, 'filePaths 不能为空')
      }
      return
    case 'clipboard_hide_and_type':
      rejectUnknownKeys(params, ['text'])
      requireString(params, 'text', { min: 1, max: 256 * 1024 })
      return
    case 'plugin_revoke':
      rejectUnknownKeys(params, ['pluginId', 'revoked', 'reason'])
      requireString(params, 'pluginId', { min: 1, max: 64 })
      if (typeof params.revoked !== 'boolean') {
        throw new ZToolsError(errorCodes.invalidRequest, 'revoked 必须是布尔值')
      }
      if (params.reason !== undefined) {
        requireString(params, 'reason', { min: 1, max: 512 })
      }
      return
    case 'clipboard_history_query':
      rejectUnknownKeys(params, ['query', 'limit', 'offset'])
      return
    case 'clipboard_history_toggle_pin':
    case 'clipboard_history_delete':
      rejectUnknownKeys(params, ['id', 'pinned'])
      requireString(params, 'id', { min: 1, max: 64 })
      return
    case 'clipboard_history_clear_unpinned':
    case 'clipboard_history_paste_sequential':
    case 'clipboard_history_reset_sequence':
      rejectUnknownKeys(params, [])
      return
    case 'snippets_list':
      rejectUnknownKeys(params, ['query'])
      return
    case 'snippets_create':
    case 'snippets_update':
      return
    case 'snippets_delete':
    case 'snippets_toggle':
      rejectUnknownKeys(params, ['id'])
      requireString(params, 'id', { min: 1, max: 64 })
      return
    case 'snippets_match_and_expand':
      rejectUnknownKeys(params, ['text'])
      requireString(params, 'text', { min: 1, max: 1024 })
      return
    case 'snippets_import':
      rejectUnknownKeys(params, ['snippets'])
      return
    case 'snippets_export':
      rejectUnknownKeys(params, [])
      return
    case 'filesearch_query': {
      rejectUnknownKeys(params, ['query', 'limit'])
      const obj = typeof params === 'object' && params !== null
        ? (params as Record<string, unknown>)
        : {}
      if ('query' in obj && obj.query !== undefined) {
        requireString(params, 'query', { min: 0, max: 1024 })
      }
      return
    }
    case 'filesearch_open':
    case 'filesearch_reveal':
    case 'filesearch_sha256':
    case 'filesearch_quick_look': {
      rejectUnknownKeys(params, ['path', 'fullPath'])
      const obj = typeof params === 'object' && params !== null
        ? (params as Record<string, unknown>)
        : {}
      if ('path' in obj && obj.path !== undefined) {
        requireString(params, 'path', { min: 1, max: 4096 })
      } else {
        requireString(params, 'fullPath', { min: 1, max: 4096 })
      }
      return
    }
    case 'window_manage_action':
      rejectUnknownKeys(params, ['action'])
      requireString(params, 'action', { min: 1, max: 64 })
      return
    case 'window_manage_list_actions':
      rejectUnknownKeys(params, [])
      return
    case 'developer_create_extension':
      return
    case 'developer_import_extension':
      rejectUnknownKeys(params, ['path'])
      requireString(params, 'path', { min: 1, max: 4096 })
      return
    case 'developer_list_extensions':
      rejectUnknownKeys(params, ['search'])
      return
    case 'developer_toggle_extension':
      rejectUnknownKeys(params, ['id', 'enabled'])
      requireString(params, 'id', { min: 1, max: 128 })
      return
    case 'developer_remove_extension':
      rejectUnknownKeys(params, ['id'])
      requireString(params, 'id', { min: 1, max: 128 })
      return
    case 'developer_diagnostics':
      rejectUnknownKeys(params, [])
      return
    case 'mcp_install_server':
      return
    case 'mcp_manage_servers':
      rejectUnknownKeys(params, ['search'])
      return
    case 'mcp_toggle_server':
      rejectUnknownKeys(params, ['id', 'enabled'])
      requireString(params, 'id', { min: 1, max: 128 })
      return
    case 'mcp_remove_server':
      rejectUnknownKeys(params, ['id'])
      requireString(params, 'id', { min: 1, max: 128 })
      return
    case 'focus_start':
      return
    case 'focus_toggle':
    case 'focus_pause':
    case 'focus_resume':
    case 'focus_complete':
    case 'focus_cancel':
    case 'focus_get_current':
    case 'focus_get_stats':
      rejectUnknownKeys(params, [])
      return
    case 'focus_list_categories':
      rejectUnknownKeys(params, ['search'])
      return
    case 'focus_create_category':
      return
    case 'screen_awareness_selected_text':
    case 'screen_awareness_screen':
    case 'screen_awareness_focused_window':
      rejectUnknownKeys(params, [])
      return
    case 'screen_awareness_screen_area':
      rejectUnknownKeys(params, ['rect'])
      return
    case 'dictation_start':
    case 'dictation_finish':
      return
    case 'dictation_cancel':
    case 'dictation_get_last':
    case 'dictation_list_words':
      rejectUnknownKeys(params, [])
      return
    case 'dictation_search':
      rejectUnknownKeys(params, ['query', 'limit'])
      return
    case 'dictation_add_word':
      rejectUnknownKeys(params, ['word'])
      requireString(params, 'word', { min: 1, max: 128 })
      return
    case 'calendar_create_event':
      optionalString(params, 'calendarName', 64)
      optionalString(params, 'conferenceUrl', 2048)
      return
    case 'calendar_upcoming_events':
      rejectUnknownKeys(params, ['withinHours', 'scope'])
      return
    case 'calendar_list_events':
      // scope 是旧版插件会带的字段，宿主忽略
      rejectUnknownKeys(params, ['scope', 'search', 'startTime', 'endTime', 'limit', 'order'])
      validateCalendarQuery(params)
      if (params.limit !== undefined) requireInteger(params, 'limit', { min: 1, max: 1000 })
      if (params.order !== undefined && params.order !== 'asc' && params.order !== 'desc') {
        throw new ZToolsError(errorCodes.invalidRequest, 'order 无效', { path: 'order' })
      }
      return
    case 'calendar_count_events':
      rejectUnknownKeys(params, ['scope', 'search', 'startTime', 'endTime'])
      validateCalendarQuery(params)
      return
    case 'calendar_delete_event':
      rejectUnknownKeys(params, ['id'])
      requireString(params, 'id', { min: 1, max: 128 })
      return
    case 'calendar_export_ics':
      rejectUnknownKeys(params, ['events', 'eventIds'])
      if (params.eventIds !== undefined) {
        requireStringArray(params, 'eventIds', { maxItems: 1000, maxItemLength: 128, maxBytes: 128 * 1000 })
      }
      return
    case 'navigation_list_windows':
      rejectUnknownKeys(params, ['search', 'query'])
      return
    case 'navigation_activate_window':
    case 'navigation_close_window':
      rejectUnknownKeys(params, ['hwnd', 'handle', 'id', 'windowId'])
      return
    case 'navigation_search_menu_items':
      rejectUnknownKeys(params, ['search', 'query'])
      return
    case 'navigation_click_menu_item':
      rejectUnknownKeys(params, ['id', 'appName', 'path'])
      return
    case 'web_search':
      rejectUnknownKeys(params, ['engine', 'query', 'url'])
      if (params.query !== undefined) {
        requireString(params, 'query', { min: 0, max: 4096 })
      }
      return
    case 'url_quick_open':
      rejectUnknownKeys(params, ['url'])
      requireString(params, 'url', { min: 1, max: 4096 })
      return
    case 'browser_get_active_tab':
      rejectUnknownKeys(params, [])
      return
    case 'contacts_list':
      rejectUnknownKeys(params, ['search', 'query', 'limit'])
      return
    case 'contacts_create':
      return
    case 'contacts_delete':
      rejectUnknownKeys(params, ['id'])
      requireString(params, 'id', { min: 1, max: 128 })
      return
    case 'games_list':
      rejectUnknownKeys(params, ['search'])
      return
    case 'games_launch':
      rejectUnknownKeys(params, ['id'])
      requireString(params, 'id', { min: 1, max: 128 })
      return
    case 'typing_get_challenges':
      rejectUnknownKeys(params, [])
      return
    case 'typing_evaluate':
      rejectUnknownKeys(params, ['challengeId', 'typedText', 'elapsedSeconds'])
      return
    case 'game_2048_create':
      rejectUnknownKeys(params, [])
      return
    case 'game_2048_move':
      rejectUnknownKeys(params, ['state', 'direction'])
      return
    case 'debug_sample_memory':
      rejectUnknownKeys(params, [])
      return
    case 'debug_create_clipboard_history':
      rejectUnknownKeys(params, ['count'])
      return
    case 'emoji_search':
      rejectUnknownKeys(params, ['query', 'category', 'skinTone', 'limit'])
      return
    case 'emoji_record_usage':
      rejectUnknownKeys(params, ['char'])
      requireString(params, 'char', { min: 1, max: 32 })
      return
    case 'emoji_toggle_favorite':
      rejectUnknownKeys(params, ['char'])
      requireString(params, 'char', { min: 1, max: 32 })
      return
    case 'emoji_get_recents':
      rejectUnknownKeys(params, [])
      return
    case 'emoji_get_favorites':
      rejectUnknownKeys(params, [])
      return
    case 'translator_translate':
      rejectUnknownKeys(params, ['text', 'sourceLanguage', 'targetLanguage'])
      requireString(params, 'text', { min: 1, max: 65536 })
      return
    case 'translator_detect_language':
      rejectUnknownKeys(params, ['text'])
      requireString(params, 'text', { min: 1, max: 65536 })
      return
    case 'translator_get_history':
      rejectUnknownKeys(params, [])
      return
    case 'notes_list':
      rejectUnknownKeys(params, ['search', 'includeTrash', 'onlyTrash', 'tag', 'pinnedFirst', 'limit'])
      return
    case 'notes_get':
      rejectUnknownKeys(params, ['id'])
      requireString(params, 'id', { min: 1, max: 128 })
      return
    case 'notes_save':
      rejectUnknownKeys(params, ['id', 'title', 'content', 'pinned', 'color', 'tags'])
      return
    case 'notes_delete':
      rejectUnknownKeys(params, ['id', 'permanent'])
      requireString(params, 'id', { min: 1, max: 128 })
      return
    case 'notes_restore':
      rejectUnknownKeys(params, ['id'])
      requireString(params, 'id', { min: 1, max: 128 })
      return
    case 'notes_toggle_pin':
      rejectUnknownKeys(params, ['id'])
      requireString(params, 'id', { min: 1, max: 128 })
      return
    case 'notes_count':
      rejectUnknownKeys(params, [])
      return
    case 'windows_run_search':
      rejectUnknownKeys(params, ['query'])
      return
    case 'windows_run_execute':
      rejectUnknownKeys(params, ['command', 'args', 'runAsAdmin', 'shell', 'workingDirectory'])
      requireString(params, 'command', { min: 1, max: 2048 })
      return
    case 'windows_run_register_alias':
      rejectUnknownKeys(params, ['alias', 'command', 'description', 'descriptionZh', 'runAsAdminByDefault'])
      requireString(params, 'alias', { min: 1, max: 64 })
      requireString(params, 'command', { min: 1, max: 2048 })
      return
    case 'windows_run_remove_alias':
      rejectUnknownKeys(params, ['alias'])
      requireString(params, 'alias', { min: 1, max: 64 })
      return
    case 'taskbar_toggle':
      rejectUnknownKeys(params, [])
      return
    case 'taskbar_show':
      rejectUnknownKeys(params, [])
      return
    case 'taskbar_hide':
      rejectUnknownKeys(params, [])
      return
    case 'taskbar_status':
      rejectUnknownKeys(params, [])
      return
    case 'taskbar_set_dock_position':
      rejectUnknownKeys(params, ['edge', 'position'])
      return
    case 'taskbar_restart_dock':
      rejectUnknownKeys(params, [])
      return
    case 'screenshots_scan':
      rejectUnknownKeys(params, ['query', 'limit', 'pinnedFirst', 'forceRefresh'])
      return
    case 'screenshots_paste_latest':
      rejectUnknownKeys(params, [])
      return
    case 'screenshots_toggle_pin':
      rejectUnknownKeys(params, ['filePath'])
      requireScreenshotPath(params)
      return
    case 'screenshots_delete':
      rejectUnknownKeys(params, ['filePath', 'permanent'])
      requireScreenshotPath(params)
      return
    case 'applications_list':
      rejectUnknownKeys(params, ['query', 'includeSystemComponents', 'forceRefresh'])
      return
    case 'applications_uninstall':
      rejectUnknownKeys(params, ['command', 'id', 'appId', 'bundleId', 'path', 'leftoverPaths'])
      requireString(params, 'command', { min: 1, max: 4096 })
      return
    case 'dictionary_lookup':
      rejectUnknownKeys(params, ['word'])
      requireString(params, 'word', { min: 1, max: 256 })
      return
    case 'dictionary_suggestions':
      rejectUnknownKeys(params, ['prefix', 'limit'])
      requireString(params, 'prefix', { min: 1, max: 256 })
      return
    case 'dictionary_toggle_favorite':
      rejectUnknownKeys(params, ['word'])
      requireString(params, 'word', { min: 1, max: 256 })
      return
    case 'dictionary_get_favorites':
      rejectUnknownKeys(params, [])
      return
    case 'dictionary_get_history':
      rejectUnknownKeys(params, [])
      return
    case 'dictionary_speak':
      rejectUnknownKeys(params, ['word', 'language', 'text'])
      requireString(params, 'word', { min: 1, max: 4096 })
      return
    case 'system_execute_action':
      rejectUnknownKeys(params, ['actionKey', 'action', 'volume', 'level', 'muted', 'params'])
      return
    case 'shortcuts_list':
      rejectUnknownKeys(params, [])
      return
    case 'shortcuts_run':
      rejectUnknownKeys(params, ['name', 'input'])
      requireString(params, 'name', { min: 1, max: 512 })
      return
    case 'shortcuts_view':
      rejectUnknownKeys(params, ['name'])
      requireString(params, 'name', { min: 1, max: 512 })
      return
    case 'audio_get_devices':
      rejectUnknownKeys(params, [])
      return
    case 'audio_set_default_device':
      rejectUnknownKeys(params, ['id', 'name', 'idOrName', 'type'])
      return
    case 'audio_set_volume':
      rejectUnknownKeys(params, ['volume', 'type'])
      return
    case 'audio_toggle_mute':
      rejectUnknownKeys(params, ['muted'])
      return
    case 'wifi_get_profiles':
      rejectUnknownKeys(params, ['interfaceName', 'forceRefresh'])
      return
    case 'wifi_get_password':
      rejectUnknownKeys(params, ['ssid'])
      requireString(params, 'ssid', { min: 1, max: 256 })
      return
    case 'brew_exec':
      rejectUnknownKeys(params, ['action', 'pkg', 'cask', 'query'])
      requireString(params, 'action', { min: 1, max: 32 })
      return
    case 'script_commands_list':
      rejectUnknownKeys(params, ['query', 'search'])
      return
    case 'script_commands_execute':
      rejectUnknownKeys(params, ['id', 'commandId', 'scriptPath', 'filePath', 'args', 'timeoutMs'])
      return
    case 'script_commands_create':
      rejectUnknownKeys(params, ['title', 'mode', 'template', 'language', 'packageName', 'description', 'sourceCode'])
      requireString(params, 'title', { min: 1, max: 256 })
      return
    case 'script_commands_reload':
      rejectUnknownKeys(params, [])
      return
    default: {
      const exhaustive: never = method
      throw new ZToolsError(errorCodes.methodNotFound, `未知方法: ${String(exhaustive)}`)
    }
  }
}
