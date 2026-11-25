<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

import ThemeProvider from '@/components/ThemeProvider.vue'
import CloseConfirmModal from '@/components/CloseConfirmModal.vue'
import ContextMenu from '@/components/ContextMenu.vue'
import UpdateNotification from '@/components/UpdateNotification.vue'
import HotkeyConflictModal from '@/components/HotkeyConflictModal.vue'
import LauncherBar from '@/components/LauncherBar.vue'

import { useEventsStore } from './stores/events'
import { usePluginsStore } from './stores/plugins'
import { useAppUpdate, isUpdateUnsupported } from '@/composables/useAppUpdate'
import { onAppStart, setTrackingWebVersion } from '@edition'
import {
  DEPRECATED_PLUGIN_FEATURE_HOTKEY_ITEMS,
  getPluginFeatureHotkeyItemByTriggerId
} from '@/utils/pluginFeatureHotkeys'
import { openSettings } from '@/utils/internalPlugins'
import { toggleHostDevTools } from '@/utils/hostDevTools'
import { matchesShellShortcut } from '@/utils/shellShortcuts'
import {
  isHotkeyRecorderInput,
  isComposingEvent,
  isModalOpen,
  normalizeEventKeyCombo
} from '@/utils/keymap'
import { dispatchSyntheticRecorderHotkey } from '@/utils/hotkeyRecorder'
import { resolveErrorMessage } from '@/utils/errorMessage'
import {
  windowModeState,
  WINDOW_MODES,
  initWindowMode,
  switchWindowMode
} from '@/utils/windowMode'
import { useAppI18n } from '@/i18n'
import { getLocalizedPluginName } from '@/utils/pluginI18n'

const { t } = useAppI18n()

const isLauncherWindow = computed(() => {
  if (typeof window === 'undefined') return false
  return (
    window.__ztoolsWindowMode === 'launcher' ||
    window.location.search.includes('mode=launcher') ||
    window.location.hash.includes('launcher')
  )
})

// 悬浮条窗口是透明无边框窗口：根节点必须透明，否则圆角面板外会露出方形底色
const isPopoutWindow = computed(() => {
  if (typeof window === 'undefined') return false
  return (
    window.__ztoolsWindowMode === 'popout' ||
    window.location.search.includes('popout=1') ||
    window.location.hash.startsWith('#/popout/') ||
    window.location.hash.includes('/popout/')
  )
})

if (isLauncherWindow.value && typeof document !== 'undefined') {
  document.documentElement.classList.add('is-launcher-window')
}

const events = useEventsStore()
const pluginsStore = usePluginsStore()
const { checkVersion, silentWebUpdate } = useAppUpdate()
const updateNotificationRef = ref(null)
const hotkeyConflictRef = ref(null)

/**
 * 将宿主推送的原始冲突数据转换为弹窗统一展示格式
 * duplicate: { type:'duplicate', key, pluginId1, pluginId2, triggerId1?, triggerId2? }
 * system:    { type:'system', key, pluginId, triggerId?, reason? }
 * legacy:    { type:'keyboard'|'mouse', key }
 */
const transformConflicts = (rawConflicts) => {
  if (!Array.isArray(rawConflicts)) return []
  const result = []
  // 构建 pluginId -> name 映射（按当前界面语言本地化显示）
  const nameMap = {}
  for (const p of pluginsStore.installedPlugins || []) {
    nameMap[String(p.pluginId)] = getLocalizedPluginName(p) || p.pluginId
  }
  const getTargetName = (id, triggerId = '') => {
    const tid = String(triggerId || '').trim()
    const pid = String(id || '').trim()
    if (tid === 'global_wake_hotkey') return t('modals.hotkeyConflict.globalWake')
    if (tid === 'mouse_wake_hook') return t('modals.hotkeyConflict.mouseWake')
    if (pid.toLowerCase() === 'system') return t('modals.hotkeyConflict.systemHotkey')
    const featureItem = tid ? getPluginFeatureHotkeyItemByTriggerId(tid) : null
    if (featureItem) {
      const pluginLabel = nameMap[String(featureItem.pluginId)] || featureItem.pluginName || featureItem.pluginId
      return `${pluginLabel} · ${featureItem.featureName}`
    }
    return nameMap[pid] || pid || t('app.unknownPlugin')
  }

  for (const item of rawConflicts) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'duplicate') {
      const name1 = getTargetName(item.pluginId1, item.triggerId1)
      const name2 = getTargetName(item.pluginId2, item.triggerId2)
      result.push({
        pluginName: name1,
        pluginId: item.pluginId1 || '',
        key: item.key || '',
        conflictType: 'duplicate',
        conflictWith: name2,
        triggerId: item.triggerId1 || '',
        conflictTriggerId: item.triggerId2 || ''
      })
      result.push({
        pluginName: name2,
        pluginId: item.pluginId2 || '',
        key: item.key || '',
        conflictType: 'duplicate',
        conflictWith: name1,
        triggerId: item.triggerId2 || '',
        conflictTriggerId: item.triggerId1 || ''
      })
    } else if (item.type === 'system') {
      result.push({
        pluginName: getTargetName(item.pluginId, item.triggerId),
        pluginId: item.pluginId || '',
        key: item.key || '',
        conflictType: 'system_occupied',
        conflictWith: item.reason || t('modals.hotkeyConflict.systemOrOtherApp'),
        triggerId: item.triggerId || '',
        ...(Array.isArray(item.suggestions) ? { suggestions: [...item.suggestions] } : {})
      })
    } else if (item.type === 'keyboard' || item.type === 'mouse') {
      result.push({
        pluginName: item.type === 'mouse' ? t('modals.hotkeyConflict.mouseWake') : t('modals.hotkeyConflict.globalWake'),
        pluginId: 'system',
        key: item.key || '',
        conflictType: 'system_occupied',
        conflictWith: t('modals.hotkeyConflict.systemOrOtherApp'),
        triggerId: item.type === 'mouse' ? 'mouse_wake_hook' : 'global_wake_hotkey',
        ...(Array.isArray(item.suggestions) ? { suggestions: [...item.suggestions] } : {})
      })
    } else if ('conflictType' in item || 'pluginName' in item) {
      result.push(item)
    }
  }
  return result
}

