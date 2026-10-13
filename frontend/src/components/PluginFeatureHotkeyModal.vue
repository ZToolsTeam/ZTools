<script setup>
import { computed, nextTick, ref } from 'vue'
import { message } from 'ant-design-vue'
import { getHotkey, openPlugin as apiOpenPlugin } from '@/api/apiserver'
import {
  formatHotkeyForPlatform,
  getHotkeyHostCapabilities,
  getHotkeyRuleDescription,
  getHotkeyWaitText,
  parseSupportedHotkeyEvent,
  resetHotkeyRecorderState
} from '@/utils/hotkeyRecorder'
import {
  DEPRECATED_PLUGIN_FEATURE_HOTKEY_ITEMS,
  OCR_CAPTURE_TRIGGER_ID,
  OCR_CAPTURE_TRIGGER_SOURCE,
  PLUGIN_FEATURE_HOTKEY_ITEMS,
  SCREENSHOT_HOTKEY_SOURCE,
  getPluginFeatureHotkeyItemByTrigger,
  isDeprecatedPluginFeatureHotkeyItem
} from '@/utils/pluginFeatureHotkeys'

const emit = defineEmits(['update:count'])

const SCREENSHOT_SETTINGS_KEY = 'settings:preferences'
const SCREENSHOT_LEGACY_SETTINGS_KEY = 'settings:hideWindow'

const visible = ref(false)
const hotkeyPlatform = ref('unknown')
const supportsDoubleModifierHotkeys = ref(false)
const loadingItemId = ref('')
const recordingItemId = ref('')
const recordingText = ref('')
const featureHotkeyMap = ref({})
const screenshotSettings = ref(createDefaultScreenshotSettings())

const inputRefs = {}

function createDefaultScreenshotSettings() {
  return {
    outputFormat: 'png',
    hideWindow: false,
    selectedWindow: '',
    selectedScreenIndexes: []
  }
}

const getTriggerList = (result) => result?.data || result || []

const configuredCount = computed(
  () => Object.keys(featureHotkeyMap.value).length
)

const setInputRef = (itemId, el) => {
  inputRefs[itemId] = el
}

const getItemHotkey = (itemId) =>
  formatHotkeyForPlatform(
    featureHotkeyMap.value[itemId]?.key || '',
    hotkeyPlatform.value,
    supportsDoubleModifierHotkeys.value
  )

const getItemStatusText = (item) => {
  if (item.pluginId === 'screenshot') {
    return '触发时直接执行截图并存入缓存'
  }

  return '触发时直接启动并进入截图识别'
}

const openPlugin = async (pluginId) => {
  try {
    const result = await apiOpenPlugin(pluginId)
    if (!result?.success) {
      message.error('打开插件失败: ' + (result?.error || '未知错误'))
    }
  } catch (error) {
    message.error('打开插件失败: ' + (error?.message || '未知错误'))
  }
}

const loadScreenshotSettings = async () => {
  const nextSettings = createDefaultScreenshotSettings()

  try {
    if (!window.ztools?.db) {
      screenshotSettings.value = nextSettings
      return
    }

    window.ztools.db.setPluginId('screenshot')
    const settings = await window.ztools.db.get(SCREENSHOT_SETTINGS_KEY)
    if (settings && typeof settings === 'object') {
      if (
        settings.outputFormat === 'png' ||
        settings.outputFormat === 'jpg' ||
        settings.outputFormat === 'bmp'
      ) {
        nextSettings.outputFormat = settings.outputFormat
      }
      if (typeof settings.hideWindow === 'boolean') {
        nextSettings.hideWindow = settings.hideWindow
      }
      if (typeof settings.selectedWindow === 'string') {
        nextSettings.selectedWindow = settings.selectedWindow
      }
      if (Array.isArray(settings.selectedScreenIndexes)) {
        nextSettings.selectedScreenIndexes = settings.selectedScreenIndexes.filter((item) =>
          Number.isInteger(item)
        )
      }
    } else {
      const legacySettings = await window.ztools.db.get(
        SCREENSHOT_LEGACY_SETTINGS_KEY
      )
      if (legacySettings?.hideWindow === true) {
        nextSettings.hideWindow = true
      }
    }
  } catch (error) {
    console.warn('加载 screenshot 设置失败:', error)
  }

  screenshotSettings.value = nextSettings
}

