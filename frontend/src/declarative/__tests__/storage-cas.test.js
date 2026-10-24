import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginHostApis } from '../pluginSecureStorage.js'
import { createScopedLocalStorage } from '../../utils/pluginStorage.js'

// 同形宿主契约替身：CAS比较与写入在单次调用内原子执行；身份由绑定methods确定。
function storageHost() {
  const records = new Map()
  const calls = []
  const call = vi.fn(async (method, params, options) => {
    calls.push({ method, params, options })
    const owner = method.startsWith('credential_') ? options?.methods?.owner : params.plugin_id
    const key = `${owner}:${params.key}`
    if (method === 'db_get') {
      if (!records.has(key)) throw Object.assign(new Error('missing'), { code: 'DATABASE_KEY_NOT_FOUND' })
      return { data: records.get(key) }
    }
    if (method === 'credential_v1_get') return { data: records.has(key) ? { status: 'present', value: records.get(key) } : { status: 'missing' } }
    if (method === 'db_compare_and_set' || method === 'credential_v1_compare_and_set') {
      const matches = (records.get(key) ?? null) === params.expectedValue
      if (matches) records.set(key, params.value)
      return { data: method === 'db_compare_and_set' ? matches : matches ? 'OK' : 'CONFLICT' }
    }
    throw new Error(`意外方法 ${method}`)
  })
  return { records, calls, call }
}
const factories = {
  LocalStorage: (owner, host) => createScopedLocalStorage(owner, host.call),
  SecureStorage: (owner, host) => createPluginHostApis({ pluginId: owner, methods: { owner }, call: host.call }).SecureStorage
}

beforeEach(() => localStorage.clear())

describe('LocalStorage 旧缓存迁移', () => {
  it('两个窗口首次迁移与更新交错，保留旧条目及双方新数据', async () => {
    localStorage.setItem('raycast_items', JSON.stringify(['legacy']))
    const host = storageHost(), originalCall = host.call.getMockImplementation()
    let reads = 0, initializations = 0, releaseSecond
    const delayedMigration = new Promise(resolve => { releaseSecond = resolve })
    host.call.mockImplementation(async (method, params) => {
      if (method === 'db_get' && ++reads <= 2) {
        throw Object.assign(new Error('missing'), { code: 'DATABASE_KEY_NOT_FOUND' })
      }
      if (method === 'db_compare_and_set' && params.expectedValue === null && ++initializations === 2) {
        await delayedMigration
      }
      return originalCall(method, params)
    })
    const first = createScopedLocalStorage('todo', host.call), second = createScopedLocalStorage('todo', host.call)
    const a = first.updateItem('items', current => [...current, 'A'])
    const b = second.updateItem('items', current => [...current, 'B'])
    try {
      await a
      expect(await first.getItem('items')).toEqual(['legacy', 'A'])
    } finally { releaseSecond() }
    await b
    expect(await first.getItem('items')).toEqual(['legacy', 'A', 'B'])
    expect(localStorage.getItem('raycast_items')).toBe('["legacy"]')
    expect(host.call.mock.calls.some(([method]) => method === 'db_put')).toBe(false)
  })

  it.each(['migration', 'reread'])('迁移阶段 %s 失败时抛错，不把旧值伪装为当前值', async stage => {
    localStorage.setItem('raycast_items', '["legacy"]')
    let reads = 0
    const call = vi.fn(async method => {
      if (method === 'db_get') {
        if (++reads === 1) throw Object.assign(new Error('missing'), { code: 'DATABASE_KEY_NOT_FOUND' })
        throw Object.assign(new Error('读取失败'), { code: 'DATA_CORRUPT' })
      }
      if (stage === 'migration') throw Object.assign(new Error('无法写入'), { code: 'FILE_ERROR' })
      return { data: false }
    })
    const storage = createScopedLocalStorage('todo', call)
    await expect(storage.updateItem('items', current => [...current, 'new'])).rejects.toMatchObject({
      code: stage === 'migration' ? 'FILE_ERROR' : 'DATA_CORRUPT'
    })
    expect(call.mock.calls.filter(([method]) => method === 'db_compare_and_set')).toHaveLength(1)
    expect(localStorage.getItem('raycast_items')).toBe('["legacy"]')
  })

  it('初始化持续冲突时有界失败；无效读取响应不当成缺失数据', async () => {
    localStorage.setItem('raycast_items', '["legacy"]')
    const call = vi.fn(async method => {
      if (method === 'db_get') throw Object.assign(new Error('missing'), { code: 'DATABASE_KEY_NOT_FOUND' })
      return { data: false }
    })
    const storage = createScopedLocalStorage('todo', call)
    await expect(storage.getItem('items')).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' })
    expect(call.mock.calls.filter(([method]) => method === 'db_compare_and_set')).toHaveLength(8)
    call.mockReset().mockResolvedValue({ data: null })
    await expect(storage.updateItem('items', () => ['new'])).rejects.toMatchObject({ code: 'HOST_RESPONSE_INVALID' })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('旧浏览器存储读取失败时禁止初始化，不能用新空列表覆盖旧数据', async () => {
    const host = storageHost(), storage = createScopedLocalStorage('todo', host.call)
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('存储不可读') })
    try {
      await expect(storage.updateItem('items', () => ['new'])).rejects.toMatchObject({ code: 'STORAGE_READ_FAILED' })
      expect(host.call.mock.calls.some(([method]) => method === 'db_compare_and_set')).toBe(false)
      expect(host.records.size).toBe(0)
    } finally { read.mockRestore() }
  })
})

