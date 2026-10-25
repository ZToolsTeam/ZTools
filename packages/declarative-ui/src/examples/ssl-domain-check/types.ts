export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT'

export interface SslCertHealthReport {
  domain: string
  subjectCN: string
  issuerName: string
  validFromIso: string
  validToIso: string
  daysRemaining: number
  isExpired: boolean
  isExpiringSoon: boolean
  serialNumber: string
  fingerprint256: string
  subjectAltNames: string[]
  protocol: string
}

export interface DnsRecordEntry {
  name: string
  type: DnsRecordType
  ttl: number
  data: string
}
