/**
 * AI 图像超分放大、人像/商品去背景与画质修复业务逻辑层 (AiImage Logic)
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

export interface AiImageEnginePreset {
  id: string
  title: string
  subtitle: string
  tag: string
  modelName: string
  defaultScale: '1x' | '2x' | '4x'
}

export interface AiImageFileItem {
  id: string
  name: string
  path: string
  parentDir: string
  extension: string
  sizeBytes: number
  width: number
  height: number
  outputSizeBytes?: number
  outputPath?: string
}

export interface AiImageBatchConfig {
  engineId: string
  taskMode?: string
  scaleFactor: '1x' | '2x' | '4x'
  denoiseStrength: 'light' | 'standard' | 'strong'
  outputFormat: 'png' | 'webp' | 'jpg'
  gpuAccel?: boolean
  outputDir?: string
}

export interface AiImageProcessedItemResult {
  inputPath: string
  outputPath: string
  sizeBytes: number
  ok: boolean
  error?: string
}

export interface AiImageBatchResult {
  ok: boolean
  processedCount: number
  engineId: string
  targetResolution: string
  outputFormat: string
  totalOutputBytes: number
  outputs: AiImageProcessedItemResult[]
  error?: string
  fromFallback?: boolean
}

function isStrictRealHost(hostOverride?: unknown): boolean {
  if (isRealElectronHost(hostOverride)) return true
  if (hostOverride !== undefined && hostOverride !== null) return true
  return false
}

export const FORBIDDEN_PATH_PATTERN = new RegExp('\\\\Windows\\\\System32|\\.\\.\\\\|\\.\\./', 'i')

export const AI_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp'] as const
export const AI_IMAGE_SUPPORTED_TEXT = '.png / .jpg / .jpeg / .webp / .bmp'

export const AI_IMAGE_IMPORT_RULES: ExampleImportRules = {
  extensions: AI_IMAGE_EXTENSIONS,
  maxDepth: 5,
  maxFiles: 500,
  excludeFile: name => /_(?:1x|2x|4x)\.(?:png|webp|jpg)$/i.test(name),
  forbiddenPath: FORBIDDEN_PATH_PATTERN
}

export const AI_IMAGE_ENGINES: AiImageEnginePreset[] = [
  {
    id: 'realesrgan-x4plus',
    title: 'Real-ESRGAN 通用画质超分增强',
    subtitle: '针对摄影照片、纹理细节与压缩伪影的高频重建超分辨率引擎',
    tag: 'Real-ESRGAN 超分',
    modelName: 'realesrgan-x4plus.onnx',
    defaultScale: '2x'
  },
  {
    id: 'anime4k-ultrasharp',
    title: 'Anime4K 动漫插画与二次元超分',
    subtitle: '专为线条锐化、色块抗锯齿与 UI 图标矢量级放大优化的极速模型',
    tag: 'Anime4K 插画',
    modelName: 'realesr-animevideov3.onnx',
    defaultScale: '4x'
  },
  {
    id: 'rmbg-1-4-matting',
    title: 'RMBG-1.4 智能发丝级抠图去背景',
    subtitle: '电商商品、人像发丝与透明物体边缘 Alpha 通道一键无损分离',
    tag: 'RMBG 智能抠图',
    modelName: 'bria-rmbg-1.4.onnx',
    defaultScale: '1x'
  },
  {
    id: 'codeformer-face',
    title: 'CodeFormer 人像五官修复与去模糊',
    subtitle: '针对老旧低清照片、失焦人像进行面部特征高保真复原',
    tag: 'CodeFormer 人像',
    modelName: 'codeformer-fidelity0.7.onnx',
    defaultScale: '2x'
  },
  {
    id: 'webp-smart-slim',
    title: '无损 WebP 智能感知瘦身压缩',
    subtitle: '保持 SSIM > 0.99 视觉质量的前提下缩减 60%~75% 图像体积',
    tag: 'WebP 智能瘦身',
    modelName: 'libwebp-smart-q85',
    defaultScale: '1x'
  }
]

export function estimateTargetResolution(width: number, height: number, scale: '1x' | '2x' | '4x'): string {
  const factor = scale === '4x' ? 4 : scale === '2x' ? 2 : 1
  const w = Math.max(1, Math.round(width * factor))
  const h = Math.max(1, Math.round(height * factor))
  return `${w}×${h}`
}

export function validateAiImagePayload(config: Partial<AiImageBatchConfig>): { valid: boolean; error?: string } {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'INVALID_CONFIG: 配置参数不能为空' }
  }
  const engineId = config.engineId || config.taskMode
  if (!engineId || typeof engineId !== 'string') {
    return { valid: false, error: 'INVALID_ENGINE: AI 视觉引擎标识不能为空' }
  }
  if (config.outputDir && FORBIDDEN_PATH_PATTERN.test(config.outputDir)) {
    return { valid: false, error: 'SECURITY_INTERCEPTED: 输出路径禁止指向系统目录或包含路径穿越' }
  }
  return { valid: true }
}

export type AiImageQueueSnapshot = AiImageFileItem[] & {
  scannedDirs: string[]
  files: AiImageFileItem[]
  items: AiImageFileItem[]
  engines: AiImageEnginePreset[]
  error?: string
}

export function toAiImageFileItem(file: ExampleImportedFile, index = 0): AiImageFileItem {
  const sizeBytes = file.sizeBytes ?? 0
  return {
    id: `ai-img-${index}-${file.path}`,
    name: file.name,
    path: file.path,
    parentDir: file.parentDir,
    extension: file.extension || '.png',
    sizeBytes,
    width: sizeBytes > 2 * 1024 * 1024 ? 1920 : 1280,
    height: sizeBytes > 2 * 1024 * 1024 ? 1080 : 720
  }
}

/**
 * 通过用户显式选择文件夹（window_show_select_folder_dialog + filesystem_get_directory_contents）导入待处理图像
 */
