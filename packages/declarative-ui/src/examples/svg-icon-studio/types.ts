export type SvgExportFormat = 'minified' | 'react-tsx' | 'vue-sfc' | 'data-uri'

export interface SvgOptimizeMetrics {
  originalBytes: number
  optimizedBytes: number
  savedBytes: number
  savedPercentage: number
  viewBox: string
  pathCount: number
  removedDangerousNodes: number
}

export interface SvgProcessResult {
  originalSvg: string
  optimizedSvg: string
  reactTsxCode: string
  vueSfcCode: string
  dataUri: string
  base64DataUri: string
  metrics: SvgOptimizeMetrics
}
