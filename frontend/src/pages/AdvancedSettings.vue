<script setup>
import { ChevronRightIcon } from '@lucide/vue'
import {
  ref,
  reactive,
  onMounted,
  onActivated,
  onDeactivated,
  onBeforeUnmount,
  watch,
  nextTick,
  computed
} from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useToast } from '@/composables/useToast'
import { track } from '@edition'
import AppearanceSettings from '@/components/settings/AppearanceSettings.vue'
import BundledPluginsSettings, { queueBundledPluginFocus } from '@/components/settings/BundledPluginsSettings.vue'
import { ROUTES } from '@/router/routes'
import { useAppPreferencesApi } from '@/composables/useAppPreferencesApi'
import {
  DEFAULT_GLOBAL_WAKE_HOTKEY,
  DEFAULT_MOUSE_LONG_PRESS_MS,
  MAX_MOUSE_LONG_PRESS_MS,
  MIN_MOUSE_LONG_PRESS_MS,
  MOUSE_WAKE_OPTIONS,
  parseMouseWakeTrigger,
  syncFullscreenDndToTriggers,
  syncGlobalWakeHotkey,
  syncMouseWakeHook
} from '@/utils/globalWakeHotkey'
import { isMacOS } from '@/utils/platform'
import { isHostDevBuild } from '@/utils/hostDevTools'
import { setWakePreference, windowModeState } from '@/utils/windowMode'
import { vSwitchKeyboard } from '@/directives/switchKeyboard'
import ScreenPermissionPanel from '@/components/ScreenPermissionPanel.vue'
import HotkeyCaptureField from '@/components/HotkeyCaptureField.vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import RcSegmented from '@/components/base/RcSegmented.vue'
import { RcButton, RcSelect } from '@/components/base'
import PluginHotkeyModal from '@/components/PluginHotkeyModal.vue'
import PluginFeatureHotkeyModal from '@/components/PluginFeatureHotkeyModal.vue'
import { useNavStore } from '@/stores/nav'
import {
  PLUGIN_FEATURE_HOTKEY_QUERY_KEY,
  getPluginFeatureHotkeyItemByTrigger,
  isDeprecatedPluginFeatureHotkeyItem
} from '@/utils/pluginFeatureHotkeys'
import {
  getHotkeyHostCapabilities,
  getHotkeyWaitText,
  getShellReserveWarning,
  interpretRecorderKeydown,
  isDoubleModifierHotkey,
  resetHotkeyRecorderState
} from '@/utils/hotkeyRecorder'
import { buildLaunchHotkeyMap } from '@/utils/launchHotkeyTargets'
import { BUILTIN_SHORTCUT_HINTS } from '@/utils/shellShortcuts'

const { success, error, warning } = useToast()
const {
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
} = useAppPreferencesApi()
const router = useRouter()
const route = useRoute()
const hotkeyPlatform = ref('unknown')
const supportsDoubleModifierHotkeys = ref(false)
const supportsMouseTriggers = ref(false)
const showWindowsWakeExtensions = computed(
  () => supportsDoubleModifierHotkeys.value || supportsMouseTriggers.value
)
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

// 设置页 4 个主 Tab 及其查询参数别名映射（唯一信源）
const SETTINGS_TAB_OPTIONS = Object.freeze([
  { value: 'general', label: '常规与外观' },
  { value: 'shortcuts', label: '快捷键' },
  { value: 'bundled', label: '内置插件' },
  { value: 'privacy', label: '隐私与权限' }
])

const SETTINGS_TAB_ALIASES = Object.freeze({
  general: 'general',
  appearance: 'general',
  shortcuts: 'shortcuts',
  hotkey: 'shortcuts',
  hotkeys: 'shortcuts',
  bundled: 'bundled',
  privacy: 'privacy',
  permission: 'privacy',
  permissions: 'privacy'
})

function resolveSettingsTab(rawTab) {
  if (typeof rawTab !== 'string') return null
  const normalized = rawTab.trim().toLowerCase()
  if (!normalized || !Object.hasOwn(SETTINGS_TAB_ALIASES, normalized)) return null
  return SETTINGS_TAB_ALIASES[normalized]
}

const activeTab = ref(resolveSettingsTab(route?.query?.tab) || 'general')
const activeTabLabel = computed(
  () => SETTINGS_TAB_OPTIONS.find((item) => item.value === activeTab.value)?.label || '常规与外观'
)

