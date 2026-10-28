import { usePluginsStore } from '@/stores/plugins'
import { useToast } from '@/composables/useToast'
import { isPluginVersionIncompatibleError, getPluginVersionIncompatibleMessage } from '@/api/apiserver'
import { onAuthRequired } from '@edition'

/** 统一安装入口反馈，只有核验成功才显示完成。登录等入口前置条件由调用方提供。 */
export function usePluginInstall() {
  const store = usePluginsStore()
  const { toastSuccess, toastWarning, toastError } = useToast()
  async function installWithFeedback(pluginId, beforeInstall) {
    if (!pluginId) return
    if (store.isRevoked(pluginId)) {
      toastError('无法安装：' + (store.getRevokedReason(pluginId) || '该插件已被官方下架禁用'))
      return
    }
    if (store.isInstalling(pluginId)) {
      toastWarning('该插件正在安装中，请稍候...')
      return
    }
    try {
      if (beforeInstall && !(await beforeInstall())) return
      toastSuccess('正在安装插件，请稍候...')
      const result = await store.installPlugin(pluginId, { autoOpen: true })
      if (result?.success) toastSuccess('插件安装完成')
      else toastWarning(result?.message || '安装结果待确认，请刷新插件列表查看')
    } catch (error) {
      if (isPluginVersionIncompatibleError(error)) toastWarning(getPluginVersionIncompatibleMessage(error))
      else if (!onAuthRequired(error, { action: 'install' })) toastError('安装失败: ' + (error.message || error))
    }
  }
  return { installWithFeedback }
}
