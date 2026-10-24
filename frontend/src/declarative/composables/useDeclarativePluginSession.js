/**
 * 挂载点持有当前显示插件的会话（DeclarativePage / LauncherBar 共用）。
 *
 * - 插件对象一出现就同步发起 acquire（flush: 'sync'，早于首帧渲染与插件 useEffect），
 *   插件专属通道对「正在打开」会等待，首个调用也带令牌；会话打开与首帧渲染并行，不拖慢出窗；
 * - 换插件 / 卸载时 release：holder 有宽限期并等在途调用结束，卸载过程中插件的保存调用仍带令牌；
 * - 官方内置示例（宿主代码本体，没有 session）不走会话，保持宿主身份。
 */
import { onBeforeUnmount, watch } from 'vue'

export function useDeclarativePluginSession(pluginRef) {
  let currentHolder = null
  let releaseCurrent = null
  let generation = 0

  function releaseHeld() {
    const release = releaseCurrent
    releaseCurrent = null
    currentHolder = null
    generation += 1
    if (release) release()
  }

  function hold(plugin) {
    const holder = plugin?.session
    if (holder === currentHolder) return
    releaseHeld()
    if (!holder || typeof holder.acquire !== 'function') return
    currentHolder = holder
    const myGeneration = generation
    let releasedEarly = false
    // 先占位：acquire 完成前就换插件时，等它完成后立即释放
    releaseCurrent = () => { releasedEarly = true }
    holder.acquire().then((release) => {
      if (releasedEarly || myGeneration !== generation) {
        release()
        return
      }
      releaseCurrent = release
    }, () => undefined)
  }

  watch(pluginRef, (plugin) => hold(plugin), { immediate: true, flush: 'sync' })
  onBeforeUnmount(() => {
    // 根组件卸载（插件 effect cleanup）在此之后进行；holder 的宽限期保证这些调用仍带令牌
    releaseHeld()
  })

  return { releaseHeld }
}
