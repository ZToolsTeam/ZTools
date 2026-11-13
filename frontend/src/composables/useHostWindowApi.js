/**
 * 声明式插件页用到的宿主窗口控制（调整窗口尺寸、窗口置顶），页面视图层不直接依赖 api 层。
 * 优先使用 preload 注入的 window.ztools.window（旧名 win）；不可用时再按需加载 api 层兜底，
 * 保持懒加载，不把 api 层带进声明式插件页的首屏依赖。
 */
const loadHostApi = () => import('@/api/apiserver')

/** preload 注入的窗口接口；非浏览器环境或未注入时为 null */
function getPreloadWindowApi() {
  if (typeof window === 'undefined') return null
  return window.ztools?.window || window.ztools?.win || null
}

const hostWindowApi = Object.freeze({
  async setSize(width, height, animate) {
    const preload = getPreloadWindowApi()
    if (preload?.setSize) return await preload.setSize(width, height, animate)
    const api = await loadHostApi()
    return await api.win.setSize(width, height, animate)
  },
  async setAlwaysOnTop(flag) {
    const preload = getPreloadWindowApi()
    if (preload?.setAlwaysOnTop) return await preload.setAlwaysOnTop(flag)
    const api = await loadHostApi()
    return await api.win.setAlwaysOnTop(flag)
  }
})

export function useHostWindowApi() {
  return hostWindowApi
}
