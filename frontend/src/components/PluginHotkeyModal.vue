<script setup>
/**
 * 启动快捷键管理弹窗
 * 展示所有已安装插件和已加入面板的本地软件，支持设置/修改/清除全局快捷键
 * 通过 IPC trigger 系列接口与原生宿主端交互
 */
import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import { usePluginsStore } from '@/stores/plugins'
import { storeToRefs } from 'pinia'
import { message } from 'ant-design-vue'
import { getHotkey } from '@/api/apiserver'
import { getPluginFeatureHotkeyItemByTrigger } from '@/utils/pluginFeatureHotkeys'
import {
  buildLaunchHotkeyMap,
  buildLaunchHotkeyRegistration
} from '@/utils/launchHotkeyTargets'
import {
  formatHotkeyForPlatform,
  getHotkeyHostCapabilities,
  getHotkeyRuleDescription,
  getHotkeyWaitText,
  parseSupportedHotkeyEvent,
  resetHotkeyRecorderState
} from '@/utils/hotkeyRecorder'

const emit = defineEmits(['update:count'])

const visible = ref(false)
const hotkeyPlatform = ref('unknown')
const supportsDoubleModifierHotkeys = ref(false)
const searchText = ref('')
// 启动快捷键映射：{ targetId: { triggerId, triggerIds, key, kind, ownerId } }
const pluginHotkeyMap = ref({})
// 已加入超级面板的本地软件
const localApps = ref([])
// 当前正在录入快捷键的目标ID
const recordingPluginId = ref(null)
// 录入中显示的临时按键文本
const recordingText = ref('')
// 操作加载状态
const loadingPluginId = ref(null)

const pluginsStore = usePluginsStore()
const { installedPlugins } = storeToRefs(pluginsStore)

const launchTargets = computed(() => {
  const plugins = (installedPlugins.value || []).map(plugin => ({
    id: String(plugin.pluginId),
    kind: 'plugin',
    name: plugin.name || plugin.pluginId,
    iconPath: plugin.iconPath || '',
    icon: plugin.icon || ''
  }))
  const apps = localApps.value.map(app => ({
    id: String(app.id),
    kind: 'localApp',
    name: app.name || app.id
  }))
  const knownIds = new Set(apps.map(app => app.id))
  const invalidApps = Object.entries(pluginHotkeyMap.value)
    .filter(([id, item]) => item.kind === 'localApp' && !knownIds.has(id))
    .map(([id]) => ({
      id,
      kind: 'localApp',
      name: `${id}（已移出面板）`,
      invalid: true
    }))
  return [...plugins, ...apps, ...invalidApps]
})

/** 按搜索关键词过滤启动目标 */
const filteredTargets = computed(() => {
  const keyword = searchText.value.trim().toLowerCase()
  if (!keyword) return launchTargets.value
  return launchTargets.value.filter(target =>
    target.name.toLowerCase().includes(keyword)
  )
})

/** 获取启动目标的快捷键显示文本 */
const getPluginHotkey = (targetId) => {
  return formatHotkeyForPlatform(
    pluginHotkeyMap.value[String(targetId)]?.key || '',
    hotkeyPlatform.value,
    supportsDoubleModifierHotkeys.value
  )
}

/** 获取插件图标 URL；本地软件使用类型占位图标。 */
const getPluginIcon = (target) => {
  if (target.kind !== 'plugin') return ''
  // 优先使用本地图标，其次远程图标
  if (target.iconPath) return target.iconPath
  if (target.icon && target.icon.startsWith('http')) return target.icon
  return ''
}

const getTargetTypeName = target => target.kind === 'localApp' ? '本地软件' : '插件'
const getHotkeyInputId = targetId => `hotkey-hidden-input-${encodeURIComponent(targetId)}`

// ========== 弹窗生命周期 ==========

/** 显示弹窗；每次都从触发器注册表读取最新数据，避免复用过期缓存。 */
const show = async () => {
  resetHotkeyRecorderState()
  const capabilities = await getHotkeyHostCapabilities()
  hotkeyPlatform.value = capabilities.platform
  supportsDoubleModifierHotkeys.value = capabilities.supportsDoubleModifierHotkeys
  searchText.value = ''
  recordingPluginId.value = null
  await Promise.all([loadLocalApps(), loadTriggers()])
  visible.value = true
}

