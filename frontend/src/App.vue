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
import { reportOnline } from '@/api/statistics'
import { isOnline } from '@/config/runtime-mode'
import { DEPRECATED_PLUGIN_FEATURE_HOTKEY_ITEMS } from '@/utils/pluginFeatureHotkeys'
import { openDevTools, openSettings } from '@/utils/internalPlugins'
import {
  windowModeState,
  WINDOW_MODES,
  initWindowMode,
  switchWindowMode
} from '@/utils/windowMode'

const isLauncherWindow = computed(() => {
  if (typeof window === 'undefined') return false
  return (
    window.__ztoolsWindowMode === 'launcher' ||
    window.location.search.includes('mode=launcher') ||
    window.location.hash.includes('launcher')
  )
})

// 悬浮条窗口是透明无边框窗口：根节点必须透明，否则圆角面板外会露出方形底色
if (isLauncherWindow.value && typeof document !== 'undefined') {
  document.documentElement.classList.add('is-launcher-window')
}

const events = useEventsStore()
const pluginsStore = usePluginsStore()
const { checkVersion, silentWebUpdate } = useAppUpdate()
const updateNotificationRef = ref(null)
const hotkeyConflictRef = ref(null)

/**
 * 将 Delphi 端原始冲突数据转换为弹窗展示格式
 * Delphi duplicate: { type:'duplicate', key, pluginId1, pluginId2 }
 * Delphi system:    { type:'system', key, pluginId, reason }
 * 弹窗格式:         { pluginName, key, conflictType, conflictWith }
 */
const transformConflicts = (rawConflicts) => {
  if (!Array.isArray(rawConflicts)) return []
  const result = []
  // 构建 pluginId -> name 映射
  const nameMap = {}
  for (const p of pluginsStore.installedPlugins || []) {
    nameMap[String(p.pluginId)] = p.name || p.pluginId
  }
  const getName = (id) => nameMap[String(id)] || id || '未知插件'

  for (const item of rawConflicts) {
    if (item.type === 'duplicate') {
      // 插件间重复：为两个插件各生成一条冲突记录
      result.push({
        pluginName: getName(item.pluginId1),
        key: item.key || '',
        conflictType: 'duplicate',
        conflictWith: getName(item.pluginId2),
        triggerId: item.triggerId1 || '',
        conflictTriggerId: item.triggerId2 || ''
      })
      result.push({
        pluginName: getName(item.pluginId2),
        key: item.key || '',
        conflictType: 'duplicate',
        conflictWith: getName(item.pluginId1),
        triggerId: item.triggerId2 || '',
        conflictTriggerId: item.triggerId1 || ''
      })
    } else if (item.type === 'system') {
      // 系统占用
      result.push({
        pluginName: getName(item.pluginId),
        key: item.key || '',
        conflictType: 'system_occupied',
        conflictWith: '系统',
        triggerId: item.triggerId || ''
      })
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
  const isDevToolsKey =
    event.key === 'F12' ||
    ((event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      (event.key === 'I' || event.key === 'i'))

  if (isDevToolsKey) {
    event.preventDefault()
    openDevTools()
    return
  }

  const isSettingsKey = (event.ctrlKey || event.metaKey) && event.key === ','
  if (isSettingsKey) {
    event.preventDefault()
    openSettings()
    return
  }

  // Ctrl+M 双模态自由切换
  const isToggleModeKey = (event.ctrlKey || event.metaKey) && (event.key === 'm' || event.key === 'M')
  if (isToggleModeKey) {
    event.preventDefault()
    switchWindowMode(
      windowModeState.currentMode === WINDOW_MODES.LAUNCHER
        ? WINDOW_MODES.DASHBOARD
        : WINDOW_MODES.LAUNCHER
    )
    return
  }

  // Alt+Space 快速进入极客条模式（并阻止默认事件，阻止 Windows 原生系统菜单弹出）
  const isAltSpace = event.altKey && (event.code === 'Space' || event.key === ' ' || event.keyCode === 32)
  if (isAltSpace) {
    event.preventDefault()
    event.stopPropagation()
    switchWindowMode(
      windowModeState.currentMode === WINDOW_MODES.LAUNCHER
        ? WINDOW_MODES.DASHBOARD
        : WINDOW_MODES.LAUNCHER
    )
    return
  }
}

onMounted(async () => {
  // console.log('App component mounted')
  initWindowMode()
  window.addEventListener('keydown', handleGlobalKeydown)
  events.init()
  await cleanupDeprecatedFeatureHotkeys()

  // 设置前端埋点的 web_version，确保 IPC 上报的埋点携带版本号
  try {
    const ver = await window.ztools?.sys?.getCurrentVersion()
    if (ver?.webVersion) {
      window.ztools?.analytics?.setWebVersion(ver.webVersion)
    }
  } catch (e) {
    // 静默处理，版本获取失败不影响业务
  }

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
        window.__ztoolsToast?.('success', 'Web 资源更新完成')
        // Delphi 端会自动 LoadURL 刷新页面，无需前端 reload
      } else {
        window.__ztoolsToast?.('error', message || 'Web 更新失败')
      }
    } else if (type === 'app') {
      if (!success) {
        window.__ztoolsToast?.('error', message || 'App 更新失败')
      }
      // App 更新成功时不需要前端处理，安装程序会自动关闭 ZTools
    }
  }

  // 启动时静默上报今日上线（无需登录，按 IP 去重，每天一次）
  reportOnline().catch(() => {})

  // 启动时检查版本（同步 IPC，Delphi 端异步推送已移除）
  // 需要前端主动处理返回结果并展示通知
  checkVersion('startup')
    .then((result) => {
      if (result && result.success) {
        // App 优先于 Web：App 有更新时只展示 App（安装包含 Web 资源）
        if (result.app) {
          // 统一走 UpdateNotification 展示，force 标记由组件内部处理
          window.__showUpdateNotification?.('app', result.app)
        } else if (result.web) {
          // Web 更新静默执行，不弹通知
          silentWebUpdate(result.web).catch((error) => {
            console.error('启动时 Web 更新失败:', error)
            window.__ztoolsToast?.('error', 'Web 更新失败: ' + (error.message || '未知错误'))
          })
        }
      }
    })
    .catch((error) => {
      if (isUpdateUnsupported(error)) {
        console.info('[update] 当前平台暂不支持应用内更新，已跳过启动检查')
        return
      }
      console.error('启动时检查更新失败:', error)
    })

  // 订阅并监听 Delphi 端异步推送的插件快捷键冲突事件
  try {
    if (window.ztools?.events) {
      await window.ztools.events.subscribe('hotkey_conflicts_detected').catch(() => {})
      window.ztools.events.on('hotkey_conflicts_detected', handleHotkeyConflictsDetected)
      window.ztools.events.on('toggle_launcher_mode', handleToggleLauncher)
    }
  } catch (e) {
    // 静默处理
  }
})

const handleToggleLauncher = () => {
  switchWindowMode(WINDOW_MODES.LAUNCHER)
}

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  events.destroy()
  delete window.__showUpdateNotification
  delete window.__silentWebUpdate
  delete window.__updateComplete
  // 清理快捷键与极客模式事件监听
  try {
    window.ztools?.events?.off?.('hotkey_conflicts_detected', handleHotkeyConflictsDetected)
    window.ztools?.events?.off?.('toggle_launcher_mode', handleToggleLauncher)
  } catch (e) {
    // 静默处理
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
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
