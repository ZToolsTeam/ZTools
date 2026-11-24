import { usePluginsStore } from '@/stores/plugins'
import { useToast } from '@/composables/useToast'
import { isPluginVersionIncompatibleError, getPluginVersionIncompatibleMessage } from '@/api/apiserver'
import { isBundledPlugin } from '@/utils/bundledPlugins'
import { onAuthRequired } from '@edition'
import { resolveErrorMessage, resolveResponseMessage } from '@/utils/errorMessage'
import { t } from '@/i18n'

/** 统一安装入口反馈，只有核验成功才显示完成。登录等入口前置条件由调用方提供。 */
export function usePluginInstall() {
  const store = usePluginsStore()
  const { toastSuccess, toastWarning, toastError } = useToast()
  async function installWithFeedback(pluginId, beforeInstall) {
    if (!pluginId) return
    if (store.isRevoked(pluginId)) {
      toastError(t('market.install.cannotInstall', { reason: store.getRevokedReason(pluginId) || t('market.revokedDefaultReason') }))
      return
    }
    // 已被用户假卸载（隐藏）的内置插件：无需登录或远程下载，直接本地一键还原
    if (isBundledPlugin(pluginId) && store.isBundledHidden(pluginId)) {
      if (store.isTogglingBundled(pluginId)) return
      try {
        const res = await store.restoreBundledPlugin(pluginId)
        if (res?.success) toastSuccess(t('market.install.bundledRestored'))
      } catch (error) {
        toastError(t('market.install.restoreFailed', { reason: resolveErrorMessage(error, 'common.unknownError') }))
      }
      return
    }
    if (store.isInstalling(pluginId)) {
      toastWarning(t('market.install.alreadyInstalling'))
      return
    }
    try {
      if (beforeInstall && !(await beforeInstall())) return
      toastSuccess(t('market.install.installingToast'))
      const result = await store.installPlugin(pluginId, { autoOpen: true })
      if (result?.success) toastSuccess(t('market.install.installComplete'))
      else toastWarning(resolveResponseMessage(result, 'market.install.installPendingVerify'))
    } catch (error) {
      if (isPluginVersionIncompatibleError(error)) toastWarning(getPluginVersionIncompatibleMessage(error))
      else if (!onAuthRequired(error, { action: 'install' })) toastError(t('market.installFailed', { reason: resolveErrorMessage(error, 'common.unknownError') }))
    }
  }
  return { installWithFeedback }
}
