import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { defaultProtectedTrashRoots } from './file-system-service.js'
import { NativeMediaParameterPolicy } from './native-media-parameter-policy.js'
import {
  authorizeVideoDownloaderCall,
  defaultFsLstat,
  VIDEO_DOWNLOADER_DLL_POLICY
} from './native-video-downloader-policy.js'

const MAX_INPUT_BYTES = 512 * 1024 * 1024
const MAX_INPUT_ITEMS = 100
const MAX_TOTAL_INPUT_BYTES = 2 * 1024 * 1024 * 1024
const FORBIDDEN_PATH_CHARACTERS = /[\0\r\n\"]/
const PATH_FIELDS = new Set([
  'files',
  'filePath',
  'watermarkFile',
  'thumbnailFile',
  'introFile',
  'outroFile',
  'outputDir',
  'outputFile'
])

export interface NativeMediaPathResolver {
  resolveAuthorizedPath(
    value: string,
    caller: CallerIdentity,
    access: 'read' | 'write',
    allowMissing: boolean
  ): Promise<string>
}

export interface NativeMediaStat {
  size: number
  isFile(): boolean
  isDirectory(): boolean
}

export interface NativeMediaLstat {
  isSymbolicLink(): boolean
}

export interface NativeMediaMethodPolicy {
  inputFiles?: boolean
  requiredInputFields?: readonly string[]
  optionalInputFields?: readonly string[]
  outputDirectory?: boolean
  outputFileName?: boolean
  defaultOutputFileName?: string
  unsupported?: boolean
}

export interface NativeMediaDllPolicy {
  dllId: string
  methods: Readonly<Record<string, NativeMediaMethodPolicy>>
}

export interface NativeMediaPolicyAdapters {
  stat?: (target: string) => Promise<NativeMediaStat>
  lstat?: (target: string) => Promise<NativeMediaLstat>
}

const AUDIO_OUTPUT_METHODS = [
  'BatchConvertFormat',
  'BatchNormalizeVolume',
  'BatchLoudnorm',
  'BatchTrimAudio',
  'BatchExtractSegment',
  'BatchMergeAudio',
  'BatchAddWatermark',
  'BatchFadeInOut',
  'BatchEqualizer',
  'BatchCompressor',
  'BatchDenoise',
  'BatchSetMetadata'
] as const

const VIDEO_OUTPUT_METHODS = [
  'BatchCompressVideo',
  'BatchTrimVideo',
  'BatchExtractSegment',
  'BatchExtractClips',
  'BatchCropByRatio',
  'BatchConvertFormat',
  'BatchConvertToGif',
  'BatchAddWatermark',
  'BatchResizeVideo',
  'BatchSetThumbnail',
  'BatchSpeedUpVideo',
  'BatchFlipVideo',
  'BatchRotateVideo',
  'BatchMergeVideo',
  'BatchRemoveAudio',
  'BatchExtractAudio',
  'BatchExtractFrames'
] as const

function withBatchFiles(
  methods: readonly string[],
  extra: Readonly<Record<string, NativeMediaMethodPolicy>> = {}
): Record<string, NativeMediaMethodPolicy> {
  const result: Record<string, NativeMediaMethodPolicy> = {}
  for (const method of methods) result[method] = { inputFiles: true, outputDirectory: true }
  return Object.assign(result, extra)
}

const TASK_METHODS: Readonly<Record<string, NativeMediaMethodPolicy>> = {
  GetTaskStatus: {},
  GetTaskList: {},
  CancelTask: {}
}

export const DEFAULT_NATIVE_MEDIA_DLL_POLICIES: readonly NativeMediaDllPolicy[] = [
  {
    dllId: 'BatchAudioPlugin',
    methods: {
      ...TASK_METHODS,
      GetFileInfo: { requiredInputFields: ['filePath'] },
      BatchDetectSilence: { inputFiles: true },
      ...withBatchFiles(AUDIO_OUTPUT_METHODS, {
        BatchMergeAudio: {
          inputFiles: true,
          outputDirectory: true,
          outputFileName: true,
          defaultOutputFileName: 'merged_output.wav'
        },
        BatchAddWatermark: {
          inputFiles: true,
          requiredInputFields: ['watermarkFile'],
          outputDirectory: true
        }
      })
    }
  },
  {
    dllId: 'BatchVideoPlugin',
    methods: {
      ...TASK_METHODS,
      GetFileInfo: { requiredInputFields: ['filePath'] },
      GenerateThumbnail: { unsupported: true },
      SaveWatermarkSettings: {},
      LoadWatermarkSettings: {},
      ...withBatchFiles(VIDEO_OUTPUT_METHODS, {
        BatchAddWatermark: {
          inputFiles: true,
          optionalInputFields: ['watermarkFile'],
          outputDirectory: true
        },
        BatchSetThumbnail: {
          inputFiles: true,
          requiredInputFields: ['thumbnailFile'],
          outputDirectory: true
        },
        BatchMergeVideo: {
          inputFiles: true,
          optionalInputFields: ['introFile', 'outroFile'],
          outputDirectory: true,
          outputFileName: true,
          defaultOutputFileName: 'merged_output.mp4'
        }
      })
    }
  },
  VIDEO_DOWNLOADER_DLL_POLICY
]

function invalidMediaCall(message: string): never {
  throw new ZToolsError(errorCodes.invalidRequest, message)
}

function pathKeyForDll(dllId: string): string {
  return dllId.toLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateRawPath(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 32 * 1024 ||
    FORBIDDEN_PATH_CHARACTERS.test(value)
  ) {
    invalidMediaCall('Invalid media path format')
  }
}

function validateOutputFileName(value: unknown): asserts value is string {
  validateRawPath(value)
  const firstExtensionSeparator = value.indexOf('.')
  const deviceStem = (firstExtensionSeparator < 0 ? value : value.slice(0, firstExtensionSeparator)).trimEnd()
  if (
    path.win32.isAbsolute(value) ||
    value.length > 255 ||
    value === '.' ||
    value === '..' ||
    /[<>:"/\\|?*]/.test(value) ||
    /[ .]$/.test(value) ||
    /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(deviceStem)
  ) {
    invalidMediaCall('Media output filename must be a plain filename in the output directory')
  }
}

export function isBuiltInNativeMediaDll(dllId: string): boolean {
  const id = pathKeyForDll(dllId)
  return DEFAULT_NATIVE_MEDIA_DLL_POLICIES.some((policy) => pathKeyForDll(policy.dllId) === id)
}

export class NativeMediaPathPolicy {
  readonly #methods = new Map<string, Readonly<Record<string, NativeMediaMethodPolicy>>>()
  readonly #stat: (target: string) => Promise<NativeMediaStat>
  readonly #lstat: ((target: string) => Promise<NativeMediaLstat>) | undefined
  readonly #parameterPolicy = new NativeMediaParameterPolicy()

  constructor(
    private readonly paths: NativeMediaPathResolver,
    additionalPolicies: readonly NativeMediaDllPolicy[] = [],
    adapters: NativeMediaPolicyAdapters = {}
  ) {
    this.#stat = adapters.stat ?? (async (target) => await fs.stat(target))
    // 生产默认强制执行真实 lstat 符号链接检查；测试仅注入 mock stat 时仅在显式提供 adapters.lstat 时检查
    this.#lstat = adapters.lstat ?? (adapters.stat ? undefined : defaultFsLstat)
    for (const policy of [...DEFAULT_NATIVE_MEDIA_DLL_POLICIES, ...additionalPolicies]) {
      const key = pathKeyForDll(policy.dllId)
      if (!key || this.#methods.has(key)) {
        throw new Error('Native media DLL policy contains a duplicate or empty DLL ID')
      }
      this.#methods.set(key, policy.methods)
    }
  }

  hasPolicy(dllId: string): boolean {
    return this.#methods.has(pathKeyForDll(dllId))
  }

  async authorizeCall(
    dllId: string,
    functionName: string,
    params: Record<string, unknown>,
    caller: CallerIdentity
  ): Promise<Record<string, unknown>> {
    if (pathKeyForDll(dllId) === 'shredderplugin' && functionName === 'secureWipeFile') {
      return await this.#authorizeShredderWipe(params, caller)
    }
    if (pathKeyForDll(dllId) === 'videodownloaderplugin') {
      return await authorizeVideoDownloaderCall(functionName, params, caller, {
        paths: this.paths,
        stat: this.#stat,
        ...(this.#lstat ? { lstat: this.#lstat } : {})
      })
    }
    const methods = this.#methods.get(pathKeyForDll(dllId))
    if (!methods) return params

    if (!Object.hasOwn(methods, functionName)) {
      throw new ZToolsError(errorCodes.methodNotFound, 'Media DLL method is not authorized by host policy')
    }
    const method = methods[functionName]
    if (!method) throw new ZToolsError(errorCodes.methodNotFound, 'Media DLL method is not authorized by host policy')
    if (method.unsupported) {
      throw new ZToolsError(errorCodes.notSupported, 'This media DLL method is not enabled by host security policy')
    }
    if (!isRecord(params)) invalidMediaCall('Media DLL parameters must be an object')
    params = this.#parameterPolicy.normalize(dllId, functionName, params)

    const acceptedPathFields = new Set<string>([
      ...(method.inputFiles ? ['files'] : []),
      ...(method.requiredInputFields ?? []),
      ...(method.optionalInputFields ?? []),
      ...(method.outputDirectory ? ['outputDir'] : []),
      ...(method.outputFileName ? ['outputFile'] : [])
    ])
    for (const key of PATH_FIELDS) {
      if (Object.hasOwn(params, key) && !acceptedPathFields.has(key)) {
        invalidMediaCall('This media DLL method does not accept this path parameter')
      }
    }

    const sanitized: Record<string, unknown> = { ...params }
    let inputItems = 0
    let totalInputBytes = 0

    const resolveInput = async (value: unknown): Promise<string> => {
      validateRawPath(value)
      inputItems += 1
      if (inputItems > MAX_INPUT_ITEMS) invalidMediaCall('Media input file count exceeds the limit of 100 items')
      const canonical = await this.paths.resolveAuthorizedPath(value, caller, 'read', false)
      let stats: NativeMediaStat
      try {
        stats = await this.#stat(canonical)
      } catch {
        throw new ZToolsError(errorCodes.fileError, 'Media input file is not accessible')
      }
      if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 0) {
        throw new ZToolsError(errorCodes.fileError, 'Media input must be a regular file')
      }
      if (stats.size > MAX_INPUT_BYTES) {
        throw new ZToolsError(errorCodes.fileTooLarge, 'Single media input exceeds the 512 MiB limit')
      }
      totalInputBytes += stats.size
      if (totalInputBytes > MAX_TOTAL_INPUT_BYTES) {
        throw new ZToolsError(errorCodes.fileTooLarge, 'Total media input size exceeds the 2 GiB limit')
      }
      return canonical
    }

    if (method.inputFiles) {
      if (!Array.isArray(params.files) || params.files.length === 0) {
        invalidMediaCall('Media method requires a non-empty files array')
      }
      if (params.files.length > MAX_INPUT_ITEMS) invalidMediaCall('Media input file count exceeds the limit of 100 items')
      const canonicalFiles: string[] = []
      for (const value of params.files) canonicalFiles.push(await resolveInput(value))
      sanitized.files = canonicalFiles
    }

    for (const field of method.requiredInputFields ?? []) {
      if (!Object.hasOwn(params, field)) invalidMediaCall(`Media method is missing required ${field} path`)
    }
    for (const field of [...(method.requiredInputFields ?? []), ...(method.optionalInputFields ?? [])]) {
      if (!Object.hasOwn(params, field)) continue
      sanitized[field] = await resolveInput(params[field])
    }

    if (functionName === 'BatchAddWatermark' && params.watermarkType !== 'text' && !Object.hasOwn(params, 'watermarkFile')) {
      invalidMediaCall('Image watermark method requires watermarkFile path')
    }

    if (method.outputDirectory) {
      validateRawPath(params.outputDir)
      let canonicalOutput: string
      try {
        canonicalOutput = await this.paths.resolveAuthorizedPath(params.outputDir, caller, 'write', false)
      } catch (error) {
        if (error instanceof ZToolsError) throw error
        throw new ZToolsError(errorCodes.permissionDenied, 'Output directory is not authorized for write access by the current window')
      }
      let outputStats: NativeMediaStat
      try {
        outputStats = await this.#stat(canonicalOutput)
      } catch {
        throw new ZToolsError(errorCodes.fileError, 'Media output directory is not accessible')
      }
      if (!outputStats.isDirectory()) {
        throw new ZToolsError(errorCodes.invalidRequest, 'Media output path must be an existing directory')
      }
      const normalizedOutput = path.resolve(canonicalOutput)
      for (const field of ['files', ...(method.requiredInputFields ?? []), ...(method.optionalInputFields ?? [])]) {
        const input = sanitized[field]
        const inputPaths = Array.isArray(input) ? input : typeof input === 'string' ? [input] : []
        if (inputPaths.some((item) => typeof item === 'string' && this.#samePath(path.resolve(item), normalizedOutput))) {
          invalidMediaCall('Media input path must not be the same as the output directory')
        }
      }
      if (method.outputFileName) {
        const outputFileName = Object.hasOwn(params, 'outputFile')
          ? params.outputFile
          : method.defaultOutputFileName ?? 'merged_output.wav'
        validateOutputFileName(outputFileName)
        const outputFilePath = path.resolve(canonicalOutput, outputFileName)
        const inputs = [
          ...(Array.isArray(sanitized.files) ? sanitized.files : []),
          ...(method.requiredInputFields ?? []).map((field) => sanitized[field]),
          ...(method.optionalInputFields ?? []).map((field) => sanitized[field])
        ].filter((value): value is string => typeof value === 'string')
        if (inputs.some((input) => this.#samePath(path.resolve(input), outputFilePath))) {
          invalidMediaCall('Media output file must not overwrite any input file')
        }
      }
      sanitized.outputDir = canonicalOutput
    } else if (Object.hasOwn(params, 'outputDir')) {
      invalidMediaCall('This media method does not accept an output directory')
    }

    return sanitized
  }

  async #authorizeShredderWipe(
    params: Record<string, unknown>,
    caller: CallerIdentity
  ): Promise<Record<string, unknown>> {
    if (!isRecord(params)) invalidMediaCall('File shredder parameters must be an object')
    const rawTarget = typeof params.path === 'string' ? params.path : params.targetPath
    validateRawPath(rawTarget)
    if (!path.isAbsolute(rawTarget)) invalidMediaCall('File shredder path must be an absolute path')

    let canonical: string
    try {
      canonical = await this.paths.resolveAuthorizedPath(rawTarget, caller, 'read', false)
    } catch {
      canonical = await this.#resolveAllowedScanTempPath(rawTarget)
    }

    if (this.#isProtectedWipePath(canonical)) {
      throw new ZToolsError(errorCodes.permissionDenied, 'Shredding files in protected system directories is forbidden')
    }

    let stats: NativeMediaStat
    try {
      stats = await this.#stat(canonical)
    } catch {
      throw new ZToolsError(errorCodes.fileError, 'Target file to shred does not exist or is not accessible')
    }
    if (!stats.isFile()) {
      throw new ZToolsError(errorCodes.invalidRequest, 'Only regular files can be shredded')
    }

    const sanitized: Record<string, unknown> = { ...params }
    if (typeof params.path === 'string') sanitized.path = canonical
    if (typeof params.targetPath === 'string') sanitized.targetPath = canonical
    return sanitized
  }

  async #resolveAllowedScanTempPath(rawTarget: string): Promise<string> {
    const resolved = path.resolve(rawTarget)
    let cursor = resolved
    while (true) {
      let lstatResult: import('node:fs').Stats
      try {
        lstatResult = await fs.lstat(cursor)
      } catch {
        throw new ZToolsError(errorCodes.permissionDenied, 'Target file to shred is not authorized by the window and is outside trusted temporary directories')
      }
      if (lstatResult.isSymbolicLink()) {
        throw new ZToolsError(errorCodes.permissionDenied, 'Target file path contains a symbolic link or reparse point')
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
    const real = await fs.realpath(resolved).catch(() => {
      throw new ZToolsError(errorCodes.permissionDenied, 'Target file to shred is not authorized by the window')
    })
    const allowedTempRoots = [
      os.tmpdir(),
      process.env.TEMP,
      process.env.TMP,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : undefined,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CrashDumps') : undefined
    ].filter((item): item is string => typeof item === 'string' && item.length > 0)

    for (const rootCandidate of allowedTempRoots) {
      const realRoot = await fs.realpath(rootCandidate).catch(() => path.resolve(rootCandidate))
      if (this.#isSubPath(real, realRoot)) {
        return real
      }
    }
    throw new ZToolsError(errorCodes.permissionDenied, 'Target file is not authorized by the current window; physical shredding denied')
  }

  #isProtectedWipePath(targetPath: string): boolean {
    const resolved = path.resolve(targetPath)
    const parsed = path.parse(resolved)
    if (resolved === parsed.root) return true
    const home = path.resolve(os.homedir())
    if (this.#samePath(resolved, home)) return true

    // 允许系统临时目录与 CrashDumps（它们可能位于 C:\Windows\Temp 或 AppData\Local\Temp）
    const allowedTempRoots = [
      os.tmpdir(),
      process.env.TEMP,
      process.env.TMP,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : undefined,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'CrashDumps') : undefined
    ].filter((item): item is string => typeof item === 'string' && item.length > 0)
    for (const tempRoot of allowedTempRoots) {
      if (this.#isSubPath(resolved, path.resolve(tempRoot))) return false
    }

    const protectedRoots = [
      ...defaultProtectedTrashRoots(process.platform, process.env),
      ...(process.platform === 'darwin' ? ['/Library', '/Applications', '/etc', '/var'] : [])
    ]
    for (const root of protectedRoots) {
      if (!root) continue
      const resolvedRoot = path.resolve(root)
      if (this.#samePath(resolved, resolvedRoot) || this.#isSubPath(resolved, resolvedRoot)) {
        return true
      }
    }
    return false
  }

  #isSubPath(childPath: string, parentDir: string): boolean {
    const normChild = process.platform === 'win32' ? path.normalize(childPath).toLowerCase() : path.normalize(childPath)
    const normParent = process.platform === 'win32' ? path.normalize(parentDir).toLowerCase() : path.normalize(parentDir)
    const prefix = normParent.endsWith(path.sep) ? normParent : `${normParent}${path.sep}`
    return normChild.startsWith(prefix) && normChild.length > prefix.length
  }

  #samePath(left: string, right: string): boolean {
    const normalizedLeft = path.normalize(left)
    const normalizedRight = path.normalize(right)
    return process.platform === 'win32'
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight
  }
}
