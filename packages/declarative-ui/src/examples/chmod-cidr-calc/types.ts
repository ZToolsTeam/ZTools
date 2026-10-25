export type CalcMode = 'cidr' | 'chmod'

export interface CidrCalculationResult {
  input: string
  ipAddress: string
  prefixLength: number
  netmask: string
  wildcardMask: string
  networkAddress: string
  broadcastAddress: string
  firstUsableIp: string
  lastUsableIp: string
  totalHosts: number
  usableHosts: number
  netmaskBinary: string
  addressScope: string
  usageHint: string
}

export interface ChmodRoleBreakdown {
  role: 'Owner (u)' | 'Group (g)' | 'Others (o)'
  digit: number
  symbolic: string
  read: boolean
  write: boolean
  execute: boolean
}

export interface ChmodCalculationResult {
  octal: string
  symbolic: string
  lsSymbolic: string
  chmodCommand: string
  chmodRecursiveCommand: string
  isWorldWritable: boolean
  securityWarning?: string
  roles: ChmodRoleBreakdown[]
}
