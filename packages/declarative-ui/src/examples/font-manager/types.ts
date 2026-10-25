export type LicenseType = 'free-commercial' | 'commercial-risk' | 'system-builtin' | 'unknown'
export type FontLicenseFilter = 'all' | 'free-commercial' | 'commercial-risk' | 'system'

export interface SystemFontInfo {
  uniqueId: string
  family: string
  chineseName?: string
  postScriptName?: string
  weight: string
  format: 'ttf' | 'otf' | 'ttc' | 'woff'
  filePath: string
  fileSize: number
  licenseType: LicenseType
  licenseName?: string
  licenseUrl?: string
  foundry?: string
  isSystemProtected?: boolean
}
