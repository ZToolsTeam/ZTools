/**
 * AI 视频补帧 (RIFE 60/120fps) 与画质超分增强业务逻辑层 (AiVideo Logic)
 */

import {
  callHostTransport,
  formatBytes,
  getRealFileSize,
  invokePluginService,
  isRealElectronHost,
  showRealItemInFolder
} from '../shared/native-ipc.js'
import {
  type ExampleImportRules,
  type ExampleImportedFile,
  pickExampleFolderFiles
} from '../shared/file-import.js'

export { formatBytes }

export interface AiVideoModelPreset {
  id: string
  title: string
  subtitle: string
  tag: string
  modelEngine: string
  defaultFps: '60fps' | '120fps' | 'source'
}

export interface AiVideoFileItem {
  id: string
  name: string
  path: string
  parentDir: string
  extension: string
  sizeBytes: number
  sourceFps: number
  sourceResolution: string
  outputSizeBytes?: number
  outputPath?: string
}

export interface AiVideoBatchConfig {
  modelId: string
  targetFps: '60fps' | '120fps' | 'source'
  targetResolution: '4k_2160p' | '2k_1440p' | '1080p_fhd'
  videoEncoder: 'hevc_nvenc' | 'h264' | 'av1'
  sceneChangeProtection: boolean
  outputDir?: string
}

export interface AiVideoProcessedItemResult {
  inputPath: string
  outputPath: string
  sizeBytes: number
  ok: boolean
  error?: string
}

export interface AiVideoBatchResult {
  ok: boolean
  processedCount: number
  modelId: string
  targetFps: string
  targetResolution: string
  videoEncoder: string
  totalOutputBytes: number
  outputs: AiVideoProcessedItemResult[]
  error?: string
  fromFallback?: boolean
}

function isStrictRealHost(hostOverride?: unknown): boolean {
  if (isRealElectronHost(hostOverride)) return true
  if (hostOverride !== undefined && hostOverride !== null) return true
  return false
}

export const FORBIDDEN_VIDEO_PATH = new RegExp('\\\\Windows\\\\System32|\\.\\.\\\\|\\.\\./', 'i')

export const AI_VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.avi', '.flv', '.webm', '.wmv', '.ts', '.m4v'] as const
export const AI_VIDEO_SUPPORTED_TEXT = '.mp4 / .mkv / .mov / .avi / .webm'

export const AI_VIDEO_IMPORT_RULES: ExampleImportRules = {
  extensions: AI_VIDEO_EXTENSIONS,
  maxDepth: 5,
  maxFiles: 500,
  excludeFile: name => /_(?:60fps|120fps|source)_(?:4k_2160p|2k_1440p|1080p_fhd)\.mp4$/i.test(name),
  forbiddenPath: FORBIDDEN_VIDEO_PATH
}

export const AI_VIDEO_MODELS: AiVideoModelPreset[] = [
  {
    id: 'rife-v4-6',
    title: 'RIFE v4.6 光流丝滑补帧 (24/30fps -> 60/120fps)',
    subtitle: '实时双向光流运动估计，消除低帧率视频卡顿并开启转场防果冻保护',
    tag: 'RIFE v4.6 补帧',
    modelEngine: 'rife-v4.6-ncnn-vulkan',
    defaultFps: '60fps'
  },
  {
    id: 'real-cugan-pro',
    title: 'Real-CUGAN 视频超分与线条锐化',
    subtitle: '专为动漫番剧、游戏录屏与演示视频打造的 2x/4x 时域稳定超分辨率模型',
    tag: 'Real-CUGAN 超分',
    modelEngine: 'realcugan-se-up2x-denoise2x',
    defaultFps: '60fps'
  },
  {
    id: 'basicvsr-plusplus',
    title: 'BasicVSR++ 多帧时域细节重建',
    subtitle: '利用前后双向多帧上下文特征聚合，恢复老旧模糊视频高频纹理细节',
    tag: 'BasicVSR++ 重建',
    modelEngine: 'basicvsr-plusplus-fp16',
    defaultFps: 'source'
  },
  {
    id: 'lowlight-video-denoise',
    title: '暗光视频智能时域降噪与动态范围拓展',
    subtitle: '消除夜间拍摄高 ISO 彩色噪点与频闪，提升暗部层次感',
    tag: '暗光智能降噪',
    modelEngine: 'fastdvdnet-hdr-vulkan',
    defaultFps: 'source'
  }
]

