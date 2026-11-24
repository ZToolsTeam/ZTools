<script setup>
import HotkeyCaptureField from '@/components/HotkeyCaptureField.vue'
import { RcDialog } from '@/components/base'
import { computed, onBeforeUnmount, ref } from 'vue'
import { message } from 'ant-design-vue'
import { storeToRefs } from 'pinia'
import { usePluginsStore } from '@/stores/plugins'
import { useAppI18n } from '@/i18n'
import { resolveErrorMessage } from '@/utils/errorMessage'
import { getHotkey, getLauncherHotkey, openPlugin as apiOpenPlugin } from '@/api/apiserver'
import {
  getHotkeyHostCapabilities,
  getHotkeyRuleDescription,
  getHotkeyWaitText,
  getShellReserveWarning,
  interpretRecorderKeydown,
  resetHotkeyRecorderState
} from '@/utils/hotkeyRecorder'
import {
  DEPRECATED_PLUGIN_FEATURE_HOTKEY_ITEMS,
  OCR_CAPTURE_TRIGGER_ID,
  OCR_CAPTURE_TRIGGER_SOURCE,
  PLUGIN_FEATURE_HOTKEY_SOURCE,
  SCREENSHOT_HOTKEY_SOURCE,
  buildPluginFeatureHotkeyItems,
  getPluginFeatureHotkeyItemByTrigger,
  isDeprecatedPluginFeatureHotkeyItem
} from '@/utils/pluginFeatureHotkeys'

const emit = defineEmits(['update:count', 'closed'])
const { t, locale } = useAppI18n()

const SCREENSHOT_SETTINGS_KEY = 'settings:preferences'
const SCREENSHOT_LEGACY_SETTINGS_KEY = 'settings:hideWindow'

const pluginsStore = usePluginsStore()
const { installedPlugins } = storeToRefs(pluginsStore)
const featureHotkeyItems = computed(() => {
  void locale.value
  return buildPluginFeatureHotkeyItems(installedPlugins.value)
})
const fieldRefs = new Map()
const setFieldRef = (id, el) => {
  const key = String(id)
  if (el) {
    fieldRefs.set(key, el)
  } else {
    fieldRefs.delete(key)
  }
}

const visible = ref(false)
const hotkeyPlatform = ref('unknown')
const supportsDoubleModifierHotkeys = ref(false)
const loadingItemId = ref('')
const recordingItemId = ref('')
const recordingText = ref('')
const recordingIsKeys = ref(false)
const featureHotkeyMap = ref({})
const screenshotSettings = ref(createDefaultScreenshotSettings())

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

/** 返回原始热键字符串，由 HotkeyCaptureField 按平台统一渲染键帽 */
const getItemHotkey = (itemId) => featureHotkeyMap.value[itemId]?.key || ''

const getItemStatusText = (item) => {
  if (item.pluginId === 'screenshot') {
    return t('hotkey.featureModal.statusScreenshot')
  }
  if (item.dynamic) {
    return t('hotkey.featureModal.statusDynamic')
  }

  return t('hotkey.featureModal.statusOcr')
}

