import { TOOL_RUNTIME_ERROR_CODES } from '../../../../contracts/tool-runtime/common.js'
import type {
  DownloadStreamAudioFormat,
  DownloadStreamMergeContainer,
  DownloadStreamProbeRequest,
  DownloadStreamRunRequest,
  DownloadTransferAddRequest,
  DownloadTransferControlRequest,
  DownloadTransferStatusRequest
} from '../../../../contracts/tool-runtime/domains/download.js'
import { createToolRuntimeError, isPlainObject } from '../../core/errors.js'
import { assertValidToolPathSlotStructure } from '../../core/path-slot-guard.js'

/**
 * 下载能力域第一层平台无关 URL 与参数白名单（Fail-Closed）：
 * - 未知字段一律拒绝；
 * - 仅允许 http: / https: 协议，严禁 file: / javascript: / data: / ftp: 等协议；
 * - 拦截云元数据地址（169.254.169.254、metadata.google.internal、100.100.100.200 等）与 0.0.0.0 / 链路本地地址；
 * - 严格校验文件名、并发连接数 (1~16)、限速、音频提取格式、合并封装容器、超时上限与 SHA-256 摘要格式。
 */

const STREAM_PROBE_KEYS = new Set(['url', 'timeoutMs'])
const STREAM_RUN_KEYS = new Set([
  'taskId',
  'url',
  'outputDir',
  'fileName',
  'trackId',
  'preferAudioOnly',
  'audioFormat',
  'mergeContainer',
  'maxRateBytesPerSec',
  'timeoutMs',
  'overwrite'
])
const ALLOWED_AUDIO_FORMATS: ReadonlySet<DownloadStreamAudioFormat> = new Set([
  'mp3',
  'flac',
  'm4a',
  'opus',
  'wav'
])
const ALLOWED_MERGE_CONTAINERS: ReadonlySet<DownloadStreamMergeContainer> = new Set([
  'mp4',
  'mkv',
  'webm'
])
export const DEFAULT_STREAM_RUN_TIMEOUT_MS = 1_800_000
export const MIN_STREAM_RUN_TIMEOUT_MS = 5_000
export const MAX_STREAM_RUN_TIMEOUT_MS = 3_600_000
const TRANSFER_ADD_KEYS = new Set([
  'taskId',
  'url',
  'outputDir',
  'fileName',
  'maxConnections',
  'maxRateBytesPerSec',
  'overwrite',
  'expectedSha256'
])
const TRANSFER_CONTROL_KEYS = new Set(['taskId'])
const TRANSFER_STATUS_KEYS = new Set(['taskId'])

const TASK_ID_REGEX = /^[A-Za-z0-9._:-]{1,128}$/
const TRACK_ID_REGEX = /^[A-Za-z0-9._+-]{1,64}$/
const SHA256_REGEX = /^[a-f0-9]{64}$/i
const WINDOWS_RESERVED_NAME_REGEX = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

const BLOCKED_METADATA_HOSTS: ReadonlySet<string> = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',
  '0.0.0.0',
  '::',
  '0:0:0:0:0:0:0:0',
  'fd00:ec2::254'
])

function rejectUnknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `${label} contains unsupported fields: ${unknown.join(', ')}`,
      { fields: unknown }
    )
  }
}

function isBlockedLinkLocalOrMetadataHost(hostname: string): boolean {
  const cleaned = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (!cleaned) return true
  if (BLOCKED_METADATA_HOSTS.has(cleaned)) return true
  if (cleaned.startsWith('169.254.')) return true
  if (cleaned.startsWith('0.')) return true
  // IPv6 链路本地与 IPv4 映射云元数据地址
  if (cleaned.startsWith('fe80:')) return true
  if (cleaned.startsWith('::ffff:169.254.') || cleaned === '::ffff:a9fe:a9fe') return true
  if (cleaned === '::ffff:0.0.0.0' || cleaned === '::ffff:0:0') return true
  if (cleaned.startsWith('::ffff:100.100.100.200')) return true
  // 整数/十六进制编码的 169.254.169.254（2852039166 / 0xa9fea9fe）
  if (cleaned === '2852039166' || cleaned === '0xa9fea9fe') return true
  return false
}

