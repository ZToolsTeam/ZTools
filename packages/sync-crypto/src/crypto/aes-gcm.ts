import crypto from 'node:crypto'

export interface EncryptedPayload {
  version: 1
  algorithm: 'aes-256-gcm'
  ciphertext: string // base64
  iv: string // base64
  tag: string // base64
  aad?: string // base64
}

export class DecryptionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'DecryptionError'
  }
}

/**
 * 采用 AES-256-GCM 对明文进行端到端高强度认证加密
 * @param plaintext 明文字符串或 Buffer
 * @param key 32 字节 (256-bit) 强对称密钥
 * @param aad 可选的附加认证数据 (Additional Authenticated Data)
 */
export function encryptAesGcm(
  plaintext: string | Buffer,
  key: Buffer,
  aad?: string | Buffer
): EncryptedPayload {
  if (key.length !== 32) {
    throw new Error(`AES-256-GCM 密钥长度必须为 32 字节，当前为 ${key.length} 字节`)
  }

  const plainBuf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8')
  // 随机生成 12 字节 (96-bit) 密码学强随机 IV
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)

  let aadBuf: Buffer | undefined
  if (aad !== undefined) {
    aadBuf = Buffer.isBuffer(aad) ? aad : Buffer.from(aad, 'utf8')
    cipher.setAAD(aadBuf)
  }

  const ciphertext = Buffer.concat([cipher.update(plainBuf), cipher.final()])
  const tag = cipher.getAuthTag()

  const payload: EncryptedPayload = {
    version: 1,
    algorithm: 'aes-256-gcm',
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64')
  }

  if (aadBuf !== undefined) {
    payload.aad = aadBuf.toString('base64')
  }

  return payload
}

/**
 * 采用 AES-256-GCM 对密文进行认证解密
 * 包含完整的消息认证码校验（防重放与防篡改）
 * @param payload 加密封包
 * @param key 32 字节 (256-bit) 对称密钥
 */
export function decryptAesGcm(
  payload: EncryptedPayload,
  key: Buffer
): Buffer {
  if (key.length !== 32) {
    throw new DecryptionError(`AES-256-GCM 密钥长度必须为 32 字节，当前为 ${key.length} 字节`)
  }

  if (payload.algorithm !== 'aes-256-gcm' || payload.version !== 1) {
    throw new DecryptionError(`不支持的加密算法或封包版本: ${payload.algorithm} v${payload.version}`)
  }

  try {
    const iv = Buffer.from(payload.iv, 'base64')
    const tag = Buffer.from(payload.tag, 'base64')
    const ciphertext = Buffer.from(payload.ciphertext, 'base64')

    if (iv.length !== 12) {
      throw new DecryptionError(`无效的 IV 长度: ${iv.length} 字节`)
    }
    if (tag.length !== 16) {
      throw new DecryptionError(`无效的认证标签 Tag 长度: ${tag.length} 字节`)
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    if (payload.aad !== undefined) {
      const aadBuf = Buffer.from(payload.aad, 'base64')
      decipher.setAAD(aadBuf)
    }

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw error
    }
    throw new DecryptionError('AES-256-GCM 认证解密失败：密文被篡改、密钥不匹配或数据损坏', error)
  }
}

/**
 * 快捷解密为 UTF-8 字符串
 */
export function decryptAesGcmString(
  payload: EncryptedPayload,
  key: Buffer
): string {
  return decryptAesGcm(payload, key).toString('utf8')
}
