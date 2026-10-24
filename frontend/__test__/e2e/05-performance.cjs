/**
 * E2E 测试 - 性能基准
 * 测试关键操作的响应时间
 */

module.exports = async (runner) => {
  await runner.runSuite('E2E: 性能基准', [
    {
      name: 'API 调用响应时间 < 500ms (sys.getInfo)',
      fn: async (cdp, assert) => {
        const elapsed = await cdp.evaluate(`(async function(){
          var start = performance.now();
          await ztools.sys.getInfo();
          return Math.round(performance.now() - start);
        })()`)
        assert.ok(elapsed < 500, 'sys.getInfo 应在 500ms 内完成，实际: ' + elapsed + 'ms')
      }
    },
    {
      name: 'DB 读写响应时间 < 200ms',
      fn: async (cdp, assert) => {
        const elapsed = await cdp.evaluate(`(async function(){
          var key = "__perf_test_" + Date.now();
          var start = performance.now();
          await ztools.db.set("__test__", key, "perf-value");
          await ztools.db.get("__test__", key);
          await ztools.db.delete("__test__", key);
          return Math.round(performance.now() - start);
        })()`)
        assert.ok(elapsed < 200, 'DB 读写删应在 200ms 内完成，实际: ' + elapsed + 'ms')
      }
    },
    {
      name: '路由切换响应时间 < 1000ms',
      fn: async (cdp, assert) => {
        const elapsed = await cdp.evaluate(`(async function(){
          var router = document.querySelector("#app").__vue_app__.config.globalProperties.$router;
          var start = performance.now();
          await router.push("/about");
          await new Promise(function(r){ setTimeout(r, 100); });
          await router.push("/");
          await new Promise(function(r){ setTimeout(r, 100); });
          return Math.round(performance.now() - start);
        })()`)
        assert.ok(elapsed < 1000, '路由往返切换应在 1000ms 内完成，实际: ' + elapsed + 'ms')
      }
    },
    {
      name: 'DOM 节点数量合理 (< 5000)',
      fn: async (cdp, assert) => {
        const count = await cdp.evaluate('document.querySelectorAll("*").length')
        assert.ok(count < 5000, 'DOM 节点数应 < 5000，实际: ' + count)
      }
    },
    {
      name: '内存使用合理',
      fn: async (cdp, assert) => {
        const memMB = await cdp.evaluate(
          'performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) : -1'
        )
        if (memMB === -1) {
          // performance.memory 在某些环境不可用
          console.log('    ℹ️  performance.memory 不可用，跳过内存检查')
          return
        }
        assert.ok(memMB < 256, 'JS 堆内存应 < 256MB，实际: ' + memMB + 'MB')
      }
    }
  ])
}
