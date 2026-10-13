/**
 * E2E 测试 - Pinia Store 状态
 * 测试各 Store 的初始化和数据加载
 */

module.exports = async (runner) => {
  // 辅助函数：通过 Vue app 获取 Pinia store
  const getStoreState = (storeId) => {
    return `(function(){
      var app = document.querySelector("#app").__vue_app__;
      var pinia = app.config.globalProperties.$pinia;
      if (!pinia) return null;
      var state = pinia.state.value["${storeId}"];
      return state ? JSON.stringify(state) : null;
    })()`
  }

  await runner.runSuite('E2E: Pinia Store 状态', [
    {
      name: 'Pinia 已初始化',
      fn: async (cdp, assert) => {
        const hasPinia = await cdp.evaluate(
          '!!(document.querySelector("#app").__vue_app__.config.globalProperties.$pinia)'
        )
        assert.ok(hasPinia, 'Pinia 应已注册')
      }
    },
    {
      name: 'plugins store 存在',
      fn: async (cdp, assert) => {
        const state = await cdp.evaluate(getStoreState('plugins'))
        assert.ok(state, 'plugins store 应存在')
        const parsed = JSON.parse(state)
        assert.ok('items' in parsed || 'list' in parsed || 'plugins' in parsed, 'plugins store 应有列表字段')
      }
    },
    {
      name: 'theme store 存在',
      fn: async (cdp, assert) => {
        const state = await cdp.evaluate(getStoreState('theme'))
        assert.ok(state, 'theme store 应存在')
      }
    },
    {
      name: 'user store 存在',
      fn: async (cdp, assert) => {
        const state = await cdp.evaluate(getStoreState('user'))
        assert.ok(state, 'user store 应存在')
      }
    },
    {
      name: 'ui store 存在',
      fn: async (cdp, assert) => {
        const state = await cdp.evaluate(getStoreState('ui'))
        assert.ok(state, 'ui store 应存在')
      }
    }
  ])
}
