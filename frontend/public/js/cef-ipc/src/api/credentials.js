import { resolveSdkText } from '../core/environment.js'
const CREDENTIAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_CREDENTIAL_VALUE_BYTES = 64 * 1024


function getCredentialErrorMessage(code) {
  switch (code) {
    case 'INVALID_REQUEST':
      return resolveSdkText('凭据请求格式无效', 'Invalid credential request format')
    case 'PERMISSION_DENIED':
      return resolveSdkText('当前插件实例无权访问凭据', 'Current plugin instance does not have permission to access credentials')
    case 'NOT_SUPPORTED':
      return resolveSdkText('宿主安全凭据存储不可用', 'Host secure credential storage is unavailable')
    case 'FILE_TOO_LARGE':
      return resolveSdkText('凭据超过 64 KiB 上限', 'Credential exceeds the 64 KiB limit')
    case 'DATA_CORRUPT':
      return resolveSdkText('安全凭据记录损坏或无法解密', 'Secure credential record is corrupted or cannot be decrypted')
    case 'STORAGE_ERROR':
      return resolveSdkText('安全凭据读写失败', 'Failed to read or write secure credential storage')
    default:
      return resolveSdkText('宿主安全凭据操作失败', 'Host secure credential operation failed')
  }
}

function credentialError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function requireCredentialKey(key) {
  if (typeof key !== 'string' || !CREDENTIAL_KEY_PATTERN.test(key)) {
    throw credentialError('INVALID_REQUEST', resolveSdkText('凭据 key 格式无效', 'Invalid credential key format'))
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapResponse(response) {
  if (!isRecord(response) || !Object.hasOwn(response, 'success')) return response
  if (response.success !== true) {
    const error = isRecord(response.error) ? response.error : {}
    const code = typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR'
    throw credentialError(code, getCredentialErrorMessage(code))
  }
  return Object.hasOwn(response, 'data') ? response.data : response
}

/** Versioned, plugin-scoped OS credential store over the existing SDK transport. */
class CredentialStoreV1API {
  constructor(transport) {
    this.transport = transport
  }

  async status() {
    const result = await this.call('credential_v1_status', {})
    if (isRecord(result) && result.status === 'available') return { status: 'available' }
    if (isRecord(result) && result.status === 'unavailable' &&
        ['encryption-unavailable', 'insecure-backend', 'backend-unknown'].includes(result.reason)) {
      return { status: 'unavailable', reason: result.reason }
    }
    throw credentialError('INTERNAL_ERROR', resolveSdkText('凭据存储状态响应无效', 'Invalid credential store status response'))
  }

  async set(key, value) {
    requireCredentialKey(key)
    if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_CREDENTIAL_VALUE_BYTES) {
      throw credentialError('INVALID_REQUEST', resolveSdkText('凭据必须是 64 KiB 以内的字符串', 'Credential value must be a string within 64 KiB'))
    }
    const result = await this.call('credential_v1_set', { key, value })
    if (result !== 'OK') throw credentialError('INTERNAL_ERROR', resolveSdkText('凭据写入结果无效', 'Invalid credential write result'))
    return true
  }

  async get(key) {
    requireCredentialKey(key)
    const result = await this.call('credential_v1_get', { key })
    if (isRecord(result) && result.status === 'missing') return null
    if (isRecord(result) && result.status === 'present' && typeof result.value === 'string' &&
        new TextEncoder().encode(result.value).byteLength <= MAX_CREDENTIAL_VALUE_BYTES) return result.value
    throw credentialError('DATA_CORRUPT', resolveSdkText('凭据读取结果无效', 'Invalid credential read result'))
  }

  async delete(key) {
    requireCredentialKey(key)
    const result = await this.call('credential_v1_delete', { key })
    if (result !== 'OK') throw credentialError('INTERNAL_ERROR', resolveSdkText('凭据删除结果无效', 'Invalid credential delete result'))
    return true
  }

  async call(method, params) {
    try {
      return unwrapResponse(await this.transport.call(method, params))
    } catch (error) {
      if (typeof error?.code === 'string') {
        throw credentialError(error.code, getCredentialErrorMessage(error.code))
      }
      throw credentialError('INTERNAL_ERROR', getCredentialErrorMessage('INTERNAL_ERROR'))
    }
  }
}

/** Explicit namespace keeps the wire contract version visible to plugin authors. */
export default class CredentialsAPI {
  constructor(transport) {
    this.v1 = new CredentialStoreV1API(transport)
  }
}
