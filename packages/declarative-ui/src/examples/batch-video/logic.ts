/**
 * 批量视频转码、裁剪与动图工坊业务逻辑层 (BatchVideo 2.0 Logic)
 * 1:1 复刻 DLLPlugins/batch-video/BatchVideoPlugin/README.md 的 12 大核心视频批处理能力
 * 真实扫描本机 Videos / Downloads / Desktop 目录下的视频媒体文件，生成工业级 FFmpeg 管线参数
 */

import {
  formatBytes,
  getRealSystemPath,
  invokeDllPluginCapability,
  scanRealDirectoryTree,
  showRealItemInFolder
} from '../shared/native-ipc.js'

export { formatBytes } from '../shared/native-ipc.js'

export interface CapabilityActionItem {
  id: string
  title: string
  subtitle: string
  tag: string
  method: string
  params: Record<string, unknown>
  ffmpegArgs?: string
  ratioMultiplier?: number
}

export interface NativeInvocationResult {
  ok: boolean
  pluginName: string
  method: string
  data?: unknown
  error?: string
  fromFallback?: boolean
}

export interface RealVideoFileItem {
  id: string
  name: string
  path: string
  parentDir: string
  extension: string
  sizeBytes: number
  estimatedCompressedBytes: number
}

export const DLL_PLUGIN_NAME = 'BatchVideoPlugin'
export const FORBIDDEN_TARGET_PATTERN = new RegExp('\\\\Windows\\\\System32|\\.\\.\\\\|\\.\\./', 'i')
export const FORBIDDEN_REASON = '视频批处理输出路径不可指向系统受保护目录或包含路径穿越'

/**
 * 1:1 复刻 DLLPlugins/batch-video/BatchVideoPlugin/README.md 的 12 大视频批处理模式
 */
