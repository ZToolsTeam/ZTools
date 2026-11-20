/**
 * 声明式插件的 LocalStorage（与 Raycast LocalStorage 接口一致）
 *
 * - 数据写入宿主的插件专用存储（db_put / db_get，按插件 ID 分库，写入即落盘），重启不丢；
 * - 每个插件只能读写自己的数据：命名空间在加载插件时由宿主按插件 ID 绑定，插件无法指定；
 * - 旧版本把数据写在浏览器 localStorage（键名 raycast_<key>，所有插件共用）。读取时若宿主存储里没有，
 *   会原子迁移旧值；竞争失败重读宿主最新值，迁移或读取失败抛错，旧值保留不删；removeItem 会同时删除旧键。
 */
import { callHostMethod } from '../declarative/hostMethods.js'
import { t } from '@/i18n'

const KEY_PREFIX = 'ls:'
const LEGACY_PREFIX = 'raycast_'
/** 单个值的上限，避免插件把超大内容塞进存储拖慢读写 */
const MAX_VALUE_BYTES = 4 * 1024 * 1024

function storageError(message, code, cause) {
  const err = new Error(message)
  err.code = code
  if (cause) err.cause = cause
  return err
}

function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 200) {
    throw storageError(t('pluginStorage.invalidKey'), 'INVALID_STORAGE_KEY')
  }
}

function removeLegacy(key) {
  try {
    globalThis.localStorage?.removeItem(LEGACY_PREFIX + key)
  } catch {
    // 浏览器存储不可用时忽略
  }
}

