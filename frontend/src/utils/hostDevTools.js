/**
 * 宿主窗口的 Chromium 开发者工具：只在开发版（未打包）可用，正式版一律不打开。
 * 正式版不给普通用户留执行任意代码的入口；开发者排查插件按文档用 --remote-debugging-port 连接。
 */

/** 是否为开发版；读取失败按正式版处理 */
export async function isHostDevBuild() {
  try {
    return (await window.ztools?.sys?.isDev?.()) === true
  } catch (err) {
    console.warn('[hostDevTools] 读取开发版标记失败:', err)
    return false
  }
}

/** 开发版切换开发者工具；正式版或接口不可用时返回 false，不做任何事 */
export async function toggleHostDevTools() {
  const toggle = window.ztools?.window?.toggleDevTools
  if (typeof toggle !== 'function' || !(await isHostDevBuild())) return false
  try {
    await toggle.call(window.ztools.window)
    return true
  } catch (err) {
    console.warn('[hostDevTools] 切换开发者工具失败:', err)
    return false
  }
}