const buildScreenshotActionParams = (item) => {
  return {
    source: SCREENSHOT_HOTKEY_SOURCE,
    captureMode: item.captureMode,
    outputFormat: screenshotSettings.value.outputFormat,
    openFolder: false,
    hideWindow: screenshotSettings.value.hideWindow
  }
}

const buildRegisterPayload = (item, hotkeyStr) => {
  if (item.pluginId === 'ocr') {
    return {
      id: OCR_CAPTURE_TRIGGER_ID,
      pluginId: 'ocr',
      type: 'hotkey',
      enabled: true,
      config: { key: hotkeyStr },
      actionMode: 'window',
      actionTarget: 'ocr',
      actionParams: {
        source: OCR_CAPTURE_TRIGGER_SOURCE,
        autoCapture: true,
        autoRecognize: true
      }
    }
  }

  return {
    id: item.triggerId,
    pluginId: 'screenshot',
    type: 'hotkey',
    enabled: true,
    config: { key: hotkeyStr },
    actionMode: 'window',
    actionTarget: 'screenshot',
    actionParams: buildScreenshotActionParams(item)
  }
}

const loadFeatureHotkeys = async () => {
  try {
    if (!window.ztools?.trigger?.list) return

    const result = await window.ztools.trigger.list()
    const triggers = getTriggerList(result)
    const nextMap = {}

    for (const trigger of triggers) {
      const item = getPluginFeatureHotkeyItemByTrigger(trigger)
      if (!item || isDeprecatedPluginFeatureHotkeyItem(item)) continue

      nextMap[item.id] = {
        triggerId: trigger?.id || item.triggerId,
        key: trigger?.config?.key || ''
      }
    }

    featureHotkeyMap.value = nextMap
    emit('update:count', Object.keys(nextMap).length)
  } catch (error) {
    console.error('加载插件内功能快捷键失败:', error)
  }
}

const cleanupDeprecatedScreenshotHotkeys = async () => {
  if (!window.ztools?.trigger?.unregister) return

  for (const item of DEPRECATED_PLUGIN_FEATURE_HOTKEY_ITEMS) {
    try {
      await window.ztools.trigger.unregister(item.triggerId)
    } catch (error) {
      // 触发器不存在时静默跳过
    }
  }
}

const loadData = async () => {
  await cleanupDeprecatedScreenshotHotkeys()
  await Promise.all([loadFeatureHotkeys(), loadScreenshotSettings()])
}

const show = async () => {
  resetHotkeyRecorderState()
  const capabilities = await getHotkeyHostCapabilities()
  hotkeyPlatform.value = capabilities.platform
  supportsDoubleModifierHotkeys.value = capabilities.supportsDoubleModifierHotkeys
  visible.value = true
  recordingItemId.value = ''
  recordingText.value = ''
  await loadData()
}

const hide = () => {
  recordingItemId.value = ''
  recordingText.value = ''
  visible.value = false
}

const handleCancel = () => {
  hide()
}

const focusInput = (itemId) => {
  nextTick(() => {
    inputRefs[itemId]?.focus()
  })
}

const startRecording = async (item) => {
  if (loadingItemId.value) return
  if (item.pluginId === 'screenshot') {
    await loadScreenshotSettings()
  }
  recordingItemId.value = item.id
  recordingText.value = ''
  focusInput(item.id)
}

const stopRecording = () => {
  resetHotkeyRecorderState()
  recordingItemId.value = ''
  recordingText.value = ''
}

const getGlobalWakeHotkey = async () => {
  try {
    return (await getHotkey()) || ''
  } catch {
    return ''
  }
}

