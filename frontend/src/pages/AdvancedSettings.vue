<script setup>
import {
  ref,
  reactive,
  onMounted,
  onBeforeUnmount,
  watch,
  nextTick,
  computed
} from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter, useRoute } from 'vue-router'
import { useToast } from '@/composables/useToast'
import { useThemeStore } from '@/stores/theme'
import { ROUTES } from '@/router/routes'
import {
  getAutostart,
  setAutostart,
  getHotkey,
  setHotkey,
  getMinimizeToTray,
  setMinimizeToTray,
  getCloseConfirm,
  setCloseConfirm
} from '@/api/apiserver'
import { syncGlobalWakeHotkey } from '@/utils/globalWakeHotkey'
import { setWakePreference, windowModeState, WAKE_PREFERENCES } from '@/utils/windowMode'
import { openDevTools } from '@/utils/internalPlugins'
import { vSwitchKeyboard } from '@/directives/switchKeyboard'
import ScreenPermissionPanel from '@/components/ScreenPermissionPanel.vue'
import ShortcutSettingsModal from '@/components/ShortcutSettingsModal.vue'
import PluginHotkeyModal from '@/components/PluginHotkeyModal.vue'
import PluginFeatureHotkeyModal from '@/components/PluginFeatureHotkeyModal.vue'
import { useNavStore } from '@/stores/nav'
import {
  PLUGIN_FEATURE_HOTKEY_QUERY_KEY,
  getPluginFeatureHotkeyItemByTrigger,
  isDeprecatedPluginFeatureHotkeyItem
} from '@/utils/pluginFeatureHotkeys'
import {
  formatHotkeyForPlatform,
  getHotkeyHostCapabilities,
  getHotkeyWaitText,
  parseSupportedHotkeyEvent,
  resetHotkeyRecorderState
} from '@/utils/hotkeyRecorder'
import { buildLaunchHotkeyMap } from '@/utils/launchHotkeyTargets'

const { success, error } = useToast()
const themeStore = useThemeStore()
const { isDark } = storeToRefs(themeStore)
const router = useRouter()
const route = useRoute()
const hotkeyPlatform = ref('unknown')
const supportsDoubleModifierHotkeys = ref(false)
const autostartStatus = ref('')
const autostartKnown = ref(false)
const autostartSaving = ref(false)
const autostartDescription = computed(() => ({
  unavailable: '无法读取登录项状态，请重新打开设置后重试',
  'requires-approval': '请在系统设置的登录项中允许 ZTools；系统批准前不会自动启动',
  'not-found': '系统未找到登录项，请重新设置并检查应用安装位置',
  'not-registered': '未开启自启动'
})[autostartStatus.value] || '登录系统时自动运行 ZTools')
const refreshAutostartStatus = async () => {
  try {
    const status = await window.ztools?.config?.get('system.autostartStatus', '')
    autostartStatus.value = ['enabled', 'requires-approval', 'not-found', 'not-registered'].includes(status) ? status : ''
  } catch { autostartStatus.value = '' }
}

// 启动快捷键弹窗引用
const pluginHotkeyModalRef = ref(null)
const pluginFeatureHotkeyModalRef = ref(null)
// 启动快捷键已配置数量（缓存值，避免必须打开弹窗才能显示）
const pluginHotkeyCount = ref(0)
const pluginFeatureHotkeyCount = ref(0)
// 启动快捷键映射缓存（仅用于设置页展示已配置数量）
const pluginHotkeyMapCache = ref({})

const settings = reactive({
  autostart: false,
  hotkey: 'Ctrl+Shift+Z',
  wakePreference: windowModeState.wakePreference || 'dashboard',
  theme: 'light',
  minimizeToTray: true,
  closeConfirm: true,
  superPanel: {
    enabled: true,
    keyboardHotkey: {
      enabled: true,
      modifiers: ['Alt'],
      key: 'Space'
    },
    mouseHotkey: {
      enabled: true,
      button: 'middle_long',
      longPressMs: 300
    },
    panelPosition: 'center',
    panelSize: 'small',
    defaultTab: 'history',
    maxRecentCount: 10
  }
})
const hotkeyRecording = ref(false)
const hotkeyRecordingText = ref('')
const hotkeyInput = ref(null)
const superPanelKeyRecording = ref(false)
const superPanelKeyRecordingText = ref('')
const superPanelKeyInput = ref(null)
const superPanelSettingRef = ref(null)

// 快捷方式设置弹窗
const shortcutModalOpen = ref(false)
const shortcutCount = ref(0)

// 弹窗关闭后刷新快捷方式数量（仅在值从 true 变为 false 时触发）
watch(shortcutModalOpen, async (newVal, oldVal) => {
  if (!newVal && oldVal) {
    try {
      if (window.ztools?.config) {
        const config = await window.ztools.config.get('super_panel')
        shortcutCount.value = Array.isArray(config?.shortcuts) ? config.shortcuts.length : 0
      }
    } catch {}
  }
})

const mouseButtonOptions = [
  { value: 'middle_press', label: '按下鼠标中键' },
  { value: 'middle_long', label: '长按鼠标中键' },
  { value: 'right_press', label: '按下鼠标右键' },
  { value: 'right_long', label: '长按鼠标右键' },
  { value: 'forward_press', label: '按下鼠标向前侧键' },
  { value: 'forward_long', label: '长按鼠标向前侧键' },
  { value: 'backward_press', label: '按下鼠标向后侧键' },
  { value: 'backward_long', label: '长按鼠标向后侧键' }
]