/** 隐藏弹窗 */
const hide = () => {
  cancelRecording()
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

async function loadLocalApps() {
  try {
    if (!window.ztools?.sys?.getPanelLocalApps) {
      localApps.value = []
      return
    }
    const apps = await window.ztools.sys.getPanelLocalApps()
    localApps.value = Array.isArray(apps) ? apps : []
  } catch (e) {
    console.error('加载面板本地软件失败:', e)
    localApps.value = []
    message.error('加载面板本地软件失败')
  }
}

// ========== 快捷键录入 ==========

/** 开始录入快捷键 */
const startRecording = (targetId) => {
  resetHotkeyRecorderState()
  // 如果有其他插件正在录入，先取消
  if (recordingPluginId.value && recordingPluginId.value !== targetId) {
    cancelRecording()
  }
  recordingPluginId.value = String(targetId)
  recordingText.value = ''
  // 等待 DOM 更新后聚焦隐藏输入框
  nextTick(() => {
    const input = document.getElementById(getHotkeyInputId(String(targetId)))
    input?.focus()
  })
}

/** 取消录入 */
const cancelRecording = () => {
  resetHotkeyRecorderState()
  recordingPluginId.value = null
  recordingText.value = ''
}

/** 处理键盘按下事件 */
const handleKeydown = async (event, target) => {
  event.preventDefault()
  event.stopPropagation()

  if (!recordingPluginId.value || recordingPluginId.value !== target.id) return

  // Escape 取消录入
  if (event.key === 'Escape') {
    cancelRecording()
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

  // 录入完成，进行冲突检测并保存
  await handleHotkeyRecorded(target, hotkeyStr)
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
          `该快捷键与「${featureItem.pluginName} - ${featureItem.featureName}」冲突`
        )
      } else {
        message.warning(`该快捷键与该${getTargetTypeName(target)}的其他快捷键冲突`)
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
    // 1. 本地检测：与全局唤醒快捷键冲突
    const globalHotkey = await getGlobalWakeHotkey()
    if (globalHotkey && globalHotkey.toLowerCase() === hotkeyStr.toLowerCase()) {
      message.warning('该快捷键与全局唤醒快捷键冲突')
      cancelRecording()
      return
    }

    // 2. 本地检测：与超级面板键盘热键冲突
    const superPanelHotkey = await getSuperPanelHotkey()
    if (superPanelHotkey && superPanelHotkey.toLowerCase() === hotkeyStr.toLowerCase()) {
      message.warning('该快捷键与超级面板键盘热键冲突')
      cancelRecording()
      return
    }

    if (await hasSameTargetHotkeyConflict(target, hotkeyStr)) {
      cancelRecording()
      return
    }

    // 3. IPC 检测：与其他启动快捷键冲突
    if (window.ztools?.trigger?.checkConflict) {
      const ownerId = pluginHotkeyMap.value[target.id]?.ownerId || target.id
      const conflictResult = await window.ztools.trigger.checkConflict(hotkeyStr, ownerId)
      const data = conflictResult?.data || conflictResult || {}
      if (data.hasConflict && data.conflicts?.length > 0) {
        const names = data.conflicts.map(c => {
          const localApp = localApps.value.find(app => app.id === c.pluginId)
          return localApp?.name || c.pluginName || c.pluginId
        }).join('、')
        message.warning(`该快捷键与启动项「${names}」冲突`)
        cancelRecording()
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
      message.warning('新快捷键已启用，但部分历史快捷键未清理；可重试清除')
    }

    cancelRecording()
  } catch (e) {
    console.error('快捷键设置失败:', e)
    message.error('快捷键设置失败: ' + (e.message || '未知错误'))
    cancelRecording()
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

/** 获取超级面板键盘热键 */
async function getSuperPanelHotkey() {
  try {
    if (!window.ztools?.config) return ''
    const config = await window.ztools.config.get('super_panel')
    const kb = config?.keyboardHotkey
    if (!kb?.enabled || !kb?.key) return ''
    const mods = Array.isArray(kb.modifiers)
      ? kb.modifiers.map(m => m.charAt(0).toUpperCase() + m.slice(1))
      : []
    const key = kb.key.charAt(0).toUpperCase() + kb.key.slice(1)
    return [...mods, key].join('+')
  } catch {
    return ''
  }
}

// ========== 触发器注册/注销 ==========

/** 注册新的启动快捷键触发器 */
async function doRegister(target, hotkeyStr) {
  if (!window.ztools?.trigger) {
    throw new Error('trigger API 不可用')
  }

  const result = await window.ztools.trigger.register(
    buildLaunchHotkeyRegistration(target, hotkeyStr)
  )

  const data = result?.data || result || {}

  // 检查注册是否成功
  if (result === false || data.success === false || data.error) {
    const detail = typeof data.error === 'string' ? `: ${data.error}` : ''
    throw new Error(`快捷键注册失败，可能被其他程序占用${detail}`)
  }

  const triggerId = data.triggerId || data.id
  if (typeof triggerId !== 'string' || !triggerId) {
    throw new Error('快捷键注册响应缺少触发器 ID，无法安全替换旧快捷键')
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
  message.success('快捷键设置成功')
  return triggerId
}

/** 注销触发器 */
async function doUnregister(triggerId) {
  if (!window.ztools?.trigger || !triggerId) return
  const result = await window.ztools.trigger.unregister(triggerId)
  const data = result?.data || result || {}
  if (result === false || data.success === false || data.error) {
    const detail = typeof data.error === 'string' ? `: ${data.error}` : ''
    throw new Error(`注销快捷键失败${detail}`)
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
    message.success('快捷键已清除')
  } catch (e) {
    console.error('清除快捷键失败:', e)
    message.error('清除快捷键失败')
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
  <a-modal
    v-model:open="visible"
    title="启动快捷键管理"
    :footer="null"
    :width="560"
    centered
    @cancel="handleCancel"
  >
    <!-- 搜索框 -->
    <a-input-search
      v-model:value="searchText"
      placeholder="搜索插件或本地软件..."
      allow-clear
      class="mb-3"
    />

    <div class="hotkey-rule-tip">
      {{ getHotkeyRuleDescription(hotkeyPlatform, supportsDoubleModifierHotkeys) }}
    </div>

    <!-- 启动目标列表 -->
    <div class="plugin-hotkey-list">
      <div v-if="filteredTargets.length === 0" class="empty-tip">
        {{ searchText ? '未找到匹配的启动项' : '暂无可配置的插件或本地软件' }}
      </div>

      <div
        v-for="target in filteredTargets"
        :key="target.id"
        class="plugin-hotkey-item"
        :class="{ invalid: target.invalid }"
      >
        <!-- 启动项图标 -->
        <div class="plugin-icon-wrap">
          <img
            v-if="getPluginIcon(target)"
            :src="getPluginIcon(target)"
            class="plugin-icon"
            :alt="target.name"
          />
          <div v-else class="plugin-icon-placeholder">
            <i :class="target.kind === 'localApp' ? 'fa fa-desktop' : 'fa fa-puzzle-piece'"></i>
          </div>
        </div>

        <!-- 启动项名称 -->
        <div class="plugin-name">
          <span>{{ target.name }}</span>
          <span class="target-type">{{ getTargetTypeName(target) }}</span>
        </div>

        <!-- 快捷键区域 -->
        <div class="hotkey-area">
          <!-- 录入模式 -->
          <div
            v-if="recordingPluginId === target.id"
            class="hotkey-recorder recording"
            @click.stop
          >
            <input
              :id="getHotkeyInputId(target.id)"
              class="hotkey-hidden-input"
              readonly
              @keydown="handleKeydown($event, target)"
              @blur="cancelRecording"
            />
            <span v-if="recordingText" class="recording-keys">
              <span
                v-for="k in recordingText.replace('...', '').split('+')"
                :key="k"
                class="key-badge"
              >{{ k || '...' }}</span>
            </span>
            <span v-else class="recording-text">
              <i class="fa fa-circle recording-dot"></i>
              {{ getHotkeyWaitText(hotkeyPlatform, supportsDoubleModifierHotkeys) }}
            </span>
          </div>

          <!-- 显示模式 -->
          <div
            v-else
            class="hotkey-recorder"
            :class="{ loading: loadingPluginId === target.id, disabled: target.invalid }"
            @click="!target.invalid && startRecording(target.id)"
          >
            <div v-if="getPluginHotkey(target.id)" class="hotkey-keys">
              <span
                v-for="k in getPluginHotkey(target.id).split('+')"
                :key="k"
                class="key-badge"
              >{{ k }}</span>
            </div>
            <span v-else class="no-hotkey">未设置</span>
          </div>

          <!-- 清除按钮 -->
          <button
            v-if="getPluginHotkey(target.id) && recordingPluginId !== target.id"
            class="clear-btn"
            title="清除快捷键"
            @click.stop="clearHotkey(target.id)"
          >
            <i class="fa fa-times"></i>
          </button>
        </div>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.plugin-hotkey-list {
  max-height: 400px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.empty-tip {
  text-align: center;
  color: var(--rc-text-secondary);
  padding: 32px 0;
  font-size: 13px;
}

.plugin-hotkey-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--rc-radius-md, 8px);
  transition: background 0.15s ease;
}

.plugin-hotkey-item:hover {
  background: var(--rc-surface-hover);
}

.plugin-hotkey-item.invalid {
  opacity: 0.72;
}

.plugin-icon-wrap {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
}

.plugin-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--rc-radius-md, 8px);
  object-fit: cover;
}

.plugin-icon-placeholder {
  width: 32px;
  height: 32px;
  border-radius: var(--rc-radius-md, 8px);
  background: var(--rc-surface-subtle);
  border: 1px solid var(--rc-border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--rc-text-secondary);
  font-size: 14px;
}

.plugin-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--rc-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.target-type {
  color: var(--rc-text-muted);
  font-size: 11px;
  font-weight: 400;
}

.hotkey-area {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.hotkey-recorder {
  min-width: 120px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--rc-radius-md, 8px);
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

.hotkey-recorder.disabled {
  cursor: not-allowed;
  opacity: 0.65;
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

.recording-keys .key-badge:first-child:last-child {
  color: var(--rc-error);
  border-color: var(--rc-error);
  background: var(--rc-error-subtle);
}

.hotkey-rule-tip {
  margin: -4px 0 12px;
  padding: 8px 10px;
  border-radius: var(--rc-radius-md, 8px);
  background: var(--rc-surface-subtle);
  border: 1px solid var(--rc-border);
  color: var(--rc-text-secondary);
  font-size: 12px;
  line-height: 1.6;
}

.recording-keys {
  display: flex;
  align-items: center;
  gap: 3px;
}

.recording-dot {
  font-size: 6px;
  animation: pulse 1s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.hotkey-keys {
  display: flex;
  align-items: center;
  gap: 3px;
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
</style>
