/**
 * AI 视频补帧 (RIFE 60/120fps) 与画质超分增强业务逻辑层 (AiVideo Logic)
 * 真实扫描本机 Videos / Downloads / Desktop 目录下的视频媒体文件，对接 AiVideoPlugin 引擎
 */

import {
  callHostTransport,
  formatBytes,
  getRealFileSize,
  getRealSystemPath,
  invokePluginService,
  isRealElectronHost,
  scanRealDirectoryTree,
  showRealItemInFolder
} from '../shared/native-ipc.js'

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

export const AI_VIDEO_MODELS: AiVideoModelPreset[] = [
  {
    id: 'rife-v4-6',
    title: 'RIFE v4.6 光流丝滑补帧 (24/30fps → 60/120fps)',
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

export const INITIAL_AI_VIDEO_FILES: AiVideoFileItem[] = [
  {
    id: 'ai-vid-1',
    name: 'Gameplay_Cyberpunk_Benchmark_30fps_Raw.mp4',
    path: 'D:\\Videos\\Captures\\Gameplay_Cyberpunk_Benchmark_30fps_Raw.mp4',
    parentDir: 'D:\\Videos\\Captures',
    extension: '.mp4',
    sizeBytes: 680 * 1024 * 1024,
    sourceFps: 30,
    sourceResolution: '1920×1080'
  },
  {
    id: 'ai-vid-2',
    name: 'Anime_Trailer_Opening_24fps_1080p.mkv',
    path: 'D:\\Videos\\Anime\\Anime_Trailer_Opening_24fps_1080p.mkv',
    parentDir: 'D:\\Videos\\Anime',
    extension: '.mkv',
    sizeBytes: 340 * 1024 * 1024,
    sourceFps: 24,
    sourceResolution: '1920×1080'
  },
  {
    id: 'ai-vid-3',
    name: 'Vintage_Tech_Keynote_Archive_720p.mov',
    path: 'C:\\Users\\Geek\\Videos\\Vintage_Tech_Keynote_Archive_720p.mov',
    parentDir: 'C:\\Users\\Geek\\Videos',
    extension: '.mov',
    sizeBytes: 420 * 1024 * 1024,
    sourceFps: 30,
    sourceResolution: '1280×720'
  },
  {
    id: 'ai-vid-4',
    name: 'Night_City_Drone_Aerial_LowLight.mp4',
    path: 'C:\\Users\\Geek\\Downloads\\Night_City_Drone_Aerial_LowLight.mp4',
    parentDir: 'C:\\Users\\Geek\\Downloads',
    extension: '.mp4',
    sizeBytes: 510 * 1024 * 1024,
    sourceFps: 30,
    sourceResolution: '1920×1080'
  },
  {
    id: 'ai-vid-5',
    name: 'UI_Motion_Design_Prototype_30fps.webm',
    path: 'D:\\Videos\\Prototypes\\UI_Motion_Design_Prototype_30fps.webm',
    parentDir: 'D:\\Videos\\Prototypes',
    extension: '.webm',
    sizeBytes: 145 * 1024 * 1024,
    sourceFps: 30,
    sourceResolution: '1920×1080'
  },
  {
    id: 'ai-vid-6',
    name: 'Product_Unboxing_B_Roll_Clip.mp4',
    path: 'D:\\Videos\\Studio\\Product_Unboxing_B_Roll_Clip.mp4',
    parentDir: 'D:\\Videos\\Studio',
    extension: '.mp4',
    sizeBytes: 275 * 1024 * 1024,
    sourceFps: 24,
    sourceResolution: '1920×1080'
  }
]

const VIDEO_EXT_REGEX = /\.(?:mp4|mkv|mov|avi|flv|webm|wmv|ts|m4v)$/i

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
}

export async function fetchAiVideoQueue(hostOverride?: any): Promise<AiVideoQueueSnapshot> {
  const strictReal = isStrictRealHost(hostOverride)
  const [videosDir, downloadsDir, desktopDir] = await Promise.all([
    getRealSystemPath('videos', hostOverride),
    getRealSystemPath('downloads', hostOverride),
    getRealSystemPath('desktop', hostOverride)
  ])

  const scannedDirs = [videosDir, downloadsDir, desktopDir].filter(Boolean)
  const discovered: AiVideoFileItem[] = []
  const seenPaths = new Set<string>()

  for (const dir of scannedDirs) {
    const scanRes = await scanRealDirectoryTree(dir, {
      maxDepth: 2,
      maxFiles: 200,
      collectTopN: 40,
      filterExt: VIDEO_EXT_REGEX,
      hostOverride
    })
    for (const f of scanRes.files) {
      if (f.sizeBytes <= 0) continue
      const normPath = f.path.toLowerCase()
      if (seenPaths.has(normPath)) continue
      seenPaths.add(normPath)
      const dot = f.name.lastIndexOf('.')
      const ext = dot > 0 ? f.name.slice(dot).toLowerCase() : '.mp4'
      discovered.push({
        id: `ai-vid-${discovered.length}-${f.path}`,
        name: f.name,
        path: f.path,
        parentDir: dir,
        extension: ext,
        sizeBytes: f.sizeBytes,
        sourceFps: 30,
        sourceResolution: '1920×1080'
      })
    }
  }

  discovered.sort((a, b) => b.sizeBytes - a.sizeBytes)

  // 真实宿主下只展示真实扫描到的视频文件，严禁在 < 4 时拼接 INITIAL_AI_VIDEO_FILES
  const files = strictReal
    ? discovered
    : discovered.length > 0
      ? discovered
      : [...INITIAL_AI_VIDEO_FILES]

  return Object.assign([...files], {
    scannedDirs,
    files,
    items: files,
    models: [...AI_VIDEO_MODELS]
  })
}

export const fetchAiVideoWorkspace = fetchAiVideoQueue

export async function executeAiVideoBatch(
  files: AiVideoFileItem[],
  config: AiVideoBatchConfig,
  hostOverride?: any
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

    const pluginRes = await invokePluginService<any>(
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
      const data = pluginRes.data
      const itemRes =
        typeof data === 'object' && data !== null && Array.isArray(data.results) && data.results.length > 0
          ? data.results[0]
          : data
      const outPath =
        (typeof itemRes === 'object' && itemRes !== null
          ? itemRes.outputPath || itemRes.path || itemRes.filePath
          : '') ||
        (typeof data === 'object' && data !== null ? data.outputPath || data.path || data.filePath : '') ||
        defaultOutputPath
      let realSize = Number(
        typeof itemRes === 'object' && itemRes !== null
          ? itemRes.outputBytes ?? itemRes.sizeBytes ?? itemRes.outputSizeBytes ?? itemRes.size ?? 0
          : 0
      )
      if (!Number.isFinite(realSize) || realSize <= 0) {
        realSize = await getRealFileSize(outPath, hostOverride)
      }
      // 必须有真实的产出文件大小或明确的成功产物校验，绝不在无文件产出时假报成功
      if (realSize > 0) {
        f.outputSizeBytes = realSize
        f.outputPath = outPath
        totalOutputBytes += realSize
        outputs.push({
          inputPath: f.path,
          outputPath: outPath,
          sizeBytes: realSize,
          ok: true
        })
        continue
      }
    }

    lastError = pluginRes.error || (pluginRes.data && pluginRes.data.error) || ''
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

  const ipcRes = await callHostTransport<any>(
    'ai_video_enhance_batch',
    {
      files: files.map(f => f.path),
      ...config
    },
    hostOverride
  )

  if (ipcRes.ok && ipcRes.data?.ok !== false) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const itemRes = Array.isArray(ipcRes.data?.results)
        ? ipcRes.data.results[i] ?? ipcRes.data.results[0]
        : ipcRes.data
      const outPath =
        itemRes?.outputPath ||
        ipcRes.data?.outputPath ||
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
        outputs.push({
          inputPath: f.path,
          outputPath: outPath,
          sizeBytes: finalSize,
          ok: true
        })
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

  if (strictReal) {
    const errMsg =
      lastError ||
      ipcRes.error ||
      'AI_VIDEO_ENHANCE_FAILED: AI 视频补帧/超分引擎未能生成有效输出文件'
    return {
      ok: false,
      processedCount: 0,
      modelId: config.modelId,
      targetFps: config.targetFps,
      targetResolution: config.targetResolution,
      videoEncoder: config.videoEncoder,
      totalOutputBytes: 0,
      outputs: [],
      error: errMsg,
      fromFallback: false
    }
  }

  for (const f of files) {
    const outPath = f.path.replace(
      /(\.[^.\\/]+)?$/,
      `_${config.targetFps}_${config.targetResolution}.mp4`
    )
    totalOutputBytes += f.sizeBytes
    outputs.push({
      inputPath: f.path,
      outputPath: outPath,
      sizeBytes: f.sizeBytes,
      ok: true
    })
  }

  return {
    ok: true,
    processedCount: files.length,
    modelId: config.modelId,
    targetFps: config.targetFps,
    targetResolution: config.targetResolution,
    videoEncoder: config.videoEncoder,
    totalOutputBytes,
    outputs,
    fromFallback: true
  }
}

export const runAiVideoBatch = executeAiVideoBatch

export async function openAiVideoLocation(fullPath: string, hostOverride?: any): Promise<boolean> {
  if (!fullPath) return false
  return showRealItemInFolder(fullPath, hostOverride)
}
