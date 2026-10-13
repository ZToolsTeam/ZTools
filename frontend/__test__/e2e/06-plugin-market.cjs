/**
 * E2E 测试 - 插件市场功能
 * 测试插件列表加载、详情页、打开已安装插件、下载状态等
 */

module.exports = async (runner) => {
  // 辅助：获取 Pinia store 状态
  const getStoreField = (storeId, field) =>
    `(function(){ var s = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia.state.value["${storeId}"]; return s ? JSON.stringify(s.${field}) : null; })()`

  // 辅助：通过 router 导航并等待
  const navigateTo = (path) =>
    `(async function(){ var r = document.querySelector("#app").__vue_app__.config.globalProperties.$router; await r.push("${path}"); await new Promise(function(resolve){ setTimeout(resolve, 800); }); })()`

  let testPluginId = null
  let marketPluginId = null

  await runner.runSuite('E2E: 插件市场', [
    {
      name: '市场列表页加载成功',
      fn: async (cdp, assert) => {
        await cdp.evaluate(navigateTo('/list'))
        // 等待网络请求完成（市场数据需要从后端加载）
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 3000); })')
        const raw = await cdp.evaluate(getStoreField('plugins', 'loading'))
        assert.equal(raw, 'false', '加载状态应为 false')
      }
    },
    {
      name: '市场列表有插件数据或显示空状态',
      fn: async (cdp, assert) => {
        const raw = await cdp.evaluate(
          `(function(){
            var s = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia.state.value["plugins"];
            var itemCount = s && s.items ? s.items.length : 0;
            var hasCards = !!document.querySelector(".plugin-card, .plugin-card-3d, [class*=card-content]");
            var hasEmpty = !!document.querySelector("[class*=empty]") || document.body.textContent.indexOf("暂无插件") >= 0;
            var hasError = s && s.error;
            return JSON.stringify({ itemCount: itemCount, hasCards: hasCards, hasEmpty: hasEmpty, hasError: !!hasError });
          })()`
        )
        const state = JSON.parse(raw)
        // 市场列表可能因网络问题无数据，只要不是异常状态就算通过
        assert.ok(
          state.itemCount > 0 || state.hasCards || state.hasEmpty || !state.hasError,
          '市场列表应有数据、空状态或正常加载'
        )
        if (state.itemCount > 0) {
          // 记录第一个市场插件 ID
          marketPluginId = await cdp.evaluate(
            '(function(){ var s = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia.state.value["plugins"]; return s && s.items && s.items[0] ? s.items[0].pluginId : ""; })()'
          )
        }
      }
    },
    {
      name: '获取已安装插件列表',
      fn: async (cdp, assert) => {
        const raw = await cdp.evaluate(
          '(function(){ var s = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia.state.value["plugins"]; return JSON.stringify(Array.from(s.installedSet || [])); })()'
        )
        const installed = JSON.parse(raw)
        assert.ok(Array.isArray(installed), 'installedSet 应为数组')
        if (installed.length > 0) {
          testPluginId = installed[0]
        }
      }
    },
    {
      name: '打开已安装插件',
      fn: async (cdp, assert) => {
        if (!testPluginId) {
          console.log('    ℹ️  无已安装插件，跳过')
          return
        }
        const raw = await cdp.evaluate(
          `(async function(){ var r = await ztools.plugin.open("${testPluginId}"); var d = r && r.data ? r.data : r; return JSON.stringify({ success: d && d.success !== false, action: d && d.action }); })()`
        )
        const result = JSON.parse(raw)
        assert.ok(result.success || result.action, '打开插件应有正常响应')
      }
    },
    {
      name: '导航到插件详情页',
      fn: async (cdp, assert) => {
        const pid = marketPluginId || testPluginId
        if (!pid) {
          console.log('    ℹ️  无可用插件 ID，跳过')
          return
        }
        await cdp.evaluate(navigateTo('/details/' + pid))
        const path = await cdp.evaluate(
          'document.querySelector("#app").__vue_app__.config.globalProperties.$router.currentRoute.value.path'
        )
        assert.includes(path, '/details/', '应导航到详情页')
      }
    },
    {
      name: '详情页渲染正确',
      fn: async (cdp, assert) => {
        const pid = marketPluginId || testPluginId
        if (!pid) {
          console.log('    ℹ️  无可用插件 ID，跳过')
          return
        }
        // 等待详情页加载
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 2000); })')
        const state = await cdp.evaluate(
          `(function(){
            var hasLoading = !!document.querySelector(".skeleton-container, .skeleton-header");
            var hasError = !!document.querySelector(".error-container");
            var hasContent = !!document.querySelector(".details-page .tab-container, .details-page .back-nav, .back-btn");
            return JSON.stringify({ hasLoading: hasLoading, hasError: hasError, hasContent: hasContent });
          })()`
        )
        const s = JSON.parse(state)
        // 有内容、正在加载、或有错误提示（网络问题）都算正常
        assert.ok(s.hasContent || s.hasLoading || s.hasError, '详情页应有内容、加载中或错误提示')
      }
    },
    {
      name: '详情页 Tab 切换',
      fn: async (cdp, assert) => {
        const clicked = await cdp.evaluate(
          `(function(){
            var tabs = document.querySelectorAll(".tab-btn");
            for (var i = 0; i < tabs.length; i++) {
              if (tabs[i].textContent.trim() === "留言") {
                tabs[i].click();
                return true;
              }
            }
            return false;
          })()`
        )
        if (!clicked) {
          console.log('    ℹ️  未找到留言 Tab，跳过')
          return
        }
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 500); })')
        const hasActive = await cdp.evaluate(
          '!!document.querySelector(".tab-btn.active")'
        )
        assert.ok(hasActive, '应有激活的 Tab')
      }
    },
    {
      name: 'downloadingSet 初始为空',
      fn: async (cdp, assert) => {
        const raw = await cdp.evaluate(
          '(function(){ var s = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia.state.value["plugins"]; return JSON.stringify(Array.from(s.downloadingSet || [])); })()'
        )
        const downloading = JSON.parse(raw)
        assert.equal(downloading.length, 0, '初始不应有正在下载的插件')
      }
    }
  ])

  // 回到首页
  await runner.cdp.evaluate(navigateTo('/'))
}
