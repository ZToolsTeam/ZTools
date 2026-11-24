<script setup>
import HotkeyCaptureField from '@/components/HotkeyCaptureField.vue'
import { CircleXIcon, SearchIcon } from '@lucide/vue'
import { RcDialog, RcSquircle } from '@/components/base'
import { resolveKeywordGlyph, resolvePluginGlyph } from '@/utils/brandIcons'
/**
 * 启动快捷键管理弹窗
 * 展示所有已安装插件，支持设置/修改/清除全局快捷键
 * 通过 IPC trigger 系列接口与原生宿主端交互
 */
import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import { usePluginsStore } from '@/stores/plugins'
import { useAppI18n } from '@/i18n'
import { resolveErrorMessage } from '@/utils/errorMessage'
import { getLocalizedPluginName, getLocalizedPluginAltNames } from '@/utils/pluginI18n'
import { storeToRefs } from 'pinia'
import { message } from 'ant-design-vue'
import { getHotkey, getLauncherHotkey } from '@/api/apiserver'
import { getPluginFeatureHotkeyItemByTrigger } from '@/utils/pluginFeatureHotkeys'
import {
  buildLaunchHotkeyMap,
  buildLaunchHotkeyRegistration
} from '@/utils/launchHotkeyTargets'
import {
  getHotkeyHostCapabilities,
  getHotkeyRuleDescription,
  getHotkeyWaitText,
  getShellReserveWarning,
  interpretRecorderKeydown,
  resetHotkeyRecorderState
} from '@/utils/hotkeyRecorder'

const emit = defineEmits(['update:count', 'closed'])
const { t } = useAppI18n()

const visible = ref(false)
const hotkeyPlatform = ref('unknown')
const supportsDoubleModifierHotkeys = ref(false)
const searchText = ref('')
const highlightedTargetId = ref('')
// 启动快捷键映射：{ targetId: { triggerId, triggerIds, key, kind, ownerId } }
const pluginHotkeyMap = ref({})
// 当前正在录入快捷键的目标ID
const recordingPluginId = ref(null)
// 录入中显示的临时按键文本
const recordingText = ref('')
const recordingIsKeys = ref(false)
// 操作加载状态
const loadingPluginId = ref(null)
const fieldRefs = new Map()
const itemRefs = new Map()

const setFieldRef = (id, el) => {
  const key = String(id)
  if (el) {
    fieldRefs.set(key, el)
  } else {
    fieldRefs.delete(key)
  }
}

const setItemRef = (id, el) => {
  const key = String(id)
  if (el) {
    itemRefs.set(key, el)
  } else {
    itemRefs.delete(key)
  }
}

const pluginsStore = usePluginsStore()
const { installedPlugins } = storeToRefs(pluginsStore)

const launchTargets = computed(() => {
  return (installedPlugins.value || []).map(plugin => ({
    id: String(plugin.pluginId),
    pluginId: String(plugin.pluginId),
    kind: 'plugin',
    name: getLocalizedPluginName(plugin) || plugin.name || plugin.pluginId,
    i18n: plugin.i18n,
    altNames: getLocalizedPluginAltNames(plugin),
    iconPath: plugin.iconPath || plugin.localIconPath || '',
    icon: plugin.icon || ''
  }))
})

/** 按搜索关键词过滤启动目标（支持名称、多语言别名与 ID 匹配） */
const filteredTargets = computed(() => {
  const keyword = searchText.value.trim().toLowerCase()
  if (!keyword) return launchTargets.value
  return launchTargets.value.filter(target =>
    getLocalizedPluginName(target).toLowerCase().includes(keyword) ||
    target.id.toLowerCase().includes(keyword) ||
    (Array.isArray(target.altNames) && target.altNames.some(alt => alt.toLowerCase().includes(keyword)))
  )
})

/** 获取启动目标原始快捷键，由 HotkeyCaptureField 按平台渲染 */
const getPluginHotkey = (targetId) => {
  return pluginHotkeyMap.value[String(targetId)]?.key || ''
}

/** 获取插件图标 URL */
const getPluginIcon = (target) => {
  if (target.kind !== 'plugin') return ''
  // 与主页卡片（usePluginIcon）同一优先级：远程图标优先，其次本地图标；都没有时由 RcSquircle 显示品牌图形
  if (target.icon && target.icon.startsWith('http')) return target.icon
  if (target.iconPath) return target.iconPath
  return ''
}