// 启动快捷键弹窗引用
const pluginHotkeyModalRef = ref(null)
const pluginFeatureHotkeyModalRef = ref(null)
const bundledPluginsSettingsRef = ref(null)
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
  mouseWakeMode: 'off',
  mouseLongPressMs: DEFAULT_MOUSE_LONG_PRESS_MS,
  fullscreenDnd: false
})
const wakeHotkeyFieldRef = ref(null)
const hotkeyRecording = ref(false)
const hotkeyRecordingText = ref('')
const hotkeyRecordingIsKeys = ref(false)
const hotkeySaving = ref(false)
const mouseWakeSaving = ref(false)
const fullscreenDndSaving = ref(false)

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

/** 从原生触发器列表同步鼠标快捷唤醒与全屏免打扰状态 */
const loadTriggerWakePreferences = async () => {
  try {
    if (!window.ztools?.trigger?.list) return
    const result = await window.ztools.trigger.list()
    if (isUnmounted) return
    const triggers = result?.data || result || []
    if (!Array.isArray(triggers)) return

    const mouseConfig = parseMouseWakeTrigger(triggers)
    settings.mouseWakeMode = mouseConfig.mode
    settings.mouseLongPressMs = mouseConfig.longPressMs

    const doubleHotkey = triggers.find(
      (trigger) =>
        trigger?.type === 'hotkey' &&
        isDoubleModifierHotkey(trigger?.config?.key)
    )
    if (mouseConfig.exists) {
      settings.fullscreenDnd = mouseConfig.fullscreenDnd
    } else if (doubleHotkey) {
      settings.fullscreenDnd = doubleHotkey.config?.fullscreenDnd !== false
    } else {
      // 默认开启全屏游戏/演示免打扰，与原生钩子默认策略一致
      settings.fullscreenDnd = true
    }
  } catch (e) {
    console.warn('[AdvancedSettings] 读取触发器唤醒扩展配置失败:', e)
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
    // 以下两项读取失败时保留默认值，开关仍可操作并重新保存
    try {
      settings.minimizeToTray = await getMinimizeToTray()
    } catch (e) {
      console.warn('读取最小化到托盘设置失败，使用默认值:', e)
    }
    try {
      settings.closeConfirm = await getCloseConfirm()
    } catch (e) {
      console.warn('读取退出确认设置失败，使用默认值:', e)
    }
    // getShowTrayIcon 读取失败时返回默认值 true，不会抛错
    settings.showTrayIcon = await getShowTrayIcon()
    settings.wakePreference = windowModeState.wakePreference || 'dashboard'
    await loadTriggerWakePreferences()
  } catch (e) {
    console.error('Failed to load settings:', e)
    error('加载设置失败')
  }
}

const wakeOptions = [
  { value: 'launcher', label: '悬浮条' },
  { value: 'dashboard', label: '工作台' }
]
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

/** 刷新宿主托盘与全局热键展示 */
const reloadHostHotkeys = async () => {
  try {
    await window.ztools?.sys?.reloadHotkeys?.()
  } catch (err) {
    console.warn('[AdvancedSettings] 刷新宿主快捷键配置失败:', err)
  }
}

// 全局唤醒快捷键单独保存：其它设置保存时不能连带改写它
const saveWakeHotkey = async (nextHotkey = settings.hotkey) => {
  if (hotkeySaving.value) return false
  const previousHotkey = settings.hotkey
  const targetHotkey = typeof nextHotkey === 'string' ? nextHotkey : ''
  hotkeySaving.value = true
  try {
    // 双向冲突预检：检查是否与已注册的插件快捷键或系统内置热键冲突
    if (targetHotkey && window.ztools?.trigger?.checkConflict) {
      const conflictResult = await window.ztools.trigger.checkConflict(
        targetHotkey,
        'system',
        'global_wake_hotkey'
      )
      const conflictData = conflictResult?.data || conflictResult || {}
      if (conflictData.hasConflict && conflictData.conflicts?.length > 0) {
        const names = conflictData.conflicts
          .map((item) => item.pluginName || item.pluginId || '系统内置功能')
          .join('、')
        error(`全局唤醒快捷键与「${names}」冲突，请更换其他组合键`)
        return false
      }
    }

    settings.hotkey = targetHotkey
    if (!(await setHotkey(targetHotkey))) {
      settings.hotkey = previousHotkey
      error('全局唤醒快捷键保存失败')
      return false
    }
    let result
    try {
      result = await syncGlobalWakeHotkey({
        hotkey: targetHotkey,
        fullscreenDnd: settings.fullscreenDnd
      })
    } catch (err) {
      console.error('同步全局快捷键失败:', err)
      error('快捷键注册失败: ' + (err?.message || '未知错误'))
      return false
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
      return false
    }
    await reloadHostHotkeys()
    success(targetHotkey ? '全局唤醒快捷键已保存' : '已关闭全局唤醒快捷键')
    const reserveWarning = getShellReserveWarning(targetHotkey)
    if (reserveWarning) {
      warning(reserveWarning)
    }
    track('settings_change', '', { type: 'wake_hotkey' })
    return true
  } finally {
    hotkeySaving.value = false
  }
}