/** 校验并规范化受控下载 URL */
export function validateSafeDownloadUrl(rawUrl: unknown, field = 'url'): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 4096) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `${field} must be a non-empty URL string`,
      { fields: [field] }
    )
  }
  if (/[\u0000-\u001f\u007f]/.test(rawUrl)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `${field} contains illegal control characters`,
      { fields: [field] }
    )
  }
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `${field} is not a valid URL`,
      { fields: [field] }
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `Protocol "${parsed.protocol}" is forbidden; only http: and https: are allowed`,
      { fields: [field] }
    )
  }
  if (parsed.username || parsed.password) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'Embedded credentials in download URL are forbidden',
      { fields: [field] }
    )
  }
  if (isBlockedLinkLocalOrMetadataHost(parsed.hostname)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `Target host "${parsed.hostname}" is blocked by network safety policy`,
      { fields: [field] }
    )
  }
  return parsed.toString()
}

/** 校验安全输出文件名（禁止路径分隔符、..、控制字符与保留设备名） */
export function validateSafeFileName(rawName: unknown, field = 'fileName'): string {
  if (typeof rawName !== 'string' || rawName.length === 0 || rawName.length > 240) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `${field} must be a non-empty string (1..240 chars)`,
      { fields: [field] }
    )
  }
  if (
    rawName === '.' ||
    rawName === '..' ||
    rawName.includes('..') ||
    rawName.includes('/') ||
    rawName.includes('\\') ||
    rawName.includes('\0') ||
    /[\u0000-\u001f\u007f<>:"|?*]/.test(rawName) ||
    rawName.endsWith('.') ||
    rawName.endsWith(' ') ||
    WINDOWS_RESERVED_NAME_REGEX.test(rawName)
  ) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `${field} contains forbidden characters or path traversal sequence`,
      { fields: [field] }
    )
  }
  return rawName
}

/** 从 URL 派生安全兜底文件名 */
export function deriveSafeFileNameFromUrl(urlString: string, fallback = 'download.bin'): string {
  try {
    const parsed = new URL(urlString)
    const rawSegment = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? '')
    const sanitized = rawSegment.replace(/[\u0000-\u001f\u007f<>:"|?*\\/]+/g, '_').replace(/\.+$/g, '').trim()
    if (sanitized && sanitized !== '.' && sanitized !== '..' && !sanitized.includes('..') && !WINDOWS_RESERVED_NAME_REGEX.test(sanitized)) {
      return sanitized.slice(0, 200)
    }
  } catch {
    // 解析失败使用默认名
  }
  return fallback
}

function validateOptionalTaskId(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string' || !TASK_ID_REGEX.test(raw)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      'Invalid taskId format',
      { fields: ['taskId'] }
    )
  }
  return raw
}

function validateOptionalRateLimit(raw: unknown): number | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1_024 || raw > 10_000_000_000) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'maxRateBytesPerSec must be an integer between 1024 and 10000000000',
      { fields: ['maxRateBytesPerSec'] }
    )
  }
  return raw
}

/** 校验 download.stream probe 请求 */
export function validateDownloadStreamProbeRequest(raw: unknown): DownloadStreamProbeRequest {
  if (!isPlainObject(raw)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      'download.stream probe request must be an object'
    )
  }
  rejectUnknownFields(raw, STREAM_PROBE_KEYS, 'tool_download_stream_probe')
  const url = validateSafeDownloadUrl(raw.url)
  let timeoutMs: number | undefined
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== 'number' || !Number.isInteger(raw.timeoutMs) || raw.timeoutMs < 1_000 || raw.timeoutMs > 300_000) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        'timeoutMs must be an integer between 1000 and 300000',
        { fields: ['timeoutMs'] }
      )
    }
    timeoutMs = raw.timeoutMs
  }
  return {
    url,
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
  }
}

