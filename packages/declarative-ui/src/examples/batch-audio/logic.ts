/**
 * 批量音频转换、响度标准化与音效工坊业务逻辑层 (BatchAudio 2.0 Logic)
 * 提供 12 大核心音频批处理能力，Windows 下通过 dllplugin_call 调用原生插件 batch-audio
 */

import {
  formatBytes,
  showRealItemInFolder
} from '../shared/native-ipc.js'
import {
  cloneCapabilityItems,
  filterCapabilityList,
  invokeValidatedDllCapability,
  validateCapabilityArgs
} from '../shared/capability-helpers.js'
import {
  type ExampleImportRules,
  type ExampleImportedFile,
  pickExampleFolderFiles
} from '../shared/file-import.js'

export { formatBytes } from '../shared/native-ipc.js'

export interface CapabilityActionItem {
  id: string
  title: string
  subtitle: string
  tag: string
  method: string
  params: Record<string, unknown>
  ffmpegFilter?: string
}

export interface NativeInvocationResult {
  ok: boolean
  pluginName: string
  method: string
  data?: unknown
  error?: string
  fromFallback?: boolean
}

export interface RealAudioFileItem {
  id: string
  name: string
  path: string
  parentDir: string
  extension: string
  sizeBytes: number
}

export const DLL_PLUGIN_NAME = 'BatchAudioPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp('\\\\Windows\\\\System32|\\.\\.\\\\|\\.\\./', 'i')
export const FORBIDDEN_REASON = '音频批处理输出路径不可指向系统受保护目录或包含路径穿越'

export const BATCH_AUDIO_EXTENSIONS = ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ogg', '.wma', '.opus', '.aiff'] as const
export const BATCH_AUDIO_SUPPORTED_TEXT = '.mp3 / .flac / .wav / .aac / .m4a / .ogg / .wma / .opus / .aiff'

export const BATCH_AUDIO_IMPORT_RULES: ExampleImportRules = {
  extensions: BATCH_AUDIO_EXTENSIONS,
  maxDepth: 5,
  maxFiles: 500,
  excludeFile: name => /_(?:ztools|out)\.[a-z0-9]+$/i.test(name),
  forbiddenPath: FORBIDDEN_TARGET_PATTERN
}

/**
 * 12 大核心音频处理模式
 */
export const AUDIO_WORKSHOP_MODES: CapabilityActionItem[] = [
  {
    id: 'audio-convert-mp3',
    title: '01. 批量格式转码为 MP3 (320kbps CBR)',
    subtitle: '全平台高音质兼容模式，完整保留 ID3v2 专辑封面与元数据标签',
    tag: 'MP3 320k',
    method: 'BatchConvertFormat',
    params: { format: 'mp3', bitrate: '320k', sampleRate: 44100 },
    ffmpegFilter: '-c:a libmp3lame -b:a 320k -ar 44100'
  },
  {
    id: 'audio-convert-flac',
    title: '02. 批量转码为无损 FLAC (Level 8)',
    subtitle: '母带级无损音频归档压缩，采样率与位深 100% 原样保持',
    tag: '无损 FLAC',
    method: 'BatchConvertFormat',
    params: { format: 'flac', compressionLevel: 8 },
    ffmpegFilter: '-c:a flac -compression_level 8'
  },
  {
    id: 'audio-loudnorm',
    title: '03. EBU R128 广播级响度标准化 (-16 LUFS)',
    subtitle: '自动平衡多首音频响度差异，防止破音失真 (Podcast/流媒体标准)',
    tag: 'R128 响度',
    method: 'BatchLoudnorm',
    params: { targetI: -16, targetTp: -1.5, targetLra: 11 },
    ffmpegFilter: '-af "loudnorm=I=-16:TP=-1.5:LRA=11"'
  },
  {
    id: 'audio-gain',
    title: '04. 固定音量分贝增益放大 (+3.5 dB)',
    subtitle: '针对录音音量偏小的会议/课程素材统一提升分贝增益',
    tag: '音量增益',
    method: 'BatchAdjustVolume',
    params: { gainDb: 3.5 },
    ffmpegFilter: '-af "volume=3.5dB"'
  },
  {
    id: 'audio-silence',
    title: '05. 首尾静音片段自动检测与切除 (-50dB)',
    subtitle: '基于 BatchAudioSilenceParser 自动剔除录音首尾空白静音段',
    tag: '切除静音',
    method: 'BatchTrimAudio',
    params: { stripSilence: true, thresholdDb: -50 },
    ffmpegFilter: '-af "silenceremove=start_periods=1:start_silence=0.3:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_silence=0.3:start_threshold=-50dB,areverse"'
  },
  {
    id: 'audio-trim-ends',
    title: '06. 音频去头去尾定时裁剪 (跳过首尾2秒)',
    subtitle: '批量去除固定片头播报或片尾版权提示音',
    tag: '去头去尾',
    method: 'BatchTrimDuration',
    params: { skipStartSec: 2, skipEndSec: 2 },
    ffmpegFilter: '-ss 00:00:02 -c:a copy'
  },
  {
    id: 'audio-fade',
    title: '07. 批量添加柔和淡入淡出过渡 (3秒)',
    subtitle: '为背景配乐与铃声添加平滑 afade 首尾过渡曲线',
    tag: '淡入淡出',
    method: 'BatchFadeInOut',
    params: { fadeInSec: 3, fadeOutSec: 3 },
    ffmpegFilter: '-af "afade=t=in:st=0:d=3,afade=t=out:st=180:d=3"'
  },
  {
    id: 'audio-eq-vocal',
    title: '08. 10 段频率均衡器 (EQ 人声与播客清晰增强)',
    subtitle: '衰减 100Hz 以下低频轰鸣，提升 3kHz 人声清晰度频段',
    tag: 'EQ 均衡器',
    method: 'BatchEqualizer',
    params: { preset: 'vocal_clarity', lowCutHz: 90, boost3kHzDb: 4 },
    ffmpegFilter: '-af "highpass=f=90,equalizer=f=3000:width_type=q:w=1.2:g=4"'
  },
  {
    id: 'audio-compressor',
    title: '09. 动态范围压缩器 (Compressor 防忽大忽小)',
    subtitle: '压制突发大音量峰值并抬升轻声细语细节',
    tag: '动态压缩',
    method: 'BatchCompressor',
    params: { thresholdDb: -18, ratio: 4, attackMs: 20, releaseMs: 250 },
    ffmpegFilter: '-af "acompressor=threshold=-18dB:ratio=4:attack=20:release=250"'
  },
  {
    id: 'audio-denoise',
    title: '10. AI 频谱背景降噪 (afftdn 空调/电流底噪消除)',
    subtitle: '基于 FFT 频谱滤波消除环境白噪音与麦克风底噪',
    tag: '频谱降噪',
    method: 'BatchDenoise',
    params: { noiseReductionDb: 14, noiseFloorDb: -45 },
    ffmpegFilter: '-af "afftdn=nr=14:nf=-45"'
  },
  {
    id: 'audio-merge',
    title: '11. 多音频轨道无缝拼接合并',
    subtitle: '按勾选顺序自动统一采样率并无缝合并为单一音频文件',
    tag: '无缝合并',
    method: 'BatchMergeAudio',
    params: { normalizeBeforeMerge: true },
    ffmpegFilter: '-filter_complex "concat=n=2:v=0:a=1"'
  },
  {
    id: 'audio-id3',
    title: '12. 批量音频 ID3v2 元数据与版权标签写入',
    subtitle: '统一写入艺术家、专辑名称、年份与发行版权签名',
    tag: 'ID3 标签',
    method: 'BatchWriteMetadata',
    params: { artist: 'ZTools Audio Studio', year: '2026' },
    ffmpegFilter: '-metadata artist="ZTools Audio Studio" -metadata date="2026"'
  }
]

