export type CredentialProtectionStatus =
  | { readonly status: 'available' }
  | {
      readonly status: 'unavailable'
      readonly reason: 'encryption-unavailable' | 'insecure-backend' | 'backend-unknown'
    }

/** Main-process-only encryption port. Implementations must use an OS-backed secret store. */
export interface CredentialProtection {
  status(): Promise<CredentialProtectionStatus>
  encrypt(plaintext: string): Promise<Buffer>
  decrypt(ciphertext: Buffer): Promise<{ readonly plaintext: string; readonly shouldReEncrypt: boolean }>
}
