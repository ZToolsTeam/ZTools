import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import type {
  DllPluginCallParams,
  DllPluginClearTaskParams,
  DatabaseGetParams,
  DatabasePutParams,
  DllPluginTaskParams
} from '../../contracts/method-params.js'
import type {
  NativeDllCallResult,
  NativeDllEvent,
  NativeDllTaskStatus,
  NativeDllTaskStartOutcome,
  NativeDllTaskStartAttempt,
  NativeDllClientPort,
  NativeDllInvocationContext,
  PrivilegedDllClientPort
} from '../native-host/dll-client-port.js'
import type { ServiceClient } from '../service/service-client.js'
import type { WindowRegistry } from '../windows/window-registry.js'
import type { RuntimeCapabilityAuthorizationService, RuntimeCapabilityLease } from './runtime-capability-authorization-service.js'
import type { PluginManifest, PluginManifestRuntimeMetadata } from './plugin-install-service.js'
import { isBuiltInNativeMediaDll, NativeMediaPathPolicy } from './native-media-policy.js'
import {
  COMMON_PLUGIN_DEFINITIONS,
  COMMON_PLUGIN_ROOT_ID,
  findCommonPlugin,
  type CommonPluginDefinition
} from './common-plugin-registry.js'
import type {
  ToolProgressEvent,
  ToolRuntimeErrorCode
} from '../../contracts/tool-runtime/common.js'
import {
  toCommonLibProvisionProgressPayload,
  type CommonLibDownloadProgress,
  type CommonLibDownloadProgressListener
} from '../tool-runtime/core/commonlibs-manager.js'
import { getResolvedLocale, syncProcessLocaleEnv, t, type SupportedLocale } from '../i18n/index.js'

interface PluginManifestSource {
  list(): Promise<{ success: true; data: Record<string, unknown>[] }>
  withPluginManifest<T>(
    pluginId: string,
    action: (manifest: PluginManifest, metadata?: PluginManifestRuntimeMetadata) => Promise<T>
  ): Promise<T>
}

interface DllEventPublisher {
  publishHostToOwner(type: string, payload: unknown, owner: CallerIdentity): {
    success: true
    delivered: number
  }
}

interface ResolvedDll {
  pluginId: string
  dllId: string
  requireAdmin: boolean
  manifest?: PluginManifest
  /** 仅普通权限官方签名插件：经离线验签后的 CommonLibs 逻辑工具 ID 列表 */
  signedCommonLibs?: readonly string[]
}

/** 供 DllPluginService 按需拉取并离线验签签名 CommonLibs 目录的最小端口 */
export interface NativePluginCommonLibsPort {
  ensureAndVerifyToolDir(
    toolId: string,
    signal?: AbortSignal,
    onProgress?: CommonLibDownloadProgressListener
  ): Promise<{ readonly toolId: string; readonly toolDir: string }>
  recordLease(toolId: string, pluginId: string): void
}

type PrivilegedDllTaskClientPort = PrivilegedDllClientPort & Pick<
  ServiceClient,
  'callDllAsync' | 'callDllWithCallback' | 'queryDllTask' | 'cancelDllTask' | 'clearDllTask'
> & Partial<Pick<ServiceClient, 'enableTaskEvents' | 'onTaskChange' | 'taskEventsEnabled'>>

interface NativeDllRuntimePort extends NativeDllClientPort {
  callDll(
    pluginId: string,
    dllId: string,
    functionName: string,
    params: unknown,
    context?: NativeDllInvocationContext,
    signal?: AbortSignal
  ): Promise<NativeDllCallResult>
  acquirePluginMaintenance(pluginId: string): Promise<() => void>
  unloadDll?(pluginId: string, dllId: string): Promise<void>
}

interface TaskRecord extends ResolvedDll {
  externalTaskId: string
  nativeTaskId: string
  backend: 'native' | 'service'
  owner: CallerIdentity
  nativeContext?: NativeDllInvocationContext
  mode: 'async' | 'callback'
  functionName: string
  cancelRequested: boolean
  cancelSent: boolean
  status: NativeDllTaskStatus['status']
  progress: number
  startState?: 'ack-pending' | 'unknown' | 'started' | 'not-started' | 'host-exited'
  nativeTaskObserved?: boolean
  startErrorCode?: string
  startOutcome?: Promise<NativeDllTaskStartOutcome>
  resolveStartOutcome?: (outcome: NativeDllTaskStartOutcome) => void
  pendingWatermarkSettings?: Record<string, unknown>
  pendingWatermarkCaller?: CallerIdentity
  settingsSavePromise?: Promise<boolean>
  settingsSaved?: boolean
  callbackPollTimer?: NodeJS.Timeout
  callbackPollInFlight?: boolean
  callbackPollDelay?: number
  callbackPollFailures?: number
  callbackEventChecked?: boolean
  callbackEventDirty?: boolean
  data?: unknown
  error?: string
  permissionLease?: RuntimeCapabilityLease
  permissionAbortListener?: () => void
  permissionRevoked?: boolean
}

interface TaskReservation {
  owner: CallerIdentity
}

interface WatermarkSettingsDatabase {
  put(params: DatabasePutParams, caller: CallerIdentity, signal: AbortSignal): Promise<{ success: true; data: 'OK' }>
  get(params: DatabaseGetParams, caller: CallerIdentity, signal: AbortSignal): Promise<{ success: true; data: string }>
}

type CallbackResultStatus = 'progress' | 'completed' | 'cancelled' | 'error' | 'unknown'

interface CallbackResultDetails {
  status: CallbackResultStatus
  value: unknown
  serializedResult?: string
  progress?: number
  current?: number
  total?: number
  message?: string
  error?: string
}

interface DllPluginServiceLifecycleOptions {
  taskQuiesceTimeoutMs?: number
  taskQuiescePollIntervalMs?: number
  taskStartAckTimeoutMs?: number
}

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const MAX_EARLY_NATIVE_EVENTS = 64
const TASK_QUIESCE_TIMEOUT_MS = 8_000
const TASK_QUIESCE_POLL_INTERVAL_MS = 100
const TASK_START_ACK_TIMEOUT_MS = 5_000
const DEADLINE_EXCEEDED = Symbol('deadline-exceeded')
const WATERMARK_SETTINGS_KEY = 'dllplugin.watermark-settings.v1'
const WATERMARK_SETTINGS_FIELDS = [
  'watermarkType', 'text', 'fontSize', 'fontColor', 'padding', 'angle', 'opacity',
  'position', 'x', 'y', 'mode', 'direction', 'dynamicPosition',
  'dynamicPositionVertical', 'dynamicSpeed', 'dynamicLoop'
] as const

function dllIdFromLoader(loader: string): string {
  const normalized = loader.replaceAll('\\', '/')
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1)
  if (path.extname(fileName).toLowerCase() !== '.dll') return ''
  return fileName.slice(0, -4)
}

const DLL_ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,64}$/
const DLL_PARAM_CJK_PATTERN = /[\u4e00-\u9fa5]/
const MAX_DLL_PARAM_STRING_LENGTH = 512

/** 历史 3 款常驻原生界面 DLL（键为小写 dllId）：仅当动态能力探测返回空 functions 或暂不可用时作为兼容兜底 */
const LEGACY_RESIDENT_UI_DLL_IDS: ReadonlySet<string> = new Set([
  'screencaptureplugin',
  'recordplugin',
  'screencolorpickerplugin'
])

function isLegacyResidentUiDll(dllId: string): boolean {
  return LEGACY_RESIDENT_UI_DLL_IDS.has(dllId.toLowerCase())
}

/**
 * 清洗原生 DLL 返回的 errorParams（遵循 R9 防中文绕过与安全脱敏规范）：
 * - 清洗控制字符并限制单字段最大长度；
 * - 在 en-US 模式下将含 CJK 字符或空白的 detail/stderr 替换为本地化占位词 common.detailUnavailable，
 *   避免原生中文透出或模板残留裸 {detail}/{stderr} 占位符。
 */
export function sanitizeDllErrorParams(
  raw: unknown,
  locale?: SupportedLocale
): Record<string, string | number> | undefined {
  if (!isRecord(raw)) return undefined
  const targetLocale = locale ?? getResolvedLocale()
  const params: Record<string, string | number> = {}
  let hasEntry = false
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(raw, key) || !/^[A-Za-z0-9_]{1,64}$/.test(key)) continue
    if (typeof value === 'number' && Number.isFinite(value)) {
      params[key] = value
      hasEntry = true
    } else if (typeof value === 'string') {
      const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim()
      const isDetailKey = key === 'detail' || key === 'stderr'
      if (!cleaned) {
        if (isDetailKey) {
          params[key] = t('common.detailUnavailable', undefined, targetLocale)
          hasEntry = true
        }
        continue
      }
      if (targetLocale === 'en-US' && isDetailKey && DLL_PARAM_CJK_PATTERN.test(cleaned)) {
        params[key] = t('common.detailUnavailable', undefined, targetLocale)
        hasEntry = true
        continue
      }
      params[key] = cleaned.length > MAX_DLL_PARAM_STRING_LENGTH
        ? `${cleaned.slice(0, MAX_DLL_PARAM_STRING_LENGTH)}...`
        : cleaned
      hasEntry = true
    }
  }
  return hasEntry ? params : undefined
}

function resolveNativeErrorMessage(
  raw: unknown,
  fallbackKey: string,
  params?: Readonly<Record<string, string | number>>
): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text && !(getResolvedLocale() === 'en-US' && DLL_PARAM_CJK_PATTERN.test(text))) {
    return text
  }
  return t(fallbackKey, params)
}

function appendStructuredDllContext(
  localized: string,
  templateKey: string,
  safeParams: Record<string, string | number> | undefined,
  locale: SupportedLocale
): string {
  if (!safeParams) return localized
  const rawTemplate = t(templateKey, undefined, locale)
  const supplements: string[] = []
  const hasPlaceholder = (name: string): boolean => rawTemplate.includes(`{${name}}`)

  if (typeof safeParams.path === 'string' && !hasPlaceholder('path')) {
    supplements.push(safeParams.path)
  }
  if (safeParams.exitCode !== undefined && !hasPlaceholder('exitCode')) {
    supplements.push(t('dll.exitCodeLabel', { exitCode: safeParams.exitCode }, locale))
  }
  const detailUnavailable = t('common.detailUnavailable', undefined, locale)
  if (typeof safeParams.detail === 'string' && !hasPlaceholder('detail') && safeParams.detail !== detailUnavailable) {
    supplements.push(safeParams.detail)
  }
  if (supplements.length === 0) return localized
  const base = localized.replace(/[。.]$/, '')
  return locale === 'zh-CN'
    ? `${base}（${supplements.join('；')}）`
    : `${base} (${supplements.join('; ')})`
}

/**
 * 安全向传给原生 DLL 的 params 对象注入当前生效的 __locale，
 * 始终返回新对象，绝不原地污染调用方入参（遵循 R4 零 ABI 破坏协议）。
 */
export function withDllLocale(
  params: Record<string, unknown>,
  locale?: SupportedLocale
): Record<string, unknown> {
  return { ...params, __locale: locale ?? getResolvedLocale() }
}

/**
 * 安全构造传给原生 DLL 的 __commonLibs 只读工具目录映射：
 * - 无条件剥离前端/调用方传入的同名 __commonLibs 字段，阻断任意目录路径伪造；
 * - 仅当宿主已通过官方签名校验并完成工具离线验签落盘时，写入受信任的只读目录映射。
 */
export function withDllCommonLibs(
  params: Record<string, unknown>,
  resolvedDirs?: Readonly<Record<string, string>>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (key === '__commonLibs') continue
    sanitized[key] = value
  }
  if (resolvedDirs && Object.keys(resolvedDirs).length > 0) {
    sanitized.__commonLibs = { ...resolvedDirs }
  }
  return sanitized
}

function translateDllTemplate(
  key: string,
  safeParams: Readonly<Record<string, string | number>> | undefined,
  locale: SupportedLocale
): string {
  const rawTemplate = t(key, undefined, locale)
  if (rawTemplate === key) return key
  const needsDetail = rawTemplate.includes('{detail}') && (!safeParams || !Object.hasOwn(safeParams, 'detail'))
  const needsStderr = rawTemplate.includes('{stderr}') && (!safeParams || !Object.hasOwn(safeParams, 'stderr'))
  if (!needsDetail && !needsStderr) {
    return t(key, safeParams, locale)
  }
  const unavailable = t('common.detailUnavailable', undefined, locale)
  return t(
    key,
    {
      ...(safeParams ?? {}),
      ...(needsDetail ? { detail: unavailable } : {}),
      ...(needsStderr ? { stderr: unavailable } : {})
    },
    locale
  )
}

/**
 * 翻译原生 DLL 进度消息：
 * - 若为合法 JSON 对象且包含规范 progressCode，则优先查主进程词典 dllProgress.<progressCode>
 *   并插值经 R9 清洗的 progressParams；缺失词条时回退 fallback；
 * - 否则原样兼容旧版纯文本进度消息。
 */
export function localizeDllProgressMessage(
  rawMessage: string,
  locale?: SupportedLocale
): string {
  if (typeof rawMessage !== 'string') return ''
  const trimmed = rawMessage.trim()
  if (!trimmed.startsWith('{')) return rawMessage
  const parsed = parseDllResult(trimmed)
  if (!isRecord(parsed)) return rawMessage
  const rawCode = typeof parsed.progressCode === 'string' ? parsed.progressCode.trim() : ''
  if (!rawCode || !DLL_ERROR_CODE_PATTERN.test(rawCode)) return rawMessage
  const targetLocale = locale ?? getResolvedLocale()
  const key = `dllProgress.${rawCode}`
  const safeParams = sanitizeDllErrorParams(parsed.progressParams, targetLocale)
  const translated = translateDllTemplate(key, safeParams, targetLocale)
  if (translated !== key) return translated
  if (typeof parsed.fallback === 'string' && parsed.fallback.trim().length > 0) {
    return parsed.fallback
  }
  return rawMessage
}

