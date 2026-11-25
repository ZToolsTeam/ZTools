/**
 * ZTools 双模态窗口协调器 (Window Mode Coordinator)
 *
 * 管理两种核心形态：
 * 1. DASHBOARD ('dashboard'): 常规应用中心大窗口 (900x600)，面向新手与全局插件管理；
 * 2. LAUNCHER  ('launcher') : 极客悬浮工具条 (680x420)，面向极客高频即时调用与全键盘流。
 */

import { reactive, readonly } from 'vue'
import { t } from '@/i18n'

export const WINDOW_MODES = Object.freeze({
  DASHBOARD: 'dashboard',
  LAUNCHER: 'launcher'
})

export const WAKE_PREFERENCES = Object.freeze({
  DASHBOARD: 'dashboard',
  LAUNCHER: 'launcher'
})

const STORAGE_KEY_PREFERENCE = 'ztools_wake_preference'
const STORAGE_KEY_FIRST_GEEK_DISCOVERED = 'ztools_geek_mode_discovered'

const state = reactive({
  currentMode: WINDOW_MODES.DASHBOARD,
  wakePreference: WAKE_PREFERENCES.LAUNCHER, // 新用户按全局热键默认呼出悬浮条（双击图标冷启动仍先展示工作台）
  isTransitioning: false,
  geekModeDiscovered: false,
  launcherInitialQuery: ''
})

/**
 * 从本地存储安全读取布尔/字符串配置
 */
function readStorage(key, fallback) {
  try {
    const val = localStorage.getItem(key)
    return val !== null ? val : fallback
  } catch {
    return fallback
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 忽略异常
  }
}

let unsubscribeHotkey = null

/**
 * 初始化偏好设置与热键联动
 */
export function initWindowMode() {
  const savedPref = readStorage(STORAGE_KEY_PREFERENCE, WAKE_PREFERENCES.LAUNCHER)
  state.wakePreference = [WAKE_PREFERENCES.DASHBOARD, WAKE_PREFERENCES.LAUNCHER].includes(savedPref)
    ? savedPref
    : WAKE_PREFERENCES.LAUNCHER

  const discovered = readStorage(STORAGE_KEY_FIRST_GEEK_DISCOVERED, 'false')
  state.geekModeDiscovered = discovered === 'true'

  // 以宿主 user_settings.json 为权威信源：若已有显式配置则优先回填，绝不用空 localStorage 覆盖老用户偏好
  if (typeof window !== 'undefined' && window.ztools?.config) {
    if (typeof window.ztools.config.get === 'function') {
      Promise.resolve(window.ztools.config.get('ui.wake_preference', '__UNSET__'))
        .then((hostPref) => {
          const normalized = typeof hostPref === 'string' ? hostPref.trim() : ''
          if (normalized === WAKE_PREFERENCES.DASHBOARD || normalized === WAKE_PREFERENCES.LAUNCHER) {
            state.wakePreference = normalized
            writeStorage(STORAGE_KEY_PREFERENCE, normalized)
            return
          }
          if (typeof window.ztools?.config?.set === 'function') {
            window.ztools.config
              .set('ui.wake_preference', state.wakePreference, true, 'user_settings.json')
              .catch(() => {})
          }
        })
        .catch(() => {})
    } else if (typeof window.ztools.config.set === 'function') {
      window.ztools.config.set('ui.wake_preference', state.wakePreference, true, 'user_settings.json').catch(() => {})
    }
  }

  if (typeof unsubscribeHotkey === 'function') {
    unsubscribeHotkey()
    unsubscribeHotkey = null
  }

  // 监听全局唤醒热键事件（仅在单窗口降级模式下由渲染进程切换，独立原生窗口模式由主进程 toggleMainWindow 统一调度，避免双端竞态抢焦点）
  if (typeof window !== 'undefined' && window.ztools?.events?.on) {
    const off = window.ztools.events.on('hotkey_triggered', (data) => {
      if (typeof window !== 'undefined' && window.__ztoolsLauncher) {
        return
      }
      const triggerId = data?.id || data?.payload?.id
      if (triggerId === 'global_wake_hotkey') {
        if (state.wakePreference === WAKE_PREFERENCES.LAUNCHER && state.currentMode !== WINDOW_MODES.LAUNCHER) {
          switchWindowMode(WINDOW_MODES.LAUNCHER).catch(() => {})
        } else if (state.wakePreference === WAKE_PREFERENCES.DASHBOARD && state.currentMode !== WINDOW_MODES.DASHBOARD) {
          switchWindowMode(WINDOW_MODES.DASHBOARD).catch(() => {})
        }
      }
    })
    if (typeof off === 'function') {
      unsubscribeHotkey = off
    }
  }
}

