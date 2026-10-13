const CREDENTIAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_CREDENTIAL_VALUE_BYTES = 64 * 1024

function credentialError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function requireCredentialKey(key) {
  if (typeof key !== 'string' || !CREDENTIAL_KEY_PATTERN.test(key)) {
    throw credentialError('INVALID_REQUEST', '凭据 key 格式无效')
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
    const messages = {
      INVALID_REQUEST: '凭据请求格式无效',
      PERMISSION_DENIED: '当前插件实例无权访问凭据',
      NOT_SUPPORTED: '宿主安全凭据存储不可用',
      FILE_TOO_LARGE: '凭据超过 64 KiB 上限',
      DATA_CORRUPT: '安全凭据记录损坏或无法解密',
      STORAGE_ERROR: '安全凭据读写失败'
    }
    throw credentialError(code, messages[code] || '宿主安全凭据操作失败')
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
    throw credentialError('INTERNAL_ERROR', '凭据存储状态响应无效')
  }

  async set(key, value) {
    requireCredentialKey(key)
    if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > MAX_CREDENTIAL_VALUE_BYTES) {
      throw credentialError('INVALID_REQUEST', '凭据必须是 64 KiB 以内的字符串')
    }
    const result = await this.call('credential_v1_set', { key, value })
    if (result !== 'OK') throw credentialError('INTERNAL_ERROR', '凭据写入结果无效')
    return true
  }

  async get(key) {
    requireCredentialKey(key)
    const result = await this.call('credential_v1_get', { key })
    if (isRecord(result) && result.status === 'missing') return null
    if (isRecord(result) && result.status === 'present' && typeof result.value === 'string' &&
        new TextEncoder().encode(result.value).byteLength <= MAX_CREDENTIAL_VALUE_BYTES) return result.value
    throw credentialError('DATA_CORRUPT', '凭据读取结果无效')
  }

  async delete(key) {
    requireCredentialKey(key)
    const result = await this.call('credential_v1_delete', { key })
    if (result !== 'OK') throw credentialError('INTERNAL_ERROR', '凭据删除结果无效')
    return true
  }

  async call(method, params) {
    try {
      return unwrapResponse(await this.transport.call(method, params))
    } catch (error) {
      if (typeof error?.code === 'string') {
        const messages = {
          INVALID_REQUEST: '凭据请求格式无效',
          PERMISSION_DENIED: '当前插件实例无权访问凭据',
          NOT_SUPPORTED: '宿主安全凭据存储不可用',
          FILE_TOO_LARGE: '凭据超过 64 KiB 上限',
          DATA_CORRUPT: '安全凭据记录损坏或无法解密',
          STORAGE_ERROR: '安全凭据读写失败'
        }
        throw credentialError(error.code, messages[error.code] || '宿主安全凭据操作失败')
      }
      throw credentialError('INTERNAL_ERROR', '宿主安全凭据操作失败')
    }
  }
}

/** Explicit namespace keeps the wire contract version visible to plugin authors. */
export default class CredentialsAPI {
  constructor(transport) {
    this.v1 = new CredentialStoreV1API(transport)
  }
}
