<script setup>
import { SpinnerIcon } from '@/utils/appIcons'

/**
 * 统一加载态：转圈 + 文案。block（默认）用于页面或区块居中占位；inline 用于行内（按钮旁、角落提示）。
 */
defineProps({
  text: { type: String, default: '加载中…' },
  inline: { type: Boolean, default: false }
})
</script>

<template>
  <span v-if="inline" class="rc-loading is-inline" role="status">
    <SpinnerIcon aria-hidden="true" /><span>{{ text }}</span>
  </span>
  <div v-else class="rc-loading" role="status">
    <SpinnerIcon class="rc-loading-icon" aria-hidden="true" />
    <span>{{ text }}</span>
  </div>
</template>

<style scoped>
.rc-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px 16px;
  color: var(--rc-text-muted);
  font-size: 12px;
}

.rc-loading-icon {
  font-size: 22px;
}

.rc-loading.is-inline {
  display: inline-flex;
  flex-direction: row;
  gap: 6px;
  padding: 0;
}
</style>
