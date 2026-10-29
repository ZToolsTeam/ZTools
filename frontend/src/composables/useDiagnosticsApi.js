/**
 * 诊断中心用到的宿主接口：诊断页需要逐个调用底层接口做体检，统一从这里取，页面视图层不直接依赖 api 层。
 */
import {
  isNative,
  sys,
  fs,
  win,
  network,
  process,
  screen,
  simulate,
  db,
  privileged,
  trigger,
  protocol,
  storageGet,
  storageSet,
  storageDelete,
  getLocalPlugins,
  openPlugin,
  getDllPluginList,
  callDllPlugin,
  installPluginNative,
  uninstallPluginNative
} from '@/api/native'
import { getMarketPlugins, getPluginDetails, getDownloadSign } from '@/api/apiserver'

/** 按 ztools:// 协议地址读取文本（协议读取体检用），请求失败时抛出原始错误由体检项记录 */
export async function readProtocolText(url) {
  const response = await fetch(url)
  return response.text()
}

export function useDiagnosticsApi() {
  return {
    isNative,
    sys,
    fs,
    win,
    network,
    process,
    screen,
    simulate,
    db,
    privileged,
    trigger,
    protocol,
    storageGet,
    storageSet,
    storageDelete,
    getLocalPlugins,
    openPlugin,
    getDllPluginList,
    callDllPlugin,
    installPluginNative,
    uninstallPluginNative,
    getMarketPlugins,
    getPluginDetails,
    getDownloadSign,
    readProtocolText
  }
}