export const VIDEO_WORKSHOP_MODES: CapabilityActionItem[] = [
  {
    id: 'video-compress-crf23',
    title: '01. 视频画质智能瘦身 (H.264 CRF 23)',
    subtitle: '视觉无损压缩，平均减少 50%~65% 视频文件体积',
    tag: '画质压缩',
    method: 'BatchCompressVideo',
    params: { crf: 23, preset: 'medium', codec: 'libx264' },
    ffmpegArgs: '-c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k',
    ratioMultiplier: 0.42
  },
  {
    id: 'video-compress-hevc',
    title: '02. HEVC H.265 极限高压缩 (CRF 26)',
    subtitle: '新一代 H.265 编码，体积缩小至原视频 30% 左右',
    tag: 'HEVC瘦身',
    method: 'BatchCompressVideo',
    params: { crf: 26, preset: 'medium', codec: 'libx265' },
    ffmpegArgs: '-c:v libx265 -crf 26 -tag:v hvc1 -c:a aac -b:a 128k',
    ratioMultiplier: 0.30
  },
  {
    id: 'video-convert-mp4',
    title: '03. 多格式极速封装转标准 MP4',
    subtitle: '将 MKV/MOV/AVI/FLV/TS 统一转为全平台兼容 MP4 (+faststart)',
    tag: '格式转换',
    method: 'BatchConvertFormat',
    params: { format: 'mp4', faststart: true },
    ffmpegArgs: '-c:v copy -c:a aac -movflags +faststart',
    ratioMultiplier: 0.96
  },
  {
    id: 'video-crop-9-16',
    title: '04. 竖屏短视频画幅裁剪 (9:16 居中)',
    subtitle: '适配抖音/视频号/Reels/Shorts 竖屏中心构图自动裁剪',
    tag: '9:16 竖屏',
    method: 'BatchCropByRatio',
    params: { ratio: '9:16' },
    ffmpegArgs: '-vf "crop=ih*9/16:ih:(iw-ow)/2:0" -c:v libx264 -crf 22',
    ratioMultiplier: 0.55
  },
  {
    id: 'video-crop-1-1',
    title: '05. 正方形/宽银幕画幅裁剪 (1:1 / 16:9)',
    subtitle: '去除上下黑边或裁剪为社交媒体 1:1 方形画幅',
    tag: '1:1 裁剪',
    method: 'BatchCropByRatio',
    params: { ratio: '1:1' },
    ffmpegArgs: '-vf "crop=min(iw\\,ih):min(iw\\,ih)" -c:v libx264 -crf 22',
    ratioMultiplier: 0.60
  },
  {
    id: 'video-trim-ends',
    title: '06. 批量去片头片尾裁剪 (跳过首尾3秒)',
    subtitle: '自动切除固定片头广告与片尾定格贴片',
    tag: '去头去尾',
    method: 'BatchTrimDuration',
    params: { skipStartSec: 3, skipEndSec: 3 },
    ffmpegArgs: '-ss 00:00:03 -c:v libx264 -crf 22 -c:a copy',
    ratioMultiplier: 0.88
  },
  {
    id: 'video-to-gif',
    title: '07. 高清全局调色板 GIF 动图导出',
    subtitle: '双通道 palettegen + paletteuse 生成无噪点高清 GIF 动图',
    tag: '转 GIF',
    method: 'BatchConvertToGif',
    params: { fps: 15, width: 480 },
    ffmpegArgs: '-vf "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse"',
    ratioMultiplier: 0.25
  },
  {
    id: 'video-watermark',
    title: '08. 九宫格防盗版图片/文字水印合成',
    subtitle: '支持左上/右上/左下/右下/居中/平铺锚点透明度合成',
    tag: '批量水印',
    method: 'BatchAddWatermark',
    params: { position: 'bottom-right', opacity: 0.85 },
    ffmpegArgs: '-vf "drawtext=text=\'ZTools Media\':x=w-tw-24:y=h-th-24:fontsize=24:fontcolor=white@0.85"',
    ratioMultiplier: 0.92
  },
  {
    id: 'video-scale-1080p',
    title: '09. 分辨率尺寸标准化 (统一 1080P / 720P)',
    subtitle: '将 4K 大体积素材统一缩放为 1920×1080 标准全高清',
    tag: '尺寸缩放',
    method: 'BatchResizeResolution',
    params: { width: 1920, height: 1080 },
    ffmpegArgs: '-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2"',
    ratioMultiplier: 0.48
  },
  {
    id: 'video-speed-1-5x',
    title: '10. 视频与音轨同步倍速调整 (1.5x 倍速)',
    subtitle: 'setpts 视频加速配合 atempo 音频变调补偿',
    tag: '倍速调整',
    method: 'BatchChangeSpeed',
    params: { speed: 1.5 },
    ffmpegArgs: '-vf "setpts=0.6667*PTS" -af "atempo=1.5"',
    ratioMultiplier: 0.67
  },
  {
    id: 'video-rotate-flip',
    title: '11. 画面水平镜像翻转与 90° 旋转校正',
    subtitle: '一键批量纠正手机横竖颠倒录制素材或水平镜像',
    tag: '旋转翻转',
    method: 'BatchRotateFlip',
    params: { flip: 'horizontal', rotate: 0 },
    ffmpegArgs: '-vf "hflip" -c:a copy',
    ratioMultiplier: 0.90
  },
  {
    id: 'video-extract-audio',
    title: '12. 音轨无损提取与静音轨移除 (转 MP3 320k)',
    subtitle: '剥离视频画面提取高品质 MP3/AAC 独立音频文件',
    tag: '音轨提取',
    method: 'BatchExtractAudio',
    params: { audioFormat: 'mp3', bitrate: '320k' },
    ffmpegArgs: '-vn -c:a libmp3lame -b:a 320k',
    ratioMultiplier: 0.08
  }
]

export function getCapabilityItems(): CapabilityActionItem[] {
  return VIDEO_WORKSHOP_MODES.map(item => ({
    ...item,
    params: { ...item.params }
  }))
}

export function filterCapabilityItems(items: CapabilityActionItem[], query: string): CapabilityActionItem[] {
  if (!Array.isArray(items)) return []
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return items
  return items.filter(item => {
    if (!item || typeof item.title !== 'string') return false
    return (
      item.title.toLowerCase().includes(q) ||
      item.subtitle.toLowerCase().includes(q) ||
      item.tag.toLowerCase().includes(q) ||
      item.method.toLowerCase().includes(q)
    )
  })
}

