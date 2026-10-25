export type VaultCategory = 'login' | 'apikey' | 'server' | 'license'

export interface VaultEntry {
  id: string
  title: string
  category: VaultCategory
  categoryLabel: string
  username: string
  endpoint: string
  secretPlain: string
  note: string
  updatedAt: number
  updatedAtShort: string
}

export interface EncryptedVaultEnvelope {
  version: 1
  saltBase64: string
  ivBase64: string
  cipherTextBase64: string
}

export interface VaultNewEntryInput {
  title: string
  category: VaultCategory
  username?: string
  endpoint?: string
  secretPlain: string
  note?: string
}
