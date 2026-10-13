import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { JournalSealer } from './path-write-journal.js'

export interface AsyncKeySealer {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{ result: string }>
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('PATH_WRITE_JOURNAL_SEAL_TIMEOUT')), 30_000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

/** AES-GCM authenticates the entire ledger; an independently random key is sealed by the OS per snapshot. */
export function createJournalSealer(keys: AsyncKeySealer): JournalSealer {
  const available = async () => {
    if (!await bounded(keys.isAsyncEncryptionAvailable())) throw new Error('PATH_WRITE_JOURNAL_SEAL_UNAVAILABLE')
  }
  return {
    async seal(text) {
      if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('PATH_WRITE_JOURNAL_TOO_LARGE')
      await available()
      const key = randomBytes(32), nonce = randomBytes(12)
      try {
        const wrapped = await bounded(keys.encryptStringAsync(key.toString('base64')))
        if (!Buffer.isBuffer(wrapped) || !wrapped.length || wrapped.length > 65536) throw new Error('PATH_WRITE_JOURNAL_KEY_INVALID')
        const cipher = createCipheriv('aes-256-gcm', key, nonce)
        const header = Buffer.alloc(8); header.write('ZPJ1'); header.writeUInt32LE(wrapped.length, 4)
        cipher.setAAD(Buffer.concat([header, wrapped]))
        const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
        return Buffer.concat([header, wrapped, nonce, cipher.getAuthTag(), body])
      } finally { key.fill(0) }
    },
    async open(bytes) {
      if (!Buffer.isBuffer(bytes) || bytes.length < 37 || bytes.length > 4 * 1024 * 1024 || bytes.subarray(0, 4).toString('ascii') !== 'ZPJ1') throw new Error('PATH_WRITE_JOURNAL_INVALID')
      const length = bytes.readUInt32LE(4)
      if (!length || length > 65536 || length > bytes.length - 36) throw new Error('PATH_WRITE_JOURNAL_INVALID')
      await available()
      const sealed = await bounded(keys.decryptStringAsync(bytes.subarray(8, 8 + length)))
      const key = Buffer.from(sealed.result, 'base64')
      try {
        if (key.length !== 32 || key.toString('base64') !== sealed.result) throw new Error('PATH_WRITE_JOURNAL_KEY_INVALID')
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(8 + length, 20 + length))
        decipher.setAAD(bytes.subarray(0, 8 + length)); decipher.setAuthTag(bytes.subarray(20 + length, 36 + length))
        return Buffer.concat([decipher.update(bytes.subarray(36 + length)), decipher.final()]).toString('utf8')
      } finally { key.fill(0) }
    }
  }
}