const getSuperPanelHotkey = async () => {
  try {
    if (!window.ztools?.config?.get) return ''
    const config = await window.ztools.config.get('super_panel')
    const hotkey = config?.keyboardHotkey
    if (!hotkey?.enabled || !hotkey?.key) {
      return ''
    }

    const modifiers = Array.isArray(hotkey.modifiers)
      ? hotkey.modifiers.map((modifier) => modifier.charAt(0).toUpperCase() + modifier.slice(1))
      : []
    const key = hotkey.key.charAt(0).toUpperCase() + hotkey.key.slice(1)
    return [...modifiers, key].join('+')
  } catch {
    return ''
  }
}

const canApplyItem = () => true

const hasSamePluginHotkeyConflict = async (item, hotkeyStr) => {
  try {
    if (!window.ztools?.trigger?.list) return false

    const currentTriggerId =
      featureHotkeyMap.value[item.id]?.triggerId || item.triggerId
    const result = await window.ztools.trigger.list(item.pluginId)
    const triggers = getTriggerList(result)

    for (const trigger of triggers) {
      if (trigger?.type !== 'hotkey' || trigger?.enabled === false) continue

      const triggerKey = trigger?.config?.key || ''
      if (!triggerKey || triggerKey.toLowerCase() !== hotkeyStr.toLowerCase()) {
        continue
      }
      if ((trigger?.id || '') === currentTriggerId) continue

      const featureItem = getPluginFeatureHotkeyItemByTrigger(trigger)
      if (featureItem) {
        message.warning(
          `该快捷键与「${featureItem.pluginName} - ${featureItem.featureName}」冲突`
        )
      } else {
        const mode = trigger?.action?.mode || trigger?.actionMode || ''
        const target = trigger?.action?.target || trigger?.actionTarget || ''
        if (mode === 'window' && target === item.pluginId) {
          message.warning('该快捷键与该插件的启动快捷键冲突')
        } else {
          message.warning(`该快捷键与 ${item.pluginName} 的其他快捷键冲突`)
        }
      }
      return true
    }
  } catch (error) {
    console.warn('检测同插件快捷键冲突失败:', error)
  }

  return false
}

const registerHotkey = async (item, hotkeyStr) => {
  if (!window.ztools?.trigger?.register) {
    message.error('全局快捷键功能不可用')
    return false
  }

  if (item.pluginId === 'screenshot') {
    await loadScreenshotSettings()
  }

  if (!canApplyItem(item, true)) {
    return false
  }

  loadingItemId.value = item.id

  try {
    if (await hasSamePluginHotkeyConflict(item, hotkeyStr)) {
      return false
    }

    const globalWakeHotkey = await getGlobalWakeHotkey()
    if (
      globalWakeHotkey &&
      globalWakeHotkey.toLowerCase() === hotkeyStr.toLowerCase()
    ) {
      message.warning('该快捷键与全局唤醒快捷键冲突')
      return false
    }

    const superPanelHotkey = await getSuperPanelHotkey()
    if (
      superPanelHotkey &&
      superPanelHotkey.toLowerCase() === hotkeyStr.toLowerCase()
    ) {
      message.warning('该快捷键与超级面板键盘热键冲突')
      return false
    }

    if (window.ztools?.trigger?.checkConflict) {
      const conflictResult = await window.ztools.trigger.checkConflict(
        hotkeyStr,
        item.pluginId
      )
      const data = conflictResult?.data || conflictResult || {}
      if (data.hasConflict && data.conflicts?.length > 0) {
        const names = data.conflicts
          .map((conflict) => conflict.pluginName || conflict.pluginId)
          .join('、')
        message.warning(`该快捷键与插件「${names}」冲突`)
        return false
      }
    }

    const currentTriggerId =
      featureHotkeyMap.value[item.id]?.triggerId || item.triggerId
    if (
      currentTriggerId &&
      currentTriggerId !== item.triggerId &&
      window.ztools?.trigger?.unregister
    ) {
      await window.ztools.trigger.unregister(currentTriggerId)
    }

    const result = await window.ztools.trigger.register(
      buildRegisterPayload(item, hotkeyStr)
    )
    const data = result?.data || result || {}

    if (data.success === false || data.error) {
      message.error('快捷键注册失败，可能被其他程序占用')
      await loadFeatureHotkeys()
      return false
    }

    featureHotkeyMap.value = {
      ...featureHotkeyMap.value,
      [item.id]: {
        triggerId: item.triggerId,
        key: hotkeyStr
      }
    }
    emit('update:count', Object.keys(featureHotkeyMap.value).length)
    message.success(`已设置「${item.pluginName} - ${item.featureName}」快捷键`)
    return true
  } catch (error) {
    message.error('设置快捷键失败: ' + (error?.message || '未知错误'))
    console.error('设置插件内功能快捷键失败:', error)
    return false
  } finally {
    loadingItemId.value = ''
  }
}

