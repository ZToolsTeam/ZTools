import { TOOL_RUNTIME_ERROR_CODES } from '../../../../contracts/tool-runtime/common.js'
import type {
  MediaAudioCodec,
  MediaContainerFormat,
  MediaProbeRequest,
  MediaScaleOption,
  MediaTranscodeRequest,
  MediaTrimOption,
  MediaVideoCodec,
  MediaWatermarkOption,
  MediaWatermarkPosition
} from '../../../../contracts/tool-runtime/domains/media.js'
import { createToolRuntimeError, isPlainObject } from '../../core/errors.js'
import { assertValidToolPathSlotStructure, DEFAULT_MAX_FILES_PER_TASK } from '../../core/path-slot-guard.js'

/**
 * 媒体能力域第一层平台无关参数白名单（Fail-Closed）：
 * - 严格拦截任何未知字段与非法类型；
 * - 校验容器/编解码器枚举、码率/帧率/采样率/声道/分辨率/裁剪/水印范围；
 * - 严禁对允许 0 的数值字段（如 startSec、opacity、marginPx）使用 !val 判空；
 * - 拦截语义矛盾的参数组合（如 extractAudioOnly + stripAudio、videoCodec=copy + scale/watermark）。
 */

export const MEDIA_CONTAINERS: ReadonlySet<MediaContainerFormat> = new Set([
  'mp4',
  'mkv',
  'mov',
  'webm',
  'mp3',
  'aac',
  'flac',
  'wav',
  'ogg',
  'gif'
])

export const AUDIO_ONLY_CONTAINERS: ReadonlySet<MediaContainerFormat> = new Set([
  'mp3',
  'aac',
  'flac',
  'wav',
  'ogg'
])

export const MEDIA_VIDEO_CODECS: ReadonlySet<MediaVideoCodec> = new Set([
  'h264',
  'hevc',
  'vp9',
  'av1',
  'copy'
])

export const MEDIA_AUDIO_CODECS: ReadonlySet<MediaAudioCodec> = new Set([
  'aac',
  'mp3',
  'opus',
  'flac',
  'pcm',
  'copy'
])

export const MEDIA_WATERMARK_POSITIONS: ReadonlySet<MediaWatermarkPosition> = new Set([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'center'
])

const PROBE_ALLOWED_KEYS = new Set(['inputs'])
const TRANSCODE_ALLOWED_KEYS = new Set([
  'taskId',
  'input',
  'output',
  'overwrite',
  'container',
  'videoCodec',
  'audioCodec',
  'videoBitrateKbps',
  'audioBitrateKbps',
  'frameRate',
  'audioSampleRateHz',
  'audioChannels',
  'extractAudioOnly',
  'stripAudio',
  'scale',
  'trim',
  'watermark'
])
const SCALE_ALLOWED_KEYS = new Set(['width', 'height', 'keepAspectRatio'])
const TRIM_ALLOWED_KEYS = new Set(['startSec', 'durationSec', 'endSec'])
const WATERMARK_ALLOWED_KEYS = new Set(['imageSlot', 'position', 'opacity', 'marginPx'])
const TASK_ID_REGEX = /^[A-Za-z0-9._:-]{1,128}$/

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

function assertFiniteRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  requireInteger = false
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `${field} must be a finite number`,
      { fields: [field] }
    )
  }
  if (requireInteger && !Number.isInteger(value)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `${field} must be an integer`,
      { fields: [field] }
    )
  }
  if (value < min || value > max) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `${field} must be within [${min}, ${max}]`,
      { fields: [field] }
    )
  }
  return value
}

/** 校验 media.probe 请求参数 */
export function validateMediaProbeRequest(raw: unknown): MediaProbeRequest {
  if (!isPlainObject(raw)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      'media.probe request must be an object'
    )
  }
  rejectUnknownFields(raw, PROBE_ALLOWED_KEYS, 'media.probe')
  if (!Array.isArray(raw.inputs) || raw.inputs.length === 0) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      'media.probe requires a non-empty inputs array',
      { fields: ['inputs'] }
    )
  }
  if (raw.inputs.length > DEFAULT_MAX_FILES_PER_TASK) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `media.probe supports at most ${DEFAULT_MAX_FILES_PER_TASK} inputs`,
      { fields: ['inputs'] }
    )
  }
  for (let i = 0; i < raw.inputs.length; i += 1) {
    assertValidToolPathSlotStructure(raw.inputs[i], `inputs[${i}]`)
  }
  return {
    inputs: raw.inputs
  }
}

function validateScaleOption(raw: unknown): MediaScaleOption {
  if (!isPlainObject(raw)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'scale must be an object',
      { fields: ['scale'] }
    )
  }
  rejectUnknownFields(raw, SCALE_ALLOWED_KEYS, 'scale')
  const width = raw.width !== undefined ? assertFiniteRange(raw.width, 'scale.width', 16, 16_384, true) : undefined
  const height = raw.height !== undefined ? assertFiniteRange(raw.height, 'scale.height', 16, 16_384, true) : undefined
  if (width === undefined && height === undefined) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'scale requires at least width or height',
      { fields: ['scale'] }
    )
  }
  if (raw.keepAspectRatio !== undefined && typeof raw.keepAspectRatio !== 'boolean') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'scale.keepAspectRatio must be a boolean',
      { fields: ['scale.keepAspectRatio'] }
    )
  }
  return {
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(raw.keepAspectRatio !== undefined ? { keepAspectRatio: raw.keepAspectRatio } : {})
  }
}

