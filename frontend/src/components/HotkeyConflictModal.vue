<script setup>
import { WarningOutlined } from '@ant-design/icons-vue'
/**
 * 快捷键冲突提醒弹窗
 * 支持两种冲突数据：
 * 1. 系统快捷键冲突（原有）：{ type: 'keyboard'|'mouse', key: string }
 * 2. 启动快捷键冲突：{ pluginName, key, conflictType: 'duplicate'|'system_occupied', conflictWith }
 */
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ROUTES } from '@/router/routes'
import {
  PLUGIN_FEATURE_HOTKEY_QUERY_KEY,
  isPluginFeatureHotkeyTriggerId
} from '@/utils/pluginFeatureHotkeys'

const router = useRouter()
const visible = ref(false)
const conflicts = ref([])
// 冲突来源类型：'system' 系统快捷键冲突 | 'plugin' 插件/本地软件启动快捷键冲突
const conflictSource = ref('system')

/** 判断是否为插件快捷键冲突数据 */
const isPluginConflict = (item) => {
  return item && ('conflictType' in item || 'pluginName' in item)
}

/**
 * 显示冲突弹窗
 * @param {Array} conflictList - 冲突数据列表，自动识别数据类型
 */
const show = (conflictList) => {
  if (!conflictList || conflictList.length === 0) return
  conflicts.value = conflictList
  // 根据第一条数据判断冲突来源类型
  conflictSource.value = isPluginConflict(conflictList[0]) ? 'plugin' : 'system'
  visible.value = true
}

/** 关闭弹窗 */
const close = () => {
  visible.value = false
}

/** 跳转到设置页面 */
const goSettings = () => {
  visible.value = false
  if (conflictSource.value === 'plugin') {
    const hasFeatureHotkeyConflict = conflicts.value.some(
      (item) =>
        isPluginFeatureHotkeyTriggerId(item.triggerId) ||
        isPluginFeatureHotkeyTriggerId(item.conflictTriggerId)
    )
    if (hasFeatureHotkeyConflict) {
      router.push({
        name: ROUTES.ADVANCED_SETTINGS.name,
        query: { [PLUGIN_FEATURE_HOTKEY_QUERY_KEY]: 'true' }
      })
    } else {
      // 启动快捷键冲突：导航到高级设置并自动打开 PluginHotkeyModal
      router.push({
        name: ROUTES.ADVANCED_SETTINGS.name,
        query: { openPluginHotkey: 'true' }
      })
    }
  } else {
    // 系统快捷键冲突：导航到高级设置页面
    router.push({ name: ROUTES.ADVANCED_SETTINGS.name })
  }
}

/** 弹窗标题 */
const modalTitle = computed(() => {
  return conflictSource.value === 'plugin' ? '启动快捷键冲突' : '快捷键冲突'
})

/** 弹窗描述文本 */
const descText = computed(() => {
  return conflictSource.value === 'plugin'
    ? '以下启动快捷键存在冲突，可能无法正常使用：'
    : '以下快捷键与其他程序冲突，无法正常使用：'
})

/** 提示文本 */
const tipText = computed(() => {
  const hasFeatureHotkeyConflict = conflicts.value.some(
    (item) =>
      isPluginFeatureHotkeyTriggerId(item.triggerId) ||
      isPluginFeatureHotkeyTriggerId(item.conflictTriggerId)
  )
  return conflictSource.value === 'plugin'
    ? hasFeatureHotkeyConflict
      ? '请前往设置修改冲突的插件内功能快捷键。'
      : '请前往设置修改冲突的启动快捷键。'
    : '请前往设置修改快捷键，或关闭占用该快捷键的程序后重启 ZTools。'
})

/** 格式化系统快捷键类型 */
const formatType = (type) => {
  return type === 'keyboard' ? '键盘快捷键' : '鼠标快捷键'
}

/** 格式化插件冲突类型 */
const formatConflictType = (conflictType) => {
  return conflictType === 'duplicate' ? '快捷键重复' : '系统占用'
}

defineExpose({ show })
</script>

<template>
  <a-modal
    v-model:open="visible"
    :title="modalTitle"
    :footer="null"
    :width="420"
    centered
  >
    <div class="conflict-content">
      <div class="conflict-icon">
        <WarningOutlined  />
      </div>
      <p class="conflict-desc">{{ descText }}</p>

      <!-- 插件快捷键冲突列表 -->
      <div v-if="conflictSource === 'plugin'" class="conflict-list">
        <div v-for="(item, index) in conflicts" :key="index" class="conflict-item plugin-conflict-item">
          <div class="plugin-conflict-row">
            <span class="plugin-name">{{ item.pluginName }}</span>
            <span class="conflict-key">
              <span
                v-for="k in item.key.split('+')"
                :key="k"
                class="key-badge"
              >{{ k }}</span>
            </span>
          </div>
          <div class="plugin-conflict-detail">
            <span class="conflict-type-tag" :class="item.conflictType">
              {{ formatConflictType(item.conflictType) }}
            </span>
            <span class="conflict-with">与「{{ item.conflictWith }}」冲突</span>
          </div>
        </div>
      </div>

      <!-- 系统快捷键冲突列表（原有） -->
      <div v-else class="conflict-list">
        <div v-for="(item, index) in conflicts" :key="index" class="conflict-item">
          <span class="conflict-type">{{ formatType(item.type) }}</span>
          <span class="conflict-key">
            <span
              v-for="k in item.key.split('+')"
              :key="k"
              class="key-badge"
            >{{ k }}</span>
          </span>
        </div>
      </div>

      <p class="conflict-tip">{{ tipText }}</p>
    </div>
    <div class="conflict-actions">
      <a-button @click="close">关闭</a-button>
      <a-button type="primary" @click="goSettings">去设置</a-button>
    </div>
  </a-modal>
</template>

<style scoped>
.conflict-content {
  text-align: center;
  padding: 8px 0;
}
.conflict-icon {
  font-size: 48px;
  color: var(--rc-warning);
  margin-bottom: 12px;
}
.conflict-desc {
  font-size: 14px;
  color: var(--zt-text);
  margin-bottom: 16px;
}
.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
  max-height: 240px;
  overflow-y: auto;
}
.conflict-item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 16px;
  background: var(--color-background-secondary);
  border-radius: 8px;
}
/* 插件冲突项：纵向布局 */
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
  color: var(--zt-text);
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
.conflict-type-tag {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}
.conflict-type-tag.duplicate {
  background: var(--rc-warning-subtle);
  color: var(--rc-warning);
}
.conflict-type-tag.system_occupied {
  background: var(--rc-error-subtle);
  color: var(--rc-error);
}
.conflict-with {
  color: var(--zt-text-secondary);
}
.conflict-type {
  font-size: 13px;
  color: var(--zt-text-secondary);
}
.conflict-key {
  display: flex;
  gap: 4px;
}
.key-badge {
  display: inline-block;
  padding: 2px 8px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  color: var(--zt-text);
}
.conflict-tip {
  font-size: 12px;
  color: var(--zt-text-secondary);
  margin-bottom: 0;
}
.conflict-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