/** 校验 download.stream run 请求 */
export function validateDownloadStreamRunRequest(raw: unknown): DownloadStreamRunRequest {
  if (!isPlainObject(raw)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      'download.stream run request must be an object'
    )
  }
  rejectUnknownFields(raw, STREAM_RUN_KEYS, 'tool_download_stream_run')
  const taskId = validateOptionalTaskId(raw.taskId)
  const url = validateSafeDownloadUrl(raw.url)
  assertValidToolPathSlotStructure(raw.outputDir, 'outputDir')
  const fileName = raw.fileName !== undefined ? validateSafeFileName(raw.fileName) : undefined
  let trackId: string | undefined
  if (raw.trackId !== undefined) {
    if (typeof raw.trackId !== 'string' || !TRACK_ID_REGEX.test(raw.trackId)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        'trackId contains illegal characters',
        { fields: ['trackId'] }
      )
    }
    trackId = raw.trackId
  }
  if (raw.preferAudioOnly !== undefined && typeof raw.preferAudioOnly !== 'boolean') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'preferAudioOnly must be a boolean',
      { fields: ['preferAudioOnly'] }
    )
  }
  let audioFormat: DownloadStreamAudioFormat | undefined
  if (raw.audioFormat !== undefined) {
    if (
      typeof raw.audioFormat !== 'string' ||
      !ALLOWED_AUDIO_FORMATS.has(raw.audioFormat as DownloadStreamAudioFormat)
    ) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `Unsupported audioFormat: ${String(raw.audioFormat)}`,
        { fields: ['audioFormat'] }
      )
    }
    if (raw.preferAudioOnly !== true) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        'audioFormat requires preferAudioOnly=true',
        { fields: ['audioFormat', 'preferAudioOnly'] }
      )
    }
    audioFormat = raw.audioFormat as DownloadStreamAudioFormat
  }
  let mergeContainer: DownloadStreamMergeContainer | undefined
  if (raw.mergeContainer !== undefined) {
    if (
      typeof raw.mergeContainer !== 'string' ||
      !ALLOWED_MERGE_CONTAINERS.has(raw.mergeContainer as DownloadStreamMergeContainer)
    ) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `Unsupported mergeContainer: ${String(raw.mergeContainer)}`,
        { fields: ['mergeContainer'] }
      )
    }
    if (raw.preferAudioOnly === true) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        'mergeContainer cannot be combined with preferAudioOnly=true',
        { fields: ['mergeContainer', 'preferAudioOnly'] }
      )
    }
    mergeContainer = raw.mergeContainer as DownloadStreamMergeContainer
  }
  if (raw.overwrite !== undefined && typeof raw.overwrite !== 'boolean') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'overwrite must be a boolean',
      { fields: ['overwrite'] }
    )
  }
  let timeoutMs: number | undefined
  if (raw.timeoutMs !== undefined) {
    if (
      typeof raw.timeoutMs !== 'number' ||
      !Number.isInteger(raw.timeoutMs) ||
      raw.timeoutMs < MIN_STREAM_RUN_TIMEOUT_MS ||
      raw.timeoutMs > MAX_STREAM_RUN_TIMEOUT_MS
    ) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `timeoutMs must be an integer between ${MIN_STREAM_RUN_TIMEOUT_MS} and ${MAX_STREAM_RUN_TIMEOUT_MS}`,
        { fields: ['timeoutMs'] }
      )
    }
    timeoutMs = raw.timeoutMs
  }
  const maxRateBytesPerSec = validateOptionalRateLimit(raw.maxRateBytesPerSec)

  return {
    ...(taskId !== undefined ? { taskId } : {}),
    url,
    outputDir: raw.outputDir,
    ...(fileName !== undefined ? { fileName } : {}),
    ...(trackId !== undefined ? { trackId } : {}),
    ...(raw.preferAudioOnly !== undefined ? { preferAudioOnly: raw.preferAudioOnly } : {}),
    ...(audioFormat !== undefined ? { audioFormat } : {}),
    ...(mergeContainer !== undefined ? { mergeContainer } : {}),
    ...(maxRateBytesPerSec !== undefined ? { maxRateBytesPerSec } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(raw.overwrite !== undefined ? { overwrite: raw.overwrite } : {})
  }
}

