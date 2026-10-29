/**
 * 内置插件统一唤起门面与注册体系
 *
 * 目标：支持设置面板的内置插件化体系，提供统一的唤起、传参与降级门面。
 * - 优先调用 window.ztools.plugin.open(pluginId, payload) 唤起原生插件；
 * - 若在纯开发调试/Web 环境，或插件唤起失败，优雅降级为本地路由组件或友好提示。
 */

import router from '@/router'

/**
 * 内置插件唯一标识
 */
export const INTERNAL_PLUGINS = Object.freeze({
  SETTINGS: 'internal-settings'
})

/**
 * 内置插件定义表（注册表）
 */
export const INTERNAL_PLUGIN_DEFINITIONS = Object.freeze({
  [INTERNAL_PLUGINS.SETTINGS]: Object.freeze({
    pluginId: INTERNAL_PLUGINS.SETTINGS,
    name: '系统设置',
    fallbackRoute: Object.freeze({ name: 'advanced-settings' })
  })
})

/**
 * 检查当前环境是否支持原生插件唤起 API
 * @returns {boolean}
 */
export function isPluginApiAvailable() {
  try {
    return (
      typeof window !== 'undefined' &&
      Boolean(window.ztools && window.ztools.plugin && typeof window.ztools.plugin.open === 'function')
    )
  } catch {
    return false
  }
}

/**
 * 校验启动载荷类型与序列化合法性（不超过 64KB）
 * @param {unknown} payload
 * @returns {Record<string, unknown> | undefined}
 */
function normalizePayload(payload) {
  if (payload === undefined || payload === null) return undefined
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('internal plugin payload 必须是一个纯对象')
  }
  let serialized
  try {
    serialized = JSON.stringify(payload)
  } catch (err) {
    throw new TypeError(`internal plugin payload 无法序列化: ${err.message}`)
  }
  if (serialized.length > 64 * 1024) {
    throw new RangeError('internal plugin payload 超过 64KB 限制')
  }
  return payload
}

/**
 * 统一唤起内置插件
 *
 * @param {string} pluginId - 内置插件 ID（如 'internal-settings'）
 * @param {Record<string, unknown>} [payload] - 启动参数对象
 * @param {Object} [options] - 选项
 * @param {import('vue-router').Router} [options.router] - 自定义路由实例（默认使用全局 router）
 * @param {Object} [options.routeOptions] - 降级路由参数（query、params）
 * @param {string} [options.prompt] - 降级提示文本
 * @returns {Promise<{ success: boolean, native?: boolean, fallback?: boolean, type?: 'native' | 'route' | 'prompt', error?: string, data?: unknown }>}
 */
export async function openInternalPlugin(pluginId, payload, options = {}) {
  if (!pluginId || typeof pluginId !== 'string') {
    throw new TypeError('pluginId 必须是非空字符串')
  }

  const validPayload = normalizePayload(payload)
  const targetRouter = options.router || router
  const def = INTERNAL_PLUGIN_DEFINITIONS[pluginId]

  // 1. 优先尝试原生插件唤起（若显式指定 preferRoute 则跳过原生插件直接走内部路由）
  if (!options.preferRoute && isPluginApiAvailable()) {
    try {
      const res = await window.ztools.plugin.open(pluginId, validPayload)
      // 若返回布尔 true 或带有 success !== false 的响应对象，表示原生插件成功唤起
      const isSuccess =
        res === true ||
        (res && typeof res === 'object' && res.success !== false)

      if (isSuccess) {
        return { success: true, native: true, type: 'native', data: res }
      }
      console.warn(`[internalPlugins] 原生插件 ${pluginId} 唤起返回失败，准备执行优雅降级:`, res)
    } catch (err) {
      console.warn(`[internalPlugins] 原生插件 ${pluginId} 唤起发生异常，准备执行优雅降级:`, err)
    }
  }

  // 2. 优雅降级：在纯 Web/开发调试环境或原生唤起失败时，降级到本地路由组件
  if (def?.fallbackRoute && targetRouter) {
    try {
      const targetRoute = {
        ...def.fallbackRoute,
        query: {
          ...(def.fallbackRoute.query || {}),
          ...(options.routeOptions?.query || {})
        },
        params: {
          ...(def.fallbackRoute.params || {}),
          ...(options.routeOptions?.params || {})
        }
      }

      // 将特定控制参数注入降级路由和全局状态
      if (validPayload) {
        if (validPayload.scrollToSuperPanelSettings) {
          targetRoute.query.scrollToSuperPanelSettings = 'true'
          window.__scrollToSuperPanelSettings = true
        }
        if (validPayload.openShortcutSettings) {
          targetRoute.query.openShortcutSettings = 'true'
          window.__openShortcutSettings = true
        }
      }

      await targetRouter.push(targetRoute)
      return { success: true, fallback: true, type: 'route', target: targetRoute }
    } catch (routeErr) {
      console.error(`[internalPlugins] 降级路由导航失败 (${pluginId}):`, routeErr)
    }
  }

  // 3. 兜底友好提示
  const promptMessage =
    options.prompt || `内置功能 [${def?.name || pluginId}] 仅在完整桌面客户端中可用`
  if (typeof window !== 'undefined' && typeof window.__ztoolsToast === 'function') {
    window.__ztoolsToast('info', promptMessage)
  } else {
    console.info(`[internalPlugins] ${promptMessage}`)
  }

  return {
    success: false,
    fallback: true,
    type: 'prompt',
    message: promptMessage
  }
}

/**
 * 唤起系统设置（门面便捷方法）
 * @param {Object} [options]
 * @param {boolean} [options.scrollToSuperPanelSettings]
 * @param {boolean} [options.openShortcutSettings]
 * @param {boolean} [options.preferRoute]
 * @param {import('vue-router').Router} [options.router]
 * @param {Object} [options.routeOptions]
 */
export async function openSettings(options = {}) {
  const payload = {}
  if (options.scrollToSuperPanelSettings) payload.scrollToSuperPanelSettings = true
  if (options.openShortcutSettings) payload.openShortcutSettings = true

  return openInternalPlugin(
    INTERNAL_PLUGINS.SETTINGS,
    Object.keys(payload).length > 0 ? payload : undefined,
    { preferRoute: true, ...options }
  )
}

/**
 * 组合式 API
 */
export function useInternalPlugins() {
  return {
    INTERNAL_PLUGINS,
    INTERNAL_PLUGIN_DEFINITIONS,
    openInternalPlugin,
    openSettings,
    isPluginApiAvailable
  }
}
