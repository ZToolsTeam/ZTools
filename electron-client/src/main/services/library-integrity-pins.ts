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
