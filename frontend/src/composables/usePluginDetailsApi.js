/**
 * 插件详情页用到的插件接口（读取详情、检查与下载更新、卸载、生成桌面快捷方式），页面视图层不直接依赖 api 层。
 */
import {
  getPluginDetails,
  checkPluginUpdate,
  downloadPluginUpdate,
  uninstallPluginNative,
  createShortcut
} from '@/api/apiserver'

export function usePluginDetailsApi() {
  return {
    getPluginDetails,
    checkPluginUpdate,
    downloadPluginUpdate,
    uninstallPluginNative,
    createShortcut
  }
}
