<template>
  <div class="decl-empty" :class="{ 'is-compact': compact }" role="status">
    <span v-if="loading" class="decl-empty-icon" aria-hidden="true">
      <SpinnerIcon class="decl-empty-spinner" />
    </span>
    <span v-else-if="icon || $slots.icon" class="decl-empty-icon" aria-hidden="true">
      <slot name="icon">
        <DeclarativeIcon :icon="icon" :size="compact ? 20 : 24" />
      </slot>
    </span>
    <p class="decl-empty-title">{{ title }}</p>
    <p v-if="description || $slots.description" class="decl-empty-desc">
      <slot name="description">{{ description }}</slot>
    </p>
    <div v-if="$slots.default" class="decl-empty-actions">
      <slot />
    </div>
  </div>
</template>

<script setup>
// 声明式渲染器统一空状态：灰阶图标 + 标题 + 可选说明 + 可选操作插槽
import { SpinnerIcon } from "@/utils/appIcons";
import DeclarativeIcon from "./DeclarativeIcon.vue";

defineProps({
  title: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ""
  },
  /** DeclarativeIcon 支持的图标名；也可用 icon 插槽传入任意图标 */
  icon: {
    type: String,
    default: ""
  },
  /** 加载中：图标换成转圈，不下“没有内容”的结论 */
  loading: {
    type: Boolean,
    default: false
  },
  /** 列表内的紧凑空状态（较小的上下留白） */
  compact: {
    type: Boolean,
    default: false
  }
});
</script>

<style scoped>
.decl-empty {
  height: 100%;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 32px 24px;
  text-align: center;
}

.decl-empty.is-compact {
  height: auto;
  min-height: 0;
  padding: 40px 16px;
}

.decl-empty-icon {
  width: 44px;
  height: 44px;
  margin-bottom: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--rc-radius-lg);
  background: var(--rc-surface-hover);
  border: 1px solid var(--rc-border);
  color: var(--rc-text-muted);
}

.decl-empty.is-compact .decl-empty-icon {
  width: 36px;
  height: 36px;
}

.decl-empty-spinner {
  width: 18px;
  height: 18px;
}

.decl-empty-title {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--rc-text-secondary);
}

.decl-empty-desc {
  margin: 0;
  max-width: 420px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--rc-text-muted);
  word-break: break-word;
}

.decl-empty-actions {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
