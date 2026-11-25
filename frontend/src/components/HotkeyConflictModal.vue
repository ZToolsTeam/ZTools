<script setup>
import ShortcutKeys from '@/components/base/ShortcutKeys.vue'
import { RcButton, RcDialog, RcTag } from '@/components/base'
import { TriangleAlertIcon } from '@lucide/vue'
/**
 * 快捷键冲突提醒弹窗
 * 统一规范化并合并展示两类冲突（互不覆盖）：
 * 1. 系统占用冲突（含全局唤醒、鼠标快捷唤醒、插件热键被外部程序占用）
 * 2. 插件重复冲突（插件或功能热键之间存在重复绑定）
 */
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ROUTES } from '@/router/routes'
import { isSafeShortcutKeysCombo } from '@/utils/hotkeyRecorder'
import {
  PLUGIN_FEATURE_HOTKEY_QUERY_KEY,
  getPluginFeatureHotkeyItemByTriggerId,
  isPluginFeatureHotkeyTriggerId
} from '@/utils/pluginFeatureHotkeys'
import { useAppI18n } from '@/i18n'
import { useToast } from '@/composables/useToast'
import { useAppPreferencesApi } from '@/composables/useAppPreferencesApi'
import { syncGlobalWakeHotkey } from '@/utils/globalWakeHotkey'
import { shortcutLabel } from '@/utils/platform'
import { resolveErrorMessage } from '@/utils/errorMessage'

const { t, locale } = useAppI18n()
const { success, error } = useToast()
const { setHotkey } = useAppPreferencesApi()
const router = useRouter()
const visible = ref(false)
const quickSwitchingKey = ref('')
// 仅保存结构化原始冲突字段，避免在 show() 中静态固化翻译文本导致热切换语言冻结
const conflicts = ref([])

const isSystemTarget = (item) => {
  const pid = String(item?.pluginId || '').trim().toLowerCase()
  const tid = String(item?.triggerId || '').trim()
  return (
    pid === 'system' ||
    tid === 'global_wake_hotkey' ||
    tid === 'mouse_wake_hook'
  )
}

/** 按当前 locale 实时解析冲突条目的显示名称 */
const resolveDisplayItemTitle = (item) => {
  if (item?.pluginNameRaw) return item.pluginNameRaw
  const tid = String(item?.triggerId || '').trim()
  if (tid === 'global_wake_hotkey') return t('modals.hotkeyConflict.globalWake')
  if (tid === 'mouse_wake_hook') return t('modals.hotkeyConflict.mouseWake')
  const featureItem = tid ? getPluginFeatureHotkeyItemByTriggerId(tid) : null
  if (featureItem) return `${featureItem.pluginName} · ${featureItem.featureName}`
  if (String(item?.pluginId || '').trim().toLowerCase() === 'system') return t('modals.hotkeyConflict.systemHotkey')
  if (item?.pluginId) return item.pluginId
  if (item?.rawType === 'mouse') return t('modals.hotkeyConflict.mouseWake')
  if (item?.rawType === 'keyboard') return t('modals.hotkeyConflict.globalWake')
  return t('modals.hotkeyConflict.unknownTrigger')
}

/** 按当前 locale 实时解析冲突对象/占用方文案 */
const resolveDisplayConflictWith = (item) => {
  const fallbackKey =
    item?.conflictType === 'system_occupied'
      ? 'modals.hotkeyConflict.systemOrOtherApp'
      : 'modals.hotkeyConflict.otherHotkey'
  if (item?.conflictWithRaw) {
    return item.conflictType === 'system_occupied'
      ? resolveErrorMessage(item.conflictWithRaw, fallbackKey)
      : item.conflictWithRaw
  }
  return t(fallbackKey)
}

const normalizeSuggestions = (raw) =>
  Array.isArray(raw)
    ? [...new Set(raw.filter((key) => typeof key === 'string' && key.trim()).map((key) => key.trim()))].slice(0, 3)
    : []

