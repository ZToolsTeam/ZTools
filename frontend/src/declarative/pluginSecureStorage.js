/**
 * 每个声明式插件自己的 SecureStorage 与 terminateProcess 实现（加载插件时按插件绑定）。
 *
 * - 全部经插件专属通道调用宿主（自动带会话令牌），主进程按会话归属分区；
 * - SecureStorage 底层是 credential_v1_*（Electron safeStorage 加密、按插件单独开库、信封绑定 pluginId+key）；
 *   加密不可用时报错，绝不回落为明文、浏览器 localStorage 或内存；
 * - 防的是「磁盘 / 备份 / 其他本机程序读到明文」，不防同一宿主里的其他 ZTools 插件。
 */
import { ZToolsHostError, assertSecureStorageKey, SECURE_STORAGE_MAX_VALUE_BYTES } from '@ztools/declarative-ui'
import { callHostMethod } from './hostMethods.js'
import { readPlaintextEntry, removePlaintextEntry } from '../utils/pluginStorage.js'

const UNAVAILABLE_REASONS = new Set(['encryption-unavailable', 'insecure-backend', 'backend-unknown'])
const UNSUPPORTED_CODES = new Set(['HOST_METHOD_UNAVAILABLE', 'METHOD_NOT_FOUND'])
const PROCESS_DEFAULT_TIMEOUT_MS = { graceful: 3_000, force: 2_000 }
/** 首次使用钥匙串时系统可能弹出授权框等待用户确认（实测新实例首次访问超过 10 秒），凭据调用放宽 IPC 超时 */
const CREDENTIAL_IPC_TIMEOUT_MS = 60_000
/** 宿主内部等待进程退出之外，快照与信号还要一点时间 */
const PROCESS_IPC_GRACE_MS = 5_000

function hostError(error, fallbackCode = 'HOST_METHOD_FAILED') {
  if (error instanceof ZToolsHostError) return error
  const code = UNSUPPORTED_CODES.has(error?.code) ? 'HOST_FEATURE_UNAVAILABLE' : (error?.code || fallbackCode)
  return new ZToolsHostError(code, error?.message || String(error), error?.details)
}

function stableJson(value) {
  return JSON.stringify(value)
}

/**
 * @param {{ pluginId: string, methods?: object | null, call?: typeof callHostMethod }} options
 *   methods：插件专属的宿主方法表（带令牌）；call：测试注入
 */
