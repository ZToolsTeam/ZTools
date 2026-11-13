import test from 'node:test'
import assert from 'node:assert/strict'
import { readTestConcurrency } from './test-run-options.mjs'

test('默认串行；受控并发覆盖上下界', () => {
  assert.equal(readTestConcurrency({}), 1)
  assert.equal(readTestConcurrency({ ZTOOLS_TEST_CONCURRENCY: '1' }), 1)
  assert.equal(readTestConcurrency({ ZTOOLS_TEST_CONCURRENCY: '32' }), 32)
})
test('资源配置错误在启动测试前失败', () => {
  for (const value of ['', '0', '-1', '33', '1.5', '01', 'Infinity', ' 2', '2 --inspect']) {
    assert.throws(() => readTestConcurrency({ ZTOOLS_TEST_CONCURRENCY: value }))
  }
})