/** 将不同来源的冲突记录归一化为与语言无关的结构化记录 */
const normalizeConflictItem = (item) => {
  if (!item || typeof item !== 'object') return null

  const suggestions = normalizeSuggestions(item.suggestions)

  // 兼容旧版系统冲突格式 { type: 'keyboard' | 'mouse', key }
  if ((item.type === 'keyboard' || item.type === 'mouse') && !('conflictType' in item)) {
    return {
      pluginNameRaw: '',
      pluginId: 'system',
      rawType: item.type,
      key: item.key || '',
      conflictType: 'system_occupied',
      conflictWithRaw: '',
      triggerId: item.type === 'mouse' ? 'mouse_wake_hook' : 'global_wake_hotkey',
      conflictTriggerId: '',
      suggestions
    }
  }

  // 兼容 Electron 宿主直推的 { type: 'system', key, pluginId, triggerId } 格式
  if (item.type === 'system' && !('conflictType' in item)) {
    return {
      pluginNameRaw: typeof item.pluginName === 'string' ? item.pluginName.trim() : '',
      pluginId: item.pluginId || '',
      rawType: 'system',
      key: item.key || '',
      conflictType: 'system_occupied',
      conflictWithRaw: typeof item.reason === 'string' ? item.reason.trim() : '',
      triggerId: item.triggerId || '',
      conflictTriggerId: '',
      suggestions
    }
  }

  const normalizedType =
    item.conflictType === 'duplicate' ? 'duplicate' : 'system_occupied'

  return {
    pluginNameRaw: typeof item.pluginName === 'string' ? item.pluginName.trim() : '',
    pluginId: item.pluginId || '',
    rawType: typeof item.type === 'string' ? item.type : '',
    key: item.key || '',
    conflictType: normalizedType,
    conflictWithRaw: typeof item.conflictWith === 'string' ? item.conflictWith.trim() : '',
    triggerId: item.triggerId || '',
    conflictTriggerId: item.conflictTriggerId || '',
    suggestions
  }
}

const buildConflictSignature = (item) =>
  [
    item.conflictType,
    item.triggerId,
    item.pluginId,
    item.pluginNameRaw,
    item.key,
    item.conflictWithRaw,
    item.conflictTriggerId
  ].join('|')

/**
 * 显示冲突弹窗；弹窗尚未关闭时新到达的冲突合并追加而非互相覆盖
 * @param {Array} conflictList - 冲突数据列表
 */
const show = (conflictList) => {
  if (!Array.isArray(conflictList) || conflictList.length === 0) return
  const normalizedIncoming = conflictList
    .map(normalizeConflictItem)
    .filter(Boolean)
  if (normalizedIncoming.length === 0) return

  const baseList = visible.value ? conflicts.value : []
  const merged = []
  const seen = new Set()
  for (const item of [...baseList, ...normalizedIncoming]) {
    const sig = buildConflictSignature(item)
    if (seen.has(sig)) continue
    seen.add(sig)
    merged.push(item)
  }

  conflicts.value = merged
  visible.value = true
}

/** 关闭弹窗并清理本轮已展示列表 */
const close = () => {
  visible.value = false
  conflicts.value = []
}

const renderedConflicts = computed(() => {
  void locale.value
  return conflicts.value.map((item) => ({
    ...item,
    pluginName: resolveDisplayItemTitle(item),
    conflictWith: resolveDisplayConflictWith(item)
  }))
})

const systemOccupiedConflicts = computed(() =>
  renderedConflicts.value.filter((item) => item.conflictType === 'system_occupied')
)

const duplicateConflicts = computed(() =>
  renderedConflicts.value.filter((item) => item.conflictType === 'duplicate')
)

const hasSystemWakeConflict = computed(() =>
  conflicts.value.some(isSystemTarget)
)

const hasPluginConflict = computed(() =>
  conflicts.value.some((item) => !isSystemTarget(item))
)

const hasFeatureHotkeyConflict = computed(() =>
  conflicts.value.some(
    (item) =>
      isPluginFeatureHotkeyTriggerId(item.triggerId) ||
      isPluginFeatureHotkeyTriggerId(item.conflictTriggerId)
  )
)

/** 跳转到设置页面 */
const goSettings = () => {
  const hasSystem = hasSystemWakeConflict.value
  const hasFeature = hasFeatureHotkeyConflict.value
  const hasPlugin = hasPluginConflict.value
  close()

  if (hasSystem) {
    router.push({
      name: ROUTES.ADVANCED_SETTINGS.name,
      query: { tab: 'shortcuts' }
    })
    return
  }
  if (hasFeature) {
    router.push({
      name: ROUTES.ADVANCED_SETTINGS.name,
      query: { [PLUGIN_FEATURE_HOTKEY_QUERY_KEY]: 'true' }
    })
    return
  }
  if (hasPlugin) {
    router.push({
      name: ROUTES.ADVANCED_SETTINGS.name,
      query: { openPluginHotkey: 'true' }
    })
    return
  }
  router.push({ name: ROUTES.ADVANCED_SETTINGS.name, query: { tab: 'shortcuts' } })
}

/** 弹窗标题 */
const modalTitle = computed(() => {
  if (systemOccupiedConflicts.value.length > 0 && duplicateConflicts.value.length > 0) {
    return t('modals.hotkeyConflict.titleMixed')
  }
  if (systemOccupiedConflicts.value.length > 0) {
    return hasPluginConflict.value ? t('modals.hotkeyConflict.titleOccupiedPlugin') : t('modals.hotkeyConflict.titleOccupied')
  }
  return t('modals.hotkeyConflict.titleDuplicate')
})