/** 处理 Delphi 端推送的插件快捷键冲突事件 */
const handleHotkeyConflictsDetected = (data) => {
  try {
    const rawConflicts = data?.conflicts || data?.payload?.conflicts || []
    if (!rawConflicts.length) return
    const conflicts = transformConflicts(rawConflicts)
    if (conflicts.length > 0) {
      hotkeyConflictRef.value?.show(conflicts)
    }
  } catch (e) {
    console.error('处理快捷键冲突事件失败:', e)
  }
}

const cleanupDeprecatedFeatureHotkeys = async () => {
  if (!window.ztools?.trigger?.unregister) return

  for (const item of DEPRECATED_PLUGIN_FEATURE_HOTKEY_ITEMS) {
    try {
      await window.ztools.trigger.unregister(item.triggerId)
    } catch (e) {
      // 触发器不存在时静默跳过
    }
  }
}

/** 全局快捷键监听：开发者工具 (F12, Ctrl+Shift+I) 与设置 (Ctrl+,) */
const handleGlobalKeydown = (event) => {
  if (isHotkeyRecorderInput(event?.target) || isComposingEvent(event)) return

  const combo = normalizeEventKeyCombo(event)
  if ((combo === 'F12' || combo === 'Ctrl+Shift+I') && !isModalOpen()) {
    event.preventDefault()
    void toggleHostDevTools()
    return
  }

  if (matchesShellShortcut(combo, 'OPEN_SETTINGS') && !isModalOpen()) {
    event.preventDefault()
    void openSettings()
    return
  }

  // 阻止非录制状态下 Alt+Space 触发浏览器/系统默认窗口菜单行为
  const isAltSpace = event.altKey && (event.code === 'Space' || event.key === ' ' || event.keyCode === 32)
  if (isAltSpace) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
}

let isAppUnmounted = false

