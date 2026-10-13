import fs from 'node:fs/promises'
import path from 'node:path'
import type { CallerIdentity } from '../../contracts/capabilities.js'
import { errorCodes, ZToolsError } from '../../contracts/errors.js'
import { NativeMediaParameterPolicy } from './native-media-parameter-policy.js'

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
  }
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
    invalidMediaCall('媒体路径格式无效')
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
    invalidMediaCall('媒体输出文件名必须是当前输出目录下的普通文件名')
  }
}

export function isBuiltInNativeMediaDll(dllId: string): boolean {
  const id = pathKeyForDll(dllId)
  return DEFAULT_NATIVE_MEDIA_DLL_POLICIES.some((policy) => pathKeyForDll(policy.dllId) === id)
}

export class NativeMediaPathPolicy {
  readonly #methods = new Map<string, Readonly<Record<string, NativeMediaMethodPolicy>>>()
  readonly #stat: (target: string) => Promise<NativeMediaStat>
  readonly #parameterPolicy = new NativeMediaParameterPolicy()

  constructor(
    private readonly paths: NativeMediaPathResolver,
    additionalPolicies: readonly NativeMediaDllPolicy[] = [],
    adapters: NativeMediaPolicyAdapters = {}
  ) {
    this.#stat = adapters.stat ?? (async (target) => await fs.stat(target))
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
    const methods = this.#methods.get(pathKeyForDll(dllId))
    if (!methods) return params

    if (!Object.hasOwn(methods, functionName)) {
      throw new ZToolsError(errorCodes.methodNotFound, '媒体 DLL 方法未获宿主策略授权')
    }
    const method = methods[functionName]
    if (!method) throw new ZToolsError(errorCodes.methodNotFound, '媒体 DLL 方法未获宿主策略授权')
    if (method.unsupported) {
      throw new ZToolsError(errorCodes.notSupported, '该媒体 DLL 方法暂未由宿主安全策略开放')
    }
    if (!isRecord(params)) invalidMediaCall('媒体 DLL 参数必须是对象')
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
        invalidMediaCall('该媒体 DLL 方法不接受此路径参数')
      }
    }

    const sanitized: Record<string, unknown> = { ...params }
    let inputItems = 0
    let totalInputBytes = 0

    const resolveInput = async (value: unknown): Promise<string> => {
      validateRawPath(value)
      inputItems += 1
      if (inputItems > MAX_INPUT_ITEMS) invalidMediaCall('媒体输入文件数量超过 100 项')
      const canonical = await this.paths.resolveAuthorizedPath(value, caller, 'read', false)
      let stats: NativeMediaStat
      try {
        stats = await this.#stat(canonical)
      } catch {
        throw new ZToolsError(errorCodes.fileError, '媒体输入文件不可访问')
      }
      if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 0) {
        throw new ZToolsError(errorCodes.fileError, '媒体输入必须是普通文件')
      }
      if (stats.size > MAX_INPUT_BYTES) {
        throw new ZToolsError(errorCodes.fileTooLarge, '单个媒体输入超过 512 MiB 上限')
      }
      totalInputBytes += stats.size
      if (totalInputBytes > MAX_TOTAL_INPUT_BYTES) {
        throw new ZToolsError(errorCodes.fileTooLarge, '媒体输入总大小超过 2 GiB 上限')
      }
      return canonical
    }

    if (method.inputFiles) {
      if (!Array.isArray(params.files) || params.files.length === 0) {
        invalidMediaCall('媒体方法需要非空 files 数组')
      }
      if (params.files.length > MAX_INPUT_ITEMS) invalidMediaCall('媒体输入文件数量超过 100 项')
      const canonicalFiles: string[] = []
      for (const value of params.files) canonicalFiles.push(await resolveInput(value))
      sanitized.files = canonicalFiles
    }

    for (const field of method.requiredInputFields ?? []) {
      if (!Object.hasOwn(params, field)) invalidMediaCall(`媒体方法缺少 ${field} 路径`)
    }
    for (const field of [...(method.requiredInputFields ?? []), ...(method.optionalInputFields ?? [])]) {
      if (!Object.hasOwn(params, field)) continue
      sanitized[field] = await resolveInput(params[field])
    }

    if (functionName === 'BatchAddWatermark' && params.watermarkType !== 'text' && !Object.hasOwn(params, 'watermarkFile')) {
      invalidMediaCall('图片水印方法需要 watermarkFile 路径')
    }

    if (method.outputDirectory) {
      validateRawPath(params.outputDir)
      let canonicalOutput: string
      try {
        canonicalOutput = await this.paths.resolveAuthorizedPath(params.outputDir, caller, 'write', false)
      } catch (error) {
        if (error instanceof ZToolsError) throw error
        throw new ZToolsError(errorCodes.permissionDenied, '输出目录未获当前窗口写授权')
      }
      let outputStats: NativeMediaStat
      try {
        outputStats = await this.#stat(canonicalOutput)
      } catch {
        throw new ZToolsError(errorCodes.fileError, '媒体输出目录不可访问')
      }
      if (!outputStats.isDirectory()) {
        throw new ZToolsError(errorCodes.invalidRequest, '媒体输出路径必须是已存在目录')
      }
      const normalizedOutput = path.resolve(canonicalOutput)
      for (const field of ['files', ...(method.requiredInputFields ?? []), ...(method.optionalInputFields ?? [])]) {
        const input = sanitized[field]
        const inputPaths = Array.isArray(input) ? input : typeof input === 'string' ? [input] : []
        if (inputPaths.some((item) => typeof item === 'string' && this.#samePath(path.resolve(item), normalizedOutput))) {
          invalidMediaCall('媒体输入路径不能与输出目录相同')
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
          invalidMediaCall('媒体输出文件不能覆盖任何输入文件')
        }
      }
      sanitized.outputDir = canonicalOutput
    } else if (Object.hasOwn(params, 'outputDir')) {
      invalidMediaCall('该媒体方法不接受输出目录')
    }

    return sanitized
  }

  #samePath(left: string, right: string): boolean {
    const normalizedLeft = path.normalize(left)
    const normalizedRight = path.normalize(right)
    return process.platform === 'win32'
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight
  }
}