/** 弹窗描述文本 */
const descText = computed(() => {
  if (systemOccupiedConflicts.value.length > 0 && duplicateConflicts.value.length > 0) {
    return t('modals.hotkeyConflict.descMixed')
  }
  if (systemOccupiedConflicts.value.length > 0) {
    return t('modals.hotkeyConflict.descOccupied')
  }
  return t('modals.hotkeyConflict.descDuplicate')
})

/** 提示文本 */
const tipText = computed(() => {
  if (hasSystemWakeConflict.value && hasPluginConflict.value) {
    return t('modals.hotkeyConflict.tipBoth')
  }
  if (hasSystemWakeConflict.value) {
    return t('modals.hotkeyConflict.tipSystem')
  }
  if (hasFeatureHotkeyConflict.value) {
    return t('modals.hotkeyConflict.tipFeature')
  }
  return t('modals.hotkeyConflict.tipPlugin')
})

const canRenderCombo = (key) => isSafeShortcutKeysCombo(key, 'windows', true)

const isWakeConflictWithSuggestions = (item) =>
  item?.triggerId === 'global_wake_hotkey' &&
  Array.isArray(item?.suggestions) &&
  item.suggestions.length > 0

/** 一键换用经本机实测未被占用的备选全局唤醒热键 */
const applyQuickWakeSuggestion = async (item, candidate) => {
  if (quickSwitchingKey.value || !candidate) return
  const previousKey = typeof item?.key === 'string' ? item.key : ''
  quickSwitchingKey.value = candidate
  try {
    const saved = await setHotkey(candidate)
    if (!saved) {
      error(t('modals.hotkeyConflict.quickSwitchFailed', { reason: t('settings.shortcuts.wakeHotkey.saveFailed') }))
      return
    }
    let syncRes
    try {
      syncRes = await syncGlobalWakeHotkey({ hotkey: candidate })
    } catch (err) {
      if (previousKey) await setHotkey(previousKey)
      error(t('modals.hotkeyConflict.quickSwitchFailed', { reason: resolveErrorMessage(err, 'common.unknownError') }))
      return
    }
    if (!syncRes?.success) {
      if (previousKey) await setHotkey(previousKey)
      const reason = syncRes?.message
        ? resolveErrorMessage({ error: syncRes.message }, 'common.unknownError')
        : t('settings.shortcuts.wakeHotkey.reasons.default')
      error(t('modals.hotkeyConflict.quickSwitchFailed', { reason }))
      return
    }
    try {
      await window.ztools?.sys?.reloadHotkeys?.()
    } catch {
      // 托盘文案刷新失败不影响热键已生效
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ztools-settings-changed'))
    }
    success(t('modals.hotkeyConflict.quickSwitchSuccess', { key: shortcutLabel(candidate) || candidate }))
    conflicts.value = conflicts.value.filter((c) => c.triggerId !== 'global_wake_hotkey')
    if (conflicts.value.length === 0) {
      close()
    }
  } finally {
    quickSwitchingKey.value = ''
  }
}

defineExpose({ show, close })
</script>

