import { encryptAesGcm, decryptAesGcmString, type EncryptedPayload } from './aes-gcm.js'

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
  key: Buffer
): EncryptedPayload {
  const jsonStr = JSON.stringify(data)
  const aad = `ztools:config:v${data.schemaVersion}:${data.updatedAt}`
  return encryptAesGcm(jsonStr, key, aad)
}

/**
 * 解密并还原应用全量配置
 */
export function decryptConfigPayload(
  payload: EncryptedPayload,
  key: Buffer
): ConfigSyncData {
  const jsonStr = decryptAesGcmString(payload, key)
  const data = JSON.parse(jsonStr) as ConfigSyncData
  if (typeof data !== 'object' || data === null || typeof data.schemaVersion !== 'number') {
    throw new Error('解密后的配置数据格式无效')
  }
  return data
}

/**
 * 对剪贴板历史密文进行端到端 AES-256-GCM 加密封包
 */
export function encryptClipboardPayload(
  data: ClipboardSyncData,
  key: Buffer
): EncryptedPayload {
  const jsonStr = JSON.stringify(data)
  const aad = `ztools:clipboard:v${data.schemaVersion}:${data.updatedAt}`
  return encryptAesGcm(jsonStr, key, aad)
}

/**
 * 解密并还原剪贴板历史数据
 */
export function decryptClipboardPayload(
  payload: EncryptedPayload,
  key: Buffer
): ClipboardSyncData {
  const jsonStr = decryptAesGcmString(payload, key)
  const data = JSON.parse(jsonStr) as ClipboardSyncData
  if (typeof data !== 'object' || data === null || !Array.isArray(data.items)) {
    throw new Error('解密后的剪贴板数据格式无效')
  }
  return data
}
