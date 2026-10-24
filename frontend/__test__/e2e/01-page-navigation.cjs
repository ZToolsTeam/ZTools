/**
 * E2E 测试 - 页面导航
 * 测试 Vue Router 页面切换、DOM 渲染状态
 */

module.exports = async (runner) => {
  await runner.runSuite('E2E: 页面导航', [
    {
      name: 'Vue 应用已挂载',
      fn: async (cdp, assert) => {
        const mounted = await cdp.evaluate('!!document.querySelector("#app")')
        assert.ok(mounted, '#app 元素应存在')
      }
    },
    {
      name: 'Vue Router 可用',
      fn: async (cdp, assert) => {
        const hasRouter = await cdp.evaluate(
          '!!(document.querySelector("#app").__vue_app__ && document.querySelector("#app").__vue_app__.config.globalProperties.$router)'
        )
        assert.ok(hasRouter, 'Vue Router 应已注册')
      }
    },
    {
      name: '获取当前路由路径',
      fn: async (cdp, assert) => {
        const path = await cdp.evaluate(
          'document.querySelector("#app").__vue_app__.config.globalProperties.$router.currentRoute.value.path'
        )
        assert.ok(path, '当前路由路径不应为空')
        assert.typeOf(path, 'string', '路由路径应为字符串')
      }
    },
    {
      name: '导航到插件列表页',
      fn: async (cdp, assert) => {
        await cdp.evaluate(
          '(async()=>{ await document.querySelector("#app").__vue_app__.config.globalProperties.$router.push("/"); await new Promise(r=>setTimeout(r,500)); })()'
        )
        const path = await cdp.evaluate(
          'document.querySelector("#app").__vue_app__.config.globalProperties.$router.currentRoute.value.path'
        )
        assert.equal(path, '/', '应导航到首页')
      }
    },
    {
      name: '导航到关于页面',
      fn: async (cdp, assert) => {
        await cdp.evaluate(
          '(async()=>{ await document.querySelector("#app").__vue_app__.config.globalProperties.$router.push("/about"); await new Promise(r=>setTimeout(r,500)); })()'
        )
        const path = await cdp.evaluate(
          'document.querySelector("#app").__vue_app__.config.globalProperties.$router.currentRoute.value.path'
        )
        assert.equal(path, '/about', '应导航到关于页面')
      }
    },
    {
      name: '导航回首页',
      fn: async (cdp, assert) => {
        await cdp.evaluate(
          '(async()=>{ await document.querySelector("#app").__vue_app__.config.globalProperties.$router.push("/"); await new Promise(r=>setTimeout(r,500)); })()'
        )
        const path = await cdp.evaluate(
          'document.querySelector("#app").__vue_app__.config.globalProperties.$router.currentRoute.value.path'
        )
        assert.equal(path, '/', '应回到首页')
      }
    }
  ])
}