const clearHotkey = async (item) => {
  const currentTriggerId =
    featureHotkeyMap.value[item.id]?.triggerId || item.triggerId
  if (!currentTriggerId || loadingItemId.value) return

  loadingItemId.value = item.id
  try {
    await window.ztools?.trigger?.unregister?.(currentTriggerId)
    const nextMap = { ...featureHotkeyMap.value }
    delete nextMap[item.id]
    featureHotkeyMap.value = nextMap
    emit('update:count', Object.keys(nextMap).length)
    message.success(`已清除「${item.pluginName} - ${item.featureName}」快捷键`)
  } catch (error) {
    console.error('清除插件内功能快捷键失败:', error)
    message.error('清除快捷键失败: ' + (error?.message || '未知错误'))
  } finally {
    loadingItemId.value = ''
  }
}

const handleKeydown = async (item, event) => {
  event.preventDefault()
  event.stopPropagation()

  if (recordingItemId.value !== item.id) return

  if (event.key === 'Escape') {
    stopRecording()
    return
  }

  if (event.key === 'Backspace' || event.key === 'Delete') {
    await clearHotkey(item)
    stopRecording()
    return
  }

  const result = parseSupportedHotkeyEvent(event, {
    platform: hotkeyPlatform.value,
    allowDoubleTap: supportsDoubleModifierHotkeys.value
  })
  if (result.status === 'pending') {
    recordingText.value = result.text
    return
  }

  if (result.status === 'invalid') {
    recordingText.value = result.text
    return
  }

  const hotkeyStr = result.hotkey
  recordingText.value = result.text
  await registerHotkey(item, hotkeyStr)
  stopRecording()
}

defineExpose({ show, hide, configuredCount })
</script>