function validateTrimOption(raw: unknown): MediaTrimOption {
  if (!isPlainObject(raw)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'trim must be an object',
      { fields: ['trim'] }
    )
  }
  rejectUnknownFields(raw, TRIM_ALLOWED_KEYS, 'trim')
  // 注意：startSec 允许为 0，必须严格使用 !== undefined 判空
  const startSec =
    raw.startSec !== undefined ? assertFiniteRange(raw.startSec, 'trim.startSec', 0, 86_400 * 7) : undefined
  const durationSec =
    raw.durationSec !== undefined
      ? assertFiniteRange(raw.durationSec, 'trim.durationSec', 0.001, 86_400 * 7)
      : undefined
  const endSec =
    raw.endSec !== undefined ? assertFiniteRange(raw.endSec, 'trim.endSec', 0.001, 86_400 * 7) : undefined

  if (startSec === undefined && durationSec === undefined && endSec === undefined) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'trim requires at least one of startSec, durationSec, or endSec',
      { fields: ['trim'] }
    )
  }
  if (durationSec !== undefined && endSec !== undefined) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'trim must not specify both durationSec and endSec',
      { fields: ['trim.durationSec', 'trim.endSec'] }
    )
  }
  if (startSec !== undefined && endSec !== undefined && endSec <= startSec) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'trim.endSec must be strictly greater than trim.startSec',
      { fields: ['trim.startSec', 'trim.endSec'] }
    )
  }
  return {
    ...(startSec !== undefined ? { startSec } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(endSec !== undefined ? { endSec } : {})
  }
}

function validateWatermarkOption(raw: unknown): MediaWatermarkOption {
  if (!isPlainObject(raw)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'watermark must be an object',
      { fields: ['watermark'] }
    )
  }
  rejectUnknownFields(raw, WATERMARK_ALLOWED_KEYS, 'watermark')
  assertValidToolPathSlotStructure(raw.imageSlot, 'watermark.imageSlot')
  if (
    typeof raw.position !== 'string' ||
    !MEDIA_WATERMARK_POSITIONS.has(raw.position as MediaWatermarkPosition)
  ) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `Unsupported watermark position: ${String(raw.position)}`,
      { fields: ['watermark.position'] }
    )
  }
  const opacity =
    raw.opacity !== undefined ? assertFiniteRange(raw.opacity, 'watermark.opacity', 0, 1) : undefined
  const marginPx =
    raw.marginPx !== undefined ? assertFiniteRange(raw.marginPx, 'watermark.marginPx', 0, 4096, true) : undefined
  return {
    imageSlot: raw.imageSlot,
    position: raw.position as MediaWatermarkPosition,
    ...(opacity !== undefined ? { opacity } : {}),
    ...(marginPx !== undefined ? { marginPx } : {})
  }
}

