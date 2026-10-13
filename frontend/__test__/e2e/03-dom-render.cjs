/**
 * E2E 测试 - DOM 渲染验证
 * 测试关键 UI 组件是否正确渲染
 */

module.exports = async (runner) => {
  // 先确保在首页
  await runner.cdp.evaluate(
    '(async()=>{ await document.querySelector("#app").__vue_app__.config.globalProperties.$router.push("/"); await new Promise(r=>setTimeout(r,500)); })()'
  )

  await runner.runSuite('E2E: DOM 渲染', [
    {
      name: '搜索栏存在',
      fn: async (cdp, assert) => {
        const exists = await cdp.evaluate(
          '!!document.querySelector("input[type=text], input[placeholder], .search-bar, .ant-input")'
        )
        assert.ok(exists, '搜索栏应存在于首页')
      }
    },
    {
      name: '侧边栏或导航存在',
      fn: async (cdp, assert) => {
        const exists = await cdp.evaluate(
          '!!document.querySelector(".sidebar, .ant-layout-sider, nav, .ant-menu")'
        )
        assert.ok(exists, '侧边栏/导航应存在')
      }
    },
    {
      name: '页面无 JS 错误（控制台检查）',
      fn: async (cdp, assert) => {
        // 注入错误收集器，等待 2 秒看是否有新错误
        const errorCount = await cdp.evaluate(`(async function(){
          var errors = [];
          var oldHandler = window.onerror;
          window.onerror = function(msg){ errors.push(msg); };
          await new Promise(function(r){ setTimeout(r, 1000); });
          window.onerror = oldHandler;
          return errors.length;
        })()`)
        assert.equal(errorCount, 0, '页面不应有 JS 运行时错误')
      }
    },
    {
      name: 'CSS 变量已定义',
      fn: async (cdp, assert) => {
        const bgColor = await cdp.evaluate(
          'getComputedStyle(document.documentElement).getPropertyValue("--plugin-bg").trim()'
        )
        // CSS 变量可能在 body 或 :root 上
        const hasCssVars = bgColor.length > 0 || await cdp.evaluate(
          'getComputedStyle(document.body).getPropertyValue("--plugin-bg").trim().length > 0'
        )
        assert.ok(hasCssVars, '--plugin-bg CSS 变量应已定义')
      }
    },
    {
      name: '页面标题不为空',
      fn: async (cdp, assert) => {
        const title = await cdp.evaluate('document.title')
        assert.ok(title, '页面标题不应为空')
      }
    }
  ])
}