function tryLocalizeDllMessageCode(
  rawCode: unknown,
  rawParams: unknown,
  locale: SupportedLocale
): string | undefined {
  if (typeof rawCode !== 'string') return undefined
  const code = rawCode.trim()
  if (!code || !DLL_ERROR_CODE_PATTERN.test(code)) return undefined
  const safeParams = sanitizeDllErrorParams(rawParams, locale)
  for (const prefix of ['dllMessages', 'dllProgress'] as const) {
    const key = `${prefix}.${code}`
    const translated = translateDllTemplate(key, safeParams, locale)
    if (translated !== key) return translated
  }
  return undefined
}

/**
 * 将原生 DLL 返回载荷中的结构化 errorCode / progressCode / messageCode 本地化为当前语言文案，
 * 同时完整保留原始结构化字段；未命中已知码或畸形载荷时原样返回。
 */
export function localizeDllErrorPayload(
  payload: unknown,
  options?: { forceError?: boolean; locale?: SupportedLocale }
): unknown {
  if (!isRecord(payload)) return payload
  const targetLocale = options?.locale ?? getResolvedLocale()
  const isErrorEnvelope =
    options?.forceError === true ||
    payload.success === false ||
    callbackStatus(payload.type) === 'error' ||
    callbackStatus(payload.status) === 'error'

  let next: Record<string, unknown> | null = null
  const ensureMutable = (): Record<string, unknown> => {
    if (!next) next = { ...payload }
    return next
  }

  const rawCode = typeof payload.errorCode === 'string' ? payload.errorCode.trim() : ''
  if (isErrorEnvelope && rawCode && DLL_ERROR_CODE_PATTERN.test(rawCode)) {
    const i18nKey = `dllErrors.${rawCode}`
    const safeParams = sanitizeDllErrorParams(payload.errorParams, targetLocale)
    const rawLocalized = translateDllTemplate(i18nKey, safeParams, targetLocale)
    if (rawLocalized !== i18nKey) {
      const localized = appendStructuredDllContext(rawLocalized, i18nKey, safeParams, targetLocale)
      const draft = ensureMutable()
      draft.error = localized
      if (
        typeof payload.message === 'string' &&
        (payload.error === undefined ||
          payload.message === payload.error ||
          payload.message === payload.errorMessage)
      ) {
        draft.message = localized
      }
      if (
        typeof payload.errorMessage === 'string' &&
        (payload.error === undefined || payload.errorMessage === payload.error)
      ) {
        draft.errorMessage = localized
      }
    }
  } else if (!isErrorEnvelope) {
    // 1) 结构化进度码（progressCode + progressParams + fallback）
    const rawProgressCode = typeof payload.progressCode === 'string' ? payload.progressCode.trim() : ''
    if (rawProgressCode && DLL_ERROR_CODE_PATTERN.test(rawProgressCode)) {
      const progressKey = `dllProgress.${rawProgressCode}`
      const safeParams = sanitizeDllErrorParams(payload.progressParams, targetLocale)
      const translated = translateDllTemplate(progressKey, safeParams, targetLocale)
      if (translated !== progressKey) {
        ensureMutable().message = translated
      } else if (typeof payload.fallback === 'string' && payload.fallback.trim().length > 0 && !payload.message) {
        ensureMutable().message = payload.fallback
      }
    } else if (typeof payload.message === 'string' && payload.message.trim().startsWith('{')) {
      const translatedMsg = localizeDllProgressMessage(payload.message, targetLocale)
      if (translatedMsg !== payload.message) {
        ensureMutable().message = translatedMsg
      }
    }

    // 2) 成功路径结构化消息码（messageCode + messageParams）
    const localizedMessage = tryLocalizeDllMessageCode(payload.messageCode, payload.messageParams, targetLocale)
    if (localizedMessage !== undefined) {
      ensureMutable().message = localizedMessage
    }
  }

  // 处理嵌套在 data 字段中的结构化错误、进度或成功消息（如 callback 信封）
  if (isRecord(payload.data)) {
    const localizedData = localizeDllErrorPayload(payload.data, {
      forceError: isErrorEnvelope,
      ...(options?.locale ? { locale: options.locale } : {})
    })
    if (localizedData !== payload.data && isRecord(localizedData)) {
      const draft = ensureMutable()
      draft.data = localizedData
      if (typeof localizedData.error === 'string') {
        const originalDataError = payload.data.error
        if (payload.error === undefined || payload.error === originalDataError) {
          draft.error = localizedData.error
        }
        if (
          typeof payload.message === 'string' &&
          (payload.message === payload.error ||
            payload.message === originalDataError ||
            payload.message === payload.data.message)
        ) {
          draft.message = localizedData.error
        }
      } else if (typeof localizedData.message === 'string' && localizedData.message !== payload.data.message) {
        if (payload.message === undefined || payload.message === payload.data.message) {
          draft.message = localizedData.message
        }
      }
    }
  }

  return next ?? payload
}

function localizeDllErrorString(rawError: string, locale?: SupportedLocale): string {
  const parsed = parseDllResult(rawError)
  if (!isRecord(parsed)) return rawError
  const localized = localizeDllErrorPayload(parsed, {
    forceError: true,
    ...(locale ? { locale } : {})
  })
  if (localized !== parsed && isRecord(localized) && typeof localized.error === 'string') {
    return localized.error
  }
  return rawError
}

function parseDllResult(result: string | null): unknown {
  if (result === null) return null
  try {
    return JSON.parse(result) as unknown
  } catch {
    return result
  }
}

function callResponse(call: NativeDllCallResult): Record<string, unknown> {
  if (call.code === 0) {
    return { success: true, data: localizeDllErrorPayload(parseDllResult(call.result)) }
  }
  const parsed = localizeDllErrorPayload(parseDllResult(call.result), { forceError: true })
  const errorRecord = isRecord(parsed) ? parsed : undefined
  const candidateError = typeof parsed === 'string' && parsed.length > 0
    ? parsed
    : errorRecord?.error
  const message = resolveNativeErrorMessage(candidateError, 'dll.callFailedWithCode', { code: call.code })
  return {
    success: false,
    error: message,
    code: call.code,
    ...(typeof errorRecord?.errorCode === 'string' ? { errorCode: errorRecord.errorCode } : {}),
    ...(isRecord(errorRecord?.errorParams) ? { errorParams: errorRecord.errorParams } : {})
  }
}

function finalTaskStatus(status: NativeDllTaskStatus['status']): status is 'completed' | 'cancelled' | 'error' {
  return status === 'completed' || status === 'cancelled' || status === 'error'
}

function taskStartConfirmed(task: TaskRecord): boolean {
  const state = task.startState
  const observed = task.nativeTaskObserved
  return state === 'started' || observed === true
}

function requireNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const code = signal.reason === errorCodes.requestTimeout
    ? errorCodes.requestTimeout
    : signal.reason === errorCodes.appStopping
      ? errorCodes.appStopping
      : errorCodes.callerDestroyed
  throw new ZToolsError(code, t('dll.error.cancelled'), { i18nKey: 'dll.error.cancelled' })
}