/** 校验 media.transcode 请求参数（全字段白名单 + 数值范围 + 互斥冲突拦截） */
export function validateMediaTranscodeRequest(raw: unknown): MediaTranscodeRequest {
  if (!isPlainObject(raw)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      'media.transcode request must be an object'
    )
  }
  rejectUnknownFields(raw, TRANSCODE_ALLOWED_KEYS, 'media.transcode')

  if (raw.taskId !== undefined && (typeof raw.taskId !== 'string' || !TASK_ID_REGEX.test(raw.taskId))) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.invalidRequest,
      'Invalid media.transcode taskId',
      { fields: ['taskId'] }
    )
  }
  assertValidToolPathSlotStructure(raw.input, 'input')
  assertValidToolPathSlotStructure(raw.output, 'output')

  if (raw.overwrite !== undefined && typeof raw.overwrite !== 'boolean') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'overwrite must be a boolean',
      { fields: ['overwrite'] }
    )
  }

  if (typeof raw.container !== 'string' || !MEDIA_CONTAINERS.has(raw.container as MediaContainerFormat)) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `Unsupported media container: ${String(raw.container)}`,
      { fields: ['container'] }
    )
  }
  const container = raw.container as MediaContainerFormat

  let videoCodec: MediaVideoCodec | undefined
  if (raw.videoCodec !== undefined) {
    if (typeof raw.videoCodec !== 'string' || !MEDIA_VIDEO_CODECS.has(raw.videoCodec as MediaVideoCodec)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `Unsupported videoCodec: ${String(raw.videoCodec)}`,
        { fields: ['videoCodec'] }
      )
    }
    videoCodec = raw.videoCodec as MediaVideoCodec
  }

  let audioCodec: MediaAudioCodec | undefined
  if (raw.audioCodec !== undefined) {
    if (typeof raw.audioCodec !== 'string' || !MEDIA_AUDIO_CODECS.has(raw.audioCodec as MediaAudioCodec)) {
      throw createToolRuntimeError(
        TOOL_RUNTIME_ERROR_CODES.policyViolation,
        `Unsupported audioCodec: ${String(raw.audioCodec)}`,
        { fields: ['audioCodec'] }
      )
    }
    audioCodec = raw.audioCodec as MediaAudioCodec
  }

  const videoBitrateKbps =
    raw.videoBitrateKbps !== undefined
      ? assertFiniteRange(raw.videoBitrateKbps, 'videoBitrateKbps', 32, 200_000, true)
      : undefined
  const audioBitrateKbps =
    raw.audioBitrateKbps !== undefined
      ? assertFiniteRange(raw.audioBitrateKbps, 'audioBitrateKbps', 16, 2_048, true)
      : undefined
  const frameRate =
    raw.frameRate !== undefined ? assertFiniteRange(raw.frameRate, 'frameRate', 1, 240) : undefined
  const audioSampleRateHz =
    raw.audioSampleRateHz !== undefined
      ? assertFiniteRange(raw.audioSampleRateHz, 'audioSampleRateHz', 8_000, 192_000, true)
      : undefined
  const audioChannels =
    raw.audioChannels !== undefined
      ? assertFiniteRange(raw.audioChannels, 'audioChannels', 1, 8, true)
      : undefined

  if (raw.extractAudioOnly !== undefined && typeof raw.extractAudioOnly !== 'boolean') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'extractAudioOnly must be a boolean',
      { fields: ['extractAudioOnly'] }
    )
  }
  if (raw.stripAudio !== undefined && typeof raw.stripAudio !== 'boolean') {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'stripAudio must be a boolean',
      { fields: ['stripAudio'] }
    )
  }

  const extractAudioOnly = raw.extractAudioOnly === true
  const stripAudio = raw.stripAudio === true
  const scale = raw.scale !== undefined ? validateScaleOption(raw.scale) : undefined
  const trim = raw.trim !== undefined ? validateTrimOption(raw.trim) : undefined
  const watermark = raw.watermark !== undefined ? validateWatermarkOption(raw.watermark) : undefined

  // 互斥冲突组合拦截
  if (extractAudioOnly && stripAudio) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'extractAudioOnly and stripAudio cannot both be true',
      { fields: ['extractAudioOnly', 'stripAudio'] }
    )
  }
  if (AUDIO_ONLY_CONTAINERS.has(container) && stripAudio) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      `Audio-only container "${container}" cannot be combined with stripAudio`,
      { fields: ['container', 'stripAudio'] }
    )
  }
  if (
    (extractAudioOnly || AUDIO_ONLY_CONTAINERS.has(container)) &&
    (videoCodec !== undefined ||
      videoBitrateKbps !== undefined ||
      frameRate !== undefined ||
      scale !== undefined ||
      watermark !== undefined)
  ) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'Video encoding/filter options cannot be combined with audio-only output',
      { fields: ['extractAudioOnly'] }
    )
  }
  if (
    stripAudio &&
    (audioCodec !== undefined ||
      audioBitrateKbps !== undefined ||
      audioSampleRateHz !== undefined ||
      audioChannels !== undefined)
  ) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'Audio encoding options cannot be combined with stripAudio',
      { fields: ['stripAudio'] }
    )
  }
  if (
    videoCodec === 'copy' &&
    (scale !== undefined || watermark !== undefined || videoBitrateKbps !== undefined || frameRate !== undefined)
  ) {
    throw createToolRuntimeError(
      TOOL_RUNTIME_ERROR_CODES.policyViolation,
      'videoCodec="copy" cannot be combined with video filters, bitrate, or frameRate',
      { fields: ['videoCodec'] }
    )
  }

  return {
    ...(raw.taskId !== undefined ? { taskId: raw.taskId } : {}),
    input: raw.input,
    output: raw.output,
    ...(raw.overwrite !== undefined ? { overwrite: raw.overwrite } : {}),
    container,
    ...(videoCodec !== undefined ? { videoCodec } : {}),
    ...(audioCodec !== undefined ? { audioCodec } : {}),
    ...(videoBitrateKbps !== undefined ? { videoBitrateKbps } : {}),
    ...(audioBitrateKbps !== undefined ? { audioBitrateKbps } : {}),
    ...(frameRate !== undefined ? { frameRate } : {}),
    ...(audioSampleRateHz !== undefined ? { audioSampleRateHz } : {}),
    ...(audioChannels !== undefined ? { audioChannels } : {}),
    ...(raw.extractAudioOnly !== undefined ? { extractAudioOnly: raw.extractAudioOnly } : {}),
    ...(raw.stripAudio !== undefined ? { stripAudio: raw.stripAudio } : {}),
    ...(scale !== undefined ? { scale } : {}),
    ...(trim !== undefined ? { trim } : {}),
    ...(watermark !== undefined ? { watermark } : {})
  }
}
