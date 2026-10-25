export type MediaParamGroup = '位置隐私' | '拍摄设备' | '曝光参数' | '视频流' | '音频流'

export interface MediaMetadataSummary {
  filePath: string
  fileName: string
  fileSize: number
  fileType: 'image' | 'video' | 'audio'
  hasExif: boolean
  hasGps: boolean
  gpsFormatted?: string
  gpsLatitude?: number
  gpsLongitude?: number
  deviceModel?: string
  dateTimeOriginal?: string
  isMediaVideo: boolean
}

export interface MediaParamItem {
  key: string
  label: string
  value: string
  group: MediaParamGroup
  extraHint?: string
}
