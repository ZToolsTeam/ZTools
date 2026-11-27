import crypto from 'node:crypto'
import { tSync } from '../i18n.js'

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
  aad?: string | Buffer,
  locale?: string
): EncryptedPayload {
  if (key.length !== 32) {
    throw new Error(tSync('aesGcm.invalidKeyLength', { length: key.length }, locale))
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

export interface DecryptAesGcmOptions {
  /**
   * 显式指定错误文案语言（覆盖运行时默认语言）
   */
  locale?: string
  /**
   * 预期 AAD 业务前缀（提供时强制校验 payload.aad 非空且 UTF-8 解码后以此开头，防止跨业务密文混淆）
   */
  expectedAadPrefix?: string
}

function resolveDecryptOptions(
  localeOrOptions?: string | DecryptAesGcmOptions,
  expectedAadPrefix?: string
): DecryptAesGcmOptions {
  if (typeof localeOrOptions === 'object' && localeOrOptions !== null) {
    return {
      locale: localeOrOptions.locale,
      expectedAadPrefix: expectedAadPrefix ?? localeOrOptions.expectedAadPrefix
    }
  }
  return {
    locale: localeOrOptions,
    expectedAadPrefix
  }
}

/**
 * 采用 AES-256-GCM 对密文进行认证解密
 * 包含完整的消息认证码校验（防重放与防篡改）以及可选的 AAD 业务前缀校验
 * @param payload 加密封包
 * @param key 32 字节 (256-bit) 对称密钥
 * @param localeOrOptions 语言标识或解密选项对象
 * @param expectedAadPrefix 可选预期 AAD 业务前缀（向后兼容末尾参数形式）
 */
export function decryptAesGcm(
  payload: EncryptedPayload,
  key: Buffer,
  localeOrOptions?: string | DecryptAesGcmOptions,
  expectedAadPrefix?: string
): Buffer {
  const { locale, expectedAadPrefix: aadPrefix } = resolveDecryptOptions(
    localeOrOptions,
    expectedAadPrefix
  )

  if (key.length !== 32) {
    throw new DecryptionError(tSync('aesGcm.invalidKeyLength', { length: key.length }, locale))
  }

  if (payload.algorithm !== 'aes-256-gcm' || payload.version !== 1) {
    throw new DecryptionError(
      tSync(
        'aesGcm.unsupportedAlgorithm',
        {
          algorithm: String(payload.algorithm),
          version: String(payload.version)
        },
        locale
      )
    )
  }

  try {
    const iv = Buffer.from(payload.iv, 'base64')
    const tag = Buffer.from(payload.tag, 'base64')
    const ciphertext = Buffer.from(payload.ciphertext, 'base64')

    if (iv.length !== 12) {
      throw new DecryptionError(tSync('aesGcm.invalidIvLength', { length: iv.length }, locale))
    }
    if (tag.length !== 16) {
      throw new DecryptionError(tSync('aesGcm.invalidTagLength', { length: tag.length }, locale))
    }

    let aadBuf: Buffer | undefined
    if (aadPrefix !== undefined) {
      if (typeof payload.aad !== 'string' || payload.aad.length === 0) {
        throw new DecryptionError(
          tSync('aesGcm.missingExpectedAad', { prefix: aadPrefix }, locale)
        )
      }
      aadBuf = Buffer.from(payload.aad, 'base64')
      if (!aadBuf.toString('utf8').startsWith(aadPrefix)) {
        throw new DecryptionError(
          tSync('aesGcm.missingExpectedAad', { prefix: aadPrefix }, locale)
        )
      }
    } else if (payload.aad !== undefined) {
      aadBuf = Buffer.from(payload.aad, 'base64')
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)

    if (aadBuf !== undefined) {
      decipher.setAAD(aadBuf)
    }

    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return plaintext
  } catch (error) {
    if (error instanceof DecryptionError) {
      throw error
    }
    throw new DecryptionError(tSync('aesGcm.decryptionFailed', undefined, locale), error)
  }
}

/**
 * 快捷解密为 UTF-8 字符串
 */
export function decryptAesGcmString(
  payload: EncryptedPayload,
  key: Buffer,
  localeOrOptions?: string | DecryptAesGcmOptions,
  expectedAadPrefix?: string
): string {
  return decryptAesGcm(payload, key, localeOrOptions, expectedAadPrefix).toString('utf8')
}