const longPressMarks = {
  200: '200ms',
  300: '300ms',
  400: '400ms',
  500: '500ms'
}

const panelSizeOptions = [
  { value: 'small', label: '小', desc: '400 x 300' },
  { value: 'medium', label: '中', desc: '400 x 600' },
  { value: 'large', label: '大', desc: '800 x 600' }
]

const defaultTabOptions = [
  { value: 'history', label: '历史' },
  { value: 'pinned', label: '固定' },
  { value: 'local', label: '本地' },
  { value: 'system_tools', label: '系统工具' },
  { value: 'all', label: '全部' }
]

const isLongPress = computed(() => {
  return settings.superPanel.mouseHotkey.button.endsWith('_long')
})

watch(hotkeyRecording, (val) => {
  if (val) {
    nextTick(() => {
      hotkeyInput.value?.focus()
    })
  }
})

const loadSettings = async () => {
  try {
    autostartKnown.value = false
    try {
      settings.autostart = await getAutostart()
      autostartKnown.value = true
      await refreshAutostartStatus()
    } catch {
      autostartStatus.value = 'unavailable'
    }
    const hotkey = await getHotkey()
    settings.hotkey = hotkey || 'Ctrl+Shift+Z'
    settings.theme = document.documentElement.classList.contains('dark')
      ? 'dark'
      : 'light'
    try {
      settings.minimizeToTray = await getMinimizeToTray()
    } catch {}
    try {
      settings.closeConfirm = await getCloseConfirm()
    } catch {}
    try {
      settings.wakePreference = windowModeState.wakePreference || 'dashboard'
    } catch {}
    try {
      if (window.ztools?.config) {
        const config = await window.ztools.config.get('super_panel')
        if (config) {
          Object.assign(settings.superPanel, config)
          // 加载快捷方式数量
          shortcutCount.value = Array.isArray(config.shortcuts) ? config.shortcuts.length : 0
        }
      }
    } catch (e) {
      console.error('Failed to load super panel settings:', e)
    }
  } catch (e) {
    console.error('Failed to load settings:', e)
    error('加载设置失败')
  }
}

const onWakePreferenceChange = (val) => {
  try {
    settings.wakePreference = val
    setWakePreference(val)
    success(val === 'launcher' ? '已设置为极客悬浮条模式' : '已设置为应用工作台模式')
  } catch (err) {
    error('保存偏好失败: ' + err.message)
  }
}

const saveAutostart = async enabled => {
  if (!autostartKnown.value || autostartSaving.value) return
  autostartSaving.value = true
  try {
    if (!(await setAutostart(enabled))) throw new Error('登录启动设置未保存')
    settings.autostart = await getAutostart()
    await refreshAutostartStatus()
    success(autostartStatus.value === 'requires-approval' ? '登录项等待系统批准' : '登录启动设置已保存')
  } catch {
    try {
      settings.autostart = await getAutostart()
      await refreshAutostartStatus()
    } catch {
      autostartKnown.value = false
      autostartStatus.value = 'unavailable'
    }
    error('登录启动设置未保存，请检查当前系统状态')
  } finally {
    autostartSaving.value = false
  }
}

const saveSettings = async () => {
  let hotkeySyncFailure = ''
  try {
    await setHotkey(settings.hotkey)

    try {
      const result = await syncGlobalWakeHotkey({ hotkey: settings.hotkey })
      if (result.success) {
        if (settings.hotkey) {
          console.log('全局唤醒快捷键已注册:', settings.hotkey)
        } else {
          console.log('全局唤醒快捷键已注销')
        }
      } else {
        const reasonMessages = {
          trigger_unavailable: '快捷键服务暂不可用',
          trigger_list_failed: '读取已有快捷键失败',
          trigger_register_failed: '新快捷键注册失败，已尝试恢复原注册',
          trigger_unregister_failed: '注销快捷键失败'
        }
        hotkeySyncFailure = reasonMessages[result.reason] || '快捷键服务返回失败'
        if (result.message) hotkeySyncFailure += `：${result.message}`
        if (result.rollbackFailed) hotkeySyncFailure += '；恢复原快捷键也失败，请重新设置'
        console.warn('全局唤醒快捷键同步失败:', result)
      }
    } catch (err) {
      console.error('同步全局快捷键失败:', err)
      error('快捷键注册失败: ' + err.message)
      return
    }
    try {
      if (window.ztools?.config) {
        await window.ztools.config.set('super_panel', settings.superPanel)
        if (window.ztools?.sys?.reloadHotkeys) {
          await window.ztools.sys.reloadHotkeys()
        }
      }
    } catch (e) {
      console.error('Failed to save super panel settings:', e)
    }
    if (hotkeySyncFailure) {
      error(`设置已保存，但全局唤醒快捷键同步失败：${hotkeySyncFailure}`)
    } else {
      success('设置已保存')
    }
    // 埋点：设置变更
    window.ztools?.analytics?.report('settings_change', '', { type: 'general' })
  } catch (e) {
    console.error('Failed to save settings:', e)
    error('保存设置失败')
  }
}

