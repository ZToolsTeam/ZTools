export type MonitorProtocol = 'wmi' | 'ddcci' | 'apple' | 'unsupported'

export type MonitorFilterValue = 'all' | 'ddcci' | 'internal'

export interface MonitorDisplayInfo {
  id: string
  name: string
  isPrimary: boolean
  protocol: MonitorProtocol
  protocolLabel: string
  brightness: number | null
  contrast: number | null
  resolution: string
  scaleFactor: number
  supportsBrightness: boolean
}

export interface MonitorScanResult {
  ok: boolean
  displays: MonitorDisplayInfo[]
  error?: string
}

export interface MonitorActionResult {
  ok: boolean
  id?: string
  brightness?: number
  updatedDisplays?: MonitorDisplayInfo[]
  errorCode?: string
  error?: string
}
