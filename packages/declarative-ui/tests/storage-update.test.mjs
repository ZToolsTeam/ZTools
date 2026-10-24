import test from 'node:test'
import assert from 'node:assert/strict'
import { updateStoredItem } from '../dist/api/storage-update.js'

function storage(initial) {
  let raw = initial === undefined ? undefined : JSON.stringify(initial)
  const result = {
    writes: 0,
    async getItem() { return raw === undefined ? undefined : JSON.parse(raw) },
    async compareAndSet(_key, expected, value) {
      if (raw !== JSON.stringify(expected)) return false
      raw = JSON.stringify(value); result.writes++; return true
    }
  }
  return result
}

test('并发修改按最新快照重试，保留双方增量', async () => {
  const s = storage(['原值'])
  await Promise.all(['A', 'B'].map(value => updateStoredItem(s, 'key', current => [...current, value])))
  assert.deepEqual((await s.getItem()).sort(), ['A', 'B', '原值'].sort())
})
test('原地修改回调也与修改前快照比较', async () => {
  const s = storage(['原值'])
  await updateStoredItem(s, 'key', current => { current.push('新增'); return current })
  assert.deepEqual(await s.getItem(), ['原值', '新增'])
  assert.equal(s.writes, 1)
})
test('无变化不写入，持续冲突有限重试后明确失败', async () => {
  const s = storage(['原值'])
  await updateStoredItem(s, 'key', current => current)
  assert.equal(s.writes, 0)
  let attempts = 0
  s.compareAndSet = async () => { attempts++; return false }
  await assert.rejects(updateStoredItem(s, 'key', () => ['新值']), { code: 'STORAGE_CONFLICT' })
  assert.equal(attempts, 8)
})
test('读取异常直接失败，不写空值', async () => {
  const s = storage(['原值'])
  s.getItem = async () => { throw new Error('读取失败') }
  await assert.rejects(updateStoredItem(s, 'key', () => []), /读取失败/)
  assert.equal(s.writes, 0)
})
