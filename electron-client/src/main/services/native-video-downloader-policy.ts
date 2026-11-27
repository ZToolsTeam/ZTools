import fs from 'node:fs/promises'
import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { defaultProtectedTrashRoots } from './file-system-service.js'
import type {
  NativeMediaDllPolicy,
  NativeMediaLstat,
  NativeMediaPathResolver,
  NativeMediaStat
} from './native-media-policy.js'

const MAX_URL_LENGTH = 4_096
const MAX_FORMAT_LENGTH = 2_048
const MAX_PROXY_LENGTH = 2_048
const MAX_TITLE_LENGTH = 256
const MAX_RAW_PATH_LENGTH = 32 * 1024
const MAX_HISTORY_LIMIT = 500
const FORBIDDEN_LINE_OR_NUL = /[\0\r\n]/
const FORBIDDEN_FORMAT_OR_PATH = /[\0\r\n"]/
const FORBIDDEN_URL_CHARS = /[\u0000-\u001f\u007f\s"]/
const CONTROL_OR_WHITESPACE = /[\u0000-\u001f\u007f\s]/
const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const ALLOWED_AUDIO_FORMATS = new Set(['mp3', 'flac', 'm4a', 'wav', 'aac', 'opus'])

/** VideoDownloaderPlugin 唯一允许暴露的 15 个方法名 */
export const VIDEO_DOWNLOADER_ALLOWED_FUNCTIONS = [
  'CheckTools',
  'GetVideoInfo',
  'StartParseAsync',
  'GetParseStatus',
  'CancelParse',
  'StartDownload',
  'StartDirectDownload',
  'GetTaskStatus',
  'GetAllTasks',
  'PauseTask',
  'ResumeTask',
  'CancelTaskById',
  'GetDownloadHistory',
  'DeleteHistory',
  'ClearHistory'
] as const

export type VideoDownloaderFunctionName = (typeof VIDEO_DOWNLOADER_ALLOWED_FUNCTIONS)[number]

const ALLOWED_FUNCTION_SET: ReadonlySet<string> = new Set(VIDEO_DOWNLOADER_ALLOWED_FUNCTIONS)

/** 注入至 DEFAULT_NATIVE_MEDIA_DLL_POLICIES 的策略声明，确保 isBuiltInNativeMediaDll 返回 true */
export const VIDEO_DOWNLOADER_DLL_POLICY: NativeMediaDllPolicy = {
  dllId: 'VideoDownloaderPlugin',
  methods: {
    CheckTools: {},
    GetVideoInfo: {},
    StartParseAsync: {},
    GetParseStatus: {},
    CancelParse: {},
    StartDownload: { outputDirectory: true },
    StartDirectDownload: { outputDirectory: true },
    GetTaskStatus: {},
    GetAllTasks: {},
    PauseTask: {},
    ResumeTask: {},
    CancelTaskById: {},
    GetDownloadHistory: {},
    DeleteHistory: {},
    ClearHistory: {}
  }
}

export interface VideoDownloaderPolicyContext {
  paths: NativeMediaPathResolver
  stat: (target: string) => Promise<NativeMediaStat>
  /** 未提供自定义 stat 时默认使用真实 fs.lstat；测试若仅 mock 了 stat 而未传 lstat 则跳过磁盘 lstat */
  lstat?: (target: string) => Promise<NativeMediaLstat>
}

function invalidCall(message: string): never {
  throw new ZToolsError(errorCodes.invalidRequest, message)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 校验对象为纯对象且不包含白名单以外的键（忽略宿主可能注入的 __locale） */
function assertAllowedKeys(
  params: unknown,
  allowedKeys: ReadonlySet<string>
): Record<string, unknown> {
  if (!isPlainRecord(params) || Reflect.ownKeys(params).some((key) => typeof key !== 'string')) {
    invalidCall('Video downloader parameters must be a plain object')
  }
  const ownKeys = Reflect.ownKeys(params) as string[]
  for (const key of ownKeys) {
    if (key === '__locale') continue
    if (!allowedKeys.has(key)) {
      invalidCall(`Video downloader parameters do not accept field ${key}`)
    }
  }
  return params
}

function validateParseUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH ||
    /[\u0000-\u001f\u007f"']/u.test(value)
  ) {
    invalidCall('Invalid video url parameter')
  }
  const trimmed = value.trim()
  if (!trimmed) {
    invalidCall('Invalid video url parameter')
  }
  // 允许直接传纯 B 站 BV 号并规范化为标准 https 链接，绝不把任意文本透传给原生解析器
  if (/^BV[0-9A-Za-z]{10}$/.test(trimmed)) {
    return `https://www.bilibili.com/video/${trimmed}`
  }
  // 严格按标准 http(s):// URL 校验（拒绝空白、引号及非标准协议）
  return validateStrictHttpUrl(trimmed, 'url')
}

function validateStrictHttpUrl(value: unknown, fieldName: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_URL_LENGTH ||
    FORBIDDEN_URL_CHARS.test(value)
  ) {
    invalidCall(`${fieldName} must be a valid http:// or https:// URL without control characters or whitespace`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    invalidCall(`${fieldName} is not a valid URL`)
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    invalidCall(`${fieldName} must use http:// or https:// protocol with a valid host`)
  }
  return value
}

function validateFormat(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_FORMAT_LENGTH ||
    FORBIDDEN_FORMAT_OR_PATH.test(value)
  ) {
    invalidCall('format must be a string up to 2048 characters without NUL, CR, LF, or quotes')
  }
  const lower = value.toLowerCase()
  const pipeHttpIndex = lower.indexOf('|http')
  if (pipeHttpIndex >= 0) {
    // 含 |http（如 DASH 视频流|音频流拼接格式）时，仅允许单个 | 且后半段必须为合法 http(s):// URL
    const firstPipe = value.indexOf('|')
    const lastPipe = value.lastIndexOf('|')
    if (firstPipe !== pipeHttpIndex || firstPipe !== lastPipe) {
      invalidCall('format with |http must contain a single valid trailing http(s):// URL')
    }
    const trailingUrl = value.slice(pipeHttpIndex + 1)
    validateStrictHttpUrl(trailingUrl, 'format audio URL')
  }
  return value
}

function validateAudioFormat(value: unknown): string {
  if (typeof value !== 'string') {
    invalidCall('audioFormat must be a string')
  }
  const normalized = value.toLowerCase()
  if (!ALLOWED_AUDIO_FORMATS.has(normalized)) {
    invalidCall('audioFormat must be one of mp3, flac, m4a, wav, aac, or opus')
  }
  return normalized
}

function validateProxy(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_PROXY_LENGTH) {
    invalidCall('proxy must be a string up to 2048 characters')
  }
  if (value === '') return ''
  if (CONTROL_OR_WHITESPACE.test(value) || value.includes('"')) {
    invalidCall('proxy must not contain whitespace, quotes, or control characters')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    invalidCall('proxy is not a valid URL')
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'socks5:') ||
    !parsed.hostname
  ) {
    invalidCall('proxy must use http://, https://, or socks5:// protocol with a valid host')
  }
  return value
}