function sameIdentity(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function commonTarget(definition: CommonPluginDefinition): ResolvedDll {
  // Only the native host resolves this registry ID to a file; its resource manifest
  // must authenticate the SHA-256 before any DLL is loaded.
  return {
    pluginId: COMMON_PLUGIN_ROOT_ID,
    dllId: definition.id,
    requireAdmin: definition.requireAdmin
  }
}

function isScreenCaptureDllOperation(target: ResolvedDll, functionName: string): boolean {
  return target.dllId.toLowerCase() === 'screencaptureplugin' &&
    ['capturescreen', 'capturewindow', 'captureregion'].includes(functionName.toLowerCase())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function copyTaskOwner(caller: CallerIdentity): CallerIdentity {
  if (caller.type === 'plugin' && (!caller.pluginId || !caller.pluginInstanceId)) {
    throw new ZToolsError(errorCodes.permissionDenied, t('dll.error.missingWindowIdentity'), {
      i18nKey: 'dll.error.missingWindowIdentity'
    })
  }
  return { ...caller }
}

function taskOwnerIdentityKey(owner: CallerIdentity): string {
  return JSON.stringify([
    owner.type,
    owner.webContentsId,
    owner.pluginId ?? null,
    owner.pluginInstanceId ?? null
  ])
}

function taskOwnerKey(owner: CallerIdentity, taskId: string): string {
  return JSON.stringify([taskOwnerIdentityKey(owner), taskId])
}

function isSameTaskOwner(left: CallerIdentity, right: CallerIdentity): boolean {
  return left.type === right.type &&
    left.webContentsId === right.webContentsId &&
    left.pluginId === right.pluginId &&
    left.pluginInstanceId === right.pluginInstanceId
}

function callbackStatus(value: unknown): CallbackResultStatus | null {
  if (typeof value !== 'string') return null
  switch (value.toLowerCase()) {
    case 'progress':
    case 'pending':
    case 'processing':
    case 'running':
      return 'progress'
    case 'complete':
    case 'completed':
    case 'done':
    case 'success':
      return 'completed'
    case 'cancelled':
    case 'canceled':
      return 'cancelled'
    case 'error':
    case 'failed':
    case 'failure':
      return 'error'
    default:
      return null
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0)
}

function numberField(value: unknown, ...keys: string[]): number | undefined {
  if (!isRecord(value)) return undefined
  for (const key of keys) {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return undefined
}

function parseCallbackResult(result: string): CallbackResultDetails {
  const rawValue = parseDllResult(result)
  const value = localizeDllErrorPayload(rawValue)
  if (!isRecord(value)) return { status: 'completed', value }

  let serializedResult: string | undefined
  if (value !== rawValue) {
    try {
      serializedResult = JSON.stringify(value)
    } catch {
      serializedResult = undefined
    }
  }

  const data = isRecord(value.data) ? value.data : undefined
  const hasExplicitType = Object.hasOwn(value, 'type')
  const hasExplicitStatus = Object.hasOwn(value, 'status') || (data !== undefined && Object.hasOwn(data, 'status'))
  const typeStatus = callbackStatus(value.type)
  const statusStatus = callbackStatus(value.status)
  const nestedStatus = callbackStatus(data?.status)
  const error = firstString(value.error, value.errorMessage, data?.error, data?.errorMessage)
  let status: CallbackResultStatus = 'unknown'

  if (hasExplicitType && typeStatus === null) {
    status = 'unknown'
  } else if (typeStatus === 'progress') {
    status = 'progress'
  } else if (typeStatus === 'error') {
    status = 'error'
  } else if (typeStatus === 'cancelled') {
    status = 'cancelled'
  } else if (typeStatus === 'completed') {
    status = 'completed'
  } else if (statusStatus === 'error' || nestedStatus === 'error' || error) {
    status = 'error'
  } else if (statusStatus === 'cancelled' || nestedStatus === 'cancelled') {
    status = 'cancelled'
  } else if (statusStatus === 'completed' || nestedStatus === 'completed') {
    status = 'completed'
  } else if (statusStatus === 'progress' || nestedStatus === 'progress') {
    status = 'progress'
  } else if (!hasExplicitStatus) {
    status = 'completed'
  }

  const directPercent = numberField(value, 'percent') ?? numberField(data, 'percent')
  const progress = numberField(value, 'progress') ?? numberField(data, 'progress')
  const rawProgress = directPercent ?? progress
  const current = numberField(value, 'current', 'currentIndex') ?? numberField(data, 'current', 'currentIndex')
  const total = numberField(value, 'total', 'totalFiles') ?? numberField(data, 'total', 'totalFiles')
  const message = firstString(value.message, data?.message)
  const percent = rawProgress === undefined
    ? undefined
    : Math.max(0, Math.min(100, directPercent !== undefined || rawProgress > 1 ? rawProgress : rawProgress * 100))

  return {
    status,
    value,
    ...(serializedResult !== undefined ? { serializedResult } : {}),
    ...(percent !== undefined ? { progress: percent } : {}),
    ...(current !== undefined ? { current } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(message ? { message } : {}),
    ...(error ? { error } : {})
  }
}

export class DllPluginService {
  readonly #tasks = new Map<string, TaskRecord>()
  readonly #nativeTasks = new Map<string, TaskRecord>()
  readonly #reservedTaskIds = new Map<string, TaskReservation>()
  readonly #earlyNativeEvents: NativeDllEvent[] = []
  readonly #pendingTaskStarts = new Map<Promise<unknown>, CallerIdentity>()
  readonly #taskDisposals = new Map<string, Promise<void>>()
  readonly #taskDisposalRetryDeadlines = new Map<string, number>()
  readonly #closedCallers = new Set<string>()
  readonly #nativeOwners = new Map<string, { owner: CallerIdentity; context: NativeDllInvocationContext }>()
  readonly #quiescingPlugins = new Set<string>()
  readonly #pluginUnloads = new Map<string, Promise<void>>()
  readonly #activeResidentDlls = new Map<string, { pluginId: string; dllId: string; context?: NativeDllInvocationContext }>()
  readonly #localeCapableDllCache = new Map<string, boolean>()
  #nativeGeneration = 0n
  readonly #removeNativeListener: (() => void) | null
  readonly #removeServiceListener: (() => void) | null
  readonly #removeWindowListener: (() => void) | null
  readonly #taskQuiesceTimeoutMs: number
  readonly #taskQuiescePollIntervalMs: number
  readonly #taskStartAckTimeoutMs: number
  #stopped = false
  #nativeListenerRemoved = false
  #serviceListenerRemoved = false
  #stopPromise: Promise<void> | null = null
  #stopDeadlineMs: number | null = null

  constructor(
    private readonly manifests: PluginManifestSource,
    private readonly nativeHost: NativeDllRuntimePort | null,
    private readonly serviceClient: PrivilegedDllTaskClientPort | null,
    private readonly events: DllEventPublisher,
    registry?: Pick<WindowRegistry, 'onRemoved'>,
    lifecycleOptions: DllPluginServiceLifecycleOptions = {},
    private readonly nativeMediaPolicy?: NativeMediaPathPolicy,
    private readonly watermarkSettingsDatabase?: WatermarkSettingsDatabase,
    private readonly runtimePlatform: NodeJS.Platform = process.platform,
    private readonly capabilityAuthorization?: Pick<RuntimeCapabilityAuthorizationService, 'beginOperation'>,
    private readonly commonLibs?: NativePluginCommonLibsPort
  ) {
    this.#taskQuiesceTimeoutMs = Number.isInteger(lifecycleOptions.taskQuiesceTimeoutMs) &&
      Number(lifecycleOptions.taskQuiesceTimeoutMs) > 0
      ? Number(lifecycleOptions.taskQuiesceTimeoutMs)
      : TASK_QUIESCE_TIMEOUT_MS
    this.#taskQuiescePollIntervalMs = Number.isInteger(lifecycleOptions.taskQuiescePollIntervalMs) &&
      Number(lifecycleOptions.taskQuiescePollIntervalMs) > 0
      ? Number(lifecycleOptions.taskQuiescePollIntervalMs)
      : TASK_QUIESCE_POLL_INTERVAL_MS
    this.#taskStartAckTimeoutMs = Number.isInteger(lifecycleOptions.taskStartAckTimeoutMs) &&
      Number(lifecycleOptions.taskStartAckTimeoutMs) > 0
      ? Number(lifecycleOptions.taskStartAckTimeoutMs)
      : TASK_START_ACK_TIMEOUT_MS
    let removeNativeListener: (() => void) | null = null
    let removeServiceListener: (() => void) | null = null
    let removeWindowListener: (() => void) | null = null
    try {
      removeNativeListener = nativeHost?.onDllEvent((event) => this.#handleNativeEvent(event)) ?? null
      removeServiceListener = serviceClient?.onTaskChange?.((taskIds) => {
        for (const task of this.#tasks.values()) {
          if (task.backend !== 'service' ||
              (!taskIds.includes('*') && !taskIds.includes(task.nativeTaskId))) continue
          task.callbackEventDirty = true
          task.callbackPollDelay = 0
          this.#clearTaskPolling(task)
          if (!task.callbackPollInFlight) void this.#pollServiceTask(task)
        }
      }) ?? null
      removeWindowListener = registry?.onRemoved((webContentsId) => this.#handleCallerRemoved(webContentsId)) ?? null
    } catch (constructionError) {
      const cleanupErrors: unknown[] = []
      for (const cleanup of [removeWindowListener, removeServiceListener, removeNativeListener]) {
        if (!cleanup) continue
        try {
          cleanup()
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError)
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [constructionError, ...cleanupErrors],
          'DllPluginService construction and listener cleanup both failed'
        )
      }
      throw constructionError
    }
    this.#removeNativeListener = removeNativeListener
    this.#removeServiceListener = removeServiceListener
    this.#removeWindowListener = removeWindowListener
    syncProcessLocaleEnv()
  }

  /**
   * 将当前生效的规范 locale 同步写入进程环境 ZTOOLS_LOCALE，
   * 并基于 DllPlugin_GetInfo 动态能力探测向支持 __setLocale 的已活跃普通原生 DLL 派发语言热更新。
   * 单款失败仅记录告警日志，不中断其他派发也不抛错。
   */
  syncLocale(locale?: SupportedLocale): SupportedLocale {
    const resolved = syncProcessLocaleEnv(locale ?? getResolvedLocale())
    if (this.#stopped || !this.nativeHost || this.runtimePlatform === 'darwin') {
      return resolved
    }
    const targets = new Map<string, { pluginId: string; dllId: string; context?: NativeDllInvocationContext }>()
    for (const [key, entry] of this.#activeResidentDlls.entries()) {
      targets.set(key, entry)
    }
    for (const task of this.#tasks.values()) {
      if (task.backend !== 'native' || finalTaskStatus(task.status)) {
        continue
      }
      const key = `${task.pluginId.toLowerCase()}::${task.dllId.toLowerCase()}`
      if (!targets.has(key)) {
        targets.set(key, {
          pluginId: task.pluginId,
          dllId: task.dllId,
          ...(task.nativeContext ? { context: task.nativeContext } : {})
        })
      }
    }
    for (const [key, target] of targets.entries()) {
      if (this.#quiescingPlugins.has(target.pluginId.toLowerCase())) continue
      void this.#dispatchLocaleToTarget(key, target, resolved)
    }
    return resolved
  }

  async #supportsSetLocale(
    key: string,
    target: { pluginId: string; dllId: string; context?: NativeDllInvocationContext }
  ): Promise<boolean> {
    const cached = this.#localeCapableDllCache.get(key)
    if (cached !== undefined) return cached
    const native = this.nativeHost
    if (!native) return false
    try {
      const info = await native.getDllInfo(target.pluginId, target.dllId, target.context)
      if (Array.isArray(info?.functions) && info.functions.length > 0) {
        const capable = info.functions.includes('__setLocale')
        this.#localeCapableDllCache.set(key, capable)
        return capable
      }
    } catch {
      // 动态探测失败时回退兼容历史 3 款常驻原生界面 DLL，避免阻断其他插件
    }
    // 动态探测失败或返回空列表时仅作当次兼容回退，不持久化写入缓存，避免瞬时异常永久锁死新 DLL 的热更新能力
    return isLegacyResidentUiDll(target.dllId)
  }

  async #dispatchLocaleToTarget(
    key: string,
    target: { pluginId: string; dllId: string; context?: NativeDllInvocationContext },
    resolved: SupportedLocale
  ): Promise<void> {
    try {
      if (!(await this.#supportsSetLocale(key, target))) return
      if (this.#stopped || this.#quiescingPlugins.has(target.pluginId.toLowerCase())) return
      await this.nativeHost?.callDll(
        target.pluginId,
        target.dllId,
        '__setLocale',
        { locale: resolved },
        target.context
      )
    } catch (error: unknown) {
      console.warn(
        `向支持 __setLocale 的原生 DLL 派发语言热更新失败: pluginId=${target.pluginId}, dllId=${target.dllId}`,
        error
      )
    }
  }

  #rememberActiveResidentDll(
    target: ResolvedDll,
    context?: NativeDllInvocationContext
  ): void {
    if (this.runtimePlatform === 'darwin' || target.requireAdmin) {
      return
    }
    const key = `${target.pluginId.toLowerCase()}::${target.dllId.toLowerCase()}`
    if (this.#localeCapableDllCache.get(key) === false) {
      return
    }
    this.#activeResidentDlls.set(key, {
      pluginId: target.pluginId,
      dllId: target.dllId,
      ...(context ? { context } : {})
    })
  }

  #forgetActiveResidentDllsForPlugin(pluginId: string): void {
    const normalized = pluginId.toLowerCase()
    for (const [key, entry] of this.#activeResidentDlls.entries()) {
      if (entry.pluginId.toLowerCase() === normalized) {
        this.#activeResidentDlls.delete(key)
      }
    }
    const prefix = `${normalized}::`
    for (const key of this.#localeCapableDllCache.keys()) {
      if (key.startsWith(prefix)) {
        this.#localeCapableDllCache.delete(key)
      }
    }
  }

  list(caller: CallerIdentity): Promise<{ success: true; plugins: Record<string, unknown>[]; count: number }> {
    const owner = copyTaskOwner(caller)
    return this.#trackTaskStart(owner, () => this.#list(owner))
  }

  async #list(caller: CallerIdentity): Promise<{ success: true; plugins: Record<string, unknown>[]; count: number }> {
    this.#requireRunning()
    const installed = (await this.manifests.list()).data
    const visible = caller.type === 'plugin'
      ? installed.filter((item) => typeof item.id === 'string' && caller.pluginId !== undefined && sameIdentity(item.id, caller.pluginId))
      : installed
    const plugins: Record<string, unknown>[] = []
    for (const item of visible) {
      const pluginId = typeof item.id === 'string' ? item.id : ''
      if (!pluginId) continue
      const dllIds = this.runtimePlatform === 'darwin'
        ? await this.#macDeclaredIds(pluginId).catch(() => [])
        : [dllIdFromLoader(typeof item.dllloader === 'string' ? item.dllloader : '')]
      for (const dllId of dllIds) {
        if (!dllId) continue
        const requireAdmin = item.requireAdmin === true
        const base = {
          id: dllId,
          name: dllId,
          pluginName: dllId,
          pluginId,
          jsPluginId: pluginId,
          requireAdmin,
          isLoaded: false
        }
        if (requireAdmin || !this.nativeHost) {
          plugins.push(base)
          continue
        }
        try {
          const info = await this.nativeHost.getDllInfo(pluginId, dllId, this.#nativeContext(caller))
          if (Array.isArray(info?.functions) && info.functions.length > 0) {
            this.#localeCapableDllCache.set(
              `${pluginId.toLowerCase()}::${dllId.toLowerCase()}`,
              info.functions.includes('__setLocale')
            )
          }
          plugins.push({ ...base, ...info, id: dllId, name: dllId, isLoaded: true })
        } catch {
          plugins.push(base)
        }
      }
    }
    for (const definition of this.runtimePlatform === 'darwin' ? [] : COMMON_PLUGIN_DEFINITIONS) {
      const base = {
        id: definition.id,
        name: definition.id,
        pluginName: definition.id,
        pluginId: COMMON_PLUGIN_ROOT_ID,
        jsPluginId: '',
        requireAdmin: definition.requireAdmin,
        isLoaded: false
      }
      if (definition.requireAdmin || !this.nativeHost) {
        plugins.push(base)
        continue
      }
      try {
        const info = await this.nativeHost.getDllInfo(COMMON_PLUGIN_ROOT_ID, definition.id, this.#nativeContext(caller))
        plugins.push({ ...base, ...info, id: definition.id, name: definition.id, isLoaded: true })
      } catch {
        plugins.push(base)
      }
    }
    return { success: true, plugins, count: plugins.length }
  }

  async call(
    params: DllPluginCallParams,
    caller: CallerIdentity,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const owner = copyTaskOwner(caller)
    return await this.#trackTaskStart(owner, async () => {
      requireNotAborted(signal)
      const target = await this.#resolve(params.plugin, owner)
      this.#assertPluginAvailable(target.pluginId)
      const capabilityLease = this.#beginScreenCaptureOperation(target, params.func, owner)
      const operationSignal = this.#combineSignals(signal, capabilityLease?.signal)
      try {
        capabilityLease?.assertCurrent()
        const nativeParams = await this.#authorizeMediaParams(target, params.func, params.params, owner)
        requireNotAborted(operationSignal)
        capabilityLease?.assertCurrent()
        this.#requireTaskStartCaller(owner)
        if (this.#isWatermarkSettingsMethod(target, params.func)) {
          const result = params.func === 'SaveWatermarkSettings'
            ? await this.#saveWatermarkSettings(target, nativeParams, owner)
            : await this.#loadWatermarkSettings(target, owner)
          capabilityLease?.assertCurrent()
          return result.success === true
            ? { success: true, data: result }
            : { success: false, error: resolveNativeErrorMessage(result.error, 'dll.error.watermarkOperationFailed'), data: result }
        }
        const { params: callParams, settingsToSave } = this.#prepareNativeMediaCall(target, params.func, nativeParams)
        const currentLocale = syncProcessLocaleEnv()
        const localizedCallParams = await this.#injectSignedCommonLibs(
          target,
          withDllLocale(callParams, currentLocale),
          owner,
          operationSignal
        )
        requireNotAborted(operationSignal)
        capabilityLease?.assertCurrent()
        if (target.requireAdmin) {
          const service = this.#requireService()
          const data = localizeDllErrorPayload(await service.callDll(target.pluginId, target.dllId, params.func, localizedCallParams))
          requireNotAborted(operationSignal)
          capabilityLease?.assertCurrent()
          const response = { success: true, data }
          if (settingsToSave) {
            const settingsSaved = await this.#persistWatermarkSettings(target, settingsToSave, owner)
            capabilityLease?.assertCurrent()
            return { ...response, settingsSaved }
          }
          return response
        }
        const native = this.#requireNativeHost()
        const nativeContext = this.#nativeContext(owner)
        const nativeResult = await native.callDll(
          target.pluginId,
          target.dllId,
          params.func,
          localizedCallParams,
          nativeContext,
          ...(operationSignal ? [operationSignal] : [])
        )
        this.#rememberActiveResidentDll(target, nativeContext)
        const response = callResponse(nativeResult)
        requireNotAborted(operationSignal)
        capabilityLease?.assertCurrent()
        if (settingsToSave && response.success === true) {
          const settingsSaved = await this.#persistWatermarkSettings(target, settingsToSave, owner)
          capabilityLease?.assertCurrent()
          if (isRecord(response.data)) return { ...response, data: { ...response.data, settingsSaved } }
          return { ...response, data: { value: response.data, settingsSaved } }
        }
        return response
      } finally {
        capabilityLease?.release()
      }
    })
  }

  async #prepareTaskInvocation(
    params: DllPluginCallParams,
    owner: CallerIdentity,
    onLease: (lease: RuntimeCapabilityLease | undefined) => void
  ): Promise<{
    target: ResolvedDll
    localizedCallParams: Record<string, unknown>
    settingsToSave?: Record<string, unknown>
  }> {
    const target = await this.#resolve(params.plugin, owner)
    this.#assertPluginAvailable(target.pluginId)
    const capabilityLease = this.#beginScreenCaptureOperation(target, params.func, owner)
    onLease(capabilityLease)
    capabilityLease?.assertCurrent()
    const nativeParams = await this.#authorizeMediaParams(target, params.func, params.params, owner)
    capabilityLease?.assertCurrent()
    this.#requireTaskStartCaller(owner)
    if (this.#isWatermarkSettingsMethod(target, params.func)) {
      throw new ZToolsError(errorCodes.notSupported, t('dll.error.watermarkSyncOnly'), {
        i18nKey: 'dll.error.watermarkSyncOnly'
      })
    }
    const { params: callParams, settingsToSave } = this.#prepareNativeMediaCall(target, params.func, nativeParams)
    const currentLocale = syncProcessLocaleEnv()
    const localizedCallParams = await this.#injectSignedCommonLibs(
      target,
      withDllLocale(callParams, currentLocale),
      owner,
      capabilityLease?.signal
    )
    capabilityLease?.assertCurrent()
    return {
      target,
      localizedCallParams,
      ...(settingsToSave ? { settingsToSave } : {})
    }
  }

  async callAsync(params: DllPluginCallParams, caller: CallerIdentity): Promise<Record<string, unknown>> {
    const owner = copyTaskOwner(caller)
    let capabilityLease: RuntimeCapabilityLease | undefined
    try {
      return await this.#trackTaskStart(owner, async () => {
      const { target, localizedCallParams, settingsToSave } = await this.#prepareTaskInvocation(
        params,
        owner,
        (lease) => { capabilityLease = lease }
      )
      if (target.requireAdmin) {
        const service = this.#requireServiceTasks()
        const taskId = `task_${randomUUID()}`
        const task: TaskRecord = {
          ...target,
          externalTaskId: taskId,
          nativeTaskId: taskId,
          backend: 'service',
          owner,
          mode: 'async',
          functionName: params.func,
          cancelRequested: false,
          cancelSent: false,
          status: 'invoking',
          progress: 0,
          startState: 'ack-pending',
          nativeTaskObserved: false,
          ...(settingsToSave ? { pendingWatermarkSettings: settingsToSave } : {})
        }
        this.#attachCapabilityLease(task, capabilityLease)
        capabilityLease = undefined
        this.#rememberTask(task)
        try {
          await service.callDllAsync(target.pluginId, target.dllId, params.func, taskId, localizedCallParams)
          task.startState = 'started'
          task.status = 'running'
          if (task.cancelRequested) void this.#sendTaskCancellation(task).catch(() => undefined)
          if (settingsToSave) {
            task.settingsSaved = await this.#persistWatermarkSettings(target, settingsToSave, owner)
          }
          this.#startServiceTaskPolling(task)
          return { success: true, taskId, ...(settingsToSave ? { settingsSaved: task.settingsSaved } : {}) }
        } catch (error) {
          this.#forgetTask(task)
          throw error
        }
      }
      const nativeContext = this.#nativeContext(owner)
      const nativeTaskId = `task_${randomUUID()}`
      let resolveStartOutcome!: (outcome: NativeDllTaskStartOutcome) => void
      const startOutcome = new Promise<NativeDllTaskStartOutcome>((resolve) => { resolveStartOutcome = resolve })
      const task: TaskRecord = {
        ...target,
        externalTaskId: nativeTaskId,
        nativeTaskId,
        backend: 'native',
        owner,
        nativeContext,
        mode: 'async',
        functionName: params.func,
        cancelRequested: false,
        cancelSent: false,
        status: 'invoking',
        progress: 0,
        startState: 'ack-pending',
        nativeTaskObserved: false,
        startOutcome,
        resolveStartOutcome,
        ...(settingsToSave ? { pendingWatermarkSettings: settingsToSave, pendingWatermarkCaller: owner } : {})
      }
      this.#attachCapabilityLease(task, capabilityLease)
      capabilityLease = undefined
      this.#rememberTask(task)
      let attempt: NativeDllTaskStartAttempt
      try {
        attempt = this.#requireNativeHost().beginDllAsyncTask(
          target.pluginId, target.dllId, params.func, localizedCallParams, nativeContext, undefined, nativeTaskId
        )
      } catch (error) {
        // begin throws only before a frame is sent; there is no native task to clear.
        this.#forgetTask(task)
        throw error
      }
      void attempt.outcome.then((outcome) => this.#settleNativeTaskStart(task, outcome)).catch(() => undefined)
      const outcome = await this.#awaitUntil(startOutcome, Date.now() + this.#taskStartAckTimeoutMs)
      if (outcome === DEADLINE_EXCEEDED) {
        if (task.startState === 'ack-pending') task.startState = 'unknown'
        if (task.startState !== 'started') {
          return { success: true, taskId: nativeTaskId, taskStartPending: true }
        }
      } else if (outcome.kind === 'not-started') {
        this.#forgetTask(task)
        const code = (outcome.error as Error & { code?: unknown }).code
        return { success: false, error: resolveNativeErrorMessage(outcome.error.message, 'dll.error.nativeHostNotStarted'), taskStartResolved: 'not-started',
          workNotStarted: true, ...(typeof code === 'string' ? { code } : {}) }
      } else if (outcome.kind === 'host-exited') {
        return { success: false, taskId: nativeTaskId, error: resolveNativeErrorMessage(outcome.error.message, 'dll.error.nativeHostStartUnconfirmed'),
          workOutcome: 'unknown', noReplay: true }
      }
      this.#rememberActiveResidentDll(target, nativeContext)
      if (settingsToSave) {
        task.settingsSavePromise ??= this.#persistWatermarkSettings(target, settingsToSave, owner)
        task.settingsSaved = await task.settingsSavePromise
      }
      return { success: true, taskId: nativeTaskId, ...(settingsToSave ? { settingsSaved: task.settingsSaved } : {}) }
      })
    } finally {
      capabilityLease?.release()
    }
  }

  async callWithCallback(
    params: DllPluginCallParams,
    caller: CallerIdentity
  ): Promise<Record<string, unknown>> {
    const requestedTaskId = params.params.taskId
    if (typeof requestedTaskId !== 'string' || !TASK_ID_PATTERN.test(requestedTaskId)) {
      throw new ZToolsError(errorCodes.invalidRequest, t('dll.error.missingTaskId'), {
        i18nKey: 'dll.error.missingTaskId'
      })
    }
    const owner = copyTaskOwner(caller)
    const taskKey = taskOwnerKey(owner, requestedTaskId)
    if (this.#tasks.has(taskKey) || this.#reservedTaskIds.has(taskKey)) {
      throw new ZToolsError(errorCodes.invalidRequest, t('dll.error.callbackTaskIdInUse'), {
        i18nKey: 'dll.error.callbackTaskIdInUse'
      })
    }
    const reservation: TaskReservation = { owner }
    this.#reservedTaskIds.set(taskKey, reservation)
    let capabilityLease: RuntimeCapabilityLease | undefined
    try {
      return await this.#trackTaskStart(owner, async () => {
        const { target, localizedCallParams, settingsToSave } = await this.#prepareTaskInvocation(
          params,
          owner,
          (lease) => { capabilityLease = lease }
        )
        if (target.requireAdmin) {
          const service = this.#requireServiceTasks()
          await service.enableTaskEvents?.().catch(() => false)
          const nativeTaskId = `task_${randomUUID()}`
          const task: TaskRecord = {
            ...target,
            externalTaskId: requestedTaskId,
            nativeTaskId,
            backend: 'service',
            owner,
            mode: 'callback',
            functionName: params.func,
            cancelRequested: false,
            cancelSent: false,
            status: 'invoking',
            progress: 0,
            startState: 'ack-pending',
            nativeTaskObserved: false,
            ...(settingsToSave ? { pendingWatermarkSettings: settingsToSave, pendingWatermarkCaller: owner } : {})
          }
          this.#attachCapabilityLease(task, capabilityLease)
          capabilityLease = undefined
          this.#rememberTask(task)
          try {
            await service.callDllWithCallback(target.pluginId, target.dllId, params.func, nativeTaskId, localizedCallParams)
            task.startState = 'started'
            task.status = 'running'
            if (task.cancelRequested) void this.#sendTaskCancellation(task).catch(() => undefined)
            this.#startServiceTaskPolling(task)
            if (settingsToSave) {
              task.settingsSaved = await this.#persistWatermarkSettings(target, settingsToSave, owner)
            }
            return {
              success: true,
              taskId: requestedTaskId,
              ...(settingsToSave ? { settingsSaved: task.settingsSaved } : {})
            }
          } catch (error) {
            this.#forgetTask(task)
            throw error
          }
        }
        const nativeContext = this.#nativeContext(owner)
        const preassignedTaskId = `task_${randomUUID()}`
        const attempt = this.#requireNativeHost().beginDllCallbackTask(
          target.pluginId,
          target.dllId,
          params.func,
          localizedCallParams,
          nativeContext,
          undefined,
          preassignedTaskId
        )
        let resolveStartOutcome!: (outcome: NativeDllTaskStartOutcome) => void
        const startOutcome = new Promise<NativeDllTaskStartOutcome>((resolve) => {
          resolveStartOutcome = resolve
        })
        const task: TaskRecord = {
          ...target,
          externalTaskId: requestedTaskId,
          nativeTaskId: attempt.taskId,
          backend: 'native',
          owner,
          nativeContext,
          mode: 'callback',
          functionName: params.func,
          cancelRequested: false,
          cancelSent: false,
          status: 'running',
          progress: 0,
          startState: 'ack-pending',
          nativeTaskObserved: false,
          startOutcome,
          resolveStartOutcome,
          ...(settingsToSave ? { pendingWatermarkSettings: settingsToSave, pendingWatermarkCaller: owner } : {})
        }
        this.#attachCapabilityLease(task, capabilityLease)
        capabilityLease = undefined
        this.#rememberTask(task)
        void attempt.outcome.then((outcome) => this.#settleNativeTaskStart(task, outcome)).catch(() => undefined)
        const deadline = Date.now() + this.#taskStartAckTimeoutMs
        const outcome = await this.#awaitUntil(startOutcome, deadline)
        if (outcome === DEADLINE_EXCEEDED) {
          if (task.startState === 'ack-pending') task.startState = 'unknown'
          if (task.startState === 'started') {
            if (settingsToSave) {
              task.settingsSavePromise ??= this.#persistWatermarkSettings(target, settingsToSave, owner)
              task.settingsSaved = await task.settingsSavePromise
            }
            return {
              success: true,
              taskId: requestedTaskId,
              ...(settingsToSave ? { settingsSaved: task.settingsSaved } : {})
            }
          }
          return {
            success: true,
            taskId: requestedTaskId,
            taskStartPending: task.nativeTaskObserved !== true,
            ...(settingsToSave ? { settingsSavedPending: true } : {})
          }
        }
        if (outcome.kind === 'not-started') {
          const errorCode = (outcome.error as Error & { code?: unknown }).code
          return {
            success: false,
            error: resolveNativeErrorMessage(outcome.error.message, 'dll.error.nativeHostNotStarted'),
            taskStartResolved: 'not-started',
            workNotStarted: true,
            ...(typeof errorCode === 'string' ? { code: errorCode } : {})
          }
        }
        if (outcome.kind !== 'started') throw outcome.error
        this.#rememberActiveResidentDll(target, nativeContext)
        if (settingsToSave) {
          task.settingsSavePromise ??= this.#persistWatermarkSettings(target, settingsToSave, owner)
          task.settingsSaved = await task.settingsSavePromise
        }
        return {
          success: true,
          taskId: requestedTaskId,
          ...(settingsToSave ? { settingsSaved: task.settingsSaved } : {})
        }
      })
    } finally {
      capabilityLease?.release()
      if (!this.#tasks.has(taskKey) && this.#reservedTaskIds.get(taskKey) === reservation) {
        this.#reservedTaskIds.delete(taskKey)
        this.#releaseClosedCallerWhenIdle(owner)
      }
    }
  }

  async queryTask(params: DllPluginTaskParams, caller: CallerIdentity): Promise<Record<string, unknown>> {
    const target = await this.#resolve(params.plugin, caller)
    const task = this.#requireTask(params.taskId, target, caller)
    this.#canExposeTaskResult(task)
    const startPending = task.backend === 'native' &&
      (task.startState === 'ack-pending' || task.startState === 'unknown') && task.nativeTaskObserved !== true
    const wasTerminal = finalTaskStatus(task.status)
    const startEndedWithoutNativeTask = task.startState === 'not-started' || task.startState === 'host-exited'
    const shouldReconcile = !startPending && !startEndedWithoutNativeTask && (!wasTerminal || task.data === undefined)
    if (shouldReconcile) {
      let status: NativeDllTaskStatus | undefined
      try {
        status = task.backend === 'service'
          ? await this.#requireServiceTasks().queryDllTask(task.pluginId, task.dllId, task.nativeTaskId)
          : await this.#requireNativeHost().queryDllTask(
            task.pluginId,
            task.dllId,
            task.nativeTaskId,
            task.nativeContext
          )
      } catch (error) {
        if (!finalTaskStatus(task.status)) throw error
      }
      if (status) {
        if (task.backend === 'service') {
          this.#applyServiceTaskStatus(task, status, true)
        } else if (!finalTaskStatus(task.status)) {
          if (finalTaskStatus(status.status)) this.#setTerminalStatus(task, status.status)
          else task.status = status.status
          task.progress = status.status === 'completed'
            ? 100
            : Math.max(task.progress, status.progress)
        }

        // A native terminal record may be observed before its callback-result event reaches
        // this process. Keep the first terminal status frozen, but recover its matching raw
        // callback envelope while NativeHost still retains it.
        if (task.backend === 'native' &&
          task.data === undefined &&
          finalTaskStatus(task.status) &&
          status.status === task.status &&
          typeof status.result === 'string'
        ) {
          const terminalResult = parseCallbackResult(status.result)
          if (terminalResult.status === task.status) {
            task.data = terminalResult.value
            if (task.status === 'error' && !task.error && terminalResult.error) {
              task.error = terminalResult.error
            }
          }
        }
        if (task.backend === 'native' && status.status === task.status && status.error && !task.error) {
          const nativeError = parseCallbackResult(status.error)
          task.error = nativeError.error ?? localizeDllErrorString(status.error)
        }
      }
    }
    this.#canExposeTaskResult(task)
    const permissionRevoked = task.permissionRevoked === true
    return {
      success: true,
      queryOk: true,
      taskId: task.externalTaskId,
      pluginName: task.dllId,
      funcName: task.functionName,
      taskDone: finalTaskStatus(task.status),
      taskStatus: permissionRevoked ? 'error' : task.status,
      taskProgress: task.status === 'completed' ? 100 : task.progress,
      ...(task.cancelRequested || permissionRevoked ? { taskCancelRequested: true } : {}),
      ...(permissionRevoked ? { taskPermissionRevoked: true } : {}),
      ...(startPending || task.startState === 'unknown' ? { taskStartPending: true } : {}),
      ...(task.startState === 'not-started' ? { taskStartResolved: 'not-started', workNotStarted: true } : {}),
      ...(task.startState === 'host-exited' ? { workOutcome: 'unknown', noReplay: true } : {}),
      ...(task.startErrorCode ? { code: task.startErrorCode } : {}),
      ...(!permissionRevoked && task.data !== undefined ? { taskData: task.data } : {}),
      ...(permissionRevoked ? { taskError: t('dll.error.screenCaptureRevokedStopping') } :
        task.error ? { taskError: task.error } : {})
    }
  }

  async cancelTask(params: DllPluginTaskParams, caller: CallerIdentity): Promise<Record<string, unknown>> {
    const target = await this.#resolve(params.plugin, caller)
    const task = this.#requireTask(params.taskId, target, caller)
    if (finalTaskStatus(task.status)) return { success: true }
    if (task.cancelRequested) return { success: true }
    task.cancelRequested = true
    if ((task.startState === 'ack-pending' || task.startState === 'unknown') && task.nativeTaskObserved !== true) {
      return { success: true, taskCancelPending: true }
    }
    const code = await this.#sendTaskCancellation(task)
    if (code !== 0) return { success: false, error: t('dll.cancelFailedWithCode', { code }), code }
    return { success: true }
  }

  async clearCallbackTask(
    params: DllPluginClearTaskParams,
    caller: CallerIdentity
  ): Promise<Record<string, unknown>> {
    this.#requireRunning()
    const owner = copyTaskOwner(caller)
    const taskKey = taskOwnerKey(owner, params.taskId)
    const task = this.#tasks.get(taskKey)
    if (!task) {
      const reservation = this.#reservedTaskIds.get(taskKey)
      if (reservation) {
        this.#requireReservationOwner(reservation, caller)
        throw new ZToolsError(errorCodes.pluginBusy, t('dll.error.callbackStartUnconfirmed'), {
          i18nKey: 'dll.error.callbackStartUnconfirmed'
        })
      }
      return { success: true }
    }
    this.#requireTaskOwner(task, caller)
    if (!finalTaskStatus(task.status)) {
      throw new ZToolsError(errorCodes.pluginBusy, t('dll.error.callbackStopUnconfirmed'), {
        i18nKey: 'dll.error.callbackStopUnconfirmed'
      })
    }
    if (task.startState === 'not-started' || task.startState === 'host-exited') {
      this.#forgetTask(task)
      return { success: true }
    }
    if (task.backend === 'service') {
      await this.#requireServiceTasks().clearDllTask(task.pluginId, task.dllId, task.nativeTaskId)
    } else {
      await this.#requireNativeHost().clearDllTask(task.pluginId, task.dllId, task.nativeTaskId, task.nativeContext)
    }
    this.#forgetTask(task)
    return { success: true }
  }

  unloadPlugin(pluginId: string): Promise<void> {
    this.#requireRunning()
    const key = pluginId.toLowerCase()
    const active = this.#pluginUnloads.get(key)
    if (active) return active
    const operation = this.#unloadPlugin(pluginId, key).finally(() => {
      this.#quiescingPlugins.delete(key)
      if (this.#pluginUnloads.get(key) === operation) this.#pluginUnloads.delete(key)
    })
    this.#pluginUnloads.set(key, operation)
    return operation
  }

  async #unloadPlugin(pluginId: string, key: string): Promise<void> {
    this.#quiescingPlugins.add(key)
    const installed = (await this.manifests.list()).data.find((item) =>
      typeof item.id === 'string' && sameIdentity(item.id, pluginId)
    )
    if (!installed || typeof installed.id !== 'string') return
    const installedId = installed.id
    const deadline = Date.now() + this.#taskQuiesceTimeoutMs
    while (Date.now() < deadline) {
      const tasks = [...new Set(this.#tasks.values())].filter((task) =>
        sameIdentity(task.pluginId, installedId) ||
        (task.owner.pluginId !== undefined && sameIdentity(task.owner.pluginId, installedId))
      )
      const starts = [...this.#pendingTaskStarts.keys()]
      const reservations = [...this.#reservedTaskIds.values()].some((reservation) =>
        reservation.owner.pluginId !== undefined && sameIdentity(reservation.owner.pluginId, installedId)
      )
      if (tasks.length === 0 && starts.length === 0 && !reservations) break
      const disposals = tasks.map((task) => this.#disposeTask(task, deadline))
      const settled = await this.#awaitUntil(Promise.allSettled([...starts, ...disposals]), deadline)
      if (settled === DEADLINE_EXCEEDED) break
      if (Date.now() < deadline && (tasks.length > 0 || starts.length > 0 || reservations)) {
        const delay = Math.min(this.#taskQuiescePollIntervalMs, Math.max(0, deadline - Date.now()))
        if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay))
      }
    }

    const remains = [...new Set(this.#tasks.values())].some((task) =>
      sameIdentity(task.pluginId, installedId) ||
      (task.owner.pluginId !== undefined && sameIdentity(task.owner.pluginId, installedId))
    )
    const hasPendingStart = this.#pendingTaskStarts.size > 0 ||
      [...this.#reservedTaskIds.values()].some((reservation) =>
        reservation.owner.pluginId !== undefined && sameIdentity(reservation.owner.pluginId, installedId)
      )
    if (remains || hasPendingStart) {
      throw new ZToolsError(errorCodes.pluginBusy, t('dll.error.taskStopUnconfirmedUnload'), {
        i18nKey: 'dll.error.taskStopUnconfirmedUnload'
      })
    }

    if (this.runtimePlatform === 'darwin' || installed.requireAdmin === true) return
    const dllId = typeof installed.dllloader === 'string' ? dllIdFromLoader(installed.dllloader) : ''
    if (!dllId) return
    const native = this.#requireNativeHost()
    if (!native.unloadDll) {
      throw new ZToolsError(errorCodes.nativeHostUnavailable, t('dll.error.unloadNotSupported'), {
        i18nKey: 'dll.error.unloadNotSupported'
      })
    }
    let releaseMaintenance: (() => void) | undefined
    if (typeof native.acquirePluginMaintenance !== 'function') {
      throw new ZToolsError(errorCodes.nativeHostUnavailable, t('dll.error.maintenanceLockNotConfigured'), {
        i18nKey: 'dll.error.maintenanceLockNotConfigured'
      })
    }
    const lockPromise = native.acquirePluginMaintenance(installedId)
      const acquired = await this.#awaitUntil(lockPromise, deadline)
      if (acquired === DEADLINE_EXCEEDED) {
        void lockPromise.then((release) => release()).catch(() => undefined)
        throw new ZToolsError(errorCodes.pluginBusy, t('dll.error.maintenanceLockTimeout'), {
          i18nKey: 'dll.error.maintenanceLockTimeout'
        })
      }
    releaseMaintenance = acquired
    try {
      const unloadPromise = native.unloadDll(installedId, dllId)
      const unloaded = await this.#awaitUntil(unloadPromise, deadline)
      if (unloaded === DEADLINE_EXCEEDED) {
        const releaseAfterUnload = releaseMaintenance
        releaseMaintenance = undefined
        void unloadPromise.then(releaseAfterUnload, releaseAfterUnload)
        throw new ZToolsError(errorCodes.pluginBusy, t('dll.error.unloadTimeout'), {
          i18nKey: 'dll.error.unloadTimeout'
        })
      }
      this.#forgetActiveResidentDllsForPlugin(installedId)
    } finally {
      releaseMaintenance?.()
    }
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise
    this.#stopped = true
    this.#activeResidentDlls.clear()
    this.#localeCapableDllCache.clear()
    this.#stopDeadlineMs = Date.now() + this.#taskQuiesceTimeoutMs
    this.#removeWindowListener?.()
    for (const task of this.#tasks.values()) {
      if (!finalTaskStatus(task.status)) task.cancelRequested = true
    }
    this.#stopPromise = this.#drainTasks(this.#stopDeadlineMs).then(async () => {
      if (this.#tasks.size > 0 || this.#pendingTaskStarts.size > 0 || this.#reservedTaskIds.size > 0) return
      const releases = [...this.#nativeOwners.values()].map(({ context }) =>
        Promise.resolve().then(() => this.nativeHost?.releaseOwner?.(context)))
      const released = await this.#awaitUntil(Promise.allSettled(releases), this.#stopDeadlineMs ?? Date.now())
      if (released === DEADLINE_EXCEEDED) return
      this.#nativeOwners.clear()
    })
    return this.#stopPromise
  }

  async #resolve(dllId: string, caller: CallerIdentity): Promise<ResolvedDll> {
    this.#requireRunning()
    const common = this.runtimePlatform === 'darwin' ? undefined : findCommonPlugin(dllId)
    let pluginId: string
    if (caller.type === 'plugin') {
      if (!caller.pluginId) {
        throw new ZToolsError(errorCodes.permissionDenied, t('dll.error.callerMissingPluginId'), {
          i18nKey: 'dll.error.callerMissingPluginId'
        })
      }
      pluginId = caller.pluginId
    } else {
      const installed = (await this.manifests.list()).data
      const candidates: Record<string, unknown>[] = []
      for (const item of installed) {
        if (typeof item.id !== 'string') continue
        const ids = this.runtimePlatform === 'darwin'
          ? await this.#macDeclaredIds(item.id).catch(() => [])
          : [dllIdFromLoader(typeof item.dllloader === 'string' ? item.dllloader : '')]
        if (ids.some((id) => this.runtimePlatform === 'darwin' ? id === dllId : id.toLowerCase() === dllId.toLowerCase())) {
          candidates.push(item)
        }
      }
      if (candidates.length === 0) {
        if (common) return commonTarget(common)
        throw new ZToolsError(errorCodes.pluginNotFound, t('dll.error.pluginNotFound'), {
          i18nKey: 'dll.error.pluginNotFound'
        })
      }
      if (candidates.length !== 1 || typeof candidates[0]?.id !== 'string') {
        throw new ZToolsError(errorCodes.permissionDenied, t('dll.error.pluginNameAmbiguous'), {
          i18nKey: 'dll.error.pluginNameAmbiguous'
        })
      }
      pluginId = candidates[0].id
    }
    return this.manifests.withPluginManifest(pluginId, async (manifest, metadata) => {
      this.#assertPluginAvailable(manifest.id)
      if (this.runtimePlatform === 'darwin' && (manifest.requireAdmin || manifest.dllloader)) {
        throw new ZToolsError(errorCodes.notSupported, t('dll.error.macUnsupportedLegacyFields'), {
          i18nKey: 'dll.error.macUnsupportedLegacyFields'
        })
      }
      const declaredDllId = this.runtimePlatform === 'darwin'
        ? metadata?.macNativeComponents?.find((component) => component.id === dllId)?.id ?? ''
        : dllIdFromLoader(manifest.dllloader)
      if (!declaredDllId) {
        if (common && caller.type === 'plugin') return commonTarget(common)
        throw new ZToolsError(errorCodes.pluginNotFound, t('dll.error.pluginNoDeclaredDll'), {
          i18nKey: 'dll.error.pluginNoDeclaredDll'
        })
      }
      if (this.runtimePlatform === 'darwin' ? declaredDllId !== dllId : declaredDllId.toLowerCase() !== dllId.toLowerCase()) {
        if (common && caller.type === 'plugin') return commonTarget(common)
        throw new ZToolsError(errorCodes.permissionDenied, t('dll.error.pluginDeclaredDllOnly'), {
          i18nKey: 'dll.error.pluginDeclaredDllOnly'
        })
      }
      return {
        pluginId,
        dllId: declaredDllId,
        requireAdmin: manifest.requireAdmin,
        manifest,
        ...(metadata?.signedCommonLibs && metadata.signedCommonLibs.length > 0
          ? { signedCommonLibs: metadata.signedCommonLibs }
          : {})
      }
    })
  }

  #macDeclaredIds(pluginId: string): Promise<string[]> {
    return this.manifests.withPluginManifest(pluginId, async (manifest, metadata) => {
      if (manifest.requireAdmin || manifest.dllloader) {
        throw new ZToolsError(errorCodes.notSupported, t('dll.error.macUnsupportedLegacyFields'), {
          i18nKey: 'dll.error.macUnsupportedLegacyFields'
        })
      }
      return metadata?.macNativeComponents?.map((component) => component.id) ?? []
    })
  }

  #requireNativeHost(): NativeDllRuntimePort {
    if (!this.nativeHost) {
      throw new ZToolsError(errorCodes.nativeHostUnavailable, t('dll.error.nativeHostNotConfigured'), {
        i18nKey: 'dll.error.nativeHostNotConfigured'
      })
    }
    return this.nativeHost
  }

  #requireService(): PrivilegedDllTaskClientPort {
    if (!this.serviceClient || this.serviceClient.diagnostics.state !== 'ready') {
      throw new ZToolsError(
        errorCodes.serviceUnavailable,
        t('dll.error.serviceNotAuthenticated'),
        { i18nKey: 'dll.error.serviceNotAuthenticated' }
      )
    }
    return this.serviceClient
  }

  #requireServiceTasks(): PrivilegedDllTaskClientPort {
    const service = this.#requireService()
    if (typeof service.callDllAsync !== 'function' ||
        typeof service.callDllWithCallback !== 'function' ||
        typeof service.queryDllTask !== 'function' ||
        typeof service.cancelDllTask !== 'function' ||
        typeof service.clearDllTask !== 'function') {
      throw new ZToolsError(errorCodes.notSupported, t('dll.error.serviceTasksNotSupported'), {
        i18nKey: 'dll.error.serviceTasksNotSupported'
      })
    }
    return service
  }

  #startServiceTaskPolling(task: TaskRecord): void {
    if (task.backend !== 'service' || task.callbackPollTimer || task.callbackPollInFlight ||
        this.#stopped || finalTaskStatus(task.status) || this.#nativeTasks.get(task.nativeTaskId) !== task) return
    if (this.serviceClient?.taskEventsEnabled && task.callbackEventChecked && !task.callbackEventDirty) return
    const timer = setTimeout(() => {
      delete task.callbackPollTimer
      void this.#pollServiceTask(task)
    }, task.callbackPollDelay ?? 150)
    timer.unref?.()
    task.callbackPollTimer = timer
  }

  async #pollServiceTask(task: TaskRecord): Promise<void> {
    if (this.#stopped || task.backend !== 'service' ||
        this.#nativeTasks.get(task.nativeTaskId) !== task || task.callbackPollInFlight) return
    task.callbackPollInFlight = true
    task.callbackEventDirty = false
    try {
      const status = await this.#requireServiceTasks().queryDllTask(
        task.pluginId,
        task.dllId,
        task.nativeTaskId
      )
      if (this.#stopped || this.#nativeTasks.get(task.nativeTaskId) !== task) return
      const changed = task.status !== status.status || task.progress !== status.progress ||
        Boolean(status.callbackResults?.length) || (status.resultReady === true && task.data === undefined)
      task.callbackPollFailures = 0
      task.callbackEventChecked = true
      task.callbackPollDelay = changed ? 150 : Math.min((task.callbackPollDelay || 150) * 2, 1_000)
      this.#applyServiceTaskStatus(task, status, true)
    } catch {
      if (this.#stopped || this.#nativeTasks.get(task.nativeTaskId) !== task) return
      task.callbackEventChecked = false
      task.callbackPollFailures = (task.callbackPollFailures ?? 0) + 1
      task.callbackPollDelay = Math.min((task.callbackPollDelay || 150) * 2, 5_000)
    } finally {
      task.callbackPollInFlight = false
      this.#startServiceTaskPolling(task)
    }
  }

  #applyServiceTaskStatus(
    task: TaskRecord,
    status: NativeDllTaskStatus,
    publish: boolean
  ): void {
    const previousStatus = task.status
    const previousProgress = task.progress
    task.startState = 'started'
    task.nativeTaskObserved = true
    if (!finalTaskStatus(task.status)) {
      if (finalTaskStatus(status.status)) this.#setTerminalStatus(task, status.status)
      else task.status = status.status
      task.progress = status.status === 'completed' ? 100 : Math.max(task.progress, status.progress)
    }
    if (status.error && !task.error) task.error = localizeDllErrorString(status.error)
    if (status.resultReady === true && task.data === undefined) {
      task.data = localizeDllErrorPayload(parseDllResult(status.result ?? null))
    }
    this.#deliverServiceCallbackResults(task, status.callbackResults)
    if (finalTaskStatus(task.status)) this.#clearTaskPolling(task)
    const rawServiceMessage = (status as NativeDllTaskStatus & { message?: unknown }).message
    const localizedServiceMessage = typeof rawServiceMessage === 'string' && rawServiceMessage.length > 0
      ? localizeDllProgressMessage(rawServiceMessage)
      : undefined
    if (publish && (previousStatus !== task.status || previousProgress !== task.progress || localizedServiceMessage !== undefined)) {
      this.#publishProgress(task, {
        percent: task.progress,
        status: task.status,
        ...(localizedServiceMessage !== undefined ? { message: localizedServiceMessage } : {}),
        ...(task.error ? { error: task.error } : {}),
        ...(task.data !== undefined ? { data: task.data } : {})
      })
    }
    if (task.cancelRequested && !task.cancelSent && !finalTaskStatus(task.status)) {
      void this.#sendTaskCancellation(task).catch(() => undefined)
    }
  }

  #deliverServiceCallbackResults(task: TaskRecord, results?: string[]): void {
    if (task.mode !== 'callback' || !results || !this.#canExposeTaskResult(task)) return
    for (const result of results) {
      const callbackResult = parseCallbackResult(result)
      this.#publishTaskEvent('dllplugin_callback_result', {
        plugin: task.dllId,
        taskId: task.externalTaskId,
        result: callbackResult.serializedResult ?? result
      }, task.owner)
    }
  }

  async #injectSignedCommonLibs(
    target: ResolvedDll,
    params: Record<string, unknown>,
    owner: CallerIdentity,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const declaredLibs = target.signedCommonLibs
    // 护栏 2 二次防线：特权 DLL（SYSTEM）严禁消费用户可写目录 CommonLibs，同时始终剥离伪造入参
    if (target.requireAdmin) {
      if (declaredLibs && declaredLibs.length > 0) {
        throw new ZToolsError(
          errorCodes.permissionDenied,
          'Privileged native plugins are forbidden from consuming CommonLibs'
        )
      }
      return withDllCommonLibs(params)
    }
    if (!declaredLibs || declaredLibs.length === 0) {
      return withDllCommonLibs(params)
    }
    if (!this.commonLibs) {
      throw new ZToolsError(
        errorCodes.notSupported,
        'CommonLibs manager is not configured for signed native plugin'
      )
    }
    const commonLibs = this.commonLibs
    const batchController = new AbortController()
    const onOuterAbort = (): void => {
      if (!batchController.signal.aborted) {
        batchController.abort(signal?.reason)
      }
    }
    if (signal?.aborted) {
      batchController.abort(signal.reason)
    } else if (signal) {
      signal.addEventListener('abort', onOuterAbort, { once: true })
    }

    const provisionTaskId = `commonlibs_${randomUUID()}`
    const perToolPercent = new Array<number>(declaredLibs.length).fill(0)
    let emittedProvisioning = false
    let maxAggregatedPercent = 0
    let settled = false

    const publishProvisionEvent = (payload: ToolProgressEvent): void => {
      try {
        this.events.publishHostToOwner('tool_runtime_progress', payload, owner)
      } catch (error) {
        console.warn('推送原生插件 CommonLibs 进度事件失败:', error)
      }
    }

    const handleToolProgress = (index: number, progress: CommonLibDownloadProgress): void => {
      if (settled) return
      emittedProvisioning = true
      const base = toCommonLibProvisionProgressPayload(progress)
      const reportedPercent =
        typeof base.percent === 'number'
          ? base.percent
          : progress.stage === 'extracting' || progress.stage === 'verifying'
            ? 99
            : perToolPercent[index] ?? 0
      if (reportedPercent > (perToolPercent[index] ?? 0)) {
        perToolPercent[index] = reportedPercent
      }
      const avgPercent = Math.min(
        99,
        Math.max(
          maxAggregatedPercent,
          Math.floor(perToolPercent.reduce((acc, value) => acc + value, 0) / declaredLibs.length)
        )
      )
      maxAggregatedPercent = avgPercent
      publishProvisionEvent({
        taskId: provisionTaskId,
        primitiveId: 'native.commonlibs',
        phase: 'provisioning',
        stage: progress.stage,
        percent: avgPercent,
        ...(base.transferredBytes !== undefined ? { transferredBytes: base.transferredBytes } : {}),
        ...(base.totalBytes !== undefined ? { totalBytes: base.totalBytes } : {}),
        ...(base.message !== undefined ? { message: base.message } : {}),
        timestamp: Date.now()
      })
    }

    const resolvedDirs: Record<string, string> = {}
    try {
      const results = await Promise.all(
        declaredLibs.map(async (toolId, index) => {
          requireNotAborted(signal)
          const verified = await commonLibs.ensureAndVerifyToolDir(toolId, batchController.signal, (progress) => {
            handleToolProgress(index, progress)
          })
          perToolPercent[index] = 100
          return [toolId, verified.toolDir] as const
        })
      )
      settled = true
      for (const [toolId, toolDir] of results) {
        commonLibs.recordLease(toolId, target.pluginId)
        resolvedDirs[toolId] = toolDir
      }
      if (emittedProvisioning) {
        publishProvisionEvent({
          taskId: provisionTaskId,
          primitiveId: 'native.commonlibs',
          phase: 'completed',
          percent: 100,
          timestamp: Date.now()
        })
      }
    } catch (error) {
      settled = true
      if (!batchController.signal.aborted) {
        batchController.abort(errorCodes.callerDestroyed)
      }
      if (emittedProvisioning) {
        const hostCode =
          typeof (error as { details?: { hostCode?: unknown } } | null)?.details?.hostCode === 'string'
            ? ((error as { details?: { hostCode?: string } }).details?.hostCode as ToolRuntimeErrorCode)
            : undefined
        const isCancelled = Boolean(signal?.aborted) || hostCode === 'TOOL_TASK_CANCELLED'
        publishProvisionEvent({
          taskId: provisionTaskId,
          primitiveId: 'native.commonlibs',
          phase: isCancelled ? 'cancelled' : 'failed',
          ...(hostCode ? { errorCode: hostCode } : {}),
          message: error instanceof Error ? error.message : String(error),
          timestamp: Date.now()
        })
      }
      throw error
    } finally {
      settled = true
      signal?.removeEventListener('abort', onOuterAbort)
    }
    return withDllCommonLibs(params, resolvedDirs)
  }

  async #authorizeMediaParams(
    target: ResolvedDll,
    functionName: string,
    params: Record<string, unknown>,
    caller: CallerIdentity
  ): Promise<Record<string, unknown>> {
    if (this.nativeMediaPolicy) {
      return await this.nativeMediaPolicy.authorizeCall(target.dllId, functionName, params, caller)
    }
    if (isBuiltInNativeMediaDll(target.dllId)) {
      throw new ZToolsError(errorCodes.notSupported, t('dll.error.mediaPolicyNotConfigured'), {
        i18nKey: 'dll.error.mediaPolicyNotConfigured'
      })
    }
    return params
  }

  #isWatermarkSettingsMethod(target: ResolvedDll, functionName: string): boolean {
    return target.dllId.toLowerCase() === 'batchvideoplugin' &&
      (functionName === 'SaveWatermarkSettings' || functionName === 'LoadWatermarkSettings')
  }

  #prepareNativeMediaCall(
    target: ResolvedDll,
    functionName: string,
    params: Record<string, unknown>
  ): { params: Record<string, unknown>; settingsToSave?: Record<string, unknown> } {
    if (target.dllId.toLowerCase() !== 'batchvideoplugin' || functionName !== 'BatchAddWatermark') {
      return { params }
    }
    const settingsToSave = params.saveSettings === true
      ? this.#watermarkSettingsFromParams(params)
      : undefined
    return {
      params: { ...params, saveSettings: false },
      ...(settingsToSave ? { settingsToSave } : {})
    }
  }

  #watermarkSettingsFromParams(params: Record<string, unknown>): Record<string, unknown> {
    const settings: Record<string, unknown> = {}
    for (const key of WATERMARK_SETTINGS_FIELDS) {
      if (Object.hasOwn(params, key)) settings[key] = params[key]
    }
    return settings
  }

  async #persistWatermarkSettings(
    target: ResolvedDll,
    settings: Record<string, unknown>,
    caller: CallerIdentity
  ): Promise<boolean> {
    const database = this.watermarkSettingsDatabase
    if (!database) return false
    try {
      await database.put({
        plugin_id: target.pluginId,
        key: WATERMARK_SETTINGS_KEY,
        value: settings,
        is_base64: false
      }, caller, new AbortController().signal)
      return true
    } catch {
      return false
    }
  }

  async #saveWatermarkSettings(
    target: ResolvedDll,
    params: Record<string, unknown>,
    caller: CallerIdentity
  ): Promise<Record<string, unknown>> {
    const settings = this.#watermarkSettingsFromParams(params)
    const settingsSaved = await this.#persistWatermarkSettings(target, settings, caller)
    return settingsSaved
      ? { success: true, message: t('dll.watermark.saved'), settings }
      : { success: false, error: t('dll.error.watermarkSaveFailed') }
  }

  async #loadWatermarkSettings(
    target: ResolvedDll,
    caller: CallerIdentity
  ): Promise<Record<string, unknown>> {
    const database = this.watermarkSettingsDatabase
    if (!database) return { success: false, error: t('dll.error.watermarkDbNotConfigured') }
    try {
      const stored = await database.get({
        plugin_id: target.pluginId,
        key: WATERMARK_SETTINGS_KEY,
        is_base64: false
      }, caller, new AbortController().signal)
      const parsed = JSON.parse(stored.data) as unknown
      if (!isRecord(parsed)) return { success: false, error: t('dll.error.watermarkDataInvalid') }
      const settings = await this.#authorizeMediaParams(target, 'SaveWatermarkSettings', parsed, caller)
      return { success: true, message: t('dll.watermark.loaded'), settings }
    } catch (error) {
      if (error instanceof ZToolsError && error.code === errorCodes.databaseKeyNotFound) {
        return { success: false, error: t('dll.error.watermarkNotSaved') }
      }
      return { success: false, error: t('dll.error.watermarkReadFailed') }
    }
  }

  #rememberTask(task: TaskRecord): void {
    const taskKey = taskOwnerKey(task.owner, task.externalTaskId)
    const existingTask = this.#tasks.get(taskKey)
    const existingNativeTask = this.#nativeTasks.get(task.nativeTaskId)
    if ((existingTask && existingTask !== task) || (existingNativeTask && existingNativeTask !== task)) {
      throw new ZToolsError(errorCodes.invalidRequest, t('dll.error.taskIdInUse'), {
        i18nKey: 'dll.error.taskIdInUse'
      })
    }
    this.#tasks.set(taskKey, task)
    this.#nativeTasks.set(task.nativeTaskId, task)
    const replay = this.#earlyNativeEvents.filter((event) => event.taskId === task.nativeTaskId)
    if (replay.length > 0) {
      const replaySet = new Set(replay)
      for (let index = this.#earlyNativeEvents.length - 1; index >= 0; index -= 1) {
        if (replaySet.has(this.#earlyNativeEvents[index]!)) this.#earlyNativeEvents.splice(index, 1)
      }
      for (const event of replay) this.#handleNativeEvent(event)
    }
    if (this.#stopped || this.#closedCallers.has(taskOwnerIdentityKey(task.owner))) {
      this.#scheduleTaskDisposal(task, this.#taskDisposalDeadline())
    }
  }

  #forgetTask(task: TaskRecord): void {
    this.#clearTaskPolling(task)
    this.#releaseCapabilityLease(task)
    const taskKey = taskOwnerKey(task.owner, task.externalTaskId)
    if (this.#tasks.get(taskKey) === task) this.#tasks.delete(taskKey)
    if (this.#nativeTasks.get(task.nativeTaskId) === task) this.#nativeTasks.delete(task.nativeTaskId)
    const reservation = this.#reservedTaskIds.get(taskKey)
    if (reservation && isSameTaskOwner(reservation.owner, task.owner)) {
      this.#reservedTaskIds.delete(taskKey)
    }
    this.#releaseClosedCallerWhenIdle(task.owner)
    this.#cleanupNativeListenerIfStopped()
  }

  async #settleNativeTaskStart(task: TaskRecord, outcome: NativeDllTaskStartOutcome): Promise<void> {
    if (this.#nativeTasks.get(task.nativeTaskId) !== task) return
    if (outcome.kind === 'started' || (outcome.kind === 'not-started' && task.nativeTaskObserved)) {
      const wasUnknown = task.startState === 'unknown'
      task.startState = 'started'
      task.nativeTaskObserved = true
      if (!finalTaskStatus(task.status) && task.status === 'invoking') task.status = 'running'
      task.resolveStartOutcome?.({ kind: 'started' })
      if (task.pendingWatermarkSettings && task.pendingWatermarkCaller && !task.settingsSavePromise) {
        task.settingsSavePromise = this.#persistWatermarkSettings(
          task,
          task.pendingWatermarkSettings,
          task.pendingWatermarkCaller
        )
        if (wasUnknown) {
          void task.settingsSavePromise.then((settingsSaved) => {
            task.settingsSaved = settingsSaved
            this.#publishProgress(task, {
              status: finalTaskStatus(task.status) ? task.status : 'running',
              taskStartResolved: true,
              taskStartPending: false,
              settingsSaved
            })
          })
        }
      }
      if (wasUnknown) {
        this.#publishProgress(task, {
          status: finalTaskStatus(task.status) ? task.status : 'running',
          taskStartResolved: true,
          taskStartPending: false
        })
      }
      if (task.cancelRequested && !finalTaskStatus(task.status)) {
        void this.#sendTaskCancellation(task).catch(() => undefined)
      }
      if (this.#stopped || this.#closedCallers.has(taskOwnerIdentityKey(task.owner))) {
        this.#scheduleTaskDisposal(task, this.#taskDisposalDeadline())
      }
      return
    }

    const wasUnknown = task.startState === 'unknown'
    task.startState = outcome.kind === 'not-started' ? 'not-started' : 'host-exited'
    task.resolveStartOutcome?.(outcome)
    const error = resolveNativeErrorMessage(outcome.error.message, 'dll.error.nativeHostStartUnconfirmed')
    if (task.mode === 'async') {
      const code = (outcome.error as Error & { code?: unknown }).code
      if (typeof code === 'string') task.startErrorCode = code
      this.#setTerminalStatus(task, 'error')
      task.error = error
      if (wasUnknown) this.#publishProgress(task, { status: task.status, error, taskStartPending: false,
        ...(outcome.kind === 'not-started' ? { taskStartResolved: 'not-started', workNotStarted: true } :
          { taskStartResolved: true, workOutcome: 'unknown', noReplay: true }),
        ...(task.startErrorCode ? { code: task.startErrorCode } : {}) })
      return
    }
    if (outcome.kind === 'host-exited' && task.nativeTaskObserved && !finalTaskStatus(task.status)) {
      this.#setTerminalStatus(task, 'error')
      task.error = error
    }
    if (wasUnknown) {
      if (outcome.kind === 'not-started') {
        const errorCode = (outcome.error as Error & { code?: unknown }).code
        this.#publishTaskEvent('dllplugin_callback_result', {
          plugin: task.dllId,
          taskId: task.externalTaskId,
          error: task.error ?? error,
          taskStartResolved: 'not-started',
          workNotStarted: true,
          ...(typeof errorCode === 'string' ? { code: errorCode } : {})
        }, task.owner)
      } else {
        this.#publishProgress(task, {
          status: finalTaskStatus(task.status) ? task.status : 'error',
          error: task.error ?? error,
          taskStartResolved: true,
          taskStartPending: false
        })
      }
    }
    this.#forgetTask(task)
  }

  async #sendTaskCancellation(task: TaskRecord): Promise<number> {
    if (finalTaskStatus(task.status)) return 0
    if (task.cancelSent) return 0
    task.cancelRequested = true
    task.cancelSent = true
    try {
      const code = task.backend === 'service'
        ? await this.#requireServiceTasks().cancelDllTask(task.pluginId, task.dllId, task.nativeTaskId)
        : await this.#requireNativeHost().cancelDllTask(
          task.pluginId,
          task.dllId,
          task.nativeTaskId,
          task.nativeContext
        )
      if (code !== 0 && !finalTaskStatus(task.status)) {
        task.cancelRequested = false
        task.cancelSent = false
      }
      return code
    } catch (error) {
      if (!finalTaskStatus(task.status)) {
        task.cancelRequested = false
        task.cancelSent = false
      }
      throw error
    }
  }

  #requireReservationOwner(reservation: TaskReservation, caller: CallerIdentity): void {
    if (!isSameTaskOwner(reservation.owner, caller)) {
      throw new ZToolsError(errorCodes.invalidRequest, t('dll.error.callbackTaskNotFoundOrNotOwned'), {
        i18nKey: 'dll.error.callbackTaskNotFoundOrNotOwned'
      })
    }
  }

  async #trackTaskStart<T>(owner: CallerIdentity, start: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(start)
    this.#pendingTaskStarts.set(pending, owner)
    try {
      return await pending
    } finally {
      this.#pendingTaskStarts.delete(pending)
      this.#releaseClosedCallerWhenIdle(owner)
      this.#cleanupNativeListenerIfStopped()
    }
  }

  #nativeContext(owner: CallerIdentity): NativeDllInvocationContext {
    this.#requireTaskStartCaller(owner)
    const key = taskOwnerIdentityKey(owner)
    const existing = this.#nativeOwners.get(key)
    if (existing) return existing.context
    if (this.#nativeGeneration >= 0xffffffffffffffffn) {
      throw new ZToolsError(errorCodes.internalError, 'Native owner generation exhausted')
    }
    let token = 0n
    while (token === 0n) token = randomBytes(8).readBigUInt64BE()
    const context = Object.freeze({
      ownerToken: token.toString(),
      generation: (++this.#nativeGeneration).toString(),
      pluginInstanceId: owner.pluginInstanceId ?? 'main:' + owner.webContentsId,
      webContentsId: owner.webContentsId
    })
    this.#nativeOwners.set(key, { owner: copyTaskOwner(owner), context })
    return context
  }

  #requireTaskStartCaller(owner: CallerIdentity): void {
    if (this.#stopped || this.#closedCallers.has(taskOwnerIdentityKey(owner))) {
      throw new ZToolsError(errorCodes.appStopping, t('dll.error.callerWindowClosing'), {
        i18nKey: 'dll.error.callerWindowClosing'
      })
    }
    if (owner.pluginId) this.#assertPluginAvailable(owner.pluginId)
  }

  #assertPluginAvailable(pluginId: string): void {
    if (this.#quiescingPlugins.has(pluginId.toLowerCase())) {
      throw new ZToolsError(errorCodes.pluginBusy, t('dll.error.pluginStopping'), {
        i18nKey: 'dll.error.pluginStopping'
      })
    }
  }

  #beginScreenCaptureOperation(
    target: ResolvedDll,
    functionName: string,
    owner: CallerIdentity
  ): RuntimeCapabilityLease | undefined {
    if (!isScreenCaptureDllOperation(target, functionName)) return undefined
    if (!this.capabilityAuthorization && owner.type === 'plugin') {
      throw new ZToolsError(errorCodes.notSupported, t('dll.error.screenCaptureAuthUnavailable'), {
        i18nKey: 'dll.error.screenCaptureAuthUnavailable'
      })
    }
    const lease = this.capabilityAuthorization?.beginOperation('screen.capture', owner)
    if (owner.type === 'plugin' && !lease) {
      throw new ZToolsError(errorCodes.permissionDenied, t('dll.error.screenCaptureNotAuthorized'), {
        i18nKey: 'dll.error.screenCaptureNotAuthorized'
      })
    }
    return lease
  }

  #combineSignals(first?: AbortSignal, second?: AbortSignal): AbortSignal | undefined {
    if (!first) return second
    if (!second) return first
    return AbortSignal.any([first, second])
  }

  #attachCapabilityLease(task: TaskRecord, lease: RuntimeCapabilityLease | undefined): void {
    if (!lease) return
    task.permissionLease = lease
    const revoke = () => {
      if (task.permissionRevoked) return
      task.permissionRevoked = true
      task.cancelRequested = true
      task.error = t('dll.error.screenCaptureRevoked')
      if (task.nativeTaskObserved && !finalTaskStatus(task.status)) {
        void this.#sendTaskCancellation(task).catch(() => undefined)
      }
    }
    task.permissionAbortListener = revoke
    lease.signal.addEventListener('abort', revoke, { once: true })
    if (lease.signal.aborted) revoke()
  }

  #releaseCapabilityLease(task: TaskRecord): void {
    const lease = task.permissionLease
    if (!lease) return
    if (task.permissionAbortListener) lease.signal.removeEventListener('abort', task.permissionAbortListener)
    delete task.permissionLease
    delete task.permissionAbortListener
    lease.release()
  }

  #canExposeTaskResult(task: TaskRecord): boolean {
    if (task.permissionRevoked) return false
    if (!task.permissionLease) return true
    try {
      task.permissionLease.assertCurrent()
      return true
    } catch {
      task.permissionAbortListener?.()
      return false
    }
  }

  #handleCallerRemoved(webContentsId: number): void {
    const ownedTasks = [...this.#tasks.values()].filter((task) => task.owner.webContentsId === webContentsId)
    const pendingOwners = [...this.#pendingTaskStarts.values()].filter((owner) => owner.webContentsId === webContentsId)
    const reservedOwners = [...this.#reservedTaskIds.values()]
      .map((reservation) => reservation.owner)
      .filter((owner) => owner.webContentsId === webContentsId)
    const closedOwners = new Map<string, CallerIdentity>()
    for (const owner of [...pendingOwners, ...reservedOwners, ...ownedTasks.map((task) => task.owner)]) {
      closedOwners.set(taskOwnerIdentityKey(owner), owner)
    }
    for (const { owner } of this.#nativeOwners.values()) {
      if (owner.webContentsId === webContentsId) closedOwners.set(taskOwnerIdentityKey(owner), owner)
    }
    for (const key of closedOwners.keys()) this.#closedCallers.add(key)
    const deadline = Date.now() + this.#taskQuiesceTimeoutMs
    for (const task of ownedTasks) {
      if (!finalTaskStatus(task.status)) task.cancelRequested = true
      this.#scheduleTaskDisposal(task, deadline)
    }
    for (const owner of closedOwners.values()) this.#releaseClosedCallerWhenIdle(owner)
  }

  #releaseClosedCallerWhenIdle(owner: CallerIdentity): void {
    const ownerKey = taskOwnerIdentityKey(owner)
    if (!this.#closedCallers.has(ownerKey)) return
    if ([...this.#pendingTaskStarts.values()].some((pendingOwner) => isSameTaskOwner(pendingOwner, owner))) return
    if ([...this.#reservedTaskIds.values()].some((reservation) => isSameTaskOwner(reservation.owner, owner))) return
    if ([...this.#tasks.values()].some((task) => isSameTaskOwner(task.owner, owner))) return
    const nativeOwner = this.#nativeOwners.get(ownerKey)
    if (nativeOwner) {
      this.#nativeOwners.delete(ownerKey)
      // 同步清理绑定该已释放 ownerToken 的活跃原生记录，防止后续 syncLocale 持失效上下文触发孤儿调用
      for (const [key, entry] of this.#activeResidentDlls.entries()) {
        if (entry.context?.ownerToken === nativeOwner.context.ownerToken) {
          this.#activeResidentDlls.delete(key)
        }
      }
      void Promise.resolve().then(() => this.nativeHost?.releaseOwner?.(nativeOwner.context))
        .catch(() => undefined)
    }
    this.#closedCallers.delete(ownerKey)
  }

  #setTerminalStatus(task: TaskRecord, status: 'completed' | 'cancelled' | 'error'): boolean {
    if (finalTaskStatus(task.status)) return false
    task.status = status
    task.cancelRequested = false
    this.#clearTaskPolling(task)
    this.#releaseCapabilityLease(task)
    if (this.#stopped || this.#closedCallers.has(taskOwnerIdentityKey(task.owner))) {
      this.#scheduleTaskDisposal(task, this.#taskDisposalDeadline())
    }
    return true
  }

  #scheduleTaskDisposal(task: TaskRecord, deadline: number): void {
    const active = this.#taskDisposals.get(task.nativeTaskId)
    if (active) {
      const existingDeadline = this.#taskDisposalRetryDeadlines.get(task.nativeTaskId) ?? 0
      this.#taskDisposalRetryDeadlines.set(task.nativeTaskId, Math.max(existingDeadline, deadline))
      return
    }
    void this.#disposeTask(task, deadline)
  }

  #taskDisposalDeadline(): number {
    return this.#stopDeadlineMs ?? Date.now() + this.#taskQuiesceTimeoutMs
  }

  #disposeTask(task: TaskRecord, deadline: number): Promise<void> {
    const active = this.#taskDisposals.get(task.nativeTaskId)
    if (active) return active
    const disposal = Promise.resolve()
      .then(async () => await this.#quiesceAndClearTask(task, deadline))
      .catch(() => undefined)
      .finally(() => {
        if (this.#taskDisposals.get(task.nativeTaskId) === disposal) {
          this.#taskDisposals.delete(task.nativeTaskId)
        }
        const retryDeadline = this.#taskDisposalRetryDeadlines.get(task.nativeTaskId)
        if (retryDeadline !== undefined) {
          this.#taskDisposalRetryDeadlines.delete(task.nativeTaskId)
          if (this.#nativeTasks.get(task.nativeTaskId) === task) {
            this.#scheduleTaskDisposal(task, retryDeadline)
          }
        }
        this.#cleanupNativeListenerIfStopped()
      })
    this.#taskDisposals.set(task.nativeTaskId, disposal)
    return disposal
  }

  async #quiesceAndClearTask(task: TaskRecord, deadline: number): Promise<void> {
    if (this.#nativeTasks.get(task.nativeTaskId) !== task) return

    while (
      !finalTaskStatus(task.status) &&
      (task.startState === 'ack-pending' || task.startState === 'unknown') &&
      task.nativeTaskObserved !== true &&
      Date.now() < deadline
    ) {
      if (task.backend === 'service') {
        try {
          const status = await this.#awaitUntil(
            this.#requireServiceTasks().queryDllTask(task.pluginId, task.dllId, task.nativeTaskId),
            deadline
          )
          if (status === DEADLINE_EXCEEDED) return
          this.#applyServiceTaskStatus(task, status, false)
        } catch {
          // A failed query cannot prove the service task never started.
        }
      }
      if (taskStartConfirmed(task)) break
      const delay = Math.min(this.#taskQuiescePollIntervalMs, Math.max(0, deadline - Date.now()))
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay))
      if (this.#nativeTasks.get(task.nativeTaskId) !== task) return
    }
    if (
      !finalTaskStatus(task.status) &&
      (task.startState === 'ack-pending' || task.startState === 'unknown') &&
      task.nativeTaskObserved !== true
    ) return

    if (!finalTaskStatus(task.status) && !task.cancelSent) {
      const cancelCode = await this.#awaitUntil(this.#sendTaskCancellation(task), deadline)
      if (cancelCode === DEADLINE_EXCEEDED) return
      if (!finalTaskStatus(task.status) && cancelCode !== 0) return
    }

    while (!finalTaskStatus(task.status) && Date.now() < deadline) {
      let status: NativeDllTaskStatus | typeof DEADLINE_EXCEEDED
      try {
        status = await this.#awaitUntil(
          task.backend === 'service'
            ? this.#requireServiceTasks().queryDllTask(task.pluginId, task.dllId, task.nativeTaskId)
            : this.#requireNativeHost().queryDllTask(task.pluginId, task.dllId, task.nativeTaskId, task.nativeContext),
          deadline
        )
      } catch {
        return
      }
      if (status === DEADLINE_EXCEEDED) return
      if (task.backend === 'service') this.#applyServiceTaskStatus(task, status, false)
      else if (!finalTaskStatus(task.status)) {
        if (finalTaskStatus(status.status)) this.#setTerminalStatus(task, status.status)
        else task.status = status.status
        task.progress = status.status === 'completed' ? 100 : Math.max(task.progress, status.progress)
        if (status.error) task.error = localizeDllErrorString(status.error)
      }
      if (!finalTaskStatus(task.status)) {
        const delay = Math.min(this.#taskQuiescePollIntervalMs, Math.max(0, deadline - Date.now()))
        if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay))
      }
    }

    if (!finalTaskStatus(task.status) || this.#nativeTasks.get(task.nativeTaskId) !== task) return
    if (task.startState === 'not-started' || task.startState === 'host-exited') {
      this.#forgetTask(task)
      return
    }
    const cleared = await this.#awaitUntil(
      task.backend === 'service'
        ? this.#requireServiceTasks().clearDllTask(task.pluginId, task.dllId, task.nativeTaskId)
        : this.#requireNativeHost().clearDllTask(task.pluginId, task.dllId, task.nativeTaskId, task.nativeContext),
      deadline
    )
    if (cleared === DEADLINE_EXCEEDED) return
    this.#forgetTask(task)
  }

  async #drainTasks(deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      const starts = [...this.#pendingTaskStarts.keys()]
      const tasks = [...this.#tasks.values()]
      const hasReservations = this.#reservedTaskIds.size > 0
      if (starts.length === 0 && tasks.length === 0 && !hasReservations) break
      const disposals = tasks.map((task) => this.#disposeTask(task, deadline))
      const completed = await this.#awaitUntil(
        Promise.allSettled([...starts, ...disposals]),
        deadline
      )
      if (completed === DEADLINE_EXCEEDED) break
      if (this.#pendingTaskStarts.size === 0 && (this.#tasks.size > 0 || this.#reservedTaskIds.size > 0)) {
        const delay = Math.min(this.#taskQuiescePollIntervalMs, Math.max(0, deadline - Date.now()))
        if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay))
      }
    }
    this.#cleanupNativeListenerIfStopped()
  }

  async #awaitUntil<T>(promise: Promise<T>, deadline: number): Promise<T | typeof DEADLINE_EXCEEDED> {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      // The native operation has already started; observe a late rejection even after the deadline.
      void promise.catch(() => undefined)
      return DEADLINE_EXCEEDED
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<typeof DEADLINE_EXCEEDED>((resolve) => {
          timer = setTimeout(() => resolve(DEADLINE_EXCEEDED), remaining)
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  #cleanupNativeListenerIfStopped(): void {
    if (
      !this.#stopped ||
      this.#tasks.size > 0 ||
      this.#pendingTaskStarts.size > 0 ||
      this.#reservedTaskIds.size > 0
    ) return
    if (!this.#nativeListenerRemoved) {
      this.#removeNativeListener?.()
      this.#nativeListenerRemoved = true
    }
    if (!this.#serviceListenerRemoved) {
      this.#removeServiceListener?.()
      this.#serviceListenerRemoved = true
    }
    this.#earlyNativeEvents.length = 0
  }

  #clearTaskPolling(task: TaskRecord): void {
    if (!task.callbackPollTimer) return
    clearTimeout(task.callbackPollTimer)
    delete task.callbackPollTimer
  }

  #requireTask(taskId: string, target: ResolvedDll, caller: CallerIdentity): TaskRecord {
    const task = this.#tasks.get(taskOwnerKey(copyTaskOwner(caller), taskId))
    if (!task || !sameIdentity(task.pluginId, target.pluginId) || !sameIdentity(task.dllId, target.dllId)) {
      throw new ZToolsError(errorCodes.invalidRequest, t('dll.error.taskNotFoundOrNotPlugin'), {
        i18nKey: 'dll.error.taskNotFoundOrNotPlugin'
      })
    }
    this.#requireTaskOwner(task, caller)
    return task
  }

  #requireTaskOwner(task: TaskRecord, caller: CallerIdentity): void {
    if (!isSameTaskOwner(task.owner, caller)) {
      throw new ZToolsError(errorCodes.invalidRequest, t('dll.error.taskNotFoundOrNotOwner'), {
        i18nKey: 'dll.error.taskNotFoundOrNotOwner'
      })
    }
  }

  #handleNativeEvent(event: NativeDllEvent): void {
    const task = this.#nativeTasks.get(event.taskId)
    if (!task) {
      if (this.#stopped) return
      if (this.#earlyNativeEvents.length >= MAX_EARLY_NATIVE_EVENTS) this.#earlyNativeEvents.shift()
      this.#earlyNativeEvents.push(event)
      return
    }
    if (task.backend !== 'native') return
    if (!sameIdentity(task.pluginId, event.pluginId) || !sameIdentity(task.dllId, event.dllId)) return
    this.#canExposeTaskResult(task)
    task.nativeTaskObserved = true
    if (task.startState === 'ack-pending' || task.startState === 'unknown') {
      task.startState = 'started'
      task.resolveStartOutcome?.({ kind: 'started' })
    }
    if (finalTaskStatus(task.status)) {
      this.#handleLateTerminalEvent(task, event)
      return
    }
    if (event.type === 'progress') {
      const reportedProgress = Number.isFinite(event.percent)
        ? Math.max(0, Math.min(100, event.percent))
        : task.progress
      const message = event.percent < 0
        ? localizeDllErrorString(event.message)
        : localizeDllProgressMessage(event.message)
      task.progress = event.percent < 0 ? task.progress : Math.max(task.progress, reportedProgress)
      if (event.percent < 0) {
        this.#setTerminalStatus(task, 'error')
        task.error = message
      } else task.status = 'running'
      this.#publishProgress(task, {
        percent: task.progress,
        message,
        status: event.percent < 0 ? 'error' : 'running',
        ...(event.percent < 0 ? { error: message } : {})
      })
      this.#sendCancellationIfRequested(task)
      return
    }
    if (event.type === 'callback-result') {
      const callbackResult = parseCallbackResult(event.result)
      if (callbackResult.status === 'progress') {
        task.status = 'running'
        if (callbackResult.progress !== undefined) {
          task.progress = Math.max(task.progress, callbackResult.progress)
        }
      } else if (callbackResult.status === 'completed') {
        this.#setTerminalStatus(task, 'completed')
        task.progress = 100
        task.data = callbackResult.value
        delete task.error
      } else if (callbackResult.status === 'cancelled') {
        this.#setTerminalStatus(task, 'cancelled')
        task.data = callbackResult.value
      } else if (callbackResult.status === 'error') {
        this.#setTerminalStatus(task, 'error')
        task.data = callbackResult.value
        task.error = resolveNativeErrorMessage(callbackResult.error, 'dll.callbackFailed')
      }
      this.#publishTaskEvent('dllplugin_callback_result', {
        plugin: task.dllId,
        taskId: task.externalTaskId,
        result: callbackResult.serializedResult ?? event.result
      }, task.owner)
      this.#sendCancellationIfRequested(task)
      return
    }
    if (event.type === 'async-return' || event.type === 'callback-return') {
      const response = callResponse(event.call)
      if (event.type === 'callback-return') {
        if (response.success !== true) {
          this.#setTerminalStatus(task, 'error')
          task.error = resolveNativeErrorMessage(response.error, 'dll.callbackFailed')
          this.#publishTaskEvent('dllplugin_callback_result', {
            plugin: task.dllId,
            taskId: task.externalTaskId,
            error: task.error,
            ...(typeof response.errorCode === 'string' ? { errorCode: response.errorCode } : {}),
            ...(isRecord(response.errorParams) ? { errorParams: response.errorParams } : {})
          }, task.owner)
        } else this.#sendCancellationIfRequested(task)
        return
      }
      if (response.success === true) {
        this.#setTerminalStatus(task, 'completed')
        task.progress = 100
        task.data = response.data
        delete task.error
        this.#publishProgress(task, { percent: 100, status: 'completed', data: task.data })
      } else {
        this.#setTerminalStatus(task, 'error')
        task.error = resolveNativeErrorMessage(response.error, 'dll.asyncFailed')
        this.#publishProgress(task, {
          status: 'error',
          error: task.error,
          ...(typeof response.errorCode === 'string' ? { errorCode: response.errorCode } : {}),
          ...(isRecord(response.errorParams) ? { errorParams: response.errorParams } : {})
        })
      }
      return
    }
    if (event.type === 'cancelled') {
      this.#setTerminalStatus(task, 'cancelled')
      this.#publishProgress(task, {
        status: 'cancelled',
        error: event.code === 0 ? undefined : t('dll.cancelledWithCode', { code: event.code })
      })
      return
    }
    if (event.type === 'task-error') {
      const localizedError = localizeDllErrorString(event.error)
      this.#setTerminalStatus(task, 'error')
      task.error = localizedError
      this.#publishProgress(task, { status: 'error', error: localizedError })
    }
  }

  #handleLateTerminalEvent(task: TaskRecord, event: NativeDllEvent): void {
    if (
      (event.type === 'async-return' || event.type === 'callback-return') &&
      (this.#stopped || this.#closedCallers.has(taskOwnerIdentityKey(task.owner)))
    ) {
      this.#scheduleTaskDisposal(task, this.#taskDisposalDeadline())
    }

    if (event.type === 'callback-result') {
      const callbackResult = parseCallbackResult(event.result)
      if (callbackResult.status !== task.status) return
      if (task.status === 'error' && !task.error && callbackResult.error) {
        task.error = callbackResult.error
      }
      if (task.data === undefined) {
        task.data = callbackResult.value
        if (task.status === 'completed') delete task.error
        this.#publishTaskEvent('dllplugin_callback_result', {
          plugin: task.dllId,
          taskId: task.externalTaskId,
          result: callbackResult.serializedResult ?? event.result
        }, task.owner)
      }
      return
    }

    if (event.type === 'async-return') {
      const response = callResponse(event.call)
      if (response.success === true && task.status === 'completed' && task.data === undefined) {
        task.data = response.data
        task.progress = 100
        this.#publishProgress(task, { percent: 100, status: 'completed', data: task.data })
      } else if (response.success !== true && task.status === 'error' && !task.error) {
        task.error = resolveNativeErrorMessage(response.error, 'dll.asyncFailed')
        this.#publishProgress(task, {
          status: 'error',
          error: task.error,
          ...(typeof response.errorCode === 'string' ? { errorCode: response.errorCode } : {}),
          ...(isRecord(response.errorParams) ? { errorParams: response.errorParams } : {})
        })
      }
      return
    }

    if (event.type === 'callback-return' && event.call.code !== 0 && task.status === 'error' && !task.error) {
      const response = callResponse(event.call)
      task.error = resolveNativeErrorMessage(response.error, 'dll.callbackFailed')
      this.#publishTaskEvent('dllplugin_callback_result', {
        plugin: task.dllId,
        taskId: task.externalTaskId,
        error: task.error,
        ...(typeof response.errorCode === 'string' ? { errorCode: response.errorCode } : {}),
        ...(isRecord(response.errorParams) ? { errorParams: response.errorParams } : {})
      }, task.owner)
      return
    }

    if (event.type === 'task-error' && task.status === 'error' && !task.error) {
      const localizedError = localizeDllErrorString(event.error)
      task.error = localizedError
      this.#publishProgress(task, { status: 'error', error: localizedError })
    }
  }

  #sendCancellationIfRequested(task: TaskRecord): void {
    if (task.cancelRequested && !task.cancelSent && !finalTaskStatus(task.status)) {
      void this.#sendTaskCancellation(task).catch(() => undefined)
    }
  }

  #publishProgress(task: TaskRecord, payload: Record<string, unknown>): void {
    if (!this.#canExposeTaskResult(task)) return
    this.#publishTaskEvent('dllplugin_progress', {
      plugin: task.dllId,
      taskId: task.externalTaskId,
      ...(task.mode === 'callback' && task.nativeTaskObserved
        ? { taskStartResolved: true, taskStartPending: false }
        : {}),
      ...payload
    }, task.owner)
  }

  #publishTaskEvent(type: string, payload: unknown, owner: CallerIdentity): void {
    if (type === 'dllplugin_callback_result' && isRecord(payload) && typeof payload.taskId === 'string') {
      const task = this.#tasks.get(taskOwnerKey(owner, payload.taskId))
      if (task && !this.#canExposeTaskResult(task)) return
    }
    try {
      this.events.publishHostToOwner(type, payload, owner)
    } catch {
      // Event delivery can stop before the Host's bounded shutdown finishes.
      // Task reconciliation and reservation cleanup must still complete.
    }
  }

  #requireRunning(): void {
    if (this.#stopped) {
      throw new ZToolsError(errorCodes.appStopping, t('dll.error.serviceStopping'), {
        i18nKey: 'dll.error.serviceStopping'
      })
    }
  }
}