const openPlugin = async (pluginId) => {
  try {
    const result = await apiOpenPlugin(pluginId)
    if (!result?.success) {
      message.error(t('hotkey.featureModal.openPluginFailed', { reason: resolveErrorMessage(result, 'common.unknownError') }))
    }
  } catch (error) {
    message.error(t('hotkey.featureModal.openPluginFailed', { reason: resolveErrorMessage(error, 'common.unknownError') }))
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
  if (item.dynamic) {
    return {
      id: item.triggerId,
      pluginId: item.pluginId,
      type: 'hotkey',
      enabled: true,
      config: { key: hotkeyStr },
      actionMode: 'window',
      actionTarget: item.pluginId,
      actionParams: {
        source: PLUGIN_FEATURE_HOTKEY_SOURCE,
        featureCode: item.featureCode
      }
    }
  }

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
      const item = getPluginFeatureHotkeyItemByTrigger(trigger, featureHotkeyItems.value)
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
      console.warn('[PluginFeatureHotkeyModal] 清理废弃触发器失败:', error)
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
  stopRecording(false)
  visible.value = false
}

const handleCancel = () => {
  hide()
}

const startRecording = async (item) => {
  if (loadingItemId.value) return
  if (item.pluginId === 'screenshot') {
    await loadScreenshotSettings()
  }
  recordingItemId.value = item.id
  recordingText.value = ''
  recordingIsKeys.value = false
}

/** 结束录入并在需要时主动失焦归还焦点，避免二次 Esc 被隐藏 input 拦截 */
const stopRecording = (restoreFocus = false) => {
  const activeId = recordingItemId.value
  resetHotkeyRecorderState()
  recordingItemId.value = ''
  recordingText.value = ''
  recordingIsKeys.value = false
  if (activeId) {
    fieldRefs.get(String(activeId))?.blurInput?.({ restoreFocus })
  }
}

onBeforeUnmount(() => {
  stopRecording(false)
})

const getGlobalWakeHotkey = async () => {
  try {
    return (await getHotkey()) || ''
  } catch {
    return ''
  }
}

const getGlobalLauncherHotkey = async () => {
  try {
    return typeof getLauncherHotkey === 'function' ? (await getLauncherHotkey()) || '' : ''
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

      const featureItem = getPluginFeatureHotkeyItemByTrigger(trigger, featureHotkeyItems.value)
      if (featureItem) {
        message.warning(
          t('hotkey.featureModal.conflictFeature', {
            plugin: featureItem.pluginName,
            feature: featureItem.featureName
          })
        )
      } else {
        const mode = trigger?.action?.mode || trigger?.actionMode || ''
        const target = trigger?.action?.target || trigger?.actionTarget || ''
        if (mode === 'window' && target === item.pluginId) {
          message.warning(t('hotkey.featureModal.conflictLaunch'))
        } else {
          message.warning(t('hotkey.featureModal.conflictOther', { plugin: item.pluginName }))
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
    message.error(t('hotkey.featureModal.unavailable'))
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
      message.warning(t('hotkey.featureModal.conflictGlobalWake'))
      return false
    }

    const globalLauncherHotkey = await getGlobalLauncherHotkey()
    if (
      globalLauncherHotkey &&
      globalLauncherHotkey.toLowerCase() === hotkeyStr.toLowerCase()
    ) {
      message.warning(t('hotkey.featureModal.conflictGlobalLauncher'))
      return false
    }

    const currentTriggerId =
      featureHotkeyMap.value[item.id]?.triggerId || item.triggerId

    if (window.ztools?.trigger?.checkConflict) {
      const conflictResult = currentTriggerId
        ? await window.ztools.trigger.checkConflict(hotkeyStr, item.pluginId, currentTriggerId)
        : await window.ztools.trigger.checkConflict(hotkeyStr, item.pluginId)
      const data = conflictResult?.data || conflictResult || {}
      if (data.hasConflict && data.conflicts?.length > 0) {
        const names = data.conflicts
          .map((conflict) => conflict.pluginName || conflict.pluginId)
          .join(t('settings.shortcuts.wakeHotkey.listSeparator'))
        message.warning(t('hotkey.featureModal.conflictPlugins', { names }))
        return false
      }
    }

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
      message.error(t('hotkey.featureModal.registerOccupied'))
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
    message.success(
      t('hotkey.featureModal.setSuccess', {
        plugin: item.pluginName,
        feature: item.featureName
      })
    )
    const reserveWarning = getShellReserveWarning(hotkeyStr)
    if (reserveWarning) {
      message.warning(reserveWarning)
    }
    return true
  } catch (error) {
    message.error(t('hotkey.featureModal.setFailed', { reason: resolveErrorMessage(error, 'common.unknownError') }))
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
    message.success(
      t('hotkey.featureModal.clearSuccess', {
        plugin: item.pluginName,
        feature: item.featureName
      })
    )
  } catch (error) {
    console.error('清除插件内功能快捷键失败:', error)
    message.error(t('hotkey.featureModal.clearFailed', { reason: resolveErrorMessage(error, 'common.unknownError') }))
  } finally {
    loadingItemId.value = ''
  }
}

/** 录入框里的按键：Esc 取消、⌫ 清除，组合键完整后注册 */
const handleKeydown = async (item, event) => {
  if (recordingItemId.value !== item.id || loadingItemId.value) return
  const result = interpretRecorderKeydown(event, {
    platform: hotkeyPlatform.value,
    allowDoubleTap: supportsDoubleModifierHotkeys.value
  })
  if (result.action === 'cancel') {
    stopRecording(true)
    return
  }
  if (result.action === 'clear') {
    await clearHotkey(item)
    stopRecording(true)
    return
  }
  recordingText.value = result.text
  recordingIsKeys.value = result.isKeys
  if (result.action !== 'valid') return
  await registerHotkey(item, result.hotkey)
  stopRecording(true)
}

defineExpose({ show, hide, configuredCount })
</script>

<template>
  <RcDialog
    v-model:open="visible"
    :after-close="() => emit('closed')"
    :title="t('hotkey.featureModal.title')"
    :width="720"
    @cancel="handleCancel"
  >
    <div class="feature-modal-tip">
      <div class="feature-modal-tip-title">{{ t('hotkey.featureModal.tipTitle') }}</div>
      <div class="feature-modal-tip-desc">
        {{ t('hotkey.featureModal.tipDesc') }}
      </div>
      <div class="feature-modal-rule">{{
        getHotkeyRuleDescription(hotkeyPlatform, supportsDoubleModifierHotkeys)
      }}</div>
    </div>

    <div class="feature-hotkey-list">
      <div
        v-for="item in featureHotkeyItems"
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
              {{ t('hotkey.featureModal.openPluginConfig') }}
            </button>
          </div>
          <div class="feature-desc">{{ item.description }}</div>
        </div>

        <HotkeyCaptureField
          :ref="(el) => setFieldRef(item.id, el)"
          class="feature-actions"
          :hotkey="getItemHotkey(item.id)"
          :recording="recordingItemId === item.id"
          :loading="loadingItemId === item.id"
          :platform="hotkeyPlatform"
          :supports-double-modifier="supportsDoubleModifierHotkeys"
          :recording-text="recordingText"
          :recording-is-keys="recordingIsKeys"
          :wait-text="getHotkeyWaitText(hotkeyPlatform, supportsDoubleModifierHotkeys)"
          :empty-text="t('hotkey.featureModal.clickToRecord')"
          @start="startRecording(item)"
          @cancel="stopRecording(false)"
          @keydown="handleKeydown(item, $event)"
          @clear="clearHotkey(item)"
        />
      </div>
    </div>
  </RcDialog>
</template>

<style scoped>
.feature-modal-tip {
  padding: 12px 14px;
  margin-bottom: 12px;
  border-radius: var(--rc-radius-lg);
  background: var(--rc-surface-subtle);
}

.feature-modal-tip-title {
  font-size: var(--rc-fs-body);
  font-weight: 600;
  color: var(--rc-text-primary);
}

.feature-modal-tip-desc {
  margin-top: 4px;
  font-size: var(--rc-fs-small);
  line-height: 1.6;
  color: var(--rc-text-secondary);
}

.feature-modal-rule {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--rc-border);
  font-size: var(--rc-fs-small);
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
  border-radius: var(--rc-radius-lg);
  border: 1px solid var(--rc-border);
  background: var(--rc-surface);
  transition: border-color var(--rc-dur) ease;
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
  font-size: var(--rc-fs-emph);
  font-weight: 600;
  color: var(--rc-text-primary);
}

/* 插件名用中性次级色，橙色只留给主按钮与选中标记 */
.feature-plugin {
  color: var(--rc-text-secondary);
}

.feature-separator {
  color: var(--rc-text-muted);
}

.feature-desc {
  margin-top: 4px;
  font-size: var(--rc-fs-small);
  line-height: 1.6;
  color: var(--rc-text-secondary);
}

.open-plugin-link {
  padding: 0;
  border: none;
  background: transparent;
  font-size: var(--rc-fs-small);
  color: var(--rc-accent-text);
  cursor: pointer;
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