for (const [name, make] of Object.entries(factories)) describe(`${name} CAS契约`, () => {
  it('两个窗口更新同一个数组时冲突重读，保留双方修改；其他插件隔离', async () => {
    const host = storageHost(), first = make('same', host), second = make('same', host), other = make('other', host)
    await Promise.all([
      first.updateItem('items', current => [...(current || []), 'A']),
      second.updateItem('items', current => [...(current || []), 'B']),
      other.updateItem('items', current => [...(current || []), 'C'])
    ])
    expect((await first.getItem('items')).sort()).toEqual(['A', 'B'])
    expect(await other.getItem('items')).toEqual(['C'])
    expect(host.calls.filter(c => c.method.includes('compare_and_set')).length).toBeGreaterThan(3)
  })
  it('缺失与JSON null分开，CAS返回冲突不会伪装写入成功', async () => {
    const host = storageHost(), storage = make('same', host)
    expect(await storage.compareAndSet('value', undefined, null)).toBe(true)
    expect(await storage.compareAndSet('value', undefined, 'overwrite')).toBe(false)
    expect(await storage.compareAndSet('value', null, 'updated')).toBe(true)
    const attempts = host.calls.filter(c => c.method.includes('compare_and_set'))
    expect(attempts[0].params.expectedValue).toBe(null)
    expect(attempts[2].params.expectedValue).toBe('null')
    expect(await storage.getItem('value')).toBe('updated')
  })
  it('写入异常与非法宿主响应向上传播，不重试或假成功', async () => {
    const host = storageHost(), storage = make('same', host)
    host.call.mockImplementation(async method => {
      if (method.endsWith('_get')) return method === 'db_get' ? { data: '[]' } : { data: { status: 'present', value: '[]' } }
      throw Object.assign(new Error('取消'), { code: 'CALLER_DESTROYED' })
    })
    await expect(storage.updateItem('items', () => ['new'])).rejects.toMatchObject({ code: 'CALLER_DESTROYED' })
    host.call.mockResolvedValue({ data: 'unexpected' })
    await expect(storage.compareAndSet('items', [], ['new'])).rejects.toMatchObject({ code: 'HOST_RESPONSE_INVALID' })
  })
  it('持续冲突有界失败；相同值的更新不写入', async () => {
    const host = storageHost(), storage = make('same', host)
    host.call.mockImplementation(async method => {
      if (method.endsWith('_get')) return method === 'db_get' ? { data: '["old"]' } : { data: { status: 'present', value: '["old"]' } }
      return { data: name === 'SecureStorage' ? 'CONFLICT' : false }
    })
    await expect(storage.updateItem('items', () => ['new'])).rejects.toMatchObject({ code: 'STORAGE_CONFLICT' })
    expect(host.call.mock.calls.filter(([m]) => m.includes('compare_and_set'))).toHaveLength(8)
    host.call.mockClear()
    expect(await storage.updateItem('items', current => [...current])).toEqual(['old'])
    expect(host.call).toHaveBeenCalledTimes(1)
  })
})

describe('存储里的旧值不是合法 JSON', () => {
  it('LocalStorage.updateItem 按原始文本比较并覆盖，不会一直报冲突', async () => {
    const host = storageHost(), storage = createScopedLocalStorage('todo', host.call)
    host.records.set('todo:ls:items', 'not-json{')
    expect(await storage.getItem('items')).toBe('not-json{')
    expect(await storage.updateItem('items', current => [String(current), 'new'])).toEqual(['not-json{', 'new'])
    expect(await storage.getItem('items')).toEqual(['not-json{', 'new'])
    expect(host.calls.filter(c => c.method === 'db_compare_and_set').map(c => c.params.expectedValue))
      .toEqual(['"not-json{"', 'not-json{'])
  })

  it('LocalStorage.compareAndSet 对合法 JSON 文本不做原始文本回退，旧值已变化时仍返回冲突', async () => {
    const host = storageHost(), storage = createScopedLocalStorage('todo', host.call)
    host.records.set('todo:ls:n', '123')
    expect(await storage.compareAndSet('n', '123', 1)).toBe(false)
    host.records.set('todo:ls:s', 'other')
    expect(await storage.compareAndSet('s', 'not-json{', 1)).toBe(false)
    expect(host.records.get('todo:ls:n')).toBe('123')
    expect(host.records.get('todo:ls:s')).toBe('other')
  })

  it('SecureStorage.updateItem 明确报数据损坏，不进入冲突重试', async () => {
    const host = storageHost()
    const storage = createPluginHostApis({ pluginId: 'todo', methods: { owner: 'todo' }, call: host.call }).SecureStorage
    host.records.set('todo:items', 'not-json{')
    await expect(storage.updateItem('items', () => ['new'])).rejects.toMatchObject({ code: 'DATA_CORRUPT' })
    expect(host.calls.some(c => c.method === 'credential_v1_compare_and_set')).toBe(false)
  })
})
