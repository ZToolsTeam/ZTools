/**
 * 声明式插件的 LocalStorage（与 Raycast LocalStorage 接口一致）
 *
 * - 数据写入宿主的插件专用存储（db_put / db_get，按插件 ID 分库，写入即落盘），重启不丢；
 * - 每个插件只能读写自己的数据：命名空间在加载插件时由宿主按插件 ID 绑定，插件无法指定；
 * - 旧版本把数据写在浏览器 localStorage（键名 raycast_<key>，所有插件共用）。读取时若宿主存储里没有，
 *   会把旧值迁移进宿主存储；旧值保留不删，迁移失败不影响读取。
 */
import { callHostMethod } from '../declarative/hostMethods.js'

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
    throw storageError('LocalStorage 的 key 必须是 1–200 个字符的字符串', 'INVALID_STORAGE_KEY')
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
  } catch {
    return { found: false }
  }
}

export function createScopedLocalStorage(pluginId, call = callHostMethod) {
  const namespace = String(pluginId || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(namespace)) {
    throw storageError(`非法的插件 ID: ${pluginId}`, 'INVALID_PLUGIN_ID')
  }

  async function put(key, value) {
    const text = JSON.stringify(value === undefined ? null : value)
    if (new TextEncoder().encode(text).length > MAX_VALUE_BYTES) {
      throw storageError(`「${key}」超过 4 MB，无法保存`, 'STORAGE_VALUE_TOO_LARGE')
    }
    await call('db_put', { plugin_id: namespace, key: KEY_PREFIX + key, value: text })
  }

  return Object.freeze({
    async getItem(key) {
      assertKey(key)
      let raw
      try {
        const res = await call('db_get', { plugin_id: namespace, key: KEY_PREFIX + key })
        raw = res?.data
      } catch (err) {
        if (err?.code !== 'DATABASE_KEY_NOT_FOUND') {
          throw storageError(`读取插件数据失败：${err?.message || err}`, err?.code || 'STORAGE_READ_FAILED', err)
        }
        const legacy = readLegacy(key)
        if (!legacy.found) return undefined
        try {
          await put(key, legacy.value)
        } catch {
          // 迁移失败不影响本次读取，下次读取会再试
        }
        return legacy.value
      }
      if (typeof raw !== 'string') return undefined
      try {
        return JSON.parse(raw)
      } catch {
        // 存储里的值不是合法 JSON（可能被外部工具改写）：按原始字符串返回，交给插件自行校验
        return raw
      }
    },

    async setItem(key, value) {
      assertKey(key)
      try {
        await put(key, value)
      } catch (err) {
        if (err?.code === 'STORAGE_VALUE_TOO_LARGE') throw err
        throw storageError(`保存插件数据失败：${err?.message || err}`, err?.code || 'STORAGE_WRITE_FAILED', err)
      }
    },

    async removeItem(key) {
      assertKey(key)
      try {
        await call('db_delete', { plugin_id: namespace, key: KEY_PREFIX + key })
      } catch (err) {
        if (err?.code === 'DATABASE_KEY_NOT_FOUND') return
        throw storageError(`删除插件数据失败：${err?.message || err}`, err?.code || 'STORAGE_WRITE_FAILED', err)
      }
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
