export type ProbeRegion = 'lan' | 'domestic' | 'global'

export interface ProbeNodeResult {
  id: string
  name: string
  host: string
  region: ProbeRegion
  regionLabel: string
  categoryDesc: string
  reachable: boolean
  latencyMs: number
  statusCode: number
}

export interface BandwidthResult {
  downloadMbps: number
  uploadMbps: number
  pingMs: number
  jitterMs: number
  localIp: string
  gatewayIp: string
}

export interface BandwidthListItem {
  id: string
  title: string
  subtitle: string
  progressRatio: number
  gradeTag: string
  valueText: string
}

export interface SpeedtestDiagnosticSummary {
  isOffline: boolean
  summaryText: string
  bandwidthItems: BandwidthListItem[]
  fullMarkdown: string
}
