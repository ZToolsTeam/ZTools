/**
 * API 测试 - 窗口控制 API (ztools.win)
 * 测试窗口操作（只测试安全的只读操作，避免影响 UI 状态）
 */

module.exports = async (runner) => {
  await runner.runSuite('API: 窗口控制', [
    {
      name: 'win.getBounds 获取窗口位置和大小',
      fn: async (cdp, assert) => {
        const bounds = await cdp.evaluateJSON('(async()=>await ztools.win.getBounds())()')
        assert.ok(bounds, '窗口边界信息不应为空')
        // 通常包含 x, y, width, height
        if (bounds.width !== undefined) {
          assert.gt(bounds.width, 0, '窗口宽度应大于 0')
          assert.gt(bounds.height, 0, '窗口高度应大于 0')
        }
      }
    },
    {
      name: 'win 模块方法存在性检查',
      fn: async (cdp, assert) => {
        const methods = await cdp.evaluateJSON(`(function(){
          var w = ztools.win;
          return {
            minimize: typeof w.minimize,
            maximize: typeof w.maximize,
            close: typeof w.close,
            setAlwaysOnTop: typeof w.setAlwaysOnTop,
            setOpacity: typeof w.setOpacity,
            getBounds: typeof w.getBounds,
            setSize: typeof w.setSize
          };
        })()`)
        assert.equal(methods.minimize, 'function', 'minimize 应为函数')
        assert.equal(methods.maximize, 'function', 'maximize 应为函数')
        assert.equal(methods.getBounds, 'function', 'getBounds 应为函数')
      }
    }
  ])
}