export async function fetchAiImageQueue(hostOverride?: unknown): Promise<AiImageQueueSnapshot> {
  const res = await pickExampleFolderFiles(
    AI_IMAGE_IMPORT_RULES,
    { title: '选择包含待处理图片的文件夹' },
    hostOverride
  )
  const files = res.files.map((f, idx) => toAiImageFileItem(f, idx)).sort((a, b) => b.sizeBytes - a.sizeBytes)
  const scannedDirs = res.folderPath ? [res.folderPath] : []
  return Object.assign([...files], {
    scannedDirs,
    files,
    items: files,
    engines: [...AI_IMAGE_ENGINES],
    ...(res.error ? { error: res.error } : {})
  })
}

export const fetchAiImageWorkspace = fetchAiImageQueue

export async function executeAiImageBatch(
  files: AiImageFileItem[],
  config: AiImageBatchConfig,
  hostOverride?: unknown
): Promise<AiImageBatchResult> {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      processedCount: 0,
      engineId: config?.engineId || config?.taskMode || '',
      targetResolution: '0×0',
      outputFormat: config?.outputFormat || 'png',
      totalOutputBytes: 0,
      outputs: [],
      error: 'EMPTY_QUEUE: 待处理图片队列不能为空'
    }
  }

  const check = validateAiImagePayload(config)
  const effectiveEngineId = config?.engineId || config?.taskMode || ''
  if (!check.valid) {
    return {
      ok: false,
      processedCount: 0,
      engineId: effectiveEngineId,
      targetResolution: '0×0',
      outputFormat: config?.outputFormat || 'png',
      totalOutputBytes: 0,
      outputs: [],
      error: check.error
    }
  }

  for (const f of files) {
    if (!f?.path || FORBIDDEN_PATH_PATTERN.test(f.path)) {
      return {
        ok: false,
        processedCount: 0,
        engineId: effectiveEngineId,
        targetResolution: '0×0',
        outputFormat: config.outputFormat,
        totalOutputBytes: 0,
        outputs: [],
        error: 'SECURITY_INTERCEPTED: 输入图片路径包含受保护系统目录或路径穿越'
      }
    }
  }

  const strictReal = isStrictRealHost(hostOverride)
  const first = files[0]
  const targetRes = estimateTargetResolution(first.width || 1920, first.height || 1080, config.scaleFactor)
  const outputs: AiImageProcessedItemResult[] = []
  let totalOutputBytes = 0
  let lastError = ''

  for (const f of files) {
    const outputDir = config.outputDir || f.parentDir || ''
    const defaultOutputPath = f.path.replace(/(\.[^.\\/]+)?$/, `_${config.scaleFactor}.${config.outputFormat}`)
    const numericScale = parseInt(String(config.scaleFactor), 10) || 2

    const pluginRes = await invokePluginService<Record<string, unknown>>(
      'AiImagePlugin',
      'processImage',
      {
        inputPath: f.path,
        outputDir,
        mode: effectiveEngineId,
        taskMode: effectiveEngineId,
        engineId: effectiveEngineId,
        scale: numericScale,
        scaleFactor: config.scaleFactor,
        outputFormat: config.outputFormat,
        denoiseStrength: config.denoiseStrength,
        gpuAccel: config.gpuAccel !== false
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
      if (realSize > 0 || itemRes?.ok === true || Boolean(itemRes?.outputPath) || data?.ok === true) {
        const finalSize = realSize > 0 ? realSize : f.sizeBytes
        f.outputSizeBytes = finalSize
        f.outputPath = outPath
        totalOutputBytes += finalSize
        outputs.push({ inputPath: f.path, outputPath: outPath, sizeBytes: finalSize, ok: true })
        continue
      }
    }

    lastError = pluginRes.error || String(pluginRes.data?.error || '')
  }

  if (outputs.length > 0) {
    return {
      ok: true,
      processedCount: outputs.length,
      engineId: effectiveEngineId,
      targetResolution: targetRes,
      outputFormat: config.outputFormat,
      totalOutputBytes,
      outputs,
      fromFallback: false
    }
  }

  const ipcRes = await callHostTransport<Record<string, unknown>>(
    'ai_image_process_batch',
    {
      files: files.map(f => f.path),
      ...config,
      mode: effectiveEngineId,
      taskMode: effectiveEngineId,
      engineId: effectiveEngineId,
      scale: parseInt(String(config.scaleFactor), 10) || 2
    },
    hostOverride
  )

  if (ipcRes.ok && ipcRes.data?.ok !== false) {
    const resultsArr = Array.isArray(ipcRes.data?.results) ? (ipcRes.data.results as Array<Record<string, unknown>>) : null
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const itemRes = resultsArr ? (resultsArr[i] ?? resultsArr[0]) : ipcRes.data
      const outPath =
        String(itemRes?.outputPath || '') ||
        f.path.replace(/(\.[^.\\/]+)?$/, `_${config.scaleFactor}.${config.outputFormat}`)
      const realSize =
        Number(itemRes?.outputBytes ?? itemRes?.sizeBytes ?? itemRes?.outputSizeBytes ?? 0) ||
        (await getRealFileSize(outPath, hostOverride)) ||
        f.sizeBytes
      totalOutputBytes += realSize
      outputs.push({ inputPath: f.path, outputPath: outPath, sizeBytes: realSize, ok: true })
    }
    return {
      ok: true,
      processedCount: outputs.length,
      engineId: effectiveEngineId,
      targetResolution: targetRes,
      outputFormat: config.outputFormat,
      totalOutputBytes,
      outputs,
      fromFallback: false
    }
  }

  if (strictReal) {
    const errMsg = lastError || ipcRes.error || 'AI_IMAGE_ENGINE_FAILED: AI 图像处理引擎调用失败或未生成有效输出文件'
    return {
      ok: false,
      processedCount: 0,
      engineId: effectiveEngineId,
      targetResolution: targetRes,
      outputFormat: config.outputFormat,
      totalOutputBytes: 0,
      outputs: [],
      error: errMsg,
      fromFallback: false
    }
  }

  return {
    ok: false,
    processedCount: 0,
    engineId: effectiveEngineId,
    targetResolution: targetRes,
    outputFormat: config.outputFormat,
    totalOutputBytes: 0,
    outputs: [],
    error: '请在 ZTools 客户端中执行 AI 图像推理任务',
    fromFallback: false
  }
}

export const runAiImageBatch = executeAiImageBatch

export async function openAiImageLocation(fullPath: string, hostOverride?: unknown): Promise<boolean> {
  if (!fullPath) return false
  return showRealItemInFolder(fullPath, hostOverride)
}