/** 恢复全局唤醒快捷键为默认 Alt+Space */
const restoreDefaultHotkey = async () => {
  await saveWakeHotkey(DEFAULT_GLOBAL_WAKE_HOTKEY)
}

/** 保存 Windows 鼠标快捷唤醒设置 */
const saveMouseWakeSetting = async () => {
  if (mouseWakeSaving.value) return
  mouseWakeSaving.value = true
  try {
    const result = await syncMouseWakeHook({
      mode: settings.mouseWakeMode,
      longPressMs: settings.mouseLongPressMs,
      fullscreenDnd: settings.fullscreenDnd
    })
    if (!result.success) {
      await loadTriggerWakePreferences()
      error(`鼠标快捷唤醒设置失败${result.message ? `：${result.message}` : ''}`)
      return
    }
    await reloadHostHotkeys()
    success(settings.mouseWakeMode === 'off' ? '已关闭鼠标快捷唤醒' : '鼠标快捷唤醒设置已保存')
    track('settings_change', '', { type: 'mouse_wake_hook' })
  } catch (err) {
    console.error('保存鼠标快捷唤醒失败:', err)
    await loadTriggerWakePreferences()
    error('鼠标快捷唤醒设置失败: ' + (err?.message || '未知错误'))
  } finally {
    mouseWakeSaving.value = false
  }
}

/** 保存全屏游戏 / 演示免打扰设置并同步到相关触发器 */
const saveFullscreenDnd = async (checked) => {
  if (fullscreenDndSaving.value) return
  const enabled = Boolean(checked)
  const previous = !enabled
  fullscreenDndSaving.value = true
  try {
    const result = await syncFullscreenDndToTriggers(enabled)
    if (!result.success) {
      settings.fullscreenDnd = previous
      error(`保存全屏免打扰设置失败${result.message ? `：${result.message}` : ''}`)
      return
    }
    settings.fullscreenDnd = enabled
    await reloadHostHotkeys()
    success(enabled ? '已开启全屏游戏 / 演示免打扰' : '已关闭全屏游戏 / 演示免打扰')
    track('settings_change', '', { type: 'fullscreen_dnd' })
  } catch (err) {
    console.error('保存全屏免打扰设置失败:', err)
    settings.fullscreenDnd = previous
    error('保存全屏免打扰设置失败: ' + (err?.message || '未知错误'))
  } finally {
    fullscreenDndSaving.value = false
  }
}

// 托盘图标的叫法随系统：macOS 是顶部菜单栏，Windows 是任务栏右下角
const trayIconLabel = isMacOS() ? '菜单栏图标' : '托盘图标'
const trayIconDesc = isMacOS() ? '在屏幕顶部菜单栏显示 ZTools 图标' : '在任务栏右下角显示 ZTools 图标'
const minimizeToTrayLabel = isMacOS() ? '关闭后在后台运行' : '最小化到托盘'
const closeConfirmDesc = isMacOS() ? '关闭主窗口时询问退出还是在后台继续运行' : '关闭主窗口时询问退出或最小化到托盘'

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

const handleWakeHotkeyKeydown = async (event) => {
  event?.preventDefault?.()
  event?.stopPropagation?.()
  if (!hotkeyRecording.value || hotkeySaving.value) return

  const result = interpretRecorderKeydown(event, {
    platform: hotkeyPlatform.value,
    allowDoubleTap: supportsDoubleModifierHotkeys.value
  })
  if (result.action === 'cancel') {
    stopHotkeyRecording(true)
    return
  }
  if (result.action === 'clear') {
    stopHotkeyRecording(true)
    if (settings.hotkey) {
      await clearHotkey()
    }
    return
  }
  hotkeyRecordingText.value = result.text
  hotkeyRecordingIsKeys.value = result.isKeys
  if (result.action !== 'valid') return
  stopHotkeyRecording(true)
  await saveWakeHotkey(result.hotkey)
}