<template>
  <RcDialog
    v-model:open="visible"
    :title="modalTitle"
    :width="440"
    @cancel="close"
  >
    <div class="conflict-content">
      <div class="conflict-icon">
        <TriangleAlertIcon aria-hidden="true" />
      </div>
      <p class="conflict-desc">{{ descText }}</p>

      <div class="conflict-sections">
        <!-- 系统占用冲突区块 -->
        <section v-if="systemOccupiedConflicts.length > 0" class="conflict-section" data-testid="system-conflicts-section">
          <h3 v-if="duplicateConflicts.length > 0" class="conflict-section-title">{{ t('modals.hotkeyConflict.sectionSystem') }}</h3>
          <div class="conflict-list">
            <div
              v-for="(item, index) in systemOccupiedConflicts"
              :key="`sys-${index}-${item.triggerId}-${item.key}`"
              class="conflict-item plugin-conflict-item"
            >
              <div class="plugin-conflict-row">
                <span class="plugin-name">{{ item.pluginName }}</span>
                <ShortcutKeys v-if="canRenderCombo(item.key)" class="conflict-key" :combo="item.key" />
                <span v-else-if="item.key" class="conflict-key-text">{{ item.key }}</span>
              </div>
              <div class="plugin-conflict-detail">
                <RcTag tone="error">{{ t('modals.hotkeyConflict.tagSystem') }}</RcTag>
                <span class="conflict-with">{{ t('modals.hotkeyConflict.conflictWith', { name: item.conflictWith }) }}</span>
              </div>
              <div
                v-if="isWakeConflictWithSuggestions(item)"
                class="conflict-suggestions"
                data-testid="wake-conflict-suggestions"
              >
                <span class="conflict-suggestions-label">{{ t('modals.hotkeyConflict.quickSwitchLabel') }}</span>
                <div class="conflict-suggestions-list">
                  <button
                    v-for="candidate in item.suggestions"
                    :key="candidate"
                    type="button"
                    class="conflict-suggestion-btn"
                    :disabled="Boolean(quickSwitchingKey)"
                    :data-testid="`quick-switch-${candidate}`"
                    @click="applyQuickWakeSuggestion(item, candidate)"
                  >
                    <ShortcutKeys v-if="canRenderCombo(candidate)" :combo="candidate" />
                    <span v-else>{{ candidate }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- 插件重复冲突区块 -->
        <section v-if="duplicateConflicts.length > 0" class="conflict-section" data-testid="duplicate-conflicts-section">
          <h3 v-if="systemOccupiedConflicts.length > 0" class="conflict-section-title">{{ t('modals.hotkeyConflict.sectionDuplicate') }}</h3>
          <div class="conflict-list">
            <div
              v-for="(item, index) in duplicateConflicts"
              :key="`dup-${index}-${item.triggerId}-${item.key}`"
              class="conflict-item plugin-conflict-item"
            >
              <div class="plugin-conflict-row">
                <span class="plugin-name">{{ item.pluginName }}</span>
                <ShortcutKeys v-if="canRenderCombo(item.key)" class="conflict-key" :combo="item.key" />
                <span v-else-if="item.key" class="conflict-key-text">{{ item.key }}</span>
              </div>
              <div class="plugin-conflict-detail">
                <RcTag tone="warning">{{ t('modals.hotkeyConflict.tagDuplicate') }}</RcTag>
                <span class="conflict-with">{{ t('modals.hotkeyConflict.conflictWith', { name: item.conflictWith }) }}</span>
              </div>
            </div>
          </div>
        </section>
      </div>

      <p class="conflict-tip">{{ tipText }}</p>
    </div>
    <template #footer>
      <RcButton variant="secondary" size="md" @click="close">{{ t('common.close') }}</RcButton>
      <RcButton variant="primary" size="md" @click="goSettings">{{ t('modals.hotkeyConflict.goSettings') }}</RcButton>
    </template>
  </RcDialog>
</template>

<style scoped>
.conflict-content {
  text-align: center;
  padding: 8px 0;
}
.conflict-icon {
  display: inline-flex;
  font-size: 48px; /* 图标字形尺寸 */
  color: var(--rc-warning);
  margin-bottom: 12px;
}
.conflict-desc {
  font-size: var(--rc-fs-body);
  color: var(--rc-text-primary);
  margin-bottom: 14px;
}
.conflict-sections {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
  max-height: 260px;
  overflow-y: auto;
}
.conflict-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.conflict-section-title {
  margin: 0;
  padding-left: 2px;
  text-align: left;
  font-size: var(--rc-fs-small);
  font-weight: 600;
  color: var(--rc-text-secondary);
}
.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.conflict-item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 14px;
  background: var(--rc-canvas);
  border-radius: var(--rc-radius-md);
}
/* 冲突项：纵向布局 */
.plugin-conflict-item {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  text-align: left;
}
.plugin-conflict-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.plugin-name {
  font-size: var(--rc-fs-body);
  font-weight: 500;
  color: var(--rc-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-conflict-detail {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--rc-fs-small);
}
.conflict-with {
  color: var(--rc-text-secondary);
}
.conflict-key {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.conflict-key-text {
  font-size: var(--rc-fs-small);
  color: var(--rc-text-secondary);
}
.conflict-tip {
  font-size: var(--rc-fs-small);
  color: var(--rc-text-secondary);
  margin-bottom: 0;
}
.conflict-suggestions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
  padding-top: 8px;
  border-top: 1px solid var(--rc-border);
}
.conflict-suggestions-label {
  font-size: var(--rc-fs-small);
  color: var(--rc-text-secondary);
}
.conflict-suggestions-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.conflict-suggestion-btn {
  display: inline-flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: var(--rc-radius-sm);
  border: 1px solid var(--rc-border);
  background: var(--rc-surface);
  color: var(--rc-text-primary);
  font-size: var(--rc-fs-small);
  cursor: pointer;
  transition: border-color var(--rc-dur) ease, background-color var(--rc-dur) ease;
}
.conflict-suggestion-btn:hover:not(:disabled) {
  border-color: var(--rc-accent);
  background: var(--rc-surface-hover);
}
.conflict-suggestion-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