const getTargetTypeName = () => t('hotkey.launchModal.targetPlugin')
// ========== 弹窗生命周期 ==========

/** 显示弹窗；每次都从触发器注册表读取最新数据，支持按传入 pluginId 自动填充搜索并高亮定位目标行。 */
const show = async (options = {}) => {
  const targetPluginId =
    typeof options === 'string'
      ? options.trim()
      : (typeof options?.pluginId === 'string' ? options.pluginId.trim() : '')
  resetHotkeyRecorderState()
  const capabilities = await getHotkeyHostCapabilities()
  hotkeyPlatform.value = capabilities.platform
  supportsDoubleModifierHotkeys.value = capabilities.supportsDoubleModifierHotkeys
  searchText.value = targetPluginId
  highlightedTargetId.value = ''
  recordingPluginId.value = null
  await loadTriggers()
  if (targetPluginId) {
    const lowerTarget = targetPluginId.toLowerCase()
    const matchedTarget = launchTargets.value.find(
      (target) =>
        target.id.toLowerCase() === lowerTarget ||
        target.name.toLowerCase() === lowerTarget
    )
    if (matchedTarget) {
      searchText.value = matchedTarget.name || matchedTarget.id
      highlightedTargetId.value = matchedTarget.id
    }
  }
  visible.value = true
  if (highlightedTargetId.value) {
    await nextTick()
    itemRefs.get(highlightedTargetId.value)?.scrollIntoView?.({ block: 'nearest' })
  }
}

/** 隐藏弹窗 */
const hide = () => {
  cancelRecording(false)
  highlightedTargetId.value = ''
  visible.value = false
}

/** 弹窗关闭回调 */
const handleCancel = () => {
  hide()
}

// ========== 数据加载 ==========

/** 从 Delphi 端加载所有触发器，构建启动快捷键映射 */
async function loadTriggers() {
  pluginHotkeyMap.value = {}
  try {
    if (!window.ztools?.trigger) {
      return
    }
    const result = await window.ztools.trigger.list()
    const triggers = result?.data || result || []
    pluginHotkeyMap.value = buildLaunchHotkeyMap(
      triggers,
      getPluginFeatureHotkeyItemByTrigger
    )
  } catch (e) {
    console.error('加载触发器列表失败:', e)
  }
}

// ========== 快捷键录入 ==========

/** 开始录入快捷键（录入框组件负责聚焦） */
const startRecording = (targetId) => {
  resetHotkeyRecorderState()
  recordingPluginId.value = String(targetId)
  recordingText.value = ''
  recordingIsKeys.value = false
}

/** 取消录入；键盘取消时主动失焦并归还焦点给触发容器，彻底根治二次 Esc 被隐藏 input 吞掉的问题 */
const cancelRecording = (restoreFocus = false) => {
  const activeId = recordingPluginId.value
  resetHotkeyRecorderState()
  recordingPluginId.value = null
  recordingText.value = ''
  recordingIsKeys.value = false
  if (activeId) {
    fieldRefs.get(String(activeId))?.blurInput?.({ restoreFocus })
  }
}

/** 录入框里的按键：Esc 取消、⌫ 清除，组合键完整后做冲突检测并保存 */
const handleKeydown = async (event, target) => {
  if (!recordingPluginId.value || recordingPluginId.value !== target.id || loadingPluginId.value) return
  const result = interpretRecorderKeydown(event, {
    platform: hotkeyPlatform.value,
    allowDoubleTap: supportsDoubleModifierHotkeys.value
  })
  if (result.action === 'cancel') {
    cancelRecording(true)
    return
  }
  if (result.action === 'clear') {
    cancelRecording(true)
    if (getPluginHotkey(target.id)) await clearHotkey(target.id)
    return
  }
  recordingText.value = result.text
  recordingIsKeys.value = result.isKeys
  if (result.action !== 'valid') return
  await handleHotkeyRecorded(target, result.hotkey)
}

