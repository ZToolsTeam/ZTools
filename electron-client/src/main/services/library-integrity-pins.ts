import { errorCodes, ZToolsError } from '../../contracts/errors.js'

// Release-owned integrity anchor for the legacy official metadata response
// which currently omits its checksum. It grants no alternative URL or version.
const ffmpeg = Object.freeze({
  libId: 'ffmpeg-1.0.0',
  downloadUrl: 'https://cdn.ztools.cn/commonlibs-zip/ffmpeg-1.0.0.zip',
  fileSize: 47_751_326,
  checksum: 'f593065e3d9ea827de95b6b6fc0993a80144967fe0703da72ea946c644e85b7a'
})

export function resolvePinnedLibraryChecksum(metadata: {
  libId: string
  downloadUrl: string
  fileSize: number | null | undefined
  checksum: string
}): string {
  if (metadata.checksum !== '') return metadata.checksum
  if (metadata.libId === ffmpeg.libId && metadata.downloadUrl === ffmpeg.downloadUrl &&
      metadata.fileSize === ffmpeg.fileSize) return ffmpeg.checksum
  return metadata.checksum
}

/** 公共库下载元数据（尚未经过安装服务的校验） */
export interface RawLibraryMetadata {
  libId: unknown
  downloadUrl: unknown
  fileSize?: unknown
  checksum: unknown
}

/** 安装服务提供给元数据来源的受控读取能力：地址校验、重定向限制、超时与大小上限都由安装服务负责 */
export interface LibraryMetadataIo {
  readonly signal: AbortSignal
  /** GET 读取文本；HTTP 非 2xx 时 ok 为 false 且 text 为空（响应体已丢弃） */
  fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }>
}

/** 公共库元数据来源；没有可用来源时抛 NOT_SUPPORTED */
export interface LibraryMetadataSource {
  resolve(libId: string, io: LibraryMetadataIo): Promise<RawLibraryMetadata>
}

/**
 * 只使用随版本发布的内置完整性锚点（CDN 地址 + 大小 + SHA-256），不请求任何后台。
 * 开源版与没有后台地址的构建都用它；未内置的公共库一律不支持在线获取。
 */
export const pinnedLibraryMetadataSource: LibraryMetadataSource = Object.freeze({
  async resolve(libId: string): Promise<RawLibraryMetadata> {
    if (libId === ffmpeg.libId) return { ...ffmpeg }
    throw new ZToolsError(errorCodes.notSupported, `单机模式不支持在线获取公共库 ${libId}`)
  }
})