function validateTitle(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_TITLE_LENGTH ||
    FORBIDDEN_LINE_OR_NUL.test(value)
  ) {
    invalidCall('title must be a string up to 256 characters without NUL, CR, or LF')
  }
  return value
}

function validateTaskId(value: unknown): string {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) {
    invalidCall('taskId format is invalid')
  }
  return value
}

function validateRawOutputDir(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RAW_PATH_LENGTH ||
    FORBIDDEN_FORMAT_OR_PATH.test(value)
  ) {
    invalidCall('outputDir must be a non-empty path without NUL, CR, LF, or quotes')
  }
  const segments = value.split(/[\\/]+/)
  if (segments.some((segment) => segment === '..')) {
    invalidCall('outputDir must not contain parent directory traversal (..)')
  }
  return value
}

function samePathForPlatform(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left)
  const normalizedRight = path.normalize(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function isSubPathForPlatform(childPath: string, parentDir: string): boolean {
  const normChild = process.platform === 'win32'
    ? path.normalize(childPath).toLowerCase()
    : path.normalize(childPath)
  const normParent = process.platform === 'win32'
    ? path.normalize(parentDir).toLowerCase()
    : path.normalize(parentDir)
  const prefix = normParent.endsWith(path.sep) ? normParent : `${normParent}${path.sep}`
  return normChild.startsWith(prefix) && normChild.length > prefix.length
}

/** 拦截盘符根目录及系统关键目录（含 Windows / Program Files / ProgramData / POSIX 系统目录） */
export function isProtectedVideoOutputDirectory(
  targetPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const resolved = path.resolve(targetPath)
  const parsed = path.parse(resolved)
  if (resolved === parsed.root) return true

  // 显式拦截 Windows 盘符根目录与 UNC 共享根目录
  const winNormalized = path.win32.normalize(targetPath)
  if (/^[a-zA-Z]:\\?$/.test(winNormalized) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(winNormalized)) {
    return true
  }

  const systemDrive = (env.SystemDrive && /^[a-zA-Z]:$/.test(env.SystemDrive)) ? env.SystemDrive : 'C:'
  const protectedRoots: string[] = [
    ...defaultProtectedTrashRoots(platform, env),
    ...(platform === 'win32'
      ? [
          `${systemDrive}\\Windows`,
          `${systemDrive}\\Program Files`,
          `${systemDrive}\\Program Files (x86)`,
          `${systemDrive}\\ProgramData`,
          'C:\\Windows',
          'C:\\Program Files',
          'C:\\Program Files (x86)',
          'C:\\ProgramData'
        ]
      : ['/Library', '/Applications', '/etc', '/var', '/private/etc'])
  ]

  for (const root of protectedRoots) {
    if (!root) continue
    const resolvedRoot = path.resolve(root)
    if (samePathForPlatform(resolved, resolvedRoot) || isSubPathForPlatform(resolved, resolvedRoot)) {
      return true
    }
  }
  return false
}

async function assertNoSymbolicLinkAncestors(
  targetPath: string,
  lstatFn: (target: string) => Promise<NativeMediaLstat>
): Promise<void> {
  let cursor = path.resolve(targetPath)
  while (true) {
    let info: NativeMediaLstat
    try {
      info = await lstatFn(cursor)
    } catch {
      throw new ZToolsError(errorCodes.fileError, 'Video downloader output directory is not accessible')
    }
    if (info.isSymbolicLink()) {
      throw new ZToolsError(
        errorCodes.permissionDenied,
        'Video downloader output directory must not contain symbolic links'
      )
    }
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}

async function authorizeOutputDir(
  rawValue: unknown,
  caller: CallerIdentity,
  context: VideoDownloaderPolicyContext
): Promise<string> {
  const rawOutputDir = validateRawOutputDir(rawValue)
  if (context.lstat && path.isAbsolute(rawOutputDir)) {
    await assertNoSymbolicLinkAncestors(rawOutputDir, context.lstat)
  }

  let canonicalOutput: string
  try {
    canonicalOutput = await context.paths.resolveAuthorizedPath(rawOutputDir, caller, 'write', false)
  } catch (error) {
    if (error instanceof ZToolsError) throw error
    throw new ZToolsError(
      errorCodes.permissionDenied,
      'Video downloader output directory is not authorized for write access by the current window'
    )
  }

  // 解析后的真实路径同样严禁存在 .. 穿越或落入系统关键目录/根目录
  if (canonicalOutput.split(/[\\/]+/).some((segment) => segment === '..')) {
    invalidCall('Resolved video downloader output directory contains invalid traversal segments')
  }
  if (isProtectedVideoOutputDirectory(canonicalOutput)) {
    throw new ZToolsError(
      errorCodes.permissionDenied,
      'Video downloader output directory cannot target system directories or drive roots'
    )
  }
  if (context.lstat) {
    await assertNoSymbolicLinkAncestors(canonicalOutput, context.lstat)
  }

  let stats: NativeMediaStat
  try {
    stats = await context.stat(canonicalOutput)
  } catch {
    throw new ZToolsError(errorCodes.fileError, 'Video downloader output directory is not accessible')
  }
  if (!stats.isDirectory()) {
    invalidCall('Video downloader outputDir must be an existing directory')
  }

  return path.resolve(canonicalOutput)
}

/**
 * 校验并规范化 VideoDownloaderPlugin 的每一次原生调用参数：
 * 1. 严格限制 15 个白名单方法，禁止原型链及越界函数；
 * 2. 拒绝非纯对象与未知键（安全忽略宿主注入的 __locale）；
 * 3. 对 URL、格式串、代理、音频格式、任务 ID、分页/ID 以及授权输出目录执行 Fail-Fast 强校验。
 */
export async function authorizeVideoDownloaderCall(
  functionName: string,
  params: unknown,
  caller: CallerIdentity,
  context: VideoDownloaderPolicyContext
): Promise<Record<string, unknown>> {
  if (!ALLOWED_FUNCTION_SET.has(functionName)) {
    throw new ZToolsError(
      errorCodes.methodNotFound,
      'VideoDownloaderPlugin method is not authorized by host policy'
    )
  }

  const fn = functionName as VideoDownloaderFunctionName

  switch (fn) {
    case 'CheckTools':
    case 'GetAllTasks':
    case 'ClearHistory': {
      assertAllowedKeys(params, new Set())
      return {}
    }

    case 'GetVideoInfo':
    case 'StartParseAsync': {
      const record = assertAllowedKeys(params, new Set(['url']))
      if (!Object.hasOwn(record, 'url')) {
        invalidCall(`${fn} requires url parameter`)
      }
      return { url: validateParseUrl(record.url) }
    }

    case 'GetParseStatus':
    case 'CancelParse':
    case 'GetTaskStatus':
    case 'PauseTask':
    case 'ResumeTask':
    case 'CancelTaskById': {
      const record = assertAllowedKeys(params, new Set(['taskId']))
      if (!Object.hasOwn(record, 'taskId')) {
        invalidCall(`${fn} requires taskId parameter`)
      }
      return { taskId: validateTaskId(record.taskId) }
    }

    case 'GetDownloadHistory': {
      const record = assertAllowedKeys(params, new Set(['limit', 'offset']))
      const sanitized: Record<string, unknown> = {}
      if (Object.hasOwn(record, 'limit') && record.limit !== undefined) {
        if (
          !Number.isSafeInteger(record.limit) ||
          (record.limit as number) < 1 ||
          (record.limit as number) > MAX_HISTORY_LIMIT
        ) {
          invalidCall(`limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`)
        }
        sanitized.limit = record.limit
      }
      if (Object.hasOwn(record, 'offset') && record.offset !== undefined) {
        if (!Number.isSafeInteger(record.offset) || (record.offset as number) < 0) {
          invalidCall('offset must be a non-negative integer')
        }
        sanitized.offset = record.offset
      }
      return sanitized
    }

    case 'DeleteHistory': {
      const record = assertAllowedKeys(params, new Set(['id']))
      if (!Object.hasOwn(record, 'id')) {
        invalidCall('DeleteHistory requires id parameter')
      }
      if (!Number.isSafeInteger(record.id) || (record.id as number) < 1) {
        invalidCall('id must be a positive safe integer')
      }
      return { id: record.id }
    }

    case 'StartDownload': {
      const record = assertAllowedKeys(
        params,
        new Set(['url', 'format', 'outputDir', 'extractAudio', 'audioFormat', 'proxy', 'title'])
      )
      if (!Object.hasOwn(record, 'url')) {
        invalidCall('StartDownload requires url parameter')
      }
      if (!Object.hasOwn(record, 'outputDir')) {
        invalidCall('StartDownload requires outputDir parameter')
      }

      const sanitized: Record<string, unknown> = {
        url: validateStrictHttpUrl(record.url, 'url')
      }
      if (Object.hasOwn(record, 'format') && record.format !== undefined) {
        sanitized.format = validateFormat(record.format)
      }
      if (Object.hasOwn(record, 'extractAudio') && record.extractAudio !== undefined) {
        if (typeof record.extractAudio !== 'boolean') {
          invalidCall('extractAudio must be a boolean')
        }
        sanitized.extractAudio = record.extractAudio
      }
      if (Object.hasOwn(record, 'audioFormat') && record.audioFormat !== undefined) {
        sanitized.audioFormat = validateAudioFormat(record.audioFormat)
      }
      if (Object.hasOwn(record, 'proxy') && record.proxy !== undefined) {
        sanitized.proxy = validateProxy(record.proxy)
      }
      if (Object.hasOwn(record, 'title') && record.title !== undefined) {
        sanitized.title = validateTitle(record.title)
      }
      sanitized.outputDir = await authorizeOutputDir(record.outputDir, caller, context)
      return sanitized
    }

    case 'StartDirectDownload': {
      const record = assertAllowedKeys(params, new Set(['videoUrl', 'title', 'outputDir']))
      if (!Object.hasOwn(record, 'videoUrl')) {
        invalidCall('StartDirectDownload requires videoUrl parameter')
      }
      if (!Object.hasOwn(record, 'outputDir')) {
        invalidCall('StartDirectDownload requires outputDir parameter')
      }

      const sanitized: Record<string, unknown> = {
        videoUrl: validateStrictHttpUrl(record.videoUrl, 'videoUrl')
      }
      if (Object.hasOwn(record, 'title') && record.title !== undefined) {
        sanitized.title = validateTitle(record.title)
      }
      sanitized.outputDir = await authorizeOutputDir(record.outputDir, caller, context)
      return sanitized
    }
  }
}

export async function defaultFsLstat(target: string): Promise<NativeMediaLstat> {
  return await fs.lstat(target)
}
