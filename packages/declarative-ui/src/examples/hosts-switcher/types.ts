export interface HostRule {
  ip: string
  domain: string
  comment?: string
  isValid: boolean
  rawLine: string
}

export interface HostsProfile {
  id: string
  name: string
  isEnabled: boolean
  isSystem: boolean
  rawContent: string
  rulesCount: number
  invalidCount: number
  updatedAt: number
  updatedAtFormatted: string
}