export function validateAiVideoPayload(config: Partial<AiVideoBatchConfig>): { valid: boolean; error?: string } {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'INVALID_CONFIG: 视频增强配置不能为空' }
  }
  if (!config.modelId || typeof config.modelId !== 'string') {
    return { valid: false, error: 'INVALID_MODEL: AI 视频模型标识不能为空' }
  }
  if (config.outputDir && FORBIDDEN_VIDEO_PATH.test(config.outputDir)) {
    return { valid: false, error: 'SECURITY_INTERCEPTED: 视频输出目录禁止指向系统核心目录或包含路径穿越' }
  }
  return { valid: true }
}

export type AiVideoQueueSnapshot = AiVideoFileItem[] & {
  scannedDirs: string[]
  files: AiVideoFileItem[]
  items: AiVideoFileItem[]
  models: AiVideoModelPreset[]
  error?: string
}

export function toAiVideoFileItem(file: ExampleImportedFile, index = 0): AiVideoFileItem {
  return {
    id: `ai-vid-${index}-${file.path}`,
    name: file.name,
    path: file.path,
    parentDir: file.parentDir,
    extension: file.extension || '.mp4',
    sizeBytes: file.sizeBytes ?? 0,
    sourceFps: 30,
    sourceResolution: '1920×1080'
  }
}

/**
 * 通过用户显式选择文件夹（window_show_select_folder_dialog + filesystem_get_directory_contents）导入待增强视频
 */
export async function fetchAiVideoQueue(hostOverride?: unknown): Promise<AiVideoQueueSnapshot> {
  const res = await pickExampleFolderFiles(
    AI_VIDEO_IMPORT_RULES,
    { title: '选择包含待增强视频的文件夹' },
    hostOverride
  )
  const files = res.files.map((f, idx) => toAiVideoFileItem(f, idx)).sort((a, b) => b.sizeBytes - a.sizeBytes)
  const scannedDirs = res.folderPath ? [res.folderPath] : []
  return Object.assign([...files], {
    scannedDirs,
    files,
    items: files,
    models: [...AI_VIDEO_MODELS],
    ...(res.error ? { error: res.error } : {})
  })
}

export const fetchAiVideoWorkspace = fetchAiVideoQueue