const openExternalUrl = (url) => {
  if (window.ztools?.shell?.openExternal) {
    window.ztools.shell.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

const saveTraySettings = async () => {
  try {
    await setMinimizeToTray(!!settings.minimizeToTray)
    await setCloseConfirm(!!settings.closeConfirm)
    success('托盘设置已保存')
    // 埋点：设置变更
    window.ztools?.analytics?.report('settings_change', '', { type: 'tray' })
  } catch (e) {
    console.error('Failed to save tray settings:', e)
    error('保存托盘设置失败')
  }
}

const handleHotkeyInput = (event) => {
  event.preventDefault()
  if (!hotkeyRecording.value) return

  if (event.key === 'Escape') {
    hotkeyRecording.value = false
    hotkeyRecordingText.value = ''
    return
  }

  const result = parseSupportedHotkeyEvent(event, {
    platform: hotkeyPlatform.value,
    allowDoubleTap: supportsDoubleModifierHotkeys.value
  })
  if (result.status !== 'valid') {
    hotkeyRecordingText.value = result.text
    return
  }

  settings.hotkey = result.hotkey
  hotkeyRecording.value = false
  hotkeyRecordingText.value = ''
  saveSettings()
}

const clearHotkey = () => {
  settings.hotkey = ''
  saveSettings()
}

const toggleHotkeyRecording = () => {
  resetHotkeyRecorderState()
  hotkeyRecording.value = !hotkeyRecording.value
  hotkeyRecordingText.value = ''
}

const formatSuperPanelHotkey = (hotkey) => {
  const modifiers = hotkey.modifiers?.map((m) => m.charAt(0).toUpperCase() + m.slice(1)) || []
  const key = hotkey.key.charAt(0).toUpperCase() + hotkey.key.slice(1)
  return formatHotkeyForPlatform(
    [...modifiers, key].join('+'),
    hotkeyPlatform.value,
    false
  ).replaceAll('+', ' + ')
}

const handleSuperPanelKeyInput = (event) => {
  event.preventDefault()
  if (!superPanelKeyRecording.value) return

  if (event.key === 'Escape') {
    resetHotkeyRecorderState()
    superPanelKeyRecording.value = false
    superPanelKeyRecordingText.value = ''
    return
  }

  const result = parseSupportedHotkeyEvent(event, {
    platform: hotkeyPlatform.value,
    allowDoubleTap: false
  })
  if (result.status !== 'valid') {
    superPanelKeyRecordingText.value = result.text
    return
  }

  const keys = result.hotkey.split('+')
  settings.superPanel.keyboardHotkey.modifiers = keys.slice(0, -1)
  settings.superPanel.keyboardHotkey.key = keys[keys.length - 1]
  superPanelKeyRecording.value = false
  superPanelKeyRecordingText.value = ''
  saveSettings()
}

const clearSuperPanelHotkey = () => {
  resetHotkeyRecorderState()
  settings.superPanel.keyboardHotkey.modifiers = []
  settings.superPanel.keyboardHotkey.key = ''
  saveSettings()
}

const startSuperPanelRecording = () => {
  resetHotkeyRecorderState()
  superPanelKeyRecording.value = true
  superPanelKeyRecordingText.value = ''
  nextTick(() => {
    superPanelKeyInput.value?.focus()
  })
}

const cancelSuperPanelRecording = () => {
  resetHotkeyRecorderState()
  superPanelKeyRecording.value = false
  superPanelKeyRecordingText.value = ''
}

const changeTheme = () => {
  themeStore.setTheme(settings.theme)
  saveSettings()
}

// 监听 themeStore.isDark 变化，同步到本地 settings.theme
watch(isDark, (val) => {
  settings.theme = val ? 'dark' : 'light'
})

/** 从 Delphi 端加载插件和本地软件的启动快捷键数据并缓存 */
async function loadPluginHotkeyCount() {
  try {
    if (!window.ztools?.trigger) return
    const result = await window.ztools.trigger.list()
    const triggers = result?.data || result || []
    const map = buildLaunchHotkeyMap(
      triggers,
      getPluginFeatureHotkeyItemByTrigger
    )
    pluginHotkeyMapCache.value = map
    pluginHotkeyCount.value = Object.keys(map).length
    // 如果弹窗已打开（详情页跳转场景），通知弹窗更新数据
    pluginHotkeyModalRef.value?.updateMap(map)
  } catch (e) {
    // 静默处理
  }
}

async function loadPluginFeatureHotkeyCount() {
  try {
    if (!window.ztools?.trigger) return
    const result = await window.ztools.trigger.list()
    const triggers = result?.data || result || []
    let count = 0

    if (Array.isArray(triggers)) {
      for (const trigger of triggers) {
        const item = getPluginFeatureHotkeyItemByTrigger(trigger)
        if (item && !isDeprecatedPluginFeatureHotkeyItem(item)) {
          count += 1
        }
      }
    }

    pluginFeatureHotkeyCount.value = count
  } catch (e) {
    // 静默处理
  }
}

/** 打开插件快捷键弹窗；弹窗会从触发器注册表加载最新数据 */
function openPluginHotkeyModal() {
  pluginHotkeyModalRef.value?.show()
}

function openPluginFeatureHotkeyModal() {
  pluginFeatureHotkeyModalRef.value?.show()
}

/** 弹窗内增删快捷键后更新缓存数量 */
function onPluginHotkeyCountUpdate(count) {
  pluginHotkeyCount.value = count
}

function onPluginFeatureHotkeyCountUpdate(count) {
  pluginFeatureHotkeyCount.value = count
}

function scrollToSuperPanelSettings() {
  nextTick(() => {
    superPanelSettingRef.value?.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    })
  })
}

