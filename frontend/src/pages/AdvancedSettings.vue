<script setup>
import { RcSelect } from '@/components/base'
import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, XIcon } from '@lucide/vue'
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
import { track } from '@edition'
import { useThemeStore } from '@/stores/theme'
import { ROUTES } from '@/router/routes'
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
import { DEFAULT_GLOBAL_WAKE_HOTKEY, syncGlobalWakeHotkey } from '@/utils/globalWakeHotkey'
import { isMacOS } from '@/utils/platform'
import { isHostDevBuild } from '@/utils/hostDevTools'
import { setWakePreference, windowModeState, WAKE_PREFERENCES } from '@/utils/windowMode'
import { vSwitchKeyboard } from '@/directives/switchKeyboard'
import ScreenPermissionPanel from '@/components/ScreenPermissionPanel.vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import RcSegmented from '@/components/base/RcSegmented.vue'
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
const { isDark, mode: themeMode } = storeToRefs(themeStore)
const themeSaving = ref(false)
const router = useRouter()
const route = useRoute()
const hotkeyPlatform = ref('unknown')
const supportsDoubleModifierHotkeys = ref(false)
const autostartStatus = ref('')
const autostartKnown = ref(false)
const autostartSaving = ref(false)
const autostartDescription = computed(() => ({
  unavailable: '无法读取登录项状态',
  'dev-unsupported': '开发版不支持开机启动，安装正式版后可用',
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
  hotkey: DEFAULT_GLOBAL_WAKE_HOTKEY,
  wakePreference: windowModeState.wakePreference || 'dashboard',
  minimizeToTray: true,
  showTrayIcon: true,
  closeConfirm: true,
  superPanel: {
    enabled: true,
    keyboardHotkey: {
      enabled: true,
      // Alt+Space 留给全局唤醒（悬浮条），两者默认值不能相同
      modifiers: ['Alt', 'Shift'],
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

const panelPositionOptions = [
  { value: 'center', label: '屏幕中心' },
  { value: 'cursor', label: '鼠标位置' }
]

const panelSizeOptions = [
  { value: 'small', label: '小', hint: '400×300' },
  { value: 'medium', label: '中', hint: '400×600' },
  { value: 'large', label: '大', hint: '800×600' }
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

// 读取登录项状态；失败时界面显示错误与「重试」，不用重新打开设置
const loadAutostart = async () => {
  autostartKnown.value = false
  // macOS 开发版（未打包）主进程不接入系统登录项，读到的只是配置里存的值，开关无效，直接禁用
  if (isMacOS() && (await isHostDevBuild())) {
    autostartStatus.value = 'dev-unsupported'
    return
  }
  try {
    settings.autostart = await getAutostart()
    autostartKnown.value = true
    await refreshAutostartStatus()
  } catch (e) {
    console.error('Failed to load autostart:', e)
    autostartStatus.value = 'unavailable'
  }
}

const loadSettings = async () => {
  try {
    await loadAutostart()
    // 空串表示用户已关闭全局唤醒，按原样显示「点击设置」，不能套默认值
    try {
      settings.hotkey = await getHotkey()
    } catch (e) {
      console.error('Failed to load wake hotkey:', e)
      error('读取全局唤醒快捷键失败')
    }
    try {
      settings.minimizeToTray = await getMinimizeToTray()
    } catch {}
    try {
      settings.closeConfirm = await getCloseConfirm()
    } catch {}
    // getShowTrayIcon 读取失败时返回默认值 true，不会抛错
    settings.showTrayIcon = await getShowTrayIcon()
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

const themeOptions = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]
const wakeOptions = [
  { value: 'launcher', label: '悬浮条' },
  { value: 'dashboard', label: '工作台' }
]
const builtinShortcuts = [
  { label: '聚焦搜索', combo: 'Ctrl+F' },
  { label: '动作面板', combo: 'Ctrl+K' },
  { label: '切换到悬浮条', combo: 'Ctrl+M' },
  { label: '打开设置', combo: 'Ctrl+,' },
  { label: '返回主页', combo: 'Escape' }
]
const pickTheme = async (value) => {
  if (themeMode.value === value || themeSaving.value) return
  themeSaving.value = true
  try {
    await themeStore.setTheme(value)
  } catch (err) {
    error('主题设置保存失败：' + (err?.message || '未知错误'))
  } finally {
    themeSaving.value = false
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

// 全局唤醒快捷键单独保存：超级面板等其它设置保存时不能连带改写它
const saveWakeHotkey = async () => {
  if (!(await setHotkey(settings.hotkey))) {
    error('全局唤醒快捷键保存失败')
    return
  }
  let result
  try {
    result = await syncGlobalWakeHotkey({ hotkey: settings.hotkey })
  } catch (err) {
    console.error('同步全局快捷键失败:', err)
    error('快捷键注册失败: ' + (err?.message || '未知错误'))
    return
  }
  if (!result.success) {
    const reasonMessages = {
      trigger_unavailable: '快捷键服务暂不可用',
      trigger_list_failed: '读取已有快捷键失败',
      trigger_register_failed: '新快捷键注册失败，已尝试恢复原注册',
      trigger_unregister_failed: '注销快捷键失败'
    }
    let message = reasonMessages[result.reason] || '快捷键服务返回失败'
    if (result.message) message += `：${result.message}`
    if (result.rollbackFailed) message += '；恢复原快捷键也失败，请重新设置'
    console.warn('全局唤醒快捷键同步失败:', result)
    error(`设置已保存，但全局唤醒快捷键同步失败：${message}`)
    return
  }
  success(settings.hotkey ? '全局唤醒快捷键已保存' : '已关闭全局唤醒快捷键')
  track('settings_change', '', { type: 'wake_hotkey' })
}

const saveSuperPanelSettings = async () => {
  try {
    if (!window.ztools?.config) throw new Error('配置服务不可用')
    await window.ztools.config.set('super_panel', settings.superPanel)
    if (window.ztools?.sys?.reloadHotkeys) {
      await window.ztools.sys.reloadHotkeys()
    }
  } catch (e) {
    console.error('Failed to save super panel settings:', e)
    error('超级面板设置保存失败：' + (e?.message || '未知错误'))
    return
  }
  success('设置已保存')
  track('settings_change', '', { type: 'super_panel' })
}

// 托盘图标的叫法随系统：macOS 是顶部菜单栏，Windows 是任务栏右下角
const trayIconLabel = isMacOS() ? '菜单栏图标' : '托盘图标'
const trayIconDesc = isMacOS() ? '在屏幕顶部菜单栏显示 ZTools 图标' : '在任务栏右下角显示 ZTools 图标'
const minimizeToTrayLabel = isMacOS() ? '关闭后在后台运行' : '最小化到托盘'
const closeConfirmDesc = isMacOS() ? '关闭主窗口时询问退出还是在后台继续运行' : '关闭主窗口时询问退出或最小化到托盘'
// 鼠标触发超级面板依赖 Windows 原生输入进程，macOS 没有对应实现，设置项不显示
const supportsMouseHotkey = !isMacOS()

const saveShowTrayIcon = async (checked) => {
  const ok = await setShowTrayIcon(!!checked)
  if (!ok) {
    settings.showTrayIcon = !checked
    error(`保存${trayIconLabel}设置失败`)
    return
  }
  success(checked ? `已显示${trayIconLabel}` : `已隐藏${trayIconLabel}`)
  track('settings_change', '', { type: 'tray_icon' })
}

// 两个 setter 失败时返回 false 而不抛错，必须检查返回值；失败后从配置重新读取，界面与实际保存的值保持一致
const saveTraySettings = async () => {
  const saved = await setMinimizeToTray(!!settings.minimizeToTray) &&
    await setCloseConfirm(!!settings.closeConfirm)
  if (!saved) {
    settings.minimizeToTray = await getMinimizeToTray()
    settings.closeConfirm = await getCloseConfirm()
    error('关闭窗口设置保存失败')
    return
  }
  success('关闭窗口设置已保存')
  track('settings_change', '', { type: 'tray' })
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
  saveWakeHotkey()
}

const clearHotkey = () => {
  settings.hotkey = ''
  saveWakeHotkey()
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
  saveSuperPanelSettings()
}

const clearSuperPanelHotkey = () => {
  resetHotkeyRecorderState()
  settings.superPanel.keyboardHotkey.modifiers = []
  settings.superPanel.keyboardHotkey.key = ''
  saveSuperPanelSettings()
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
        <h1 class="page-title">设置</h1>
        <p class="page-subtitle">修改后立即生效并自动保存</p>
      </div>

      <!-- 设置卡片网格 -->
      <div class="settings-grid">
        <!-- 外观设置卡片 -->
        <div class="settings-card">
          <div class="card-header">
            <h2 class="card-title">外观</h2>
          </div>

          <div class="settings-list">
            <div class="theme-switcher" role="radiogroup" aria-label="界面主题">
              <button
                v-for="option in themeOptions"
                :key="option.value"
                type="button"
                role="radio"
                class="theme-btn"
                :class="{ active: themeMode === option.value }"
                :aria-checked="themeMode === option.value"
                :disabled="themeSaving"
                @click="pickTheme(option.value)"
              >
                <div class="theme-preview" :class="`${option.value === 'system' ? (isDark ? 'dark' : 'light') : option.value}-preview`" aria-hidden="true">
                  <div class="preview-bar"><span class="preview-mark"></span></div>
                  <div class="preview-line" style="width: 70%"></div>
                  <div class="preview-line" style="width: 45%"></div>
                </div>
                <span class="theme-name"><span class="theme-marker" aria-hidden="true"></span>{{ option.label }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 常规设置卡片 -->
        <div class="settings-card">
          <div class="card-header">
            <h2 class="card-title">通用</h2>
          </div>

          <div class="settings-list">
            <!-- 开机自动启动 -->
            <div class="setting-item">
              <div class="setting-info">
                <div class="setting-text">
                  <span class="setting-label">开机自动启动</span>
                  <span
                    class="setting-desc"
                    :class="{ 'is-error': autostartStatus === 'unavailable' }"
                    data-testid="autostart-status"
                  >
                    {{ autostartDescription }}
                    <button
                      v-if="autostartStatus === 'unavailable'"
                      type="button"
                      class="setting-inline-link"
                      data-testid="autostart-retry"
                      @click="loadAutostart"
                    >重试</button>
                  </span>
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

            <!-- 托盘图标（Windows 通知区域 / macOS 菜单栏） -->
            <div class="setting-item">
              <div class="setting-info">
                <div class="setting-text">
                  <span class="setting-label">{{ trayIconLabel }}</span>
                  <span class="setting-desc">{{ trayIconDesc }}</span>
                </div>
              </div>
              <a-switch
                v-switch-keyboard
                size="small"
                v-model:checked="settings.showTrayIcon"
                data-testid="tray-icon-switch"
                @change="saveShowTrayIcon"
              />
            </div>

            <!-- 退出确认 -->
            <div class="setting-item">
              <div class="setting-info">
                <div class="setting-text">
                  <span class="setting-label">退出确认</span>
                  <span class="setting-desc">{{ closeConfirmDesc }}</span>
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
                <div class="setting-text">
                  <span class="setting-label">{{ minimizeToTrayLabel }}</span>
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

        <!-- 快捷键设置卡片 -->
        <div class="settings-card wide-card">
          <div class="card-header">
            <h2 class="card-title">快捷键</h2>
          </div>

          <div class="settings-list">
            <!-- 全局唤醒快捷键 -->
            <div class="setting-item hotkey-item">
              <div class="setting-info">
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
                    <span class="recording-dot" aria-hidden="true"></span>
                    {{
                      hotkeyRecordingText ||
                      getHotkeyWaitText(hotkeyPlatform, supportsDoubleModifierHotkeys)
                    }}
                  </span>
                  <div v-else class="hotkey-keys">
                    <ShortcutKeys v-if="settings.hotkey" :combo="formatHotkeyForPlatform(settings.hotkey, hotkeyPlatform, supportsDoubleModifierHotkeys)" />
                    <span v-else class="no-hotkey">点击设置</span>
                  </div>
                </div>
                <button
                  v-if="settings.hotkey"
                  class="clear-btn"
                  @click="clearHotkey"
                  title="清除"
                >
                  <XIcon  />
                </button>
              </div>
            </div>

            <!-- 呼出形态偏好设置 -->
            <div class="setting-item">
              <div class="setting-info">
                <div class="setting-text">
                  <span class="setting-label">默认呼出形态</span>
                  <span class="setting-desc">按全局热键唤醒时的窗口展示模式</span>
                </div>
              </div>
              <div class="setting-control">
                <RcSegmented
                  variant="marker"
                  aria-label="默认呼出形态"
                  :model-value="settings.wakePreference"
                  :options="wakeOptions"
                  @change="onWakePreferenceChange"
                />
              </div>
            </div>

            <!-- 启动快捷键（独立项） -->
            <div class="setting-item" style="cursor: pointer" @click="openPluginHotkeyModal">
              <div class="setting-info">
                <div class="setting-text">
                  <span class="setting-label">启动快捷键</span>
                  <span class="setting-desc">为指定插件或本地应用设置全局独立启动热键</span>
                </div>
              </div>
              <span style="font-size: 12px; color: var(--rc-text-secondary)">
                已配置 {{ pluginHotkeyCount }} 个快捷键
                <ChevronRightIcon  style="margin-left: 4px; font-size: 10px" />
              </span>
            </div>

            <div
              class="setting-item"
              style="cursor: pointer"
              @click="openPluginFeatureHotkeyModal"
            >
              <div class="setting-info">
                <div class="setting-text">
                  <span class="setting-label">功能快捷键</span>
                  <span class="setting-desc">为插件内置功能（如截图、文字识别）设置全局热键</span>
                </div>
              </div>
              <span style="font-size: 12px; color: var(--rc-text-secondary)">
                已配置 {{ pluginFeatureHotkeyCount }} 个快捷键
                <ChevronRightIcon  style="margin-left: 4px; font-size: 10px" />
              </span>
            </div>

            <!-- 超级面板 -->
            <div ref="superPanelSettingRef" class="setting-item">
              <div class="setting-info">
                <div class="setting-text">
                  <span class="setting-label">超级面板</span>
                  <span class="setting-desc">快速启动插件的便捷面板</span>
                </div>
              </div>
              <a-switch
                v-switch-keyboard
                size="small"
                v-model:checked="settings.superPanel.enabled"
                @change="saveSuperPanelSettings"
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
                    <span>键盘热键</span>
                  </div>
                  <a-switch
                    v-switch-keyboard
                    size="small"
                    v-model:checked="settings.superPanel.keyboardHotkey.enabled"
                    @change="saveSuperPanelSettings"
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
                          <span class="recording-dot" aria-hidden="true"></span>
                          {{ superPanelKeyRecordingText || getHotkeyWaitText(hotkeyPlatform, false) }}
                        </span>
                        <div v-else class="hotkey-keys">
                          <template
                            v-if="
                              settings.superPanel.keyboardHotkey.key
                            "
                          >
                            <ShortcutKeys :combo="formatSuperPanelHotkey(settings.superPanel.keyboardHotkey)" />
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
                        <XIcon  />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 鼠标热键（仅 Windows） -->
              <div v-if="supportsMouseHotkey" class="sub-setting-group">
                <div class="sub-setting-header">
                  <div class="sub-setting-info">
                    <span>鼠标热键</span>
                  </div>
                  <a-switch
                    v-switch-keyboard
                    size="small"
                    v-model:checked="settings.superPanel.mouseHotkey.enabled"
                    @change="saveSuperPanelSettings"
                  />
                </div>

                <div
                  v-if="settings.superPanel.mouseHotkey.enabled"
                  class="sub-setting-content"
                >
                  <div class="mouse-setting-row">
                    <span class="mouse-label">触发方式</span>
                    <RcSelect
                      v-model:value="settings.superPanel.mouseHotkey.button"
                      style="width: 180px"
                      @change="saveSuperPanelSettings"
                    >
                      <a-select-option
                        v-for="option in mouseButtonOptions"
                        :key="option.value"
                        :value="option.value"
                      >
                        {{ option.label }}
                      </a-select-option>
                    </RcSelect>
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
                      @change="saveSuperPanelSettings"
                    />
                  </div>
                </div>
              </div>

              <!-- 其他设置 -->
              <div class="sub-setting-group">
                <div class="sub-setting-header">
                  <div class="sub-setting-info">
                    <span>其他设置</span>
                  </div>
                </div>

                <div class="sub-setting-content">
                  <div class="mouse-setting-row">
                    <span class="mouse-label">面板位置</span>
                    <RcSegmented
                      v-model="settings.superPanel.panelPosition"
                      variant="marker"
                      aria-label="面板位置"
                      :options="panelPositionOptions"
                      @change="saveSuperPanelSettings"
                    />
                  </div>

                  <div class="mouse-setting-row">
                    <span class="mouse-label">面板大小</span>
                    <RcSegmented
                      v-model="settings.superPanel.panelSize"
                      variant="marker"
                      aria-label="面板大小"
                      :options="panelSizeOptions"
                      @change="saveSuperPanelSettings"
                    />
                  </div>

                  <div class="mouse-setting-row">
                    <span class="mouse-label">默认标签</span>
                    <RcSegmented
                      v-model="settings.superPanel.defaultTab"
                      variant="marker"
                      aria-label="默认标签"
                      :options="defaultTabOptions"
                      @change="saveSuperPanelSettings"
                    />
                  </div>

                  <div class="mouse-setting-row">
                    <span class="mouse-label">最近使用数量</span>
                    <a-input-number
                      v-model:value="settings.superPanel.maxRecentCount"
                      :min="5"
                      :max="20"
                      style="width: 88px"
                      @change="saveSuperPanelSettings"
                  >
                    <template #upIcon><ChevronUpIcon aria-hidden="true" /></template>
                    <template #downIcon><ChevronDownIcon aria-hidden="true" /></template>
                  </a-input-number>
                  </div>
                </div>
              </div>

              <!-- 快捷方式设置 -->
              <div class="sub-setting-group">
                <div class="sub-setting-header" style="cursor: pointer" @click="shortcutModalOpen = true">
                  <div class="sub-setting-info">
                    <span>快捷方式设置</span>
                  </div>
                  <span style="font-size: 12px; color: var(--rc-text-secondary)">
                    已配置 {{ shortcutCount }} 个快捷方式
                    <ChevronRightIcon  style="margin-left: 4px; font-size: 10px" />
                  </span>
                </div>
              </div>

            </div>
          </div>
        </div>

        <!-- 常用快捷键（只读）：与 MainLayout 中 GLOBAL 作用域绑定保持一致 -->
        <div class="settings-card">
          <div class="card-header">
            <h2 class="card-title">常用快捷键</h2>
          </div>
          <div class="settings-list">
            <div v-for="item in builtinShortcuts" :key="item.combo" class="setting-item compact">
              <span class="setting-label">{{ item.label }}</span>
              <ShortcutKeys :combo="item.combo" />
            </div>
          </div>
        </div>

        <!-- 隐私与权限卡片 -->
        <ScreenPermissionPanel class="wide-card" />
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
/* 主题选择：选中项用余烬橙方块标记 */
.theme-switcher {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 10px;
  padding-top: 4px;
}

.theme-btn {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 8px 10px;
  border-radius: 12px;
  border: 1px solid var(--rc-border);
  background: var(--rc-surface);
  color: var(--rc-text-secondary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.theme-btn:hover {
  border-color: var(--rc-border-highlight);
}

.theme-btn.active {
  border-color: var(--rc-accent);
}

.theme-btn:focus-visible {
  outline: 2px solid var(--rc-accent);
  outline-offset: 2px;
}

.theme-preview {
  height: 78px;
  border-radius: 8px;
  padding: 10px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* 预览卡固定展示「雾白 / 墨黑」两套真实配色，不随当前主题变化 */
.light-preview {
  background: #f4f3f0;
  box-shadow: inset 0 0 0 1px #e7e5e0;
}

.dark-preview {
  background: #0b0b0c;
  box-shadow: inset 0 0 0 1px #202024;
}

.preview-bar {
  height: 14px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  padding-left: 5px;
}

.light-preview .preview-bar {
  background: #ffffff;
}

.dark-preview .preview-bar {
  background: #1a1a1d;
}

.preview-mark {
  width: 4px;
  height: 4px;
  border-radius: 1px;
  background: #ff6b3d;
}

.preview-line {
  height: 6px;
  border-radius: 2px;
}

.light-preview .preview-line {
  background: #dbd8d2;
}

.dark-preview .preview-line {
  background: #2c2c31;
}

.theme-name {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px;
  font-size: 13px;
}

.theme-btn.active .theme-name {
  color: var(--rc-text-primary);
  font-weight: 600;
}

.theme-marker {
  width: 6px;
  height: 6px;
  border-radius: 1.7px;
  flex-shrink: 0;
  background: transparent;
}

.theme-btn.active .theme-marker {
  background: var(--rc-accent);
  box-shadow: 0 0 8px rgba(255, 107, 61, 0.55);
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
  min-width: 132px;
  height: 32px;
  padding: 0 12px;
  border-radius: 8px;
  border: 1px solid var(--rc-border-highlight);
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
  color: var(--rc-accent-text);
  display: flex;
  align-items: center;
  gap: 6px;
}

.recording-text.small {
  font-size: 11px;
}

.recording-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
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
  margin: 0 0 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sub-setting-group {
  padding: 12px 14px;
  background: var(--rc-surface-subtle);
  border-radius: 10px;
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

.sub-setting-content {
  margin-top: 10px;
  border-top: 1px solid var(--rc-border);
}

/* 子设置行：与主列表同构（左名称、右控件），行间细线分隔 */
.mouse-setting-row {
  min-height: 46px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 16px;
  padding: 7px 0;
  border-bottom: 1px solid var(--rc-border);
}

.sub-setting-content > :last-child {
  border-bottom: none;
}

.mouse-label {
  font-size: 13px;
  color: var(--rc-text-secondary);
}

.slider-setting {
  padding: 10px 0 4px;
}

/* 刻度文字居中于端点，两侧留出半个标签宽度，避免超出卡片 */
.slider-setting :deep(.ant-slider) {
  margin: 10px 22px 22px;
}

/* 数字输入统一为 32px 高、8px 圆角，与快捷键录入框、下拉框（RcSelect）一致 */
.sub-settings :deep(.ant-input-number) {
  height: 32px;
  border-radius: 8px;
  border-color: var(--rc-border-highlight);
  background: transparent;
  box-shadow: none;
}

.sub-settings :deep(.ant-input-number .ant-input-number-input) {
  height: 30px;
}

.sub-settings :deep(.ant-input-number:hover),
.sub-settings :deep(.ant-input-number-focused) {
  border-color: var(--rc-accent);
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
  color: var(--rc-accent-text);
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