/**
 * 重置状态（供测试或重新初始化使用）
 */
export function _resetWindowModeForTesting() {
  if (typeof unsubscribeHotkey === 'function') {
    unsubscribeHotkey()
    unsubscribeHotkey = null
  }
  state.currentMode = WINDOW_MODES.DASHBOARD
  state.wakePreference = WAKE_PREFERENCES.LAUNCHER
  state.isTransitioning = false
  state.geekModeDiscovered = false
  state.launcherInitialQuery = ''
}

/**
 * 设置唤醒偏好
 * @param {'dashboard' | 'launcher'} preference
 */
export function setWakePreference(preference) {
  if (![WAKE_PREFERENCES.DASHBOARD, WAKE_PREFERENCES.LAUNCHER].includes(preference)) {
    throw new Error(t('settings.shortcuts.wakePreference.invalid', { preference: String(preference) }))
  }
  state.wakePreference = preference
  writeStorage(STORAGE_KEY_PREFERENCE, preference)
  if (typeof window !== 'undefined' && window.ztools?.config?.set) {
    window.ztools.config.set('ui.wake_preference', preference, true, 'user_settings.json').catch(() => {})
  }
}

/**
 * 标记用户已发现/体验过极客条
 */
export function markGeekModeDiscovered() {
  state.geekModeDiscovered = true
  writeStorage(STORAGE_KEY_FIRST_GEEK_DISCOVERED, 'true')
}

/**
 * 切换窗口形态
 * @param {'dashboard' | 'launcher'} targetMode 
 * @param {object} [options]
 * @param {string} [options.initialQuery] 传递给工具条的初始查询词
 * @returns {Promise<boolean>}
 */
export async function switchWindowMode(targetMode, options = {}) {
  if (state.isTransitioning) return false
  if (![WINDOW_MODES.DASHBOARD, WINDOW_MODES.LAUNCHER].includes(targetMode)) {
    console.warn(`[WindowMode] 未知目标模式: ${targetMode}`)
    return false
  }

  state.isTransitioning = true
  try {
    if (targetMode === WINDOW_MODES.LAUNCHER) {
      markGeekModeDiscovered()
      state.launcherInitialQuery = typeof options.initialQuery === 'string' ? options.initialQuery : ''
      state.currentMode = WINDOW_MODES.LAUNCHER

      // 优先呼出独立原生极客悬浮窗
      if (typeof window !== 'undefined' && window.__ztoolsLauncher?.show) {
        try {
          await window.__ztoolsLauncher.show()
        } catch (e) {
          console.warn('[WindowMode] 呼出极客悬浮窗失败:', e)
        }
      } else if (typeof window !== 'undefined' && window.ztools?.window?.setSize) {
        // 兼容单窗口降级或测试替身
        try {
          await window.ztools.window.setSize({
            width: 680,
            height: 440,
            animate: true
          })
        } catch (e) {
          console.warn('[WindowMode] 调整极客条窗口尺寸失败:', e)
        }
      }
    } else {
      state.launcherInitialQuery = ''
      state.currentMode = WINDOW_MODES.DASHBOARD

      // 展开回原生大工作台
      if (typeof window !== 'undefined' && window.__ztoolsLauncher?.expandToDashboard) {
        try {
          await window.__ztoolsLauncher.expandToDashboard()
        } catch (e) {
          console.warn('[WindowMode] 展开大工作台失败:', e)
        }
      } else if (typeof window !== 'undefined' && window.ztools?.window?.setSize) {
        // 兼容单窗口降级或测试替身
        try {
          await window.ztools.window.setSize({
            width: 900,
            height: 600,
            animate: true
          })
        } catch (e) {
          console.warn('[WindowMode] 调整大窗口尺寸失败:', e)
        }
      }
    }
    return true
  } finally {
    state.isTransitioning = false
  }
}

/**
 * 对外暴露响应式状态
 */
export const windowModeState = readonly(state)