onMounted(async () => {
  const capabilities = await getHotkeyHostCapabilities()
  hotkeyPlatform.value = capabilities.platform
  supportsDoubleModifierHotkeys.value = capabilities.supportsDoubleModifierHotkeys
  // 确保 Sidebar 选中状态正确（从超级面板等外部跳转时）
  useNavStore().setPage('advanced-settings')
  await loadSettings()

  // 异步加载插件快捷键数量（不阻塞页面渲染）
  loadPluginHotkeyCount()
  loadPluginFeatureHotkeyCount()

  // 检测全局标志，自动打开快捷方式设置弹窗（从超级面板虚拟项跳转过来）
  if (window.__openShortcutSettings) {
    window.__openShortcutSettings = false
    shortcutModalOpen.value = true
  }
  if (window.__scrollToSuperPanelSettings) {
    window.__scrollToSuperPanelSettings = false
    scrollToSuperPanelSettings()
  }
  // 检测路由 query 参数，自动打开插件快捷键弹窗（供详情页跳转使用）
  if (route.query.openPluginHotkey === 'true') {
    nextTick(() => {
      openPluginHotkeyModal()
    })
    // 清除 query 参数，避免刷新后重复打开
    router.replace({ query: { ...route.query, openPluginHotkey: undefined } })
  }
  if (route.query[PLUGIN_FEATURE_HOTKEY_QUERY_KEY] === 'true') {
    nextTick(() => {
      openPluginFeatureHotkeyModal()
    })
    router.replace({
      query: {
        ...route.query,
        [PLUGIN_FEATURE_HOTKEY_QUERY_KEY]: undefined
      }
    })
  }
  // 监听关闭确认弹窗修改配置后的通知
  window.addEventListener('ztools-settings-changed', onSettingsChanged)
  window.addEventListener(
    'ztools-scroll-to-super-panel-settings',
    scrollToSuperPanelSettings
  )
})

const onSettingsChanged = () => {
  loadSettings()
}

onBeforeUnmount(() => {
  resetHotkeyRecorderState()
  window.removeEventListener('ztools-settings-changed', onSettingsChanged)
  window.removeEventListener(
    'ztools-scroll-to-super-panel-settings',
    scrollToSuperPanelSettings
  )
})
</script>

