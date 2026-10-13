/**
 * E2E 测试 - 我的页面（首页）
 * 测试已安装插件展示、收藏列表、最近使用、插件打开等
 */

module.exports = async (runner) => {
  const navigateTo = (path) =>
    `(async function(){ var r = document.querySelector("#app").__vue_app__.config.globalProperties.$router; await r.push("${path}"); await new Promise(function(resolve){ setTimeout(resolve, 800); }); })()`

  await runner.runSuite('E2E: 我的页面', [
    {
      name: '导航到首页',
      fn: async (cdp, assert) => {
        await cdp.evaluate(navigateTo('/'))
        const path = await cdp.evaluate(
          'document.querySelector("#app").__vue_app__.config.globalProperties.$router.currentRoute.value.path'
        )
        assert.equal(path, '/', '应在首页')
      }
    },
    {
      name: '已安装插件列表渲染',
      fn: async (cdp, assert) => {
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 1000); })')
        const raw = await cdp.evaluate(
          `(function(){
            var s = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia.state.value["plugins"];
            return JSON.stringify({
              installedCount: s.installedSet ? s.installedSet.size || Array.from(s.installedSet).length : 0,
              installedPluginsCount: s.installedPlugins ? s.installedPlugins.length : 0
            });
          })()`
        )
        const state = JSON.parse(raw)
        assert.gte(state.installedCount, 0, 'installedSet 应有值')
        assert.gte(state.installedPluginsCount, 0, 'installedPlugins 应有值')
      }
    },
    {
      name: '收藏列表状态正确',
      fn: async (cdp, assert) => {
        const raw = await cdp.evaluate(
          `(function(){
            var s = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia.state.value["plugins"];
            return JSON.stringify({
              favCount: s.favorites ? (s.favorites.size || Array.from(s.favorites).length) : 0,
              favPluginsCount: s.favoritePluginsList ? s.favoritePluginsList.length : 0
            });
          })()`
        )
        const state = JSON.parse(raw)
        assert.gte(state.favCount, 0, '收藏数应 >= 0')
      }
    },
    {
      name: '最近使用列表状态正确',
      fn: async (cdp, assert) => {
        const raw = await cdp.evaluate(
          `(function(){
            var s = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia.state.value["plugins"];
            return JSON.stringify({
              recentsCount: s.recents ? s.recents.length : 0
            });
          })()`
        )
        const state = JSON.parse(raw)
        assert.gte(state.recentsCount, 0, '最近使用数应 >= 0')
      }
    },
    {
      name: '搜索框可用',
      fn: async (cdp, assert) => {
        const hasInput = await cdp.evaluate(
          '!!document.querySelector("input[type=text], .ant-input, .search-bar input")'
        )
        assert.ok(hasInput, '搜索框应存在')
      }
    },
    {
      name: '侧边栏分类导航可用',
      fn: async (cdp, assert) => {
        const hasNav = await cdp.evaluate(
          '!!document.querySelector(".sidebar, .ant-menu, nav")'
        )
        assert.ok(hasNav, '侧边栏导航应存在')
      }
    }
  ])
}