async function hasSameTargetHotkeyConflict(target, hotkeyStr) {
  try {
    if (!window.ztools?.trigger?.list) return false

    const current = pluginHotkeyMap.value[target.id]
    const currentTriggerId = current?.triggerId || ''
    const result = await window.ztools.trigger.list(current?.ownerId || target.id)
    const triggers = result?.data || result || []

    if (!Array.isArray(triggers)) return false

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
          t('hotkey.featureModal.conflictFeature', {
            plugin: featureItem.pluginName,
            feature: featureItem.featureName
          })
        )
      } else {
        message.warning(
          t('hotkey.launchModal.conflictSameTarget', { type: getTargetTypeName(target) })
        )
      }
      return true
    }
  } catch (e) {
    console.warn('检测同插件快捷键冲突失败:', e)
  }

  return false
}

/** 录入完成后的处理：冲突检测 + 保存 */
async function handleHotkeyRecorded(target, hotkeyStr) {
  loadingPluginId.value = target.id

  try {
    // 1. 本地检测：与全局唤醒快捷键 / 独立悬浮条快捷键冲突
    const globalHotkey = await getGlobalWakeHotkey()
    if (globalHotkey && globalHotkey.toLowerCase() === hotkeyStr.toLowerCase()) {
      message.warning(t('hotkey.featureModal.conflictGlobalWake'))
      cancelRecording()
      return
    }
    const launcherHotkey = await getGlobalLauncherHotkey()
    if (launcherHotkey && launcherHotkey.toLowerCase() === hotkeyStr.toLowerCase()) {
      message.warning(t('hotkey.featureModal.conflictGlobalLauncher'))
      cancelRecording()
      return
    }

    // 2. 本地检测：与同一目标的其他快捷键冲突
    if (await hasSameTargetHotkeyConflict(target, hotkeyStr)) {
      cancelRecording(true)
      return
    }

    // 3. IPC 检测：与其他启动快捷键冲突（携带当前 triggerId 避免自我误报）
    const currentTriggerId = pluginHotkeyMap.value[target.id]?.triggerId || ''
    if (window.ztools?.trigger?.checkConflict) {
      const ownerId = pluginHotkeyMap.value[target.id]?.ownerId || target.id
      const conflictResult = currentTriggerId
        ? await window.ztools.trigger.checkConflict(hotkeyStr, ownerId, currentTriggerId)
        : await window.ztools.trigger.checkConflict(hotkeyStr, ownerId)
      const data = conflictResult?.data || conflictResult || {}
      if (data.hasConflict && data.conflicts?.length > 0) {
        const names = data.conflicts
          .map(c => c.pluginName || c.pluginId)
          .join(t('settings.shortcuts.wakeHotkey.listSeparator'))
        message.warning(t('hotkey.launchModal.conflictTargets', { names }))
        cancelRecording(true)
        return
      }
    }

    // 4. 冲突检测通过，执行保存/修改
    const existing = pluginHotkeyMap.value[target.id]
    const existingTriggerIds = getExistingTriggerIds(existing)
    const newTriggerId = await doRegister(target, hotkeyStr)

    // 先确认新快捷键已经注册，再清理旧触发器；注册失败时保留原来的快捷键。
    const staleTriggerIds = existingTriggerIds.filter((triggerId) => triggerId !== newTriggerId)
    const failedCleanupIds = []
    for (const triggerId of staleTriggerIds) {
      try {
        await doUnregister(triggerId)
      } catch (cleanupError) {
        console.warn('清理历史启动快捷键失败:', triggerId, cleanupError)
        failedCleanupIds.push(triggerId)
      }
    }

    if (failedCleanupIds.length > 0) {
      const registered = pluginHotkeyMap.value[target.id]
      pluginHotkeyMap.value[target.id] = {
        ...registered,
        triggerIds: [newTriggerId, ...failedCleanupIds]
      }
      message.warning(t('hotkey.launchModal.cleanupPartialWarning'))
    }

    cancelRecording(true)
  } catch (e) {
    console.error('快捷键设置失败:', e)
    message.error(t('hotkey.launchModal.setFailed', { reason: resolveErrorMessage(e, 'common.unknownError') }))
    cancelRecording(true)
  } finally {
    loadingPluginId.value = null
  }
}

// ========== 系统快捷键获取（本地冲突检测用） ==========

/** 获取全局唤醒快捷键 */
async function getGlobalWakeHotkey() {
  try {
    return await getHotkey() || ''
  } catch {
    return ''
  }
}

/** 获取独立悬浮条全局快捷键 */
async function getGlobalLauncherHotkey() {
  try {
    return typeof getLauncherHotkey === 'function' ? (await getLauncherHotkey()) || '' : ''
  } catch {
    return ''
  }
}

