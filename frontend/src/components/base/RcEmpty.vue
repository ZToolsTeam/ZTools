<script setup>
/**
 * 统一空状态：灰阶图标块 + 标题 + 一行说明，可选操作按钮（#action 插槽）。
 * size：md（页面主体区域）/ sm（列表、弹窗内）。
 */
defineProps({
  icon: { type: [Object, Function], default: null },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  size: { type: String, default: 'md', validator: (v) => ['sm', 'md'].includes(v) }
})
</script>

<template>
  <div class="rc-empty" :class="`is-${size}`" role="status">
    <span v-if="icon" class="rc-empty-icon"><component :is="icon" aria-hidden="true" /></span>
    <p class="rc-empty-title">{{ title }}</p>
    <p v-if="description" class="rc-empty-desc">{{ description }}</p>
    <div v-if="$slots.action" class="rc-empty-action"><slot name="action" /></div>
  </div>
</template>

<style scoped>
.rc-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.rc-empty.is-md {
  padding: 40px 16px;
}

.rc-empty.is-sm {
  padding: 24px 12px;
}

.rc-empty-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 12px;
  border: 1px solid var(--rc-border);
  border-radius: 12px;
  background: var(--rc-surface);
  color: var(--rc-text-muted);
}

.is-md .rc-empty-icon {
  width: 44px;
  height: 44px;
  font-size: 20px;
}

.is-sm .rc-empty-icon {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  font-size: 17px;
}

.rc-empty-title {
  margin: 0;
  color: var(--rc-text-secondary);
  font-size: 13px;
  font-weight: 500;
}

.rc-empty-desc {
  max-width: 360px;
  margin: 4px 0 0;
  color: var(--rc-text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.rc-empty-action {
  margin-top: 14px;
}
</style>