const clearHotkey = async () => {
  await saveWakeHotkey('')
}

const startHotkeyRecording = () => {
  if (hotkeySaving.value) return
  resetHotkeyRecorderState()
  hotkeyRecording.value = true
  hotkeyRecordingText.value = ''
  hotkeyRecordingIsKeys.value = false
}

/** 从 Delphi 端加载插件的启动快捷键数据并缓存 */
async function loadPluginHotkeyCount() {
  try {
    if (!window.ztools?.trigger) return
    const result = await window.ztools.trigger.list()
    if (isUnmounted) return
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
    console.warn('[AdvancedSettings] 加载启动快捷键数量失败:', e)
  }
}

async function loadPluginFeatureHotkeyCount() {
  try {
    if (!window.ztools?.trigger) return
    const result = await window.ztools.trigger.list()
    if (isUnmounted) return
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
    console.warn('[AdvancedSettings] 加载功能快捷键数量失败:', e)
  }
}

/** 打开插件快捷键弹窗；支持传入 pluginId 自动筛选定位目标插件 */
function openPluginHotkeyModal(pluginId = '') {
  pluginHotkeyModalRef.value?.show(pluginId ? { pluginId } : undefined)
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

const stopHotkeyRecording = (restoreFocus = false) => {
  if (hotkeyRecording.value) {
    hotkeyRecording.value = false
    hotkeyRecordingText.value = ''
    hotkeyRecordingIsKeys.value = false
    wakeHotkeyFieldRef.value?.blurInput?.({ restoreFocus })
  }
  resetHotkeyRecorderState()
}

watch(activeTab, (tab) => {
  if (tab !== 'shortcuts') {
    stopHotkeyRecording()
  }
})

let hasCompletedInitialMount = false
let isConsumingRouteQuery = false
let isUnmounted = false

const clearRouteQueries = async (keys) => {
  const currentQuery = route?.query || {}
  const nextQuery = { ...currentQuery }
  let changed = false
  for (const key of keys) {
    if (nextQuery[key] !== undefined) {
      nextQuery[key] = undefined
      changed = true
    }
  }
  if (!changed) return
  try {
    await router.replace({ query: nextQuery })
  } catch (err) {
    console.warn('[AdvancedSettings] 清理设置页查询参数失败:', err)
  }
}

const focusBundledTarget = async (targetId) => {
  activeTab.value = 'bundled'
  await clearRouteQueries(['manageBundled'])
  if (isUnmounted) return
  await nextTick()
  if (isUnmounted) return
  if (bundledPluginsSettingsRef.value?.focusPlugin) {
    queueBundledPluginFocus('')
    await bundledPluginsSettingsRef.value.focusPlugin(targetId)
  } else {
    queueBundledPluginFocus(targetId)
  }
}

const consumeRouteQuery = async () => {
  if (isConsumingRouteQuery || isUnmounted) return
  const query = route?.query || {}
  const resolvedTab = resolveSettingsTab(query.tab)
  const shouldOpenPluginHotkey = query.openPluginHotkey === 'true'
  const targetPluginId = typeof query.pluginId === 'string' ? query.pluginId.trim() : ''
  const shouldOpenFeatureHotkey = query[PLUGIN_FEATURE_HOTKEY_QUERY_KEY] === 'true'
  const manageBundledId = typeof query.manageBundled === 'string' ? query.manageBundled.trim() : ''

  if (!resolvedTab && !shouldOpenPluginHotkey && !shouldOpenFeatureHotkey && !manageBundledId) {
    return
  }

  isConsumingRouteQuery = true
  try {
    if (resolvedTab) {
      activeTab.value = resolvedTab
    }

    if (shouldOpenPluginHotkey || shouldOpenFeatureHotkey) {
      activeTab.value = 'shortcuts'
      await clearRouteQueries(['openPluginHotkey', 'pluginId', PLUGIN_FEATURE_HOTKEY_QUERY_KEY])
      if (isUnmounted) return
      await nextTick()
      if (isUnmounted) return
      if (shouldOpenPluginHotkey) {
        openPluginHotkeyModal(targetPluginId)
      }
      if (shouldOpenFeatureHotkey) {
        openPluginFeatureHotkeyModal()
      }
    }

    if (manageBundledId && !isUnmounted) {
      await focusBundledTarget(manageBundledId)
    }
  } finally {
    isConsumingRouteQuery = false
  }
}

watch(
  () => [
    route?.query?.tab,
    route?.query?.openPluginHotkey,
    route?.query?.pluginId,
    route?.query?.[PLUGIN_FEATURE_HOTKEY_QUERY_KEY],
    route?.query?.manageBundled
  ],
  () => {
    if (hasCompletedInitialMount && !isUnmounted) {
      void consumeRouteQuery()
    }
  }
)

onMounted(async () => {
  isUnmounted = false
  // 在首个 await 前同步绑定监听器并设置导航激活态，确保快速卸载时能与 onBeforeUnmount 对称注销
  useNavStore().setPage('advanced-settings')
  window.addEventListener('ztools-settings-changed', onSettingsChanged)

  const capabilities = await getHotkeyHostCapabilities()
  if (isUnmounted) return
  hotkeyPlatform.value = capabilities.platform
  supportsDoubleModifierHotkeys.value = capabilities.supportsDoubleModifierHotkeys
  supportsMouseTriggers.value = capabilities.supportsMouseTriggers
  await loadSettings()
  if (isUnmounted) return

  // 异步加载插件快捷键数量（不阻塞页面渲染）
  loadPluginHotkeyCount()
  loadPluginFeatureHotkeyCount()

  hasCompletedInitialMount = true
  await consumeRouteQuery()
})

onActivated(() => {
  if (isUnmounted) return
  useNavStore().setPage('advanced-settings')
  if (!hasCompletedInitialMount) return
  void loadSettings()
  void loadPluginHotkeyCount()
  void loadPluginFeatureHotkeyCount()
  void consumeRouteQuery()
})

onDeactivated(() => {
  stopHotkeyRecording()
})

const onSettingsChanged = () => {
  if (!isUnmounted) {
    loadSettings()
  }
}

onBeforeUnmount(() => {
  isUnmounted = true
  stopHotkeyRecording()
  window.removeEventListener('ztools-settings-changed', onSettingsChanged)
})
</script>

<template>
  <div class="settings-page">
    <div class="settings-container">
      <!-- 页面标题 -->
      <div class="page-header settings-page-header">
        <h1 class="page-title">设置</h1>
        <p class="page-subtitle">修改后立即生效并自动保存</p>
      </div>

      <!-- 顶部 Tab 分段槽 -->
      <div class="settings-tabs-bar">
        <RcSegmented
          v-model="activeTab"
          variant="marker"
          aria-label="设置分类"
          data-testid="settings-tabs"
          :options="SETTINGS_TAB_OPTIONS"
        />
      </div>

      <!-- 设置内容面板 -->
      <div class="settings-grid" role="tabpanel" :aria-label="activeTabLabel">
        <!-- Tab 1: 常规与外观 -->
        <template v-if="activeTab === 'general'">
          <!-- 外观设置卡片 -->
          <AppearanceSettings />

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
        </template>

        <!-- Tab 2: 快捷键 -->
        <template v-else-if="activeTab === 'shortcuts'">
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
                  <HotkeyCaptureField
                    ref="wakeHotkeyFieldRef"
                    :hotkey="settings.hotkey"
                    :recording="hotkeyRecording"
                    :loading="hotkeySaving"
                    :platform="hotkeyPlatform"
                    :supports-double-modifier="supportsDoubleModifierHotkeys"
                    :recording-text="hotkeyRecordingText"
                    :recording-is-keys="hotkeyRecordingIsKeys"
                    :wait-text="getHotkeyWaitText(hotkeyPlatform, supportsDoubleModifierHotkeys)"
                    empty-text="点击设置"
                    @start="startHotkeyRecording"
                    @cancel="stopHotkeyRecording(false)"
                    @keydown="handleWakeHotkeyKeydown"
                    @clear="clearHotkey"
                  />
                  <RcButton
                    variant="ghost"
                    size="sm"
                    data-testid="restore-default-wake-hotkey"
                    :disabled="settings.hotkey === DEFAULT_GLOBAL_WAKE_HOTKEY || hotkeySaving"
                    @click="restoreDefaultHotkey"
                  >
                    恢复默认
                  </RcButton>
                </div>
              </div>

              <!-- Windows 原生鼠标快捷唤醒（仅支持的宿主显示，不提供右键单击） -->
              <div v-if="showWindowsWakeExtensions && supportsMouseTriggers" class="setting-item">
                <div class="setting-info">
                  <div class="setting-text">
                    <span class="setting-label">鼠标快捷唤醒</span>
                    <span class="setting-desc">使用鼠标中键、侧键或右键长按快速呼出与隐藏窗口</span>
                  </div>
                </div>
                <div class="setting-control mouse-wake-control">
                  <RcSelect
                    v-model:value="settings.mouseWakeMode"
                    :options="MOUSE_WAKE_OPTIONS"
                    :disabled="mouseWakeSaving"
                    aria-label="鼠标快捷唤醒模式"
                    data-testid="mouse-wake-select"
                    @change="saveMouseWakeSetting"
                  />
                </div>
              </div>

              <!-- 鼠标长按阈值（仅选中长按模式时显示，范围 200~500ms） -->
              <div
                v-if="showWindowsWakeExtensions && supportsMouseTriggers && settings.mouseWakeMode.endsWith(':long')"
                class="setting-item animate-in"
              >
                <div class="setting-info">
                  <div class="setting-text">
                    <span class="setting-label">长按触发阈值</span>
                    <span class="setting-desc">长按鼠标按键达到该时长后触发唤醒（200 ~ 500 毫秒）</span>
                  </div>
                </div>
                <div class="setting-control slider-control">
                  <a-slider
                    v-model:value="settings.mouseLongPressMs"
                    :min="MIN_MOUSE_LONG_PRESS_MS"
                    :max="MAX_MOUSE_LONG_PRESS_MS"
                    :step="50"
                    :disabled="mouseWakeSaving"
                    data-testid="mouse-long-press-slider"
                    @after-change="saveMouseWakeSetting"
                  />
                  <span class="slider-value">{{ settings.mouseLongPressMs }} ms</span>
                </div>
              </div>

              <!-- 全屏游戏 / 演示免打扰（仅 Windows 扩展唤醒宿主显示） -->
              <div v-if="showWindowsWakeExtensions" class="setting-item">
                <div class="setting-info">
                  <div class="setting-text">
                    <span class="setting-label">全屏游戏 / 演示免打扰</span>
                    <span class="setting-desc">检测到全屏独占游戏或演示时，暂停双击修饰键与鼠标快捷唤醒</span>
                  </div>
                </div>
                <a-switch
                  v-switch-keyboard
                  size="small"
                  v-model:checked="settings.fullscreenDnd"
                  :loading="fullscreenDndSaving"
                  data-testid="fullscreen-dnd-switch"
                  @change="saveFullscreenDnd"
                />
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
              <div class="setting-item" style="cursor: pointer" @click="openPluginHotkeyModal()">
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
            </div>
          </div>

          <!-- 常用快捷键（只读）：与 shellShortcuts 唯一信源保持一致 -->
          <div class="settings-card">
            <div class="card-header">
              <h2 class="card-title">常用快捷键</h2>
            </div>
            <div class="settings-list">
              <div v-for="item in BUILTIN_SHORTCUT_HINTS" :key="item.id || item.combo" class="setting-item compact">
                <span class="setting-label">{{ item.label }}</span>
                <ShortcutKeys :combo="item.combo" />
              </div>
            </div>
          </div>
        </template>

        <!-- Tab 3: 内置插件 -->
        <BundledPluginsSettings
          v-else-if="activeTab === 'bundled'"
          ref="bundledPluginsSettingsRef"
          class="wide-card"
        />

        <!-- Tab 4: 隐私与权限 -->
        <ScreenPermissionPanel
          v-else-if="activeTab === 'privacy'"
          class="wide-card"
        />
      </div>
    </div>
    <PluginHotkeyModal ref="pluginHotkeyModalRef" @update:count="onPluginHotkeyCountUpdate" />
    <PluginFeatureHotkeyModal
      ref="pluginFeatureHotkeyModalRef"
      @update:count="onPluginFeatureHotkeyCountUpdate"
    />
  </div>
</template>

<style scoped>
/* 顶部标题与分段 Tab 槽 */
.settings-page-header {
  margin-bottom: 16px;
}

.settings-tabs-bar {
  margin-bottom: 24px;
}

/* 快捷键录入与扩展控制 */
.hotkey-item {
  flex-wrap: wrap;
  gap: 12px;
}

.hotkey-input-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mouse-wake-control {
  min-width: 180px;
}

.slider-control {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 220px;
}

.slider-control :deep(.ant-slider) {
  flex: 1;
  margin: 0;
}

.slider-value {
  min-width: 52px;
  font-size: 12px;
  color: var(--rc-text-secondary);
  text-align: right;
  font-variant-numeric: tabular-nums;
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

