/**
 * checksum.ts
 * Cryptographic checksum utilities
 */

import crypto from 'node:crypto'
import fs from 'node:fs'

export class ChecksumHelper {
  static sha256(data: string | Buffer | null | undefined): string | null {
    if (data === null || data === undefined) return null
    return crypto.createHash('sha256').update(data).digest('hex')
  }

  static sha256File(filePath: string): string | null {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return null
    const buf = fs.readFileSync(filePath)
    return ChecksumHelper.sha256(buf)
  }
}