// ========== 触发器注册/注销 ==========

/** 注册新的启动快捷键触发器 */
async function doRegister(target, hotkeyStr) {
  if (!window.ztools?.trigger) {
    throw new Error(t('hotkey.launchModal.triggerApiUnavailable'))
  }

  const result = await window.ztools.trigger.register(
    buildLaunchHotkeyRegistration(target, hotkeyStr)
  )

  const data = result?.data || result || {}

  // 检查注册是否成功
  if (result === false || data.success === false || data.error) {
    const resolved = data.error ? resolveErrorMessage(data, 'hotkey.launchModal.registerOccupied') : ''
    const hasDetail = Boolean(resolved && resolved !== t('hotkey.launchModal.registerOccupied'))
    throw new Error(
      hasDetail
        ? t('hotkey.launchModal.registerOccupiedWithDetail', { detail: resolved })
        : t('hotkey.launchModal.registerOccupied')
    )
  }

  const triggerId = data.triggerId || data.id
  if (typeof triggerId !== 'string' || !triggerId) {
    throw new Error(t('hotkey.launchModal.missingTriggerId'))
  }

  // 注册成功，更新本地映射
  pluginHotkeyMap.value[target.id] = {
    triggerId,
    triggerIds: [triggerId],
    key: hotkeyStr,
    kind: target.kind,
    ownerId: target.id
  }
  emit('update:count', Object.keys(pluginHotkeyMap.value).length)
  message.success(t('hotkey.launchModal.setSuccess'))
  const reserveWarning = getShellReserveWarning(hotkeyStr)
  if (reserveWarning) {
    message.warning(reserveWarning)
  }
  return triggerId
}

/** 注销触发器 */
async function doUnregister(triggerId) {
  if (!window.ztools?.trigger || !triggerId) return
  const result = await window.ztools.trigger.unregister(triggerId)
  const data = result?.data || result || {}
  if (result === false || data.success === false || data.error) {
    const resolved = data.error ? resolveErrorMessage(data, 'hotkey.launchModal.unregisterFailed') : ''
    const hasDetail = Boolean(resolved && resolved !== t('hotkey.launchModal.unregisterFailed'))
    throw new Error(
      hasDetail
        ? t('hotkey.launchModal.unregisterFailedWithDetail', { detail: resolved })
        : t('hotkey.launchModal.unregisterFailed')
    )
  }
}

function getExistingTriggerIds(existing) {
  const triggerIds = Array.isArray(existing?.triggerIds)
    ? existing.triggerIds
    : [existing?.triggerId]
  return [...new Set(triggerIds.filter(Boolean))]
}

async function unregisterAll(triggerIds) {
  for (const triggerId of triggerIds) {
    await doUnregister(triggerId)
  }
}

// ========== 清除快捷键 ==========

/** 清除某个启动目标的快捷键 */
const clearHotkey = async (targetId) => {
  const existing = pluginHotkeyMap.value[targetId]
  const existingTriggerIds = getExistingTriggerIds(existing)
  if (existingTriggerIds.length === 0) return

  loadingPluginId.value = targetId
  try {
    await unregisterAll(existingTriggerIds)
    // 更新本地映射
    delete pluginHotkeyMap.value[targetId]
    pluginHotkeyMap.value = { ...pluginHotkeyMap.value }
    emit('update:count', Object.keys(pluginHotkeyMap.value).length)
    message.success(t('hotkey.launchModal.clearSuccess'))
  } catch (e) {
    console.error('清除快捷键失败:', e)
    message.error(t('hotkey.launchModal.clearFailed'))
  } finally {
    loadingPluginId.value = null
  }
}

// ========== 已配置快捷键数量（供外部使用） ==========

const configuredCount = computed(() => {
  return Object.keys(pluginHotkeyMap.value).length
})

// 组件卸载时清理录入状态
onBeforeUnmount(() => {
  cancelRecording()
})

/** 外部数据加载完成后更新弹窗内的映射（处理弹窗先于数据打开的场景） */
const updateMap = (map) => {
  if (visible.value && map) {
    pluginHotkeyMap.value = { ...map }
  }
}

defineExpose({ show, hide, updateMap, configuredCount })
</script>