/** 校验 download.transfer add 请求 */
export function validateDownloadTransferAddRequest(raw: unknown): DownloadTransferAddRequest {
  if (!isPlainObject(raw)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      'download.transfer add request must be an object'
    )
  }
  rejectUnknownFields(raw, TRANSFER_ADD_KEYS, 'tool_download_transfer_add')
  const taskId = validateOptionalTaskId(raw.taskId)
  const url = validateSafeDownloadUrl(raw.url)
  assertValidToolPathSlotStructure(raw.outputDir, 'outputDir')
  const fileName = raw.fileName !== undefined ? validateSafeFileName(raw.fileName) : undefined

  let maxConnections: number | undefined
  if (raw.maxConnections !== undefined) {
    if (
      typeof raw.maxConnections !== 'number' ||
      !Number.isInteger(raw.maxConnections) ||
      raw.maxConnections < 1 ||
      raw.maxConnections > 16
    ) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        'maxConnections must be an integer between 1 and 16',
        { fields: ['maxConnections'] }
      )
    }
    maxConnections = raw.maxConnections
  }

  const maxRateBytesPerSec = validateOptionalRateLimit(raw.maxRateBytesPerSec)
  if (raw.overwrite !== undefined && typeof raw.overwrite !== 'boolean') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'overwrite must be a boolean',
      { fields: ['overwrite'] }
    )
  }

  let expectedSha256: string | undefined
  if (raw.expectedSha256 !== undefined) {
    if (typeof raw.expectedSha256 !== 'string' || !SHA256_REGEX.test(raw.expectedSha256)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        'expectedSha256 must be a 64-character hex SHA-256 digest',
        { fields: ['expectedSha256'] }
      )
    }
    expectedSha256 = raw.expectedSha256.toLowerCase()
  }

  return {
    ...(taskId !== undefined ? { taskId } : {}),
    url,
    outputDir: raw.outputDir,
    ...(fileName !== undefined ? { fileName } : {}),
    ...(maxConnections !== undefined ? { maxConnections } : {}),
    ...(maxRateBytesPerSec !== undefined ? { maxRateBytesPerSec } : {}),
    ...(raw.overwrite !== undefined ? { overwrite: raw.overwrite } : {}),
    ...(expectedSha256 !== undefined ? { expectedSha256 } : {})
  }
}

/** 校验 pause / resume / cancel 请求 */
export function validateDownloadTransferControlRequest(raw: unknown): DownloadTransferControlRequest {
  if (!isPlainObject(raw)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      'download.transfer control request must be an object'
    )
  }
  rejectUnknownFields(raw, TRANSFER_CONTROL_KEYS, 'tool_download_transfer_control')
  const taskId = validateOptionalTaskId(raw.taskId)
  if (!taskId) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      'taskId is required',
      { fields: ['taskId'] }
    )
  }
  return { taskId }
}

/** 校验 status 查询请求 */
export function validateDownloadTransferStatusRequest(raw: unknown): DownloadTransferStatusRequest {
  if (raw === undefined || raw === null) {
    return {}
  }
  if (!isPlainObject(raw)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      'download.transfer status request must be an object'
    )
  }
  rejectUnknownFields(raw, TRANSFER_STATUS_KEYS, 'tool_download_transfer_status')
  const taskId = validateOptionalTaskId(raw.taskId)
  return {
    ...(taskId !== undefined ? { taskId } : {})
  }
}
