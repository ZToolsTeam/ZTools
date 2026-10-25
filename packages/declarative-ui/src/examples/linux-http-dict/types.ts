export type DictCategory = 'linux' | 'http' | 'port'

export type LinuxCommandGroup = 'file' | 'text' | 'system' | 'net' | 'disk' | 'security'

export interface LinuxCommandItem {
  id: string
  name: string
  group: LinuxCommandGroup
  groupLabel: string
  description: string
  aliases: string[]
  stars: string
  package?: string
  params: Array<{ flag: string; desc: string }>
  examples: Array<{ title: string; cmd: string; note?: string }>
}

export interface HttpStatusItem {
  code: number
  phrase: string
  meaning: string
  rfc: string
  isRetryable: boolean
  causes: string[]
  troubleshooting: Array<{ step: string; action: string }>
  architectureNotes: string
}

export interface PortItem {
  port: number
  protocol: 'TCP' | 'UDP' | 'TCP/UDP'
  service: string
  category: string
  description: string
  securityNotice: string
}
