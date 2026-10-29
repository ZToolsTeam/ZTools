<script setup>
import { ArrowRightIcon } from '@lucide/vue'

/**
 * 横幅入口：左侧标题 + 一行说明，右侧带箭头的链接文案，整块可点击。
 * 用于主页「去插件市场」、插件市场底部「插件仓库」这类引导入口。
 */
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
  linkText: { type: String, required: true }
})
defineEmits(['click'])
</script>

<template>
  <button type="button" class="rc-banner-link" @click="$emit('click', $event)">
    <slot name="leading" />
    <span class="rc-banner-text">
      <span class="rc-banner-title">{{ title }}</span>
      <span v-if="description" class="rc-banner-desc">{{ description }}</span>
    </span>
    <span class="rc-banner-action">{{ linkText }}<ArrowRightIcon aria-hidden="true" /></span>
  </button>
</template>

<style scoped>
.rc-banner-link {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 18px;
  border: 1px solid var(--rc-border);
  border-radius: var(--rc-radius-lg);
  background: var(--rc-surface);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.rc-banner-link:hover {
  border-color: var(--rc-border-highlight);
}

.rc-banner-link:hover .rc-banner-action :deep(.lucide) {
  transform: translateX(2px);
}

.rc-banner-link:focus-visible {
  outline: none;
  box-shadow: var(--rc-focus-ring);
}

.rc-banner-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rc-banner-title {
  color: var(--rc-text-primary);
  font-size: 13px;
  font-weight: 500;
}

.rc-banner-desc {
  color: var(--rc-text-muted);
  font-size: 12px;
}

.rc-banner-action {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--rc-accent-text);
  font-size: 13px;
}

.rc-banner-action :deep(.lucide) {
  font-size: 14px;
  transition: transform 0.15s ease;
}
</style>
