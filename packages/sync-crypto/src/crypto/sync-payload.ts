import { encryptAesGcm, decryptAesGcmString, type EncryptedPayload } from './aes-gcm.js'
import { tSync } from '../i18n.js'

export interface ConfigSyncData {
  schemaVersion: number
  updatedAt: string
  deviceId?: string
  settings: Record<string, unknown>
  triggers?: unknown[]
  plugins?: Record<string, unknown>
}

export interface ClipboardSyncItem {
  id: string
  type: 'text' | 'image' | 'files' | 'html'
  content: string
  metadata?: Record<string, unknown>
  timestamp: number
}

export interface ClipboardSyncData {
  schemaVersion: number
  updatedAt: string
  deviceId?: string
  items: ClipboardSyncItem[]
}

/**
 * 对应用全量配置进行端到端 AES-256-GCM 密文封包
 */
export function encryptConfigPayload(
  data: ConfigSyncData,
  key: Buffer,
  locale?: string
): EncryptedPayload {
  const jsonStr = JSON.stringify(data)
  const aad = `ztools:config:v${data.schemaVersion}:${data.updatedAt}`
  return encryptAesGcm(jsonStr, key, aad, locale)
}

/**
 * 解密并还原应用全量配置（强制校验 AAD 业务前缀 ztools:config:）
 */
export function decryptConfigPayload(
  payload: EncryptedPayload,
  key: Buffer,
  locale?: string
): ConfigSyncData {
  const jsonStr = decryptAesGcmString(payload, key, {
    locale,
    expectedAadPrefix: 'ztools:config:'
  })
  const data = JSON.parse(jsonStr) as ConfigSyncData
  if (typeof data !== 'object' || data === null || typeof data.schemaVersion !== 'number') {
    throw new Error(tSync('payload.invalidConfig', undefined, locale))
  }
  return data
}

/**
 * 对剪贴板历史密文进行端到端 AES-256-GCM 加密封包
 */
export function encryptClipboardPayload(
  data: ClipboardSyncData,
  key: Buffer,
  locale?: string
): EncryptedPayload {
  const jsonStr = JSON.stringify(data)
  const aad = `ztools:clipboard:v${data.schemaVersion}:${data.updatedAt}`
  return encryptAesGcm(jsonStr, key, aad, locale)
}

/**
 * 解密并还原剪贴板历史数据（强制校验 AAD 业务前缀 ztools:clipboard:）
 */
export function decryptClipboardPayload(
  payload: EncryptedPayload,
  key: Buffer,
  locale?: string
): ClipboardSyncData {
  const jsonStr = decryptAesGcmString(payload, key, {
    locale,
    expectedAadPrefix: 'ztools:clipboard:'
  })
  const data = JSON.parse(jsonStr) as ClipboardSyncData
  if (typeof data !== 'object' || data === null || !Array.isArray(data.items)) {
    throw new Error(tSync('payload.invalidClipboard', undefined, locale))
  }
  return data
}