export function getCapabilityItems(): CapabilityActionItem[] {
  return cloneCapabilityItems(AUDIO_WORKSHOP_MODES)
}

export function filterCapabilityItems(items: CapabilityActionItem[], query: string): CapabilityActionItem[] {
  return filterCapabilityList(items, query)
}

export function validateInvocationPayload(method: string, params: unknown): { valid: boolean; error?: string } {
  return validateCapabilityArgs(method, params, FORBIDDEN_TARGET_PATTERN, FORBIDDEN_REASON)
}

export async function invokeNativeCapability(
  method: string,
  params: Record<string, unknown>,
  hostBridge?: unknown
): Promise<NativeInvocationResult> {
  return invokeValidatedDllCapability(DLL_PLUGIN_NAME, method, params, FORBIDDEN_TARGET_PATTERN, FORBIDDEN_REASON, hostBridge)
}

export type AudioWorkspaceSnapshot = RealAudioFileItem[] & {
  scannedDirs: string[]
  files: RealAudioFileItem[]
  items: RealAudioFileItem[]
  presets: CapabilityActionItem[]
  error?: string
}

export function toRealAudioFileItem(file: ExampleImportedFile, index = 0): RealAudioFileItem {
  return {
    id: `aud-${index}-${file.path}`,
    name: file.name,
    path: file.path,
    parentDir: file.parentDir,
    extension: file.extension || '.mp3',
    sizeBytes: file.sizeBytes ?? 0
  }
}

/**
 * 通过用户显式选择文件夹（window_show_select_folder_dialog + filesystem_get_directory_contents）导入音频工作区
 */
export async function fetchRealAudioWorkspace(hostOverride?: unknown): Promise<AudioWorkspaceSnapshot> {
  const presets = getCapabilityItems()
  const res = await pickExampleFolderFiles(
    BATCH_AUDIO_IMPORT_RULES,
    { title: '选择包含音频文件的文件夹' },
    hostOverride
  )
  const files = res.files.map((f, idx) => toRealAudioFileItem(f, idx)).sort((a, b) => b.sizeBytes - a.sizeBytes)
  const scannedDirs = res.folderPath ? [res.folderPath] : []
  return Object.assign([...files], {
    scannedDirs,
    files,
    items: files,
    presets,
    ...(res.error ? { error: res.error } : {})
  })
}

export const scanLocalAudioQueue = fetchRealAudioWorkspace

export async function openAudioFileLocation(fullPath: string, hostOverride?: unknown): Promise<boolean> {
  if (!fullPath) return false
  return showRealItemInFolder(fullPath, hostOverride)
}
