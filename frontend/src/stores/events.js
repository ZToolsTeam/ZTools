import { defineStore } from 'pinia'
import { usePluginsStore } from './plugins'
import { useUIStore } from './ui'
import { useThemeStore } from './theme'

export const useEventsStore = defineStore('events', {
  state: () => ({
    initialized: false
  }),
  actions: {
    async init() {
      if (this.initialized) return
      this.initialized = true

      if (window.ztools && window.ztools.events) {
        try {
          // 订阅全局事件（非阻塞，不需要 await）
          window.ztools.events
            .subscribe('plugin_install_complete')
            .catch((err) => console.warn('[EventsStore] 订阅 plugin_install_complete 失败:', err))
          window.ztools.events
            .subscribe('plugin_uninstalled')
            .catch((err) => console.warn('[EventsStore] 订阅 plugin_uninstalled 失败:', err))
          window.ztools.events
            .subscribe('ui_close_confirm_request')
            .catch((err) => console.warn('[EventsStore] 订阅 ui_close_confirm_request 失败:', err))
          window.ztools.events
            .subscribe('system.DarkModeChange')
            .catch((err) => console.warn('[EventsStore] 订阅 system.DarkModeChange 失败:', err))
          window.ztools.events
            .subscribe('plugin_not_installed')
            .catch((err) => console.warn('[EventsStore] 订阅 plugin_not_installed 失败:', err))

          window.ztools.events.on(
            'plugin_install_complete',
            this.handleInstallComplete
          )
          window.ztools.events.on(
            'plugin_uninstalled',
            this.handleUninstallComplete
          )
          window.ztools.events.on(
            'ui_close_confirm_request',
            this.handleCloseConfirmRequest
          )
          window.ztools.events.on(
            'system.DarkModeChange',
            this.handleDarkModeChange
          )
          window.ztools.events.on(
            'plugin_not_installed',
            this.handlePluginNotInstalled
          )
        } catch (e) {
          console.error('Failed to init global events:', e)
        }
      }
    },

    destroy() {
      if (!this.initialized) return
      this.initialized = false
      if (window.ztools && window.ztools.events) {
        window.ztools.events.off(
          'plugin_install_complete',
          this.handleInstallComplete
        )
        window.ztools.events.off(
          'plugin_uninstalled',
          this.handleUninstallComplete
        )
        window.ztools.events.off(
          'ui_close_confirm_request',
          this.handleCloseConfirmRequest
        )
        window.ztools.events.off(
          'system.DarkModeChange',
          this.handleDarkModeChange
        )
        window.ztools.events.off(
          'plugin_not_installed',
          this.handlePluginNotInstalled
        )
      }
    },

    handleInstallComplete(envelope) {
      const pluginsStore = usePluginsStore()
      pluginsStore.onInstallComplete(envelope?.payload)
    },

    handleUninstallComplete(envelope) {
      const pluginsStore = usePluginsStore()
      pluginsStore.onUninstallComplete(envelope?.payload)
    },

    handleCloseConfirmRequest(envelope) {
      const uiStore = useUIStore()
      const payload = envelope?.payload || {}
      const origin = payload.origin || 'closeButton'
      uiStore.openCloseConfirm(origin)
    },

    handleDarkModeChange(envelope) {
      const themeStore = useThemeStore()
      try {
        const payload = envelope?.payload || {}
        const isDark = !!(
          payload.isDark ??
          payload.dark ??
          payload.enabled ??
          payload.value
        )
        themeStore.handleSystemThemeChange(isDark, payload.mode)
      } catch (e) {
        console.error('[EventsStore] 处理系统主题变更失败:', e)
      }
    },

    handlePluginNotInstalled(envelope) {
      // 处理插件未安装事件，导航到插件详情页
      try {
        const payload = envelope?.payload || {}
        const pluginId = payload.pluginId
        const error = payload.error || '插件未安装'

        if (!pluginId) {
          console.warn('[EventsStore] plugin_not_installed 事件缺少 pluginId')
          return
        }

        // console.log(`[EventsStore] 插件未安装: ${pluginId}, 错误: ${error}, 导航到详情页`)

        // 动态导入 router 和 toast，避免循环依赖
        import('../router/index.js').then(({ default: router }) => {
          import('../router/routes.js').then(({ routeUtils }) => {
            import('../composables/useToast.js').then(({ useToast }) => {
              const { toastWarning } = useToast()
              toastWarning(error + '，请重新下载该插件')
              router.push(routeUtils.toPluginDetails(pluginId))
            })
          })
        })
      } catch (e) {
        console.error('[EventsStore] 处理插件未安装事件失败:', e)
      }
    }
  }
})