<template>
  <div class="settings-page">
    <div class="settings-container">
      <!-- 页面标题 -->
      <div class="page-header">
        <div class="header-icon">
          <i class="fa fa-cog"></i>
        </div>
        <div class="header-text">
          <h1 class="page-title">高级设置</h1>
          <p class="page-subtitle">管理应用程序的核心行为与视觉偏好</p>
        </div>
      </div>

      <!-- 设置卡片网格 -->
      <div class="settings-grid">
        <!-- 常规设置卡片 -->
        <div class="settings-card">
          <div class="card-header">
            <div class="card-icon icon-blue">
              <i class="fa fa-sliders"></i>
            </div>
            <h2 class="card-title">常规设置</h2>
          </div>

          <div class="settings-list">
            <!-- 开机自动启动 -->
            <div class="setting-item">
              <div class="setting-info">
                <div class="setting-icon">
                  <i class="fa fa-power-off"></i>
                </div>
                <div class="setting-text">
                  <span class="setting-label">开机自动启动</span>
                  <span class="setting-desc" data-testid="autostart-status">{{ autostartDescription }}</span>
                </div>
              </div>
              <a-switch
                v-switch-keyboard
                size="small"
                v-model:checked="settings.autostart"
                :disabled="!autostartKnown"
                :loading="autostartSaving"
                data-testid="autostart-switch"
                @change="saveAutostart"
              />
            </div>

            <!-- 退出确认 -->
            <div class="setting-item">
              <div class="setting-info">
                <div class="setting-icon">
                  <i class="fa fa-window-close-o"></i>
                </div>
                <div class="setting-text">
                  <span class="setting-label">退出确认</span>
                  <span class="setting-desc">关闭主窗口时询问退出或最小化到托盘</span>
                </div>
              </div>
              <a-switch
                v-switch-keyboard
                size="small"
                v-model:checked="settings.closeConfirm"
                @change="saveTraySettings"
              />
            </div>

            <!-- 最小化到托盘 -->
            <div v-if="!settings.closeConfirm" class="setting-item animate-in">
              <div class="setting-info">
                <div class="setting-icon">
                  <i class="fa fa-compress"></i>
                </div>
                <div class="setting-text">
                  <span class="setting-label">最小化到托盘</span>
                  <span class="setting-desc">关闭窗口后在后台继续运行</span>
                </div>
              </div>
              <a-switch
                v-switch-keyboard
                size="small"
                v-model:checked="settings.minimizeToTray"
                @change="saveTraySettings"
              />
            </div>
          </div>
        </div>

        <!-- 外观设置卡片 -->
        <div class="settings-card">
          <div class="card-header">
            <div class="card-icon icon-purple">
              <i class="fa fa-paint-brush"></i>
            </div>
            <h2 class="card-title">外观设置</h2>
          </div>

          <div class="settings-list">
            <div class="setting-item theme-setting">
              <div class="setting-info">
                <div class="setting-icon">
                  <i class="fa fa-adjust"></i>
                </div>
                <div class="setting-text">
                  <span class="setting-label">界面主题</span>
                  <span class="setting-desc">切换应用整体视觉风格</span>
                </div>
              </div>
            </div>

            <div class="theme-switcher">
              <button
                class="theme-btn"
                :class="{ active: settings.theme === 'light' }"
                @click="
                  () => {
                    settings.theme = 'light'
                    changeTheme()
                  }
                "
              >
                <div class="theme-preview light-preview">
                  <div class="preview-header"></div>
                  <div class="preview-content">
                    <div class="preview-sidebar"></div>
                    <div class="preview-main"></div>
                  </div>
                </div>
                <span class="theme-name">
                  <i class="fa fa-sun-o"></i>
                  明亮模式
                </span>
              </button>

              <button
                class="theme-btn"
                :class="{ active: settings.theme === 'dark' }"
                @click="
                  () => {
                    settings.theme = 'dark'
                    changeTheme()
                  }
                "
              >
                <div class="theme-preview dark-preview">
                  <div class="preview-header"></div>
                  <div class="preview-content">
                    <div class="preview-sidebar"></div>
                    <div class="preview-main"></div>
                  </div>
                </div>
                <span class="theme-name">
                  <i class="fa fa-moon-o"></i>
                  暗黑模式
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- 快捷键设置卡片 -->
        <div class="settings-card wide-card">
          <div class="card-header">
            <div class="card-icon icon-green">
              <i class="fa fa-keyboard-o"></i>
            </div>
            <h2 class="card-title">快捷交互</h2>
          </div>

          <div class="settings-list">
            <!-- 全局唤醒快捷键 -->
            <div class="setting-item hotkey-item">
              <div class="setting-info">
                <div class="setting-icon">
                  <i class="fa fa-bolt"></i>
                </div>
                <div class="setting-text">
                  <span class="setting-label">全局唤醒快捷键</span>
                  <span class="setting-desc"
                    >使用组合键快速呼出或隐藏主界面</span
                  >
                </div>
              </div>
              <div class="hotkey-input-group">
                <div
                  class="hotkey-recorder"
                  :class="{ recording: hotkeyRecording }"
                  @click="toggleHotkeyRecording"
                >
                  <input
                    ref="hotkeyInput"
                    class="hotkey-hidden-input"
                    readonly
                    @keydown="handleHotkeyInput"
                    @blur="hotkeyRecording = false; hotkeyRecordingText = ''"
                  />
                  <span v-if="hotkeyRecording" class="recording-text">
                    <i class="fa fa-circle recording-dot"></i>
                    {{
                      hotkeyRecordingText ||
                      getHotkeyWaitText(hotkeyPlatform, supportsDoubleModifierHotkeys)
                    }}
                  </span>
                  <div v-else class="hotkey-keys">
                    <template v-if="settings.hotkey">
                      <span
                        v-for="key in formatHotkeyForPlatform(settings.hotkey, hotkeyPlatform, supportsDoubleModifierHotkeys).split('+')"
                        :key="key"
                        class="key-badge"
                        >{{ key }}</span
                      >
                    </template>
                    <span v-else class="no-hotkey">点击设置</span>
                  </div>
                </div>
                <button
                  v-if="settings.hotkey"
                  class="clear-btn"
                  @click="clearHotkey"
                  title="清除"
                >
                  <i class="fa fa-times"></i>
                </button>
              </div>
            </div>

            <!-- 呼出形态偏好设置 -->
            <div class="setting-item">
              <div class="setting-info">
                <div class="setting-icon">
                  <i class="fa fa-sliders"></i>
                </div>
                <div class="setting-text">
                  <span class="setting-label">默认呼出形态</span>
                  <span class="setting-desc">按全局热键唤醒时的窗口展示模式</span>
                </div>
              </div>
              <div class="setting-control">
                <a-radio-group
                  v-model:value="settings.wakePreference"
                  size="small"
                  button-style="solid"
                  @change="e => onWakePreferenceChange(e.target.value)"
                >
                  <a-radio-button value="dashboard">应用工作台</a-radio-button>
                  <a-radio-button value="launcher">极客悬浮条</a-radio-button>
                </a-radio-group>
              </div>
            </div>

            <!-- 启动快捷键（独立项） -->
            <div class="setting-item" style="cursor: pointer" @click="openPluginHotkeyModal">
              <div class="setting-info">
                <div class="setting-icon">
                  <i class="fa fa-keyboard-o"></i>
                </div>
                <div class="setting-text">
                  <span class="setting-label">启动快捷键</span>
                  <span class="setting-desc">为指定插件或本地应用设置全局独立启动热键</span>
                </div>
              </div>
              <span style="font-size: 12px; color: var(--zt-text-secondary)">
                已配置 {{ pluginHotkeyCount }} 个快捷键
                <i class="fa fa-chevron-right" style="margin-left: 4px; font-size: 10px"></i>
              </span>
            </div>

            <div
              class="setting-item"
              style="cursor: pointer"
              @click="openPluginFeatureHotkeyModal"
            >
              <div class="setting-info">
                <div class="setting-icon">
                  <i class="fa fa-crosshairs"></i>
                </div>
                <div class="setting-text">
                  <span class="setting-label">功能快捷键</span>
                  <span class="setting-desc">为插件内置功能（如截图、文字识别）设置全局热键</span>
                </div>
              </div>
              <span style="font-size: 12px; color: var(--zt-text-secondary)">
                已配置 {{ pluginFeatureHotkeyCount }} 个快捷键
                <i class="fa fa-chevron-right" style="margin-left: 4px; font-size: 10px"></i>
              </span>
            </div>

            <!-- 超级面板 -->
            <div ref="superPanelSettingRef" class="setting-item">
              <div class="setting-info">
                <div class="setting-icon">
                  <i class="fa fa-th"></i>
                </div>
                <div class="setting-text">
                  <span class="setting-label">超级面板</span>
                  <span class="setting-desc">快速启动插件的便捷面板</span>
                </div>
              </div>
              <a-switch
                v-switch-keyboard
                size="small"
                v-model:checked="settings.superPanel.enabled"
                @change="saveSettings"
              />
            </div>

            <!-- 超级面板子设置 -->
            <div
              v-if="settings.superPanel.enabled"
              class="sub-settings animate-in"
            >
              <!-- 键盘热键 -->
              <div class="sub-setting-group">
                <div class="sub-setting-header">
                  <div class="sub-setting-info">
                    <i class="fa fa-keyboard-o"></i>
                    <span>键盘热键</span>
                  </div>
                  <a-switch
                    v-switch-keyboard
                    size="small"
                    v-model:checked="settings.superPanel.keyboardHotkey.enabled"
                    @change="saveSettings"
                  />
                </div>

                <div
                  v-if="settings.superPanel.keyboardHotkey.enabled"
                  class="sub-setting-content"
                >
                  <div class="hotkey-row">
                    <span class="hotkey-label">快捷键</span>
                    <div class="hotkey-input-group compact">
                      <div
                        class="hotkey-recorder small"
                        :class="{ recording: superPanelKeyRecording }"
                        @click="startSuperPanelRecording"
                      >
                        <input
                          ref="superPanelKeyInput"
                          class="hotkey-hidden-input"
                          readonly
                          @keydown="handleSuperPanelKeyInput"
                          @blur="cancelSuperPanelRecording"
                        />
                        <span
                          v-if="superPanelKeyRecording"
                          class="recording-text small"
                        >
                          <i class="fa fa-circle recording-dot"></i>
                          {{ superPanelKeyRecordingText || getHotkeyWaitText(hotkeyPlatform, false) }}
                        </span>
                        <div v-else class="hotkey-keys">
                          <template
                            v-if="
                              settings.superPanel.keyboardHotkey.key
                            "
                          >
                            <span
                              v-for="key in formatSuperPanelHotkey(
                                settings.superPanel.keyboardHotkey
                              ).split(' + ')"
                              :key="key"
                              class="key-badge small"
                              >{{ key }}</span
                            >
                          </template>
                          <span v-else class="no-hotkey">未设置</span>
                        </div>
                      </div>
                      <button
                        v-if="settings.superPanel.keyboardHotkey.key"
                        class="clear-btn small"
                        @click="clearSuperPanelHotkey"
                        title="清除"
                      >
                        <i class="fa fa-times"></i>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 鼠标热键 -->
              <div class="sub-setting-group">
                <div class="sub-setting-header">
                  <div class="sub-setting-info">
                    <i class="fa fa-mouse-pointer"></i>
                    <span>鼠标热键</span>
                  </div>
                  <a-switch
                    v-switch-keyboard
                    size="small"
                    v-model:checked="settings.superPanel.mouseHotkey.enabled"
                    @change="saveSettings"
                  />
                </div>

                <div
                  v-if="settings.superPanel.mouseHotkey.enabled"
                  class="sub-setting-content"
                >
                  <div class="mouse-setting-row">
                    <span class="mouse-label">触发方式</span>
                    <a-select
                      v-model:value="settings.superPanel.mouseHotkey.button"
                      style="width: 160px"
                      size="small"
                      @change="saveSettings"
                    >
                      <a-select-option
                        v-for="option in mouseButtonOptions"
                        :key="option.value"
                        :value="option.value"
                      >
                        {{ option.label }}
                      </a-select-option>
                    </a-select>
                  </div>

                  <div v-if="isLongPress" class="slider-setting">
                    <div class="slider-header">
                      <span class="slider-label">长按响应时间</span>
                      <span class="slider-value"
                        >{{
                          settings.superPanel.mouseHotkey.longPressMs
                        }}ms</span
                      >
                    </div>
                    <a-slider
                      v-model:value="
                        settings.superPanel.mouseHotkey.longPressMs
                      "
                      :min="200"
                      :max="500"
                      :step="50"
                      :marks="longPressMarks"
                      @change="saveSettings"
                    />
                  </div>
                </div>
              </div>

              <!-- 其他设置 -->
              <div class="sub-setting-group">
                <div class="sub-setting-header">
                  <div class="sub-setting-info">
                    <i class="fa fa-cogs"></i>
                    <span>其他设置</span>
                  </div>
                </div>

                <div class="sub-setting-content">
                  <div class="mouse-setting-row">
                    <span class="mouse-label">面板位置</span>
                    <a-radio-group
                      v-model:value="settings.superPanel.panelPosition"
                      size="small"
                      @change="saveSettings"
                    >
                      <a-radio-button value="center">屏幕中心</a-radio-button>
                      <a-radio-button value="cursor">鼠标位置</a-radio-button>
                    </a-radio-group>
                  </div>

                  <div class="mouse-setting-row" style="margin-top: 12px">
                    <span class="mouse-label">面板大小</span>
                    <a-radio-group
                      v-model:value="settings.superPanel.panelSize"
                      size="small"
                      @change="saveSettings"
                    >
                      <a-radio-button
                        v-for="option in panelSizeOptions"
                        :key="option.value"
                        :value="option.value"
                      >
                        {{ option.label }} {{ option.desc }}
                      </a-radio-button>
                    </a-radio-group>
                  </div>

                  <div class="mouse-setting-row" style="margin-top: 12px">
                    <span class="mouse-label">默认选中 Tab</span>
                    <a-select
                      v-model:value="settings.superPanel.defaultTab"
                      size="small"
                      style="width: 120px"
                      @change="saveSettings"
                    >
                      <a-select-option
                        v-for="option in defaultTabOptions"
                        :key="option.value"
                        :value="option.value"
                      >
                        {{ option.label }}
                      </a-select-option>
                    </a-select>
                  </div>

                  <div class="mouse-setting-row" style="margin-top: 12px">
                    <span class="mouse-label">最近使用数量</span>
                    <a-input-number
                      v-model:value="settings.superPanel.maxRecentCount"
                      :min="5"
                      :max="20"
                      size="small"
                      style="width: 80px"
                      @change="saveSettings"
                    />
                  </div>
                </div>
              </div>

              <!-- 快捷方式设置 -->
              <div class="sub-setting-group">
                <div class="sub-setting-header" style="cursor: pointer" @click="shortcutModalOpen = true">
                  <div class="sub-setting-info">
                    <i class="fa fa-bolt"></i>
                    <span>快捷方式设置</span>
                  </div>
                  <span style="font-size: 12px; color: var(--zt-text-secondary)">
                    已配置 {{ shortcutCount }} 个快捷方式
                    <i class="fa fa-chevron-right" style="margin-left: 4px; font-size: 10px"></i>
                  </span>
                </div>
              </div>

            </div>
          </div>
        </div>

        <!-- 隐私与权限卡片 -->
        <ScreenPermissionPanel class="wide-card" />

        <!-- 开发者工具卡片 -->
        <div class="settings-card wide-card">
          <div class="card-header">
            <div class="card-icon icon-orange">
              <i class="fa fa-terminal"></i>
            </div>
            <h2 class="card-title">开发者工具</h2>
          </div>

          <div class="settings-list">
            <div class="setting-item dev-item">
              <div class="setting-info">
                <div class="setting-icon">
                  <i class="fa fa-code"></i>
                </div>
                <div class="setting-text">
                  <span class="setting-label">调试控制台</span>
                  <span class="setting-desc"
                    >执行 JS 代码、测试 API、调试插件</span
                  >
                </div>
              </div>
              <button class="open-btn" @click="openDevTools()">
                <i class="fa fa-external-link"></i>
                打开
              </button>
            </div>

            <!-- 开源插件生态大仓 -->
            <div class="setting-item dev-item">
              <div class="setting-info">
                <div class="setting-icon" style="background: rgba(255, 255, 255, 0.08); color: var(--color-text-primary);">
                  <i class="fa fa-github"></i>
                </div>
                <div class="setting-text">
                  <span class="setting-label">开源插件生态大仓 (ZTools-extensions)</span>
                  <span class="setting-desc"
                    >34款核心扩展源码全量开源，开放投稿即 PR，免运维静态分发</span
                  >
                </div>
              </div>
              <button class="open-btn" @click="openExternalUrl('https://github.com/codingmuse/ZTools-extensions')">
                <i class="fa fa-external-link"></i>
                访问
              </button>
            </div>

            <!-- 5分钟快速上手指南 -->
            <div class="setting-item dev-item">
              <div class="setting-info">
                <div class="setting-icon" style="background: rgba(16, 185, 129, 0.15); color: #10b981;">
                  <i class="fa fa-book"></i>
                </div>
                <div class="setting-text">
                  <span class="setting-label">开发者极速上手指南</span>
                  <span class="setting-desc"
                    >纯声明式 UI 标准、一键脚手架生成、5分钟写出你的专属插件</span
                  >
                </div>
              </div>
              <button class="open-btn" @click="openExternalUrl('https://github.com/codingmuse/ZTools-extensions#5-%E5%88%86%E9%92%9F%E8%B4%A1%E7%8C%AE%E4%BD%A0%E7%9A%84%E9%A6%96%E6%AC%BE%E6%8F%92%E4%BB%B6')">
                <i class="fa fa-external-link"></i>
                阅读
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <ShortcutSettingsModal v-model:open="shortcutModalOpen" />
    <PluginHotkeyModal ref="pluginHotkeyModalRef" @update:count="onPluginHotkeyCountUpdate" />
    <PluginFeatureHotkeyModal
      ref="pluginFeatureHotkeyModalRef"
      @update:count="onPluginFeatureHotkeyCountUpdate"
    />
  </div>