<template>
  <a-modal
    v-model:open="visible"
    title="功能快捷键管理"
    :footer="null"
    :width="720"
    centered
    @cancel="handleCancel"
  >
    <div class="feature-modal-tip">
      <div class="feature-modal-tip-title">功能快捷键设置</div>
      <div class="feature-modal-tip-desc">
        为插件内置功能设置全局热键，触发时将直接执行对应动作。
      </div>
      <div class="feature-modal-rule">{{
        getHotkeyRuleDescription(hotkeyPlatform, supportsDoubleModifierHotkeys)
      }}</div>
    </div>

    <div class="feature-hotkey-list">
      <div
        v-for="item in PLUGIN_FEATURE_HOTKEY_ITEMS"
        :key="item.id"
        class="feature-hotkey-item"
      >
        <div class="feature-main">
          <div class="feature-title-row">
            <div class="feature-title">
              <span class="feature-plugin">{{ item.pluginName }}</span>
              <span class="feature-separator">/</span>
              <span>{{ item.featureName }}</span>
            </div>
            <button
              v-if="item.pluginId === 'screenshot'"
              type="button"
              class="open-plugin-link"
              @click="openPlugin('screenshot')"
            >
              打开插件配置
            </button>
          </div>
          <div class="feature-desc">{{ item.description }}</div>
        </div>

        <div class="feature-actions">
          <div
            class="hotkey-recorder"
            :class="{
              recording: recordingItemId === item.id,
              loading: loadingItemId === item.id
            }"
            @click="startRecording(item)"
          >
            <input
              :ref="(el) => setInputRef(item.id, el)"
              class="hotkey-hidden-input"
              readonly
              @keydown="handleKeydown(item, $event)"
              @blur="recordingItemId === item.id ? stopRecording() : null"
            />

            <span v-if="recordingItemId === item.id" class="recording-text">
              {{
                loadingItemId === item.id
                  ? '保存中...'
                  : recordingText || getHotkeyWaitText(hotkeyPlatform, supportsDoubleModifierHotkeys)
              }}
            </span>
            <div v-else-if="getItemHotkey(item.id)" class="hotkey-keys">
              <span
                v-for="key in getItemHotkey(item.id).split('+')"
                :key="key"
                class="key-badge"
              >
                {{ key }}
              </span>
            </div>
            <span v-else class="no-hotkey">点击录入</span>
          </div>

          <button
            v-if="getItemHotkey(item.id) && recordingItemId !== item.id"
            type="button"
            class="clear-btn"
            title="清除快捷键"
            @click.stop="clearHotkey(item)"
          >
            <i class="fa fa-times"></i>
          </button>
        </div>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.feature-modal-tip {
  padding: 12px 14px;
  margin-bottom: 12px;
  border-radius: var(--rc-radius-lg, 12px);
  background: var(--rc-surface-subtle);
}

.feature-modal-tip-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--rc-text-primary);
}

.feature-modal-tip-desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--rc-text-secondary);
}

.feature-modal-rule {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--rc-border);
  font-size: 12px;
  line-height: 1.6;
  color: var(--rc-text-secondary);
}

.feature-hotkey-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.feature-hotkey-item {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px;
  border-radius: var(--rc-radius-lg, 12px);
  border: 1px solid var(--rc-border);
  background: var(--rc-surface);
  transition: border-color 0.15s ease;
}

.feature-hotkey-item:hover {
  border-color: var(--rc-border-highlight);
}

.feature-main {
  flex: 1;
  min-width: 0;
}

.feature-title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
}

.feature-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--rc-text-primary);
}

.feature-plugin {
  color: var(--rc-accent);
}

.feature-separator {
  color: var(--rc-text-muted);
}

.feature-desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--rc-text-secondary);
}

.open-plugin-link {
  padding: 0;
  border: none;
  background: transparent;
  font-size: 12px;
  color: var(--rc-accent);
  cursor: pointer;
}

.feature-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.hotkey-recorder {
  min-width: 180px;
  min-height: 38px;
  padding: 0 10px;
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

.hotkey-recorder:hover {
  border-color: var(--rc-accent);
}

.hotkey-recorder.recording {
  border-color: var(--rc-accent);
  background: var(--rc-accent-subtle);
}

.hotkey-recorder.loading {
  opacity: 0.6;
  pointer-events: none;
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
}

.hotkey-keys {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  justify-content: center;
}

.key-badge {
  padding: 2px 6px;
  border-radius: var(--rc-radius-sm, 4px);
  font-size: 11px;
  font-weight: 600;
  font-family: var(--rc-font-mono, monospace);
  background: var(--rc-kbd-bg);
  color: var(--rc-kbd-text);
  border: 1px solid var(--rc-kbd-border);
}

.no-hotkey {
  font-size: 12px;
  color: var(--rc-text-muted);
}

.clear-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--rc-radius-sm, 6px);
  border: none;
  background: transparent;
  color: var(--rc-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.clear-btn:hover {
  background: var(--rc-error-subtle);
  color: var(--rc-error);
}

@media (max-width: 720px) {
  .feature-hotkey-item {
    flex-direction: column;
    align-items: stretch;
  }

  .feature-actions {
    width: 100%;
  }

  .hotkey-recorder {
    flex: 1;
    width: 100%;
  }
}
</style>