export function validateInvocationPayload(method: string, params: unknown): { valid: boolean; error?: string } {
  if (typeof method !== 'string' || method.trim().length === 0) {
    return { valid: false, error: 'INVALID_METHOD: 调用方法名不能为空' }
  }
  if (method.length > 128 || !/^[A-Za-z0-9_]+$/.test(method.trim())) {
    return { valid: false, error: 'INVALID_METHOD_FORMAT: 方法名包含非法字符或超长' }
  }
  if (params === null || params === undefined || typeof params !== 'object' || Array.isArray(params)) {
    return { valid: false, error: 'INVALID_PARAMS: 参数必须为非空对象' }
  }

  const record = params as Record<string, unknown>
  for (const [key, val] of Object.entries(record)) {
    if (typeof val === 'string') {
      if (val.length > 4096) {
        return { valid: false, error: `PARAM_TOO_LONG: 参数 ${key} 超过最大长度限制` }
      }
      if (FORBIDDEN_TARGET_PATTERN.test(val)) {
        return { valid: false, error: `SECURITY_INTERCEPTED: ${FORBIDDEN_REASON}` }
      }
    } else if (typeof val === 'number') {
      if (!Number.isFinite(val) || val < -1000 || val > 100_000_000) {
        return { valid: false, error: `PARAM_OUT_OF_RANGE: 数值参数 ${key} 越界或非有限数` }
      }
    }
  }

  return { valid: true }
}

export async function invokeNativeCapability(
  method: string,
  params: Record<string, unknown>,
  hostBridge?: any
): Promise<NativeInvocationResult> {
  const check = validateInvocationPayload(method, params)
  if (!check.valid) {
    throw new Error(check.error || '参数校验失败')
  }
  const res = await invokeDllPluginCapability(DLL_PLUGIN_NAME, method, params, hostBridge)
  return {
    ok: res.ok,
    pluginName: DLL_PLUGIN_NAME,
    method: method.trim(),
    data: res.data ?? undefined,
    error: res.error,
    fromFallback: res.fromFallback
  }
}

const VIDEO_EXT_REGEX = /\.(?:mp4|mkv|mov|avi|flv|webm|wmv|ts|m4v|gif)$/i

export type VideoWorkspaceSnapshot = RealVideoFileItem[] & {
  scannedDirs: string[]
  files: RealVideoFileItem[]
  items: RealVideoFileItem[]
  presets: CapabilityActionItem[]
}

/**
 * 深度扫描本机 Videos / Downloads / Desktop 目录下的真实视频文件
 * 严禁回退扫描非视频文件充当视频，严禁在真实宿主下拼接 INITIAL_SAMPLE_VIDEOS
 */
export async function fetchRealVideoWorkspace(hostOverride?: any): Promise<VideoWorkspaceSnapshot> {
  const [videosDir, downloadsDir, desktopDir] = await Promise.all([
    getRealSystemPath('videos', hostOverride),
    getRealSystemPath('downloads', hostOverride),
    getRealSystemPath('desktop', hostOverride)
  ])

  const scannedDirs = [videosDir, downloadsDir, desktopDir].filter(Boolean)
  const files: RealVideoFileItem[] = []
  const seenPaths = new Set<string>()

  for (const dir of scannedDirs) {
    const videoScan = await scanRealDirectoryTree(dir, {
      maxDepth: 2,
      maxFiles: 250,
      collectTopN: 40,
      filterExt: VIDEO_EXT_REGEX,
      hostOverride
    })
    for (const f of videoScan.files) {
      if (f.sizeBytes <= 0) continue
      if (!VIDEO_EXT_REGEX.test(f.name)) continue
      const normPath = f.path.toLowerCase()
      if (seenPaths.has(normPath)) continue
      seenPaths.add(normPath)
      const dot = f.name.lastIndexOf('.')
      const ext = dot > 0 ? f.name.slice(dot).toLowerCase() : '.mp4'
      files.push({
        id: `vid-${files.length}-${f.path}`,
        name: f.name,
        path: f.path,
        parentDir: dir,
        extension: ext,
        sizeBytes: f.sizeBytes,
        estimatedCompressedBytes: Math.round(f.sizeBytes * 0.42)
      })
    }
  }

  files.sort((a, b) => b.sizeBytes - a.sizeBytes)
  const presets = getCapabilityItems()

  return Object.assign([...files], {
    scannedDirs,
    files,
    items: files,
    presets
  })
}

export const scanLocalVideoQueue = fetchRealVideoWorkspace

export async function openVideoFileLocation(fullPath: string, hostOverride?: any): Promise<boolean> {
  if (!fullPath) return false
  return showRealItemInFolder(fullPath, hostOverride)
}