</template>

<style scoped>
/* 主题切换器 */
.theme-setting {
  margin-bottom: 8px;
}

.theme-switcher {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  padding: 0 14px;
}

.theme-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: var(--rc-radius-xl, 14px);
  border: 2px solid var(--rc-border);
  background: var(--rc-surface);
  cursor: pointer;
  transition: all 0.3s ease;
}

.theme-btn:hover {
  border-color: var(--rc-accent);
  transform: translateY(-2px);
}

.theme-btn.active {
  border-color: var(--rc-accent);
  background: var(--rc-accent-subtle);
}

.theme-preview {
  width: 100%;
  height: 60px;
  border-radius: var(--rc-radius-md, 8px);
  overflow: hidden;
  border: 1px solid var(--rc-border);
}

.light-preview {
  background: #f8fafc;
}

.dark-preview {
  background: #1a1f2e;
}

.preview-header {
  height: 12px;
  background: linear-gradient(135deg, #4a8cff 0%, #2d71ff 100%);
}

.preview-content {
  display: flex;
  height: calc(100% - 12px);
  padding: 4px;
  gap: 4px;
}

.preview-sidebar {
  width: 20%;
  border-radius: 3px;
}

.light-preview .preview-sidebar {
  background: #e2e8f0;
}

.dark-preview .preview-sidebar {
  background: #313847;
}

.preview-main {
  flex: 1;
  border-radius: 3px;
}

.light-preview .preview-main {
  background: #fff;
}

.dark-preview .preview-main {
  background: #252b3b;
}

.theme-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--rc-text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.theme-btn.active .theme-name {
  color: var(--rc-accent);
}

/* 快捷键录入 */
.hotkey-item {
  flex-wrap: wrap;
  gap: 12px;
}

.hotkey-input-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hotkey-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hotkey-label {
  font-size: 12px;
  color: var(--rc-text-secondary);
}

.hotkey-input-group.compact {
  margin-top: 0;
}

.hotkey-recorder {
  min-width: 140px;
  height: 36px;
  padding: 0 14px;
  border-radius: var(--rc-radius-lg, 10px);
  border: 1.5px solid var(--rc-border);
  background: var(--rc-surface);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
}

.hotkey-recorder.small {
  min-width: 120px;
  height: 32px;
  padding: 0 10px;
}

.hotkey-recorder:hover {
  border-color: var(--rc-accent);
}

.hotkey-recorder.recording {
  border-color: var(--rc-accent);
  background: var(--rc-accent-subtle);
}

.hotkey-hidden-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.recording-text {
  font-size: 12px;
  font-weight: 500;
  color: var(--rc-accent);
  display: flex;
  align-items: center;
  gap: 6px;
}

.recording-text.small {
  font-size: 11px;
}

.recording-dot {
  font-size: 6px;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}

.hotkey-keys {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 子设置 (超级面板展开区) */
.sub-settings {
  margin-top: 8px;
  margin-left: 32px;
  padding: 16px;
  background: var(--rc-surface-subtle);
  border-radius: var(--rc-radius-xl, 14px);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sub-setting-group {
  padding: 10px 14px;
  background: var(--rc-surface);
  border-radius: var(--rc-radius-lg, 12px);
  border: 1px solid var(--rc-border);
}

.sub-setting-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sub-setting-info {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--rc-text-primary);
}

.sub-setting-info i {
  color: var(--rc-text-secondary);
  font-size: 12px;
}

.sub-setting-content {
  margin-top: 12px;
  padding: 12px 12px 0 24px;
  border-top: 1px solid var(--rc-border);
}

.mouse-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.mouse-label {
  font-size: 12px;
  color: var(--rc-text-secondary);
}

.slider-setting {
  margin-top: 16px;
  padding: 0 24px;
}

.slider-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.slider-label {
  font-size: 12px;
  color: var(--rc-text-secondary);
}

.slider-value {
  font-size: 12px;
  font-weight: 600;
  color: var(--rc-accent);
}

/* 开发者工具按钮 */
.open-btn {
  padding: 8px 16px;
  border-radius: var(--rc-radius-lg, 10px);
  border: none;
  background: linear-gradient(135deg, #ffaf41 0%, #ff9500 100%);
  color: white;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all 0.3s ease;
  box-shadow: 0 4px 12px rgba(255, 175, 65, 0.25);
}

.open-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 16px rgba(255, 175, 65, 0.35);
}

.open-btn:active {
  transform: translateY(0);
}

/* 动画 */
@keyframes slideDown {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-in {
  animation: slideDown 0.3s ease-out forwards;
}

/* 响应式 */
@media (max-width: 768px) {
  .hotkey-item {
    flex-direction: column;
    align-items: flex-start;
  }

  .hotkey-input-group {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>

