/**
 * E2E 测试 - 高级设置功能
 * 测试设置项读取、修改、保存、冲突检测等
 */

module.exports = async (runner) => {
  const navigateTo = (path) =>
    `(async function(){ var r = document.querySelector("#app").__vue_app__.config.globalProperties.$router; await r.push("${path}"); await new Promise(function(resolve){ setTimeout(resolve, 800); }); })()`

  await runner.runSuite('E2E: 高级设置', [
    {
      name: '导航到设置页',
      fn: async (cdp, assert) => {
        await cdp.evaluate(navigateTo('/advanced-settings'))
        const path = await cdp.evaluate(
          'document.querySelector("#app").__vue_app__.config.globalProperties.$router.currentRoute.value.path'
        )
        assert.equal(path, '/advanced-settings', '应导航到设置页')
      }
    },
    {
      name: '设置页渲染正确',
      fn: async (cdp, assert) => {
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 500); })')
        const hasPage = await cdp.evaluate(
          '!!document.querySelector(".settings-page, .settings-container")'
        )
        assert.ok(hasPage, '设置页应正确渲染')
      }
    },
    {
      name: '设置卡片存在',
      fn: async (cdp, assert) => {
        const cardCount = await cdp.evaluate(
          'document.querySelectorAll(".settings-card").length'
        )
        assert.gte(cardCount, 2, '应至少有 2 个设置卡片')
      }
    },
    {
      name: '读取开机自启动设置',
      fn: async (cdp, assert) => {
        const val = await cdp.evaluate(
          '(async function(){ return await ztools.config.get("system.autostart", "false"); })()'
        )
        assert.ok(val === 'true' || val === 'false', '自启动应为布尔字符串')
      }
    },
    {
      name: '修改并恢复关闭确认设置',
      fn: async (cdp, assert) => {
        // 读取当前值
        const original = await cdp.evaluate(
          '(async function(){ return await ztools.config.get("system.closeConfirm", "true"); })()'
        )
        // 切换
        const newVal = original === 'true' ? 'false' : 'true'
        await cdp.evaluate(
          `(async function(){ await ztools.config.set("system.closeConfirm", "${newVal}", true); })()`
        )
        // 验证
        const changed = await cdp.evaluate(
          '(async function(){ return await ztools.config.get("system.closeConfirm", "true"); })()'
        )
        assert.equal(changed, newVal, '设置应已修改')
        // 恢复
        await cdp.evaluate(
          `(async function(){ await ztools.config.set("system.closeConfirm", "${original}", true); })()`
        )
        const restored = await cdp.evaluate(
          '(async function(){ return await ztools.config.get("system.closeConfirm", "true"); })()'
        )
        assert.equal(restored, original, '设置应已恢复')
      }
    },
    {
      name: '修改并恢复最小化到托盘设置',
      fn: async (cdp, assert) => {
        const original = await cdp.evaluate(
          '(async function(){ return await ztools.config.get("system.minimizeToTray", "true"); })()'
        )
        const newVal = original === 'true' ? 'false' : 'true'
        await cdp.evaluate(
          `(async function(){ await ztools.config.set("system.minimizeToTray", "${newVal}", true); })()`
        )
        const changed = await cdp.evaluate(
          '(async function(){ return await ztools.config.get("system.minimizeToTray", "true"); })()'
        )
        assert.equal(changed, newVal, '托盘设置应已修改')
        // 恢复
        await cdp.evaluate(
          `(async function(){ await ztools.config.set("system.minimizeToTray", "${original}", true); })()`
        )
      }
    },
    {
      name: '读取全局唤醒快捷键',
      fn: async (cdp, assert) => {
        const hotkey = await cdp.evaluate(
          '(async function(){ return await ztools.config.get("hotkey.global", ""); })()'
        )
        assert.typeOf(hotkey, 'string', '快捷键应为字符串')
      }
    },
    {
      name: '读取超级面板配置',
      fn: async (cdp, assert) => {
        const raw = await cdp.evaluate(
          '(async function(){ var c = await ztools.config.get("super_panel"); return JSON.stringify(c); })()'
        )
        if (!raw || raw === 'null' || raw === 'undefined') {
          console.log('    ℹ️  超级面板配置为空，跳过')
          return
        }
        const config = JSON.parse(raw)
        assert.ok(config, '超级面板配置不应为空')
        // 检查关键字段
        assert.ok('enabled' in config, '应有 enabled 字段')
      }
    },
    {
      name: '主题切换 Switch 存在',
      fn: async (cdp, assert) => {
        const hasTheme = await cdp.evaluate(
          '!!document.querySelector(".theme-switcher, .theme-btn")'
        )
        assert.ok(hasTheme, '主题切换控件应存在')
      }
    }
  ])

  // 回到首页
  await runner.cdp.evaluate(navigateTo('/'))
}
