<script setup>
import { ChevronRightIcon, XIcon } from '@lucide/vue'
import {
  ref,
  reactive,
  onMounted,
  onBeforeUnmount,
  watch,
  nextTick,
  computed
} from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useToast } from '@/composables/useToast'
import { track } from '@edition'
import AppearanceSettings from '@/components/settings/AppearanceSettings.vue'
import { ROUTES } from '@/router/routes'
import { useAppPreferencesApi } from '@/composables/useAppPreferencesApi'
import { DEFAULT_GLOBAL_WAKE_HOTKEY, syncGlobalWakeHotkey } from '@/utils/globalWakeHotkey'
import { isMacOS } from '@/utils/platform'
import { isHostDevBuild } from '@/utils/hostDevTools'
import { setWakePreference, windowModeState, WAKE_PREFERENCES } from '@/utils/windowMode'
import { vSwitchKeyboard } from '@/directives/switchKeyboard'
import ScreenPermissionPanel from '@/components/ScreenPermissionPanel.vue'
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import RcSegmented from '@/components/base/RcSegmented.vue'
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
  resetHotkeyRecorderState,
  notifyHotkeyRecorderActive
} from '@/utils/hotkeyRecorder'
import { buildLaunchHotkeyMap } from '@/utils/launchHotkeyTargets'

const { success, error } = useToast()
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
  closeConfirm: true
})
const hotkeyRecording = ref(false)
const hotkeyRecordingText = ref('')
const hotkeyInput = ref(null)

watch(hotkeyRecording, (val) => {
  notifyHotkeyRecorderActive(Boolean(val))
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
  } catch (e) {
    console.error('Failed to load settings:', e)
    error('加载设置失败')
  }
}

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

// 全局唤醒快捷键单独保存：其它设置保存时不能连带改写它
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

const handleHotkeyInput = (event) => {
  event.preventDefault()
  event.stopPropagation()
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

onMounted(async () => {
  const capabilities = await getHotkeyHostCapabilities()
  hotkeyPlatform.value = capabilities.platform
  supportsDoubleModifierHotkeys.value = capabilities.supportsDoubleModifierHotkeys
  // 确保 Sidebar 选中状态正确（从外部跳转时）
  useNavStore().setPage('advanced-settings')
  await loadSettings()

  // 异步加载插件快捷键数量（不阻塞页面渲染）
  loadPluginHotkeyCount()
  loadPluginFeatureHotkeyCount()

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
})

const onSettingsChanged = () => {
  loadSettings()
}

onBeforeUnmount(() => {
  if (hotkeyRecording.value) notifyHotkeyRecorderActive(false)
  resetHotkeyRecorderState()
  window.removeEventListener('ztools-settings-changed', onSettingsChanged)
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
                    inputmode="none"
                    autocomplete="off"
                    spellcheck="false"
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
    <PluginHotkeyModal ref="pluginHotkeyModalRef" @update:count="onPluginHotkeyCountUpdate" />
    <PluginFeatureHotkeyModal
      ref="pluginFeatureHotkeyModalRef"
      @update:count="onPluginFeatureHotkeyCountUpdate"
    />
  </div>
</template>

<style scoped>
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

