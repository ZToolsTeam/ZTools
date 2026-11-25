import { defineStore } from 'pinia'
import { usePluginsStore } from './plugins'
import { useUIStore } from './ui'
import { useThemeStore } from './theme'
import { useLocaleStore } from './locale'
import { applyExternalShellShortcuts } from '@/utils/shellShortcuts'
import { resolveErrorMessage } from '@/utils/errorMessage'
import { t } from '@/i18n'

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
          window.ztools.events.subscribe('plugin_runtime_stopped')
            .catch(err => console.warn('[EventsStore] 订阅 plugin_runtime_stopped 失败:', err))
          window.ztools.events.on('plugin_runtime_stopped', this.handlePluginRuntimeStopped)
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
            .subscribe('system.AccentColorChange')
            .catch((err) => console.warn('[EventsStore] 订阅 system.AccentColorChange 失败:', err))
          window.ztools.events
            .subscribe('system.LocaleChange')
            .catch((err) => console.warn('[EventsStore] 订阅 system.LocaleChange 失败:', err))
          window.ztools.events
            .subscribe('system.ShellShortcutsChange')
            .catch((err) => console.warn('[EventsStore] 订阅 system.ShellShortcutsChange 失败:', err))
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
            'system.AccentColorChange',
            this.handleAccentColorChange
          )
          window.ztools.events.on(
            'system.LocaleChange',
            this.handleLocaleChange
          )
          window.ztools.events.on(
            'system.ShellShortcutsChange',
            this.handleShellShortcutsChange
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
        window.ztools.events.off('plugin_runtime_stopped', this.handlePluginRuntimeStopped)
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
          'system.AccentColorChange',
          this.handleAccentColorChange
        )
        window.ztools.events.off(
          'system.LocaleChange',
          this.handleLocaleChange
        )
        window.ztools.events.off(
          'system.ShellShortcutsChange',
          this.handleShellShortcutsChange
        )
        window.ztools.events.off(
          'plugin_not_installed',
          this.handlePluginNotInstalled
        )
      }
    },

    handlePluginRuntimeStopped(envelope) {
      if (envelope?.source?.kind !== 'host') return
      usePluginsStore().onPluginRuntimeStopped(envelope.payload)
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

    handleAccentColorChange(envelope) {
      const themeStore = useThemeStore()
      try {
        const payload = envelope?.payload || {}
        const accent = payload.accent ?? payload.value
        if (typeof accent === 'string') {
          themeStore.handleExternalAccentChange(accent)
        }
      } catch (e) {
        console.error('[EventsStore] 处理主题色变更失败:', e)
      }
    },

    handleLocaleChange(envelope) {
      try {
        const localeStore = useLocaleStore()
        localeStore.applyHostLocale(envelope)
      } catch (e) {
        console.error('[EventsStore] 处理系统语言变更失败:', e)
      }
    },

    handleShellShortcutsChange(envelope) {
      try {
        applyExternalShellShortcuts(envelope?.payload)
      } catch (e) {
        console.error('[EventsStore] 处理常用快捷键变更失败:', e)
      }
    },

    handlePluginNotInstalled(envelope) {
      // 处理插件未安装事件，导航到插件详情页
      try {
        const payload = envelope?.payload || {}
        const pluginId = payload.pluginId
        const error = resolveErrorMessage(payload, 'events.pluginNotInstalled')

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
              toastWarning(t('events.pluginNotInstalledReinstall', { error }))
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