function isJsonText(text) {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/**
 * 读取明文条目（宿主库 ls:<key> 优先，其次浏览器旧键 raycast_<key>），不做迁移写入。
 * 供 SecureStorage.importFromLocalStorage 使用：迁移期间不应再把明文写回宿主库。
 */
export async function readPlaintextEntry(namespace, key, call = callHostMethod) {
  assertKey(key)
  try {
    const res = await call('db_get', { plugin_id: namespace, key: KEY_PREFIX + key })
    if (typeof res?.data === 'string') {
      try {
        return { found: true, value: JSON.parse(res.data) }
      } catch {
        return { found: true, value: res.data }
      }
    }
  } catch (err) {
    if (err?.code !== 'DATABASE_KEY_NOT_FOUND') {
      throw storageError(t('pluginStorage.readFailed', { reason: err?.message || err }), err?.code || 'STORAGE_READ_FAILED', err)
    }
  }
  return readLegacy(key)
}

/** 删除明文条目：宿主库与浏览器旧键都删，任一失败抛错（调用方据此决定是否重试） */
export async function removePlaintextEntry(namespace, key, call = callHostMethod) {
  assertKey(key)
  try {
    await call('db_delete', { plugin_id: namespace, key: KEY_PREFIX + key })
  } catch (err) {
    if (err?.code !== 'DATABASE_KEY_NOT_FOUND') {
      throw storageError(t('pluginStorage.deleteFailed', { reason: err?.message || err }), err?.code || 'STORAGE_WRITE_FAILED', err)
    }
  }
  removeLegacy(key)
  if (readLegacy(key).found) {
    throw storageError(t('pluginStorage.legacyDeleteFailed'), 'STORAGE_WRITE_FAILED')
  }
}

function readLegacy(key) {
  try {
    const raw = globalThis.localStorage?.getItem(LEGACY_PREFIX + key)
    if (raw === null || raw === undefined) return { found: false }
    try {
      return { found: true, value: JSON.parse(raw) }
    } catch {
      return { found: true, value: raw }
    }
  } catch (err) {
    throw storageError(t('pluginStorage.legacyReadFailed', { reason: err?.message || err }), err?.code || 'STORAGE_READ_FAILED', err)
  }
}

export function createScopedLocalStorage(pluginId, call = callHostMethod) {
  const namespace = String(pluginId || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(namespace)) {
    throw storageError(t('pluginStorage.invalidPluginId', { pluginId }), 'INVALID_PLUGIN_ID')
  }

  async function put(key, value) {
    const text = JSON.stringify(value === undefined ? null : value)
    if (new TextEncoder().encode(text).length > MAX_VALUE_BYTES) {
      throw storageError(t('pluginStorage.valueTooLargeForKey', { key }), 'STORAGE_VALUE_TOO_LARGE')
    }
    await call('db_put', { plugin_id: namespace, key: KEY_PREFIX + key, value: text })
  }

  async function compareAndSet(key, expected, value) {
    assertKey(key)
    const text = JSON.stringify(value)
    const before = expected === undefined ? null : JSON.stringify(expected)
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_VALUE_BYTES) {
      throw storageError(t('pluginStorage.valueInvalidOrTooLarge'), 'STORAGE_VALUE_TOO_LARGE')
    }
    const attempt = async (expectedValue) => {
      const result = await call('db_compare_and_set', { plugin_id: namespace, key: KEY_PREFIX + key, expectedValue, value: text })
      if (typeof result?.data !== 'boolean') throw storageError(t('pluginStorage.invalidHostResult'), 'HOST_RESPONSE_INVALID')
      return result.data
    }
    if (await attempt(before)) return true
    // 存储里的值不是合法 JSON 时 getItem 返回原始文本；此时按原始文本再比较一次。
    // 只对“本身不是合法 JSON 的字符串”这样做：合法 JSON 的原始文本会被 getItem 解析，不会以字符串形式返回，二者不会混淆。
    if (typeof expected === 'string' && !isJsonText(expected)) return attempt(expected)
    return false
  }

  return Object.freeze({
    compareAndSet,
    async updateItem(key, update) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await this.getItem(key)
        const before = JSON.stringify(current)
        const expected = before === undefined ? undefined : JSON.parse(before)
        const next = update(current)
        if (JSON.stringify(next) === before) return next
        if (await this.compareAndSet(key, expected, next)) return next
      }
      throw storageError(t('pluginStorage.conflictRetry'), 'STORAGE_CONFLICT')
    },
    async getItem(key) {
      assertKey(key)
      for (let attempt = 0; attempt < 8; attempt++) {
        let raw
        try {
          const res = await call('db_get', { plugin_id: namespace, key: KEY_PREFIX + key })
          raw = res?.data
        } catch (err) {
          if (err?.code !== 'DATABASE_KEY_NOT_FOUND') {
            throw storageError(t('pluginStorage.readFailed', { reason: err?.message || err }), err?.code || 'STORAGE_READ_FAILED', err)
          }
          const legacy = readLegacy(key)
          if (!legacy.found) return undefined
          // 只初始化仍然缺失的键；另一个窗口先保存时，必须读取其最新值。
          if (await compareAndSet(key, undefined, legacy.value)) return legacy.value
          continue
        }
        if (typeof raw !== 'string') throw storageError(t('pluginStorage.invalidHostContent'), 'HOST_RESPONSE_INVALID')
        try {
          return JSON.parse(raw)
        } catch {
          // 存储里的值不是合法 JSON（可能被外部工具改写）：按原始字符串返回，交给插件自行校验
          return raw
        }
      }
      throw storageError(t('pluginStorage.conflictRetry'), 'STORAGE_CONFLICT')
    },

    async setItem(key, value) {
      assertKey(key)
      try {
        await put(key, value)
      } catch (err) {
        if (err?.code === 'STORAGE_VALUE_TOO_LARGE') throw err
        throw storageError(t('pluginStorage.saveFailed', { reason: err?.message || err }), err?.code || 'STORAGE_WRITE_FAILED', err)
      }
    },

    async removeItem(key) {
      assertKey(key)
      try {
        await call('db_delete', { plugin_id: namespace, key: KEY_PREFIX + key })
      } catch (err) {
        if (err?.code !== 'DATABASE_KEY_NOT_FOUND') {
          throw storageError(t('pluginStorage.deleteFailed', { reason: err?.message || err }), err?.code || 'STORAGE_WRITE_FAILED', err)
        }
      }
      // 同时删除浏览器旧键：否则下次 getItem 在宿主库读不到时会把旧值「迁移」回来，删除过的数据复活
      removeLegacy(key)
    },

    async allItems() {
      const res = await call('db_query', { plugin_id: namespace, prefix: KEY_PREFIX, limit: 0 })
      const out = {}
      for (const row of Array.isArray(res?.data) ? res.data : []) {
        if (typeof row?.key !== 'string' || !row.key.startsWith(KEY_PREFIX)) continue
        try {
          out[row.key.slice(KEY_PREFIX.length)] = JSON.parse(row.value)
        } catch {
          out[row.key.slice(KEY_PREFIX.length)] = row.value
        }
      }
      return out
    },

    async clear() {
      const items = await this.allItems()
      for (const key of Object.keys(items)) await this.removeItem(key)
    }
  })
}