onMounted(async () => {
  // console.log('App component mounted')
  isAppUnmounted = false
  window.__ztoolsDispatchRecorderHotkey = dispatchSyntheticRecorderHotkey
  initWindowMode()
  window.addEventListener('keydown', handleGlobalKeydown)
  events.init()

  // 设置前端埋点的 web_version，确保上报的埋点携带版本号（只有官方版上报；开源版为空操作）
  try {
    const ver = await window.ztools?.sys?.getCurrentVersion()
    if (isAppUnmounted) return
    if (ver?.webVersion) {
      setTrackingWebVersion(ver.webVersion)
    }
  } catch (e) {
    // 静默处理，版本获取失败不影响业务
  }

  if (isAppUnmounted) return

  // 主工作台专属初始化（悬浮条与独立弹出窗跳过启动上报、废弃热键清理、更新弹窗桥接、启动检查更新及事件订阅）
  if (!isLauncherWindow.value && !isPopoutWindow.value) {
    onAppStart({ getInstalledPluginIds: () => pluginsStore.getCatalogInstalledPluginIds() })

    await cleanupDeprecatedFeatureHotkeys()
    if (isAppUnmounted) return

    // 将更新通知方法挂到 window，供 main.js 的 IPC 回调调用
    window.__showUpdateNotification = (type, data) => {
      if (updateNotificationRef.value) {
        updateNotificationRef.value.show(type, data)
      }
    }

    // Web 静默更新方法挂到 window，供 main.js 的 IPC 回调调用
    window.__silentWebUpdate = silentWebUpdate

    // 更新完成回调（Delphi 原生窗体关闭后通过 IPC 通知前端）
    // Web 更新完成后 Delphi 端会自动 LoadURL 刷新页面，前端无需处理刷新
    // App 更新通知由 Delphi 端在新页面加载后自动推送，前端无需暂存
    window.__updateComplete = (type, success, message) => {
      if (type === 'web') {
        if (success) {
          window.__ztoolsToast?.('success', t('app.webUpdateDone'))
          // Delphi 端会自动 LoadURL 刷新页面，无需前端 reload
        } else {
          window.__ztoolsToast?.('error', message || t('app.webUpdateFailed'))
        }
      } else if (type === 'app') {
        if (!success) {
          window.__ztoolsToast?.('error', message || t('app.appUpdateFailed'))
        }
        // App 更新成功时不需要前端处理，安装程序会自动关闭 ZTools
      }
    }

    // 启动时检查版本（同步 IPC，Delphi 端异步推送已移除）
    // 需要前端主动处理返回结果并展示通知
    checkVersion('startup')
      .then((result) => {
        if (isAppUnmounted) return
        if (result && result.success) {
          // App 优先于 Web：App 有更新时只展示 App（安装包含 Web 资源）
          if (result.app) {
            // 统一走 UpdateNotification 展示，force 标记由组件内部处理
            window.__showUpdateNotification?.('app', result.app)
          } else if (result.web) {
            // Web 更新静默执行，不弹通知
            silentWebUpdate(result.web).catch((error) => {
              console.error('启动时 Web 更新失败:', error)
              window.__ztoolsToast?.('error', t('app.webUpdateFailedWithReason', { reason: resolveErrorMessage(error, 'common.unknownError') }))
            })
          }
        }
      })
      .catch((error) => {
        if (isAppUnmounted) return
        if (isUpdateUnsupported(error)) {
          console.info('[update] 当前平台暂不支持应用内更新，已跳过启动检查')
          return
        }
        console.error('启动时检查更新失败:', error)
      })

    // 订阅并监听 Delphi 端异步推送的插件快捷键冲突事件与悬浮条切换事件
    try {
      if (window.ztools?.events) {
        await window.ztools.events.subscribe('hotkey_conflicts_detected').catch((subErr) => {
          console.warn('订阅 hotkey_conflicts_detected 失败:', subErr)
        })
        if (isAppUnmounted) return
        window.ztools.events.on('hotkey_conflicts_detected', handleHotkeyConflictsDetected)
        window.ztools.events.on('toggle_launcher_mode', handleToggleLauncher)
      }
    } catch (e) {
      console.warn('注册快捷键/悬浮条事件监听失败:', e)
    }
  }
})

const handleToggleLauncher = () => {
  switchWindowMode(WINDOW_MODES.LAUNCHER)
}

onBeforeUnmount(() => {
  isAppUnmounted = true
  window.removeEventListener('keydown', handleGlobalKeydown)
  events.destroy()
  if (!isLauncherWindow.value && !isPopoutWindow.value) {
    delete window.__showUpdateNotification
    delete window.__silentWebUpdate
    delete window.__updateComplete
    // 清理快捷键与极客模式事件监听
    try {
      window.ztools?.events?.off?.('hotkey_conflicts_detected', handleHotkeyConflictsDetected)
      window.ztools?.events?.off?.('toggle_launcher_mode', handleToggleLauncher)
    } catch (e) {
      console.warn('清理快捷键/悬浮条事件监听失败:', e)
    }
  }
})
</script>

<template>
  <ThemeProvider>
    <!-- 极客悬浮条独立实例：直接呈现全键盘秒搜悬浮条 -->
    <template v-if="isLauncherWindow">
      <LauncherBar />
    </template>
    <!-- 完整应用工作台大界面 -->
    <template v-else>
      <router-view v-slot="{ Component }">
        <transition name="fade" mode="out-in">
          <component :is="Component" />
        </transition>
      </router-view>
      <CloseConfirmModal />
      <ContextMenu />
      <!-- 更新通知（强制/可选更新统一样式） -->
      <UpdateNotification ref="updateNotificationRef" />
      <!-- 快捷键冲突提示 -->
      <HotkeyConflictModal ref="hotkeyConflictRef" />
    </template>
  </ThemeProvider>
</template>

<style scoped>
#app {
  min-height: 100vh;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--rc-dur) ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
