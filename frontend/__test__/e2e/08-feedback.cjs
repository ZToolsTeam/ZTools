/**
 * E2E 测试 - 反馈建议（需求墙）功能
 * 测试反馈列表加载、筛选、投票、内联提交等
 */

module.exports = async (runner) => {
  const navigateTo = (path) =>
    `(async function(){ var r = document.querySelector("#app").__vue_app__.config.globalProperties.$router; await r.push("${path}"); await new Promise(function(resolve){ setTimeout(resolve, 800); }); })()`

  await runner.runSuite('E2E: 反馈建议', [
    {
      name: '导航到反馈页',
      fn: async (cdp, assert) => {
        await cdp.evaluate(navigateTo('/wish-wall'))
        const path = await cdp.evaluate(
          'document.querySelector("#app").__vue_app__.config.globalProperties.$router.currentRoute.value.path'
        )
        assert.equal(path, '/wish-wall', '应导航到反馈页')
      }
    },
    {
      name: '反馈页渲染正确',
      fn: async (cdp, assert) => {
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 1000); })')
        const hasPage = await cdp.evaluate(
          '!!document.querySelector(".wish-wall-page, .wish-container")'
        )
        assert.ok(hasPage, '反馈页应正确渲染')
      }
    },
    {
      name: '内联提交区存在',
      fn: async (cdp, assert) => {
        const hasSubmitArea = await cdp.evaluate(
          '!!document.querySelector(".feedback-editor") && !!document.querySelector(".inline-submit-btn")'
        )
        assert.ok(hasSubmitArea, '内联提交编辑框和提交按钮应存在')
      }
    },
    {
      name: '筛选栏存在且有状态下拉',
      fn: async (cdp, assert) => {
        const hasStatusSelect = await cdp.evaluate(
          '!!document.querySelector(".status-select")'
        )
        assert.ok(hasStatusSelect, '筛选栏应显示状态下拉框')
      }
    },
    {
      name: '反馈列表加载完成',
      fn: async (cdp, assert) => {
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 1500); })')
        const state = await cdp.evaluate(
          `(function(){
            var hasLoading = !!document.querySelector(".loading-state");
            var hasEmpty = !!document.querySelector(".empty-state");
            var hasRows = !!document.querySelector(".feedback-item, .feedback-table");
            return JSON.stringify({ hasLoading: hasLoading, hasEmpty: hasEmpty, hasRows: hasRows });
          })()`
        )
        const s = JSON.parse(state)
        assert.ok(!s.hasLoading, '加载应已完成')
        assert.ok(s.hasEmpty || s.hasRows, '应显示空状态或反馈行')
      }
    },
    {
      name: '切换状态筛选',
      fn: async (cdp, assert) => {
        const opened = await cdp.evaluate(
          `(function(){
            var trigger = document.querySelector(".status-select .ant-select-selector");
            if (!trigger) return false;
            trigger.click();
            return true;
          })()`
        )
        assert.ok(opened, '应打开状态下拉框')
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 300); })')
        const clicked = await cdp.evaluate(
          `(function(){
            var options = document.querySelectorAll(".ant-select-item-option");
            for (var i = 0; i < options.length; i++) {
              if (options[i].textContent.trim().indexOf("已通过") >= 0) {
                options[i].click();
                return true;
              }
            }
            return false;
          })()`
        )
        assert.ok(clicked, '应找到并点击"已通过"选项')
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 1000); })')
        const activeText = await cdp.evaluate(
          '(function(){ var a = document.querySelector(".status-select .ant-select-selection-item"); return a ? a.textContent.trim() : ""; })()'
        )
        assert.includes(activeText, '已通过', '状态下拉应显示"已通过"')
      }
    },
    {
      name: '切换回全部状态',
      fn: async (cdp, assert) => {
        await cdp.evaluate(
          `(function(){
            var trigger = document.querySelector(".status-select .ant-select-selector");
            if (trigger) trigger.click();
          })()`
        )
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 300); })')
        await cdp.evaluate(
          `(function(){
            var options = document.querySelectorAll(".ant-select-item-option");
            for (var i = 0; i < options.length; i++) {
              if (options[i].textContent.trim().indexOf("全部") >= 0) {
                options[i].click();
                return;
              }
            }
          })()`
        )
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 500); })')
      }
    },
    {
      name: '反馈行有点赞按钮',
      fn: async (cdp, assert) => {
        const hasVoteBtn = await cdp.evaluate(
          '!!document.querySelector(".vote-btn")'
        )
        const hasEmpty = await cdp.evaluate(
          '!!document.querySelector(".empty-state")'
        )
        if (hasEmpty) {
          console.log('    ℹ️  反馈列表为空，跳过投票按钮检查')
          return
        }
        assert.ok(hasVoteBtn, '反馈行应有点赞按钮')
      }
    },
    {
      name: '点击内联提交触发提交或登录',
      fn: async (cdp, assert) => {
        await cdp.evaluate(
          `(function(){
            var editor = document.querySelector(".feedback-editor");
            if (editor) {
              editor.value = "自动化测试反馈";
              editor.dispatchEvent(new Event("input", { bubbles: true }));
            }
          })()`
        )
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 100); })')
        await cdp.evaluate(
          '(function(){ var btn = document.querySelector(".inline-submit-btn"); if(btn) btn.click(); })()'
        )
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 500); })')
        const state = await cdp.evaluate(
          `(function(){
            var hasModal = !!document.querySelector(".modal-overlay, .modal-content");
            var hasLoginModal = !!document.querySelector(".ant-modal, .login-modal");
            var uiStore = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia.state.value["ui"];
            var userStore = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia.state.value["user"];
            var showLogin = uiStore ? uiStore.showLoginModal : false;
            var loggedIn = userStore ? userStore.isLoggedIn : false;
            return JSON.stringify({ hasModal: hasModal, hasLoginModal: hasLoginModal, showLogin: showLogin, loggedIn: loggedIn });
          })()`
        )
        const s = JSON.parse(state)
        assert.ok(!s.hasModal, '不应再弹出提交弹窗')
        if (!s.loggedIn) {
          assert.ok(s.showLogin || s.hasLoginModal, '未登录时应弹出登录弹窗')
        }
        await cdp.evaluate(
          `(function(){
            var uiStore = document.querySelector("#app").__vue_app__.config.globalProperties.$pinia.state.value["ui"];
            if (uiStore) uiStore.showLoginModal = false;
          })()`
        )
        await cdp.evaluate('new Promise(function(r){ setTimeout(r, 300); })')
      }
    }
  ])

  // 回到首页
  await runner.cdp.evaluate(navigateTo('/'))
}