<template>
  <RcDialog
    v-model:open="visible"
    :after-close="() => emit('closed')"
    :title="t('hotkey.launchModal.title')"
    :width="560"
    @cancel="handleCancel"
  >
    <!-- 搜索框 -->
    <a-input
      v-model:value="searchText"
      :placeholder="t('hotkey.launchModal.searchPlaceholder')"
      allow-clear
      class="mb-3"
    >
      <template #prefix><SearchIcon class="input-prefix-icon" aria-hidden="true" /></template>
      <template #clearIcon><CircleXIcon class="input-clear-icon" aria-hidden="true" /></template>
    </a-input>

    <div class="hotkey-rule-tip">
      {{ getHotkeyRuleDescription(hotkeyPlatform, supportsDoubleModifierHotkeys) }}
    </div>

    <!-- 启动目标列表 -->
    <div class="plugin-hotkey-list">
      <div v-if="filteredTargets.length === 0" class="empty-tip">
        {{ searchText ? t('hotkey.launchModal.emptySearch') : t('hotkey.launchModal.emptyList') }}
      </div>

      <div
        v-for="target in filteredTargets"
        :key="target.id"
        :ref="(el) => setItemRef(target.id, el)"
        :data-target-id="target.id"
        class="plugin-hotkey-item"
        :class="{ invalid: target.invalid, 'is-highlighted': highlightedTargetId === target.id }"
      >
        <!-- 启动项图标 -->
        <!-- 与主页卡片同一套图标：官方插件用品牌图形，其它插件用自带图标，都没有时按名称挑同风格图形 -->
        <div class="plugin-icon-wrap">
          <RcSquircle
            :glyph="resolvePluginGlyph(target.id)"
            :fallback-glyph="resolveKeywordGlyph(target.name)"
            :src="getPluginIcon(target)"
            :size="32"
            :alt="getLocalizedPluginName(target)"
          />
        </div>

        <!-- 启动项名称 -->
        <div class="plugin-name">
          <!-- 列表里只有插件，逐行再写「插件」只是噪音，不再显示类型 -->
          <span>{{ getLocalizedPluginName(target) }}</span>
        </div>

        <!-- 快捷键区域 -->
        <HotkeyCaptureField
          :ref="(el) => setFieldRef(target.id, el)"
          :hotkey="getPluginHotkey(target.id)"
          :recording="recordingPluginId === target.id"
          :loading="loadingPluginId === target.id"
          :disabled="target.invalid"
          :platform="hotkeyPlatform"
          :supports-double-modifier="supportsDoubleModifierHotkeys"
          :recording-text="recordingText"
          :recording-is-keys="recordingIsKeys"
          :wait-text="getHotkeyWaitText(hotkeyPlatform, supportsDoubleModifierHotkeys)"
          :empty-text="t('hotkeyCapture.emptyText')"
          @start="startRecording(target.id)"
          @cancel="cancelRecording(false)"
          @keydown="handleKeydown($event, target)"
          @clear="clearHotkey(target.id)"
        />
      </div>
    </div>
  </RcDialog>
</template>

<style scoped>
.plugin-hotkey-list {
  max-height: 400px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* 底部留白，滚到底时最后一行不贴着弹窗圆角被裁断 */
  padding-bottom: 12px;
}

.empty-tip {
  text-align: center;
  color: var(--rc-text-secondary);
  padding: 32px 0;
  font-size: var(--rc-fs-body);
}

.plugin-hotkey-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--rc-radius-md);
  transition: background var(--rc-dur) ease;
}

.plugin-hotkey-item:hover {
  background: var(--rc-surface-hover);
}

.plugin-hotkey-item.invalid {
  opacity: 0.72;
}

.plugin-hotkey-item.is-highlighted {
  background: var(--rc-accent-subtle);
  outline: 1px solid var(--rc-accent);
}

.plugin-icon-wrap {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
}

.plugin-name {
  flex: 1;
  font-size: var(--rc-fs-body);
  font-weight: 500;
  color: var(--rc-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.hotkey-rule-tip {
  margin: -4px 0 12px;
  padding: 8px 10px;
  border-radius: var(--rc-radius-md);
  background: var(--rc-surface-subtle);
  border: 1px solid var(--rc-border);
  color: var(--rc-text-secondary);
  font-size: var(--rc-fs-small);
  line-height: 1.6;
}
</style>
