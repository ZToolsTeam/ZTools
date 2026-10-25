export type OfficeExt = 'docx' | 'pptx' | 'xlsx'
export type SlimQualityPreset = 'balanced' | 'aggressive' | 'lossless'

export interface OfficeDocImage {
  name: string
  entryPath: string
  format: 'png' | 'jpeg' | 'webp' | 'gif' | 'emf' | 'wmf'
  originalSize: number
  estimatedSize: number
  savedPercent: number
  dimensions: string
}

export interface OfficeDocSummary {
  filePath: string
  fileName: string
  ext: OfficeExt
  originalSize: number
  estimatedSize: number
  savedPercent: number
  images: OfficeDocImage[]
  hasComments: boolean
  hasAuthorMetadata: boolean
}

export interface SlimOptions {
  quality: SlimQualityPreset
  cleanMetadata: boolean
  backupOriginal?: boolean
}

export interface VirtualOoxmlArchive {
  fileName: string
  entries: Record<string, Uint8Array | string>
  isEncryptedPackage?: boolean
}
