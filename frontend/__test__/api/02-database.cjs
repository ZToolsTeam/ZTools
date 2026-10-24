/**
 * API 测试 - 数据库 API (ztools.db)
 * 测试 LevelDB 的 CRUD 操作
 */

const TEST_PLUGIN_ID = '__test__'
const TEST_KEY = 'test-key-' + Date.now()

module.exports = async (runner) => {
  await runner.runSuite('API: 数据库操作', [
    {
      name: 'db.set 写入数据',
      fn: async (cdp, assert) => {
        const result = await cdp.evaluateJSON(
          `(async()=>await ztools.db.set("${TEST_PLUGIN_ID}", "${TEST_KEY}", "hello-test"))()`
        )
        // set 成功通常返回 true 或无异常
        assert.ok(result !== undefined, 'set 应有返回值')
      }
    },
    {
      name: 'db.get 读取数据',
      fn: async (cdp, assert) => {
        const value = await cdp.evaluate(
          `(async()=>await ztools.db.get("${TEST_PLUGIN_ID}", "${TEST_KEY}"))()`
        )
        assert.equal(value, 'hello-test', '读取值应与写入值一致')
      }
    },
    {
      name: 'db.set 覆盖写入',
      fn: async (cdp, assert) => {
        await cdp.evaluate(
          `(async()=>await ztools.db.set("${TEST_PLUGIN_ID}", "${TEST_KEY}", "updated-value"))()`
        )
        const value = await cdp.evaluate(
          `(async()=>await ztools.db.get("${TEST_PLUGIN_ID}", "${TEST_KEY}"))()`
        )
        assert.equal(value, 'updated-value', '覆盖后应读到新值')
      }
    },
    {
      name: 'db.set 写入 JSON 对象',
      fn: async (cdp, assert) => {
        const jsonKey = TEST_KEY + '-json'
        const raw = await cdp.evaluate(
          `(async function(){
            var val = JSON.stringify({name:"test",count:42,nested:{a:1}});
            await ztools.db.set("${TEST_PLUGIN_ID}", "${jsonKey}", val);
            var r = await ztools.db.get("${TEST_PLUGIN_ID}", "${jsonKey}");
            await ztools.db.delete("${TEST_PLUGIN_ID}", "${jsonKey}");
            var obj = (typeof r === "string") ? JSON.parse(r) : r;
            return JSON.stringify(obj);
          })()`
        )
        const result = JSON.parse(raw)
        assert.equal(result.name, 'test', 'JSON 对象字段应正确')
        assert.equal(result.count, 42, 'JSON 数字字段应正确')
        assert.equal(result.nested.a, 1, 'JSON 嵌套字段应正确')
      }
    },
    {
      name: 'db.allDocs 列出所有文档',
      fn: async (cdp, assert) => {
        const docs = await cdp.evaluateJSON(
          `(async()=>await ztools.db.allDocs("${TEST_PLUGIN_ID}"))()`
        )
        assert.ok(docs !== null && docs !== undefined, 'allDocs 应有返回值')
      }
    },
    {
      name: 'db.delete 删除数据',
      fn: async (cdp, assert) => {
        await cdp.evaluate(
          `(async()=>await ztools.db.delete("${TEST_PLUGIN_ID}", "${TEST_KEY}"))()`
        )
        const value = await cdp.evaluate(
          `(async()=>await ztools.db.get("${TEST_PLUGIN_ID}", "${TEST_KEY}"))()`
        )
        // 删除后 get 应返回 null/undefined 或空
        assert.ok(!value || value === 'null' || value === 'undefined', '删除后应读不到数据')
      }
    },
    {
      name: 'db.get 读取不存在的 key',
      fn: async (cdp, assert) => {
        const value = await cdp.evaluate(
          `(async()=>await ztools.db.get("${TEST_PLUGIN_ID}", "nonexistent-key-${Date.now()}"))()`
        )
        assert.ok(value === null || value === undefined || value === '', '不存在的 key 应返回空值')
      }
    }
  ])
}
