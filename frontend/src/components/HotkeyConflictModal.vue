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

const router = useRouter()
const visible = ref(false)
const conflicts = ref([])

const isSystemTarget = (item) => {
  const pid = String(item?.pluginId || '').trim().toLowerCase()
  const tid = String(item?.triggerId || '').trim()
  return pid === 'system' || tid === 'global_wake_hotkey' || tid === 'mouse_wake_hook'
}

const resolveRawItemTitle = (item) => {
  const tid = String(item?.triggerId || '').trim()
  if (tid === 'global_wake_hotkey') return '全局唤醒快捷键'
  if (tid === 'mouse_wake_hook') return '鼠标快捷唤醒'
  const featureItem = tid ? getPluginFeatureHotkeyItemByTriggerId(tid) : null
  if (featureItem) return `${featureItem.pluginName} · ${featureItem.featureName}`
  if (String(item?.pluginId || '').trim().toLowerCase() === 'system') return '系统快捷键'
  if (item?.pluginName) return item.pluginName
  if (item?.pluginId) return item.pluginId
  if (item?.type === 'mouse') return '鼠标快捷唤醒'
  if (item?.type === 'keyboard') return '全局唤醒快捷键'
  return '未知触发器'
}

/** 将不同来源的冲突记录归一化为统一展示结构 */
const normalizeConflictItem = (item) => {
  if (!item || typeof item !== 'object') return null

  // 兼容旧版系统冲突格式 { type: 'keyboard' | 'mouse', key }
  if ((item.type === 'keyboard' || item.type === 'mouse') && !('conflictType' in item)) {
    return {
      pluginName: item.type === 'mouse' ? '鼠标快捷唤醒' : '全局唤醒快捷键',
      pluginId: 'system',
      key: item.key || '',
      conflictType: 'system_occupied',
      conflictWith: '系统或其他程序',
      triggerId: item.type === 'mouse' ? 'mouse_wake_hook' : 'global_wake_hotkey',
      conflictTriggerId: ''
    }
  }

  // 兼容 Electron 宿主直推的 { type: 'system', key, pluginId, triggerId } 格式
  if (item.type === 'system' && !('conflictType' in item)) {
    return {
      pluginName: resolveRawItemTitle(item),
      pluginId: item.pluginId || '',
      key: item.key || '',
      conflictType: 'system_occupied',
      conflictWith: item.reason || '系统或其他程序',
      triggerId: item.triggerId || '',
      conflictTriggerId: ''
    }
  }

  const normalizedType =
    item.conflictType === 'duplicate' ? 'duplicate' : 'system_occupied'

  return {
    pluginName: item.pluginName || resolveRawItemTitle(item),
    pluginId: item.pluginId || '',
    key: item.key || '',
    conflictType: normalizedType,
    conflictWith: item.conflictWith || (normalizedType === 'system_occupied' ? '系统或其他程序' : '其他快捷键'),
    triggerId: item.triggerId || '',
    conflictTriggerId: item.conflictTriggerId || ''
  }
}

const buildConflictSignature = (item) =>
  [
    item.conflictType,
    item.triggerId,
    item.pluginId,
    item.pluginName,
    item.key,
    item.conflictWith
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

const systemOccupiedConflicts = computed(() =>
  conflicts.value.filter((item) => item.conflictType === 'system_occupied')
)

const duplicateConflicts = computed(() =>
  conflicts.value.filter((item) => item.conflictType === 'duplicate')
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
    return '快捷键冲突提醒'
  }
  if (systemOccupiedConflicts.value.length > 0) {
    return hasPluginConflict.value ? '快捷键被占用冲突' : '快捷键冲突'
  }
  return '启动快捷键冲突'
})

/** 弹窗描述文本 */
const descText = computed(() => {
  if (systemOccupiedConflicts.value.length > 0 && duplicateConflicts.value.length > 0) {
    return '以下全局快捷键存在系统占用或重复绑定，部分快捷键可能无法正常生效：'
  }
  if (systemOccupiedConflicts.value.length > 0) {
    return '以下快捷键已被系统或其他程序占用，无法正常使用：'
  }
  return '以下启动快捷键存在重复冲突，可能无法正常使用：'
})

/** 提示文本 */
const tipText = computed(() => {
  if (hasSystemWakeConflict.value && hasPluginConflict.value) {
    return '请前往快捷键设置调整全局唤醒或插件启动快捷键，或关闭占用该热键的外部程序。'
  }
  if (hasSystemWakeConflict.value) {
    return '请前往设置修改唤醒快捷键，或关闭占用该快捷键的程序后重试。'
  }
  if (hasFeatureHotkeyConflict.value) {
    return '请前往设置修改冲突的插件内功能快捷键。'
  }
  return '请前往设置修改冲突的启动快捷键。'
})

const canRenderCombo = (key) => isSafeShortcutKeysCombo(key, 'windows', true)

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
          <h3 v-if="duplicateConflicts.length > 0" class="conflict-section-title">系统占用冲突</h3>
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
                <RcTag tone="error">系统占用</RcTag>
                <span class="conflict-with">与「{{ item.conflictWith }}」冲突</span>
              </div>
            </div>
          </div>
        </section>

        <!-- 插件重复冲突区块 -->
        <section v-if="duplicateConflicts.length > 0" class="conflict-section" data-testid="duplicate-conflicts-section">
          <h3 v-if="systemOccupiedConflicts.length > 0" class="conflict-section-title">插件重复冲突</h3>
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
                <RcTag tone="warning">快捷键重复</RcTag>
                <span class="conflict-with">与「{{ item.conflictWith }}」冲突</span>
              </div>
            </div>
          </div>
        </section>
      </div>

      <p class="conflict-tip">{{ tipText }}</p>
    </div>
    <div class="conflict-actions">
      <RcButton variant="secondary" size="md" @click="close">关闭</RcButton>
      <RcButton variant="primary" size="md" @click="goSettings">去设置</RcButton>
    </div>
  </RcDialog>
</template>

<style scoped>
.conflict-content {
  text-align: center;
  padding: 8px 0;
}
.conflict-icon {
  display: inline-flex;
  font-size: 48px;
  color: var(--rc-warning);
  margin-bottom: 12px;
}
.conflict-desc {
  font-size: 14px;
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
  font-size: 12px;
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
  border-radius: 8px;
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
  font-size: 13px;
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
  font-size: 12px;
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
  font-size: 12px;
  color: var(--rc-text-secondary);
}
.conflict-tip {
  font-size: 12px;
  color: var(--rc-text-secondary);
  margin-bottom: 0;
}
.conflict-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
