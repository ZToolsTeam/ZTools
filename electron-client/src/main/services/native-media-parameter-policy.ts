import { errorCodes, ZToolsError } from '../../contracts/errors.js'

const MAX_INPUT_ITEMS = 100
const MAX_MEDIA_SECONDS = 7 * 24 * 60 * 60
const MAX_DIMENSION = 16_384
const MAX_TEXT_LENGTH = 4_096
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/

type ParameterValidator = (value: unknown) => unknown

interface MethodSchema {
  fields: Readonly<Record<string, ParameterValidator>>
  required?: readonly string[]
  validate?: (params: Record<string, unknown>) => void
}

type MethodTable = Readonly<Record<string, MethodSchema>>

function invalid(message: string): never {
  throw new ZToolsError(errorCodes.invalidRequest, message)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function finiteNumber(name: string, minimum: number, maximum: number): ParameterValidator {
  return (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
      invalid(`${name} 必须是 ${minimum} 到 ${maximum} 之间的有限数值`)
    }
    return value
  }
}

function integer(name: string, minimum: number, maximum: number): ParameterValidator {
  return (value) => {
    if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
      invalid(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`)
    }
    return value
  }
}

function boolean(name: string): ParameterValidator {
  return (value) => {
    if (typeof value !== 'boolean') invalid(`${name} 必须是布尔值`)
    return value
  }
}

function stringValue(name: string, maximumLength: number, allowEmpty = true): ParameterValidator {
  return (value) => {
    if (
      typeof value !== 'string' ||
      (!allowEmpty && value.length === 0) ||
      value.length > maximumLength ||
      CONTROL_CHARACTERS.test(value)
    ) {
      invalid(`${name} 格式或长度无效`)
    }
    return value
  }
}

function enumValue(name: string, values: readonly string[], normalizeLowercase = false): ParameterValidator {
  const allowed = new Set(values)
  return (value) => {
    if (typeof value !== 'string') invalid(`${name} 必须是受支持的字符串选项`)
    const normalized = normalizeLowercase ? value.toLowerCase() : value
    if (!allowed.has(normalized)) invalid(`${name} 包含不受支持的选项`)
    return normalized
  }
}

function numericSelect(name: string, values: readonly number[]): ParameterValidator {
  const allowed = new Set(values)
  return (value) => {
    let normalized: number
    if (typeof value === 'number') {
      normalized = value
    } else if (typeof value === 'string' && /^\d+$/.test(value)) {
      normalized = Number(value)
    } else {
      invalid(`${name} 必须是受支持的数字选项`)
    }
    if (!Number.isSafeInteger(normalized) || !allowed.has(normalized)) {
      invalid(`${name} 包含不受支持的数字选项`)
    }
    return normalized
  }
}

function pathString(name: string): ParameterValidator {
  return (value) => {
    if (typeof value !== 'string' || value.length === 0) invalid(`${name} 必须是路径字符串`)
    return value
  }
}

function fileList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INPUT_ITEMS) {
    invalid(`files 必须是 1 到 ${MAX_INPUT_ITEMS} 项的路径数组`)
  }
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
    invalid('files 必须是普通路径数组')
  }
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index]
    if (!Object.hasOwn(value, index) || typeof item !== 'string' || item.length === 0) {
      invalid('files 中每一项都必须是路径字符串')
    }
  }
  return [...value]
}

function parseTimeSeconds(value: unknown, name: string, positive: boolean): number {
  let seconds: number
  if (typeof value === 'number') {
    seconds = value
  } else if (typeof value === 'string') {
    const scalar = /^(\d+(?:\.\d+)?)$/.exec(value)
    if (scalar) {
      seconds = Number(scalar[1])
    } else {
      const minuteSecond = /^(\d+):([0-5]?\d(?:\.\d+)?)$/.exec(value)
      const hourMinuteSecond = /^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(value)
      if (minuteSecond) {
        seconds = Number(minuteSecond[1]) * 60 + Number(minuteSecond[2])
      } else if (hourMinuteSecond) {
        seconds =
          Number(hourMinuteSecond[1]) * 3600 +
          Number(hourMinuteSecond[2]) * 60 +
          Number(hourMinuteSecond[3])
      } else {
        invalid(`${name} 必须是秒数或完整的 MM:SS / HH:MM:SS 时间`)
      }
    }
  } else {
    invalid(`${name} 必须是秒数或时间字符串`)
  }

  if (
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > MAX_MEDIA_SECONDS ||
    (positive && seconds === 0)
  ) {
    invalid(`${name} 超出允许时间范围`)
  }
  return seconds
}

function timeValue(name: string, positive: boolean): ParameterValidator {
  return (value) => parseTimeSeconds(value, name, positive)
}

function clipsValue(value: unknown): Array<{ startTime: number; duration: number }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_INPUT_ITEMS) {
    invalid(`clips 必须是 1 到 ${MAX_INPUT_ITEMS} 项的数组`)
  }
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
    invalid('clips 必须是普通数组')
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid(`clips[${index}] 不允许为空项`)
  }
  return value.map((clip, index) => {
    if (!isPlainRecord(clip) || Reflect.ownKeys(clip).some((key) => typeof key !== 'string')) {
      invalid(`clips[${index}] 必须是普通对象`)
    }
    const keys = Reflect.ownKeys(clip) as string[]
    if (keys.some((key) => key !== 'startTime' && key !== 'duration')) {
      invalid(`clips[${index}] 只允许 startTime 和 duration`)
    }
    if (!Object.hasOwn(clip, 'startTime') || !Object.hasOwn(clip, 'duration')) {
      invalid(`clips[${index}] 缺少 startTime 或 duration`)
    }
    const startTime = parseTimeSeconds(clip.startTime, `clips[${index}].startTime`, false)
    const duration = parseTimeSeconds(clip.duration, `clips[${index}].duration`, true)
    if (startTime + duration > MAX_MEDIA_SECONDS) {
      invalid(`clips[${index}] 结束时间超过 7 天上限`)
    }
    return { startTime, duration }
  })
}

function validateSegmentBounds(params: Record<string, unknown>): void {
  const startTime = (params.startTime as number | undefined) ?? 0
  const duration = params.duration as number
  if (startTime + duration > MAX_MEDIA_SECONDS) invalid('片段终点超过 7 天上限')
}

const filesField = fileList
const outputDirField = pathString('outputDir')
const taskIdField: ParameterValidator = (value) => {
  if (typeof value !== 'string' || !TASK_ID_PATTERN.test(value)) invalid('taskId 格式无效')
  return value
}

function batch(
  fields: Readonly<Record<string, ParameterValidator>> = {},
  options: { outputDir?: boolean; required?: readonly string[]; validate?: MethodSchema['validate'] } = {}
): MethodSchema {
  return {
    fields: {
      files: filesField,
      ...(options.outputDir === false ? {} : { outputDir: outputDirField }),
      taskId: taskIdField,
      ...fields
    },
    required: ['files', ...(options.required ?? [])],
    ...(options.validate ? { validate: options.validate } : {})
  }
}

function taskMethod(withTaskId: boolean): MethodSchema {
  return withTaskId
    ? { fields: { taskId: taskIdField }, required: ['taskId'] }
    : { fields: {} }
}

const audioMethods: MethodTable = {
  GetTaskStatus: taskMethod(true),
  GetTaskList: taskMethod(false),
  CancelTask: taskMethod(true),
  GetFileInfo: { fields: { filePath: pathString('filePath') }, required: ['filePath'] },
  BatchConvertFormat: batch({
    format: enumValue('format', ['wav', 'mp3', 'aac', 'flac', 'ogg']),
    sampleRate: numericSelect('sampleRate', [44_100, 48_000]),
    bitDepth: numericSelect('bitDepth', [16, 24]),
    channels: numericSelect('channels', [1, 2])
  }),
  BatchNormalizeVolume: batch({ volume: finiteNumber('volume', 0, 10) }),
  BatchLoudnorm: batch({
    lufs: finiteNumber('lufs', -70, -5),
    lra: finiteNumber('lra', 1, 20),
    tp: finiteNumber('tp', -9, 0)
  }),
  BatchTrimAudio: batch({
    trimType: enumValue('trimType', ['start', 'end']),
    duration: timeValue('duration', true)
  }, { required: ['duration'] }),
  BatchExtractSegment: batch({
    startTime: timeValue('startTime', false),
    duration: timeValue('duration', true)
  }, { required: ['duration'], validate: validateSegmentBounds }),
  BatchMergeAudio: batch({
    outputFile: pathString('outputFile'),
    insertSilence: boolean('insertSilence'),
    silenceDuration: finiteNumber('silenceDuration', 0, MAX_MEDIA_SECONDS)
  }, { validate: (params) => {
    if ((params.files as string[]).length < 2) invalid('BatchMergeAudio 至少需要 2 个输入文件')
    if (params.insertSilence === true && params.silenceDuration !== undefined &&
        ((params.silenceDuration as number) < 0.1 || (params.silenceDuration as number) > 60)) {
      invalid('启用合并静音时 silenceDuration 必须为 0.1–60 秒')
    }
  } }),
  BatchAddWatermark: batch({
    watermarkFile: pathString('watermarkFile'),
    interval: finiteNumber('interval', 0, MAX_MEDIA_SECONDS),
    volume: finiteNumber('volume', 0, 1)
  }),
  BatchFadeInOut: batch({
    fadeIn: finiteNumber('fadeIn', 0, MAX_MEDIA_SECONDS),
    fadeOut: finiteNumber('fadeOut', 0, MAX_MEDIA_SECONDS)
  }),
  BatchEqualizer: batch({
    frequency: finiteNumber('frequency', 20, 20_000),
    gain: finiteNumber('gain', -20, 20),
    width: finiteNumber('width', 0.1, 10)
  }),
  BatchCompressor: batch(),
  BatchDenoise: batch(),
  BatchDetectSilence: batch({
    noise: finiteNumber('noise', -80, 0),
    duration: finiteNumber('duration', 0.1, MAX_MEDIA_SECONDS)
  }, { outputDir: false }),
  BatchSetMetadata: batch({
    title: stringValue('title', MAX_TEXT_LENGTH),
    artist: stringValue('artist', MAX_TEXT_LENGTH),
    album: stringValue('album', MAX_TEXT_LENGTH)
  })
}

const watermarkPosition = [
  'topleft', 'top', 'topright', 'left', 'center', 'right',
  'bottomleft', 'bottom', 'bottomright', 'custom'
] as const

const watermarkSettingsFields: Readonly<Record<string, ParameterValidator>> = {
  watermarkType: enumValue('watermarkType', ['text', 'image']),
  text: stringValue('text', MAX_TEXT_LENGTH),
  fontSize: integer('fontSize', 8, 200),
  fontColor: (value) => {
    if (typeof value !== 'string') invalid('fontColor 必须是安全颜色值')
    const normalized = value.toLowerCase()
    const named = new Set(['white', 'black', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'gray', 'grey'])
    if (!named.has(normalized) && !/^#[0-9a-f]{6}$/.test(normalized)) {
      invalid('fontColor 必须是受支持的颜色名或 #RRGGBB')
    }
    return normalized
  },
  padding: integer('padding', 0, 50),
  angle: finiteNumber('angle', -360, 360),
  opacity: finiteNumber('opacity', 0, 1),
  position: enumValue('position', watermarkPosition),
  x: integer('x', 0, MAX_DIMENSION),
  y: integer('y', 0, MAX_DIMENSION),
  mode: enumValue('mode', ['fixed', 'dynamic', 'tiled']),
  direction: enumValue('direction', ['top', 'bottom', 'left', 'right']),
  dynamicPosition: enumValue('dynamicPosition', ['left', 'center', 'right']),
  dynamicPositionVertical: enumValue('dynamicPositionVertical', ['top', 'center', 'bottom']),
  dynamicSpeed: integer('dynamicSpeed', 1, 500),
  dynamicLoop: boolean('dynamicLoop')
}

const videoMethods: MethodTable = {
  GetTaskStatus: taskMethod(true),
  GetTaskList: taskMethod(false),
  CancelTask: taskMethod(true),
  GetFileInfo: { fields: { filePath: pathString('filePath') }, required: ['filePath'] },
  SaveWatermarkSettings: { fields: watermarkSettingsFields },
  LoadWatermarkSettings: { fields: {} },
  BatchCompressVideo: batch({
    codec: enumValue('codec', ['h264', 'h265', 'av1', 'libx264', 'libx265', 'libsvtav1'], true),
    quality: integer('quality', 1, 51)
  }, { required: ['quality'] }),
  BatchTrimVideo: batch({
    trimType: enumValue('trimType', ['start', 'end']),
    duration: timeValue('duration', true)
  }, { required: ['duration'] }),
  BatchExtractSegment: batch({
    startTime: timeValue('startTime', false),
    duration: timeValue('duration', true)
  }, { required: ['duration'], validate: validateSegmentBounds }),
  BatchExtractClips: batch({ clips: clipsValue }, { required: ['clips'] }),
  BatchCropByRatio: batch({
    ratio: enumValue('ratio', ['16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '5:4', '4:5', '1:1'])
  }, { required: ['ratio'] }),
  BatchConvertFormat: batch({
    format: enumValue('format', ['mp4', 'avi', 'flv', 'mkv', 'mov', 'wmv', 'webm'])
  }, { required: ['format'] }),
  BatchConvertToGif: batch({
    format: enumValue('format', ['gif', 'webp']),
    fps: integer('fps', 1, 60),
    width: integer('width', 0, MAX_DIMENSION),
    height: integer('height', 0, MAX_DIMENSION),
    loop: boolean('loop')
  }, { required: ['format'] }),
  BatchAddWatermark: batch({
    ...watermarkSettingsFields,
    saveSettings: boolean('saveSettings'),
    watermarkFile: pathString('watermarkFile')
  }, { validate: (params) => {
    const type = params.watermarkType ?? 'image'
    if (type === 'text' && Object.hasOwn(params, 'watermarkFile')) {
      invalid('文字水印不能同时包含 watermarkFile')
    }
    if (type === 'image' && Object.hasOwn(params, 'text')) {
      invalid('图片水印不能包含未使用的 text')
    }
  } }),
  BatchResizeVideo: batch({
    width: integer('width', 0, MAX_DIMENSION),
    height: integer('height', 0, MAX_DIMENSION)
  }, { validate: (params) => {
    if ((params.width ?? 0) === 0 && (params.height ?? 0) === 0) {
      invalid('BatchResizeVideo 至少需要一个正尺寸')
    }
  } }),
  BatchSetThumbnail: batch({ thumbnailFile: pathString('thumbnailFile') }, { required: ['thumbnailFile'] }),
  BatchSpeedUpVideo: batch({ speed: finiteNumber('speed', 0.1, 10), audioSync: boolean('audioSync') }, { required: ['speed'] }),
  BatchFlipVideo: batch({ direction: enumValue('direction', ['horizontal', 'vertical']) }, { required: ['direction'] }),
  BatchRotateVideo: batch({
    angle: (value) => {
      const result = integer('angle', -360, 360)(value)
      if ((result as number) % 90 !== 0) invalid('angle 必须是 90 度的整数倍')
      return result
    }
  }, { required: ['angle'] }),
  BatchMergeVideo: batch({
    introFile: pathString('introFile'),
    outroFile: pathString('outroFile'),
    position: enumValue('position', ['append', 'prepend']),
    outputFile: pathString('outputFile'),
    checkFormat: boolean('checkFormat')
  }, { validate: (params) => {
    const hasIntroOrOutro = Object.hasOwn(params, 'introFile') || Object.hasOwn(params, 'outroFile')
    if (hasIntroOrOutro) {
      if (Object.hasOwn(params, 'position') || Object.hasOwn(params, 'outputFile') || Object.hasOwn(params, 'checkFormat')) {
        invalid('片头/片尾合并模式不接受 position、outputFile 或 checkFormat')
      }
    } else if ((params.files as string[]).length < 2) {
      invalid('BatchMergeVideo 至少需要 2 个主视频文件')
    }
  } }),
  BatchRemoveAudio: batch(),
  BatchExtractAudio: batch({ format: enumValue('format', ['mp3', 'aac', 'wav', 'flac']) }),
  BatchExtractFrames: batch({
    interval: integer('interval', 1, MAX_MEDIA_SECONDS),
    width: integer('width', 0, MAX_DIMENSION),
    height: integer('height', 0, MAX_DIMENSION)
  })
}

const METHOD_TABLES: Readonly<Record<string, MethodTable>> = {
  batchaudioplugin: audioMethods,
  batchvideoplugin: videoMethods
}

export class NativeMediaParameterPolicy {
  normalize(dllId: string, functionName: string, params: Record<string, unknown>): Record<string, unknown> {
    const dllKey = dllId.toLowerCase()
    if (!Object.hasOwn(METHOD_TABLES, dllKey)) return params
    const methods = METHOD_TABLES[dllKey]!
    if (!Object.hasOwn(methods, functionName)) {
      throw new ZToolsError(errorCodes.methodNotFound, '媒体 DLL 方法未获参数策略授权')
    }
    if (!isPlainRecord(params) || Reflect.ownKeys(params).some((key) => typeof key !== 'string')) {
      invalid('媒体 DLL 参数必须是普通对象')
    }

    const method = methods[functionName]!
    const normalized: Record<string, unknown> = {}
    const ownKeys = Reflect.ownKeys(params) as string[]
    for (const key of ownKeys) {
      if (!Object.hasOwn(method.fields, key)) invalid(`媒体 DLL 参数不接受字段 ${key}`)
      normalized[key] = method.fields[key]!(params[key])
    }
    for (const key of method.required ?? []) {
      if (!Object.hasOwn(normalized, key)) invalid(`媒体 DLL 参数缺少 ${key}`)
    }
    method.validate?.(normalized)
    return normalized
  }
}