export function createPluginHostApis({ pluginId, methods = null, call = callHostMethod }) {
  const invoke = (method, params = {}, options = {}) => call(method, params, { ...options, ...(methods ? { methods } : {}) })
  const invokeCredential = (method, params) => invoke(method, params, { timeoutMs: CREDENTIAL_IPC_TIMEOUT_MS })
  const namespace = String(pluginId || '').trim()
  // 明文 LocalStorage 走宿主通道（与插件 LocalStorage 一致），压缩走插件专属通道（主进程要求归属）
  const plaintextCall = (method, params) => call(method, params)
  const migrationLocks = new Map()

  async function status() {
    try {
      const result = await invokeCredential('credential_v1_status', {})
      const data = result?.data
      if (data?.status === 'available') return { available: true }
      if (data?.status === 'unavailable' && UNAVAILABLE_REASONS.has(data.reason)) {
        return { available: false, reason: data.reason }
      }
      return { available: false, reason: 'encryption-unavailable' }
    } catch (error) {
      if (UNSUPPORTED_CODES.has(error?.code)) return { available: false, reason: 'host-unsupported' }
      if (error?.code === 'PLUGIN_IDENTITY_REQUIRED') return { available: false, reason: 'identity-required' }
      throw hostError(error)
    }
  }

  async function getItem(key) {
    assertSecureStorageKey(key)
    let result
    try {
      result = await invokeCredential('credential_v1_get', { key })
    } catch (error) {
      if (error?.code === 'NOT_SUPPORTED') {
        throw new ZToolsHostError('SECURE_STORAGE_UNAVAILABLE', '系统加密存储当前不可用')
      }
      throw hostError(error)
    }
    const data = result?.data
    if (data?.status === 'missing') return undefined
    if (data?.status !== 'present' || typeof data.value !== 'string') {
      throw new ZToolsHostError('HOST_RESPONSE_INVALID', '宿主返回的加密数据无效')
    }
    try {
      return JSON.parse(data.value)
    } catch {
      throw new ZToolsHostError('DATA_CORRUPT', `加密存储里的「${key}」不是有效 JSON`)
    }
  }

  async function writeItem(key, value, ifAbsent, expected) {
    assertSecureStorageKey(key)
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
      throw new ZToolsHostError('INVALID_REQUEST', 'SecureStorage 只能保存可 JSON 序列化的值')
    }
    let text
    try {
      text = stableJson(value)
    } catch {
      throw new ZToolsHostError('INVALID_REQUEST', 'SecureStorage 只能保存可 JSON 序列化的值')
    }
    if (new TextEncoder().encode(text).length > SECURE_STORAGE_MAX_VALUE_BYTES) {
      throw new ZToolsHostError('FILE_TOO_LARGE', `「${key}」超过 64 KiB，无法保存到加密存储`)
    }
    try {
      const conditional = expected !== undefined
      const result = await invokeCredential(conditional ? 'credential_v1_compare_and_set' : 'credential_v1_set', {
        key, value: text, ...(ifAbsent ? { ifAbsent: true } : {}),
        ...(conditional ? { expectedValue: expected.value === undefined ? null : stableJson(expected.value) } : {})
      })
      return result?.data
    } catch (error) {
      if (error?.code === 'NOT_SUPPORTED') {
        throw new ZToolsHostError('SECURE_STORAGE_UNAVAILABLE', '系统加密存储当前不可用，为保护数据已停止保存')
      }
      throw hostError(error)
    }
  }

  async function removeItem(key) {
    assertSecureStorageKey(key)
    try {
      await invokeCredential('credential_v1_delete', { key })
    } catch (error) {
      throw hostError(error)
    }
  }

  async function compact() {
    try {
      await invoke('db_compact', { plugin_id: namespace })
    } catch (error) {
      // 压缩失败不影响迁移结果，下次删除时再压
      console.warn(`[secure-storage] 插件 ${namespace} 数据库压缩失败：${error?.message || error}`)
    }
  }

  async function discardLocalStorage(key) {
    await removePlaintextEntry(namespace, key, plaintextCall)
    await compact()
  }

  /** 同一 key 在渲染侧串行；跨窗口并发由主进程 ifAbsent（按 key 串行锁内判断）兜底 */
  function withMigrationLock(key, run) {
    const previous = migrationLocks.get(key) || Promise.resolve()
    const current = previous.catch(() => undefined).then(run)
    const tail = current.catch(() => undefined)
    migrationLocks.set(key, tail)
    tail.then(() => { if (migrationLocks.get(key) === tail) migrationLocks.delete(key) })
    return current
  }

  async function importFromLocalStorage(key, options = {}) {
    const targetKey = options?.targetKey ?? key
    assertSecureStorageKey(targetKey)
    return withMigrationLock(targetKey, async () => {
      let secure = await getItem(targetKey)
      const legacy = await readPlaintextEntry(namespace, key, plaintextCall)
      if (!legacy.found) {
        return secure === undefined ? { status: 'not-found' } : { status: 'kept-secure', value: secure }
      }
      if (secure === undefined) {
        const written = await writeItem(targetKey, legacy.value, true)
        if (written !== 'EXISTS') {
          // 读回校验一致后才删除明文；任一步失败都不删明文（下次再试），不会出现两边都没有
          const readBack = await getItem(targetKey)
          if (stableJson(readBack) !== stableJson(legacy.value)) {
            throw new ZToolsHostError('MIGRATION_VERIFY_FAILED', '加密存储读回校验不一致，已保留明文')
          }
          await discardLocalStorage(key)
          return { status: 'imported', value: readBack }
        }
        // 另一个窗口刚完成迁移：以加密存储为准，进入合并分支
        secure = await getItem(targetKey)
      }
      if (stableJson(secure) === stableJson(legacy.value)) {
        await discardLocalStorage(key)
        return { status: 'kept-secure', value: secure }
      }
      return { status: 'kept-secure', value: secure, legacyValue: legacy.value }
    })
  }

  async function terminateProcess(pid, options = {}) {
    if (!Number.isInteger(pid) || pid < 2 || pid > 0xffff_ffff) {
      throw new ZToolsHostError('INVALID_REQUEST', 'pid 必须是 2–4294967295 的整数')
    }
    const mode = options.mode === 'force' ? 'force' : 'graceful'
    const params = { pid, mode }
    if (options.tree !== undefined) params.tree = options.tree === true
    if (options.timeoutMs !== undefined) params.timeoutMs = options.timeoutMs
    if (options.expectedName !== undefined) params.expectedName = String(options.expectedName)
    const waitMs = Number.isInteger(params.timeoutMs) ? params.timeoutMs : PROCESS_DEFAULT_TIMEOUT_MS[mode]
    try {
      const result = await invoke('process_terminate_pid', params, { timeoutMs: waitMs + PROCESS_IPC_GRACE_MS })
      return result?.data
    } catch (error) {
      throw hostError(error)
    }
  }

  const hostTransport = Object.freeze({
    async call(method, params = {}, options = {}) {
      try {
        return await invoke(method, params, options)
      } catch (error) {
        throw hostError(error)
      }
    }
  })

  const SecureStorage = Object.freeze({
    status,
    getItem,
    async setItem(key, value) {
      await writeItem(key, value, false)
    },
    async compareAndSet(key, expected, value) {
      const result = await writeItem(key, value, false, { value: expected })
      if (result !== 'OK' && result !== 'CONFLICT') throw new ZToolsHostError('HOST_RESPONSE_INVALID', '宿主返回的存储结果无效')
      return result === 'OK'
    },
    async updateItem(key, update) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await getItem(key)
        const before = JSON.stringify(current)
        const expected = before === undefined ? undefined : JSON.parse(before)
        const next = update(current)
        if (JSON.stringify(next) === before) return next
        if (await SecureStorage.compareAndSet(key, expected, next)) return next
      }
      throw new ZToolsHostError('STORAGE_CONFLICT', '数据正在被其他窗口修改，请重试')
    },
    removeItem,
    importFromLocalStorage,
    discardLocalStorage
  })

  return { SecureStorage, terminateProcess, hostTransport, getHostTransport: () => hostTransport }
}
