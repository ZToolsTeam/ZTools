import { safeStorage } from 'electron'
import type { CredentialProtection, CredentialProtectionStatus } from '../services/credential-protection.js'

/** No plaintext fallback is allowed for credentials. On Linux, basic_text is rejected. */
export const electronCredentialProtection: CredentialProtection = Object.freeze({
  async status(): Promise<CredentialProtectionStatus> {
    try {
      if (!await safeStorage.isAsyncEncryptionAvailable()) {
        return { status: 'unavailable', reason: 'encryption-unavailable' }
      }
      if (process.platform === 'linux') {
        const backend = safeStorage.getSelectedStorageBackend()
        if (backend === 'basic_text') return { status: 'unavailable', reason: 'insecure-backend' }
        if (backend === 'unknown') return { status: 'unavailable', reason: 'backend-unknown' }
      }
      return { status: 'available' }
    } catch {
      return { status: 'unavailable', reason: 'encryption-unavailable' }
    }
  },
  async encrypt(plaintext: string): Promise<Buffer> {
    return safeStorage.encryptStringAsync(plaintext)
  },
  async decrypt(ciphertext: Buffer): Promise<{ readonly plaintext: string; readonly shouldReEncrypt: boolean }> {
    const first = await safeStorage.decryptStringAsync(ciphertext)
    return { plaintext: first.result, shouldReEncrypt: first.shouldReEncrypt }
  }
})