export async function executeAiVideoBatch(
  files: AiVideoFileItem[],
  config: AiVideoBatchConfig,
  hostOverride?: unknown
): Promise<AiVideoBatchResult> {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      processedCount: 0,
      modelId: config?.modelId || '',
      targetFps: config?.targetFps || '60fps',
      targetResolution: config?.targetResolution || '4k_2160p',
      videoEncoder: config?.videoEncoder || 'hevc_nvenc',
      totalOutputBytes: 0,
      outputs: [],
      error: 'EMPTY_QUEUE: 待增强视频队列不能为空'
    }
  }

  const check = validateAiVideoPayload(config)
  if (!check.valid) {
    return {
      ok: false,
      processedCount: 0,
      modelId: config.modelId,
      targetFps: config.targetFps,
      targetResolution: config.targetResolution,
      videoEncoder: config.videoEncoder,
      totalOutputBytes: 0,
      outputs: [],
      error: check.error
    }
  }

  for (const f of files) {
    if (!f?.path || FORBIDDEN_VIDEO_PATH.test(f.path)) {
      return {
        ok: false,
        processedCount: 0,
        modelId: config.modelId,
        targetFps: config.targetFps,
        targetResolution: config.targetResolution,
        videoEncoder: config.videoEncoder,
        totalOutputBytes: 0,
        outputs: [],
        error: 'SECURITY_INTERCEPTED: 视频路径不可包含系统受保护路径或路径穿越'
      }
    }
  }

  const strictReal = isStrictRealHost(hostOverride)
  const outputs: AiVideoProcessedItemResult[] = []
  let totalOutputBytes = 0
  let lastError = ''

  for (const f of files) {
    const outputDir = config.outputDir || f.parentDir || ''
    const defaultOutputPath = f.path.replace(
      /(\.[^.\\/]+)?$/,
      `_${config.targetFps}_${config.targetResolution}.mp4`
    )

    const pluginRes = await invokePluginService<Record<string, unknown>>(
      'AiVideoPlugin',
      'enhanceVideo',
      {
        inputPath: f.path,
        outputDir,
        modelId: config.modelId,
        targetFps: config.targetFps,
        targetResolution: config.targetResolution,
        videoEncoder: config.videoEncoder,
        sceneChangeProtection: config.sceneChangeProtection
      },
      hostOverride
    )

    if (pluginRes.ok && pluginRes.data?.ok !== false) {
      const data = pluginRes.data as Record<string, unknown> | undefined
      const resultsArr = Array.isArray(data?.results) ? (data.results as Array<Record<string, unknown>>) : null
      const itemRes = resultsArr && resultsArr.length > 0 ? resultsArr[0] : data
      const outPath =
        String(itemRes?.outputPath || itemRes?.path || itemRes?.filePath || data?.outputPath || data?.path || data?.filePath || '') ||
        defaultOutputPath
      let realSize = Number(itemRes?.outputBytes ?? itemRes?.sizeBytes ?? itemRes?.outputSizeBytes ?? itemRes?.size ?? 0)
      if (!Number.isFinite(realSize) || realSize <= 0) {
        realSize = await getRealFileSize(outPath, hostOverride)
      }
      if (realSize > 0) {
        f.outputSizeBytes = realSize
        f.outputPath = outPath
        totalOutputBytes += realSize
        outputs.push({ inputPath: f.path, outputPath: outPath, sizeBytes: realSize, ok: true })
        continue
      }
    }

    lastError = pluginRes.error || String(pluginRes.data?.error || '')
  }

  if (outputs.length > 0) {
    return {
      ok: true,
      processedCount: outputs.length,
      modelId: config.modelId,
      targetFps: config.targetFps,
      targetResolution: config.targetResolution,
      videoEncoder: config.videoEncoder,
      totalOutputBytes,
      outputs,
      fromFallback: false
    }
  }

  const ipcRes = await callHostTransport<Record<string, unknown>>(
    'ai_video_enhance_batch',
    { files: files.map(f => f.path), ...config },
    hostOverride
  )

  if (ipcRes.ok && ipcRes.data?.ok !== false) {
    const resultsArr = Array.isArray(ipcRes.data?.results) ? (ipcRes.data.results as Array<Record<string, unknown>>) : null
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const itemRes = resultsArr ? (resultsArr[i] ?? resultsArr[0]) : ipcRes.data
      const outPath =
        String(itemRes?.outputPath || ipcRes.data?.outputPath || '') ||
        f.path.replace(/(\.[^.\\/]+)?$/, `_${config.targetFps}_${config.targetResolution}.mp4`)
      const realSize =
        Number(
          itemRes?.outputBytes ??
            itemRes?.sizeBytes ??
            itemRes?.outputSizeBytes ??
            ipcRes.data?.sizeBytes ??
            ipcRes.data?.outputSizeBytes ??
            0
        ) || (await getRealFileSize(outPath, hostOverride))
      if (!strictReal || realSize > 0) {
        const finalSize = realSize > 0 ? realSize : f.sizeBytes
        totalOutputBytes += finalSize
        outputs.push({ inputPath: f.path, outputPath: outPath, sizeBytes: finalSize, ok: true })
      }
    }
    if (outputs.length > 0) {
      return {
        ok: true,
        processedCount: outputs.length,
        modelId: config.modelId,
        targetFps: config.targetFps,
        targetResolution: config.targetResolution,
        videoEncoder: config.videoEncoder,
        totalOutputBytes,
        outputs,
        fromFallback: false
      }
    }
  }

  const errMsg = lastError || ipcRes.error || 'AI_VIDEO_ENHANCE_FAILED: AI 视频补帧/超分引擎未能生成有效输出文件'
  return {
    ok: false,
    processedCount: 0,
    modelId: config.modelId,
    targetFps: config.targetFps,
    targetResolution: config.targetResolution,
    videoEncoder: config.videoEncoder,
    totalOutputBytes: 0,
    outputs: [],
    error: strictReal ? errMsg : '请在 ZTools 客户端中执行 AI 视频增强任务',
    fromFallback: false
  }
}

export const runAiVideoBatch = executeAiVideoBatch

export async function openAiVideoLocation(fullPath: string, hostOverride?: unknown): Promise<boolean> {
  if (!fullPath) return false
  return showRealItemInFolder(fullPath, hostOverride)
}
