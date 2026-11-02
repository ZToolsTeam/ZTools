/**
 * 设置页用到的宿主偏好接口（开机启动、唤醒快捷键、托盘与退出行为），页面视图层不直接依赖 api 层。
 */
import {
  getAutostart,
  setAutostart,
  getHotkey,
  setHotkey,
  getMinimizeToTray,
  setMinimizeToTray,
  getShowTrayIcon,
  setShowTrayIcon,
  getCloseConfirm,
  setCloseConfirm
} from '@/api/apiserver'

export function useAppPreferencesApi() {
  return {
    getAutostart,
    setAutostart,
    getHotkey,
    setHotkey,
    getMinimizeToTray,
    setMinimizeToTray,
    getShowTrayIcon,
    setShowTrayIcon,
    getCloseConfirm,
    setCloseConfirm
  }
}
